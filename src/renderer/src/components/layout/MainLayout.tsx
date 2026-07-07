import { useState } from 'react'
import { Toolbar } from './Toolbar'
import { StatusBar } from './StatusBar'
import { CollectionPane } from '../item-tree/CollectionPane'
import { ItemListPane } from '../item-tree/ItemListPane'
import { DetailPane } from '../detail-panel/DetailPane'
import { PdfReaderPane } from '../pdf-viewer/PdfReaderPane'
import { MarkdownReaderPane } from '../pdf-viewer/MarkdownReaderPane'
import { ImageGalleryPane } from '../pdf-viewer/ImageGalleryPane'
import { useItemStore } from '../../stores/itemStore'

export function MainLayout(): JSX.Element {
  const [sidebarWidth] = useState(240)
  const [detailWidth] = useState(320)
  const selectedId = useItemStore((s) => s.selectedId)
  const viewerPath = useItemStore((s) => s.viewerPath)
  const viewerType = useItemStore((s) => s.viewerType)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      <Toolbar />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 0, background: 'var(--bg)' }}>
        {/* Left sidebar */}
        <aside style={{
          width: sidebarWidth,
          flexShrink: 0,
          borderRight: '1px solid var(--separator)',
          overflowY: 'auto',
          background: 'var(--bg-sidebar)',
        }}>
          <CollectionPane />
        </aside>

        {/* Center -- light card container per design guide */}
        <main style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          margin: '12px 16px 12px 12px',
          boxShadow: 'var(--shadow-sm)',
        }}>
          {viewerPath
            ? viewerType === 'markdown'
              ? <MarkdownReaderPane />
              : viewerType === 'gallery'
                ? <ImageGalleryPane />
                : <PdfReaderPane />
            : <ItemListPane />
          }
        </main>

        {/* Right detail — hidden during PDF reading */}
        {selectedId !== null && !viewerPath && (
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
        )}
      </div>

      <StatusBar />
    </div>
  )
}
