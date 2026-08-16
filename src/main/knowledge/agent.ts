// Tool-loop agent over the knowledge index. No framework: an OpenAI-compatible
// function-calling loop (max 8 rounds) with three read-only tools, plus a 4th
// (load_skill) when the user has installed skills. Streaming deltas and
// lifecycle states are pushed to the renderer via domain events; the IPC call
// itself only returns the conversation id.
import { getDb } from '../db'
import { emit } from '../core/Notifier'
import { getActiveWorkspace } from '../services/WorkspaceContextService'
import { assertReadable } from '../security/pathGuard'
import { getSetting } from '../services/SettingsService'
import { getKnowledgeDb } from './db'
import { hybridSearch } from './search'
import { truncateAtBoundary } from './truncate'
import { getChatConfig, chatStream, type ChatMessage, type ToolDef } from './providers'
import { extractCitations } from './citations'
import { listInstalledSkills, getSkillBody } from './skills'
import { AGENT_ACTION_TOOLS, AGENT_ACTION_TOOL_NAMES, executeAgentTool } from './agentTools'
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { KnowledgeRef } from '../../shared/ipc-contract'
import { IMPORTANT_SCOPE } from '../../shared/types'
import type { RetrievalStep } from '../../shared/types'

const MAX_ROUNDS = 8
const abortControllers = new Map<number, AbortController>()

function wsId(): number {
	return getActiveWorkspace().id ?? 0
}

/** Read a numeric setting, clamped to [min,max]; falls back to def when unset/invalid. */
function tunedInt(key: string, def: number, min: number, max: number): number {
	const v = getSetting(key)
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def
}

// ── Tools ────────────────────────────────────────────────────────────────────

