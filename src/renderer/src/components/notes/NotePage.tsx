import { useState } from 'react'
import { useItemStore } from '../../stores/itemStore'
import { NoteEditor } from './NoteEditor'
import { Backlinks } from './Backlinks'
import { resolveWiki } from './resolveWiki'

export function NotePage(): JSX.Element {
	const noteId = useItemStore((s) => s.noteViewerId)!
	const [refreshKey, setRefreshKey] = useState(0)
	return (
		<div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
			<div style={{ flex: 1, padding: 18, minWidth: 0 }}>
				<NoteEditor noteId={noteId} onWiki={resolveWiki} onSaved={() => setRefreshKey((k) => k + 1)} />
			</div>
			<div style={{ flex: '0 0 220px', borderLeft: '1px solid var(--border)', padding: 16, overflowY: 'auto' }}>
				<Backlinks kind="note" id={noteId} refreshKey={refreshKey}
					onOpen={(k, i) => (k === 'note' ? useItemStore.getState().openNote(i) : useItemStore.getState().setSelectedId(i))} />
			</div>
		</div>
	)
}
