# 检索范围(用户手动 + 每对话记忆)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 对话加可选"搜索范围"(全库/分类),把 `search_library` 限定到所选分类的条目,并按对话记忆范围。与 @ 提及正交、不改 `resolveRefs`。

**Architecture:** `hybridSearch` 加可选 `filter: { itemIds }`;`ask()` 把 `collectionId`(主库 `collection_items`)解析成 `itemIds` 透传给工具循环;范围存 `conversations.scope_collection_id`(幂等加列迁移),切换对话时恢复。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、better-sqlite3、Vitest、React。

参见 spec:`docs/superpowers/specs/2026-08-13-search-scope-design.md`

---

## Task 1: `search.ts` 过滤管道 + `scopeClause`(含单测)

**Files:**
- Modify: `src/main/knowledge/search.ts`
- Test: `src/main/knowledge/search.test.ts`(追加)

- [ ] **Step 1: 写失败测试** — 在 `src/main/knowledge/search.test.ts` 顶部 import 追加 `scopeClause`,并加一个 describe(tab 缩进):

```ts
import { rrfFuse, toFtsQuery, scopeClause } from './search'
```

```ts
describe('scopeClause', () => {
	it('is empty for no filter', () => {
		expect(scopeClause('c.item_id', undefined)).toBe('')
	})
	it('is empty for empty itemIds', () => {
		expect(scopeClause('c.item_id', { itemIds: [] })).toBe('')
	})
	it('builds an IN clause from itemIds', () => {
		expect(scopeClause('c.item_id', { itemIds: [3, 7] })).toBe(' AND c.item_id IN (3,7)')
	})
})
```

- [ ] **Step 2: 跑测试确认失败** — `npx vitest run src/main/knowledge/search.test.ts` → 期望 `scopeClause is not a function`。

- [ ] **Step 3: 加类型 + helper** — 在 `search.ts` 的 `const CANDIDATES = 30` 附近加:

```ts
export interface ScopeFilter { itemIds: number[] }

/** SQL `AND <col> IN (...)` fragment restricting to a collection's items, or ''
 *  for whole-library / empty scope. itemIds are trusted DB integers. */
export function scopeClause(col: string, filter?: ScopeFilter): string {
	return filter && filter.itemIds.length ? ` AND ${col} IN (${filter.itemIds.join(',')})` : ''
}
```

- [ ] **Step 4: `ftsSearch` 加 filter** — 替换整个 `ftsSearch`:

```ts
function ftsSearch(wsId: number, query: string, filter?: ScopeFilter): number[] {
	const kdb = getKnowledgeDb()
	try {
		return (kdb.prepare(`
			SELECT f.rowid AS id
			FROM fts_chunks f
			JOIN chunks c ON c.id = f.rowid
			WHERE fts_chunks MATCH ? AND c.workspace_id = ?${scopeClause('c.item_id', filter)}
			ORDER BY bm25(fts_chunks)
			LIMIT ${CANDIDATES}
		`).all(toFtsQuery(query), wsId) as { id: number }[]).map((r) => r.id)
	} catch {
		return []   // malformed query after sanitizing shouldn't kill the search
	}
}
```

- [ ] **Step 5: `vectorSearch` 加 filter** — 改签名为 `async function vectorSearch(wsId: number, query: string, filter?: ScopeFilter): Promise<number[]>`,并在两处 chunks 查询加 scope:

  vec0 路径的 workspace 过滤查询改为:
```ts
				const inWs = new Set((kdb.prepare(
					`SELECT id FROM chunks WHERE workspace_id = ? AND id IN (${ids.join(',')})${scopeClause('item_id', filter)}`
				).all(wsId) as { id: number }[]).map((r) => r.id))
```
  JS cosine 回退的查询改为(注意从字符串字面量改成模板串):
```ts
		const rows = kdb.prepare(
			`SELECT id, embedding FROM chunks WHERE workspace_id = ? AND embedded = 1 AND embedding IS NOT NULL${scopeClause('item_id', filter)}`
		).all(wsId) as { id: number; embedding: Buffer }[]
```

