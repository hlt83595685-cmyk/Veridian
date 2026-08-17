// AI library-action tools: the write half of the chat agent (the read half —
// search_library / read_context / get_item_info — lives in agent.ts). Each
// executor resolves an item_key (exact, then unique-prefix fallback for the
// truncated UUID keys folder-backed libraries use), performs the mutation via a
// Service (which emits a domain event), and returns a short confirmation plus a
// RetrievalStep for the trace panel. AI-created notes/edges are tagged origin='ai'.
import { readFileSync } from 'fs'
import { getDb } from '../db'
import { mergeTagsForItem, listAll as listAllTags } from '../services/TagService'
import { listAll as listAllCollections, createCollection, addItemToCollection } from '../services/CollectionService'
import { updateItem, setStarred, listItems } from '../services/ItemService'
import { saveNote, getNote, listNotesByItem, listStandaloneNotes } from '../services/NoteService'
import { linkItems } from '../services/RelationService'
import { RELATION_TYPES } from '../db/relations'
import { assertReadable } from '../security/pathGuard'
import type { ToolDef } from './providers'
import type { RetrievalStep } from '../../shared/types'
import type { ScopeFilter } from './search'

const READ_ITEM_CHARS = 8000

function resolveItem(key: string): { id: number; key: string; title: string | null } | null {
	const db = getDb()
	let row = db.prepare('SELECT id, key, title FROM items WHERE key = ? AND deleted = 0')
		.get(key) as { id: number; key: string; title: string | null } | undefined
	if (!row) {
		const like = key.replace(/[\\%_]/g, '\\$&') + '%'
		const hits = db.prepare("SELECT id, key, title FROM items WHERE key LIKE ? ESCAPE '\\' AND deleted = 0 LIMIT 2")
			.all(like) as { id: number; key: string; title: string | null }[]
		if (hits.length === 1) row = hits[0]
	}
	return row ?? null
}

export const AGENT_READ_TOOLS: ToolDef[] = [
	{ type: 'function', function: {
			name: 'list_items',
			description: 'List the papers in the current library (key, title, year, existing tags). Use this — NOT search_library — for library-wide or bulk tasks such as classifying or tagging every paper. search_library is only for finding papers by topic/content.',
			parameters: { type: 'object', properties: {} } } },
	{ type: 'function', function: {
			name: 'read_item',
			description: 'Read the full converted text (markdown) of ONE paper by its key, for direct analysis. Use this to read a paper you already know — do NOT use search_library to read a paper whose key you already have. search_library is only for discovering unknown papers by topic.',
			parameters: { type: 'object', properties: { item_key: { type: 'string' } }, required: ['item_key'] } } },
	{ type: 'function', function: {
			name: 'list_collections',
			description: 'List the collections (folders) in the current library, so you can file papers correctly.',
			parameters: { type: 'object', properties: {} } } },
	{ type: 'function', function: {
			name: 'list_tags',
			description: 'List every tag already used in the current library, to reuse consistent tag names.',
			parameters: { type: 'object', properties: {} } } },
	{ type: 'function', function: {
			name: 'read_notes',
			description: 'Read the notes already attached to one paper.',
			parameters: { type: 'object', properties: { item_key: { type: 'string' } }, required: ['item_key'] } } },
	{ type: 'function', function: {
			name: 'list_notes',
			description: 'List standalone concept notes (id + title) — notes not attached to any paper. Use to find a concept note to update, or to check whether a [[Title]] concept page already exists before creating it.',
			parameters: { type: 'object', properties: {} } } },
]

