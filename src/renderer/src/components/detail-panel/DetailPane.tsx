import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import { MetadataTab } from './MetadataTab'
import { TagsTab } from './TagsTab'
import { AttachmentsTab } from './AttachmentsTab'
import { NoteEditor } from '../notes/NoteEditor'
import { Backlinks } from '../notes/Backlinks'
import { resolveWiki } from '../notes/resolveWiki'
import type { Item } from '../../../../shared/types'

type Tab = 'metadata' | 'tags' | 'attachments' | 'notes'

// Remembered across item switches (and detail-pane open/close) within a
// session, so selecting another paper keeps you on the tab you were reading
// rather than snapping back to metadata. All four tabs apply to every item.
let lastDetailTab: Tab = 'metadata'

function NotesTab({ itemId }: { itemId: number }): JSX.Element {
  const [noteId, setNoteId] = useState<number | undefined>(undefined)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => { void window.veridian.notes.listByItem(itemId).then((ns) => setNoteId(ns[0]?.id)) }, [itemId])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16, gap: 12, minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 120 }}>
        <NoteEditor noteId={noteId} itemId={itemId} onWiki={resolveWiki} onSaved={(id) => { setNoteId(id); setRefreshKey((k) => k + 1) }} />
      </div>
      <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
        <Backlinks kind="item" id={itemId} refreshKey={refreshKey}
          onOpen={(k, i) => (k === 'note' ? useItemStore.getState().openNote(i) : useItemStore.getState().setSelectedId(i))} />
      </div>
    </div>
  )
}

export function DetailPane({ itemId }: { itemId: number }): JSX.Element {
  const { t } = useTranslation('common')
  const { items, loadItems, setSelectedId } = useItemStore()
  const [tab, setTabState] = useState<Tab>(lastDetailTab)
  const setTab = (t: Tab): void => { lastDetailTab = t; setTabState(t) }

  const item = items.find((i) => i.id === itemId)
  const handleSaved = useCallback(() => loadItems(), [loadItems])

  if (!item) return <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>...</div>

  const tabs: { id: Tab; label: string }[] = [
    { id: 'metadata',    label: t('detail.tab.metadata') },
    { id: 'tags',        label: t('detail.tab.tags') },
    { id: 'attachments', label: t('detail.tab.attachments') },
    { id: 'notes',       label: t('detail.tab.notes') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tabs */}
      <div style={{
        display: 'flex',
        padding: '0 12px',
        borderBottom: '1px solid var(--separator)',
        background: 'var(--bg)',
        flexShrink: 0,
        gap: 0,
      }}>
        {tabs.map((tb) => {
          const active = tab === tb.id
          return (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              style={{
                padding: '10px 12px',
                border: 'none',
                borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
                background: 'transparent',
                color: active ? 'var(--primary)' : 'var(--muted)',
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                whiteSpace: 'nowrap',
                transition: 'color var(--duration) var(--ease)',
              }}
            >
              {tb.label}
            </button>
          )
        })}
        <div style={{ flex: 1 }} />
        {/* Collapse the detail panel back to the right (deselects the item). */}
        <button
          onClick={() => setSelectedId(null)}
          title={t('detail.collapse')}
          style={{
            alignSelf: 'center', flexShrink: 0,
            width: 26, height: 26, borderRadius: 'var(--radius-md)',
            border: 'none', background: 'transparent', color: 'var(--muted)',
            cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
        {tab === 'metadata'    && <MetadataTab item={item} onSaved={handleSaved} />}
        {tab === 'tags'        && <TagsTab itemId={item.id} />}
        {tab === 'attachments' && <AttachmentsTab itemId={item.id} />}
        {tab === 'notes'       && <NotesTab itemId={item.id} />}
      </div>
    </div>
  )
}
