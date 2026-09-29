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
