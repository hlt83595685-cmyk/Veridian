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
    return (
      document.querySelector('meta[name="citation_pdf_url"]')?.content
      || document.querySelector('a[href$=".pdf"]')?.href
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT') {
      sendResponse({ ok: true, data: extract() })
    }
    return true
  })
})()
