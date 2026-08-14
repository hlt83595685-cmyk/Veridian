import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'fs'
import { basename, join, dirname, sep } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { PDFDocument } from 'pdf-lib'
import AdmZip from 'adm-zip'
import { Agent } from 'undici'
import { planChunkMerge } from './services/mergeChunks'

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_BASE    = 'https://mineru.net/api/v1/agent/parse'
const PRECISION_BASE = 'https://mineru.net/api/v4'

// Max pages per MinerU Agent API request
const MAX_PAGES_PER_CHUNK = 20

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MinerUProgress {
  state: 'pending' | 'running' | 'done' | 'failed'
  message?: string
  chunk?: string
  // 0..1 completion estimate. Chunked (sequential) modes report real fraction
  // from chunk index; single-file / parallel-batch modes step through coarse
  // phase weights. Absent means "no estimate" -> the status bar goes
  // indeterminate. See the phase weights inline at each call site.
  progress?: number
}

// ── Network helpers ─────────────────────────────────────────────────────────
// MinerU work is network-heavy and flaky in practice: OSS pre-signed uploads of
// large PDFs and slow VLM result downloads routinely exceed undici's default
// ~300s header/body timeouts, and the connection to mineru.net / Aliyun OSS can
// drop mid-transfer. Combined with pdf2md's maxAttempts:1, a single hiccup
// aborted the whole conversion -- the main cause of low success rates. Every
// call below goes through longFetch (generous, bounded timeouts) + withRetry
// (backoff on transient network / 5xx errors).

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Dedicated dispatcher: 10-min header/body windows (vs. the ~300s default) so a
// slow upload/download isn't killed prematurely, but still bounded so a truly
// dead connection can't hang a job forever. Scoped to these calls via the
// per-request `dispatcher` option -- NOT setGlobalDispatcher -- so CrossRef /
// GitHub fetches keep their normal (shorter) timeouts.
const netDispatcher = new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
  connect: { timeout: 30_000 },
})

// Node's global fetch types omit undici's `dispatcher`; pass it through a cast.
function longFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const opts = { ...options, dispatcher: netDispatcher }
  return fetch(url, opts as RequestInit)
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (/HTTP (429|5\d\d)/.test(err.message)) return true
  if (/timeout/i.test(err.message)) return true
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true
  const cause = (err as { cause?: { code?: string } }).cause
  const code = cause?.code ?? (err as { code?: string }).code
  return typeof code === 'string' && (
    code.startsWith('UND_ERR') || code.startsWith('ECONN') ||
    code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
  )
}

// How long a transient failure may keep recurring, back-to-back, before we give
// up. A brief interruption that recovers on any retry resets nothing here
// because success returns immediately -- so the job is judged failed ONLY when
// the transfer stays broken continuously for this long. A recovered blip never
// fails the conversion.
const MAX_CONTINUOUS_FAILURE_MS = 180_000  // 3 min of unbroken failure

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  budgetMs = MAX_CONTINUOUS_FAILURE_MS
): Promise<T> {
  let attempt = 0
  let firstFailureAt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      const now = Date.now()
      if (firstFailureAt === 0) firstFailureAt = now
      const continuousMs = now - firstFailureAt
      // Non-retryable (auth/4xx/logic) fails immediately; a retryable error
      // fails only once it has been continuous past the budget.
      if (!isRetryable(err) || continuousMs >= budgetMs) throw err
      const backoff = Math.min(15_000, 1000 * 2 ** Math.min(attempt - 1, 4))
      console.warn(
        `[mineru] ${label} 第 ${attempt} 次失败（${(err as Error).message}）；` +
        `已连续中断 ${Math.round(continuousMs / 1000)}s / 上限 ${budgetMs / 1000}s，${backoff}ms 后重试`
      )
      await sleep(backoff)
    }
  }
}

async function fetchJson(url: string, options: RequestInit): Promise<unknown> {
  return withRetry(`请求 ${url}`, async () => {
    const resp = await longFetch(url, options)
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`HTTP ${resp.status}: ${text}`)
    }
    return resp.json()
  })
}

export interface UploadProgress { sent: number; total: number; speed: number } // bytes, bytes, bytes/s

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtSpeed(bytesPerSec: number): string {
  return `${fmtBytes(Math.max(0, bytesPerSec))}/s`
}

