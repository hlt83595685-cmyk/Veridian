import { createNote as repoCreate, updateNote as repoUpdate, deleteNote as repoDelete, listNotesByItem, listStandaloneNotes, findNoteByTitle, getNote, type NoteInput } from '../db/notes'
import { findItemByTitle, getItemById } from '../db/items'
import { setWikilinksForNote, listBacklinks, deleteRelationsForNote, type LinkEndpoint } from '../db/relations'
import { extractWikiTargets } from '../knowledge/wikilinks'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export { listNotesByItem, listStandaloneNotes, getNote }

// --- P1 API kept intact (agentTools.ts imports createNote; updateNote unused
//     externally but harmless to keep) ---

export function createNote(input: NoteInput): number {
	const id = repoCreate(input)
	appendOp('note', id, 'create', { itemId: input.itemId ?? null, origin: input.origin ?? 'user' })
	if (input.itemId != null) emit({ type: 'note.changed', itemIds: [input.itemId] })
	return id
}

export function updateNote(id: number, itemId: number | null, patch: { title?: string | null; content?: string | null; updatedBy: 'user' | 'ai' }): void {
	repoUpdate(id, patch)
	appendOp('note', id, 'modify', {})
	if (itemId != null) emit({ type: 'note.changed', itemIds: [itemId] })
}

// --- P2-A wikilink-aware API ---

/** Resolve a note's [[..]] targets to concrete item/note endpoints. Unresolved
 *  titles are dropped (no edge). Priority: standalone note first, then paper. */
function resolveTargets(content: string, selfNoteId: number): LinkEndpoint[] {
	const out: LinkEndpoint[] = []
	for (const title of extractWikiTargets(content)) {
		const note = findNoteByTitle(title)
		if (note && note.id !== selfNoteId) { out.push({ kind: 'note', id: note.id }); continue }
		const item = findItemByTitle(title)
		if (item) out.push({ kind: 'item', id: item.id })
	}
	return out
}

/** Create or update a note, then reconcile its wikilink out-edges from the
 *  content. Returns the note id. */
export function saveNote(input: { id?: number; itemId?: number | null; title?: string | null; content?: string | null }): number {
	let id = input.id
	if (id == null) {
		id = repoCreate({ itemId: input.itemId ?? null, title: input.title ?? null, content: input.content ?? '', origin: 'user' })
		appendOp('note', id, 'create', { itemId: input.itemId ?? null })
	} else {
		repoUpdate(id, { title: input.title ?? null, content: input.content ?? null, updatedBy: 'user' })
		appendOp('note', id, 'modify', {})
	}
	setWikilinksForNote(id, resolveTargets(input.content ?? '', id))
	const itemId = input.itemId ?? getNote(id)?.item_id ?? null
	emit({ type: 'note.changed', itemIds: itemId != null ? [itemId] : [] })
	emit({ type: 'relation.changed', itemIds: itemId != null ? [itemId] : [] })
	return id
}

export function deleteNote(id: number): void {
	const note = getNote(id)
	deleteRelationsForNote(id)
	repoDelete(id)
	appendOp('note', id, 'delete', {})
	emit({ type: 'note.changed', itemIds: note?.item_id != null ? [note.item_id] : [] })
	emit({ type: 'relation.changed', itemIds: [] })
}

/** Backlinks (incoming edges) resolved to display rows. */
export function getBacklinks(kind: 'item' | 'note', id: number): { kind: 'item' | 'note'; id: number; title: string; relType: string }[] {
	return listBacklinks(kind, id).map((r) => {
		const title = r.src_kind === 'note'
			? (getNote(r.src_id)?.title ?? '(untitled note)')
			: (getItemById(r.src_id)?.title ?? '(unknown)')
		return { kind: r.src_kind as 'item' | 'note', id: r.src_id, title, relType: r.rel_type }
	})
}

/** Resolve a [[Title]] to an endpoint (note preferred over item), or null if
 *  unresolved — for the renderer's click-through / create-on-miss. */
export function resolveTitle(title: string): { kind: 'item' | 'note'; id: number } | null {
	const note = findNoteByTitle(title)
	if (note) return { kind: 'note', id: note.id }
	const item = findItemByTitle(title)
	if (item) return { kind: 'item', id: item.id }
	return null
}
