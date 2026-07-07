import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import logoUrl from '../../assets/logo.png'

export function Toolbar(): JSX.Element {
  const { t } = useTranslation('common')
  const { searchQuery, setSearchQuery, loadItems, activeCollection } = useItemStore()
  const searchRef = useRef<HTMLInputElement>(null)

  const activeColId = activeCollection.startsWith('col:')
    ? parseInt(activeCollection.slice(4), 10)
    : undefined

  const handleImport = async (): Promise<void> => {
    const result = await window.veridian.import.openDialog(activeColId)
    if (!result.canceled && result.imported > 0) {
      await loadItems()
    }
  }

  const handleAdd = async (): Promise<void> => {
    try {
      const item = await window.veridian.items.create({ type: 'journalArticle', title: '新条目' })
      if (activeColId && item?.id) {
        await window.veridian.collections.addItem(activeColId, item.id)
      }
      await loadItems()
    } catch (err) {
      console.error('[Toolbar] handleAdd failed:', err)
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); handleAdd() }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <header
      style={{
        height: 64,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 24px',
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--separator)',
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 8, userSelect: 'none' }}>
        <img src={logoUrl} alt="" style={{ width: 32, height: 32, objectFit: 'contain' }} draggable={false} />
        <span style={{
          fontSize: 20,
          fontWeight: 700,
          color: 'var(--foreground)',
          letterSpacing: '-0.02em',
        }}>
          Veridian
        </span>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', flex: 1, maxWidth: 370 }}>
        <input
          ref={searchRef}
          type="search"
          placeholder={t('toolbar.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            height: 38,
            paddingLeft: 14,
            paddingRight: 12,
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            fontSize: 14,
            color: 'var(--foreground)',
            boxShadow: 'var(--shadow-sm)',
          }}
        />
      </div>

      <div style={{ flex: 1 }} />

      {/* Import (secondary) */}
      <button
        onClick={handleImport}
        className="btn-secondary"
        style={{
          height: 38,
          padding: '0 18px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--foreground-2)',
          fontSize: 14,
          fontWeight: 500,
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 14 }}>↓</span>
        {t('toolbar.import')}
      </button>

      {/* Add (primary gradient) */}
      <button
        onClick={handleAdd}
        title="Ctrl+N"
        className="btn-primary"
        style={{
          height: 38,
          padding: '0 18px',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          color: '#fff',
          fontSize: 14,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 17, lineHeight: 1 }}>+</span>
        {t('toolbar.addItem')}
      </button>

    </header>
  )
}