// PUT a file buffer to an OSS pre-signed URL, retried on transient failure.
// The body is streamed in fixed-size chunks so we can report upload progress +
// speed via onUpload. A stream body would default to chunked transfer-encoding,
// which OSS pre-signed PUTs reject -- so we set an explicit content-length,
// which makes undici send a normal fixed-length request (verified). The counted
// bytes reflect what's been handed to the socket, so they lead the true
// on-the-wire amount by at most one chunk (the queuing strategy's high-water
// mark). On a retry the stream is rebuilt and sent restarts from 0.
async function putFile(
  uploadUrl: string,
  body: Buffer,
  label: string,
  onUpload?: (p: UploadProgress) => void
): Promise<void> {
  const total = body.length
  const CHUNK = 256 * 1024
  await withRetry(`上传 ${label}`, async () => {
    let sent = 0
    let lastT = Date.now()
    let lastSent = 0
    const emit = (force: boolean): void => {
      if (!onUpload) return
      const now = Date.now()
      if (!force && now - lastT < 200) return
      const dt = now - lastT
      const speed = dt > 0 ? ((sent - lastSent) / dt) * 1000 : 0
      lastT = now
      lastSent = sent
      onUpload({ sent, total, speed })
    }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) { controller.close(); emit(true); return }
        const end = Math.min(sent + CHUNK, total)
        controller.enqueue(body.subarray(sent, end))
        sent = end
        emit(false)
      },
    }, new ByteLengthQueuingStrategy({ highWaterMark: CHUNK }))
    const init = {
      method: 'PUT', body: stream, duplex: 'half',
      headers: { 'content-length': String(total) },
    }
    const resp = await longFetch(uploadUrl, init as RequestInit)
    if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`)
  })
}

// GET a binary/text body, retried on transient failure.
async function getBuffer(url: string, label: string): Promise<Buffer> {
  return withRetry(`下载 ${label}`, async () => {
    const resp = await longFetch(url)
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`)
    return Buffer.from(await resp.arrayBuffer())
  })
}

// ── pdf-lib helpers ───────────────────────────────────────────────────────────

export async function getPdfPageCount(filePath: string): Promise<number> {
  const buf = readFileSync(filePath)
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true })
  return doc.getPageCount()
}

async function splitPdf(filePath: string, chunkSize: number, tmpDir: string): Promise<string[]> {
  const buf = readFileSync(filePath)
  const src = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = src.getPageCount()
  const chunks: string[] = []

  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(start + chunkSize, total)
    const chunk = await PDFDocument.create()
    const pages = await chunk.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i))
    pages.forEach((p) => chunk.addPage(p))
    const chunkBuf = await chunk.save()
    const stem = basename(filePath, '.pdf')
    const chunkPath = join(tmpDir, `${stem}_chunk${chunks.length + 1}.pdf`)
    writeFileSync(chunkPath, chunkBuf)
    chunks.push(chunkPath)
  }
  return chunks
}

// ═══════════════════════════════════════════════════════════════════════════════
// Agent API (free, no token required)
// ═══════════════════════════════════════════════════════════════════════════════

async function agentSubmitFile(
  filePath: string,
  onUpload?: (p: UploadProgress) => void
): Promise<string> {
  const fileName = basename(filePath)
  const sigResp = await fetchJson(`${AGENT_BASE}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, language: 'ch', enable_table: true, enable_formula: true }),
  }) as { code: number; data: { file_url: string; task_id: string }; msg: string }

  if (sigResp.code !== 0) throw new Error(`MinerU submit error: ${sigResp.msg}`)

  const { file_url, task_id } = sigResp.data
  await putFile(file_url, readFileSync(filePath), fileName, onUpload)
  return task_id
}

async function agentPollResult(taskId: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    await sleep(3000)
    const resp = await fetchJson(`${AGENT_BASE}/${taskId}`, { method: 'GET' }) as {
      code: number
      data: { state: string; markdown_url?: string; err_msg?: string }
    }
    if (resp.code !== 0) throw new Error(`Poll error: ${JSON.stringify(resp)}`)
    const { state, markdown_url, err_msg } = resp.data
    if (state === 'done') {
      if (!markdown_url) throw new Error('No markdown_url in response')
      return (await getBuffer(markdown_url, 'markdown')).toString('utf-8')
    }
    if (state === 'failed') throw new Error(`Task failed: ${err_msg ?? 'unknown'}`)
  }
  throw new Error('Timeout waiting for MinerU result (6 min)')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Precision API (requires Bearer token, outputs zip with full.md + images)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Step 1: POST /api/v4/file-urls/batch for one or more files.
 * Returns { batchId, uploadUrls } where each uploadUrl is an OSS pre-signed PUT
 * URL aligned to the input order. The batch endpoint automatically submits the
 * parse task once each file is uploaded.
 */
async function precisionBatchSubmit(
  fileNames: string[],
  token: string
): Promise<{ batchId: string; uploadUrls: string[] }> {
  const resp = await fetchJson(`${PRECISION_BASE}/file-urls/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      files: fileNames.map((name) => ({ name })),
      model_version: 'vlm',
      enable_formula: true,
      enable_table: true,
      language: 'ch',
    }),
  }) as {
    code: number
    msg: string
    data: { batch_id: string; file_urls: string[] }
  }
  if (resp.code !== 0) throw new Error(`MinerU batch submit error (${resp.code}): ${resp.msg}`)
  const uploadUrls = resp.data.file_urls
  if (!uploadUrls || uploadUrls.length !== fileNames.length) {
    throw new Error('MinerU 返回的上传地址数量与提交文件数不一致')
  }
  return { batchId: resp.data.batch_id, uploadUrls }
}

