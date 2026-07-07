import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import { PDFDocument, PDFName, PDFArray, PDFNumber, PDFString, PDFRef } from 'pdf-lib'
import 'pdfjs-dist/web/pdf_viewer.css'

// Module-level singleton: ensures workerSrc is set exactly once across all mounts
let _workerReady: Promise<void> | null = null
function ensureWorker(): Promise<void> {
  if (!_workerReady) {
    _workerReady = (async () => {
      const path = await window.veridian.fs.pdfjsWorkerPath()
      const raw = await window.veridian.fs.readFile(path)
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([new Uint8Array(raw)], { type: 'text/javascript' })
      )
    })()
  }
  return _workerReady
}

type Tool = 'none' | 'highlight' | 'note' | 'erase'

// Highlight colors: [cssHex for canvas, [r,g,b] 0-1 for PDF]
const HIGHLIGHT_COLORS: { label: string; css: string; pdf: [number, number, number] }[] = [
  { label: '黄',   css: '#FFE014', pdf: [1,    0.88, 0.08] },
  { label: '绿',   css: '#A8F0A0', pdf: [0.66, 0.94, 0.63] },
  { label: '青',   css: '#80E8FF', pdf: [0.50, 0.91, 1.00] },
  { label: '粉',   css: '#FFB3D9', pdf: [1.00, 0.70, 0.85] },
  { label: '橙',   css: '#FFD080', pdf: [1.00, 0.82, 0.50] },
]

interface Props { filePath: string }

interface HighlightRect {
  id: string
  pageNum: number
  pdfRect: [number, number, number, number]
  color: string  // css hex
}

interface NoteAnnot {
  id: string
  pageNum: number
  pdfX: number
  pdfY: number
  contents: string
}

interface PendingNote {
  screenX: number; screenY: number
  pdfX: number; pdfY: number; pageNum: number
}

// ── PDF helpers ───────────────────────────────────────────────────────────────

function pushAnnotRef(doc: PDFDocument, page: ReturnType<PDFDocument['getPage']>, ref: PDFRef): void {
  const existing = page.node.get(PDFName.of('Annots'))
  let arr: PDFArray
  if (existing instanceof PDFArray) {
    arr = existing
  } else if (existing) {
    const resolved = doc.context.lookup(existing)
    arr = resolved instanceof PDFArray ? resolved : doc.context.obj([])
  } else {
    arr = doc.context.obj([])
  }
  arr.push(ref)
  page.node.set(PDFName.of('Annots'), arr)
}

async function addHighlightToPdf(
  bytes: Uint8Array, pageIndex: number,
  rect: [number, number, number, number],
  id: string, pdfColor: [number, number, number]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const [x1, y1, x2, y2] = rect
  const annot = doc.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Highlight'),
    Rect: doc.context.obj([x1, y1, x2, y2]),
    QuadPoints: doc.context.obj([x1, y2, x2, y2, x1, y1, x2, y1]),
    C: doc.context.obj(pdfColor),
    CA: PDFNumber.of(0.5), F: PDFNumber.of(4),
    NM: PDFString.of(id), T: PDFString.of('Veridian'), Contents: PDFString.of(''),
  })
  pushAnnotRef(doc, page, doc.context.register(annot))
  return doc.save()
}

async function addNoteToPdf(
  bytes: Uint8Array, pageIndex: number,
  x: number, y: number, contents: string, id: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(pageIndex)
  const annot = doc.context.obj({
    Type: PDFName.of('Annot'), Subtype: PDFName.of('Text'),
    Rect: doc.context.obj([x, y, x + 20, y + 20]),
    Contents: PDFString.of(contents),
    T: PDFString.of('Veridian'), NM: PDFString.of(id),
    F: PDFNumber.of(4), Open: PDFName.of('false'),
    Name: PDFName.of('Note'), C: doc.context.obj([1, 0.87, 0]),
  })
  pushAnnotRef(doc, page, doc.context.register(annot))
  return doc.save()
}