- [ ] **Step 6: `runQuery` + `hybridSearch` 透传 filter** — 替换 `runQuery` 与 `hybridSearch` 头部:

```ts
/** FTS + vector rank lists for one query string, optionally scoped. */
async function runQuery(wsId: number, query: string, filter?: ScopeFilter): Promise<number[][]> {
	const [fts, vec] = await Promise.all([
		Promise.resolve(ftsSearch(wsId, query, filter)),
		vectorSearch(wsId, query, filter),
	])
	return [fts, vec]
}

export async function hybridSearch(wsId: number, query: string, topK = 8, filter?: ScopeFilter): Promise<SearchHit[]> {
	// Scope set but the collection is empty (or deleted) => no results.
	if (filter && !filter.itemIds.length) return []
	// Retrieve the original query while translating it in parallel; a Chinese
	// query also gets an English pass so BM25 can match English papers. Fuse all
	// rank lists. Non-Chinese queries / translation failure => original only.
	const [origLists, translated] = await Promise.all([
		runQuery(wsId, query, filter),
		translateForSearch(query),
	])
	const rankLists = translated ? [...origLists, ...(await runQuery(wsId, translated, filter))] : origLists
	const fused = rrfFuse(rankLists)
```

(其余 `pool`/hydrate/`rerankHits(query, candidates, topK)` 不动。)

- [ ] **Step 7: typecheck + 测试** — `npm run typecheck`(无输出);`npm test` 全绿(报确切数)。

- [ ] **Step 8: Commit**:
```bash
git add src/main/knowledge/search.ts src/main/knowledge/search.test.ts
git commit -m "feat: optional item-id scope filter in hybridSearch (search.ts)"
```

---

## Task 2: `db.ts` 迁移 + `agent.ts` 范围解析/透传/持久化

**Files:**
- Modify: `src/main/knowledge/db.ts`
- Modify: `src/main/knowledge/agent.ts`

- [ ] **Step 1: conversations 加列(CREATE + 幂等迁移)** — `db.ts` 中 `CREATE TABLE IF NOT EXISTS conversations (...)` 里 `created_at` 行后加一列:

```
			created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
			scope_collection_id INTEGER
```

  并在 `db.exec(`...`)` 之后、`return db` 之前加幂等迁移(应对已存在的旧库):

```ts
	// Additive migration: older DBs have `conversations` without this column.
	const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
	if (!convCols.some((c) => c.name === 'scope_collection_id')) {
		db.exec('ALTER TABLE conversations ADD COLUMN scope_collection_id INTEGER')
	}
```

- [ ] **Step 2: `ConversationRow` + `listConversations` 带上 scope** — `agent.ts`:

  接口加字段:
```ts
export interface ConversationRow { id: number; title: string; created_at: number; scope_collection_id: number | null }
```
  查询改为:
```ts
export function listConversations(): ConversationRow[] {
	return getKnowledgeDb().prepare(
		'SELECT id, title, created_at, scope_collection_id FROM conversations WHERE workspace_id = ? ORDER BY id DESC LIMIT 100'
	).all(wsId()) as ConversationRow[]
}
```

- [ ] **Step 3: `runTool` 加 filter** — 改签名并把 filter 传给 search:

```ts
async function runTool(name: string, argsJson: string, filter?: import('./search').ScopeFilter): Promise<string> {
```
  `search_library` 分支里:
```ts
		const hits = await hybridSearch(wsId(), q, 8, filter)
```

- [ ] **Step 4: `ask()` 加 scope 参数、解析、持久化、透传** — 改 `ask`:

  签名:
```ts
export async function ask(question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null): Promise<number> {
```
  会话建/存 scope —— 替换建会话与首条消息之间那段:
```ts
	let convId = conversationId
	const scope = scopeCollectionId ?? null
	if (convId === null) {
		const info = kdb.prepare('INSERT INTO conversations (workspace_id, title, scope_collection_id) VALUES (?, ?, ?)')
			.run(ws, question.slice(0, 60), scope)
		convId = Number(info.lastInsertRowid)
	} else {
		kdb.prepare('UPDATE conversations SET scope_collection_id = ? WHERE id = ?').run(scope, convId)
	}
```
  解析 itemIds(在取 `cfg` 之后、进入循环之前的合适位置,例如紧挨 `const tools = ...` 上方):
