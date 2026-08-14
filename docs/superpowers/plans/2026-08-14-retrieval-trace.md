# 检索过程可观测(harness 活动流)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每条助手回答上方一个 harness 风格活动流:实时逐步显示 agent 的工具调用(搜索/读上下文/查信息/加载技能),搜索步显示 query + 命中论文 + 摘录字数;跑完折叠成一行、可再展开;持久化。

**Architecture:** 新增 `RetrievalStep` 类型与 `knowledge.step` 事件;`agent.ts` 每步 emit + 累积并随消息持久化(`messages.steps` 加列迁移);渲染层累积事件、解析持久化、用 `RetrievalTrace` 组件展示。检索/重排/翻译/范围/截断逻辑不动。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、better-sqlite3、Vitest、React、既有 domain-event 通道。

参见 spec:`docs/superpowers/specs/2026-08-14-retrieval-trace-design.md`

---

## Task 1: 共享类型 + 事件

**Files:** Modify `src/shared/types.ts`, `src/shared/events.ts`

- [ ] **Step 1: `RetrievalStep` 类型** — 在 `src/shared/types.ts` 末尾加:

```ts
// One agent action during a chat turn, shown in the retrieval-trace panel.
export interface RetrievalStep {
	tool: 'search_library' | 'read_context' | 'get_item_info' | 'load_skill'
	label: string                                          // query / itemKey:seq / itemKey / skill name
	hits?: { key: string; title: string; chars: number }[] // search_library only: hit papers + real excerpt length
}
```

- [ ] **Step 2: `knowledge.step` 事件** — 在 `src/shared/events.ts`:
  - 顶部若无则加 `import type { RetrievalStep } from './types'`。
  - 在 `knowledge.chatState` 变体之后加:
```ts
	| { type: 'knowledge.step'; conversationId: number; step: RetrievalStep }
```

- [ ] **Step 3: typecheck** — `npm run typecheck` → 无输出。

- [ ] **Step 4: Commit**:
```bash
git add src/shared/types.ts src/shared/events.ts
git commit -m "feat: RetrievalStep type + knowledge.step event"
```

---

## Task 2: `db.ts` 迁移 + `agent.ts` 后端

**Files:** Modify `src/main/knowledge/db.ts`, `src/main/knowledge/agent.ts`

### db.ts
- [ ] **Step 1: messages 加列 + 迁移** — 在 `CREATE TABLE IF NOT EXISTS messages (...)` 里 `created_at` 行后加一列:
```
			created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
			steps           TEXT NOT NULL DEFAULT '[]'
```
  并在幂等迁移区(和 conversations 的那段相邻)加:
```ts
	const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
	if (!msgCols.some((c) => c.name === 'steps')) {
		db.exec("ALTER TABLE messages ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'")
	}
```

### agent.ts
- [ ] **Step 2: import 类型** — 顶部加:
```ts
import type { RetrievalStep } from '../../shared/types'
```

- [ ] **Step 3: `MessageRow` 加 steps** — 改接口:
```ts
export interface MessageRow {
	id: number; conversation_id: number; role: string; content: string
	citations: string; created_at: number; steps: string
}
```
  (`getMessages` 用 `SELECT *`,自动带回 steps。)

- [ ] **Step 4: `runTool` 返回 `{ result, step }`** — 改签名并让每个分支产出 step。整段替换 `runTool`:

