# 精准模式 PDF 分块与合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 MinerU 精准（token）模式加上与免费模式一致的 >20 页 PDF 自动分块能力，并正确合并各分块的 markdown 与图片。

**Architecture:** 所有拆分/合并逻辑封在 `convertPdfToMarkdownPrecision` 内部，函数签名与返回 `{ mdPath, imagesDir }` 不变，因此 `ConversionService`、`normalizeImages`、附件注册、仓库同步全部零改动。跨块图片撞名用纯函数 `planChunkMerge` 加 `c{i}_` 命名空间前缀解决，交给下游 `normalizeImages` 统一重编号为 `figN`。

**Tech Stack:** TypeScript（strict，tab 缩进，无 `any`）、Electron main 进程、vitest、pdf-lib、adm-zip、MinerU v4 batch API。

参考 spec：`docs/superpowers/specs/2026-08-05-precision-pdf-split-design.md`

---

## File Structure

- **Create** `src/main/services/mergeChunks.ts` — 纯函数 `planChunkMerge`，无 fs 依赖，与 `markdownImages.ts` 同层同风格。
- **Create** `src/main/services/mergeChunks.test.ts` — `planChunkMerge` 单测。
- **Modify** `src/main/mineruApi.ts` — 泛化 `precisionBatchSubmit` / `precisionPollBatch` 为数组形状，重写 `convertPdfToMarkdownPrecision` 加分块分支，补 fs import。
- 不改：`ConversionService.ts`、`markdownImages.ts`、免费模式路径、精准单文件（≤20 页）行为。

---

## Task 1: 纯函数 `planChunkMerge`（TDD）

**Files:**
- Create: `src/main/services/mergeChunks.ts`
- Test: `src/main/services/mergeChunks.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/main/services/mergeChunks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { planChunkMerge } from './mergeChunks'

describe('planChunkMerge', () => {
  it('namespaces each chunk\'s images with c{i}_ and rewrites refs', () => {
    const { content, copies } = planChunkMerge([
      { md: '![](images/img_0.jpg)', images: ['img_0.jpg'] },
      { md: '![](images/img_0.jpg) ![](images/pic.png)', images: ['img_0.jpg', 'pic.png'] },
    ])
    expect(content).toContain('images/c1_img_0.jpg')
    expect(content).toContain('images/c2_img_0.jpg')
    expect(content).toContain('images/c2_pic.png')
    expect(copies).toEqual([
      { chunk: 0, from: 'img_0.jpg', to: 'c1_img_0.jpg' },
      { chunk: 1, from: 'img_0.jpg', to: 'c2_img_0.jpg' },
      { chunk: 1, from: 'pic.png', to: 'c2_pic.png' },
    ])
  })

  it('joins chunk markdown with a horizontal-rule separator', () => {
    const { content } = planChunkMerge([
      { md: 'first', images: [] },
      { md: 'second', images: [] },
    ])
    expect(content).toBe('first\n\n---\n\nsecond')
  })

  it('reuses one target and one copy for an image referenced twice in a chunk', () => {
    const { content, copies } = planChunkMerge([
      { md: '![](images/x.png) then ![](images/x.png)', images: ['x.png'] },
    ])
    expect(copies).toEqual([{ chunk: 0, from: 'x.png', to: 'c1_x.png' }])
    expect(content.match(/c1_x\.png/g)).toHaveLength(2)
  })

  it('handles html img tags', () => {
    const { content, copies } = planChunkMerge([
      { md: '<img src="images/photo.jpeg" alt="p">', images: ['photo.jpeg'] },
    ])
    expect(content).toContain('src="images/c1_photo.jpeg"')
    expect(copies).toEqual([{ chunk: 0, from: 'photo.jpeg', to: 'c1_photo.jpeg' }])
  })

  it('leaves external and unknown refs untouched and does not copy them', () => {
    const { content, copies } = planChunkMerge([
      { md: '![](https://ex.com/a.png) ![](images/gone.png) ![](images/here.png)', images: ['here.png'] },
    ])
    expect(content).toContain('https://ex.com/a.png')
    expect(content).toContain('images/gone.png')
    expect(content).toContain('images/c1_here.png')
    expect(copies).toEqual([{ chunk: 0, from: 'here.png', to: 'c1_here.png' }])
  })

  it('emits no copies when a chunk has no images', () => {
    const { copies } = planChunkMerge([{ md: 'text only', images: [] }])
    expect(copies).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/mergeChunks.test.ts`
