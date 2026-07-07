import http from 'http'
import { createItem } from '../services/ItemService'
import { setCreatorsForItem } from '../services/CreatorService'
import { getAllCollections } from '../db/collections'
import { addItemToCollection } from '../services/CollectionService'
import { addAttachmentFromUrl } from '../services/AttachmentService'
import { fetchCrossRefByDoi, searchCrossRefByTitle, CROSSREF_TYPE_MAP } from '../crossref'
import { setTagsForItem } from '../services/TagService'
import { autoConvertPdfToMd } from '../services/ConversionService'

const PORT = 23119
let server: http.Server | null = null

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// ── CrossRef enrichment (shared by /preview and /save) ─────────────────────

interface EnrichedItem {
  type: string
  title: string | null
  abstract: string | null
  year: number | null
  doi: string | null
  url: string | null
  journal: string | null
  publisher: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  isbn: string | null
  language: string | null
  authors: { last_name: string; first_name: string | null }[]
  pdf_url: string | null
  keywords: string[]
}

async function enrich(input: Partial<EnrichedItem>): Promise<EnrichedItem> {
  let { type, title, abstract, year, doi, url, journal, publisher,
        volume, issue, pages, isbn, language, authors = [], pdf_url,
        keywords = [] } = input

  const apply = (cr: Awaited<ReturnType<typeof fetchCrossRefByDoi>>) => {
    if (!cr) return
    const dateParts =
      cr.published?.['date-parts'] ??
      cr['published-print']?.['date-parts'] ??
      cr['published-online']?.['date-parts']
    if (!doi)   doi   = cr.DOI ?? null
    if (!type)  type  = CROSSREF_TYPE_MAP[cr.type ?? ''] ?? 'journalArticle'
    title     = title     || cr.title?.[0]     || null
    abstract  = abstract  || (cr.abstract?.replace(/<[^>]+>/g, '').trim()) || null
    year      = year      || (dateParts?.[0]?.[0] ?? null)
    journal   = journal   || cr['container-title']?.[0] || null
    publisher = publisher || cr.publisher || null
    volume    = volume    || cr.volume    || null
    issue     = issue     || cr.issue     || null
    pages     = pages     || cr.page      || null
    language  = language  || cr.language  || null
    if (!authors?.length && cr.author?.length) {
      authors = cr.author
        .filter((a) => a.family)
        .map((a) => ({ last_name: a.family!, first_name: a.given ?? null }))
    }
    // Merge CrossRef subject tags (deduplicate)
    if (cr.subject?.length) {
      const existing = new Set(keywords.map((k) => k.toLowerCase()))
      for (const s of cr.subject) {
        if (s && !existing.has(s.toLowerCase())) {
          keywords = [...keywords, s]
          existing.add(s.toLowerCase())
        }
      }
    }
  }

  try {
    if (doi) {
      apply(await fetchCrossRefByDoi(doi))
    } else if (title) {
      apply(await searchCrossRefByTitle(title))
    }
  } catch { /* non-fatal */ }

  return {
    type:      type      ?? 'journalArticle',
    title:     title     ?? null,
    abstract:  abstract  ?? null,
    year:      year ? Number(year) : null,
    doi:       doi       ?? null,
    url:       url       ?? null,
    journal:   journal   ?? null,
    publisher: publisher ?? null,
    volume:    volume    ?? null,
    issue:     issue     ?? null,
    pages:     pages     ?? null,
    isbn:      isbn      ?? null,
    language:  language  ?? null,
    authors:   authors   ?? [],
    pdf_url:   pdf_url   ?? null,
    keywords:  keywords,
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startLocalServer(): void {
  server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    const url = (req.url ?? '/').split('?')[0]

    try {
      // GET /ping
      if (req.method === 'GET' && url === '/ping') {
        return json(res, 200, { ok: true, app: 'Veridian' })
      }

      // GET /collections
      if (req.method === 'GET' && url === '/collections') {
        return json(res, 200, { collections: getAllCollections() })
      }

      // POST /preview — CrossRef lookup, return enriched metadata (no save)
      if (req.method === 'POST' && url === '/preview') {
        const body = JSON.parse(await readBody(req))
        const item = await enrich(body)
        return json(res, 200, item)
      }

      // POST /save — enrich + persist
      if (req.method === 'POST' && url === '/save') {
        const body = JSON.parse(await readBody(req))
        const { collectionId, ...rest } = body
        const item = await enrich(rest)

        const saved = createItem({
          type:      item.type,
          title:     item.title,
          abstract:  item.abstract,
          year:      item.year,
          doi:       item.doi,
          url:       item.url,
          journal:   item.journal,
          publisher: item.publisher,
          volume:    item.volume,
          issue:     item.issue,
          pages:     item.pages,
          isbn:      item.isbn,
          language:  item.language,
        })

        if (item.authors.length) {
          setCreatorsForItem(
            saved.id,
            item.authors.map((a, i) => ({
              last_name:  a.last_name,
              first_name: a.first_name,
              role: 'author' as const,
              position: i,
            }))
          )
        }

        if (collectionId) {
          try { addItemToCollection(Number(collectionId), saved.id) } catch { /* ok */ }
        }

        if (item.keywords.length) {
          setTagsForItem(saved.id, item.keywords)
        }

        if (item.pdf_url) {
          addAttachmentFromUrl(saved.id, item.pdf_url).then((att) => {
            if (att?.path) autoConvertPdfToMd(saved.id, att.path)
          }).catch(() => {})
        }

        return json(res, 201, { success: true, item: saved })
      }

      json(res, 404, { error: 'not found', url })
    } catch (err) {
      console.error('[server] error:', err)
      json(res, 500, { error: String(err) })
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Veridian] Port ${PORT} already in use — server disabled`)
    } else {
      console.error('[Veridian] Server error:', err)
    }
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Veridian] Server listening on http://127.0.0.1:${PORT}`)
  })
}

export function stopLocalServer(): void {
  server?.close()
  server = null
}
