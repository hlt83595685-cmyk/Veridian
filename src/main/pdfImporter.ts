import { readFileSync } from 'fs'
import { basename } from 'path'
import { createItem, findItemByDoi } from './db/items'
import { setCreatorsForItem } from './db/creators'
import { addAttachment, fileMd5, findItemIdByMd5, getAttachmentsByItem } from './db/attachments'
import { addItemToCollection } from './db/collections'
import { setTagsForItem } from './db/tags'
import { fetchCrossRefByDoi, searchCrossRefByTitle, CROSSREF_TYPE_MAP, type CrossRefWork } from './crossref'
import { autoConvertPdfToMd } from './services/ConversionService'
import { emit } from './core/Notifier'

/**
 * Duplicate handling shared by both import branches. Returns the number of
 * NEW items created (0 for duplicates -- the repo must not grow a second
 * papers/<key> dir for the same paper).
 *
 * DOI hit on an item without a PDF = merge: attach this file to it. That is
 * the common "saved via browser extension first, imported the PDF later"
 * flow, and the whole point of doing dedup app-side before anything syncs.
 */
function mergeIntoExisting(existingId: number, filePath: string): void {
  const hasPdf = getAttachmentsByItem(existingId).some((a) => a.type === 'pdf')
  if (hasPdf) return
  addAttachment(existingId, filePath)
  emit({ type: 'attachment.changed', itemIds: [existingId] })
  autoConvertPdfToMd(existingId, filePath)
}

// ── PDF text extraction via pdf-parse ───────────────────────────────────────

export async function extractPdfText(filePath: string): Promise<string> {
  // pdf-parse-new is a CJS-only Node library, safe to require() in Electron main
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse-new') as (
    buf: Buffer,
    opts?: { max?: number }
  ) => Promise<{ text: string }>

  const buf = readFileSync(filePath)
  const result = await pdfParse(buf, { max: 8 })
  return result.text
}

// ── DOI extraction ──────────────────────────────────────────────────────────

