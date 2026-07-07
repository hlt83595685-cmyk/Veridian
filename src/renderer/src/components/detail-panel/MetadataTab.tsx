import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Item, Creator, ItemType } from '../../../../shared/types'
import { ITEM_TYPE_LABELS } from '../../../../shared/types'

interface Props { item: Item; onSaved: () => void }

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  padding: '0 10px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontSize: 13,
  color: 'var(--foreground)',
  boxShadow: 'var(--shadow-xs)',
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontSize: 13,
  color: 'var(--foreground)',
  resize: 'vertical',
  lineHeight: 1.6,
  boxShadow: 'var(--shadow-xs)',
}

export function MetadataTab({ item, onSaved }: Props): JSX.Element {
  const { t, i18n } = useTranslation('common')
  const lang = i18n.language as 'zh' | 'en'
  const [fields, setFields] = useState<Partial<Item>>({})
  const [creators, setCreators] = useState<Creator[]>([])
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setFields({
      title: item.title ?? '', type: item.type,
      abstract: item.abstract ?? '', year: item.year ?? undefined,
      doi: item.doi ?? '', url: item.url ?? '',
      journal: item.journal ?? '', publisher: item.publisher ?? '',
      volume: item.volume ?? '', issue: item.issue ?? '',
      pages: item.pages ?? '', isbn: item.isbn ?? '',
      language: item.language ?? '',
    })
    setDirty(false)
    window.veridian.creators.getByItem(item.id).then(setCreators)
  }, [item.id])

  const setField = (key: keyof Item, value: unknown): void => {
    setFields((p) => ({ ...p, [key]: value }))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (!dirty) return
    await window.veridian.items.update(item.id, fields as Record<string, unknown>)
    await window.veridian.creators.setForItem(item.id, creators)
    setDirty(false)
    onSaved()
  }

  const addCreator = (): void => {
    setCreators((p) => [...p, { last_name: '', first_name: '', role: 'author', position: p.length }])
    setDirty(true)
  }

  const updateCreator = (i: number, f: keyof Creator, v: string): void => {
    setCreators((p) => p.map((c, idx) => idx === i ? { ...c, [f]: v } : c))
    setDirty(true)
  }

  const removeCreator = (i: number): void => {
    setCreators((p) => p.filter((_, idx) => idx !== i).map((c, idx) => ({ ...c, position: idx })))
    setDirty(true)
  }

  return (
    <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Save banner */}
      {dirty && (
        <div style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--primary-light)',
          border: '1px solid rgba(0,122,255,0.15)',
        }}>
          <span style={{ fontSize: 12, color: 'var(--primary)', flex: 1 }}>
            {t('detail.unsaved')}
          </span>
          <button
            onClick={save}
            style={{
              height: 28, padding: '0 14px',
              borderRadius: 'var(--radius-md)', border: 'none',
              background: 'var(--primary)', color: '#fff',
              fontSize: 12, fontWeight: 600,
              boxShadow: '0 2px 6px rgba(0,122,255,0.30)',
            }}
          >
            {t('detail.save')}
          </button>
        </div>
      )}

      {/* Type */}
      <Field label={t('detail.type')}>
        <select
          value={fields.type ?? ''}
          onChange={(e) => setField('type', e.target.value)}
          onBlur={save}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          {(Object.keys(ITEM_TYPE_LABELS) as ItemType[]).map((tp) => (
            <option key={tp} value={tp}>{ITEM_TYPE_LABELS[tp][lang]}</option>
          ))}
        </select>
      </Field>

      {/* Title */}
      <Field label={t('detail.title')}>
        <input
          value={fields.title ?? ''}
          onChange={(e) => setField('title', e.target.value)}
          onBlur={save}
          style={inputStyle}
        />
      </Field>

      {/* Authors */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('detail.authors')}
          </label>
          <button
            onClick={addCreator}
            style={{
              height: 24, padding: '0 10px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--primary)',
              background: 'var(--primary-light)',
              color: 'var(--primary)', fontSize: 11, fontWeight: 600,
            }}
          >
            + {t('detail.addAuthor')}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {creators.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <input
                placeholder={t('detail.lastName')}
                value={c.last_name}
                onChange={(e) => updateCreator(i, 'last_name', e.target.value)}
                onBlur={save}
                style={{ ...inputStyle, height: 30, flex: 1, fontSize: 12 }}
              />
              <input
                placeholder={t('detail.firstName')}
                value={c.first_name ?? ''}
                onChange={(e) => updateCreator(i, 'first_name', e.target.value)}
                onBlur={save}
                style={{ ...inputStyle, height: 30, flex: 1, fontSize: 12 }}
              />
              <select
                value={c.role}
                onChange={(e) => updateCreator(i, 'role', e.target.value)}
                onBlur={save}
                style={{ ...inputStyle, height: 30, width: 'auto', padding: '0 6px', fontSize: 12 }}
              >
                <option value="author">{t('detail.roleAuthor')}</option>
                <option value="editor">{t('detail.roleEditor')}</option>
                <option value="translator">{t('detail.roleTranslator')}</option>
              </select>
              <button
                onClick={() => removeCreator(i)}
                style={{
                  width: 26, height: 26, borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--muted)',
                  fontSize: 14, flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Year */}
      <Field label={t('detail.year')}>
        <input
          type="number"
          value={fields.year ?? ''}
          onChange={(e) => setField('year', e.target.value ? Number(e.target.value) : null)}
          onBlur={save}
          style={{ ...inputStyle, width: 100 }}
        />
      </Field>

      {/* Journal */}
      <Field label={t('detail.journal')}>
        <input value={fields.journal ?? ''} onChange={(e) => setField('journal', e.target.value)} onBlur={save} style={inputStyle} />
      </Field>

      {/* Volume / Issue / Pages */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label={t('detail.volume')} style={{ flex: 1 }}>
          <input value={fields.volume ?? ''} onChange={(e) => setField('volume', e.target.value)} onBlur={save} style={inputStyle} />
        </Field>
        <Field label={t('detail.issue')} style={{ flex: 1 }}>
          <input value={fields.issue ?? ''} onChange={(e) => setField('issue', e.target.value)} onBlur={save} style={inputStyle} />
        </Field>
        <Field label={t('detail.pages')} style={{ flex: 1 }}>
          <input value={fields.pages ?? ''} onChange={(e) => setField('pages', e.target.value)} onBlur={save} style={inputStyle} />
        </Field>
      </div>

      {/* Publisher */}
      <Field label={t('detail.publisher')}>
        <input value={fields.publisher ?? ''} onChange={(e) => setField('publisher', e.target.value)} onBlur={save} style={inputStyle} />
      </Field>

      {/* DOI */}
      <Field label="DOI">
        <input value={fields.doi ?? ''} onChange={(e) => setField('doi', e.target.value)} onBlur={save}
          style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
      </Field>

      {/* URL */}
      <Field label="URL">
        <input type="url" value={fields.url ?? ''} onChange={(e) => setField('url', e.target.value)} onBlur={save} style={inputStyle} />
      </Field>

      {/* Abstract */}
      <Field label={t('detail.abstract')}>
        <textarea
          rows={5}
          value={fields.abstract ?? ''}
          onChange={(e) => setField('abstract', e.target.value)}
          onBlur={save}
          style={textareaStyle}
        />
      </Field>
    </div>
  )
}

function Field({ label, children, style }: {
  label: string; children: React.ReactNode; style?: React.CSSProperties
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, ...style }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </label>
      {children}
    </div>
  )
}