Expected: FAIL — `Cannot find module './mergeChunks'` / `planChunkMerge is not a function`

- [ ] **Step 3: 写最小实现**

Create `src/main/services/mergeChunks.ts`:

```ts
// Pure planning logic for merging N per-chunk MinerU precision results into one.
// Each chunk is an independent parse job with its own images/ folder whose
// basenames can collide across chunks, so every chunk's referenced images get a
// c{i}_ namespace prefix before merge; the caller copies files accordingly and
// the downstream normalizeImages step re-numbers everything to figN. Pure (no
// fs) so it unit-tests under plain vitest -- mirrors markdownImages.ts.

export interface ChunkInput {
	md: string          // this chunk's full.md content
	images: string[]    // basenames present in this chunk's images dir
}

export interface ChunkImageCopy {
	chunk: number       // 0-based index into the chunks array
	from: string        // original basename in that chunk's images dir
	to: string          // namespaced basename in the merged images dir (c{i}_...)
}

export interface ChunkMergePlan {
	content: string             // merged markdown, chunks joined by \n\n---\n\n
	copies: ChunkImageCopy[]    // image files to copy into the merged images dir
}

// Markdown ![alt](path "title") and HTML <img src="path"> -- same as markdownImages.ts
const MD_REF = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g
const HTML_REF = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi

function isExternal(ref: string): boolean {
	return /^(https?:|data:|file:|veridian-file:)/i.test(ref)
}

function basenameOf(ref: string): string {
	const clean = ref.split(/[?#]/)[0]
	const parts = clean.split(/[\\/]/)
	return parts[parts.length - 1]
}

/**
 * Merge N chunk markdowns into one document, namespacing each chunk's referenced
 * images to c{i}_<name> so cross-chunk basename collisions can't clobber each
 * other. Only images actually referenced by a chunk's markdown are copied;
 * anything unreferenced is dropped (the same outcome normalizeImages would reach
 * downstream). Chunks are concatenated in array order, separated by a horizontal
 * rule -- consistent with the free Agent mode's merge.
 */
export function planChunkMerge(chunks: ChunkInput[]): ChunkMergePlan {
	const copies: ChunkImageCopy[] = []
	const parts: string[] = []

	chunks.forEach((chunk, i) => {
		const available = new Set(chunk.images)
		const mapping = new Map<string, string>()   // original basename -> c{i+1}_basename

		const assign = (ref: string): string | null => {
			if (isExternal(ref)) return null
			const base = basenameOf(ref)
			if (!available.has(base)) return null
			let target = mapping.get(base)
			if (!target) {
				target = `c${i + 1}_${base}`
				mapping.set(base, target)
				copies.push({ chunk: i, from: base, to: target })
			}
			return target
		}

		const rewrite = (text: string, re: RegExp): string =>
			text.replace(re, (whole, pre: string, ref: string, post: string) => {
				const target = assign(ref)
				return target === null ? whole : `${pre}images/${target}${post}`
			})

		let content = rewrite(chunk.md, MD_REF)
		content = rewrite(content, HTML_REF)
		parts.push(content)
	})

	return { content: parts.join('\n\n---\n\n'), copies }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/services/mergeChunks.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/services/mergeChunks.ts src/main/services/mergeChunks.test.ts
git commit -m "feat: add planChunkMerge for cross-chunk precision merge"
```

---

## Task 2: 精准模式分块改造（`mineruApi.ts`）

一次性改完三处（两个 helper + 主函数）以保证提交可编译；网络代码无法单测，靠 typecheck + 手动验证。

**Files:**
- Modify: `src/main/mineruApi.ts`

- [ ] **Step 1: 补 fs import 与 planChunkMerge import**

把第 1 行：

```ts
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
```

改为：

```ts
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'fs'
```