```ts
async function runTool(name: string, argsJson: string, filter?: import('./search').ScopeFilter): Promise<{ result: string; step: RetrievalStep }> {
	let args: Record<string, unknown>
	try { args = JSON.parse(argsJson || '{}') } catch { return { result: 'error: invalid arguments', step: { tool: 'search_library', label: '(bad args)' } } }

	if (name === 'search_library') {
		const q = String(args.query ?? '').trim()
		if (!q) return { result: 'error: empty query', step: { tool: 'search_library', label: '(empty)' } }
		const count = tunedInt('knowledge.search.resultCount', 6, 1, 12)
		const chars = tunedInt('knowledge.search.excerptChars', 1200, 200, 4000)
		const hits = await hybridSearch(wsId(), q, count, filter)
		const titleOf = new Map<string, string | null>()
		if (hits.length) {
			const keys = [...new Set(hits.map((h) => h.itemKey))]
			for (const r of getDb().prepare(`SELECT key, title FROM items WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys) as { key: string; title: string | null }[]) {
				titleOf.set(r.key, r.title)
			}
		}
		const excerpts = hits.map((h) => ({ h, text: truncateAtBoundary(h.text, chars) }))
		const step: RetrievalStep = {
			tool: 'search_library', label: q,
			hits: excerpts.map(({ h, text }) => ({ key: h.itemKey, title: titleOf.get(h.itemKey) ?? h.itemKey, chars: text.length })),
		}
		const result = hits.length
			? excerpts.map(({ h, text }) => `[${h.itemKey}:${h.seq}] (${h.headingPath || 'text'})\n${text}`).join('\n\n---\n\n')
			: 'no results'
		return { result, step }
	}

	if (name === 'get_item_info') {
		const key = String(args.item_key ?? '')
		const item = getDb().prepare(
			'SELECT id, title, year, journal, doi FROM items WHERE key = ? AND deleted = 0'
		).get(key) as { id: number; title: string | null; year: number | null; journal: string | null; doi: string | null } | undefined
		const step: RetrievalStep = { tool: 'get_item_info', label: key }
		if (!item) return { result: 'not found', step }
		const creators = getDb().prepare(`
			SELECT c.last_name, c.first_name FROM creators c
			JOIN item_creators ic ON ic.creator_id = c.id
			WHERE ic.item_id = ? ORDER BY ic.position LIMIT 10
		`).all(item.id) as { last_name: string; first_name: string | null }[]
		return { result: JSON.stringify({
			title: item.title, year: item.year, journal: item.journal, doi: item.doi,
			authors: creators.map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ')),
		}), step }
	}

	if (name === 'read_context') {
		const key = String(args.item_key ?? '')
		const seq = Number(args.seq)
		const step: RetrievalStep = { tool: 'read_context', label: `${key}:${Number.isFinite(seq) ? seq : '?'}` }
		if (!key || !Number.isFinite(seq)) return { result: 'error: bad arguments', step }
		const rows = getKnowledgeDb().prepare(`
			SELECT seq, heading_path, text FROM chunks
			WHERE workspace_id = ? AND item_key = ? AND seq BETWEEN ? AND ?
			ORDER BY seq
		`).all(wsId(), key, seq - 1, seq + 1) as { seq: number; heading_path: string; text: string }[]
		if (!rows.length) return { result: 'not found', step }
		return { result: rows.map((r) => `[${key}:${r.seq}] (${r.heading_path || 'text'})\n${r.text}`).join('\n\n'), step }
	}

	if (name === 'load_skill') {
		const skillName = String(args.name ?? '')
		const body = getSkillBody(skillName)
		return { result: body ?? 'not found', step: { tool: 'load_skill', label: skillName } }
	}

	return { result: 'error: unknown tool', step: { tool: 'search_library', label: `(unknown: ${name})` } }
}
```

- [ ] **Step 5: ask 循环:emit + 累积 step** — 在 `ask()` 里,进入 `void (async () => {` 之前建累积器:
```ts
	const steps: RetrievalStep[] = []
```
  循环里那段改为:
```ts
				for (const tc of result.toolCalls) {
					emit({ type: 'knowledge.chatState', conversationId: convId!, state: 'searching', detail: tc.function.name })
					const { result: toolResult, step } = await runTool(tc.function.name, tc.function.arguments, filter)
					steps.push(step)
					emit({ type: 'knowledge.step', conversationId: convId!, step })
					messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id })
				}
