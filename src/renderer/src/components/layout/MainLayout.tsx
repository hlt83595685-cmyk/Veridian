import { useCallback, useEffect, useRef, useState } from 'react'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { CollectionPane } from '../item-tree/CollectionPane'
import { ItemListPane } from '../item-tree/ItemListPane'
import { DetailPane } from '../detail-panel/DetailPane'
import { PdfReaderPane } from '../pdf-viewer/PdfReaderPane'
import { MarkdownReaderPane } from '../pdf-viewer/MarkdownReaderPane'
import { ImageGalleryPane } from '../pdf-viewer/ImageGalleryPane'
import { SettingsPage } from '../pages/SettingsPage'
import { ToolsPage } from '../pages/ToolsPage'
import { KnowledgePage } from '../knowledge/KnowledgePage'
import { NotePage } from '../notes/NotePage'
import { useItemStore } from '../../stores/itemStore'
import { useUiStore } from '../../stores/uiStore'
import { useLayoutStore } from '../../stores/layoutStore'

// A vertical drag handle between two panes. Live-updates the pane width on
// pointer move; the parent persists once on pointer-up (onEnd).
function Resizer({ onDrag, onEnd }: {
  onDrag: (clientX: number) => void
  onEnd: () => void
}): JSX.Element {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent): void => onDrag(e.clientX)
    const up = (): void => {
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dragging, onDrag, onEnd])

  return (
    <div
      className={`pane-resizer${dragging ? ' dragging' : ''}`}
      style={{ width: 6 }}
      onPointerDown={(e) => {
        e.preventDefault()
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        setDragging(true)
      }}
    />
  )
}

export function MainLayout(): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const selectedId = useItemStore((s) => s.selectedId)
  const viewerPath = useItemStore((s) => s.viewerPath)
  const viewerType = useItemStore((s) => s.viewerType)
  const noteViewerId = useItemStore((s) => s.noteViewerId)
  const page = useUiStore((s) => s.page)

  const sidebarWidth = useLayoutStore((s) => s.prefs.sidebarWidth)
  const detailWidth = useLayoutStore((s) => s.prefs.detailWidth)
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth)
  const setDetailWidth = useLayoutStore((s) => s.setDetailWidth)
  const persist = useLayoutStore((s) => s.persist)

  const dragSidebar = useCallback((clientX: number) => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) setSidebarWidth(clientX - rect.left)
  }, [setSidebarWidth])
  const dragDetail = useCallback((clientX: number) => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) setDetailWidth(rect.right - clientX)
  }, [setDetailWidth])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <Toolbar />

      <div ref={rowRef} style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 0, background: 'var(--bg)' }}>
        {/* Left sidebar */}
        <aside style={{
          width: sidebarWidth,
          flexShrink: 0,
          borderRight: '1px solid var(--separator)',
          overflow: 'hidden',
          background: 'var(--bg-sidebar)',
        }}>
          <CollectionPane />
        </aside>

        <Resizer onDrag={dragSidebar} onEnd={persist} />

        {/* Center -- light card container per design guide. Settings/Tools
            take over the whole card as full pages (sidebar bottom icons). */}
        <main style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          margin: '12px 16px 12px 6px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          {/* Kept mounted (just hidden) rather than conditionally rendered like the
              other pages -- switching away and back should find the same
              conversation, draft text, and scroll position still there. This
              is in-memory only (dies with a full app restart, unlike the
              window/viewer state MainStore persists) since it's scoped to
              "don't lose my place while I go look something up", not a
              session-restore feature. */}
          <div style={{ display: page === 'knowledge' ? 'contents' : 'none' }}>
            <KnowledgePage />
          </div>
          {/* Item list kept mounted (just hidden) while a reader is open or on
              other pages, so its scroll position survives opening/closing a
              PDF / markdown / gallery viewer -- same reason KnowledgePage is
              kept mounted above. */}
          <div style={{ display: page === 'library' && !viewerPath && noteViewerId == null ? 'contents' : 'none' }}>
            <ItemListPane />
          </div>
          {page === 'knowledge' ? null
            : page === 'settings'
            ? <SettingsPage />
            : page === 'tools'
              ? <ToolsPage />
              : noteViewerId != null
                ? <NotePage />
                : viewerPath
                  ? viewerType === 'markdown'
                    ? <MarkdownReaderPane />
                    : viewerType === 'gallery'
                      ? <ImageGalleryPane />
                      : <PdfReaderPane />
                  : null
          }
        </main>

        {/* Right detail — hidden during PDF reading and on settings/tools pages */}
        {page === 'library' && selectedId !== null && !viewerPath && noteViewerId == null && (
          <>
            <Resizer onDrag={dragDetail} onEnd={persist} />
            <aside style={{
              width: detailWidth,
              flexShrink: 0,
              overflowY: 'auto',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              margin: '12px 16px 12px 0',
              boxShadow: 'var(--shadow-sm)',
            }}>
              <DetailPane itemId={selectedId} />
            </aside>
          </>
        )}
      </div>

      <StatusBar />
    </div>
  )
}
