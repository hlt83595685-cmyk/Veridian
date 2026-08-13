# 跨语言查询翻译 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 中文 query 检索前翻成英文,原文+译文两路检索并 RRF 融合;纯英文 query 与失败时退回现状。

**Architecture:** 新增 `src/main/knowledge/queryTranslate.ts`(`hasCJK` 纯函数 + `translateForSearch` 网络包装),`hybridSearch` 改为"原 query 检索与翻译并发 → 有译文则再检索译文 → 合并所有 rank lists → RRF"。FTS/向量/RRF/重排全不动。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、Vitest、既有 OpenAI 兼容 provider(`chatStream`/`getChatConfig`)。

参见 spec:`docs/superpowers/specs/2026-08-13-query-translate-design.md`

---

## File Structure

- **Create** `src/main/knowledge/queryTranslate.ts` — 导出 `hasCJK`(纯函数)、`translateForSearch`(翻译 + 超时 + 回退)。
- **Create** `src/main/knowledge/queryTranslate.test.ts` — `hasCJK` 单测。
- **Modify** `src/main/knowledge/search.ts` — 抽出 `runQuery` 辅助;`hybridSearch` 并发翻译并合并 rank lists。

---

## Task 1: `hasCJK` 纯函数 + `translateForSearch`(TDD for hasCJK)

**Files:**
- Create: `src/main/knowledge/queryTranslate.ts`
- Test: `src/main/knowledge/queryTranslate.test.ts`

- [ ] **Step 1: Write the failing test** — `src/main/knowledge/queryTranslate.test.ts`(tab 缩进):

```ts
import { describe, it, expect } from 'vitest'
import { hasCJK } from './queryTranslate'

describe('hasCJK', () => {
	it('detects Chinese', () => {
		expect(hasCJK('注意力机制')).toBe(true)
	})
	it('is false for pure ASCII/English', () => {
		expect(hasCJK('transformer attention')).toBe(false)
	})
	it('detects mixed Chinese + English', () => {
		expect(hasCJK('transformer 注意力')).toBe(true)
	})
	it('is false for empty', () => {
		expect(hasCJK('')).toBe(false)
	})
})
```

- [ ] **Step 2: Run test, verify it FAILS** — `npx vitest run src/main/knowledge/queryTranslate.test.ts` → expect failure resolving `./queryTranslate`.

- [ ] **Step 3: Write implementation** — `src/main/knowledge/queryTranslate.ts`(tab 缩进):

```ts
import { getChatConfig, chatStream } from './providers'

const TIMEOUT_MS = 12_000
const TRANSLATE_SYSTEM =
	'Translate the user\'s search query to English. Output ONLY the translation, ' +
	'no quotes, no explanation. If it is already English, output it unchanged.'

/** True if the string contains a CJK ideograph (Chinese). Cheap gate so only
 *  Chinese queries pay for a translation. */
export function hasCJK(s: string): boolean {
	return /[㐀-鿿]/.test(s)
}

/** Translate a Chinese search query to English for the retrieval second pass.
 *  Returns null (caller falls back to the original query alone) when the query
 *  is not Chinese, no chat model is configured, or the call fails/times out. */
export async function translateForSearch(query: string): Promise<string | null> {
	if (!hasCJK(query)) return null
	const cfg = getChatConfig()
	if (!cfg) return null
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
	try {
		const res = await chatStream(cfg, [
			{ role: 'system', content: TRANSLATE_SYSTEM },
			{ role: 'user', content: query },
		], [], () => {}, ctrl.signal)
		const out = res.content.trim()
		return out && out !== query ? out : null
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}
```

- [ ] **Step 4: Run test, verify it PASSES** — `npx vitest run src/main/knowledge/queryTranslate.test.ts` → expect 4 tests pass.

- [ ] **Step 5: Typecheck** — `npm run typecheck` → expect no output. If `messages` triggers a `ChatMessage` type error, import the type and annotate `const messages: ChatMessage[] = [...]`; prefer not to unless required.

- [ ] **Step 6: Commit**:
```bash
git add src/main/knowledge/queryTranslate.ts src/main/knowledge/queryTranslate.test.ts
git commit -m "feat: hasCJK + translateForSearch (cross-lingual query translation)"
```

---

## Task 2: 接入 `hybridSearch`（并发翻译 + 合并 rank lists）

**Files:**
- Modify: `src/main/knowledge/search.ts`