```

- [ ] **Step 6: 持久化 steps** — 助手消息 INSERT 改为带 steps:
```ts
				const citations = resolveCitations(extractCitations(finalText))
				kdb.prepare('INSERT INTO messages (conversation_id, role, content, citations, steps) VALUES (?, ?, ?, ?, ?)')
					.run(convId, 'assistant', finalText, JSON.stringify(citations), JSON.stringify(steps))
```

- [ ] **Step 7: typecheck + 测试** — `npm run typecheck`(无输出);`npm test`(全绿)。报确切数。

- [ ] **Step 8: Commit**:
```bash
git add src/main/knowledge/db.ts src/main/knowledge/agent.ts
git commit -m "feat: capture + persist per-turn retrieval steps; emit knowledge.step"
```

---

## Task 3: getMessages 返回类型带 steps

**Files:** Modify `src/preload/index.ts`, `src/renderer/src/env.d.ts`

- [ ] **Step 1: preload** — `getMessages` 的泛型返回类型加 `steps: string`:
```ts
    getMessages: (conversationId: number) =>
      call<Array<{ id: number; conversation_id: number; role: string; content: string; citations: string; created_at: number; steps: string }>>(
        'knowledge:getMessages', conversationId),
```

- [ ] **Step 2: env.d.ts** — 同步:
```ts
    getMessages: (conversationId: number) => Promise<Array<{
      id: number; conversation_id: number; role: string; content: string
      citations: string; created_at: number; steps: string
    }>>
```

- [ ] **Step 3: typecheck** — `npm run typecheck` → 无输出。

- [ ] **Step 4: Commit**:
```bash
git add src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: getMessages returns persisted steps"
```

---

## Task 4: `summarizeSteps` 纯函数(TDD)+ `RetrievalTrace` 组件

**Files:**
- Create: `src/renderer/src/components/knowledge/retrievalTrace.ts`
- Test: `src/renderer/src/components/knowledge/retrievalTrace.test.ts`
- Create: `src/renderer/src/components/knowledge/RetrievalTrace.tsx`

- [ ] **Step 1: 写失败测试** — `retrievalTrace.test.ts`(tab 缩进):
```ts
import { describe, it, expect } from 'vitest'
import { summarizeSteps } from './retrievalTrace'
import type { RetrievalStep } from '../../../../shared/types'

const steps: RetrievalStep[] = [
	{ tool: 'search_library', label: 'q1', hits: [{ key: 'A', title: 'A', chars: 100 }, { key: 'B', title: 'B', chars: 200 }] },
	{ tool: 'read_context', label: 'A:2' },
	{ tool: 'search_library', label: 'q2', hits: [{ key: 'A', title: 'A', chars: 150 }, { key: 'C', title: 'C', chars: 120 }] },
]