export function extractDoi(text: string): string | null {
  const m = text.match(/\b(10\.\d{4,9}\/[^\s"'<>[\]{}|\\^`]+)/i)
  return m ? m[1].replace(/[.)]+$/, '') : null
}

// ── Local heuristic fallback ─────────────────────────────────────────────────

export interface LocalMeta {
  title: string | null
  abstract: string | null
  year: number | null
}

export function parseLocalMeta(text: string, filename: string): LocalMeta {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 5)
  const title = (lines[0] ?? basename(filename, '.pdf')).slice(0, 200)

  const absMatch = text.match(/abstract[:\s]+(.{50,1200}?)(?:\n\n|\bintroduction\b)/is)
  const abstract = absMatch ? absMatch[1].replace(/\s+/g, ' ').trim() : null

  const yearMatch = text.match(/\b(19|20)\d{2}\b/)
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null

  return { title, abstract, year }
}

// ── Keyword extraction from PDF text ────────────────────────────────────────

export function extractKeywordsFromText(text: string): string[] {
  // Normalise line endings and collapse repeated whitespace within lines
  // (pdf-parse often inserts newlines inside keyword lists)
  const normalised = text
    .replace(/\r\n?/g, '\n')
    // Join lines that look like continuation of a keyword list:
    // a line ending mid-word (no sentence-ending punctuation) followed by a
    // line that starts lowercase or continues with a delimiter
    .replace(/([^.\n]{1,60})\n(?=[a-z,;·•])/g, '$1 ')

  // Header patterns:
  //   Keywords:  /  Key words:  /  Index Terms:  /  关键词:
  //   followed by the keyword text which may itself span 1-3 lines
  const headerRe =
    /(?:keywords?|key\s*words?|index\s+terms?|关键词)\s*[:\-—–·]\s*([\s\S]{4,400}?)(?=\n\n|\n[A-Z1-9]|$)/i

  const m = normalised.match(headerRe)

  if (!m) {
    // Fallback: look for a line that IS a keyword header with no trailing text,
    // then grab the next non-empty line(s)
    const headerOnly = normalised.match(
      /(?:keywords?|key\s*words?|index\s+terms?|关键词)\s*[:\-—–]?\s*\n([\s\S]{4,300}?)(?=\n\n|\n[A-Z1-9]|$)/i
    )
    if (!headerOnly) return []
    return splitKeywords(headerOnly[1])
  }

  return splitKeywords(m[1])
}

function splitKeywords(raw: string): string[] {
  // Collapse newlines into spaces so multi-line keyword phrases are preserved
  // e.g. "Lagrangian\nparticle tracking" → "Lagrangian particle tracking"
  const flat = raw.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim()

  // Detect primary separator in priority order: · ; , (space-dot-space counts as ·)
  // "word1 · word2" and "word1·word2" both match
  const byDot       = flat.split(/\s*·\s*/).filter((k) => k.trim().length >= 2)
  const bySemicolon = flat.split(/\s*;\s*/).filter((k) => k.trim().length >= 2)
  const byComma     = flat.split(/\s*[,，]\s*/).filter((k) => k.trim().length >= 2)

  // Pick the separator that produces the most parts (>1 means it actually split)
  let parts: string[]
  if (byDot.length > 1) {
    parts = byDot
  } else if (bySemicolon.length > 1) {
    parts = bySemicolon
  } else if (byComma.length > 1) {
    parts = byComma
  } else {
    // Last resort: split on two or more spaces (some PDFs use spacing as separator)
    parts = flat.split(/\s{2,}/).filter((k) => k.trim().length >= 2)
    if (parts.length <= 1) parts = [flat]
  }

  return parts
    .map((k) =>
      k
        .replace(/^[·•\-–—\s]+/, '')  // leading bullets / dashes
        .replace(/[.。·•]+$/, '')      // trailing punctuation
        .replace(/\s{2,}/g, ' ')       // collapse internal whitespace
        .trim()
    )
    .filter((k) => k.length >= 2 && k.length <= 80)
    .slice(0, 20)
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function importPDF(filePath: string, collectionId?: number): Promise<number> {
  // Dedup gate 1 -- exact file: this byte-identical PDF is already attached
  // to an active item. Cheapest check, catches "imported the same file twice".
  const md5 = fileMd5(filePath)
  if (md5) {
    const owner = findItemIdByMd5(md5)
    if (owner !== null) {
      console.log(`[pdfImporter] duplicate file (md5=${md5.slice(0, 8)}…) already on item ${owner} -- skipping`)
      if (collectionId) { try { addItemToCollection(collectionId, owner) } catch { /* already in */ } }
      return 0
    }
  }

  let text: string
  try {
    text = await extractPdfText(filePath)
  } catch (err) {
    console.error('[pdfImporter] text extraction failed:', err)
    const stub = createItem({ type: 'journalArticle', title: basename(filePath, '.pdf') })
    if (collectionId) addItemToCollection(collectionId, stub.id)
    try { addAttachment(stub.id, filePath) } catch { /* ignore */ }
    autoConvertPdfToMd(stub.id, filePath)
    return 1
  }

  const doi = extractDoi(text)
  console.log(`[pdfImporter] DOI found: ${doi ?? 'none'}`)

  let work: CrossRefWork | null = null
  if (doi) {
    console.log('[pdfImporter] Querying CrossRef by DOI...')
    work = await fetchCrossRefByDoi(doi)
    console.log(`[pdfImporter] CrossRef DOI lookup: ${work ? 'OK' : 'not found / offline'}`)
  }

  // Fallback: no DOI in the text, or the extracted DOI didn't resolve --
  // very common for scanned PDFs, hyphen-wrapped DOIs, or non-journal
  // preprints. Search CrossRef by the heuristically-guessed title instead of
  // giving up on CrossRef entirely.
  const localMeta = parseLocalMeta(text, filePath)
  if (!work && localMeta.title) {
    console.log('[pdfImporter] No DOI match, trying CrossRef title search...')
    work = await searchCrossRefByTitle(localMeta.title)
    console.log(`[pdfImporter] CrossRef title search: ${work ? 'OK' : 'no match'}`)
  }

  // Dedup gate 2 -- DOI: the library already has this paper (possibly saved
  // via the browser extension, or imported from BibTeX). Never create a
  // second item; merge the PDF into the existing one if it has none.
  const effectiveDoi = work?.DOI ?? doi
  if (effectiveDoi) {
    const existing = findItemByDoi(effectiveDoi)
    if (existing) {
      console.log(`[pdfImporter] duplicate DOI ${effectiveDoi} -> item ${existing.id} ("${existing.title}") -- merging instead of creating`)
      mergeIntoExisting(existing.id, filePath)
      if (collectionId) { try { addItemToCollection(collectionId, existing.id) } catch { /* already in */ } }
      return 0
    }
  }

  if (work) {
    const dateObj =
      work.published?.['date-parts'] ??
      work['published-print']?.['date-parts'] ??
      work['published-online']?.['date-parts']
    const year = dateObj?.[0]?.[0] ?? null
    const type = CROSSREF_TYPE_MAP[work.type ?? ''] ?? 'journalArticle'

    const item = createItem({
      type,
      title: work.title?.[0] ?? null,
      abstract: work.abstract?.replace(/<[^>]+>/g, '').trim() ?? null,
      year,
      doi: work.DOI ?? doi,
      url: work.URL ?? null,
      journal: work['container-title']?.[0] ?? null,
      publisher: work.publisher ?? null,
      volume: work.volume ?? null,
      issue: work.issue ?? null,
      pages: work.page ?? null,
      isbn: work.ISBN?.[0] ?? null,
      language: work.language ?? null,
    })
    if (collectionId) addItemToCollection(collectionId, item.id)

    const authors = (work.author ?? [])
      .filter((a) => a.family)
      .map((a, i) => ({
        last_name: a.family!,
        first_name: a.given ?? null,
        role: 'author' as const,
        position: i,
      }))
    const editors = (work.editor ?? [])
      .filter((e) => e.family)
      .map((e, i) => ({
        last_name: e.family!,
        first_name: e.given ?? null,
        role: 'editor' as const,
        position: authors.length + i,
      }))
    const creators = [...authors, ...editors]
    if (creators.length) setCreatorsForItem(item.id, creators)

    // Combine CrossRef subject + PDF keyword section
    const pdfKeywords = extractKeywordsFromText(text)
    const crSubjects = work.subject ?? []
    const allKeywords = [
      ...crSubjects,
      ...pdfKeywords.filter((k) => !crSubjects.some((s) => s.toLowerCase() === k.toLowerCase())),
    ]
    if (allKeywords.length) setTagsForItem(item.id, allKeywords)

    addAttachment(item.id, filePath)
    console.log(`[pdfImporter] Imported via CrossRef: "${item.title}" (${allKeywords.length} keywords)`)
    autoConvertPdfToMd(item.id, filePath)
  } else {
    const item = createItem({
      type: 'journalArticle',
      title: localMeta.title,
      abstract: localMeta.abstract,
      year: localMeta.year,
      doi: doi ?? null,
    })
    if (collectionId) addItemToCollection(collectionId, item.id)

    // PDF-only: extract keywords from text
    const pdfKeywords = extractKeywordsFromText(text)
    if (pdfKeywords.length) setTagsForItem(item.id, pdfKeywords)

    addAttachment(item.id, filePath)
    console.log(`[pdfImporter] Imported via local heuristic: "${item.title}" (${pdfKeywords.length} keywords)`)
    autoConvertPdfToMd(item.id, filePath)
  }

  return 1
}

// ── Keyword extraction from Markdown text ────────────────────────────────────

export function extractKeywordsFromMarkdown(md: string): string[] {
  // Normalise line endings
  const text = md.replace(/\r\n?/g, '\n')

  // Patterns to try, in priority order:
  // 1. Bold inline header:  **Keywords**: ... or **关键词**: ...
  // 2. Plain inline header: Keywords: ...  / Index Terms: ...  / 关键词: ...
  // 3. Markdown heading block:
  //      ## Keywords
  //      word1; word2

  const inlineBold = text.match(
    /\*{1,2}(?:keywords?|key\s*words?|index\s+terms?|关键词)\*{1,2}\s*[：:]\s*(.{4,400}?)(?:\n\n|\n#|$)/i
  )
  if (inlineBold) return splitKeywords(inlineBold[1])

  const inlinePlain = text.match(
    /(?:^|\n)(?:keywords?|key\s*words?|index\s+terms?|关键词)\s*[：:]\s*(.{4,400}?)(?:\n\n|\n#|$)/i
  )
  if (inlinePlain) return splitKeywords(inlinePlain[1])

  // Heading block: ## Keywords\n...\n\n
  const headingBlock = text.match(
    /#{1,4}\s*(?:keywords?|key\s*words?|index\s+terms?|关键词)\s*\n+([\s\S]{4,400}?)(?:\n\n|\n#|$)/i
  )
  if (headingBlock) return splitKeywords(headingBlock[1])

  return []
}

// ── Title extraction from Markdown text ──────────────────────────────────────

// Section/heading words that are never the paper's own title even when they
// appear as the first heading (MinerU sometimes emits a running header or an
// "Abstract" heading before the real title slips into plain bold text).
const NON_TITLE_HEADINGS = /^(abstract|keywords?|关键词|摘要|contents|目录|references?|参考文献)$/i

export function extractTitleFromMarkdown(md: string): string | null {
  const text = md.replace(/\r\n?/g, '\n')

  // Prefer the first Markdown heading (# / ##); MinerU puts the paper title
  // there in the vast majority of converted PDFs.
  const headingMatches = text.matchAll(/^#{1,2}\s+(.+?)\s*$/gm)
  for (const m of headingMatches) {
    const candidate = cleanTitle(m[1])
    if (isPlausibleTitle(candidate)) return candidate
  }

  // Fallback: first bold line near the top (some MinerU outputs skip the
  // heading marker and just bold the title).
  const boldMatches = text.matchAll(/^\*{2}(.+?)\*{2}\s*$/gm)
  for (const m of boldMatches) {
    const candidate = cleanTitle(m[1])
    if (isPlausibleTitle(candidate)) return candidate
  }

  return null
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\*{1,2}/g, '')          // stray emphasis markers
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300)
}

function isPlausibleTitle(candidate: string): boolean {
  if (candidate.length < 6 || candidate.length > 300) return false
  if (NON_TITLE_HEADINGS.test(candidate)) return false
  return true
}

// On-demand keyword + title extraction for existing items lives in
// services/KeywordService.ts (single write path via TagService/ItemService).
