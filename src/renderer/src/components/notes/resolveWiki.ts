import { useItemStore } from '../../stores/itemStore'

// Click a [[wikilink]]: resolve the title; open the paper (select) or the note
// (note page); if unresolved, offer to create a standalone note by that title.
export async function resolveWiki(title: string): Promise<void> {
	if (!title.trim()) return
	const r = await window.veridian.notes.resolveTitle(title)
	if (r?.kind === 'item') { useItemStore.getState().setSelectedId(r.id); return }
	if (r?.kind === 'note') { useItemStore.getState().openNote(r.id); return }
	if (window.confirm(`Create note “${title}”?`)) {
		const id = await window.veridian.notes.save({ title, content: '' })
		useItemStore.getState().openNote(id)
	}
}
