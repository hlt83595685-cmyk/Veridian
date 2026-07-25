import { useEffect, useState } from 'react'
import { useInView } from '../../hooks/useInView'
import { useItemStore } from '../../stores/itemStore'
import { sortByFigNumber } from './FigureStrip.utils'
import type { Attachment } from '../../../../shared/types'

const MAX_THUMBS = 10
const THUMB_SIZE = 52

interface Loaded {
  dir: string
  label: string   // the imagedir attachment's own display name, for the gallery header
  files: string[]
}

export function FigureStrip({ itemId }: { itemId: number }): JSX.Element {
  const { ref, inView } = useInView<HTMLDivElement>()
  const [loaded, setLoaded] = useState<Loaded | null>(null)   // null = not fetched (or nothing to show) yet

  useEffect(() => {
    if (!inView) return
    let alive = true
    window.veridian.attachments.getByItem(itemId)
      .then((attachments: Attachment[]) => {
        const imgDir = attachments.find((a) => a.type === 'imagedir')
        if (!imgDir?.path) return null
        const dir = imgDir.path
        const label = imgDir.filename ?? '图片文件夹'
        return window.veridian.fs.listDir(dir).then((files) => ({ dir, label, files }))
      })
      .then((result) => {
        if (!alive) return
        if (!result || result.files.length === 0) { setLoaded(null); return }
        setLoaded({ dir: result.dir, label: result.label, files: sortByFigNumber(result.files).slice(0, MAX_THUMBS) })
      })
      .catch(() => { if (alive) setLoaded(null) })
    return () => { alive = false }
  }, [inView, itemId])

  if (!loaded) return <div ref={ref} />   // placeholder: not-yet-visible, no images, or fetch failed -- zero visual footprint

  return (
    <div
      ref={ref}
      style={{
        display: 'flex', gap: 6, overflowX: 'auto', overflowY: 'hidden',
        padding: '6px 0 2px', marginTop: 4,
      }}
    >
      {loaded.files.map((path) => (
        <FigureThumb key={path} path={path} dir={loaded.dir} label={loaded.label} />
      ))}
    </div>
  )
}

function FigureThumb({ path, dir, label }: { path: string; dir: string; label: string }): JSX.Element | null {
  const { openGallery } = useItemStore()
  const [failed, setFailed] = useState(false)
  if (failed) return null

  const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')

  return (
    <img
      src={`veridian-file:///${encoded}`}
      alt=""
      loading="lazy"
      decoding="async"
      onClick={(e) => {
        e.stopPropagation()   // don't trigger the row's onClick (item selection)
        openGallery(dir, label)   // label = the folder's own name, not this single image
      }}
      onError={() => setFailed(true)}
      style={{
        width: THUMB_SIZE, height: THUMB_SIZE, objectFit: 'cover',
        borderRadius: 6, flexShrink: 0, cursor: 'pointer',
        border: '1px solid var(--border)',
      }}
    />
  )
}