并在第 6 行 `import AdmZip from 'adm-zip'` 之后新增一行：

```ts
import { planChunkMerge } from './services/mergeChunks'
```

- [ ] **Step 2: 泛化 `precisionBatchSubmit` 为数组形状**

将现有 `precisionBatchSubmit`（约 121–147 行）整体替换为：

```ts
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
```

- [ ] **Step 3: 泛化 `precisionPollBatch` 为整批 + expectedCount**

将现有 `precisionPollBatch`（约 157–187 行）整体替换为：

```ts
/** Poll GET /extract-results/batch/{id} until all expectedCount files are done.
 *  Returns each file's zip URL; fails fast if any chunk failed. */
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
		// Require the full set present before trusting an all-done check: entries
		// can appear incrementally, and every() over a partial set is misleading.
		if (results.length === expectedCount && results.every((r) => r.state === 'done')) {
			return results.map((r) => {
				if (!r.full_zip_url) throw new Error(`No full_zip_url for ${r.file_name}`)
				return { fileName: r.file_name, zipUrl: r.full_zip_url }
			})
		}
	}
	throw new Error('Timeout waiting for MinerU precision result (20 min)')
}
```

- [ ] **Step 4: 重写 `convertPdfToMarkdownPrecision` 加分块分支**

将现有 `convertPdfToMarkdownPrecision`（约 292–317 行）整体替换为：

```ts
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
		// tmpDir holds only chunk PDFs + raw per-chunk extraction; the merged
		// output already lives under staging, so this cleanup is safe.
		try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
	}
}
```

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误（尤其确认 `precisionBatchSubmit` / `precisionPollBatch` 的所有调用点已更新，`readdirSync`/`statSync`/`copyFileSync`/`planChunkMerge` 均已导入）

- [ ] **Step 6: 跑全量单测**

Run: `npx vitest run`
Expected: 全绿，含 `mergeChunks.test.ts` 与既有 `markdownImages.test.ts`

- [ ] **Step 7: 提交**

```bash
git add src/main/mineruApi.ts
git commit -m "feat: split & merge >20-page PDFs in precision (token) mode"
```

---

## Task 3: 手动验证（真实 API）

自动测试覆盖不到实时 MinerU 调用，需手动确认。

- [ ] **Step 1:** 在设置 → 工具中切到"精准解析 API"并填入有效 MinerU Token。
- [ ] **Step 2:** 导入一份 **> 20 页、含图表** 的 PDF（触发多块路径）。
- [ ] **Step 3:** 观察进度提示依次出现：拆分 → 批量上传 → 并行解析 → 合并 → 完成。
- [ ] **Step 4:** 打开转换出的 markdown，确认：正文按页顺序完整、图片显示为 `images/figN.ext` 且能正常渲染、无重复/缺图。
- [ ] **Step 5:** 若该库连了 GitHub 仓库，确认同步后 `papers/<title>/files/` 下 `.md` 与 `images/` 正确落地。
- [ ] **Step 6:** 另导入一份 **≤ 20 页** PDF，确认单文件路径行为与改动前一致（回归）。

---

## Self-Review 记录

- **Spec 覆盖：** 分块阈值 20（Task 2 Step 4 用 `MAX_PAGES_PER_CHUNK`）、单批次并行提交（Task 2 Step 2/4）、纯函数分层（Task 1）、任一块失败即整份失败（Task 2 Step 3 fail-fast + 主函数 throw）、>200 块报错（Task 2 Step 4）、图片 `c{i}_` 命名空间与下游 figN（Task 1 + Task 2 Step 4）、空图块→`imagesDir: null`（Task 1 空图用例 + 主函数 `copies.length > 0` 判断）——均有对应任务。
- **占位符扫描：** 无 TBD/TODO，所有代码步骤含完整代码。
- **类型一致性：** `precisionBatchSubmit` 返回 `{ batchId, uploadUrls }`、`precisionPollBatch` 返回 `Array<{ fileName, zipUrl }>` 并接受 `expectedCount`、`planChunkMerge` 入参 `{ md, images }[]` 出参 `{ content, copies }`——主函数调用点全部一致。
