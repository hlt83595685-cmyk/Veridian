import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import { MetadataTab } from './MetadataTab'
import { TagsTab } from './TagsTab'
import { AttachmentsTab } from './AttachmentsTab'
import type { Item } from '../../../../shared/types'

type Tab = 'metadata' | 'tags' | 'attachments' | 'notes'

export function DetailPane({ itemId }: { itemId: number }): JSX.Element {
  const { t } = useTranslation('common')
  const { items, loadItems } = useItemStore()
  const [tab, setTab] = useState<Tab>('metadata')

  const item = items.find((i) => i.id === itemId)
  const handleSaved = useCallback(() => loadItems(), [loadItems])

  useEffect(() => { setTab('metadata') }, [itemId])

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
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
        {tab === 'metadata'    && <MetadataTab item={item} onSaved={handleSaved} />}
        {tab === 'tags'        && <TagsTab itemId={item.id} />}
        {tab === 'attachments' && <AttachmentsTab itemId={item.id} />}
        {tab === 'notes'       && (
          <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>
            {t('detail.notesPlaceholder')}
          </div>
        )}
      </div>
    </div>
  )
}
