import { useState, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Tag } from '../../../../shared/types'
import { useTags } from '../../data/hooks'
import { mutate } from '../../data/queryCache'

export function TagsTab({ itemId }: { itemId: number }): JSX.Element {
  const { t } = useTranslation('common')
  // Event-driven read; tag.changed events (e.g. keyword extraction finishing
  // in the background) refresh this list automatically.
  const { data: tags } = useTags(itemId)
  const [input, setInput] = useState('')

  const commit = async (next: Tag[]): Promise<void> => {
    // Optimistic: the chip appears instantly, rolls back if the write fails
    await mutate<Tag[]>(
      ['tags', itemId],
      () => next,
      () => window.veridian.tags.setForItem(itemId, next.map((t) => t.name))
    )
  }

  const addTag = async (): Promise<void> => {
    const name = input.trim()
    if (!name || tags.some((t) => t.name === name)) return
    await commit([...tags, { id: 0, name }])
    setInput('')
  }

  const removeTag = (name: string): void => {
    commit(tags.filter((t) => t.name !== name))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') { e.preventDefault(); addTag() }
  }

  return (
    <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Input row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          placeholder={t('detail.tagPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1, height: 34, padding: '0 10px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            fontSize: 13,
            boxShadow: 'var(--shadow-xs)',
          }}
        />
        <button
          onClick={addTag}
          style={{
            height: 34, padding: '0 14px',
            borderRadius: 'var(--radius-md)', border: 'none',
            background: 'var(--primary)', color: '#fff',
            fontSize: 13, fontWeight: 600,
            boxShadow: '0 2px 6px rgba(0,122,255,0.25)',
            flexShrink: 0,
          }}
        >
          {t('detail.addTag')}
        </button>
      </div>

      {/* Tag bubbles */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {tags.length === 0 ? (
          <span style={{
            fontSize: 13,
            fontFamily: 'Cambria, "Times New Roman", Georgia, serif',
            fontStyle: 'italic',
            color: 'var(--muted)',
          }}>
            {t('detail.noTags')}
          </span>
        ) : tags.map((tag) => (
          <span
            key={tag.name}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px 4px 12px',
              borderRadius: 6,
              background: 'rgba(102,8,116,0.07)',
              border: '1px solid rgba(102,8,116,0.22)',
              color: '#660874',
              fontFamily: '"Adobe Gothic Std B", "Adobe Gothic Std", "Source Han Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
              lineHeight: 1.6,
              transition: 'background var(--duration) var(--ease)',
            }}
          >
            {tag.name}
            <button
              onClick={() => removeTag(tag.name)}
              style={{
                background: 'none', border: 'none',
                color: 'var(--primary)', fontSize: 15,
                lineHeight: 1, opacity: 0.45, padding: '0 0 1px',
                cursor: 'pointer', flexShrink: 0,
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}