export const AGENT_WRITE_TOOLS: ToolDef[] = [
	{ type: 'function', function: {
			name: 'create_note',
			description: 'Create a note. Provide item_key to attach it to a paper, OR omit item_key to create a standalone concept note (then title is REQUIRED and becomes the concept\'s identity). In the body you may write [[Title]] to link to other notes/papers — those become backlinks automatically. Use for summaries, observations, or concept pages the user asks you to save.',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
			}, required: ['content'] } } },
	{ type: 'function', function: {
			name: 'update_note',
			description: 'Overwrite an existing note (identified by note_id) with new title/content. Read the note first via read_notes or list_notes so you do not discard the user\'s text. [[Title]] links in the new content are re-reconciled into backlinks.',
			parameters: { type: 'object', properties: {
				note_id: { type: 'number' }, title: { type: 'string' }, content: { type: 'string' },
			}, required: ['note_id'] } } },
	{ type: 'function', function: {
			name: 'add_tags',
			description: 'Add one or more keyword tags to a paper (existing tags are kept).',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
			}, required: ['item_key', 'tags'] } } },
	{ type: 'function', function: {
			name: 'add_to_collection',
			description: 'File a paper into a collection (folder), creating the collection if it does not exist.',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' }, collection: { type: 'string' },
			}, required: ['item_key', 'collection'] } } },
	{ type: 'function', function: {
			name: 'link_items',
			description: `Create a typed link between two papers. rel_type must be one of: ${RELATION_TYPES.join(', ')}.`,
			parameters: { type: 'object', properties: {
				from_key: { type: 'string' }, to_key: { type: 'string' }, rel_type: { type: 'string' },
			}, required: ['from_key', 'to_key', 'rel_type'] } } },
	{ type: 'function', function: {
			name: 'update_metadata',
			description: 'Correct bibliographic fields of a paper. Only pass fields you want to change.',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' },
				title: { type: 'string' }, abstract: { type: 'string' }, year: { type: 'number' },
				journal: { type: 'string' }, doi: { type: 'string' }, url: { type: 'string' },
				volume: { type: 'string' }, issue: { type: 'string' }, pages: { type: 'string' },
			}, required: ['item_key'] } } },
	{ type: 'function', function: {
			name: 'set_star',
			description: 'Mark or unmark a paper as important (starred).',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' }, starred: { type: 'boolean' },
			}, required: ['item_key', 'starred'] } } },
]

export const AGENT_ACTION_TOOLS: ToolDef[] = [...AGENT_READ_TOOLS, ...AGENT_WRITE_TOOLS]
export const AGENT_ACTION_TOOL_NAMES = new Set(AGENT_ACTION_TOOLS.map((t) => t.function.name))

type Step = RetrievalStep['tool']

function step(tool: Step, label: string): RetrievalStep {
	return { tool, label }
}

