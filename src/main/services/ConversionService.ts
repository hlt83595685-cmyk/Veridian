// PDF -> Markdown conversion orchestration on top of the generic JobQueue.
// Replaces the pdf2md-only serial queue: progress flows through the Notifier
// job.progress event, and conversion outputs are registered through
// AttachmentService so the UI refreshes automatically.
import { join, dirname, basename } from 'path'
import { existsSync } from 'fs'
import { registerJobType, enqueue } from '../core/JobQueue'
import { convertPdfToMarkdownAuto, convertPdfToMarkdownPrecision } from '../mineruApi'
import { registerAttachment, registerAttachmentDir, listByItem } from './AttachmentService'
import { isPdf2mdEnabled, getPdf2mdMode, getPdf2mdApiToken } from './SettingsService'
import { grantAccess } from '../security/pathGuard'
import { setConversionFailed } from '../db/items'

interface Pdf2mdPayload {
  itemId: number
  pdfPath: string
  outputPath?: string
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
    const { itemId, pdfPath, outputPath } = payload
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
 * Manual conversion from the context menu. Re-running overwrites the
 * previous output IN PLACE (same .md path; registerAttachment dedupes the
 * row) instead of stacking -1/-2 versioned copies -- repeat conversions of
 * one PDF must not multiply files locally or in a synced workspace repo.
 * Returns an error code when the item has no PDF attachment.
 */
export function manualConvertPdfToMd(itemId: number): string | null {
  const attachments = listByItem(itemId)
  const pdfAtt = attachments.find(
    (a) => a.mime_type === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
  )
  if (!pdfAtt?.path) return 'no_pdf'

  const pdfPath = pdfAtt.path

  // Reuse the item's existing markdown output path if there is one
  const existingMd = attachments.find(
    (a) => a.path && (a.mime_type === 'text/markdown' || a.filename?.toLowerCase().endsWith('.md'))
  )
  const outputPath = existingMd?.path ?? join(dirname(pdfPath), `${basename(pdfPath, '.pdf')}.md`)

  pendingConversions++
  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfPath), { itemId, pdfPath, outputPath })
  return null
}
