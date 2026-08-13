# 命中片段截断优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_library` 命中片段改为按语义边界截断,并把"命中条数""摘录长度"做成可在 AI 设置里调的参数(默认 6 条 / 1200 字)。

**Architecture:** 新增纯函数 `truncateAtBoundary`;`agent.ts` 读两个设置(带钳制)并替换 `8`/`slice(0,700)`;两个 setting key 加入渲染层白名单;`KnowledgeSettingsTab` 加两个数字输入。检索/重排/翻译/范围逻辑不动。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、Vitest、React、既有 KV 设置系统(`getSetting` / `window.veridian.settings`)。

参见 spec:`docs/superpowers/specs/2026-08-13-chunk-truncation-design.md`

---

## Task 1: `truncateAtBoundary` 纯函数(TDD)

**Files:**
- Create: `src/main/knowledge/truncate.ts`
- Test: `src/main/knowledge/truncate.test.ts`

- [ ] **Step 1: 写失败测试** — `src/main/knowledge/truncate.test.ts`(tab 缩进):

```ts
import { describe, it, expect } from 'vitest'
import { truncateAtBoundary } from './truncate'

describe('truncateAtBoundary', () => {
	it('returns short text unchanged', () => {
		expect(truncateAtBoundary('hello', 20)).toBe('hello')
	})
	it('cuts at the last sentence end within budget', () => {
		const t = 'First sentence. Second sentence. Third goes over the limit here.'
		expect(truncateAtBoundary(t, 40)).toBe('First sentence. Second sentence.')
	})
	it('cuts at a paragraph break', () => {
		const t = 'Para one has enough text here.\n\nPara two continues well past the limit boundary.'
		expect(truncateAtBoundary(t, 45)).toBe('Para one has enough text here.')
	})
	it('hard-cuts when no boundary in the second half', () => {
		expect(truncateAtBoundary('x'.repeat(100), 30)).toBe('x'.repeat(30))
	})
	it('handles CJK sentence enders', () => {
		const t = '第一句话。第二句话。第三句话超过了限制字数继续写下去。'
		expect(truncateAtBoundary(t, 12)).toBe('第一句话。第二句话。')
	})
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/main/knowledge/truncate.test.ts` → 期望无法解析 `./truncate`。

- [ ] **Step 3: 实现** — `src/main/knowledge/truncate.ts`(tab 缩进):

```ts
// Truncate a chunk excerpt to `max` chars without cutting mid-sentence/-table:
// prefer the last paragraph break, then the last sentence end; only if that
// boundary keeps at least half the budget, else hard-cut.
export function truncateAtBoundary(text: string, max: number): string {
	if (text.length <= max) return text
	const slice = text.slice(0, max)
	const para = slice.lastIndexOf('\n\n')
	if (para >= max * 0.5) return slice.slice(0, para).trimEnd()
	const m = slice.match(/[\s\S]*[。！？.!?\n]/)
	if (m && m[0].length >= max * 0.5) return m[0].trimEnd()
	return slice.trimEnd()
}
```

- [ ] **Step 4: 跑测试确认通过** — `npx vitest run src/main/knowledge/truncate.test.ts` → 期望 5 通过。

- [ ] **Step 5: Commit**:
```bash
git add src/main/knowledge/truncate.ts src/main/knowledge/truncate.test.ts
git commit -m "feat: truncateAtBoundary -- boundary-aware excerpt truncation"
```

---

## Task 2: `agent.ts` 读设置并应用

**Files:** Modify `src/main/knowledge/agent.ts`

- [ ] **Step 1: import** — 顶部加(靠近其它 import):

```ts
import { getSetting } from '../services/SettingsService'
import { truncateAtBoundary } from './truncate'
```

- [ ] **Step 2: 加 `tunedInt` helper** — 放在 `wsId()` 附近:

```ts
/** Read a numeric setting, clamped to [min,max]; falls back to def when unset/invalid. */
function tunedInt(key: string, def: number, min: number, max: number): number {
	const v = getSetting(key)
	const n = typeof v === 'number' ? v : Number(v)
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def
}
```

- [ ] **Step 3: 改 `search_library` 分支** — 目前是:

```ts
	if (name === 'search_library') {
		const q = String(args.query ?? '').trim()
		if (!q) return 'error: empty query'
		const hits = await hybridSearch(wsId(), q, 8, filter)
		if (!hits.length) return 'no results'
		return hits.map((h) =>
			`[${h.itemKey}:${h.seq}] (${h.headingPath || 'text'})\n${h.text.slice(0, 700)}`
		).join('\n\n---\n\n')
	}
```
  改为:
```ts
	if (name === 'search_library') {
		const q = String(args.query ?? '').trim()
		if (!q) return 'error: empty query'
		const count = tunedInt('knowledge.search.resultCount', 6, 1, 12)
		const chars = tunedInt('knowledge.search.excerptChars', 1200, 200, 4000)
		const hits = await hybridSearch(wsId(), q, count, filter)
		if (!hits.length) return 'no results'
		return hits.map((h) =>
			`[${h.itemKey}:${h.seq}] (${h.headingPath || 'text'})\n${truncateAtBoundary(h.text, chars)}`
		).join('\n\n---\n\n')
	}
```

- [ ] **Step 4: typecheck + 测试** — `npm run typecheck`(无输出);`npm test`(全绿)。报确切数。

- [ ] **Step 5: Commit**:
```bash
git add src/main/knowledge/agent.ts
git commit -m "feat: search_library honors configurable result count + boundary truncation"
```

---

## Task 3: 设置写入白名单

**Files:** Modify `src/main/ipc/handlers.ts`

