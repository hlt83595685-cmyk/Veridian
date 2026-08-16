// AI library-action tools: the write half of the chat agent (the read half —
// search_library / read_context / get_item_info — lives in agent.ts). Each
// executor resolves an item_key (exact, then unique-prefix fallback for the
// truncated UUID keys folder-backed libraries use), performs the mutation via a
// Service (which emits a domain event), and returns a short confirmation plus a
// RetrievalStep for the trace panel. AI-created notes/edges are tagged origin='ai'.
import { getDb } from '../db'
import { mergeTagsForItem, listAll as listAllTags } from '../services/TagService'
import { listAll as listAllCollections, createCollection, addItemToCollection } from '../services/CollectionService'
import { updateItem, setStarred, listItems } from '../services/ItemService'
import { createNote, listNotesByItem } from '../services/NoteService'
import { linkItems } from '../services/RelationService'
import { RELATION_TYPES } from '../db/relations'
import type { ToolDef } from './providers'
import type { RetrievalStep } from '../../shared/types'

function resolveItem(key: string): { id: number; title: string | null } | null {
	const db = getDb()
	let row = db.prepare('SELECT id, title FROM items WHERE key = ? AND deleted = 0')
		.get(key) as { id: number; title: string | null } | undefined
	if (!row) {
		const like = key.replace(/[\\%_]/g, '\\$&') + '%'
		const hits = db.prepare("SELECT id, title FROM items WHERE key LIKE ? ESCAPE '\\' AND deleted = 0 LIMIT 2")
			.all(like) as { id: number; title: string | null }[]
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
]

export const AGENT_WRITE_TOOLS: ToolDef[] = [
	{ type: 'function', function: {
			name: 'create_note',
			description: 'Attach a note to a paper. Use for summaries or observations the user asks you to save.',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
			}, required: ['item_key', 'content'] } } },
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

export async function executeAgentTool(name: string, argsJson: string): Promise<{ result: string; step: RetrievalStep }> {
	let a: Record<string, unknown>
	try { a = JSON.parse(argsJson || '{}') } catch { return { result: 'error: invalid arguments', step: step(name as Step, '(bad args)') } }
	const key = String(a.item_key ?? '')

	if (name === 'list_items') {
		const items = listItems()
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
		const body = notes.length ? notes.map((n) => `- ${n.title ?? '(untitled)'}: ${n.content ?? ''}`).join('\n') : '(no notes)'
		return { result: body, step: step('read_notes', item.title ?? key) }
	}

	if (name === 'create_note') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('create_note', key) }
		createNote({ itemId: item.id, title: a.title ? String(a.title) : null, content: String(a.content ?? ''), origin: 'ai' })
		return { result: `note added to "${item.title ?? key}"`, step: step('create_note', item.title ?? key) }
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
