// Veridian Connector — service worker
'use strict'

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
    signal: AbortSignal.timeout(15000),
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
          if (!raw) { sendResponse({ ok: false, error: 'extraction failed' }); break }

          // 2. ask server to enrich via CrossRef and return preview (don't save yet)
          const preview = await apiPost('/preview', {
            doi:     raw.doi,
            title:   raw.title,
            pdf_url: raw.pdf_url,
            authors: raw.authors,
            url:     raw.page_url,
          })
          sendResponse({ ok: true, data: preview, raw })
          break
        }

        case 'SAVE': {
          const result = await apiPost('/save', msg.payload)
          sendResponse({ ok: true, item: result.item })
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
