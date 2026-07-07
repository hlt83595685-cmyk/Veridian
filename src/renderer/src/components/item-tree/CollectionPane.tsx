import { useEffect, useState, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import { useCollectionStore } from '../../stores/collectionStore'

// ── SVG icons (inline, no external dep) ────────────────────────────────────

function IconLibrary(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" fill="none"/>
      <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
      <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      <line x1="5" y1="10.5" x2="9" y2="10.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  )
}

function IconRecent(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M8 5.5V8l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function IconTrash({ full }: { full?: boolean }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      <path d="M4 4.5l.7 8A1 1 0 0 0 5.7 13.5h4.6a1 1 0 0 0 1-.9l.7-8.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {full && <line x1="6.5" y1="7" x2="6.5" y2="11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>}
      {full && <line x1="9.5" y1="7" x2="9.5" y2="11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>}
    </svg>
  )
}

function IconFolder({ open }: { open?: boolean }): JSX.Element {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M2 5a1 1 0 0 1 1-1h3.4l1.2 1.5H13a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M2 5a1 1 0 0 1 1-1h3.4l1.2 1.5H13a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    </svg>
  )
}

function Twisty({ open, onClick }: { open: boolean; onClick: (e: React.MouseEvent) => void }): JSX.Element {
  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        flexShrink: 0,
        cursor: 'pointer',
        transition: 'transform 160ms ease',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        color: 'var(--muted)',
        borderRadius: 3,
      }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8">
        <path d="M2 1.5l3.5 2.5L2 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      </svg>
    </span>
  )
}

// ── Nav row ─────────────────────────────────────────────────────────────────