- [ ] **Step 1: 加两个 key** — 在 `RENDERER_WRITABLE_SETTINGS` 这个 `Set([...])` 里(`'ui.layout',` 之后、`])` 之前)加:

```ts
  // AI retrieval tuning (result count + excerpt length) -- plain numbers.
  'knowledge.search.resultCount', 'knowledge.search.excerptChars',
```

- [ ] **Step 2: typecheck** — `npm run typecheck` → 无输出。

- [ ] **Step 3: Commit**:
```bash
git add src/main/ipc/handlers.ts
git commit -m "feat: allow renderer to write knowledge.search.* tuning settings"
```

---

## Task 4: 设置 UI(`KnowledgeSettingsTab`)+ i18n

**Files:**
- Modify: `src/renderer/src/components/knowledge/KnowledgeSettingsTab.tsx`
- Modify: `src/renderer/src/i18n/index.ts`

先 READ `KnowledgeSettingsTab.tsx`。它用 `Section` 组件、`loadAll()`(一个 `Promise.all` of `settings.get`)、`saveField(key, value)`。

- [ ] **Step 1: 加 state** — 在其它 `useState` 附近:

```ts
	const [resultCount, setResultCount] = useState('6')
	const [excerptChars, setExcerptChars] = useState('1200')
```

- [ ] **Step 2: `loadAll` 载入两值** — 在 `loadAll` 的 `Promise.all([...])` 数组末尾(`indexStatus()` 那项之后)追加两项:

```ts
			window.veridian.settings.get('knowledge.search.resultCount'),
			window.veridian.settings.get('knowledge.search.excerptChars'),
```
  相应把解构数组末尾加两个变量(如 `, rc, ec`),并在函数体设置:
```ts
		setResultCount(typeof rc === 'number' ? String(rc) : '6')
		setExcerptChars(typeof ec === 'number' ? String(ec) : '1200')
```

- [ ] **Step 3: `saveField` 允许 number** — 把签名从 `(key: string, value: string | boolean)` 改为:
```ts
	async function saveField(key: string, value: string | boolean | number): Promise<void> {
```

- [ ] **Step 4: 加"检索"小节** — 在返回 JSX 里(存储 `Section` 之后、embedding 相关区块之前或其后,择一自然位置)插入:

```tsx
				<Section label={t('settings.knowledge.retrievalTitle')}>
					<div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
						{t('settings.knowledge.retrievalDesc')}
					</div>
					<div style={{ display: 'flex', gap: 16 }}>
						<label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--foreground-2)' }}>
							{t('settings.knowledge.resultCount')}
							<input
								type="number" min={1} max={12} value={resultCount}
								onChange={(e) => setResultCount(e.target.value)}
								onBlur={() => void saveField('knowledge.search.resultCount', Number(resultCount) || 6)}
								style={{ width: 90, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
							/>
						</label>
						<label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--foreground-2)' }}>
							{t('settings.knowledge.excerptChars')}
							<input
								type="number" min={200} max={4000} step={100} value={excerptChars}
								onChange={(e) => setExcerptChars(e.target.value)}
								onBlur={() => void saveField('knowledge.search.excerptChars', Number(excerptChars) || 1200)}
								style={{ width: 110, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
							/>
						</label>
					</div>
				</Section>
```

- [ ] **Step 5: i18n** — 在 `src/renderer/src/i18n/index.ts` 的 `settings.knowledge` 段(zh 与 en 各一处)加:
  - zh: `retrievalTitle: '检索',` `retrievalDesc: '控制每次搜索返回给 AI 的命中条数与每条摘录长度。',` `resultCount: '检索结果数',` `excerptChars: '摘录长度(字)',`
  - en: `retrievalTitle: 'Retrieval',` `retrievalDesc: 'How many hits and how much of each excerpt are sent to the AI per search.',` `resultCount: 'Result count',` `excerptChars: 'Excerpt length (chars)',`
  (先读该段确认 `settings.knowledge` 的确切结构再插入,匹配现有键的写法。)

- [ ] **Step 6: typecheck** — `npm run typecheck` → 无输出。

- [ ] **Step 7: Commit**:
```bash
git add src/renderer/src/components/knowledge/KnowledgeSettingsTab.tsx src/renderer/src/i18n/index.ts
git commit -m "feat: AI settings inputs for search result count + excerpt length"
```

---

## Task 5: App 内手动验证

**Files:** 无(验证)。

- [ ] **Step 1** — 若 dev server 未开则启动(先问用户是否已开着 app)。
- [ ] **Step 2 默认改善** — 不改设置提问一次;命中摘录应更完整(不再 700 硬切),句子/表格不被拦腰切。
- [ ] **Step 3 可调** — 在 AI 设置里把"检索结果数"改小(如 3)、"摘录长度"改大(如 2000),保存;再提问 → 命中条数与摘录长度随之变化。
- [ ] **Step 4 钳制** — 输入越界值(如 0 或 99999),不应崩溃(后端钳制到范围内)。
- [ ] **Step 5: 无需提交**。

---

## Self-Review

- **Spec 覆盖**:边界截断(Task 1 `truncateAtBoundary` + 5 单测)✅;两个可配置参数(Task 2 `tunedInt` 读取、Task 3 白名单、Task 4 UI)✅;默认 6/1200 且钳制 1–12 / 200–4000(Task 2)✅;默认即改善(`8`→`count`、`slice(0,700)`→`truncateAtBoundary`)✅;只改格式化步骤、其余不动✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:setting key `knowledge.search.resultCount` / `knowledge.search.excerptChars` 在 agent/handlers/UI 各处一致;`truncateAtBoundary(text, max)` 签名在 Task 1/2 一致;`saveField` 放宽为接受 `number`。
