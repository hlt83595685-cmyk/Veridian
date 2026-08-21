// PDF -> Markdown conversion orchestration on top of the generic JobQueue.
// Replaces the pdf2md-only serial queue: progress flows through the Notifier
// job.progress event, and conversion outputs are registered through
// AttachmentService so the UI refreshes automatically.
import { join, dirname, basename } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import type Database from 'better-sqlite3'
import { planImageRenames } from './markdownImages'
import { registerJobType, enqueue, isBusy } from '../core/JobQueue'
import { convertPdfToMarkdownAuto, convertPdfToMarkdownPrecision } from '../mineruApi'
import { registerAttachment, registerAttachmentDir, listByItem } from './AttachmentService'
import { isPdf2mdEnabled, getPdf2mdMode, getPdf2mdApiToken } from './SettingsService'
import { grantAccess } from '../security/pathGuard'
import { setConversionFailed } from '../db/items'
import { emit } from '../core/Notifier'
import { getActiveWorkspace } from './WorkspaceContextService'
import { isInside, moveInto } from './storagePaths'

interface Pdf2mdPayload {
  itemId: number
  pdfPath: string
}

// Conversion output ALWAYS goes to a per-item staging dir, never next to the
// PDF: after a workspace sync the PDF lives INSIDE the repo, and converting
// next to it would dump MinerU's raw zip extraction (full.md, images,
// layout.json and other debris) straight into papers/<title>/files/,
// bypassing the exporter's canonical-name overwrite. With staging, only the
// registered md/images attachments are relocated into the repo (md overwrites
// files/<stem>.md; images replaces files/images wholesale) and the debris
// stays here. Cleared before each run so re-conversions start fresh.

/**
 * Root of the scratch area. Follows the active library's location so bulk data
 * stays off the system drive and the later relocation is a same-volume rename;
 * libraries with no content root of their own fall back to userData.
 */
export function stagingRootDir(): string {
  return getActiveWorkspace().stagingRoot ?? join(app.getPath('userData'), 'conversions')
}

function stagingDir(itemId: number): string {
  const dir = join(stagingRootDir(), String(itemId))
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Drop an item's scratch directory once its payloads have been relocated.
 *
 * Guarded: if any attachment of this item still points inside the scratch
 * directory, the relocation didn't finish (moveInto keeps the source on
 * failure) and the scratch copy is still the live one -- so leave it alone.
 */
export function clearStagingIfRelocated(db: Database.Database, itemId: number): void {
  const dir = join(stagingRootDir(), String(itemId))
  if (!existsSync(dir)) return
  const rows = db.prepare('SELECT path FROM attachments WHERE item_id = ? AND path IS NOT NULL')
    .all(itemId) as Array<{ path: string }>
  if (rows.some((r) => isInside(r.path, dir))) return
  try { rmSync(dir, { recursive: true, force: true }) }
  catch (err) { console.warn(`[conversion] staging cleanup failed (${dir}):`, (err as Error).message) }
}

/** Permanent home for conversion output of libraries that have no content
 *  root of their own. A directory per item, because the markdown references
 *  its figures as `images/figN.jpg` -- md and images must stay siblings. */
export function convertedDir(itemId: number): string {
  return join(app.getPath('userData'), 'converted', String(itemId))
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
    const { content, renames, unreferenced } = planImageRenames(md, files)

    // Images the document never references (cover thumbnails, duplicate page
    // captures MinerU sometimes emits) don't get a fig name -- delete them so
    // only images actually used by the markdown ship to the repo.
    for (const name of unreferenced) {
      try { rmSync(join(imagesDir, name), { force: true }) } catch { /* ignore */ }
    }

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

// Busy-ness is derived from the JobQueue's own bookkeeping rather than a manual
// counter: a handler that throws before its finally block used to leak a count
// and wedge the idle signal forever, which stranded a whole batch's converted
// files in staging instead of relocating them into the workspace folder.
let onIdleHook: (() => void) | null = null

export function hasPendingConversions(): boolean {
  return isBusy('pdf2md')
}

export function setOnConversionsIdle(fn: () => void): void {
  onIdleHook = fn
}

export function initConversionService(): void {
  registerJobType<Pdf2mdPayload>('pdf2md', async (payload, ctx) => {
    const { itemId, pdfPath } = payload
    try {
      const outputPath = join(stagingDir(itemId), `${basename(pdfPath, '.pdf')}.md`)
      const mode = getPdf2mdMode()
      const token = getPdf2mdApiToken()

      let mdPath: string
      let imagesDir: string | null = null
      if (mode === 'precision') {
        if (!token) throw new Error('精准解析模式需要填写 API Token（请前往设置 → PDF 转换）')
        const result = await convertPdfToMarkdownPrecision(pdfPath, token, (p) => {
          ctx.progress(p.message ?? p.state, p.chunk, p.progress)
        }, outputPath)
        mdPath = result.mdPath
        if (result.imagesDir) {
          normalizeImages(mdPath, result.imagesDir)   // figN names, in staging
          imagesDir = result.imagesDir
        }
      }
      else {
        mdPath = await convertPdfToMarkdownAuto(pdfPath, (p) => {
          ctx.progress(p.message ?? p.state, p.chunk, p.progress)
        }, outputPath)
      }
      // A library with no content root never runs an export, so the scratch
      // area would become these files' permanent home -- and the scratch area
      // gets wiped wholesale by the next conversion. Give them a real home now.
      let finalMd = mdPath
      let finalImages = imagesDir
      if (getActiveWorkspace().repoRoot == null) {
        const home = convertedDir(itemId)
        rmSync(home, { recursive: true, force: true })   // re-conversion overwrites
        if (moveInto(mdPath, join(home, 'Full.md'))) finalMd = join(home, 'Full.md')
        if (finalImages && moveInto(finalImages, join(home, 'images'))) {
          finalImages = join(home, 'images')
        }
      }
      grantAccess(finalMd)
      registerAttachment(itemId, finalMd)
      if (finalImages) {
        grantAccess(finalImages)
        registerAttachmentDir(itemId, finalImages, basename(finalImages))
      }
      // Nothing of value is left in scratch for a rootless library -- for one
      // with a content root, the export relocates and Task 4 clears it. Only
      // safe once neither final path still lives in this item's scratch dir --
      // e.g. the md moved but the images move failed.
      const itemStagingDir = join(stagingRootDir(), String(itemId))
      if (
        getActiveWorkspace().repoRoot == null &&
        !isInside(finalMd, itemStagingDir) &&
        (!finalImages || !isInside(finalImages, itemStagingDir))
      ) {
        try { rmSync(itemStagingDir, { recursive: true, force: true }) }
        catch { /* leftover; the GC reclaims it */ }
      }
      setConversionFailed(itemId, false)   // success clears any prior failure
      emit({ type: 'item.modified', ids: [itemId] })   // refresh the list's red-flag column
    } catch (err) {
      setConversionFailed(itemId, true)    // flag the item; it still exports
      emit({ type: 'item.modified', ids: [itemId] })   // surface the red flag in the list now
      throw err                            // keep JobQueue's error reporting
    }
  }, { concurrency: 1, maxAttempts: 1, onIdle: () => onIdleHook?.() })
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

  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfAtt.path), { itemId, pdfPath: pdfAtt.path })
  return null
}