function NavRow({
  id, icon, label, active, depth = 0, hasTwisty = false, isOpen = false,
  onTwisty, onClick,
}: {
  id: string
  icon: JSX.Element
  label: string
  active: boolean
  depth?: number
  hasTwisty?: boolean
  isOpen?: boolean
  onTwisty?: (e: React.MouseEvent) => void
  onClick: () => void
}): JSX.Element {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '5px 8px',
        paddingLeft: 8 + depth * 18,
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--primary-light)' : 'transparent',
        color: active ? 'var(--primary)' : 'var(--foreground-2)',
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background var(--duration) var(--ease)',
        minHeight: 28,
      }}
      className="sidebar-row"
    >
      {hasTwisty && onTwisty
        ? <Twisty open={isOpen} onClick={(e) => { e.stopPropagation(); onTwisty(e) }} />
        : <span style={{ width: 16, flexShrink: 0 }} />
      }
      <span style={{ display: 'flex', alignItems: 'center', color: active ? 'var(--primary)' : 'var(--foreground-3)' }}>
        {icon}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function CollectionPane(): JSX.Element {
  const { t } = useTranslation('common')
  const { activeCollection, setActiveCollection } = useItemStore()
  const { collections, load, create, rename, remove } = useCollectionStore()

  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [collectionsOpen, setCollectionsOpen] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; colId: number } | null>(null)

  const trashFull = collections.length >= 0  // placeholder — real check is item count; always show normal icon for now

  useEffect(() => { load() }, [load])

  // Close context menu on outside click
  useEffect(() => {
    const handler = (): void => setContextMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const commitNew = async (): Promise<void> => {
    const n = newName.trim()
    if (n) await create(n)
    setNewName(''); setAdding(false)
  }

  const commitRename = async (): Promise<void> => {
    if (renamingId !== null && renameVal.trim()) await rename(renamingId, renameVal.trim())
    setRenamingId(null)
  }

  const onNewKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') commitNew()
    if (e.key === 'Escape') { setAdding(false); setNewName('') }
  }

  const onRenameKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') commitRename()
    if (e.key === 'Escape') setRenamingId(null)
  }

  const toggleExpand = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Build parent->children map for tree
  const childrenOf = (parentId: number | null) =>
    collections.filter((c) => c.parent_id === parentId)

  const renderCollection = (colId: number, depth: number): JSX.Element[] => {
    const col = collections.find((c) => c.id === colId)
    if (!col) return []
    const children = childrenOf(col.id)
    const hasChildren = children.length > 0
    const isOpen = expanded.has(col.id)
    const active = activeCollection === `col:${col.id}`

    const rows: JSX.Element[] = []

    if (renamingId === col.id) {
      rows.push(
        <div key={col.id} style={{ padding: '2px 4px', paddingLeft: 8 + depth * 18 + 20 }}>
          <input
            autoFocus
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={onRenameKey}
            onBlur={commitRename}
            style={{
              width: '100%', height: 28, padding: '0 8px',
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--primary)',
              background: 'var(--surface)', fontSize: 12,
            }}
          />
        </div>
      )
    } else {
      rows.push(
        <div
          key={col.id}
          style={{ position: 'relative' }}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, colId: col.id }) }}
        >
          <NavRow
            id={`col:${col.id}`}
            icon={<IconFolder open={isOpen && hasChildren} />}
            label={col.name}
            active={active}
            depth={depth}
            hasTwisty={hasChildren}
            isOpen={isOpen}
            onTwisty={() => toggleExpand(col.id)}
            onClick={() => setActiveCollection(`col:${col.id}`)}
          />
          {/* Rename on double-click overlay trigger */}
          <div
            onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(col.id); setRenameVal(col.name) }}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          />
        </div>
      )
    }

    if (hasChildren && isOpen) {
      children.forEach((child) => {
        rows.push(...renderCollection(child.id, depth + 1))
      })
    }

    return rows
  }

  const roots = childrenOf(null)

  return (
    <div
      style={{ padding: '8px 6px', display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}
      onClick={() => setContextMenu(null)}
    >
      {/* ── My Library header ── */}
      <p style={{
        fontSize: 10, fontWeight: 700, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        padding: '0 10px', marginBottom: 4, userSelect: 'none',
      }}>
        {t('collections.title')}
      </p>

      {/* All Items */}
      <NavRow
        id="all"
        icon={<IconLibrary />}
        label={t('collections.all')}
        active={activeCollection === 'all'}
        onClick={() => setActiveCollection('all')}
      />

      {/* Recent */}
      <NavRow
        id="recent"
        icon={<IconRecent />}
        label={t('collections.recent')}
        active={activeCollection === 'recent'}
        onClick={() => setActiveCollection('recent')}
      />

      {/* Trash */}
      <NavRow
        id="trash"
        icon={<IconTrash full={false} />}
        label={t('collections.trash')}
        active={activeCollection === 'trash'}
        onClick={() => setActiveCollection('trash')}
      />

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--separator)', margin: '8px 6px' }} />

      {/* My Collections section header with twisty */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '2px 4px', marginBottom: 2,
      }}>
        <span
          onClick={() => setCollectionsOpen((v) => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, cursor: 'pointer',
            transition: 'transform 160ms ease',
            transform: collectionsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            color: 'var(--muted)', flexShrink: 0,
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8">
            <path d="M2 1.5l3.5 2.5L2 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
        </span>
        <p style={{
          flex: 1,
          fontSize: 10, fontWeight: 700, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: '0.08em',
          padding: '0 4px', userSelect: 'none',
        }}>
          {t('collections.myCollections')}
        </p>
        <button
          onClick={(e) => { e.stopPropagation(); setAdding(true) }}
          title={t('collections.new')}
          style={{
            width: 18, height: 18, borderRadius: '50%', border: 'none',
            background: 'var(--primary-light)', color: 'var(--primary)',
            fontSize: 13, fontWeight: 700, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          +
        </button>
      </div>

      {/* New collection input */}
      {adding && (
        <div style={{ padding: '2px 8px', marginBottom: 2 }}>
          <input
            autoFocus
            placeholder={t('collections.namePlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={onNewKey}
            onBlur={commitNew}
            style={{
              width: '100%', height: 28, padding: '0 8px',
              borderRadius: 'var(--radius-md)',
              border: '1.5px solid var(--primary)',
              background: 'var(--surface)', fontSize: 12,
            }}
          />
        </div>
      )}

      {/* Collection tree */}
      {collectionsOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {roots.length === 0 && !adding && (
            <p style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 28px', userSelect: 'none' }}>
              {t('collections.empty')}
            </p>
          )}
          {roots.map((col) => renderCollection(col.id, 0))}
        </div>
      )}

      {/* Right-click context menu for collections */}
      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 200,
            background: 'rgba(255,255,255,0.94)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            padding: 4,
            minWidth: 150,
          }}
        >
          <CtxItem
            label={t('collections.rename')}
            icon="✏️"
            onClick={() => {
              const col = collections.find((c) => c.id === contextMenu.colId)
              if (col) { setRenamingId(col.id); setRenameVal(col.name) }
              setContextMenu(null)
            }}
          />
          <CtxItem
            label={t('collections.delete')}
            icon="🗑"
            color="var(--accent)"
            onClick={() => { remove(contextMenu.colId); setContextMenu(null) }}
          />
        </div>
      )}
    </div>
  )
}

function CtxItem({ label, icon, color = 'var(--foreground)', onClick }: {
  label: string; icon: string; color?: string; onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '7px 12px',
        borderRadius: 'var(--radius-md)', border: 'none',
        background: 'transparent', color,
        fontSize: 13, fontWeight: 500, textAlign: 'left', cursor: 'pointer',
      }}
    >
      <span>{icon}</span>{label}
    </button>
  )
}