describe('summarizeSteps', () => {
	it('counts searches and unique sources', () => {
		expect(summarizeSteps(steps)).toEqual({ searches: 2, sources: 3 })
	})
	it('handles empty', () => {
		expect(summarizeSteps([])).toEqual({ searches: 0, sources: 0 })
	})
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/renderer/src/components/knowledge/retrievalTrace.test.ts`。

- [ ] **Step 3: 实现纯函数** — `retrievalTrace.ts`:
```ts
import type { RetrievalStep } from '../../../../shared/types'

/** Fold a turn's steps into the collapsed-summary numbers. */
export function summarizeSteps(steps: RetrievalStep[]): { searches: number; sources: number } {
	const keys = new Set<string>()
	let searches = 0
	for (const s of steps) {
		if (s.tool === 'search_library') searches++
		for (const h of s.hits ?? []) keys.add(h.key)
	}
	return { searches, sources: keys.size }
}
```

- [ ] **Step 4: 跑测试确认通过** — 同命令 → 2 通过。

- [ ] **Step 5: `RetrievalTrace` 组件** — `RetrievalTrace.tsx`(tab 缩进)。harness 风格:streaming 时展开逐步、done 时折叠一行可展开:
```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RetrievalStep } from '../../../../shared/types'
import { summarizeSteps } from './retrievalTrace'

const ICON: Record<RetrievalStep['tool'], string> = {
	search_library: '🔍', read_context: '📄', get_item_info: 'ℹ️', load_skill: '📎',
}

export function RetrievalTrace({ steps, streaming }: { steps: RetrievalStep[]; streaming?: boolean }): JSX.Element | null {
	const { t } = useTranslation('common')
	const [open, setOpen] = useState(false)
	if (!steps.length) return null
	const expanded = streaming || open
	const { searches, sources } = summarizeSteps(steps)

	return (
		<div style={{
			alignSelf: 'flex-start', maxWidth: '88%', marginBottom: 2,
			fontSize: 11.5, color: 'var(--muted)',
		}}>
			<button
				onClick={() => setOpen((v) => !v)}
				style={{ border: 'none', background: 'none', padding: 0, color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5 }}
			>
				{t('knowledge.traceSummary', { searches, sources })} {streaming ? '' : (open ? '▾' : '▸')}
			</button>
			{expanded && (
				<div style={{ marginTop: 4, borderLeft: '2px solid var(--border)', paddingLeft: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
					{steps.map((s, i) => (
						<div key={i}>
							<div style={{ color: 'var(--foreground-3)' }}>
								{ICON[s.tool]} {s.tool === 'search_library'
									? t('knowledge.traceSearch', { query: s.label, n: s.hits?.length ?? 0 })
									: `${s.tool} · ${s.label}`}
							</div>
							{s.hits && s.hits.length > 0 && (
								<div style={{ paddingLeft: 16, color: 'var(--muted)' }}>
									{s.hits.map((h, j) => (
										<div key={j} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
											{h.title} · {t('knowledge.traceChars', { n: h.chars })}
										</div>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
```

- [ ] **Step 6: typecheck + 测试** — `npm run typecheck`(无输出);`npx vitest run src/renderer/src/components/knowledge/retrievalTrace.test.ts`(2 通过)。

- [ ] **Step 7: Commit**:
```bash
git add src/renderer/src/components/knowledge/retrievalTrace.ts src/renderer/src/components/knowledge/retrievalTrace.test.ts src/renderer/src/components/knowledge/RetrievalTrace.tsx
git commit -m "feat: summarizeSteps + RetrievalTrace component (harness-style trace)"
```

---

## Task 5: 接入 `ChatMessage` + `KnowledgePage` + i18n

**Files:** Modify `src/renderer/src/components/knowledge/ChatMessage.tsx`, `src/renderer/src/components/knowledge/KnowledgePage.tsx`, `src/renderer/src/i18n/index.ts`

- [ ] **Step 1: ChatMessageView 渲染 trace** — `ChatMessage.tsx`:
  - import:`import { RetrievalTrace } from './RetrievalTrace'` 和 `import type { RetrievalStep } from '../../../../shared/types'`。
  - `ChatMessageView` 的 props 加 `steps?: RetrievalStep[]`。
  - 在助手分支(`return ( <div style={{ alignSelf:'flex-start', ...流式列 }}>`)最顶部、气泡 `<div>` 之前插入:
```tsx
				{role === 'assistant' && steps && steps.length > 0 && (
					<RetrievalTrace steps={steps} streaming={streaming} />
				)}
```
  (放在助手外层容器内、答案气泡上方。)

- [ ] **Step 2: KnowledgePage —— DisplayMessage 带 steps** — 顶部 `DisplayMessage` 接口加 `steps?: RetrievalStep[]`,并 `import type { RetrievalStep } from '../../../../shared/types'`。

- [ ] **Step 3: refreshMessages 解析 steps** — 把 map 改为:
```ts
		setMessages(rows.map((r) => ({
			id: r.id, role: r.role as 'user' | 'assistant', content: r.content,
			citations: JSON.parse(r.citations || '[]'),
			steps: JSON.parse(r.steps || '[]'),
		})))
```

- [ ] **Step 4: knowledge.step 事件累积** — 在事件 `useEffect` 的 `if/else if` 链里(`knowledge.chatDelta` 分支之后)加:
```ts
				} else if (e.type === 'knowledge.step') {
					if (e.conversationId !== activeConvIdRef.current) return
					setMessages((prev) => {
						const last = prev[prev.length - 1]
						if (last?.id === 'streaming') {
							return [...prev.slice(0, -1), { ...last, steps: [...(last.steps ?? []), e.step] }]
						}
						return [...prev, { id: 'streaming', role: 'assistant', content: streamingRef.current, citations: [], steps: [e.step] }]
					})
```
  (注意大括号配平:它是链上的一个 `else if` 分支。)

- [ ] **Step 5: 传 steps 给 ChatMessageView** — 渲染处加 `steps={m.steps}`:
```tsx
						<ChatMessageView
							key={m.id}
							role={m.role}
							content={m.content}
							citations={m.citations}
							steps={m.steps}
							streaming={m.id === 'streaming'}
						/>
```

- [ ] **Step 6: i18n** — `i18n/index.ts` 的**顶层 `knowledge`**段(chat 页用的那个,不是 settings.knowledge),zh 与 en 各加:
  - zh:`traceSummary: '🔍 检索 {{searches}} 次 · {{sources}} 篇来源',` `traceSearch: '搜索 "{{query}}" → {{n}} 条',` `traceChars: '{{n}} 字',`
  - en:`traceSummary: '🔍 {{searches}} searches · {{sources}} sources',` `traceSearch: 'Search "{{query}}" → {{n}} hits',` `traceChars: '{{n}} chars',`

- [ ] **Step 7: typecheck + 测试** — `npm run typecheck`(无输出);`npm test`(全绿)。

- [ ] **Step 8: Commit**:
```bash
git add src/renderer/src/components/knowledge/ChatMessage.tsx src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/i18n/index.ts
git commit -m "feat: show retrieval trace above answers (live + persisted)"
```

---

## Task 6: App 内手动验证

**Files:** 无(验证)。

- [ ] **Step 1** — 若 dev server 未开则启动(先问用户是否已开着 app)。
- [ ] **Step 2 实时** — 提一个问题:回答前/中应**实时逐步**出现活动流(🔍 搜索 … → N 条,展开见论文 + 摘录字数;读上下文等)。
- [ ] **Step 3 验证 #6** — 搜索步显示的**命中条数**应等于设置的"检索结果数",每条**摘录字数**≈"摘录长度"设置(边界截断,通常略小)。改设置后再问,数字随之变化。
- [ ] **Step 4 折叠/持久化** — 回答完活动流**折叠成一行**;点击可展开;**刷新/重开该对话**后仍能展开看到同样的过程。
- [ ] **Step 5: 无需提交**。

---

## Self-Review
- **Spec 覆盖**:RetrievalStep + knowledge.step(Task 1)✅;每步 emit + 持久化(Task 2)✅;messages.steps 迁移(Task 2)✅;getMessages 带 steps(Task 2/3)✅;实时累积(Task 5 step 事件)✅;折叠摘要 summarizeSteps + 单测(Task 4)✅;harness UI RetrievalTrace(Task 4)✅;搜索步显示论文+摘录字数(Task 2 hits.chars、Task 4 渲染)✅;持久化后重开可展开(Task 5 refreshMessages 解析)✅;不加新工具/不接 reasoning(全程未涉及)✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:`RetrievalStep` 在 shared/types 定义,agent/events/renderer 各处 `import type` 一致;`runTool` 返回 `{result, step}` 在 Task 2 内自洽;`steps: string`(DB/IPC)与 `RetrievalStep[]`(解析后)在边界处 `JSON.parse/stringify` 转换;i18n key `traceSummary/traceSearch/traceChars` 在 Task 5 定义与使用一致。
