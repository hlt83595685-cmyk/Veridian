import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import { useCollectionStore } from '../../stores/collectionStore'
import type { Item } from '../../../../shared/types'

interface ContextMenu { x: number; y: number; itemId: number | null; showMove?: boolean }

const TYPE_ICON: Record<string, string> = {
  journalArticle:  '📄',
  book:            '📗',
  bookSection:     '📖',
  thesis:          '🎓',
  conferencePaper: '🎤',
  report:          '📋',
  webpage:         '🌐',
  preprint:        '📝',
}

function ItemRow({ item, selected, onClick, onDoubleClick, onContextMenu }: {
  item: Item
  selected: boolean
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const { t } = useTranslation('common')
  const icon = TYPE_ICON[item.type] ?? '📄'

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 14px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--separator)',
        background: selected ? 'var(--primary-light)' : 'transparent',
        borderLeft: `3px solid ${selected ? 'var(--primary)' : 'transparent'}`,
        transition: 'background var(--duration) var(--ease)',
        userSelect: 'none',
      }}
    >
      <span style={{ fontSize: 18, marginTop: 1, flexShrink: 0 }}>{icon}</span>
      {/* Title + tags */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: 18,
          fontFamily: '"Times New Roman", "Georgia", "Palatino Linotype", serif',
          fontWeight: selected ? 600 : 500,
          color: selected ? 'var(--primary)' : 'var(--foreground)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          lineHeight: 1.4,
        }}>
          {item.title || t('item.untitled')}
        </p>
        {item.tags && item.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {item.tags.slice(0, 6).map((tag) => (
              <span key={tag} style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 14,
                fontFamily: '"Adobe Gothic Std B", "Adobe Gothic Std", "Source Han Sans", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
                fontWeight: 700,
                letterSpacing: '0.02em',
                background: 'rgba(102,8,116,0.07)',
                color: '#660874',
                border: '1px solid rgba(102,8,116,0.20)',
                lineHeight: 1.7,
                whiteSpace: 'nowrap',
              }}>
                {tag}
              </span>
            ))}
            {item.tags.length > 6 && (
              <span style={{
                fontSize: 12, color: '#660874', lineHeight: 1.7,
                alignSelf: 'center', opacity: 0.6,
                fontFamily: '"Adobe Gothic Std B", sans-serif',
              }}>
                +{item.tags.length - 6}
              </span>
            )}
          </div>
        )}
      </div>
      {/* Journal column */}
      <div style={{
        flexShrink: 0,
        width: 130,
        textAlign: 'right',
        paddingTop: 2,
        overflow: 'hidden',
      }}>
        <span style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 400,
          color: selected ? 'var(--primary)' : 'var(--foreground-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {item.journal ?? ''}
        </span>
      </div>
      {/* Year column */}
      <div style={{
        flexShrink: 0,
        width: 40,
        textAlign: 'right',
        paddingTop: 2,
      }}>
        <span style={{
          fontSize: 12,
          fontWeight: selected ? 600 : 500,
          color: selected ? 'var(--primary)' : 'var(--accent-orange)',
          letterSpacing: '-0.01em',
        }}>
          {item.year ?? '—'}
        </span>
      </div>
    </div>
  )
}

