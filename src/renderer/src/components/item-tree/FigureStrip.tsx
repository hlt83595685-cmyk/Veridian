import { useState } from 'react'
import { useInView } from '../../hooks/useInView'
import { useItemStore } from '../../stores/itemStore'
import { useItemImages } from '../../data/hooks'
import { sortByFigNumber } from './FigureStrip.utils'

const MAX_THUMBS = 10
const THUMB_SIZE = 52

// Lazy-mount gate: FigureStripContent (and the IPC calls its useItemImages
// hook makes) only mounts once this row is near the viewport, so an
// off-screen row in the (non-virtualized) list does zero work. Once mounted,
// it stays mounted (useInView's inView never reverts to false), so it keeps
// receiving live updates via the query cache -- no need to scroll away and
// back, or restart the app, to see a conversion finish or a sync pull land.
export function FigureStrip({ itemId }: { itemId: number }): JSX.Element {
  const { ref, inView } = useInView<HTMLDivElement>()
  return <div ref={ref}>{inView && <FigureStripContent itemId={itemId} />}</div>
}

function FigureStripContent({ itemId }: { itemId: number }): JSX.Element | null {
  const { data } = useItemImages(itemId)
  if (!data || data.files.length === 0) return null

  const files = sortByFigNumber(data.files).slice(0, MAX_THUMBS)

  return (
    <div
      style={{
        display: 'flex', gap: 6, overflowX: 'auto', overflowY: 'hidden',
        padding: '6px 0 2px', marginTop: 4,
      }}
    >
      {files.map((path) => (
        <FigureThumb key={path} path={path} dir={data.dir} label={data.label} />
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
