// Keyword + title extraction from the converted markdown attachment only
// (MinerU output). PDF text is no longer used as a source -- markdown is the
// single source of truth once conversion has run. Writes go through
// TagService / ItemService so the UI refreshes via their domain events.
import { readFileSync } from 'fs'
import { listByItem } from './AttachmentService'
import { mergeTagsForItem } from './TagService'
import { updateItem } from './ItemService'
import { extractKeywordsFromMarkdown, extractTitleFromMarkdown } from '../pdfImporter'

function firstMarkdownText(itemId: number): string | null {
  const mds = listByItem(itemId).filter(
    (a) => a.path && (a.mime_type === 'text/markdown' || a.filename?.toLowerCase().endsWith('.md'))
  )
  for (const att of mds) {
    try {
      return readFileSync(att.path!, 'utf-8')
    } catch (err) {
      console.warn(`[KeywordService] markdown read failed for item ${itemId}:`, err)
    }
  }
  return null
}

export async function extractKeywordsForItem(
  itemId: number
): Promise<{ added: number; total: number; titleUpdated: boolean }> {
  const md = firstMarkdownText(itemId)
  if (!md) return { added: 0, total: 0, titleUpdated: false }

  const keywords = extractKeywordsFromMarkdown(md)
  const { added, total } = keywords.length
    ? mergeTagsForItem(itemId, keywords)
    : { added: 0, total: 0 }

  const title = extractTitleFromMarkdown(md)
  let titleUpdated = false
  if (title) {
    updateItem(itemId, { title })
    titleUpdated = true
  }

  return { added, total, titleUpdated }
}