/** Step 2: PUT file to OSS pre-signed URL. Must NOT send Content-Type header. */
async function precisionUploadFile(
  filePath: string,
  uploadUrl: string,
  onUpload?: (p: UploadProgress) => void
): Promise<void> {
  await putFile(uploadUrl, readFileSync(filePath), basename(filePath), onUpload)
}

/** Step 3: Poll GET /api/v4/extract-results/batch/{batch_id} until all
 *  expectedCount files are done. Returns each file's zip URL; fails fast if any
 *  chunk failed. */
async function precisionPollBatch(
  batchId: string,
  token: string,
  expectedCount: number
): Promise<Array<{ fileName: string; zipUrl: string }>> {
  for (let i = 0; i < 240; i++) {
    await sleep(5000)
    const resp = await fetchJson(`${PRECISION_BASE}/extract-results/batch/${batchId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }) as {
      code: number; msg: string
      data: {
        batch_id: string
        extract_result: Array<{
          file_name: string
          state: string
          err_msg?: string
          full_zip_url?: string
        }>
      }
    }
    if (resp.code !== 0) throw new Error(`Precision poll error: ${JSON.stringify(resp)}`)
    const results = resp.data.extract_result ?? []
    const failed = results.find((r) => r.state === 'failed')
    if (failed) throw new Error(`Precision task failed (${failed.file_name}): ${failed.err_msg ?? 'unknown'}`)
    // Require the full set present before trusting an all-done check: entries can
    // appear incrementally, and every() over a partial set is misleading.
    if (results.length === expectedCount && results.every((r) => r.state === 'done')) {
      return results.map((r) => {
        if (!r.full_zip_url) throw new Error(`No full_zip_url for ${r.file_name}`)
        return { fileName: r.file_name, zipUrl: r.full_zip_url }
      })
    }
    // states: waiting-file, pending, running, converting — keep polling
  }
  throw new Error('Timeout waiting for MinerU precision result (20 min)')
}

/**
 * Step 5: Download zip, extract full.md and images into outputDir.
 * Returns the path to full.md.
 */
async function precisionExtractZip(
  zipUrl: string,
  outputDir: string,
  stem: string
): Promise<{ mdPath: string; imagesDir: string | null }> {
  // Download zip
  const zipBuf = await getBuffer(zipUrl, 'zip')

  const zip = new AdmZip(zipBuf)

  // Extract entire zip into stem_mineru/ preserving the original directory structure.
  // This keeps relative image paths in full.md intact — no rewriting needed.
  //
  // Decode entry names as UTF-8 ourselves rather than using extractAllTo:
  // adm-zip falls back to CP437 when the archive omits the UTF-8 flag (MinerU
  // does), which mangles non-ASCII titles (e.g. U+2010 hyphen -> "â€\x90")
  // and scatters images into a wrongly-named folder next to the real one.
  const extractDir = join(outputDir, `${stem}_mineru`)
  mkdirSync(extractDir, { recursive: true })
  for (const entry of zip.getEntries()) {
    const rel = entry.rawEntryName.toString('utf8').replace(/\\/g, '/')
    const dest = join(extractDir, rel)
    // zip-slip guard: never write outside extractDir
    if (dest !== extractDir && !dest.startsWith(extractDir + sep)) continue
    if (entry.isDirectory) {
      mkdirSync(dest, { recursive: true })
    } else {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.getData())
    }
  }

  // Locate full.md — it may be at the root or inside a subdirectory
  const mdPath = findFile(extractDir, 'full.md')
  if (!mdPath) throw new Error('full.md not found in MinerU zip')

  // Find the images directory (typically alongside full.md)
  const mdDir = dirname(mdPath)
  const { readdirSync: rd, statSync: st } = require('fs') as typeof import('fs')
  let imagesDir: string | null = null
  for (const entry of rd(mdDir)) {
    const full = join(mdDir, entry)
    if (st(full).isDirectory()) { imagesDir = full; break }
  }

  return { mdPath, imagesDir }
}

function findFile(dir: string, name: string): string | null {
  const { readdirSync, statSync } = require('fs') as typeof import('fs')
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    } else if (entry === name) {
      return full
    }
  }
  return null
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public: Agent mode conversion
// ═══════════════════════════════════════════════════════════════════════════════

export async function convertPdfToMarkdownAuto(
  filePath: string,
  onProgress?: (p: MinerUProgress) => void,
  outputPath?: string
): Promise<string> {
  const outputDir = dirname(filePath)
  const stem = basename(filePath, '.pdf')
  const outPath = outputPath ?? join(outputDir, `${stem}.md`)

  onProgress?.({ state: 'pending', message: '读取 PDF 页数...', progress: 0.05 })
  const pageCount = await getPdfPageCount(filePath)

  if (pageCount <= MAX_PAGES_PER_CHUNK) {
    onProgress?.({ state: 'running', message: `上传 PDF（${pageCount} 页）...`, progress: 0.2 })
    const taskId = await agentSubmitFile(filePath, ({ sent, total, speed }) => {
      onProgress?.({
        state: 'running',
        message: `上传 PDF ${fmtBytes(sent)}/${fmtBytes(total)}（${fmtSpeed(speed)}）`,
        progress: 0.2 + (total ? sent / total : 0) * 0.2,   // upload spans 0.2..0.4
      })
    })
    onProgress?.({ state: 'running', message: '解析中，请稍候...', progress: 0.5 })
    const markdown = await agentPollResult(taskId)
    writeFileSync(outPath, markdown, 'utf-8')
  } else {
    const tmpDir = join(tmpdir(), `veridian-pdf2md-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
    try {
      onProgress?.({ state: 'running', message: `拆分 PDF（${pageCount} 页 → 每块 ${MAX_PAGES_PER_CHUNK} 页）...`, progress: 0.05 })
      const chunks = await splitPdf(filePath, MAX_PAGES_PER_CHUNK, tmpDir)
      const parts: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const chunkLabel = `${i + 1}/${chunks.length}`
        // Each chunk spans an equal slice of the bar; upload advances within the
        // first 30% of the slice (real byte fraction), parse lands at 40%.
        onProgress?.({ state: 'running', message: `上传第 ${chunkLabel} 块...`, chunk: chunkLabel, progress: i / chunks.length })
        const taskId = await agentSubmitFile(chunks[i], ({ sent, total, speed }) => {
          const frac = total ? sent / total : 0
          onProgress?.({
            state: 'running',
            message: `上传第 ${chunkLabel} 块 ${fmtBytes(sent)}/${fmtBytes(total)}（${fmtSpeed(speed)}）`,
            chunk: chunkLabel,
            progress: (i + 0.3 * frac) / chunks.length,
          })
        })
        onProgress?.({ state: 'running', message: `解析第 ${chunkLabel} 块...`, chunk: chunkLabel, progress: (i + 0.4) / chunks.length })
        const md = await agentPollResult(taskId)
        parts.push(md)
      }
      writeFileSync(outPath, parts.join('\n\n---\n\n'), 'utf-8')
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  onProgress?.({ state: 'done', message: '转换完成', progress: 1 })
  return outPath
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public: Precision API mode conversion
// ═══════════════════════════════════════════════════════════════════════════════

export async function convertPdfToMarkdownPrecision(
  filePath: string,
  token: string,
  onProgress?: (p: MinerUProgress) => void,
  outputPath?: string
): Promise<{ mdPath: string; imagesDir: string | null }> {
  const outputDir = dirname(outputPath ?? filePath)
  const stem = basename(filePath, '.pdf')

  onProgress?.({ state: 'pending', message: '读取 PDF 页数...', progress: 0.05 })
  const pageCount = await getPdfPageCount(filePath)

  // ── Single-file path (<= 20 pages): unchanged behavior ──────────────────────
  if (pageCount <= MAX_PAGES_PER_CHUNK) {
    const fileName = basename(filePath)
    onProgress?.({ state: 'pending', message: '获取上传地址...', progress: 0.1 })
    const { batchId, uploadUrls } = await precisionBatchSubmit([fileName], token)
    onProgress?.({ state: 'running', message: '上传 PDF...', progress: 0.2 })
    await precisionUploadFile(filePath, uploadUrls[0], ({ sent, total, speed }) => {
      onProgress?.({
        state: 'running',
        message: `上传 PDF ${fmtBytes(sent)}/${fmtBytes(total)}（${fmtSpeed(speed)}）`,
        progress: 0.2 + (total ? sent / total : 0) * 0.2,   // upload spans 0.2..0.4
      })
    })
    onProgress?.({ state: 'running', message: '精准解析中（VLM 模型，速度较慢）...', progress: 0.5 })
    const [result] = await precisionPollBatch(batchId, token, 1)
    onProgress?.({ state: 'running', message: '下载并解压结果...', progress: 0.9 })
    const { mdPath, imagesDir } = await precisionExtractZip(result.zipUrl, outputDir, stem)
    onProgress?.({ state: 'done', message: '精准解析完成', progress: 1 })
    return { mdPath, imagesDir }
  }

  // ── Multi-chunk path (> 20 pages): split, batch-submit, merge ───────────────
  const tmpDir = join(tmpdir(), `veridian-pdf2md-${randomUUID()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    // Parallel batch: no per-chunk signal during the long parse, so the bar
    // steps through coarse phase weights (split .05, upload .15, parse .5,
    // download .8, merge .95) rather than reporting a real fraction.
    onProgress?.({ state: 'running', message: `拆分 PDF（${pageCount} 页 → 每块 ${MAX_PAGES_PER_CHUNK} 页）...`, progress: 0.05 })
    const chunks = await splitPdf(filePath, MAX_PAGES_PER_CHUNK, tmpDir)
    if (chunks.length > 200) {
      throw new Error(`PDF 过大：拆分为 ${chunks.length} 块，超过 MinerU 单批次 200 块上限`)
    }
    const fileNames = chunks.map((c) => basename(c))

    onProgress?.({ state: 'running', message: `批量上传 ${chunks.length} 个分块...`, progress: 0.15 })
    const { batchId, uploadUrls } = await precisionBatchSubmit(fileNames, token)

    // Parallel uploads report per-chunk; aggregate into one total sent/total and
    // an overall speed so the several concurrent streams don't fight over the
    // status line. Sizes are learned from the callbacks (putFile reports each
    // chunk's total), so the aggregate total grows in as uploads start.
    const sentArr = new Array<number>(chunks.length).fill(0)
    const totalArr = new Array<number>(chunks.length).fill(0)
    let aggT = Date.now()
    let aggSent = 0
    const reportAgg = (force: boolean): void => {
      const now = Date.now()
      if (!force && now - aggT < 250) return
      const sent = sentArr.reduce((a, b) => a + b, 0)
      const total = totalArr.reduce((a, b) => a + b, 0)
      const dt = now - aggT
      const speed = dt > 0 ? ((sent - aggSent) / dt) * 1000 : 0
      aggT = now
      aggSent = sent
      const frac = total ? sent / total : 0
      onProgress?.({
        state: 'running',
        message: `批量上传 ${chunks.length} 块 ${fmtBytes(sent)}/${fmtBytes(total)}（${fmtSpeed(speed)}）`,
        progress: 0.15 + frac * 0.2,   // upload spans 0.15..0.35
      })
    }
    await Promise.all(chunks.map((c, i) => precisionUploadFile(c, uploadUrls[i], ({ sent, total }) => {
      sentArr[i] = sent
      totalArr[i] = total
      reportAgg(false)
    })))
    reportAgg(true)

    onProgress?.({ state: 'running', message: `精准解析中（${chunks.length} 块并行，VLM 模型）...`, progress: 0.5 })
    const results = await precisionPollBatch(batchId, token, chunks.length)
    // Batch result order is not guaranteed -- map back to chunk order by name.
    const zipByName = new Map(results.map((r) => [r.fileName, r.zipUrl]))

    onProgress?.({ state: 'running', message: '下载并解压各分块结果...', progress: 0.8 })
    const extractRoot = join(tmpDir, 'extract')
    const chunkResults: Array<{ md: string; images: string[]; imagesDir: string | null }> = []
    for (let i = 0; i < chunks.length; i++) {
      const zipUrl = zipByName.get(fileNames[i])
      if (!zipUrl) throw new Error(`缺少分块结果：${fileNames[i]}`)
      const { mdPath, imagesDir } = await precisionExtractZip(zipUrl, extractRoot, `chunk${i + 1}`)
      const md = readFileSync(mdPath, 'utf-8')
      const images = imagesDir
        ? readdirSync(imagesDir).filter((f) => {
            try { return statSync(join(imagesDir, f)).isFile() } catch { return false }
          })
        : []
      chunkResults.push({ md, images, imagesDir })
    }

    onProgress?.({ state: 'running', message: `合并 ${chunks.length} 个分块结果...`, progress: 0.95 })
    const { content, copies } = planChunkMerge(
      chunkResults.map((c) => ({ md: c.md, images: c.images }))
    )

    // Merged output under ${stem}_mineru/images -- matches the md's images/ ref
    // convention and the single-file path's dir shape, so ConversionService and
    // the repo exporter treat it identically. Copy (not move): chunks live on
    // tmpdir, the merged dir under staging -- possibly a different volume.
    const mergedRoot = join(outputDir, `${stem}_mineru`)
    const mergedImagesDir = join(mergedRoot, 'images')
    mkdirSync(mergedImagesDir, { recursive: true })
    for (const cp of copies) {
      const srcDir = chunkResults[cp.chunk].imagesDir
      if (!srcDir) continue
      copyFileSync(join(srcDir, cp.from), join(mergedImagesDir, cp.to))
    }

    const mdPath = join(mergedRoot, 'full.md')
    writeFileSync(mdPath, content, 'utf-8')

    onProgress?.({ state: 'done', message: '精准解析完成', progress: 1 })
    return { mdPath, imagesDir: copies.length > 0 ? mergedImagesDir : null }
  } finally {
    // tmpDir holds only chunk PDFs + raw per-chunk extraction; the merged output
    // already lives under staging, so this cleanup is safe.
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Used by the Tools dialog (manual pick-pdf flow) — always uses Agent mode
// ═══════════════════════════════════════════════════════════════════════════════

export async function convertPdfToMarkdown(
  filePath: string,
  outputDir: string,
  _opts: Record<string, unknown>,
  onProgress?: (p: MinerUProgress) => void
): Promise<string> {
  const stem = basename(filePath, '.pdf')
  const outPath = join(outputDir, `${stem}.md`)
  onProgress?.({ state: 'pending', message: '读取 PDF 页数...' })
  const pageCount = await getPdfPageCount(filePath)

  if (pageCount <= MAX_PAGES_PER_CHUNK) {
    onProgress?.({ state: 'running', message: `上传 PDF（${pageCount} 页）...` })
    const taskId = await agentSubmitFile(filePath)
    onProgress?.({ state: 'running', message: '解析中，请稍候...' })
    const markdown = await agentPollResult(taskId)
    writeFileSync(outPath, markdown, 'utf-8')
  } else {
    const tmpDir = join(tmpdir(), `veridian-pdf2md-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
    try {
      onProgress?.({ state: 'running', message: `拆分 PDF（${pageCount} 页）...` })
      const chunks = await splitPdf(filePath, MAX_PAGES_PER_CHUNK, tmpDir)
      const parts: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const chunkLabel = `${i + 1}/${chunks.length}`
        onProgress?.({ state: 'running', message: `上传第 ${chunkLabel} 块...`, chunk: chunkLabel })
        const taskId = await agentSubmitFile(chunks[i])
        onProgress?.({ state: 'running', message: `解析第 ${chunkLabel} 块...`, chunk: chunkLabel })
        const md = await agentPollResult(taskId)
        parts.push(md)
      }
      writeFileSync(outPath, parts.join('\n\n---\n\n'), 'utf-8')
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  onProgress?.({ state: 'done', message: '转换完成' })
  return outPath
}
