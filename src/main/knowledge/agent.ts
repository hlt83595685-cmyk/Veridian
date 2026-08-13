// Tool-loop agent over the knowledge index. No framework: an OpenAI-compatible
// function-calling loop (max 8 rounds) with three read-only tools, plus a 4th
// (load_skill) when the user has installed skills. Streaming deltas and
// lifecycle states are pushed to the renderer via domain events; the IPC call
// itself only returns the conversation id.
import { getDb } from '../db'
import { emit } from '../core/Notifier'
import { getActiveWorkspace } from '../services/WorkspaceContextService'
import { assertReadable } from '../security/pathGuard'
import { getKnowledgeDb } from './db'
import { hybridSearch } from './search'
import { getChatConfig, chatStream, type ChatMessage, type ToolDef } from './providers'
import { extractCitations } from './citations'
import { listInstalledSkills, getSkillBody } from './skills'
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { KnowledgeRef } from '../../shared/ipc-contract'

const MAX_ROUNDS = 8
const abortControllers = new Map<number, AbortController>()

function wsId(): number {
	return getActiveWorkspace().id ?? 0
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

async function runTool(name: string, argsJson: string): Promise<string> {
	let args: Record<string, unknown>
	try { args = JSON.parse(argsJson || '{}') } catch { return 'error: invalid arguments' }

	if (name === 'search_library') {
		const q = String(args.query ?? '').trim()
		if (!q) return 'error: empty query'
		const hits = await hybridSearch(wsId(), q, 8)
		if (!hits.length) return 'no results'
		return hits.map((h) =>
			`[${h.itemKey}:${h.seq}] (${h.headingPath || 'text'})\n${h.text.slice(0, 700)}`
		).join('\n\n---\n\n')
	}

	if (name === 'get_item_info') {
		const key = String(args.item_key ?? '')
		const item = getDb().prepare(
			'SELECT id, title, year, journal, doi FROM items WHERE key = ? AND deleted = 0'
		).get(key) as { id: number; title: string | null; year: number | null; journal: string | null; doi: string | null } | undefined
		if (!item) return 'not found'
		const creators = getDb().prepare(`
			SELECT c.last_name, c.first_name FROM creators c
			JOIN item_creators ic ON ic.creator_id = c.id
			WHERE ic.item_id = ? ORDER BY ic.position LIMIT 10
		`).all(item.id) as { last_name: string; first_name: string | null }[]
		return JSON.stringify({
			title: item.title, year: item.year, journal: item.journal, doi: item.doi,
			authors: creators.map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ')),
		})
	}

	if (name === 'read_context') {
		const key = String(args.item_key ?? '')
		const seq = Number(args.seq)
		if (!key || !Number.isFinite(seq)) return 'error: bad arguments'
		const rows = getKnowledgeDb().prepare(`
			SELECT seq, heading_path, text FROM chunks
			WHERE workspace_id = ? AND item_key = ? AND seq BETWEEN ? AND ?
			ORDER BY seq
		`).all(wsId(), key, seq - 1, seq + 1) as { seq: number; heading_path: string; text: string }[]
		if (!rows.length) return 'not found'
		return rows.map((r) => `[${key}:${r.seq}] (${r.heading_path || 'text'})\n${r.text}`).join('\n\n')
	}

	if (name === 'load_skill') {
		const body = getSkillBody(String(args.name ?? ''))
		return body ?? 'not found'
	}

	return 'error: unknown tool'
}

// ── Conversation persistence ─────────────────────────────────────────────────

export interface ConversationRow { id: number; title: string; created_at: number }
export interface MessageRow {
	id: number; conversation_id: number; role: string; content: string
	citations: string; created_at: number
}

export function listConversations(): ConversationRow[] {
	return getKnowledgeDb().prepare(
		'SELECT id, title, created_at FROM conversations WHERE workspace_id = ? ORDER BY id DESC LIMIT 100'
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
	const stmt = getDb().prepare('SELECT id, title FROM items WHERE key = ?')
	return raw.map((c) => {
		const row = stmt.get(c.itemKey) as { id: number; title: string | null } | undefined
		return { ...c, itemId: row?.id ?? null, title: row?.title ?? null }
	})
}

// ── The ask loop ─────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are the research assistant inside Veridian, a reference manager. You answer questions strictly from the user's own paper library using the provided tools.

Rules:
- ALWAYS search the library before answering; never answer from general knowledge alone. If the library has nothing relevant, say so plainly.
- Cite every claim with the marker [^item_key:seq] taken from search results (e.g. [^AB12CD34:5]). Place markers inline right after the claim they support.
- Answer in the same language the user asked in.
- Be concise and factual. Quote numbers and findings exactly as the excerpts state them.
- Write every mathematical variable, symbol, or formula in LaTeX: inline as $...$ (e.g. the coefficient $\\beta_1$) and standalone equations as $$...$$. Never write math as plain text.`

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

export async function ask(question: string, conversationId: number | null, refs?: KnowledgeRef[]): Promise<number> {
	const kdb = getKnowledgeDb()
	const ws = wsId()

	let convId = conversationId
	if (convId === null) {
		const info = kdb.prepare('INSERT INTO conversations (workspace_id, title) VALUES (?, ?)')
			.run(ws, question.slice(0, 60))
		convId = Number(info.lastInsertRowid)
	}
	kdb.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
		.run(convId, 'user', question)

	const cfg = getChatConfig()
	if (!cfg) {
		emit({ type: 'knowledge.chatState', conversationId: convId, state: 'error', detail: 'not_configured' })
		return convId
	}

	// History (previous turns) + this question
	const history = getMessages(convId)
	const messages: ChatMessage[] = [
		{ role: 'system', content: buildSystemPrompt() },
		...resolveRefs(refs),
		...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
	]

	const tools = listInstalledSkills().length ? [...BASE_TOOLS, LOAD_SKILL_TOOL] : BASE_TOOLS

	const ac = new AbortController()
	abortControllers.set(convId, ac)

	void (async () => {
		try {
			let finalText = ''
			for (let round = 0; round < MAX_ROUNDS; round++) {
				emit({ type: 'knowledge.chatState', conversationId: convId!, state: round === 0 ? 'searching' : 'answering' })
				const result = await chatStream(cfg, messages, tools, (delta) => {
					emit({ type: 'knowledge.chatDelta', conversationId: convId!, delta })
				}, ac.signal)

				if (result.toolCalls.length === 0) {
					finalText = result.content
					break
				}
				messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
				for (const tc of result.toolCalls) {
					emit({
						type: 'knowledge.chatState', conversationId: convId!, state: 'searching',
						detail: tc.function.name,
					})
					const toolResult = await runTool(tc.function.name, tc.function.arguments)
					messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id })
				}
				// Loop continues; if we hit MAX_ROUNDS the last content stands.
				finalText = result.content
			}

			const citations = resolveCitations(extractCitations(finalText))
			kdb.prepare('INSERT INTO messages (conversation_id, role, content, citations) VALUES (?, ?, ?, ?)')
				.run(convId, 'assistant', finalText, JSON.stringify(citations))
			emit({ type: 'knowledge.chatState', conversationId: convId!, state: 'done' })
		} catch (err) {
			const aborted = (err as Error).name === 'AbortError'
			if (!aborted) console.error('[knowledge] ask failed:', err)
			emit({
				type: 'knowledge.chatState', conversationId: convId!,
				state: aborted ? 'done' : 'error',
				detail: aborted ? 'stopped' : (err as Error).message,
			})
		} finally {
			abortControllers.delete(convId!)
		}
	})()

	return convId
}

export function stopGeneration(conversationId: number): void {
	abortControllers.get(conversationId)?.abort()
}
