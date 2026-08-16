import { createNote as repoCreate, updateNote as repoUpdate, deleteNote as repoDelete, listNotesByItem, type NoteInput } from '../db/notes'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export { listNotesByItem }

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

export function deleteNote(id: number, itemId: number | null): void {
	repoDelete(id)
	appendOp('note', id, 'delete', {})
	if (itemId != null) emit({ type: 'note.changed', itemIds: [itemId] })
}
