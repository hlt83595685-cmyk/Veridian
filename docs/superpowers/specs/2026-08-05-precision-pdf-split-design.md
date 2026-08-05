# 精准（token）模式 PDF 分块与合并 — 设计文档

日期：2026-08-05
状态：已批准，待实现

## 背景与问题

Veridian 的 PDF→Markdown 有两种模式：

- **免费 Agent 模式**（`convertPdfToMarkdownAuto` / `convertPdfToMarkdown`）：读页数，超过 `MAX_PAGES_PER_CHUNK`（20）就用 `splitPdf` 按 20 页拆块，逐块提交/轮询，再用 `\n\n---\n\n` 拼接。
- **精准 Precision 模式**（`convertPdfToMarkdownPrecision`）：单文件，走 MinerU v4 batch API，返回 zip（`full.md` + `images/`）。**没有任何页数检查或拆分**。

MinerU v4 单文件上限为 **600 页 / 200 MB**，单批次最多 200 文件，账号每日 2000 页高优先级配额。当前精准模式面对超限 PDF 会直接在提交/解析阶段失败，没有拆分兜底。

**目标**：给精准模式加上与免费模式一致的分块能力，并正确处理精准模式独有的图片输出、图片改名、以及下游仓库同步流程。

## 关键决策（已确认）

1. **分块阈值 = 20 页/块**，复用现有 `MAX_PAGES_PER_CHUNK`，与免费模式一致。
   - 连带影响：精准模式下几乎每篇多页论文都会走"多块合并"路径，因此跨块图片去重与 markdown 合并是**常态主路径**，必须做稳。
2. **单批次并行提交**所有分块：一次 batch 提交 N 个块（batch API 本就是数组形状），服务端并行解析，只轮询一次。
3. 分层：合并逻辑放进**新的纯函数模块** `mergeChunks.ts`，fs 侧留在 `mineruApi.ts`——照搬 `markdownImages.ts`（纯计划 + fs 执行）的既有模式。
4. **任一块失败 → 整份失败**（throw），不跳过坏块继续。与 `JobQueue` 的 `maxAttempts:1` 及 `setConversionFailed(itemId, true)`（该条目暂不进同步）一致。
5. **>200 块只报清晰错误**，多批次留作 future（YAGNI；200 块=4000 页已超每日配额）。

## 架构原则：复杂度封在边界内

所有拆分/合并逻辑塞进 `convertPdfToMarkdownPrecision` 内部，让它**依然只返回 `{ mdPath, imagesDir }`**。因此 `ConversionService`、`normalizeImages`、附件注册、仓库同步**全部零改动**——它们看到的与现在的单文件精准结果完全一致。

`pageCount ≤ 20` 时走原来的单文件路径，行为完全不变（`precisionBatchSubmit` 传长度 1 的数组）。

## 数据流（pageCount > 20）

```
1. splitPdf(pdf, 20, tmpDir)              →  N 个分块 PDF（复用现有函数）
2. precisionBatchSubmit(fileNames[])      →  { batchId, uploadUrls[] }   一次批量提交
3. 并行 PUT 上传 N 个块到各自 uploadUrl
4. precisionPollBatch(batchId)            →  [{ fileName, zipUrl }]      单次轮询整批
5. 逐块 precisionExtractZip(zip)          →  N 组 { chunkMd, chunkImagesDir }
6. 合并（新逻辑，见下）：
     - 每块图片按 c{i}_原名 复制进统一 images/ 目录（跨块防撞名）
     - 每块 md 图片引用按 basename 重写为 images/c{i}_原名
     - 用 "\n\n---\n\n" 拼接
     → 写出单个 mdPath + 单个 merged imagesDir（固定名 images）
7. 返回 { mdPath, imagesDir }  →  下游 normalizeImages 照常统一重命名为 figN
```

## 图片处理（核心难点）

### 问题：跨块撞名
每块是独立解析任务，各自产出 `images/`。块1 的 `img_0.jpg` 与块2 的 `img_0.jpg` 是不同的图，直接合并会互相覆盖，且两块 md 都写 `images/img_0.jpg`，引用无法区分。

### 方案：合并时加块命名空间，交给下游统一编号
`planChunkMerge`（纯函数）对每块 i **按 basename 匹配**（与 `planImageRenames` 一致，因此不管 MinerU 用什么路径前缀都无所谓）：

