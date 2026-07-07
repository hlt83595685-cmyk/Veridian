import { useItemStore } from '../../stores/itemStore'
import { MarkdownViewer } from './MarkdownViewer'

export function MarkdownReaderPane(): JSX.Element {
  const { viewerPath, viewerFilename, closePdf } = useItemStore()

  if (!viewerPath) return <></>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '0 16px', height: 46, flexShrink: 0,
        background: 'rgba(242,242,247,0.85)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottom: '1px solid var(--separator)',
      }}>
        <button
          onClick={closePdf}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            height: 30, padding: '0 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--foreground-2)',
            fontSize: 12, fontWeight: 500,
            boxShadow: 'var(--shadow-xs)', flexShrink: 0,
          }}
        >
          ← 返回
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14, flexShrink: 0 }}>📝</span>
          <span style={{
            fontSize: 13, fontWeight: 500, color: 'var(--foreground)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {viewerFilename}
          </span>
        </div>

        <button
          onClick={() => window.veridian.attachments.openPath(viewerPath)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            height: 30, padding: '0 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--muted)',
            fontSize: 12, fontWeight: 500,
            boxShadow: 'var(--shadow-xs)', flexShrink: 0,
          }}
        >
          ↗ 外部打开
        </button>
      </div>

      {/* Markdown content */}
      <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg-elevated)' }}>
        <MarkdownViewer filePath={viewerPath} />
      </div>
    </div>
  )
}