```ts
	// Resolve the collection scope (main library DB) to a chunk item-id filter.
	let filter: import('./search').ScopeFilter | undefined
	if (scope !== null) {
		const ids = getDb().prepare('SELECT item_id FROM collection_items WHERE collection_id = ?')
			.all(scope) as { item_id: number }[]
		filter = { itemIds: ids.map((r) => r.item_id) }
	}
```
  工具调用透传 filter —— 循环里那行改为:
```ts
					const toolResult = await runTool(tc.function.name, tc.function.arguments, filter)
```

- [ ] **Step 5: typecheck + 测试** — `npm run typecheck`(无输出);`npm test` 全绿。

- [ ] **Step 6: Commit**:
```bash
git add src/main/knowledge/db.ts src/main/knowledge/agent.ts
git commit -m "feat: persist per-conversation scope; resolve collection to item-id filter"
```

---

## Task 3: IPC —— `knowledge:ask` 加 scope、`listConversations` 返回 scope

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`

- [ ] **Step 1: 契约** — `ipc-contract.ts` 的 `knowledge:ask` 加第 4 参:

```ts
  'knowledge:ask':                z.tuple([z.string().min(1).max(4000), id.nullable(), z.array(knowledgeRef).max(5).optional(), z.number().int().positive().nullable().optional()]),
```

- [ ] **Step 2: handler** — `handlers.ts` 的 `'knowledge:ask'` 改为透传第 4 参:

```ts
  'knowledge:ask':                (_e, question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null) =>
    Agent.ask(question, conversationId, refs, scopeCollectionId),
```

- [ ] **Step 3: preload** — `preload/index.ts` 的 `knowledge.ask`:

```ts
    ask: (question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null) =>
      call<number>('knowledge:ask', question, conversationId, refs, scopeCollectionId),
```
  并给 `listConversations` 的返回类型加 `scope_collection_id`:
```ts
    listConversations: () =>
      call<Array<{ id: number; title: string; created_at: number; scope_collection_id: number | null }>>('knowledge:listConversations'),
```

- [ ] **Step 4: env.d.ts** — 同步类型:

```ts
    ask: (question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null) => Promise<number>
    listConversations: () => Promise<Array<{ id: number; title: string; created_at: number; scope_collection_id: number | null }>>
```

- [ ] **Step 5: typecheck** — `npm run typecheck` → 无输出。

- [ ] **Step 6: Commit**:
```bash
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: thread scopeCollectionId through knowledge:ask IPC"
```

---

## Task 4: `KnowledgePage` 范围选择器 UI

**Files:**
- Modify: `src/renderer/src/components/knowledge/KnowledgePage.tsx`

- [ ] **Step 1: 类型 + import** — 顶部 `ConversationRow` 加字段;确保 `Collection` 类型可用:

```ts
interface ConversationRow { id: number; title: string; created_at: number; scope_collection_id: number | null }
```
  在 `import type { Item } from '../../../../shared/types'` 处一并引入 `Collection`:
```ts
import type { Item, Collection } from '../../../../shared/types'
```

- [ ] **Step 2: state + 载入分类** — 在其它 `useState` 附近加:

```ts
	const [collections, setCollections] = useState<Collection[]>([])
	const [scopeCollectionId, setScopeCollectionId] = useState<number | null>(null)
```
  在已有的 mount `useEffect`(拉取会话/仓库树的那个)里追加一次分类载入(或新增一个 useEffect):
```ts
	useEffect(() => {
		window.veridian.collections.getAll().then((c) => setCollections(c as Collection[])).catch(() => setCollections([]))
	}, [])
