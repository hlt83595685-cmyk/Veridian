// Veridian Connector — content script
// Strategy: extract DOI / title from page, let the server do CrossRef enrichment
;(function () {
  'use strict'

  // ── DOI extraction ──────────────────────────────────────────────────────────
  // Finds the first valid DOI in a string
  function parseDoi(text) {
    if (!text) return null
    const m = text.match(/\b(10\.\d{4,9}\/[^\s"'<>()\[\]{}]+)/i)
    if (!m) return null
    return m[1].replace(/[.,;:)\]}>]+$/, '')
  }

  function extractDoi() {
    // 1. URL itself  e.g. https://doi.org/10.xxxx  or  ?doi=10.xxxx
    let doi = parseDoi(decodeURIComponent(location.href))
    if (doi) return doi

    // 2. Canonical / og:url meta
    const canonical = document.querySelector('link[rel="canonical"]')?.href
      || document.querySelector('meta[property="og:url"]')?.content
    doi = parseDoi(canonical)
    if (doi) return doi

    // 3. citation_doi / DC.identifier meta tags
    const metaNames = ['citation_doi','DC.identifier','dc.identifier','prism.doi']
    for (const name of metaNames) {
      const el = document.querySelector(`meta[name="${name}"],meta[property="${name}"]`)
      doi = parseDoi(el?.content)
      if (doi) return doi
    }

    // 4. Visible <a href> links containing doi.org
    for (const a of document.querySelectorAll('a[href*="doi.org/10."]')) {
      doi = parseDoi(a.href)
      if (doi) return doi
    }

    // 5. Scan first 5000 chars of body text
    doi = parseDoi(document.body?.innerText?.slice(0, 5000))
    return doi
  }

  // ── Title extraction ────────────────────────────────────────────────────────
  function extractTitle() {
    return (
      document.querySelector('meta[name="citation_title"]')?.content
      || document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector('h1.article-title,h1.title,.article-title,#article-title')?.textContent?.trim()
      || document.querySelector('h1')?.textContent?.trim()
      || document.title?.replace(/\s*[-|–].*$/, '').trim()
    ) || null
  }

  // ── PDF URL ─────────────────────────────────────────────────────────────────
  function extractPdfUrl() {
    // The tab navigated straight to a .pdf resource -- Chrome's built-in viewer renders
    // it with no <head>/<meta>/<a> markup at all (the "page" is just the PDF plugin's
    // shell), so the two lookups below always miss. document.contentType is the one
    // reliable signal that DOM exposes for this case; the PDF is simply the tab's own URL.
    if (document.contentType === 'application/pdf') return location.href

    return (
      document.querySelector('meta[name="citation_pdf_url"]')?.content
      || document.querySelector('a[href$=".pdf"]')?.href
      // Same idea, but the link carries a query string after ".pdf" (e.g. "?download=1").
      || document.querySelector('a[href*=".pdf?"]')?.href
      || null
    )
  }

  // ── Authors (best-effort from meta only — CrossRef will fill this anyway) ──
  function extractAuthors() {
    const tags = [...document.querySelectorAll('meta[name="citation_author"]')]
    return tags.map(el => {
      const parts = (el.content || '').split(',').map(s => s.trim())
      return { last_name: parts[0] || '', first_name: parts[1] || null }
    }).filter(a => a.last_name)
  }

  // ── Main ────────────────────────────────────────────────────────────────────
  function extract() {
    return {
      doi:      extractDoi(),
      title:    extractTitle(),
      pdf_url:  extractPdfUrl(),
      authors:  extractAuthors(),
      page_url: location.href,
    }
  }

  // ── Authenticated PDF fetch ─────────────────────────────────────────────────
  // Some publishers (Elsevier/ScienceDirect and others) gate the PDF behind the
  // reader's own login/institutional-proxy session. The desktop app's own download
  // (background.js's apiPost -> server/index.ts) runs from a separate network stack
  // with none of that, so it gets a 403/login page even when this exact tab, right
  // now, can see the PDF fine. This tab's own fetch() carries the same cookies the
  // page itself uses, so it succeeds where the app's own request can't.
  //
  // The bytes are handed back to background.js rather than POSTed to the desktop app
  // directly from here: a content script's fetch() is attributed to the PAGE's own
  // origin (https://www.sciencedirect.com, not chrome-extension://...), and the
  // server's CORS check only allows the extension's origin -- background.js's own
  // fetch calls are unambiguously extension-origin, exactly like every other call it
  // already makes to this same server.
  const MAX_PDF_BYTES = 50 * 1024 * 1024

  async function fetchPdfBytes(pdfUrl) {
    const pdfResp = await fetch(pdfUrl, { credentials: 'include' })
    if (!pdfResp.ok) return { ok: false, error: `PDF fetch failed: HTTP ${pdfResp.status}` }
    const buf = await pdfResp.arrayBuffer()
    if (buf.byteLength < 1024 || buf.byteLength > MAX_PDF_BYTES) {
      return { ok: false, error: `downloaded size ${buf.byteLength} out of bounds` }
    }
    const head = new Uint8Array(buf, 0, 5)
    if (String.fromCharCode(...head) !== '%PDF-') {
      // The usual shape of a paywall: a 200 OK with a login/error HTML page instead of the PDF.
      // Echo enough to actually tell which -- status/content-type plus a text preview of the
      // body -- rather than just "not a PDF", so the next failure is diagnosable from one log.
      const contentType = pdfResp.headers.get('content-type')
      const preview = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 300))
      return {
        ok: false,
        error: `downloaded content is not a PDF: HTTP ${pdfResp.status}, content-type=${contentType}, ` +
          `redirected=${pdfResp.redirected}, finalUrl=${pdfResp.url}, first bytes: ${JSON.stringify(preview)}`,
      }
    }
    return { ok: true, buf }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT') {
      sendResponse({ ok: true, data: extract() })
      return true
    }
    if (msg.type === 'FETCH_PDF_BYTES') {
      fetchPdfBytes(msg.pdfUrl)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }))
      return true // keep the message channel open for the async response
    }
    return true
  })
})()