const BASE_TOOLS: ToolDef[] = [
	{
		type: 'function',
		function: {
			name: 'search_library',
			description:
				'Hybrid semantic + keyword search over the full text of every paper in the current library. ' +
				'Returns excerpts with their source (item_key + seq). Call multiple times with different ' +
				'phrasings if the first search misses. Queries can be Chinese or English.',
			parameters: {
				type: 'object',
				properties: { query: { type: 'string', description: 'search query' } },
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_item_info',
			description: 'Bibliographic metadata (title, authors, year, journal, DOI) for one paper.',
			parameters: {
				type: 'object',
				properties: { item_key: { type: 'string', description: 'the item key from a search result' } },
				required: ['item_key'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'read_context',
			description: 'Read the chunks immediately before and after a given excerpt for more context.',
			parameters: {
				type: 'object',
				properties: {
					item_key: { type: 'string' },
					seq: { type: 'number', description: 'the seq of the excerpt to expand around' },
				},
				required: ['item_key', 'seq'],
			},
		},
	},
]

const LOAD_SKILL_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'load_skill',
		description:
			'Load the full instructions for one of the installed skills listed at the end of this ' +
			'prompt. Call this before following a skill\'s procedure -- the catalog only gives you its ' +
			'name and a one-line description, not the actual steps.',
		parameters: {
			type: 'object',
			properties: { name: { type: 'string', description: 'the skill name from the catalog' } },
			required: ['name'],
		},
	},
}

async function runTool(name: string, argsJson: string, filter?: import('./search').ScopeFilter): Promise<{ result: string; step: RetrievalStep }> {
	if (AGENT_ACTION_TOOL_NAMES.has(name)) return executeAgentTool(name, argsJson, filter)

	let args: Record<string, unknown>
	try { args = JSON.parse(argsJson || '{}') } catch { return { result: 'error: invalid arguments', step: { tool: 'search_library', label: '(bad args)' } } }

	if (name === 'search_library') {
		const q = String(args.query ?? '').trim()
		if (!q) return { result: 'error: empty query', step: { tool: 'search_library', label: '(empty)' } }
		const count = tunedInt('knowledge.search.resultCount', 6, 1, 12)
		const chars = tunedInt('knowledge.search.excerptChars', 1200, 200, 4000)
		const hits = await hybridSearch(wsId(), q, count, filter)
		const titleOf = new Map<string, string | null>()
		if (hits.length) {
			const keys = [...new Set(hits.map((h) => h.itemKey))]
			for (const r of getDb().prepare(`SELECT key, title FROM items WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys) as { key: string; title: string | null }[]) {
				titleOf.set(r.key, r.title)
			}
		}
		const excerpts = hits.map((h) => ({ h, text: truncateAtBoundary(h.text, chars) }))
		const step: RetrievalStep = {
			tool: 'search_library', label: q,
			hits: excerpts.map(({ h, text }) => ({ key: h.itemKey, title: titleOf.get(h.itemKey) ?? h.itemKey, chars: text.length })),
		}
		const result = hits.length
			? excerpts.map(({ h, text }) => `[${h.itemKey}:${h.seq}] (${h.headingPath || 'text'})\n${text}`).join('\n\n---\n\n')
			: 'no results'
		return { result, step }
	}

	if (name === 'get_item_info') {
		const key = String(args.item_key ?? '')
		const item = getDb().prepare(
			'SELECT id, title, year, journal, doi FROM items WHERE key = ? AND deleted = 0'
		).get(key) as { id: number; title: string | null; year: number | null; journal: string | null; doi: string | null } | undefined
		const step: RetrievalStep = { tool: 'get_item_info', label: key }
		if (!item) return { result: 'not found', step }
		const creators = getDb().prepare(`
			SELECT c.last_name, c.first_name FROM creators c
			JOIN item_creators ic ON ic.creator_id = c.id
			WHERE ic.item_id = ? ORDER BY ic.position LIMIT 10
		`).all(item.id) as { last_name: string; first_name: string | null }[]
		return { result: JSON.stringify({
			title: item.title, year: item.year, journal: item.journal, doi: item.doi,
			authors: creators.map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ')),
		}), step }
	}

	if (name === 'read_context') {
		const key = String(args.item_key ?? '')
		const seq = Number(args.seq)
		const step: RetrievalStep = { tool: 'read_context', label: `${key}:${Number.isFinite(seq) ? seq : '?'}` }
		if (!key || !Number.isFinite(seq)) return { result: 'error: bad arguments', step }
		const rows = getKnowledgeDb().prepare(`
			SELECT seq, heading_path, text FROM chunks
			WHERE workspace_id = ? AND item_key = ? AND seq BETWEEN ? AND ?
			ORDER BY seq
		`).all(wsId(), key, seq - 1, seq + 1) as { seq: number; heading_path: string; text: string }[]
		if (!rows.length) return { result: 'not found', step }
		return { result: rows.map((r) => `[${key}:${r.seq}] (${r.heading_path || 'text'})\n${r.text}`).join('\n\n'), step }
	}

	if (name === 'load_skill') {
		const skillName = String(args.name ?? '')
		const body = getSkillBody(skillName)
		return { result: body ?? 'not found', step: { tool: 'load_skill', label: skillName } }
	}

	return { result: 'error: unknown tool', step: { tool: 'search_library', label: `(unknown: ${name})` } }
}

// ── Conversation persistence ─────────────────────────────────────────────────

export interface ConversationRow { id: number; title: string; created_at: number; scope_collection_id: number | null }
export interface MessageRow {
	id: number; conversation_id: number; role: string; content: string
	citations: string; created_at: number; steps: string; refs: string
}

export function listConversations(): ConversationRow[] {
	return getKnowledgeDb().prepare(
		'SELECT id, title, created_at, scope_collection_id FROM conversations WHERE workspace_id = ? ORDER BY id DESC LIMIT 100'
	).all(wsId()) as ConversationRow[]
}

export function getMessages(conversationId: number): MessageRow[] {
	return getKnowledgeDb().prepare(
		'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id'
	).all(conversationId) as MessageRow[]
}

export function deleteConversation(conversationId: number): void {
	const kdb = getKnowledgeDb()
	kdb.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
	kdb.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
}

// ── Citations ────────────────────────────────────────────────────────────────

export interface Citation { itemKey: string; itemId: number | null; seq: number; title: string | null }

function resolveCitations(raw: { itemKey: string; seq: number }[]): Citation[] {
	const exact = getDb().prepare('SELECT id, title FROM items WHERE key = ?')
	// Folder-backed libraries key items by full UUID, but the model tends to cite
	// only the first segment (mimicking the short example key). Fall back to a
	// unique prefix match so those citations still resolve.
	const prefix = getDb().prepare("SELECT id, title FROM items WHERE key LIKE ? ESCAPE '\\' LIMIT 2")
	return raw.map((c) => {
		let row = exact.get(c.itemKey) as { id: number; title: string | null } | undefined
		if (!row) {
			const like = c.itemKey.replace(/[\\%_]/g, '\\$&') + '%'
			const hits = prefix.all(like) as { id: number; title: string | null }[]
			if (hits.length === 1) row = hits[0]
		}
		return { ...c, itemId: row?.id ?? null, title: row?.title ?? null }
	})
}

// ── The ask loop ─────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the research assistant inside Veridian, a reference manager. You answer questions strictly from the user's own paper library using the provided tools.

Rules:
- If the user has attached specific papers or files for this turn (they appear as "[Attached paper: ...]" or "[Attached file: ...]" system messages), answer directly from that attached content. Do NOT call search_library, and do NOT add [^...] citation markers for it -- the attached text has no seq numbers and none are needed. Only search if the attached material genuinely lacks what's asked.
- Otherwise, to ANSWER a question, you MUST use search_library — even when the user has selected a collection and asks about "these papers", search_library is already scoped to that selection and returns the exact passages to cite. NEVER answer a question by calling list_items or read_item to read papers wholesale — that produces no citations and is slow. list_items/read_item are ONLY for explicit organise/classify/tag requests or for reading one specific paper the user named. Never answer from general knowledge alone; if the library has nothing relevant, say so plainly.
- For claims drawn from search_library results, cite with the marker [^item_key:seq] taken from those results (e.g. [^AB12CD34:5]), placed inline right after the claim.
- Answer in the same language the user asked in.
- Be concise and factual. Quote numbers and findings exactly as the excerpts state them.
- Write every mathematical variable, symbol, or formula in LaTeX: inline as $...$ (e.g. the coefficient $\\beta_1$) and standalone equations as $$...$$. Never write math as plain text.
- Library actions: you can MODIFY the user's library, but ONLY when they explicitly ask you to organise, annotate, or fix something (e.g. "tag this", "add a note", "link these two", "put it in a collection", "fix the year"). For plain questions you must NEVER modify anything.
  - create_note(item_key, title, content): save a note on a paper.
  - add_tags(item_key, tags): add keyword tags (call list_tags first to reuse existing names).
  - add_to_collection(item_key, collection): file a paper into a collection (call list_collections first).
  - link_items(from_key, to_key, rel_type): connect two papers; rel_type ∈ extends | contradicts | related | cites | same_method.
  - update_metadata(item_key, ...fields): correct bibliographic fields.
  - set_star(item_key, starred): mark a paper important.
  - read_item(item_key): read ONE specific paper's full text, when you already know which paper you want (e.g. from list_items or an @-mention). Don't use search_library to re-read a paper whose key you already have.
  - list_items(): list the papers in the CURRENT SCOPE (key, title, year, tags). If the user has selected a collection/scope, this lists only those papers; otherwise the whole library. Use it ONLY for explicit library-management/bulk tasks (e.g. "classify these papers", "tag everything") — NEVER to answer a question.
  When the user has selected a scope/collection, BOTH search_library and list_items are confined to it — stay within the selected papers, never widen to the whole library. For a bulk task like classification: call list_items, judge each paper by its title or read_item, then issue the add_to_collection / add_tags calls (you may issue many in one turn). If there are many papers, handle a bounded batch and tell the user how many you processed and how many remain.
  Never end your turn with an empty reply: always finish with a short summary of what you did and what remains, in the user's language.
  After acting, tell the user in one line exactly what you changed.`

/** Appends an installed-skills catalog (name + one-line description) so the
 *  model can decide on its own when a skill's procedure applies -- mirrors
 *  how Claude's own Agent Skills are progressively disclosed: the catalog is
 *  cheap, the full body only loads via load_skill when actually relevant. */
function buildSystemPrompt(): string {
	const skills = listInstalledSkills()
	if (!skills.length) return BASE_SYSTEM_PROMPT
	const catalog = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
	return `${BASE_SYSTEM_PROMPT}\n\nInstalled skills (call load_skill(name) to read one in full before using it):\n${catalog}`
}

const MAX_REF_CHARS = 8000

/** Resolves @/`/`-mention refs into extra hidden context messages, injected
 *  right after the system prompt and kept out of the 4000-char question cap
 *  the visible chat bubble is limited to. */
function resolveRefs(refs: KnowledgeRef[] | undefined): ChatMessage[] {
	if (!refs?.length) return []
	const out: ChatMessage[] = []
	for (const ref of refs) {
		if (ref.type === 'item') {
			// Read the paper's markdown attachment directly (source of truth) rather
			// than the derived chunk index -- an @-mention must carry the paper's
			// text even before the background indexer has run on it.
			const item = getDb().prepare('SELECT id, title FROM items WHERE key = ? AND deleted = 0')
				.get(ref.itemKey) as { id: number; title: string | null } | undefined
			if (!item) continue
			const title = item.title ?? ref.itemKey
			const md = getDb().prepare(
				"SELECT path FROM attachments WHERE item_id = ? AND type = 'markdown' AND path IS NOT NULL LIMIT 1"
			).get(item.id) as { path: string } | undefined
			if (md) {
				try {
					const text = readFileSync(assertReadable(md.path), 'utf-8').slice(0, MAX_REF_CHARS)
					out.push({ role: 'system', content: `[Attached paper: ${title}]\n${text}` })
					continue
				} catch { /* fall through to the no-text note */ }
			}
			out.push({ role: 'system', content: `[Attached paper: ${title} -- no converted markdown text is available for it yet]` })
		} else if (ref.type === 'file') {
			try {
				const real = assertReadable(ref.path)
				const text = readFileSync(real, 'utf-8').slice(0, MAX_REF_CHARS)
				out.push({ role: 'system', content: `[Attached file: ${basename(ref.path)}]\n${text}` })
			} catch (err) {
				out.push({ role: 'system', content: `[Attached file ${basename(ref.path)} could not be read: ${(err as Error).message}]` })
			}
		} else if (ref.type === 'skill') {
			const body = getSkillBody(ref.name)
			out.push({
				role: 'system',
				content: body
					? `[Manually attached skill: ${ref.name} -- follow these instructions for this turn]\n${body}`
					: `[Skill "${ref.name}" is not installed]`,
			})
		}
	}
	return out
}

interface StoredRef { type: 'item' | 'file' | 'skill'; itemKey?: string; path?: string; name?: string; label: string }

// Enrich refs with a human label for display, resolved once at store time.
function enrichRefs(refs: KnowledgeRef[] | undefined): StoredRef[] {
	if (!refs?.length) return []
	return refs.map((r): StoredRef => {
		if (r.type === 'item') {
			const row = getDb().prepare('SELECT title FROM items WHERE key = ?').get(r.itemKey) as { title: string | null } | undefined
			return { type: 'item', itemKey: r.itemKey, label: row?.title ?? r.itemKey }
		}
		if (r.type === 'file') return { type: 'file', path: r.path, label: basename(r.path) }
		return { type: 'skill', name: r.name, label: r.name }
	})
}

function lastUserRefs(convId: number): KnowledgeRef[] {
	const row = getKnowledgeDb().prepare("SELECT refs FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
		.get(convId) as { refs: string } | undefined
	try { return JSON.parse(row?.refs || '[]') as KnowledgeRef[] } catch { return [] }
}

function scopeToFilter(scope: number | null): import('./search').ScopeFilter | undefined {
	if (scope === IMPORTANT_SCOPE) {
		const ids = getDb().prepare('SELECT id FROM items WHERE starred = 1 AND deleted = 0').all() as { id: number }[]
		return { itemIds: ids.map((r) => r.id) }
	}
	if (scope !== null) {
		const ids = getDb().prepare('SELECT item_id FROM collection_items WHERE collection_id = ?').all(scope) as { item_id: number }[]
		return { itemIds: ids.map((r) => r.item_id) }
	}
	return undefined
}

function conversationFilter(convId: number): import('./search').ScopeFilter | undefined {
	const row = getKnowledgeDb().prepare('SELECT scope_collection_id FROM conversations WHERE id = ?')
		.get(convId) as { scope_collection_id: number | null } | undefined
	return scopeToFilter(row?.scope_collection_id ?? null)
}

function runTurn(convId: number, refs: KnowledgeRef[] | undefined, filter: import('./search').ScopeFilter | undefined): void {
	const cfg = getChatConfig()
	if (!cfg) {
		emit({ type: 'knowledge.chatState', conversationId: convId, state: 'error', detail: 'not_configured' })
		return
	}
	const kdb = getKnowledgeDb()
	const messages: ChatMessage[] = [
		{ role: 'system', content: buildSystemPrompt() },
		...resolveRefs(refs),
		...getMessages(convId).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
	]
	const tools = [
		...BASE_TOOLS,
		...AGENT_ACTION_TOOLS,
		...(listInstalledSkills().length ? [LOAD_SKILL_TOOL] : []),
	]
	const ac = new AbortController()
	abortControllers.set(convId, ac)
	const steps: RetrievalStep[] = []
	console.log('[dbg-scope] runTurn conv=%d filter=%s', convId, filter ? `${filter.itemIds.length} items [${filter.itemIds.slice(0, 8).join(',')}...]` : 'NONE (whole library)')
	void (async () => {
		try {
			let finalText = ''
			for (let round = 0; round < MAX_ROUNDS; round++) {
				emit({ type: 'knowledge.chatState', conversationId: convId, state: round === 0 ? 'searching' : 'answering' })
				const result = await chatStream(cfg, messages, tools, (delta) => {
					emit({ type: 'knowledge.chatDelta', conversationId: convId, delta })
				}, ac.signal)
				if (result.toolCalls.length === 0) { finalText = result.content; break }
				messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
				for (const tc of result.toolCalls) {
					emit({ type: 'knowledge.chatState', conversationId: convId, state: 'searching', detail: tc.function.name })
					console.log('[dbg-scope] tool=%s args=%s', tc.function.name, (tc.function.arguments || '').slice(0, 120))
					const { result: toolResult, step } = await runTool(tc.function.name, tc.function.arguments, filter)
					steps.push(step)
					emit({ type: 'knowledge.step', conversationId: convId, step })
					messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id })
				}
				finalText = result.content
			}
			if (!finalText.trim()) {
				// The model spent its whole tool-call budget without ever producing a
				// final answer (e.g. it looped on tools). Re-run once with NO tools so
				// it must summarise from what it already has — the user never gets a
				// blank bubble. Do NOT append a user message here: after tool-result
				// turns that would create two consecutive user turns, which the
				// Anthropic (claude-subscription) API rejects with a 400.
				const wrap = await chatStream(cfg, messages, [], (delta) => {
					emit({ type: 'knowledge.chatDelta', conversationId: convId, delta })
				}, ac.signal)
				finalText = wrap.content
			}
			const citations = resolveCitations(extractCitations(finalText))
			kdb.prepare('INSERT INTO messages (conversation_id, role, content, citations, steps) VALUES (?, ?, ?, ?, ?)')
				.run(convId, 'assistant', finalText, JSON.stringify(citations), JSON.stringify(steps))
			emit({ type: 'knowledge.chatState', conversationId: convId, state: 'done' })
		} catch (err) {
			const aborted = (err as Error).name === 'AbortError'
			if (!aborted) console.error('[knowledge] runTurn failed:', err)
			emit({ type: 'knowledge.chatState', conversationId: convId, state: aborted ? 'done' : 'error', detail: aborted ? 'stopped' : (err as Error).message })
		} finally {
			abortControllers.delete(convId)
		}
	})()
}

export async function ask(question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null): Promise<number> {
	const kdb = getKnowledgeDb()
	const ws = wsId()

	let convId = conversationId
	const scope = scopeCollectionId ?? null
	console.log('[dbg-scope] ask received scopeCollectionId=%o -> scope=%o', scopeCollectionId, scope)
	if (convId === null) {
		const info = kdb.prepare('INSERT INTO conversations (workspace_id, title, scope_collection_id) VALUES (?, ?, ?)')
			.run(ws, question.slice(0, 60), scope)
		convId = Number(info.lastInsertRowid)
	} else {
		kdb.prepare('UPDATE conversations SET scope_collection_id = ? WHERE id = ?').run(scope, convId)
	}
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(convId, 'user', question, JSON.stringify(enrichRefs(refs)))

	runTurn(convId, refs, scopeToFilter(scope))
	return convId
}

export function stopGeneration(conversationId: number): void {
	abortControllers.get(conversationId)?.abort()
}

export function regenerate(conversationId: number): void {
	const kdb = getKnowledgeDb()
	const last = kdb.prepare('SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
		.get(conversationId) as { id: number; role: string } | undefined
	if (!last) return
	if (last.role === 'assistant') kdb.prepare('DELETE FROM messages WHERE id = ?').run(last.id)
	runTurn(conversationId, lastUserRefs(conversationId), conversationFilter(conversationId))
}

export function editLastAndResend(conversationId: number, newQuestion: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null): void {
	const kdb = getKnowledgeDb()
	const lastUser = kdb.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
		.get(conversationId) as { id: number } | undefined
	if (!lastUser) return
	const scope = scopeCollectionId ?? null
	kdb.prepare('UPDATE conversations SET scope_collection_id = ? WHERE id = ?').run(scope, conversationId)
	kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, lastUser.id)
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(conversationId, 'user', newQuestion, JSON.stringify(enrichRefs(refs)))
	runTurn(conversationId, refs, scopeToFilter(scope))
}