export async function executeAgentTool(name: string, argsJson: string, filter?: ScopeFilter): Promise<{ result: string; step: RetrievalStep }> {
	let a: Record<string, unknown>
	try { a = JSON.parse(argsJson || '{}') } catch { return { result: 'error: invalid arguments', step: step(name as Step, '(bad args)') } }
	const key = String(a.item_key ?? '')

	if (name === 'list_items') {
		let items = listItems()
		if (filter) {
			const inScope = new Set(filter.itemIds)
			items = items.filter((it) => inScope.has(it.id))
		}
		const cap = 300
		const shown = items.slice(0, cap)
		const lines = shown.map((it) => `${it.key}\t${it.title ?? '(untitled)'}${it.year ? ` (${it.year})` : ''}${it.tags?.length ? ` [${it.tags.join(', ')}]` : ''}`)
		const note = items.length > cap ? `\n… and ${items.length - cap} more (showing first ${cap})` : ''
		return { result: (lines.join('\n') || '(library is empty)') + note, step: step('list_items', `${items.length} items`) }
	}
	if (name === 'list_collections') {
		const names = listAllCollections().map((c) => c.name)
		return { result: names.length ? names.join('\n') : '(no collections)', step: step('list_collections', `${names.length} collections`) }
	}
	if (name === 'list_tags') {
		const names = listAllTags().map((t) => t.name)
		return { result: names.length ? names.join(', ') : '(no tags)', step: step('list_tags', `${names.length} tags`) }
	}
	if (name === 'read_notes') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('read_notes', key) }
		const notes = listNotesByItem(item.id)
		const body = notes.length ? notes.map((n) => `- [id ${n.id}] ${n.title ?? '(untitled)'}: ${n.content ?? ''}`).join('\n') : '(no notes)'
		return { result: body, step: step('read_notes', item.title ?? key) }
	}
	if (name === 'list_notes') {
		const notes = listStandaloneNotes()
		const body = notes.length ? notes.map((n) => `[id ${n.id}] ${n.title ?? '(untitled)'}`).join('\n') : '(no standalone notes)'
		return { result: body, step: step('list_notes', `${notes.length} notes`) }
	}
	if (name === 'read_item') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('read_item', key) }
		const md = getDb().prepare("SELECT path FROM attachments WHERE item_id = ? AND type = 'markdown' AND path IS NOT NULL LIMIT 1")
			.get(item.id) as { path: string } | undefined
		if (!md) return { result: `no converted markdown text is available for "${item.title ?? key}" yet`, step: step('read_item', item.title ?? key) }
		try {
			const text = readFileSync(assertReadable(md.path), 'utf-8').slice(0, READ_ITEM_CHARS)
			// Carry the paper as a "hit" so the trace summary counts it as a source
			// (reading a paper in full is a source just like a search excerpt).
			return { result: text, step: { tool: 'read_item', label: item.title ?? key, hits: [{ key: item.key, title: item.title ?? item.key, chars: text.length }] } }
		} catch (err) {
			return { result: `could not read "${item.title ?? key}": ${(err as Error).message}`, step: step('read_item', item.title ?? key) }
		}
	}

	if (name === 'create_note') {
		const title = a.title != null ? String(a.title) : null
		const content = String(a.content ?? '')
		if (key) {
			const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('create_note', key) }
			const id = saveNote({ itemId: item.id, title, content, origin: 'ai' })
			return { result: `note ${id} added to "${item.title ?? key}"`, step: step('create_note', item.title ?? key) }
		}
		if (!title || !title.trim()) return { result: 'error: a standalone concept note needs a title', step: step('create_note', '(no title)') }
		const id = saveNote({ title, content, origin: 'ai' })
		return { result: `standalone note ${id} created: "${title}"`, step: step('create_note', title) }
	}
	if (name === 'update_note') {
		const noteId = Number(a.note_id)
		if (!Number.isInteger(noteId) || noteId <= 0) return { result: 'error: note_id must be a positive integer', step: step('update_note', '(bad id)') }
		const existing = getNote(noteId); if (!existing) return { result: `note not found: ${noteId}`, step: step('update_note', String(noteId)) }
		const title = a.title != null ? String(a.title) : existing.title
		const content = a.content != null ? String(a.content) : (existing.content ?? '')
		saveNote({ id: noteId, title, content, origin: 'ai' })
		return { result: `note ${noteId} updated`, step: step('update_note', title ?? String(noteId)) }
	}
	if (name === 'add_tags') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('add_tags', key) }
		const tags = Array.isArray(a.tags) ? a.tags.map(String) : []
		const res = mergeTagsForItem(item.id, tags)
		return { result: `tagged "${item.title ?? key}" (+${res.added})`, step: step('add_tags', tags.join(', ')) }
	}
	if (name === 'add_to_collection') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('add_to_collection', key) }
		const cname = String(a.collection ?? '').trim()
		if (!cname) return { result: 'error: empty collection name', step: step('add_to_collection', '(empty)') }
		const existing = listAllCollections().find((c) => c.name.toLowerCase() === cname.toLowerCase())
		const col = existing ?? createCollection(cname)
		addItemToCollection(col.id, item.id)
		return { result: `filed "${item.title ?? key}" into "${col.name}"`, step: step('add_to_collection', col.name) }
	}
	if (name === 'link_items') {
		const src = resolveItem(String(a.from_key ?? '')); const dst = resolveItem(String(a.to_key ?? ''))
		if (!src) return { result: `item not found: ${a.from_key}`, step: step('link_items', String(a.from_key ?? '')) }
		if (!dst) return { result: `item not found: ${a.to_key}`, step: step('link_items', String(a.to_key ?? '')) }
		const relType = String(a.rel_type ?? '')
		try {
			const created = linkItems(src.id, dst.id, relType, 'ai')
			return { result: created ? `linked "${src.title ?? src.id}" —${relType}→ "${dst.title ?? dst.id}"` : 'link already existed', step: step('link_items', relType) }
		} catch (err) {
			return { result: `error: ${(err as Error).message}`, step: step('link_items', relType) }
		}
	}
	if (name === 'update_metadata') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('update_metadata', key) }
		const patch: Record<string, unknown> = {}
		for (const f of ['title', 'abstract', 'year', 'journal', 'doi', 'url', 'volume', 'issue', 'pages'] as const) {
			if (a[f] !== undefined) patch[f] = a[f]
		}
		updateItem(item.id, patch as Parameters<typeof updateItem>[1])
		return { result: `updated metadata of "${item.title ?? key}"`, step: step('update_metadata', Object.keys(patch).join(', ')) }
	}
	if (name === 'set_star') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('set_star', key) }
		setStarred(item.id, Boolean(a.starred))
		return { result: `${a.starred ? 'starred' : 'unstarred'} "${item.title ?? key}"`, step: step('set_star', item.title ?? key) }
	}

	return { result: `error: unknown tool ${name}`, step: step(name as Step, '(unknown)') }
}
