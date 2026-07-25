// PDF -> Markdown conversion orchestration on top of the generic JobQueue.
// Replaces the pdf2md-only serial queue: progress flows through the Notifier
// job.progress event, and conversion outputs are registered through
// AttachmentService so the UI refreshes automatically.
import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { planImageRenames } from './markdownImages'
import { registerJobType, enqueue } from '../core/JobQueue'
import { convertPdfToMarkdownAuto, convertPdfToMarkdownPrecision } from '../mineruApi'
import { registerAttachment, registerAttachmentDir, listByItem } from './AttachmentService'
import { isPdf2mdEnabled, getPdf2mdMode, getPdf2mdApiToken } from './SettingsService'
import { grantAccess } from '../security/pathGuard'
import { setConversionFailed } from '../db/items'

interface Pdf2mdPayload {
  itemId: number
  pdfPath: string
}

// Conversion output ALWAYS goes to a per-item staging dir under userData,
// never next to the PDF: after a workspace sync the PDF lives INSIDE the repo,
// and converting next to it would dump MinerU's raw zip extraction (full.md,
// images, layout.json and other debris) straight into papers/<title>/files/,
// bypassing the exporter's canonical-name overwrite. With staging, only the
// registered md/images attachments are relocated into the repo (md overwrites
// files/<stem>.md; images replaces files/images wholesale) and the debris
// stays here. Cleared before each run so re-conversions start fresh.
function stagingDir(itemId: number): string {
  const dir = join(app.getPath('userData'), 'conversions', String(itemId))
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true })
  return dir
}

// Normalize the conversion output in staging: every image referenced by the
// markdown becomes images/figN.<ext> (order of first appearance), and the
// files in imagesDir are renamed to match. Two-phase rename (via temp names)
// so a source file that happens to already carry a target name (fig1.png)
// can't be clobbered mid-way. Best-effort: a failure here must not fail the
// conversion -- the un-normalized output is still perfectly usable.
function normalizeImages(mdPath: string, imagesDir: string): void {
  try {
    const files = readdirSync(imagesDir).filter((f) => {
      try { return statSync(join(imagesDir, f)).isFile() } catch { return false }
    })
    const md = readFileSync(mdPath, 'utf-8')
    const { content, renames } = planImageRenames(md, files)
    if (renames.length === 0) return
    // Phase 1: move all sources out of the way; Phase 2: settle final names.
    const temps: Array<{ tmp: string; to: string }> = []
    for (const r of renames) {
      const tmp = join(imagesDir, `${randomUUID()}.tmp`)
      renameSync(join(imagesDir, r.from), tmp)
      temps.push({ tmp, to: join(imagesDir, r.to) })
    }
    for (const t of temps) renameSync(t.tmp, t.to)
    writeFileSync(mdPath, content, 'utf-8')
  } catch (err) {
    console.warn('[conversion] image normalization skipped:', (err as Error).message)
  }
}

let pendingConversions = 0
let onIdle: (() => void) | null = null

export function hasPendingConversions(): boolean {
  return pendingConversions > 0
}

export function setOnConversionsIdle(fn: () => void): void {
  onIdle = fn
}

export function initConversionService(): void {
  registerJobType<Pdf2mdPayload>('pdf2md', async (payload, ctx) => {
    const { itemId, pdfPath } = payload
    const outputPath = join(stagingDir(itemId), `${basename(pdfPath, '.pdf')}.md`)
    try {
      const mode = getPdf2mdMode()
      const token = getPdf2mdApiToken()

      let mdPath: string
      if (mode === 'precision') {
        if (!token) throw new Error('精准解析模式需要填写 API Token（请前往设置 → PDF 转换）')
        const result = await convertPdfToMarkdownPrecision(pdfPath, token, (p) => {
          ctx.progress(p.message ?? p.state, p.chunk)
        }, outputPath)
        mdPath = result.mdPath
        if (result.imagesDir) {
          normalizeImages(mdPath, result.imagesDir)   // figN names, in staging
          grantAccess(result.imagesDir)
          registerAttachmentDir(itemId, result.imagesDir, basename(result.imagesDir))
        }
      }
      else {
        mdPath = await convertPdfToMarkdownAuto(pdfPath, (p) => {
          ctx.progress(p.message ?? p.state, p.chunk)
        }, outputPath)
      }
      grantAccess(mdPath)
      registerAttachment(itemId, mdPath)
      setConversionFailed(itemId, false)   // success clears any prior failure
    } catch (err) {
      setConversionFailed(itemId, true)    // hold this item out of sync
      throw err                            // keep JobQueue's error reporting
    } finally {
      pendingConversions--
      if (pendingConversions === 0) onIdle?.()
    }
  }, { concurrency: 1, maxAttempts: 1 })
}

/**
 * Enqueue automatic conversion after import. Skips when disabled, already
 * converted, or a matching .md already exists on disk.
 */
export function autoConvertPdfToMd(itemId: number, pdfPath: string): void {
  if (!isPdf2mdEnabled()) return

  const mdPath = join(dirname(pdfPath), `${basename(pdfPath, '.pdf')}.md`)
  const existing = listByItem(itemId)

  // "Already converted" must be judged by TYPE, not path equality: after a
  // workspace sync relocates the markdown row into the repo its path no
  // longer matches mdPath, and the old check would re-convert (and stack a
  // second markdown attachment) on every subsequent import touching the item.
  if (existing.some((a) => a.type === 'markdown')) return
  if (existsSync(mdPath)) {
    grantAccess(mdPath)
    registerAttachment(itemId, mdPath)
    return
  }

  pendingConversions++
  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfPath), { itemId, pdfPath })
}

/**
 * Manual conversion from the context menu. Output goes to the item's staging
 * dir (see stagingDir); the workspace exporter then relocates it over the
 * previous repo copy under its canonical name -- repeat conversions replace
 * files/<stem>.md and files/images in place, never stack copies or dump
 * MinerU's raw extraction into the repo.
 * Returns an error code when the item has no PDF attachment.
 */
export function manualConvertPdfToMd(itemId: number): string | null {
  const attachments = listByItem(itemId)
  const pdfAtt = attachments.find(
    (a) => a.mime_type === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
  )
  if (!pdfAtt?.path) return 'no_pdf'

  pendingConversions++
  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfAtt.path), { itemId, pdfPath: pdfAtt.path })
  return null
}
