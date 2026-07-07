import { readFileSync } from 'fs'
import { createItem } from './db/items'
import { setCreatorsForItem } from './db/creators'
import { setTagsForItem } from './db/tags'
import { addItemToCollection } from './db/collections'

// ── BibTeX parser (no external dependency) ──────────────────────────────────

interface BibEntry {
  type: string
  key: string
  fields: Record<string, string>
}

function parseBibTeX(src: string): BibEntry[] {
  const entries: BibEntry[] = []
  // Match @type{key, ...}
  const entryRe = /@(\w+)\s*\{\s*([^,]+),([^@]*)/gs
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(src)) !== null) {
    const type = m[1].toLowerCase()
    if (type === 'string' || type === 'preamble' || type === 'comment') continue
    const key = m[2].trim()
    const body = m[3]
    const fields: Record<string, string> = {}
    const fieldRe = /(\w+)\s*=\s*(?:\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}|"([^"]*)"|([\w\d]+))/g
    let fm: RegExpExecArray | null
    while ((fm = fieldRe.exec(body)) !== null) {
      const val = (fm[2] ?? fm[3] ?? fm[4] ?? '').replace(/\s+/g, ' ').trim()
      fields[fm[1].toLowerCase()] = val
    }
    entries.push({ type, key, fields })
  }
  return entries
}

const BIB_TYPE_MAP: Record<string, string> = {
  article: 'journalArticle',
  book: 'book',
  inproceedings: 'conferencePaper',
  conference: 'conferencePaper',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  techreport: 'report',
  misc: 'webpage',
  unpublished: 'preprint',
  inbook: 'bookSection',
  incollection: 'bookSection',
}

export function importBibTeX(filePath: string, collectionId?: number): number {
  const src = readFileSync(filePath, 'utf-8')
  const entries = parseBibTeX(src)
  let count = 0
  for (const entry of entries) {
    const f = entry.fields
    const type = BIB_TYPE_MAP[entry.type] ?? 'journalArticle'
    const year = f.year ? parseInt(f.year, 10) : null
    const item = createItem({
      type,
      title: f.title,
      abstract: f.abstract,
      year: isNaN(year!) ? null : year,
      doi: f.doi,
      url: f.url,
      journal: f.journal ?? f.booktitle,
      publisher: f.publisher,
      volume: f.volume,
      issue: f.number,
      pages: f.pages,
      isbn: f.isbn,
    })
    if (collectionId) addItemToCollection(collectionId, item.id)
    // Parse authors: "Last, First and Last2, First2"
    const authorStr = f.author ?? f.editor ?? ''
    if (authorStr) {
      const creators = authorStr.split(/\s+and\s+/i).map((a, i) => {
        const parts = a.split(',').map((s) => s.trim())
        return {
          last_name: parts[0] ?? a.trim(),
          first_name: parts[1] ?? null,
          role: f.editor && !f.author ? 'editor' : 'author',
          position: i,
        }
      })
      setCreatorsForItem(item.id, creators)
    }
    // BibTeX keywords field: comma or semicolon separated
    if (f.keywords) {
      const tags = f.keywords
        .split(/[;,]/)
        .map((k) => k.trim())
        .filter((k) => k.length >= 2 && k.length <= 60)
      if (tags.length) setTagsForItem(item.id, tags)
    }
    count++
  }
  return count
}

// ── CSL-JSON importer ────────────────────────────────────────────────────────

interface CSLItem {
  type?: string
  title?: string
  abstract?: string
  issued?: { 'date-parts'?: number[][] }
  DOI?: string
  URL?: string
  'container-title'?: string
  publisher?: string
  volume?: string
  issue?: string
  page?: string
  ISBN?: string
  language?: string
  keyword?: string
  author?: Array<{ family?: string; given?: string }>
  editor?: Array<{ family?: string; given?: string }>
}

const CSL_TYPE_MAP: Record<string, string> = {
  'article-journal': 'journalArticle',
  book: 'book',
  'chapter': 'bookSection',
  'paper-conference': 'conferencePaper',
  thesis: 'thesis',
  report: 'report',
  webpage: 'webpage',
  manuscript: 'preprint',
}

export function importCSLJSON(filePath: string, collectionId?: number): number {
  const raw = readFileSync(filePath, 'utf-8')
  let data: CSLItem | CSLItem[]
  try {
    data = JSON.parse(raw)
  } catch {
    return 0
  }
  const entries: CSLItem[] = Array.isArray(data) ? data : [data]
  let count = 0
  for (const csl of entries) {
    const year = csl.issued?.['date-parts']?.[0]?.[0] ?? null
    const type = CSL_TYPE_MAP[csl.type ?? ''] ?? 'journalArticle'
    const item = createItem({
      type,
      title: csl.title,
      abstract: csl.abstract,
      year,
      doi: csl.DOI,
      url: csl.URL,
      journal: csl['container-title'],
      publisher: csl.publisher,
      volume: csl.volume,
      issue: csl.issue,
      pages: csl.page,
      isbn: csl.ISBN,
      language: csl.language,
    })
    if (collectionId) addItemToCollection(collectionId, item.id)
    // CSL keyword field: semicolon-separated string
    if (csl.keyword) {
      const tags = csl.keyword
        .split(/[;,]/)
        .map((k) => k.trim())
        .filter((k) => k.length >= 2 && k.length <= 60)
      if (tags.length) setTagsForItem(item.id, tags)
    }
    const authors = csl.author ?? []
    const editors = csl.editor ?? []
    const creators = [
      ...authors.map((a, i) => ({
        last_name: a.family ?? 'Unknown',
        first_name: a.given ?? null,
        role: 'author' as const,
        position: i,
      })),
      ...editors.map((e, i) => ({
        last_name: e.family ?? 'Unknown',
        first_name: e.given ?? null,
        role: 'editor' as const,
        position: i,
      })),
    ]
    if (creators.length) setCreatorsForItem(item.id, creators)
    count++
  }
  return count
}