export function ItemListPane(): JSX.Element {
  const { t } = useTranslation('common')
  const { items, selectedId, setSelectedId, searchQuery, activeCollection, loadItems, yearSort, toggleYearSort } = useItemStore()
  const { collections } = useCollectionStore()
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const isTrash = activeCollection === 'trash'
  const isCollection = activeCollection.startsWith('col:')
  const activeColId = isCollection ? parseInt(activeCollection.slice(4), 10) : null

  const filtered = (() => {
    let list = items
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (i) => i.title?.toLowerCase().includes(q) || i.abstract?.toLowerCase().includes(q)
      )
    }
    if (yearSort === 'desc') {
      list = [...list].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    }
    return list
  })()

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleDoubleClick = async (item: Item): Promise<void> => {
    setSelectedId(item.id)
    try {
      const atts = await window.veridian.attachments.getByItem(item.id)
      const pdf = atts.find(
        (a) => a.mime_type === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
      )
      if (!pdf) return
      const path = await window.veridian.attachments.getPath(pdf.id)
      if (path) useItemStore.getState().openPdf(path, pdf.filename ?? 'document.pdf')
    } catch (err) {
      console.error('[ItemListPane] double-click open failed:', err)
    }
  }

  const handleTrash = async (id: number): Promise<void> => {
    await window.veridian.items.trash(id)
    if (selectedId === id) setSelectedId(null)
    await loadItems()
    setContextMenu(null)
  }

  const handleRestore = async (id: number): Promise<void> => {
    await window.veridian.items.restore(id)
    if (selectedId === id) setSelectedId(null)
    await loadItems()
    setContextMenu(null)
  }

  const handleRemoveFromCollection = async (id: number): Promise<void> => {
    if (activeColId === null) return
    await window.veridian.collections.removeItem(activeColId, id)
    if (selectedId === id) setSelectedId(null)
    await loadItems()
    setContextMenu(null)
  }

  const handleDeletePermanently = async (id: number): Promise<void> => {
    await window.veridian.items.delete(id)
    if (selectedId === id) setSelectedId(null)
    await loadItems()
    setContextMenu(null)
  }

  const handleEmptyTrash = async (): Promise<void> => {
    await window.veridian.items.emptyTrash()
    setSelectedId(null)
    await loadItems()
    setContextMenu(null)
  }

  const handleExtractKeywords = async (itemId: number): Promise<void> => {
    setContextMenu(null)
    const result = await window.veridian.items.extractKeywords(itemId)
    if (result.added > 0) await loadItems()
  }

  const handlePdf2md = async (itemId: number): Promise<void> => {
    setContextMenu(null)
    const result = await window.veridian.pdf2md.convertItem(itemId)
    if (result.error === 'no_pdf') {
      alert(t('item.pdf2mdNoPdf'))
    }
  }

  const handleMoveToCollection = async (itemId: number, colId: number): Promise<void> => {
    // Remove from current collection (if in one), add to target
    if (activeColId !== null) {
      await window.veridian.collections.removeItem(activeColId, itemId)
    }
    await window.veridian.collections.addItem(colId, itemId)
    await loadItems()
    setContextMenu(null)
  }

  const handleAddToCollection = async (itemId: number, colId: number): Promise<void> => {
    await window.veridian.collections.addItem(colId, itemId)
    setContextMenu(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      onClick={() => setContextMenu(null)}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '0 14px', height: 36,
        borderBottom: '1px solid var(--separator)',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
        gap: 8,
      }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em' }}>
          {t('item.listHeader', { count: filtered.length })}
        </span>
        {/* Journal column header */}
        <span style={{
          width: 130, textAlign: 'right', flexShrink: 0,
          fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em',
        }}>
          {t('item.journalColumn')}
        </span>
        {/* Year column header — clickable sort */}
        <button
          onClick={toggleYearSort}
          title={yearSort === 'desc' ? t('item.sortYearReset') : t('item.sortYearDesc')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2,
            width: 40, flexShrink: 0,
            padding: '2px 0',
            border: 'none',
            background: 'transparent',
            color: yearSort === 'desc' ? 'var(--accent-orange)' : 'var(--muted)',
            fontSize: 11, fontWeight: yearSort === 'desc' ? 700 : 600,
            letterSpacing: '0.04em',
            cursor: 'pointer',
            transition: 'color var(--duration) var(--ease)',
          }}
        >
          {t('item.yearColumn')}
          <span style={{ fontSize: 8, lineHeight: 1, marginTop: 1 }}>
            {yearSort === 'desc' ? '↓' : '↕'}
          </span>
        </button>
      </div>

      {/* List */}
      <div
        style={{ flex: 1, overflowY: 'auto' }}
        onContextMenu={isTrash ? (e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, itemId: null }) } : undefined}
      >
        {filtered.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', gap: 10,
            color: 'var(--muted)',
          }}>
            <span style={{ fontSize: 36 }}>{isTrash ? '🗑' : '📚'}</span>
            <p style={{ fontSize: 13 }}>{isTrash ? t('item.trashEmpty') : t('item.empty')}</p>
          </div>
        ) : (
          filtered.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              onClick={() => setSelectedId(item.id)}
              onDoubleClick={() => handleDoubleClick(item)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, itemId: item.id }) }}
            />
          ))
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 100,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            padding: '4px',
            minWidth: 160,
          }}
        >
          {isTrash ? (
            <>
              {contextMenu.itemId !== null && (
                <>
                  <ContextItem label={t('item.restore')} icon="↩" color="var(--primary)"
                    onClick={() => handleRestore(contextMenu.itemId!)} />
                  <ContextItem label={t('item.deletePermanently')} icon="✕" color="var(--accent)"
                    onClick={() => handleDeletePermanently(contextMenu.itemId!)} />
                  <div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />
                </>
              )}
              <ContextItem label={t('item.emptyTrash')} icon="🗑" color="var(--accent)"
                onClick={handleEmptyTrash} />
            </>
          ) : isCollection ? (
            <>
              {contextMenu.itemId !== null && (
                <>
                  <ContextItem label={t('item.extractKeywords')} icon="🔑" color="var(--foreground)"
                    onClick={() => handleExtractKeywords(contextMenu.itemId!)} />
                  <ContextItem label={t('item.pdf2md')} icon="M↓" color="var(--primary)"
                    onClick={() => handlePdf2md(contextMenu.itemId!)} />
                </>
              )}
              {contextMenu.itemId !== null && collections.filter(c => c.id !== activeColId).length > 0 && (
                <CollectionSubMenu
                  label={t('item.moveToCollection')}
                  collections={collections.filter(c => c.id !== activeColId)}
                  onSelect={(colId) => handleMoveToCollection(contextMenu.itemId!, colId)}
                />
              )}
              <ContextItem label={t('item.removeFromCollection')} icon="↩" color="var(--primary)"
                onClick={() => handleRemoveFromCollection(contextMenu.itemId!)} />
              <div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />
              <ContextItem label={t('item.moveToTrash')} icon="🗑" color="var(--accent)"
                onClick={() => handleTrash(contextMenu.itemId!)} />
            </>
          ) : (
            <>
              {contextMenu.itemId !== null && (
                <>
                  <ContextItem label={t('item.extractKeywords')} icon="🔑" color="var(--foreground)"
                    onClick={() => handleExtractKeywords(contextMenu.itemId!)} />
                  <ContextItem label={t('item.pdf2md')} icon="M↓" color="var(--primary)"
                    onClick={() => handlePdf2md(contextMenu.itemId!)} />
                </>
              )}
              {collections.length > 0 && contextMenu.itemId !== null && (
                <CollectionSubMenu
                  label={t('item.addToCollection')}
                  collections={collections}
                  onSelect={(colId) => handleAddToCollection(contextMenu.itemId!, colId)}
                />
              )}
              {<div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />}
              <ContextItem label={t('item.moveToTrash')} icon="🗑" color="var(--accent)"
                onClick={() => handleTrash(contextMenu.itemId!)} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ContextItem({ label, icon, color, onClick }: {
  label: string; icon: string; color: string; onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '7px 12px',
        borderRadius: 'var(--radius-md)', border: 'none',
        background: 'transparent', color,
        fontSize: 13, fontWeight: 500, textAlign: 'left',
      }}
    >
      <span>{icon}</span>
      {label}
    </button>
  )
}

function CollectionSubMenu({ label, collections, onSelect }: {
  label: string
  collections: { id: number; name: string }[]
  onSelect: (colId: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ position: 'relative', isolation: 'isolate' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          width: '100%', padding: '7px 12px',
          borderRadius: 'var(--radius-md)', border: 'none',
          background: open ? 'var(--primary-light)' : 'transparent',
          color: 'var(--foreground)',
          fontSize: 13, fontWeight: 500, textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>📁</span>{label}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>▶</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: '100%',
          marginLeft: 4,
          zIndex: 200,
          background: 'rgba(255,255,255,0.95)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          padding: 4,
          minWidth: 160,
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          {collections.map((col) => (
            <button
              key={col.id}
              onClick={() => onSelect(col.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '7px 12px',
                borderRadius: 'var(--radius-md)', border: 'none',
                background: 'transparent', color: 'var(--foreground)',
                fontSize: 13, fontWeight: 500, textAlign: 'left',
              }}
            >
              <span>📁</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {col.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
