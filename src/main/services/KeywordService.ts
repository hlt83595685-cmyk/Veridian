// Keyword extraction: markdown attachments first (MinerU output is cleaner),
// PDF text as fallback. Tag writes go through TagService so the UI refreshes
// via the tag.changed event.
import { readFileSync } from 'fs'
import { listByItem } from './AttachmentService'
import { mergeTagsForItem } from './TagService'
import { extractKeywordsFromMarkdown, extractKeywordsFromText, extractPdfText } from '../pdfImporter'

export async function extractKeywordsForItem(itemId: number): Promise<{ added: number; total: number }> {
  const attachments = listByItem(itemId)
  const found = new Set<string>()

  const mds = attachments.filter(
    (a) => a.path && (a.mime_type === 'text/markdown' || a.filename?.toLowerCase().endsWith('.md'))
  )
  for (const att of mds) {
    try {
      const kws = extractKeywordsFromMarkdown(readFileSync(att.path!, 'utf-8'))
      for (const kw of kws) found.add(kw)
    } catch (err) {
      console.warn(`[KeywordService] markdown read failed for item ${itemId}:`, err)
    }
  }

  if (!found.size) {
    const pdfs = attachments.filter(
      (a) => a.path && (a.mime_type === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf'))
    )
    for (const att of pdfs) {
      try {
        const kws = extractKeywordsFromText(await extractPdfText(att.path!))
        for (const kw of kws) found.add(kw)
      } catch (err) {
        console.warn(`[KeywordService] PDF text extraction failed for item ${itemId}:`, err)
      }
    }
  }

  if (!found.size) return { added: 0, total: 0 }
  return mergeTagsForItem(itemId, [...found])
}
