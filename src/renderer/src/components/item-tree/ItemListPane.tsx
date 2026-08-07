import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import { useCollectionStore } from '../../stores/collectionStore'
import { useViewPrefsStore, FONT_MIN, FONT_MAX, THUMB_MIN, THUMB_MAX } from '../../stores/viewPrefsStore'
import type { Item } from '../../../../shared/types'
import emptyRefsUrl from '../../assets/empty-refs.png'
import { FigureStrip } from './FigureStrip'

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

// Small round GitHub avatar for the item's contributor. Loads the locally
// cached avatar via veridian-file://; falls back to a colored initial when
// there's no cached image (offline, unknown user, or no attribution).
function ContributorAvatar({ login, size = 18 }: { login: string; size?: number }): JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    window.veridian.github.avatarPath(login)
      .then((p) => { if (alive) p ? setPath(p) : setFailed(true) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [login])

  const dim = { width: size, height: size, borderRadius: '50%', flexShrink: 0 }

  if (path && !failed) {
    const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    return (
      <img
        src={`veridian-file:///${encoded}`}
        alt={login}
        title={login}
        style={{ ...dim, objectFit: 'cover' }}
        onError={() => setFailed(true)}
      />
    )
  }

  // Fallback: colored initial. Hue derived from the login so it's stable.
  let hash = 0
  for (let i = 0; i < login.length; i++) hash = (hash * 31 + login.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return (
    <span
      title={login}
      style={{
        ...dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `hsl(${hue}, 55%, 55%)`, color: '#fff',
        fontSize: size * 0.55, fontWeight: 700, textTransform: 'uppercase',
      }}
    >
      {login.charAt(0)}
    </span>
  )
}

function ItemRow({ item, selected, onClick, onDoubleClick, onContextMenu, titleFontSize, showJournal, showYear, showTags }: {
  item: Item
  selected: boolean
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  titleFontSize: number
  showJournal: boolean
  showYear: boolean
  showTags: boolean
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
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 18, marginTop: 1 }}>{icon}</span>
        {item.added_by && <ContributorAvatar login={item.added_by} />}
      </span>
      {/* Title + tags */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontSize: titleFontSize,
          fontFamily: '"Times New Roman", "Georgia", "Palatino Linotype", serif',
          fontWeight: selected ? 600 : 500,
          color: selected ? 'var(--primary)' : 'var(--foreground)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          lineHeight: 1.4,
        }}>
          {item.conversion_failed === 1 && (
            <span
              title={t('item.conversionFailed')}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16, borderRadius: '50%',
                background: '#e5484d', color: '#fff', fontSize: 11, fontWeight: 800,
                marginRight: 6, verticalAlign: 'middle', flexShrink: 0,
              }}
            >
              !
            </span>
          )}
          {item.title || t('item.untitled')}
        </p>
        {showTags && item.tags && item.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {item.tags.slice(0, 6).map((tag) => (
              <span key={tag} style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 10,
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
        <FigureStrip itemId={item.id} />
      </div>
      {/* Journal column */}
      {showJournal && (
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
      )}
      {/* Year column */}
      {showYear && (
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
      )}
    </div>
  )
}

export function ItemListPane(): JSX.Element {
  const { t } = useTranslation('common')
  const { items, selectedId, setSelectedId, searchQuery, activeCollection, loadItems, yearSort, toggleYearSort } = useItemStore()
  const { collections } = useCollectionStore()
  const prefs = useViewPrefsStore((s) => s.prefs)
  const updatePrefs = useViewPrefsStore((s) => s.update)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)   // dragenter/leave fire per child; count to know when we truly left
  const menuRef = useRef<HTMLDivElement>(null)
  const viewMenuRef = useRef<HTMLDivElement>(null)
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

  // View-settings popover: dismiss on outside click or Esc. Kept separate from
  // the per-item context menu so interacting inside it (slider/toggles) doesn't
  // close it.
  useEffect(() => {
    if (!viewMenu) return
    const onDown = (e: MouseEvent): void => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setViewMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setViewMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [viewMenu])

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

  const handleFetchMetadata = async (itemId: number): Promise<void> => {
    setContextMenu(null)
    // No manual reload needed -- CrossRef/markdown updates flow through
    // item.modified / tag.changed domain events which already refresh the list.
    await window.veridian.items.fetchMetadata(itemId)
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

  // ── Drag-and-drop import ──────────────────────────────────────────────────
  // Dropping references into the list imports them just like the toolbar's
  // Import button (same importer, dedup, and auto-pdf2md). Disabled in Trash.
  const dropEnabled = !isTrash
  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

  const handleDragEnter = (e: React.DragEvent): void => {
    if (!dropEnabled || !hasFiles(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const handleDragOver = (e: React.DragEvent): void => {
    if (!dropEnabled || !hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (): void => {
    if (!dropEnabled) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) }
  }
  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    if (!dropEnabled) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.veridian.import.pathForFile(f))
      .filter((p) => /\.(pdf|bib|json)$/i.test(p))
    if (paths.length === 0) return
    try {
      const res = await window.veridian.import.paths(paths, activeColId ?? undefined)
      if (res.imported > 0) await loadItems()
    } catch (err) {
      console.error('[ItemListPane] drop import failed:', err)
    }
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}
      onClick={() => setContextMenu(null)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header — right-click opens the display-settings popover */}
      <div
        onContextMenu={(e) => { e.preventDefault(); setViewMenu({ x: e.clientX, y: e.clientY }) }}
        title={t('item.displaySettings')}
        style={{
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
        {prefs.showJournal && (
          <span style={{
            width: 130, textAlign: 'right', flexShrink: 0,
            fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em',
          }}>
            {t('item.journalColumn')}
          </span>
        )}
        {/* Year column header — clickable sort */}
        {prefs.showYear && (
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
        )}
      </div>

      {/* List */}
      <div
        style={{ flex: 1, overflowY: 'auto' }}
        onContextMenu={isTrash ? (e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, itemId: null }) } : undefined}
      >
        {filtered.length === 0 ? (
          isTrash ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', gap: 10,
              color: 'var(--muted)',
            }}>
              <span style={{ fontSize: 36 }}>🗑</span>
              <p style={{ fontSize: 13 }}>{t('item.trashEmpty')}</p>
            </div>
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', textAlign: 'center',
            }}>
              <img
                src={emptyRefsUrl}
                alt=""
                draggable={false}
                style={{ width: 300, maxWidth: '70%', opacity: 0.95, userSelect: 'none' }}
              />
              <p style={{
                marginTop: 28, fontSize: 24, fontWeight: 700,
                color: 'var(--foreground)', letterSpacing: '-0.01em',
              }}>
                {t('item.emptyTitle')}
              </p>
              <p style={{ marginTop: 14, fontSize: 15, color: 'var(--muted-2)' }}>
                {t('item.empty')}
              </p>
            </div>
          )
        ) : (
          filtered.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              selected={selectedId === item.id}
              onClick={() => setSelectedId(item.id)}
              onDoubleClick={() => handleDoubleClick(item)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, itemId: item.id }) }}
              titleFontSize={prefs.titleFontSize}
              showJournal={prefs.showJournal}
              showYear={prefs.showYear}
              showTags={prefs.showTags}
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
                  <ContextItem label={t('item.restore')}
                    onClick={() => handleRestore(contextMenu.itemId!)} />
                  <ContextItem label={t('item.deletePermanently')}
                    onClick={() => handleDeletePermanently(contextMenu.itemId!)} />
                  <div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />
                </>
              )}
              <ContextItem label={t('item.emptyTrash')}
                onClick={handleEmptyTrash} />
            </>
          ) : isCollection ? (
            <>
              {contextMenu.itemId !== null && (
                <>
                  <ContextItem label={t('item.fetchMetadata')}
                    onClick={() => handleFetchMetadata(contextMenu.itemId!)} />
                  <ContextItem label={t('item.pdf2md')}
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
              <ContextItem label={t('item.removeFromCollection')}
                onClick={() => handleRemoveFromCollection(contextMenu.itemId!)} />
              <div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />
              <ContextItem label={t('item.moveToTrash')}
                onClick={() => handleTrash(contextMenu.itemId!)} />
            </>
          ) : (
            <>
              {contextMenu.itemId !== null && (
                <>
                  <ContextItem label={t('item.fetchMetadata')}
                    onClick={() => handleFetchMetadata(contextMenu.itemId!)} />
                  <ContextItem label={t('item.pdf2md')}
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
              <ContextItem label={t('item.moveToTrash')}
                onClick={() => handleTrash(contextMenu.itemId!)} />
            </>
          )}
        </div>
      )}

      {/* Display-settings popover (right-click on the header). Stays open while
          adjusting the slider / toggling columns; closes on outside click / Esc. */}
      {viewMenu && (
        <div
          ref={viewMenuRef}
          style={{
            position: 'fixed',
            top: viewMenu.y,
            left: Math.min(viewMenu.x, window.innerWidth - 240),
            zIndex: 100,
            width: 224,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-lg)',
            padding: '10px 12px',
          }}
        >
          {/* Title font size */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
              {t('item.titleFontSize')}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {prefs.titleFontSize}px
            </span>
          </div>
          <input
            type="range"
            min={FONT_MIN}
            max={FONT_MAX}
            step={1}
            value={prefs.titleFontSize}
            onChange={(e) => updatePrefs({ titleFontSize: parseInt(e.target.value, 10) })}
            style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
          />

          {/* Figure-strip thumbnail size */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0 6px' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
              {t('item.thumbSize')}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {prefs.thumbSize}px
            </span>
          </div>
          <input
            type="range"
            min={THUMB_MIN}
            max={THUMB_MAX}
            step={1}
            value={prefs.thumbSize}
            onChange={(e) => updatePrefs({ thumbSize: parseInt(e.target.value, 10) })}
            style={{ width: '100%', accentColor: 'var(--primary)', cursor: 'pointer' }}
          />

          <div style={{ height: 1, background: 'var(--separator)', margin: '10px 0 6px' }} />

          <ToggleRow label={t('item.journalColumn')} checked={prefs.showJournal}
            onToggle={() => updatePrefs({ showJournal: !prefs.showJournal })} />
          <ToggleRow label={t('item.yearColumn')} checked={prefs.showYear}
            onToggle={() => updatePrefs({ showYear: !prefs.showYear })} />
          <ToggleRow label={t('item.showTags')} checked={prefs.showTags}
            onToggle={() => updatePrefs({ showTags: !prefs.showTags })} />
        </div>
      )}

      {/* Drag-and-drop import overlay. pointer-events: none so the drop lands on
          the root container, not this layer. */}
      {dragging && (
        <div style={{
          position: 'absolute', inset: 8, zIndex: 50, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 'var(--radius-lg)',
          border: '2.5px dashed var(--primary)',
          background: 'var(--primary-light)',
          backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            color: 'var(--primary)',
          }}>
            <span style={{ fontSize: 40, lineHeight: 1 }}>↓</span>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{t('item.dropHint')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function ToggleRow({ label, checked, onToggle }: {
  label: string; checked: boolean; onToggle: () => void
}): JSX.Element {
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '6px 6px',
        borderRadius: 'var(--radius-md)', border: 'none',
        background: 'transparent', color: 'var(--foreground)',
        fontSize: 13, fontWeight: 500, textAlign: 'left', cursor: 'pointer',
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 16, height: 16, flexShrink: 0,
        borderRadius: 4,
        border: `1.5px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
        background: checked ? 'var(--primary)' : 'transparent',
        color: '#fff', fontSize: 11, fontWeight: 800, lineHeight: 1,
      }}>
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  )
}

function ContextItem({ label, onClick }: {
  label: string; onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center',
        width: '100%', padding: '7px 12px',
        borderRadius: 'var(--radius-md)', border: 'none',
        background: 'transparent', color: 'var(--foreground)',
        fontSize: 13, fontWeight: 500, textAlign: 'left',
      }}
    >
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
        <span>{label}</span>
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
