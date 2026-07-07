'use strict'
;(async () => {
  const $ = id => document.getElementById(id)
  const body = $('mainBody')
  const statusDot = $('statusDot')
  const statusLabel = $('statusLabel')

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
    statusLabel.textContent = online ? 'Veridian 已连接' : 'Veridian 未运行'
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

  // ── 1. Ping ────────────────────────────────────────────────────────────────
  const ping = await send('PING')
  setStatus(ping?.online)
  if (!ping?.online) {
    showError('请先启动 Veridian 桌面应用（端口 23119）')
    return
  }

  // ── 2. Extract + preview via server ────────────────────────────────────────
  body.innerHTML = `<div class="empty-state">
    <span class="spinner blue"></span>
    <p style="margin-top:10px;color:#8e8e93">正在提取并查询元数据...</p>
  </div>`

  const exResp = await send('EXTRACT_AND_PREVIEW')

  if (!exResp?.ok || !exResp.data?.title) {
    showError(exResp?.error ?? '未能识别该页面的文献信息\n支持含 DOI 的学术页面')
    return
  }

  const meta = exResp.data   // enriched by server CrossRef

  // ── 3. Load collections ────────────────────────────────────────────────────
  const colResp = await send('GET_COLLECTIONS')
  const cols = colResp?.collections ?? []

  // ── 4. Render preview ──────────────────────────────────────────────────────
  const typeMap = {
    journalArticle:'期刊论文', book:'书籍', thesis:'学位论文',
    conferencePaper:'会议论文', preprint:'预印本', report:'报告',
    bookSection:'书章节', webpage:'网页',
  }

  const authorStr = (meta.authors ?? []).slice(0, 6)
    .map(a => [a.first_name, a.last_name].filter(Boolean).join(' '))
    .join('; ') + ((meta.authors?.length ?? 0) > 6 ? ` 等 ${meta.authors.length} 人` : '')

  const colOptions = cols.length
    ? `<p class="section-label">保存到分类</p>
       <select id="colSel">
         <option value="">📚 全部文献</option>
         ${cols.map(c => `<option value="${c.id}">📁 ${esc(c.name)}</option>`).join('')}
       </select>`
    : ''

  body.innerHTML = `
    <div class="card">
      <div class="meta-title">${esc(meta.title)}</div>
      <div class="meta-rows">
        ${metaRow('类型', typeMap[meta.type] ?? meta.type)}
        ${metaRow('年份', meta.year)}
        ${metaRow('期刊', meta.journal)}
        ${metaRow('卷/期', [meta.volume, meta.issue].filter(Boolean).join(' / ') || null)}
        ${metaRow('页码', meta.pages)}
        ${metaRow('DOI',  meta.doi, 'doi')}
      </div>
      ${authorStr ? `<div class="authors">${esc(authorStr)}</div>` : ''}
      ${meta.pdf_url ? `<div class="meta-row"><span class="meta-label">PDF</span><span class="meta-value" style="color:#34c759">已检测到，保存时自动下载</span></div>` : ''}
    </div>
    ${colOptions}
    <div id="errMsg" class="error-msg" style="display:none"></div>
    <button id="saveBtn" class="btn btn-primary">保存到 Veridian</button>
  `

  // ── 5. Save ────────────────────────────────────────────────────────────────
  $('saveBtn').addEventListener('click', async () => {
    const btn = $('saveBtn')
    const err = $('errMsg')
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span>保存中...'
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
          <p>已保存到 Veridian</p>
          <p style="font-size:12px;font-weight:400;color:#34c759;margin-top:4px">
            ${esc((meta.title ?? '').slice(0, 60))}
          </p>
        </div>`
    } else {
      btn.disabled = false
      btn.textContent = '保存到 Veridian'
      err.textContent = resp?.error ?? '保存失败，请重试'
      err.style.display = 'block'
    }
  })
})()
