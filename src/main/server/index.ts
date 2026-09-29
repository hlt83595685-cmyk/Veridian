import http from 'http'
import { net } from 'electron'
import { createItem } from '../services/ItemService'
import { findItemByDoi } from '../db/items'
import { setCreatorsForItem } from '../services/CreatorService'
import { getAllCollections } from '../db/collections'
import { addItemToCollection } from '../services/CollectionService'
import { addAttachmentFromUrl, listByItem } from '../services/AttachmentService'
import { fetchCrossRefByDoi, searchCrossRefByTitle, CROSSREF_TYPE_MAP } from '../crossref'
import { setTagsForItem } from '../services/TagService'
import { autoConvertPdfToMd } from '../services/ConversionService'
import { emit } from '../core/Notifier'
import { getActiveWorkspace } from '../services/WorkspaceContextService'
import { getWorkspace } from '../services/LocalWorkspaceService'
import { extractPdfTextFromBuffer, extractDoi as extractDoiFromPdfText, parseLocalMeta } from '../pdfImporter'

// 23120, NOT 23119: 23119 is Zotero's connector port -- squatting on it makes
// the two apps silently steal each other's browser-extension traffic.
const PORT = 23120
const MAX_BODY_BYTES = 1024 * 1024
const MAX_PDF_BYTES = 50 * 1024 * 1024
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

// Downloads a PDF purely to read its text (no attachment/DB write -- this may run at
// /preview time, before the user has decided to save anything, and /save's own
// addAttachmentFromUrl() does the real, persisted download separately). Same size cap and
// magic-byte check as db/attachments.ts's addAttachmentFromUrl, deliberately not shared
// since that one also owns file placement + DB rows, which don't apply here.
async function downloadAndExtractPdfText(pdfUrl: string): Promise<string | null> {
  const resp = await net.fetch(pdfUrl, { signal: AbortSignal.timeout(12000) })
  if (!resp.ok) return null
  const declared = Number(resp.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) return null
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length < 1024 || buf.length > MAX_PDF_BYTES) return null
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return null
  return extractPdfTextFromBuffer(buf)
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

  // The extension found neither a DOI nor a title on the page -- typical when the browser
  // tab is a raw PDF URL rather than an HTML landing page (Chrome's built-in viewer exposes
  // no <meta>/<a> markup to scrape; see DEVLOG 2026-09-29). Fall back to the PDF's own
  // content, the same way a locally-imported PDF is handled in pdfImporter.ts's importPDF().
  if (!title && pdf_url) {
    const text = await downloadAndExtractPdfText(pdf_url).catch(() => null)
    if (text) {
      const pdfDoi = extractDoiFromPdfText(text)
      if (pdfDoi && !doi) {
        try { apply(await fetchCrossRefByDoi(pdfDoi)) } catch { /* non-fatal */ }
      }
      if (!title) {
        const local = parseLocalMeta(text, pdf_url)
        if (!doi && local.title) {
          try { apply(await searchCrossRefByTitle(local.title)) } catch { /* non-fatal */ }
        }
        // Still nothing from CrossRef (preprint, no match, or the lookup itself failed) --
        // the heuristic title/abstract/year straight from the PDF beats no title at all.
        title    = title    || local.title
        abstract = abstract || local.abstract
        year     = year     || local.year
      }
      if (pdfDoi && !doi) doi = pdfDoi
    }
  }

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
      // GET /ping -- also reports which library the extension is about to
      // save into. Raw kind/name only: the main process doesn't choose the
      // extension's display language, that's the extension's job.
      if (req.method === 'GET' && url === '/ping') {
        const ctx = getActiveWorkspace()
        const workspace = ctx.id === null
          ? { kind: 'personal' as const, name: null }
          : { kind: ctx.kind, name: getWorkspace(ctx.id)?.name ?? null }
        return json(res, 200, { ok: true, app: 'Veridian', workspace }, cors)
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
        console.log(`[server] POST /save: doi=${body.doi} title=${JSON.stringify(body.title)} pdf_url=${body.pdf_url}`)
        const { collectionId, ...rest } = body
        const item = await enrich(rest)

        // Dedup: the library already has this DOI -- don't create a second
        // item (and a second papers/<key> dir in synced workspaces). Saving
        // the same page twice from the extension is the most common path here.
        if (item.doi) {
          const existing = findItemByDoi(item.doi)
          if (existing) {
            console.log(`[server] /save: duplicate DOI ${item.doi} -> reusing item ${existing.id}`)
            if (collectionId) {
              try { addItemToCollection(Number(collectionId), existing.id) } catch { /* ok */ }
            }
            // Same rule as pdfImporter.ts's mergeIntoExisting(): a DOI hit on an item that
            // still has no PDF attaches this one instead of doing nothing forever. Without
            // this, an item saved once (e.g. before the PDF was reachable) could never pick
            // one up on a later save, even from a page that now has it.
            if (item.pdf_url && !listByItem(existing.id).some((a) => a.type === 'pdf')) {
              addAttachmentFromUrl(existing.id, item.pdf_url).then((att) => {
                if (att?.path) autoConvertPdfToMd(existing.id, att.path)
                else console.warn(`[server] /save: duplicate-merge PDF attach failed for item ${existing.id} (${item.pdf_url})`)
              }).catch((err) => {
                console.error(`[server] /save: duplicate-merge PDF attach threw for item ${existing.id} (${item.pdf_url}):`, err)
              })
            }
            return json(res, 200, { success: true, duplicated: true, item: existing }, cors)
          }
        }

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

        console.log(`[server] /save: created item ${saved.id}, pdf_url=${item.pdf_url}`)
        if (item.pdf_url) {
          // Fire-and-forget: the item is already saved, so a failed PDF download must not
          // fail the save response. It must still be LOGGED, though -- addAttachmentFromUrl
          // itself now logs why (see db/attachments.ts), but nothing here said this even
          // happened, so "item saved, no PDF" was indistinguishable from "nobody tried".
          addAttachmentFromUrl(saved.id, item.pdf_url).then((att) => {
            if (att?.path) autoConvertPdfToMd(saved.id, att.path)
            else console.warn(`[server] /save: no PDF attached for item ${saved.id} (${item.pdf_url})`)
          }).catch((err) => {
            console.error(`[server] /save: PDF attach threw for item ${saved.id} (${item.pdf_url}):`, err)
          })
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
