import http from 'http'
import { createItem } from '../services/ItemService'
import { setCreatorsForItem } from '../services/CreatorService'
import { getAllCollections } from '../db/collections'
import { addItemToCollection } from '../services/CollectionService'
import { addAttachmentFromUrl } from '../services/AttachmentService'
import { fetchCrossRefByDoi, searchCrossRefByTitle, CROSSREF_TYPE_MAP } from '../crossref'
import { setTagsForItem } from '../services/TagService'
import { autoConvertPdfToMd } from '../services/ConversionService'
import { emit } from '../core/Notifier'

// 23120, NOT 23119: 23119 is Zotero's connector port -- squatting on it makes
// the two apps silently steal each other's browser-extension traffic.
const PORT = 23120
const MAX_BODY_BYTES = 1024 * 1024
let server: http.Server | null = null

// Any web page can fetch() 127.0.0.1, so the Origin header is the only thing
// separating our browser extension (chrome-extension://...) from a drive-by
// website (http/https origin). Extension origins get CORS headers echoed back;
// web origins are rejected outright; no Origin (curl, native) passes through.
function corsFor(req: http.IncomingMessage): Record<string, string> | 'forbidden' {
  const origin = req.headers.origin
  if (!origin) return {}
  if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    }
  }
  return 'forbidden'
}

function json(
  res: http.ServerResponse, status: number, data: unknown,
  cors: Record<string, string> = {}
): void {
  // The oversized-body path destroys the socket mid-request; writing the 413
  // to a dead connection must not throw into the request handler.
  if (res.destroyed || res.headersSent) return
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('body_too_large'))
      }
    })
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
    year:      year && Number.isFinite(Number(year)) ? Number(year) : null,
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
    const cors = corsFor(req)
    if (cors === 'forbidden') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'origin not allowed' }))
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }

    const url = (req.url ?? '/').split('?')[0]

    try {
      // GET /ping
      if (req.method === 'GET' && url === '/ping') {
        return json(res, 200, { ok: true, app: 'Veridian' }, cors)
      }

      // GET /collections
      if (req.method === 'GET' && url === '/collections') {
        return json(res, 200, { collections: getAllCollections() }, cors)
      }

      // POST /preview — CrossRef lookup, return enriched metadata (no save)
      if (req.method === 'POST' && url === '/preview') {
        const body = JSON.parse(await readBody(req))
        const item = await enrich(body)
        return json(res, 200, item, cors)
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

        return json(res, 201, { success: true, item: saved }, cors)
      }

      json(res, 404, { error: 'not found', url }, cors)
    } catch (err) {
      console.error('[server] error:', err)
      const tooLarge = err instanceof Error && err.message === 'body_too_large'
      json(res, tooLarge ? 413 : 500, { error: tooLarge ? 'body too large' : String(err) }, cors)
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Veridian] Port ${PORT} already in use — server disabled`)
      // Surface in the status bar instead of failing silently -- delayed so
      // the BrowserWindow exists by the time the event is broadcast.
      setTimeout(() => emit({
        type: 'job.progress',
        job: {
          id: 'local-server', type: 'server', label: 'Connector',
          state: 'error', message: `端口 ${PORT} 被占用，浏览器扩展连接器不可用`, pending: 0,
        },
      }), 3000)
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