```

- [ ] **Step 3: 切换/新建对话时同步范围** — `startNewConversation` 里加 `setScopeCollectionId(null)`;`openConversation` 里按会话行恢复:

```ts
	function startNewConversation(): void {
		setScopeCollectionId(null)
		// ...existing body...
	}

	async function openConversation(id: number): Promise<void> {
		const row = conversations.find((c) => c.id === id)
		// Restore the saved scope, but fall back to whole-library if that
		// collection was since deleted (not in the loaded list).
		const saved = row?.scope_collection_id ?? null
		setScopeCollectionId(saved !== null && collections.some((c) => c.id === saved) ? saved : null)
		setConversationId(id)
		await refreshMessages(id)
	}
```
  (保留 `openConversation` 原有的 `setConversationId(id)` / `refreshMessages(id)`;若与上面重复只保留一份。)

- [ ] **Step 4: send 传 scope** — `send()` 里的 ask 调用改为带第 4 参:

```ts
		const id = await window.veridian.knowledge.ask(q, conversationId, refs.length ? refs : undefined, scopeCollectionId)
```

- [ ] **Step 5: 选择器 UI** — 在输入区(`<textarea>` 所在容器)上方或旁边加一个下拉。放在 textarea 前:

```tsx
						<select
							value={scopeCollectionId ?? ''}
							onChange={(e) => setScopeCollectionId(e.target.value ? Number(e.target.value) : null)}
							title={t('knowledge.scopeSelectTitle')}
							style={{
								alignSelf: 'flex-start', marginBottom: 6, height: 26, padding: '0 8px',
								borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
								background: 'var(--surface)', color: 'var(--foreground-2)', fontSize: 12,
							}}
						>
							<option value="">{t('knowledge.scopeWholeLibrary')}</option>
							{collections.map((c) => (
								<option key={c.id} value={c.id}>{c.name}</option>
							))}
						</select>
```

- [ ] **Step 6: i18n** — 在 `src/renderer/src/i18n/index.ts` 的 `zh`/`en` 的 `knowledge` 段加:
  - zh: `scopeWholeLibrary: '全库',` 和 `scopeSelectTitle: '搜索范围',`
  - en: `scopeWholeLibrary: 'Whole library',` 和 `scopeSelectTitle: 'Search scope',`

- [ ] **Step 7: typecheck** — `npm run typecheck` → 无输出。

- [ ] **Step 8: Commit**:
```bash
git add src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/i18n/index.ts
git commit -m "feat: search-scope selector in the AI chat (whole library / collection)"
```

---

## Task 5: App 内手动验证

**Files:** 无(验证)。

- [ ] **Step 1** — 确认已配置聊天模型;若 dev server 未开则启动(先问用户是否已开着 app)。
- [ ] **Step 2 范围生效** — 选一个分类为范围,就该分类内文献提问 → 只命中该分类;换"全库"再问 → 命中范围更广。
- [ ] **Step 3 每对话记忆** — 设范围后开新对话(应回到全库),再切回旧对话 → 范围应恢复为之前所选。
- [ ] **Step 4 @ 兼容** — 选一个分类范围,同时 @ 一篇**范围外**的文献提问 → agent 仍能读到并引用该 @ 文献(证明 @ 注入不受范围影响)。
- [ ] **Step 5 回退** — 不选范围(全库)问一次 → 行为与之前一致。
- [ ] **Step 6: 无需提交**。

---

## Self-Review

- **Spec 覆盖**:手动分类范围(Task 4 选择器)✅;可选默认全库(`scopeCollectionId` 默认 null、`filter` undefined 时行为不变)✅;每对话记忆(Task 2 迁移+持久化、Task 4 恢复)✅;跨库解析 collectionId→itemIds(Task 2 主库 `collection_items`)✅;FTS+向量过滤(Task 1 `scopeClause` 两处)✅;空分类→无结果(Task 1 短路)✅;与 @ 兼容(`resolveRefs` 全程不改)✅;分类删除回落全库(Task 4 openConversation 校验)✅。
- **占位符扫描**:无 TBD/TODO;所有代码步骤含完整代码。
- **类型一致性**:`ScopeFilter` 定义于 search.ts,agent.ts 用 `import('./search').ScopeFilter` 引用;`scope_collection_id` 在 db/agent/ipc/preload/env/KnowledgePage 各处命名一致;`knowledge:ask` 第 4 参在契约/handler/preload/env/调用处签名一致。
