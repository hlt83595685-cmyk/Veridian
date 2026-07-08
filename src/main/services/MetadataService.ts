// On-demand metadata fetch for an existing item: re-runs the same CrossRef
// lookup used at import time (DOI first, then title search) against the
// item's PDF attachment. Falls back to markdown-derived title/keywords
// (KeywordService) when there's no PDF or CrossRef has no match. All writes
// go through Item/Creator/TagService so the UI refreshes via domain events.
import { readFileSync } from 'fs'
import { listByItem } from './AttachmentService'
import { getItem, updateItem } from './ItemService'
import { setCreatorsForItem } from './CreatorService'
import { mergeTagsForItem } from './TagService'
import { extractKeywordsForItem } from './KeywordService'
import {
  extractPdfText, extractDoi, parseLocalMeta, extractKeywordsFromText,
} from '../pdfImporter'
import { fetchCrossRefByDoi, searchCrossRefByTitle, type CrossRefWork } from '../crossref'

export interface MetadataFetchResult {
  source: 'crossref' | 'markdown' | 'none'
  titleUpdated: boolean
  tagsAdded: number
}

const GENERIC_TITLES = new Set(['新条目', '(untitled)', '（无标题）', 'untitled'])

function isMeaningfulTitle(title: string | null): boolean {
  if (!title) return false
  if (title.trim().length < 6) return false
  if (GENERIC_TITLES.has(title.trim().toLowerCase())) return false
  return true
}

async function applyCrossRefWork(itemId: number, work: CrossRefWork, extraKeywords: string[]): Promise<boolean> {
  const dateObj =
    work.published?.['date-parts'] ??
    work['published-print']?.['date-parts'] ??
    work['published-online']?.['date-parts']
  const year = dateObj?.[0]?.[0] ?? null

  // Note: the items repo's updateItem() uses COALESCE(@field, field) -- a
  // bound value of `null` means "leave unchanged", and it does not support
  // changing `type` at all (createItem-only column), so it's omitted here.
  // Every field must be null rather than undefined: better-sqlite3 throws on
  // undefined bind values.
  updateItem(itemId, {
    title: work.title?.[0] ?? null,
    abstract: work.abstract?.replace(/<[^>]+>/g, '').trim() ?? null,
    year,
    doi: work.DOI ?? null,
    url: work.URL ?? null,
    journal: work['container-title']?.[0] ?? null,
    publisher: work.publisher ?? null,
    volume: work.volume ?? null,
    issue: work.issue ?? null,
    pages: work.page ?? null,
    isbn: work.ISBN?.[0] ?? null,
    language: work.language ?? null,
  })

  const authors = (work.author ?? [])
    .filter((a) => a.family)
    .map((a, i) => ({ last_name: a.family!, first_name: a.given ?? null, role: 'author' as const, position: i }))
  const editors = (work.editor ?? [])
    .filter((e) => e.family)
    .map((e, i) => ({
      last_name: e.family!, first_name: e.given ?? null, role: 'editor' as const, position: authors.length + i,
    }))
  const creators = [...authors, ...editors]
  if (creators.length) setCreatorsForItem(itemId, creators)

  const crSubjects = work.subject ?? []
  const allKeywords = [
    ...crSubjects,
    ...extraKeywords.filter((k) => !crSubjects.some((s) => s.toLowerCase() === k.toLowerCase())),
  ]
  if (allKeywords.length) mergeTagsForItem(itemId, allKeywords)

  return !!work.title?.[0]
}

export async function fetchMetadataForItem(itemId: number): Promise<MetadataFetchResult> {
  const attachments = listByItem(itemId)
  const pdfAtt = attachments.find(
    (a) => a.path && (a.mime_type === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf'))
  )

  if (pdfAtt?.path) {
    let text: string
    try {
      text = await extractPdfText(pdfAtt.path)
    } catch (err) {
      console.warn(`[MetadataService] PDF text extraction failed for item ${itemId}:`, err)
      text = ''
    }

    if (text) {
      const doi = extractDoi(text)
      let work: CrossRefWork | null = null
      if (doi) work = await fetchCrossRefByDoi(doi)

      if (!work) {
        const item = getItem(itemId)
        const candidate = isMeaningfulTitle(item?.title ?? null)
          ? item!.title!
          : parseLocalMeta(text, pdfAtt.path).title
        if (candidate) work = await searchCrossRefByTitle(candidate)
      }

      if (work) {
        const pdfKeywords = extractKeywordsFromText(text)
        const titleUpdated = await applyCrossRefWork(itemId, work, pdfKeywords)
        return { source: 'crossref', titleUpdated, tagsAdded: (work.subject ?? []).length + pdfKeywords.length }
      }
    }
  }

  // No PDF, no DOI match, or no title-search match -- fall back to whatever
  // the converted markdown can offer.
  const md = await extractKeywordsForItem(itemId)
  if (md.added > 0 || md.titleUpdated) {
    return { source: 'markdown', titleUpdated: md.titleUpdated, tagsAdded: md.added }
  }

  return { source: 'none', titleUpdated: false, tagsAdded: 0 }
}