**Context** — the CURRENT `hybridSearch` head is:

```ts
export async function hybridSearch(wsId: number, query: string, topK = 8): Promise<SearchHit[]> {
	const [ftsIds, vecIds] = await Promise.all([
		Promise.resolve(ftsSearch(wsId, query)),
		vectorSearch(wsId, query),
	])
	const fused = rrfFuse([ftsIds, vecIds])
	// Over-select a rerank pool; ...
```

Everything from `const pool = ...` onward is unchanged by this task.

- [ ] **Step 1: Add import** — near the other `./` imports in `search.ts`:

```ts
import { translateForSearch } from './queryTranslate'
```

- [ ] **Step 2: Add the `runQuery` helper** — place it directly above `hybridSearch`:

```ts
/** FTS + vector rank lists for one query string. */
async function runQuery(wsId: number, query: string): Promise<number[][]> {
	const [fts, vec] = await Promise.all([
		Promise.resolve(ftsSearch(wsId, query)),
		vectorSearch(wsId, query),
	])
	return [fts, vec]
}
```

- [ ] **Step 3: Replace the head of `hybridSearch`** — replace exactly these lines:

```ts
	const [ftsIds, vecIds] = await Promise.all([
		Promise.resolve(ftsSearch(wsId, query)),
		vectorSearch(wsId, query),
	])
	const fused = rrfFuse([ftsIds, vecIds])
```

with:

```ts
	// Retrieve the original query while translating it in parallel; a Chinese
	// query also gets an English pass so BM25 can match English papers. Fuse all
	// rank lists. Non-Chinese queries / translation failure => original only.
	const [origLists, translated] = await Promise.all([
		runQuery(wsId, query),
		translateForSearch(query),
	])
	const rankLists = translated ? [...origLists, ...(await runQuery(wsId, translated))] : origLists
	const fused = rrfFuse(rankLists)
```

Leave the rest of `hybridSearch` (pool/hydrate/`rerankHits`) untouched. Note `rerankHits(query, ...)` keeps the ORIGINAL query.

- [ ] **Step 4: Typecheck** — `npm run typecheck` → expect no output.

- [ ] **Step 5: Full test run** — `npm test` → expect all green (existing `search.test.ts` rrfFuse/toFtsQuery, `rerank.test.ts`, new `queryTranslate.test.ts`). Report exact counts.

- [ ] **Step 6: Commit**:
```bash
git add src/main/knowledge/search.ts
git commit -m "feat: hybridSearch runs a translated second pass for Chinese queries"
```

---

## Task 3: App 内手动验证

**Files:** 无(验证)。

- [ ] **Step 1** — 确认已配置聊天模型(否则翻译走"未配置→回退")。

- [ ] **Step 2** — 若 dev server 未开则启动;先问用户是否已开着 app(避免起第二个实例)。

- [ ] **Step 3** — 用**中文**就某篇**英文**文献的内容提一个具体问题,应能检索到相关英文正文并作答(翻译生效)。主进程日志无未捕获异常。

- [ ] **Step 4** — 断网(或清空聊天 key)后再用中文问一次:应仍能返回结果(退回只用原 query),不报错、不卡死(≤12s 超时)。恢复配置。

- [ ] **Step 5** — 用**纯英文** query 问一次:行为应与之前一致(不触发翻译)。

- [ ] **Step 6: 无需提交**(验证无代码改动)。

---

## Self-Review

- **Spec 覆盖**:仅跨语言翻译(Task 1 `translateForSearch`)✅;单向中→英(`hasCJK` 门控 + system 提示)✅;始终开无设置(全程无 setting)✅;复用聊天模型(`getChatConfig`+`chatStream`)✅;并发翻译(Task 2 `Promise.all`)✅;多 rank list 融合(`rrfFuse(rankLists)`)✅;重排用原 query(`rerankHits(query, ...)` 不变)✅;回退清单 5 条(hasCJK/无模型/失败/超时/空译文——Task 1 guard + try/catch)✅;`hasCJK` 单测 4 场景(Task 1)✅。
- **占位符扫描**:无 TBD/TODO,所有代码步骤含完整代码。
- **类型一致性**:`hasCJK`/`translateForSearch`/`runQuery` 三处签名在 Task 1–2 一致;`chatStream` 五参调用与 `providers.ts` 一致;`rrfFuse` 接受 `number[][]` 与现有定义一致。
