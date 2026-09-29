// Veridian Connector — service worker
'use strict'

// Fires once each time this service worker (re)starts -- confirms in the console that the
// worker actually reloaded this file (and which version), since MV3 workers restart silently
// and stale-cached code is a common source of "I reloaded but nothing changed" confusion.
console.log('[Veridian] background.js starting, version', chrome.runtime.getManifest().version)

const API = 'http://127.0.0.1:23120'

async function apiGet(path) {
  const r = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function apiPost(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // /preview and /save can now download + parse the PDF itself when the page had no
    // DOI/title to work with (see DEVLOG 2026-09-29); 15s was too tight a ceiling for that.
    signal: AbortSignal.timeout(25000),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`HTTP ${r.status}: ${txt}`)
  }
  return r.json()
}

// Fallback for when content.js's DOM-based extractPdfUrl() found nothing: ask the server
// what the URL actually is. Covers a tab navigated straight to a PDF resource -- Chrome's
// built-in viewer wraps it in its own HTML/JS/shadow-DOM UI (no <meta>, no <a>, no <embed>
// reachable via plain querySelector, and document.contentType still reports 'text/html'),
// so there is no reliable DOM signal to sniff. This also catches PDF URLs with no ".pdf" in
// them at all (e.g. arXiv's https://arxiv.org/pdf/<id>), which no DOM heuristic would ever
// have matched anyway.
async function sniffPdfContentType(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
  const type = r.headers.get('content-type') || ''
  return type.toLowerCase().startsWith('application/pdf') ? url : null
}

// Inject content script and extract page data
async function extractFromTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  })
  const raw = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXTRACT' }, (resp) => {
      resolve(resp?.data ?? null)
    })
  })
  if (raw && !raw.pdf_url) {
    raw.pdf_url = await sniffPdfContentType(raw.page_url).catch(() => null)
  }
  return raw
}

// Asks the active tab's already-injected content script to fetch the PDF itself (with the
// page's own cookies -- see content.js's FETCH_PDF_BYTES) and, if that produced real PDF
// bytes, uploads them to the desktop app. Entirely fire-and-forget: failures are only logged,
// never surfaced to the popup, which has already shown "saved" by the time this runs.
async function attachPdfViaTab(itemId, pdfUrl) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) { console.log('[Veridian] attachPdfViaTab: no active tab'); return }
  chrome.tabs.sendMessage(tab.id, { type: 'FETCH_PDF_BYTES', pdfUrl }, (resp) => {
    // chrome.runtime.lastError fires if content.js isn't there to answer (e.g. the tab
    // navigated away) -- reading it here is required, or Chrome logs "Unchecked
    // runtime.lastError" on every ordinary success too.
    const lastError = chrome.runtime.lastError?.message
    if (lastError) { console.log('[Veridian] FETCH_PDF_BYTES messaging error:', lastError); return }
    if (!resp?.ok) { console.log('[Veridian] FETCH_PDF_BYTES failed:', resp?.error); return }
    fetch(`${API}/attach-pdf?itemId=${encodeURIComponent(itemId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: resp.buf,
      signal: AbortSignal.timeout(15000),
    })
      .then((r) => console.log('[Veridian] /attach-pdf response:', r.status))
      .catch((err) => console.log('[Veridian] /attach-pdf request failed:', err.message))
  })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[Veridian] onMessage:', msg.type)
  ;(async () => {
    try {
      switch (msg.type) {

        case 'PING': {
          const data = await apiGet('/ping').catch(() => null)
          sendResponse({ online: !!data })
          break
        }

        case 'GET_COLLECTIONS': {
          const data = await apiGet('/collections').catch(() => ({ collections: [] }))
          sendResponse({ collections: data.collections ?? [] })
          break
        }

        case 'EXTRACT_AND_PREVIEW': {
          // 1. extract raw data from page
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          if (!tab?.id) { sendResponse({ ok: false, error: 'no tab' }); break }

          const raw = await extractFromTab(tab.id)
          console.log('[Veridian] extracted from page:', raw)
          if (!raw) { sendResponse({ ok: false, error: 'extraction failed' }); break }

          // 2. ask server to enrich via CrossRef and return preview (don't save yet)
          let preview
          try {
            preview = await apiPost('/preview', {
              doi:     raw.doi,
              title:   raw.title,
              pdf_url: raw.pdf_url,
              authors: raw.authors,
              url:     raw.page_url,
            })
          } catch (err) {
            console.log('[Veridian] /preview request failed:', err.message)
            throw err
          }
          console.log('[Veridian] /preview responded:', preview)
          sendResponse({ ok: true, data: preview, raw })
          break
        }

        case 'SAVE': {
          const result = await apiPost('/save', msg.payload)
          sendResponse({ ok: true, item: result.item })
          // Fire-and-forget, same as the app's own PDF download: the save itself already
          // succeeded, so this must not hold up (or be able to fail) the response to the
          // popup. The desktop app's own attempt, made from inside this same /save call,
          // has already run by now and simply had no cookies to use against a paywalled
          // publisher -- so this is a genuinely separate attempt, not a duplicate of that
          // one, and only the extension can supply the tab's own session for it.
          if (result.item?.id && msg.payload.pdf_url) attachPdfViaTab(result.item.id, msg.payload.pdf_url)
          break
        }

        default:
          sendResponse({ ok: false, error: 'unknown message' })
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message })
    }
  })()
  return true
})
