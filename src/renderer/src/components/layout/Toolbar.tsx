import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'

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
        height: 52,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 16px',
        background: 'rgba(242,242,247,0.85)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottom: '1px solid var(--separator)',
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      {/* App name */}
      <span style={{
        fontSize: 15,
        fontWeight: 700,
        color: 'var(--primary)',
        letterSpacing: '-0.02em',
        marginRight: 4,
        userSelect: 'none',
      }}>
        Veridian
      </span>

      {/* Search */}
      <div style={{ position: 'relative', flex: 1, maxWidth: 280 }}>
        <span style={{
          position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--muted)', fontSize: 13, pointerEvents: 'none',
        }}>
          🔍
        </span>
        <input
          ref={searchRef}
          type="search"
          placeholder={t('toolbar.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: '100%',
            height: 32,
            paddingLeft: 30,
            paddingRight: 10,
            borderRadius: 10,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            fontSize: 13,
            color: 'var(--foreground)',
            boxShadow: 'var(--shadow-xs)',
          }}
        />
      </div>

      <div style={{ flex: 1 }} />

      {/* Import */}
      <button
        onClick={handleImport}
        style={{
          height: 32,
          padding: '0 14px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--foreground-2)',
          fontSize: 13,
          fontWeight: 500,
          boxShadow: 'var(--shadow-xs)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <span style={{ fontSize: 14 }}>↓</span>
        {t('toolbar.import')}
      </button>

      {/* Add */}
      <button
        onClick={handleAdd}
        title="Ctrl+N"
        style={{
          height: 32,
          padding: '0 14px',
          borderRadius: 'var(--radius-md)',
          border: 'none',
          background: 'var(--primary)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 600,
          boxShadow: '0 2px 6px rgba(0,122,255,0.30)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
        {t('toolbar.addItem')}
      </button>

    </header>
  )
}
