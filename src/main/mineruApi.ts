import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'fs'
import { basename, join, dirname } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { PDFDocument } from 'pdf-lib'
import AdmZip from 'adm-zip'
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
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchJson(url: string, options: RequestInit): Promise<unknown> {
  const resp = await fetch(url, options)
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function agentSubmitFile(filePath: string): Promise<string> {
  const fileName = basename(filePath)
  const sigResp = await fetchJson(`${AGENT_BASE}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, language: 'ch', enable_table: true, enable_formula: true }),
  }) as { code: number; data: { file_url: string; task_id: string }; msg: string }

  if (sigResp.code !== 0) throw new Error(`MinerU submit error: ${sigResp.msg}`)

  const { file_url, task_id } = sigResp.data
  const fileBuffer = readFileSync(filePath)
  const uploadResp = await fetch(file_url, { method: 'PUT', body: fileBuffer })
  if (!uploadResp.ok) throw new Error(`Upload failed: HTTP ${uploadResp.status}`)
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
      const mdResp = await fetch(markdown_url)
      if (!mdResp.ok) throw new Error(`Download markdown failed: HTTP ${mdResp.status}`)
      return mdResp.text()
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
async function precisionUploadFile(filePath: string, uploadUrl: string): Promise<void> {
  const fileBuffer = readFileSync(filePath)
  const resp = await fetch(uploadUrl, { method: 'PUT', body: fileBuffer })
  if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`)
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
  const resp = await fetch(zipUrl)
  if (!resp.ok) throw new Error(`Download zip failed: HTTP ${resp.status}`)
  const zipBuf = Buffer.from(await resp.arrayBuffer())

  const zip = new AdmZip(zipBuf)

  // Extract entire zip into stem_mineru/ preserving the original directory structure.
  // This keeps relative image paths in full.md intact — no rewriting needed.
  const extractDir = join(outputDir, `${stem}_mineru`)
  mkdirSync(extractDir, { recursive: true })
  zip.extractAllTo(extractDir, /* overwrite */ true)

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
      onProgress?.({ state: 'running', message: `拆分 PDF（${pageCount} 页 → 每块 ${MAX_PAGES_PER_CHUNK} 页）...` })
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

  onProgress?.({ state: 'pending', message: '读取 PDF 页数...' })
  const pageCount = await getPdfPageCount(filePath)

  // ── Single-file path (<= 20 pages): unchanged behavior ──────────────────────
  if (pageCount <= MAX_PAGES_PER_CHUNK) {
    const fileName = basename(filePath)
    onProgress?.({ state: 'pending', message: '获取上传地址...' })
    const { batchId, uploadUrls } = await precisionBatchSubmit([fileName], token)
    onProgress?.({ state: 'running', message: '上传 PDF...' })
    await precisionUploadFile(filePath, uploadUrls[0])
    onProgress?.({ state: 'running', message: '精准解析中（VLM 模型，速度较慢）...' })
    const [result] = await precisionPollBatch(batchId, token, 1)
    onProgress?.({ state: 'running', message: '下载并解压结果...' })
    const { mdPath, imagesDir } = await precisionExtractZip(result.zipUrl, outputDir, stem)
    onProgress?.({ state: 'done', message: '精准解析完成' })
    return { mdPath, imagesDir }
  }

  // ── Multi-chunk path (> 20 pages): split, batch-submit, merge ───────────────
  const tmpDir = join(tmpdir(), `veridian-pdf2md-${randomUUID()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    onProgress?.({ state: 'running', message: `拆分 PDF（${pageCount} 页 → 每块 ${MAX_PAGES_PER_CHUNK} 页）...` })
    const chunks = await splitPdf(filePath, MAX_PAGES_PER_CHUNK, tmpDir)
    if (chunks.length > 200) {
      throw new Error(`PDF 过大：拆分为 ${chunks.length} 块，超过 MinerU 单批次 200 块上限`)
    }
    const fileNames = chunks.map((c) => basename(c))

    onProgress?.({ state: 'running', message: `批量上传 ${chunks.length} 个分块...` })
    const { batchId, uploadUrls } = await precisionBatchSubmit(fileNames, token)
    await Promise.all(chunks.map((c, i) => precisionUploadFile(c, uploadUrls[i])))

    onProgress?.({ state: 'running', message: `精准解析中（${chunks.length} 块并行，VLM 模型）...` })
    const results = await precisionPollBatch(batchId, token, chunks.length)
    // Batch result order is not guaranteed -- map back to chunk order by name.
    const zipByName = new Map(results.map((r) => [r.fileName, r.zipUrl]))

    onProgress?.({ state: 'running', message: '下载并解压各分块结果...' })
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

    onProgress?.({ state: 'running', message: `合并 ${chunks.length} 个分块结果...` })
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

    onProgress?.({ state: 'done', message: '精准解析完成' })
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
