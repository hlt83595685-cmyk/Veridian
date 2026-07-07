import { useEffect, useRef, useState } from 'react'
import { useItemStore } from '../../stores/itemStore'

// ── Thumbnail ─────────────────────────────────────────────────────────────────

function Thumb({
  filePath,
  onClick,
}: {
  filePath: string
  onClick: () => void
}): JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobRef = useRef<string | null>(null)

  useEffect(() => {
    window.veridian.fs.readFile(filePath)
      .then((bytes) => {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'svg' ? 'image/svg+xml'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : 'image/png'
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
        blobRef.current = url
        setBlobUrl(url)
      })
      .catch(() => setBlobUrl('__error__'))
    return () => { if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null } }
  }, [filePath])

  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath

  return (
    <div
      onClick={onClick}
      title={name}
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
        aspectRatio: '1 / 1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'transform 0.15s, box-shadow 0.15s',
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.transform = 'scale(1.03)'
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.18)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLDivElement).style.transform = ''
        ;(e.currentTarget as HTMLDivElement).style.boxShadow = ''
      }}
    >
      {blobUrl && blobUrl !== '__error__' ? (
        <img
          src={blobUrl}
          alt={name}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : blobUrl === '__error__' ? (
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>⚠</span>
      ) : (
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>…</span>
      )}
    </div>
  )
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function Lightbox({
  filePaths,
  index,
  onClose,
  onPrev,
  onNext,
}: {
  filePaths: string[]
  index: number
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}): JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobRef = useRef<string | null>(null)
  const filePath = filePaths[index]
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath

  useEffect(() => {
    setBlobUrl(null)
    if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null }
    window.veridian.fs.readFile(filePath)
      .then((bytes) => {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'svg' ? 'image/svg+xml'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : 'image/png'
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
        blobRef.current = url
        setBlobUrl(url)
      })
      .catch(() => setBlobUrl('__error__'))
    return () => { if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null } }
  }, [filePath])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onPrev()
      if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onPrev, onNext])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {/* Header */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px',
          background: 'linear-gradient(rgba(0,0,0,0.6), transparent)',
        }}
      >
        <span style={{ color: '#fff', fontSize: 13, opacity: 0.85 }}>
          {name}
        </span>
        <span style={{ color: '#fff', fontSize: 12, opacity: 0.6 }}>
          {index + 1} / {filePaths.length}
        </span>
        <button
          onClick={onClose}
          style={{
            width: 30, height: 30, borderRadius: '50%',
            border: 'none', background: 'rgba(255,255,255,0.15)',
            color: '#fff', fontSize: 16, cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Image */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '90vw', maxHeight: '80vh', display: 'flex', alignItems: 'center' }}
      >
        {blobUrl && blobUrl !== '__error__' ? (
          <img
            src={blobUrl}
            alt={name}
            style={{ maxWidth: '90vw', maxHeight: '80vh', borderRadius: 8, objectFit: 'contain' }}
          />
        ) : (
          <div style={{ color: '#fff', opacity: 0.5, fontSize: 14 }}>
            {blobUrl === '__error__' ? '加载失败' : '加载中…'}
          </div>
        )}
      </div>

      {/* Prev / Next */}
      {filePaths.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onPrev() }}
            style={{
              position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)',
              width: 44, height: 44, borderRadius: '50%',
              border: 'none', background: 'rgba(255,255,255,0.15)',
              color: '#fff', fontSize: 20, cursor: 'pointer',
            }}
          >
            ‹
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onNext() }}
            style={{
              position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
              width: 44, height: 44, borderRadius: '50%',
              border: 'none', background: 'rgba(255,255,255,0.15)',
              color: '#fff', fontSize: 20, cursor: 'pointer',
            }}
          >
            ›
          </button>
        </>
      )}
    </div>
  )
}

// ── Main pane ─────────────────────────────────────────────────────────────────

export function ImageGalleryPane(): JSX.Element {
  const { viewerPath, viewerFilename, closePdf } = useItemStore()
  const [images, setImages] = useState<string[]>([])
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)

  useEffect(() => {
    if (!viewerPath) return
    setImages([])
    window.veridian.fs.listDir(viewerPath)
      .then((files) => setImages(files.sort()))
      .catch(() => setImages([]))
  }, [viewerPath])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 16px',
        borderBottom: '1px solid var(--separator)',
        background: 'var(--bg)',
        flexShrink: 0,
      }}>
        <button
          onClick={closePdf}
          style={{
            height: 28, padding: '0 12px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--muted)', fontSize: 12, cursor: 'pointer',
          }}
        >
          ← 返回
        </button>
        <span style={{
          fontSize: 13, fontWeight: 600, color: 'var(--foreground)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {viewerFilename ?? '图片文件夹'}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
          {images.length} 张图片
        </span>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {images.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', paddingTop: 60 }}>
            暂无图片
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 12,
          }}>
            {images.map((path, i) => (
              <Thumb key={path} filePath={path} onClick={() => setLightboxIdx(i)} />
            ))}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIdx !== null && (
        <Lightbox
          filePaths={images}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onPrev={() => setLightboxIdx((i) => (i! - 1 + images.length) % images.length)}
          onNext={() => setLightboxIdx((i) => (i! + 1) % images.length)}
        />
      )}
    </div>
  )
}