async function updateNoteToPdf(
  bytes: Uint8Array, id: string, newContents: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  for (const page of doc.getPages()) {
    const annotsRef = page.node.get(PDFName.of('Annots'))
    if (!annotsRef) continue
    const arr = doc.context.lookup(annotsRef instanceof PDFArray ? annotsRef : annotsRef)
    if (!(arr instanceof PDFArray)) continue
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i)
      const dict = doc.context.lookup(ref)
      if (!dict || typeof (dict as any).get !== 'function') continue
      const nm = (dict as any).get(PDFName.of('NM'))
      if (nm && (nm.toString() === `(${id})` || nm.decodeText?.() === id || String(nm).includes(id))) {
        ;(dict as any).set(PDFName.of('Contents'), PDFString.of(newContents))
      }
    }
  }
  return doc.save()
}

async function removeAnnotsFromPdf(bytes: Uint8Array, ids: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  for (const page of doc.getPages()) {
    const annotsRef = page.node.get(PDFName.of('Annots'))
    if (!annotsRef) continue
    const resolved = doc.context.lookup(annotsRef)
    if (!(resolved instanceof PDFArray)) continue

    const keep: PDFRef[] = []
    for (let i = 0; i < resolved.size(); i++) {
      const ref = resolved.get(i) as PDFRef
      const dict = doc.context.lookup(ref)
      if (!dict || typeof (dict as any).get !== 'function') { keep.push(ref); continue }
      const nm = (dict as any).get(PDFName.of('NM'))
      // NM is stored as PDFString: its raw value includes parens, or use asString()
      const nmStr: string = nm
        ? (typeof nm.asString === 'function' ? nm.asString() : nm.decodeText?.() ?? String(nm))
        : ''
      if (ids.includes(nmStr)) {
        doc.context.delete(ref)  // free the object
      } else {
        keep.push(ref)
      }
    }

    // Rebuild the array with only kept refs
    const newArr = doc.context.obj(keep)
    if (resolved === annotsRef) {
      page.node.set(PDFName.of('Annots'), newArr)
    } else {
      // annotsRef is an indirect ref — update in place
      doc.context.assign(annotsRef as PDFRef, newArr)
    }
  }
  return doc.save()
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PdfAnnotationViewer({ filePath }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [tool, setTool] = useState<Tool>('none')
  const [hlColorIdx, setHlColorIdx] = useState(0)  // index into HIGHLIGHT_COLORS
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [highlights, setHighlights] = useState<HighlightRect[]>([])
  const [notes, setNotes] = useState<NoteAnnot[]>([])
  const [pendingNote, setPendingNote] = useState<PendingNote | null>(null)
  const [noteText, setNoteText] = useState('')
  // note popup state: null = closed, id = view mode, id+'_edit' = edit mode
  const [notePopup, setNotePopup] = useState<{ id: string; editing: boolean } | null>(null)
  const [editText, setEditText] = useState('')

  // Rubber-band rect for erase tool (screen coords relative to scroll container)
  const [eraseDrag, setEraseDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const eraseDragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const erasePageRef = useRef<number | null>(null)

  const pdfBytesRef = useRef<Uint8Array | null>(null)
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null)
  const viewportsRef = useRef<Map<number, pdfjsLib.PageViewport>>(new Map())
  const scaleRef = useRef(scale)
  useEffect(() => { scaleRef.current = scale }, [scale])
  const highlightsRef = useRef<HighlightRect[]>([])
  useEffect(() => { highlightsRef.current = highlights }, [highlights])
  const toolRef = useRef<Tool>('none')
  useEffect(() => { toolRef.current = tool }, [tool])


  // ── canvas drawing ──

  const drawHighlightsOnPage = useCallback((
    pageNum: number, hls: HighlightRect[], vp: pdfjsLib.PageViewport
  ) => {
    const canvas = document.getElementById(`pdf-canvas-${pageNum}`) as HTMLCanvasElement | null
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    ctx.globalAlpha = 0.45
    for (const h of hls.filter(h => h.pageNum === pageNum)) {
      const [x1, y1, x2, y2] = h.pdfRect
      const [sx1, sy1] = vp.convertToViewportPoint(x1, y2)
      const [sx2, sy2] = vp.convertToViewportPoint(x2, y1)
      ctx.fillStyle = h.color
      ctx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1)
    }
    ctx.restore()
  }, [])

  // ── page render ──

  const renderPage = useCallback(async (
    doc: pdfjsLib.PDFDocumentProxy, pageNum: number,
    currentScale: number, currentHighlights: HighlightRect[]
  ) => {
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: currentScale })
    viewportsRef.current.set(pageNum, viewport)

    const canvas = document.getElementById(`pdf-canvas-${pageNum}`) as HTMLCanvasElement | null
    if (!canvas) return
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport, annotationMode: 0 }).promise
    drawHighlightsOnPage(pageNum, currentHighlights, viewport)

    const wrapper = document.getElementById(`pdf-page-${pageNum}`)
    if (!wrapper) return
    wrapper.querySelector('.textLayer')?.remove()
    const textDiv = document.createElement('div')
    textDiv.className = 'textLayer'
    textDiv.style.width = `${viewport.width}px`
    textDiv.style.height = `${viewport.height}px`
    wrapper.appendChild(textDiv)
    await new TextLayer({
      textContentSource: await page.getTextContent(),
      container: textDiv, viewport,
    }).render()
  }, [drawHighlightsOnPage])

  // Re-render one page using current pdfDocRef (after erase)
  const rerenderPage = useCallback(async (pageNum: number, hls: HighlightRect[]) => {
    const doc = pdfDocRef.current
    if (!doc) return
    await renderPage(doc, pageNum, scaleRef.current, hls)
  }, [renderPage])

  // ── annotation loading ──

  const loadAnnotations = useCallback(async (doc: pdfjsLib.PDFDocumentProxy) => {
    const hls: HighlightRect[] = []
    const nts: NoteAnnot[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const annots = await page.getAnnotations()
      for (const a of annots) {
        if (a.subtype === 'Highlight' && a.rect) {
          // Try to match the saved CSS color from the PDF color array
          const c = a.color   // {r,g,b} 0-255 from pdfjs
          let cssColor = '#FFE014'
          if (c) {
            const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b)
            const match = HIGHLIGHT_COLORS.find(hc => {
              const [pr, pg, pb] = hc.pdf
              return Math.abs(pr * 255 - r) < 10 && Math.abs(pg * 255 - g) < 10 && Math.abs(pb * 255 - b) < 10
            })
            if (match) cssColor = match.css
          }
          hls.push({ id: a.id ?? `hl-${i}-${hls.length}`, pageNum: i, pdfRect: a.rect, color: cssColor })
        } else if (a.subtype === 'Text' && a.rect) {
          nts.push({ id: a.id ?? `note-${i}-${nts.length}`, pageNum: i,
            pdfX: a.rect[0], pdfY: a.rect[1], contents: a.contents ?? '' })
        }
      }
    }
    setHighlights(hls)
    setNotes(nts)
    return hls
  }, [])

  // ── initial load ──

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    async function load(): Promise<void> {
      try {
        await ensureWorker()
        const raw = await window.veridian.fs.readFile(filePath)
        if (cancelled) return
        const bytes = new Uint8Array(raw)
        pdfBytesRef.current = bytes
        viewportsRef.current.clear()
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        if (cancelled) return
        pdfDocRef.current = doc
        setNumPages(doc.numPages)
        const hls = await loadAnnotations(doc)
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return
          await renderPage(doc, i, scaleRef.current, hls)
        }
        if (!cancelled) setLoading(false)
      } catch (e) {
        if (!cancelled) { setError(String(e)); setLoading(false) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [filePath, loadAnnotations, renderPage])

  // ── scale change → full re-render ──

  useEffect(() => {
    const doc = pdfDocRef.current
    if (!doc || loading) return
    viewportsRef.current.clear()
    let cancelled = false
    async function rerender(): Promise<void> {
      for (let i = 1; i <= doc!.numPages; i++) {
        if (cancelled) return
        await renderPage(doc!, i, scale, highlightsRef.current)
      }
    }
    rerender()
    return () => { cancelled = true }
  }, [scale, loading, renderPage])

  // ── silent PDF doc refresh (after writing bytes) ──

  const refreshPdfDoc = useCallback(async (newBytes: Uint8Array) => {
    pdfBytesRef.current = newBytes
    const newDoc = await pdfjsLib.getDocument({ data: newBytes.slice() }).promise
    pdfDocRef.current?.destroy()
    pdfDocRef.current = newDoc
  }, [])

  // ── highlight ──

  function pageNumOfNode(node: Node | null): number | null {
    let el = node instanceof Element ? node : node?.parentElement
    while (el) {
      const p = (el as HTMLElement).dataset?.page
      if (p) return parseInt(p, 10)
      el = el.parentElement
    }
    return null
  }

  function selectionToPdfRect(
    vp: pdfjsLib.PageViewport, canvas: HTMLCanvasElement, selRect: DOMRect
  ): [number, number, number, number] {
    const cr = canvas.getBoundingClientRect()
    const [x1p, y1p] = vp.convertToPdfPoint(selRect.left - cr.left, selRect.top - cr.top)
    const [x2p, y2p] = vp.convertToPdfPoint(selRect.right - cr.left, selRect.bottom - cr.top)
    return [Math.min(x1p, x2p), Math.min(y1p, y2p), Math.max(x1p, x2p), Math.max(y1p, y2p)]
  }

  // ── erase drag handlers ──

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (toolRef.current !== 'erase') return
    // Identify which page was clicked
    let el = e.target as HTMLElement | null
    let pageNum: number | null = null
    while (el) {
      const p = el.dataset?.page
      if (p) { pageNum = parseInt(p, 10); break }
      el = el.parentElement
    }
    if (!pageNum) return
    erasePageRef.current = pageNum
    const scrollEl = scrollRef.current
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0
    const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0
    const d = { x1: e.clientX + scrollLeft, y1: e.clientY + scrollTop, x2: e.clientX + scrollLeft, y2: e.clientY + scrollTop }
    eraseDragRef.current = d
    setEraseDrag({ ...d })
    e.preventDefault()
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (toolRef.current !== 'erase' || !eraseDragRef.current) return
    const scrollEl = scrollRef.current
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0
    const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0
    const d = { ...eraseDragRef.current, x2: e.clientX + scrollLeft, y2: e.clientY + scrollTop }
    eraseDragRef.current = d
    setEraseDrag({ ...d })
  }, [])

  const handleMouseUp = useCallback(async (e?: React.MouseEvent) => {
    const t = toolRef.current

    // ── erase: rubber-band drag ──
    if (t === 'erase') {
      const drag = eraseDragRef.current
      const pageNum = erasePageRef.current
      eraseDragRef.current = null
      erasePageRef.current = null
      setEraseDrag(null)
      if (!drag || !pageNum || !pdfBytesRef.current) return
      const viewport = viewportsRef.current.get(pageNum)
      const canvas = document.getElementById(`pdf-canvas-${pageNum}`) as HTMLCanvasElement | null
      if (!viewport || !canvas) return

      const scrollEl = scrollRef.current
      const scrollTop = scrollEl ? scrollEl.scrollTop : 0
      const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0
      // drag coords are client+scroll; convert back to client for getBoundingClientRect comparison
      const cr = canvas.getBoundingClientRect()
      const rx1 = Math.min(drag.x1, drag.x2) - scrollLeft - cr.left
      const ry1 = Math.min(drag.y1, drag.y2) - scrollTop - cr.top
      const rx2 = Math.max(drag.x1, drag.x2) - scrollLeft - cr.left
      const ry2 = Math.max(drag.y1, drag.y2) - scrollTop - cr.top
      if (rx2 - rx1 < 2 && ry2 - ry1 < 2) return

      const [px1, py1] = viewport.convertToPdfPoint(rx1, ry1)
      const [px2, py2] = viewport.convertToPdfPoint(rx2, ry2)
      const sx1 = Math.min(px1, px2), sy1 = Math.min(py1, py2)
      const sx2 = Math.max(px1, px2), sy2 = Math.max(py1, py2)

      const toRemove = highlightsRef.current.filter(h => {
        if (h.pageNum !== pageNum) return false
        const [hx1, hy1, hx2, hy2] = h.pdfRect
        return sx1 < hx2 && sx2 > hx1 && sy1 < hy2 && sy2 > hy1
      })
      if (toRemove.length === 0) return
      const ids = toRemove.map(h => h.id)
      const nextHls = highlightsRef.current.filter(h => !ids.includes(h.id))
      setHighlights(nextHls)
      setSaving(true)
      try {
        const newBytes = await removeAnnotsFromPdf(pdfBytesRef.current, ids)
        await window.veridian.fs.writeFile(filePath, newBytes)
        await refreshPdfDoc(newBytes)
        await rerenderPage(pageNum, nextHls)
      } catch (err) { console.error('[erase save]', err) }
      finally { setSaving(false) }
      return
    }

    // ── highlight: text selection ──
    if (t !== 'highlight') return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const selRect = range.getBoundingClientRect()
    if (selRect.width < 2 || selRect.height < 2) return
    const pageNum = pageNumOfNode(sel.anchorNode)
    if (!pageNum) return
    const viewport = viewportsRef.current.get(pageNum)
    const canvas = document.getElementById(`pdf-canvas-${pageNum}`) as HTMLCanvasElement | null
    if (!viewport || !canvas || !pdfBytesRef.current) return

    const pdfRect = selectionToPdfRect(viewport, canvas, selRect)
    sel.removeAllRanges()

    const col = HIGHLIGHT_COLORS[hlColorIdx]
    const id = `hl-${Date.now()}`
    const newHl: HighlightRect = { id, pageNum, pdfRect, color: col.css }
    drawHighlightsOnPage(pageNum, [newHl], viewport)
    setHighlights(prev => [...prev, newHl])
    setSaving(true)
    try {
      const newBytes = await addHighlightToPdf(pdfBytesRef.current, pageNum - 1, pdfRect, id, col.pdf)
      await window.veridian.fs.writeFile(filePath, newBytes)
      await refreshPdfDoc(newBytes)
    } catch (err) { console.error('[highlight save]', err) }
    finally { setSaving(false) }
  }, [hlColorIdx, filePath, drawHighlightsOnPage, refreshPdfDoc, rerenderPage])

  // ── note placement ──

  const handlePageClick = useCallback((e: React.MouseEvent, pageNum: number) => {
    if (toolRef.current !== 'note') return
    if ((e.target as HTMLElement).closest('[data-note-icon]')) return
    const viewport = viewportsRef.current.get(pageNum)
    const canvas = document.getElementById(`pdf-canvas-${pageNum}`) as HTMLCanvasElement | null
    if (!viewport || !canvas) return
    const cr = canvas.getBoundingClientRect()
    const [pdfX, pdfY] = viewport.convertToPdfPoint(e.clientX - cr.left, e.clientY - cr.top)
    setPendingNote({ screenX: e.clientX, screenY: e.clientY, pdfX, pdfY, pageNum })
    setNoteText('')
  }, [])

  const confirmNote = useCallback(async () => {
    if (!pendingNote || !pdfBytesRef.current) return
    const { pageNum, pdfX, pdfY } = pendingNote
    setPendingNote(null)
    const id = `note-${Date.now()}`
    setNotes(prev => [...prev, { id, pageNum, pdfX, pdfY, contents: noteText }])
    setSaving(true)
    try {
      const newBytes = await addNoteToPdf(pdfBytesRef.current, pageNum - 1, pdfX, pdfY, noteText, id)
      await window.veridian.fs.writeFile(filePath, newBytes)
      await refreshPdfDoc(newBytes)
    } catch (err) { console.error('[note save]', err) }
    finally { setSaving(false) }
  }, [pendingNote, noteText, filePath, refreshPdfDoc])

  // ── note edit / delete ──

  const saveNoteEdit = useCallback(async (id: string) => {
    if (!pdfBytesRef.current) return
    setNotes(prev => prev.map(n => n.id === id ? { ...n, contents: editText } : n))
    setNotePopup(null)
    setSaving(true)
    try {
      const newBytes = await updateNoteToPdf(pdfBytesRef.current, id, editText)
      await window.veridian.fs.writeFile(filePath, newBytes)
      await refreshPdfDoc(newBytes)
    } catch (err) { console.error('[note edit]', err) }
    finally { setSaving(false) }
  }, [editText, filePath, refreshPdfDoc])

  const deleteNote = useCallback(async (id: string) => {
    if (!pdfBytesRef.current) return
    setNotes(prev => prev.filter(n => n.id !== id))
    setNotePopup(null)
    setSaving(true)
    try {
      const newBytes = await removeAnnotsFromPdf(pdfBytesRef.current, [id])
      await window.veridian.fs.writeFile(filePath, newBytes)
      await refreshPdfDoc(newBytes)
    } catch (err) { console.error('[note delete]', err) }
    finally { setSaving(false) }
  }, [filePath, refreshPdfDoc])

  // ── note icon positions ──

  function noteIconPos(note: NoteAnnot): { left: number; top: number } | null {
    const vp = viewportsRef.current.get(note.pageNum)
    if (!vp) return null
    const canvas = document.getElementById(`pdf-canvas-${note.pageNum}`) as HTMLCanvasElement | null
    if (!canvas) return null
    const wrapper = document.getElementById(`pdf-page-${note.pageNum}`)
    if (!wrapper) return null
    const [sx, sy] = vp.convertToViewportPoint(note.pdfX, note.pdfY)
    const cr = canvas.getBoundingClientRect()
    const wr = wrapper.getBoundingClientRect()
    return { left: sx + (cr.left - wr.left), top: sy + (cr.top - wr.top) }
  }

  // ── styles ──

  const isActive = (t: Tool) => tool === t
  const btnStyle = (t: Tool): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 6,
    border: '1px solid var(--border)',
    background: isActive(t) ? '#2563eb' : 'var(--surface)',
    color: isActive(t) ? '#fff' : 'var(--foreground-2)',
    fontSize: 12, fontWeight: 500, cursor: 'pointer', userSelect: 'none',
  })

  if (error) return <div style={{ padding: 32, color: 'red', fontSize: 13 }}>PDF 加载失败：{error}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '0 12px', minHeight: 40, flexShrink: 0,
        background: 'rgba(242,242,247,0.9)', borderBottom: '1px solid var(--separator)',
        userSelect: 'none',
      }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 2 }}>工具：</span>
        <button style={btnStyle('none')}      onClick={() => setTool('none')}>选择</button>
        <button style={btnStyle('highlight')} onClick={() => setTool('highlight')}>🖊 高亮</button>
        <button style={btnStyle('note')}      onClick={() => setTool('note')}>📌 便签</button>
        <button style={btnStyle('erase')}     onClick={() => setTool('erase')}>🧹 橡皮擦</button>

        {/* Color picker — only shown when highlight tool active */}
        {tool === 'highlight' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>颜色：</span>
            {HIGHLIGHT_COLORS.map((c, i) => (
              <div
                key={c.label}
                onClick={() => setHlColorIdx(i)}
                title={c.label}
                style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: c.css, cursor: 'pointer',
                  border: hlColorIdx === i ? '2.5px solid #2563eb' : '1.5px solid rgba(0,0,0,0.2)',
                  boxSizing: 'border-box',
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>缩放：</span>
        <button style={{ ...btnStyle('none'), padding: '4px 8px' }}
          onClick={() => setScale(s => Math.max(0.5, +(s - 0.25).toFixed(2)))}>−</button>
        <span style={{ fontSize: 12, minWidth: 38, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button style={{ ...btnStyle('none'), padding: '4px 8px' }}
          onClick={() => setScale(s => Math.min(4, +(s + 0.25).toFixed(2)))}>+</button>
        {saving && <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>保存中…</span>}
      </div>

      {/* ── Scroll area ── */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', background: '#525659', padding: '16px 0', position: 'relative' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={() => setNotePopup(null)}
      >
        {/* Rubber-band erase selection overlay */}
        {eraseDrag && (() => {
          const scrollEl = scrollRef.current
          const scrollTop = scrollEl ? scrollEl.scrollTop : 0
          const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0
          const left = Math.min(eraseDrag.x1, eraseDrag.x2) - scrollLeft
          const top = Math.min(eraseDrag.y1, eraseDrag.y2) - scrollTop
          const width = Math.abs(eraseDrag.x2 - eraseDrag.x1)
          const height = Math.abs(eraseDrag.y2 - eraseDrag.y1)
          return (
            <div style={{
              position: 'fixed', left, top, width, height,
              border: '2px dashed #ef4444', background: 'rgba(239,68,68,0.1)',
              pointerEvents: 'none', zIndex: 100,
            }} />
          )
        })()}
        {loading && (
          <div style={{ textAlign: 'center', color: '#ccc', paddingTop: 60, fontSize: 14 }}>加载中…</div>
        )}

        {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => (
          <div key={pageNum} style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
            <div
              id={`pdf-page-${pageNum}`}
              data-page={pageNum}
              style={{ position: 'relative', lineHeight: 0 }}
              onClick={(e) => handlePageClick(e, pageNum)}
            >
              <canvas
                id={`pdf-canvas-${pageNum}`}
                style={{
                  display: 'block', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  cursor: tool === 'note' ? 'crosshair' : tool === 'erase' ? 'cell' : 'default',
                }}
              />

              {/* Note icons */}
              {notes.filter(n => n.pageNum === pageNum).map(note => {
                const pos = noteIconPos(note)
                if (!pos) return null
                const popup = notePopup?.id === note.id ? notePopup : null
                return (
                  <div key={note.id} style={{ position: 'absolute', left: pos.left, top: pos.top, zIndex: 10 }}>
                    <div
                      data-note-icon="1"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (popup) { setNotePopup(null) }
                        else { setNotePopup({ id: note.id, editing: false }); setEditText(note.contents) }
                      }}
                      style={{
                        width: 22, height: 22, background: '#FFD700',
                        border: '1.5px solid #B8960C', borderRadius: '4px 4px 0 4px',
                        cursor: 'pointer', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', fontSize: 13,
                        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                      }}
                      title={note.contents}
                    >📝</div>

                    {popup && (
                      <div
                        onClick={e => e.stopPropagation()}
                        style={{
                          position: 'absolute', left: 26, top: 0,
                          minWidth: 210, maxWidth: 300, zIndex: 20,
                          background: '#FFFDE7', border: '1px solid #B8960C',
                          borderRadius: '0 6px 6px 6px', padding: '8px 10px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
                          display: 'flex', flexDirection: 'column', gap: 6,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#7a6000' }}>便签</span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {!popup.editing && (
                              <button
                                onClick={() => setNotePopup({ id: note.id, editing: true })}
                                style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, border: '1px solid #B8960C', background: '#fff', cursor: 'pointer' }}
                              >编辑</button>
                            )}
                            <button
                              onClick={() => deleteNote(note.id)}
                              style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, border: '1px solid #e55', background: '#fff', color: '#c00', cursor: 'pointer' }}
                            >删除</button>
                          </div>
                        </div>

                        {popup.editing ? (
                          <>
                            <textarea
                              autoFocus
                              value={editText}
                              onChange={e => setEditText(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNoteEdit(note.id) }}
                              rows={3}
                              style={{
                                resize: 'none', fontSize: 12, padding: '3px 5px',
                                border: '1px solid #B8960C', borderRadius: 4, background: '#fff',
                              }}
                            />
                            <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                              <button onClick={() => setNotePopup({ id: note.id, editing: false })}
                                style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>取消</button>
                              <button onClick={() => saveNoteEdit(note.id)}
                                style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}>保存</button>
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: note.contents ? '#333' : '#aaa' }}>
                            {note.contents || '（无内容）'}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── New note popup ── */}
      {pendingNote && (
        <div style={{
          position: 'fixed',
          left: Math.min(pendingNote.screenX + 12, window.innerWidth - 260),
          top: Math.min(pendingNote.screenY + 12, window.innerHeight - 180),
          zIndex: 1000, background: '#FFFDE7', border: '1px solid #B8960C',
          borderRadius: 8, padding: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
          display: 'flex', flexDirection: 'column', gap: 8, minWidth: 230,
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#7a6000' }}>添加便签</span>
          <textarea
            autoFocus value={noteText}
            onChange={e => setNoteText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmNote() }}
            rows={3}
            style={{ resize: 'none', fontSize: 13, padding: '4px 6px', border: '1px solid #B8960C', borderRadius: 4, background: '#fff' }}
            placeholder="输入注释内容… (Ctrl+Enter 确认)"
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setPendingNote(null)} style={btnStyle('none')}>取消</button>
            <button onClick={confirmNote}
              style={{ ...btnStyle('none'), background: '#2563eb', color: '#fff', border: 'none' }}>确认</button>
          </div>
        </div>
      )}
    </div>
  )
}
