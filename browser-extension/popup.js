'use strict'
;(async () => {
  const $ = id => document.getElementById(id)
  const body = $('mainBody')
  const statusDot = $('statusDot')
  const statusLabel = $('statusLabel')
  const langBtn = $('langBtn')

  // ── i18n ──────────────────────────────────────────────────────────────────
  // Extension-local translations (kept separate from the desktop app's
  // i18next setup -- this is a plain unbundled script, no module loader).
  // Manually toggled in-popup (not chrome.i18n's browser-language-follow),
  // preference persisted in chrome.storage.local since the popup's DOM (and
  // any in-memory state) is torn down every time it closes. Default: English.
  const LANG_KEY = 'veridian_lang'

  const STRINGS = {
    en: {
      connecting: 'Connecting...',
      connected: 'Veridian connected',
      offline: 'Veridian not running',
      needsApp: 'Please start the Veridian desktop app (port 23120)',
      extractingPage: 'Extracting page info...',
      extractingMeta: 'Extracting and looking up metadata...',
      noMetadata: 'Could not recognize reference info on this page. Works best on academic pages with a DOI.',
      savingTo: 'Saving to',
      personalLibrary: 'Personal Library',
      typeLabel: 'Type', yearLabel: 'Year', journalLabel: 'Journal',
      volumeIssueLabel: 'Vol/Issue', pagesLabel: 'Pages', doiLabel: 'DOI', pdfLabel: 'PDF',
      pdfDetected: 'Detected -- will download on save',
      saveToCollection: 'Save to collection',
      allItems: 'All Items',
      saveButton: 'Save to Veridian',
      saving: 'Saving...',
      savedTitle: 'Saved to Veridian',
      saveFailed: 'Save failed, please retry',
      andMore: n => ` and ${n} more`,
      types: {
        journalArticle: 'Journal Article', book: 'Book', thesis: 'Thesis',
        conferencePaper: 'Conference Paper', preprint: 'Preprint', report: 'Report',
        bookSection: 'Book Section', webpage: 'Webpage',
      },
    },
    zh: {
      connecting: '连接中...',
      connected: 'Veridian 已连接',
      offline: 'Veridian 未运行',
      needsApp: '请先启动 Veridian 桌面应用（端口 23120）',
      extractingPage: '正在提取页面信息...',
      extractingMeta: '正在提取并查询元数据...',
      noMetadata: '未能识别该页面的文献信息，支持含 DOI 的学术页面',
      savingTo: '保存到',
      personalLibrary: '个人库',
      typeLabel: '类型', yearLabel: '年份', journalLabel: '期刊',
      volumeIssueLabel: '卷/期', pagesLabel: '页码', doiLabel: 'DOI', pdfLabel: 'PDF',
      pdfDetected: '已检测到，保存时自动下载',
      saveToCollection: '保存到分类',
      allItems: '全部文献',
      saveButton: '保存到 Veridian',
      saving: '保存中...',
      savedTitle: '已保存到 Veridian',
      saveFailed: '保存失败，请重试',
      andMore: n => ` 等 ${n} 人`,
      types: {
        journalArticle: '期刊论文', book: '书籍', thesis: '学位论文',
        conferencePaper: '会议论文', preprint: '预印本', report: '报告',
        bookSection: '书章节', webpage: '网页',
      },
    },
  }

  async function getLang() {
    const stored = await chrome.storage.local.get(LANG_KEY)
    return stored[LANG_KEY] === 'zh' ? 'zh' : 'en'
  }

  const lang = await getLang()
  const S = STRINGS[lang]
  langBtn.textContent = lang === 'en' ? '中文' : 'EN'
  langBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ [LANG_KEY]: lang === 'en' ? 'zh' : 'en' })
    location.reload()
  })

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  }

  function send(type, extra = {}) {
    return new Promise(resolve =>
      chrome.runtime.sendMessage({ type, ...extra }, resolve)
    )
  }

  function setStatus(online) {
    statusDot.className = 'status-dot ' + (online ? 'online' : 'offline')
    statusLabel.textContent = online ? S.connected : S.offline
  }

  function showError(msg) {
    body.innerHTML = `
      <div class="empty-state">
        <span class="icon">⚠️</span>
        <p>${esc(msg)}</p>
      </div>`
  }

  function metaRow(label, value, cls = '') {
    if (!value && value !== 0) return ''
    return `<div class="meta-row">
      <span class="meta-label">${esc(label)}</span>
      <span class="meta-value ${cls}">${esc(String(value))}</span>
    </div>`
  }

  // ── 0. Localize the initial loading state ────────────────────────────────
  statusLabel.textContent = S.connecting
  body.innerHTML = `<div class="empty-state">
    <span class="spinner blue"></span>
    <p style="margin-top:10px;color:#8e8e93">${esc(S.extractingPage)}</p>
  </div>`

  // ── 1. Ping ────────────────────────────────────────────────────────────────
  const ping = await send('PING')
  setStatus(ping?.online)
  if (!ping?.online) {
    showError(S.needsApp)
    return
  }

  // Which library the save is about to land in -- surfaced read-only so a
  // collaborative-workspace switch made in the desktop app doesn't silently
  // catch the user off guard. workspace comes straight from /ping's raw
  // kind/name; the extension picks the localized label, not the main process.
  const workspaceName = ping.workspace?.name ?? S.personalLibrary
  const wsRow = `<div style="font-size:11px;color:#8e8e93;padding:0 2px 2px;">
    ${esc(S.savingTo)}: <strong style="color:#3a3a3c">${esc(workspaceName)}</strong>
  </div>`

  // ── 2. Extract + preview via server ────────────────────────────────────────
  body.innerHTML = `<div class="empty-state">
    <span class="spinner blue"></span>
    <p style="margin-top:10px;color:#8e8e93">${esc(S.extractingMeta)}</p>
  </div>`

  const exResp = await send('EXTRACT_AND_PREVIEW')

  if (!exResp?.ok || !exResp.data?.title) {
    showError(exResp?.error ?? S.noMetadata)
    return
  }

  const meta = exResp.data   // enriched by server CrossRef

  // ── 3. Load collections ────────────────────────────────────────────────────
  const colResp = await send('GET_COLLECTIONS')
  const cols = colResp?.collections ?? []

  // ── 4. Render preview ──────────────────────────────────────────────────────
  const authorStr = (meta.authors ?? []).slice(0, 6)
    .map(a => [a.first_name, a.last_name].filter(Boolean).join(' '))
    .join('; ') + ((meta.authors?.length ?? 0) > 6 ? S.andMore(meta.authors.length - 6) : '')

  const colOptions = cols.length
    ? `<p class="section-label">${esc(S.saveToCollection)}</p>
       <select id="colSel">
         <option value="">📚 ${esc(S.allItems)}</option>
         ${cols.map(c => `<option value="${c.id}">📁 ${esc(c.name)}</option>`).join('')}
       </select>`
    : ''

  body.innerHTML = `
    ${wsRow}
    <div class="card">
      <div class="meta-title">${esc(meta.title)}</div>
      <div class="meta-rows">
        ${metaRow(S.typeLabel, S.types[meta.type] ?? meta.type)}
        ${metaRow(S.yearLabel, meta.year)}
        ${metaRow(S.journalLabel, meta.journal)}
        ${metaRow(S.volumeIssueLabel, [meta.volume, meta.issue].filter(Boolean).join(' / ') || null)}
        ${metaRow(S.pagesLabel, meta.pages)}
        ${metaRow(S.doiLabel, meta.doi, 'doi')}
      </div>
      ${authorStr ? `<div class="authors">${esc(authorStr)}</div>` : ''}
      ${meta.pdf_url ? `<div class="meta-row"><span class="meta-label">${esc(S.pdfLabel)}</span><span class="meta-value" style="color:#34c759">${esc(S.pdfDetected)}</span></div>` : ''}
    </div>
    ${colOptions}
    <div id="errMsg" class="error-msg" style="display:none"></div>
    <button id="saveBtn" class="btn btn-primary">${esc(S.saveButton)}</button>
  `

  // ── 5. Save ────────────────────────────────────────────────────────────────
  $('saveBtn').addEventListener('click', async () => {
    const btn = $('saveBtn')
    const err = $('errMsg')
    btn.disabled = true
    btn.innerHTML = `<span class="spinner"></span>${esc(S.saving)}`
    err.style.display = 'none'

    const collectionId = $('colSel')?.value ? parseInt($('colSel').value, 10) : null

    const resp = await send('SAVE', {
      payload: {
        type:      meta.type,
        title:     meta.title,
        abstract:  meta.abstract,
        year:      meta.year,
        doi:       meta.doi,
        url:       meta.url,
        journal:   meta.journal,
        publisher: meta.publisher,
        volume:    meta.volume,
        issue:     meta.issue,
        pages:     meta.pages,
        isbn:      meta.isbn,
        language:  meta.language,
        authors:   meta.authors ?? [],
        pdf_url:   meta.pdf_url,
        collectionId,
      }
    })

    if (resp?.ok) {
      body.innerHTML = `
        <div class="success-state">
          <span class="icon">✅</span>
          <p>${esc(S.savedTitle)}</p>
          <p style="font-size:12px;font-weight:400;color:#34c759;margin-top:4px">
            ${esc((meta.title ?? '').slice(0, 60))}
          </p>
        </div>`
    } else {
      btn.disabled = false
      btn.textContent = S.saveButton
      err.textContent = resp?.error ?? S.saveFailed
      err.style.display = 'block'
    }
  })
})()
