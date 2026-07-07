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

interface Pdf2mdPayload {
  itemId: number
  pdfPath: string
  outputPath?: string
}

export function initConversionService(): void {
  registerJobType<Pdf2mdPayload>('pdf2md', async (payload, ctx) => {
    const { itemId, pdfPath, outputPath } = payload
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

  if (existing.some((a) => a.path === mdPath)) return
  if (existsSync(mdPath)) {
    grantAccess(mdPath)
    registerAttachment(itemId, mdPath)
    return
  }

  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfPath), { itemId, pdfPath })
}

/**
 * Manual conversion from the context menu. If a .md already exists for this
 * PDF, appends a version suffix (-1, -2, ...). Returns an error code when the
 * item has no PDF attachment.
 */
export function manualConvertPdfToMd(itemId: number): string | null {
  const attachments = listByItem(itemId)
  const pdfAtt = attachments.find(
    (a) => a.mime_type === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf')
  )
  if (!pdfAtt?.path) return 'no_pdf'

  const pdfPath = pdfAtt.path
  const dir = dirname(pdfPath)
  const stem = basename(pdfPath, '.pdf')

  const baseMd = join(dir, `${stem}.md`)
  let outputPath = baseMd
  if (existsSync(baseMd) || attachments.some((a) => a.path === baseMd)) {
    let version = 1
    while (true) {
      const candidate = join(dir, `${stem}-${version}.md`)
      if (!existsSync(candidate) && !attachments.some((a) => a.path === candidate)) {
        outputPath = candidate
        break
      }
      version++
    }
  }

  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfPath), { itemId, pdfPath, outputPath })
  return null
}