```
块 i 的磁盘文件 img_0.jpg        →  复制进统一 images/，改名 c{i}_img_0.jpg
块 i 的 md 引用 images/img_0.jpg  →  重写成 images/c{i}_img_0.jpg
```

- 每块内部去重（同图多次引用只复制一份、只有一个目标名），复用 `planImageRenames` 的 map 思路。
- 跨盘安全：块在 tmp、合并目录在 staging，可能不同盘，用 **`copyFileSync` 而非 rename**。
- 合并目录**固定叫 `images`**（与 md 的 `images/…` 引用约定一致），建在 `${stem}_mineru/images`。

`c{i}_` 是过渡名，不会留到最后。合并结果原样交给**未改动的** `normalizeImages`，它按整篇出现顺序统一重编号为 `fig1..figN`、删无引用图、磁盘改名。下游、附件注册、仓库同步全部不变。

```
块1: images/img_0.jpg  ─┐
块2: images/img_0.jpg  ─┼─合并─→ images/c1_img_0.jpg  ─┐
块2: images/pic.png    ─┘         images/c2_img_0.jpg  ─┼─normalizeImages─→ fig1/fig2/fig3
                                  images/c2_pic.png    ─┘
```

### 图片边界
- 某块无图（纯文本）：images 列表为空，不复制，md 直接拼接。
- 所有块都无图：合并目录为空 → 返回 `imagesDir: null`（符合现有 `string | null` 契约，`ConversionService` 已有 `if (result.imagesDir)` 守卫）。
- 水印/logo 每页都有：MinerU 常用内容哈希命名，块内去重；跨块因 `c{i}_` 前缀各留一份，`normalizeImages` 按引用位置各自编号——符合预期。

## 改动清单（全部在 `src/main/`）

| 文件 | 改动 |
|---|---|
| `mineruApi.ts` · `precisionBatchSubmit` | 泛化：入参 `fileNames: string[]`，返回 `uploadUrls: string[]`（顺序对齐输入）。单文件路径传长度 1 |
| `mineruApi.ts` · `precisionPollBatch` | 泛化：等**整批** `extract_result` 全 `done`（现在只看 `[0]`），任一 `failed` 快速失败抛错，返回 `[{fileName, zipUrl}]` |
| `mineruApi.ts` · `convertPdfToMarkdownPrecision` | 加入"页数判断 → 拆分 → 批量提交 → 并行上传 → 单次轮询 → 逐块解压 → 合并"分支；tmpDir 在 `finally` 清理 |
| **新增** `mergeChunks.ts` | 纯函数 `planChunkMerge(chunks: {md, images: string[]}[]) → { content, copies: {chunk, from, to}[] }`；fs 侧（copyFileSync、写 md）留在 `mineruApi.ts` |
| **新增** `mergeChunks.test.ts` | 单测：跨块撞名、引用重写、分隔符、外链/缺失文件不动、空图块——照搬 `markdownImages.test.ts` 风格 |

## 错误处理 / 边界
- 任一块失败 → 整份失败（throw）；`setConversionFailed(itemId, true)` 由 `ConversionService` 现有 catch 兜底。
- 合并**不是** best-effort：合并失败输出不可用，直接抛（区别于 `normalizeImages` 的静默跳过）。
- 批量上限 200 文件：>200 块给出明确报错，多批次留作 future。
- 200 MB 大小限制：仅按页数拆，不按体积——与免费模式现状同缺口，v1 不处理。
- 轮询超时：并行解析下现有 20min 上限基本够；如需可按块数适当放宽（标注，不强制）。

## 进度提示（沿用 `ctx.progress`）
`拆分 PDF（N 页 → 每块 20 页）` → `批量上传 N 个分块` → `精准解析中（N 块并行，VLM）` → `合并 N 个分块结果` → `完成`

## 测试策略
- 纯函数 `planChunkMerge` 单测覆盖合并逻辑（唯一新增的复杂点）。
- 下游 `normalizeImages` 已有测试不受影响。
- 实时 API 无法自动测——手动验证一份 >20 页 PDF 的精准转换。

## 非目标（Out of scope）
- 按文件体积（200 MB）拆分。
- >200 块的多批次提交。
- 免费 Agent 模式的任何改动。
- 精准模式单文件（≤20 页）路径的行为改变。
