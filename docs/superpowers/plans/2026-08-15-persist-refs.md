# 持久化 @ 引用 + 气泡 chip + 中性用户气泡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 随用户消息持久化 @ refs(重新生成/编辑复用 → 直接读 md 不再多余搜索),气泡内以 chip 显示所附文献,用户气泡改中性浅色。

**Architecture:** `messages` 加 `refs` 列;`agent.ts` 存/读 refs;`getMessages` 带回;前端渲染 chip + 重排气泡样式。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、better-sqlite3、React。

参见 spec:`docs/superpowers/specs/2026-08-15-persist-refs-design.md`

---

## Task 1: DB 迁移 + `agent.ts` 存/读 refs

**Files:** Modify `src/main/knowledge/db.ts`, `src/main/knowledge/agent.ts`

### db.ts
- [ ] **Step 1: messages 加 refs 列 + 迁移** —— CREATE 里 `steps` 行后加:
```
			steps           TEXT NOT NULL DEFAULT '[]',
			refs            TEXT NOT NULL DEFAULT '[]'
```
  并在 messages 的迁移块旁加:
```ts
	const msgCols2 = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
	if (!msgCols2.some((c) => c.name === 'refs')) {
		db.exec("ALTER TABLE messages ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'")
	}
```
  (若已有一个 `const msgCols = ... table_info(messages)` 用于 steps,可复用它判断,不必新增变量;择一即可,避免重复声明。)

### agent.ts
- [ ] **Step 2: StoredRef 类型 + enrichRefs** —— 在 `resolveRefs` 附近加:
```ts
interface StoredRef { type: 'item' | 'file' | 'skill'; itemKey?: string; path?: string; name?: string; label: string }

// Enrich refs with a human label for display, resolved once at store time.
function enrichRefs(refs: KnowledgeRef[] | undefined): StoredRef[] {
	if (!refs?.length) return []
	return refs.map((r): StoredRef => {
		if (r.type === 'item') {
			const row = getDb().prepare('SELECT title FROM items WHERE key = ?').get(r.itemKey) as { title: string | null } | undefined
			return { type: 'item', itemKey: r.itemKey, label: row?.title ?? r.itemKey }
		}
		if (r.type === 'file') return { type: 'file', path: r.path, label: basename(r.path) }
		return { type: 'skill', name: r.name, label: r.name }
	})
}

function lastUserRefs(convId: number): KnowledgeRef[] {
	const row = getKnowledgeDb().prepare("SELECT refs FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
		.get(convId) as { refs: string } | undefined
	try { return JSON.parse(row?.refs || '[]') as KnowledgeRef[] } catch { return [] }
}
```

- [ ] **Step 3: MessageRow 加 refs** —— 改接口:
```ts
export interface MessageRow {
	id: number; conversation_id: number; role: string; content: string
	citations: string; created_at: number; steps: string; refs: string
}
```

- [ ] **Step 4: ask 存 refs** —— 把 `ask` 里插入用户消息那行改为:
```ts
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(convId, 'user', question, JSON.stringify(enrichRefs(refs)))
```
  (其后 `runTurn(convId, refs, scopeToFilter(scope))` 不变——本轮仍用原始 refs。)

- [ ] **Step 5: regenerate 复用 refs** —— 把 `regenerate` 里的 `runTurn(conversationId, [], conversationFilter(conversationId))` 改为:
```ts
	runTurn(conversationId, lastUserRefs(conversationId), conversationFilter(conversationId))
```

- [ ] **Step 6: editLastAndResend 复用 refs** —— 整体替换该函数:
```ts
export function editLastAndResend(conversationId: number, newQuestion: string): void {
	const kdb = getKnowledgeDb()
	const lastUser = kdb.prepare("SELECT id, refs FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
		.get(conversationId) as { id: number; refs: string } | undefined
	if (!lastUser) return
	let refs: KnowledgeRef[] = []
	try { refs = JSON.parse(lastUser.refs || '[]') as KnowledgeRef[] } catch { /* [] */ }
	kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, lastUser.id)
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(conversationId, 'user', newQuestion, JSON.stringify(refs))
	runTurn(conversationId, refs, conversationFilter(conversationId))
}
```

- [ ] **Step 7: typecheck + build + test** —— `npm run typecheck`;`npm run build`;`npm test`。报确切数。

- [ ] **Step 8: Commit**:
```bash
git add src/main/knowledge/db.ts src/main/knowledge/agent.ts
git commit -m "feat: persist @-refs per user message; reuse on regenerate/edit"
```

---

## Task 2: getMessages 返回 refs

**Files:** `src/preload/index.ts`, `src/renderer/src/env.d.ts`

- [ ] **Step 1: preload** —— `getMessages` 泛型对象末尾加 `; refs: string`(在 `steps: string` 之后)。
- [ ] **Step 2: env.d.ts** —— `getMessages` 返回类型同样加 `refs: string`(在 `steps: string` 后)。
- [ ] **Step 3: typecheck** —— 无输出。
- [ ] **Step 4: Commit**:
```bash
git add src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: getMessages returns persisted refs"
```

---

## Task 3: 前端 —— chip 显示 + 中性用户气泡

**Files:** `src/renderer/src/components/knowledge/ChatMessage.tsx`, `src/renderer/src/components/knowledge/KnowledgePage.tsx`

### KnowledgePage.tsx
- [ ] **Step 1: DisplayMessage 加 refs** —— 接口加:
```ts
	refs?: { type: string; label: string }[]
```

- [ ] **Step 2: refreshMessages 解析** —— map 里加:
```ts
			refs: JSON.parse(r.refs || '[]'),
```

- [ ] **Step 3: send 乐观带 refs** —— 在 `send()` 里,现有 `const refs = pendingRefs.filter((p) => q.includes(p.token)).map((p) => p.ref)` 之后新增:
```ts
		const sentRefs = pendingRefs.filter((p) => q.includes(p.token))
			.map((p) => ({ type: p.ref.type, label: p.token.replace(/^[@/]/, '') }))
```
  并把乐观用户消息那句加上 `refs: sentRefs`:
```ts
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [], refs: sentRefs }])
```
  (`refs` 变量仍传给 `knowledge.ask(...)` 不变。)

- [ ] **Step 4: 传 refs 给 ChatMessageView** —— 渲染处加 `refs={m.refs}`。
  editResend 的乐观更新保留原 refs(现有 `.map((m) => (m.id === lastUser.id ? { ...m, content: text } : m))` 已经 `...m`,天然保留 refs——无需改)。

### ChatMessage.tsx
- [ ] **Step 5: props 加 refs** —— `ChatMessageView` 解构 + 类型加 `refs?: { type: string; label: string }[]`。

- [ ] **Step 6: 用户气泡 chip + 中性色** —— 把用户分支的**非编辑态**(`) : (` 之后的 `<>...</>`)替换为:
```tsx
					<>
						{refs && refs.length > 0 && (
							<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end', maxWidth: '100%' }}>
								{refs.map((r, i) => (
									<span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 220, padding: '2px 8px', borderRadius: 999, background: 'var(--muted-bg)', border: '1px solid var(--border)', color: 'var(--foreground-3)', fontSize: 11 }}>
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
											<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
										</svg>
										<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
									</span>
								))}
							</div>
						)}
						<div style={{ padding: '9px 13px', borderRadius: '14px 14px 4px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
							{content}
						</div>
						{isLast && onEditResend && (
							<div className="msg-actions">
								<ActBtn title={t('knowledge.edit')} path={ICON_EDIT} onClick={() => { setDraft(content); setEditing(true) }} />
							</div>
						)}
					</>
```

- [ ] **Step 7: typecheck + build** —— `npm run typecheck`(无输出);`npm run build`(成功)。

- [ ] **Step 8: Commit**:
```bash
git add src/renderer/src/components/knowledge/ChatMessage.tsx src/renderer/src/components/knowledge/KnowledgePage.tsx
git commit -m "feat: show @-ref chips on user messages; neutral user bubble"
```

---

## Task 4: App 内手动验证

**Files:** 无。

- [ ] **Step 1** —— dev server 未开则启动(先问用户)。
- [ ] **Step 2 chip + 中性气泡** —— @ 一篇文献发问 → 用户气泡为**中性浅色**,上方有 **📎 标题** chip。
- [ ] **Step 3 重新生成保 refs** —— 对该回答重新生成 → 检索活动流里**没有 search_library**(或很少),模型直接基于附件作答;chip 仍在。
- [ ] **Step 4 编辑重问保 refs** —— 编辑该提问文字重发 → 附件 chip 保留、直接读 md 作答。
- [ ] **Step 5 持久化** —— 刷新/重开该对话 → chip 仍显示。
- [ ] **Step 6: 无需提交**。

---

## Self-Review
- **Spec 覆盖**:refs 迁移(Task 1)✅;enrichRefs 存 label(Task 1)✅;regenerate/edit 复用 refs → 直接读 md(Task 1 lastUserRefs/editLastAndResend)✅;getMessages 带 refs(Task 1/2)✅;chip 显示(Task 3)✅;乐观即时 chip(Task 3 send)✅;中性气泡(Task 3 Step 6)✅;editResend 保留 refs(`...m` + 后端沿用)✅;旧消息兼容(默认 `'[]'`)✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:`StoredRef`/`enrichRefs`/`lastUserRefs`/`MessageRow.refs`/`DisplayMessage.refs` 各处一致;`refs: string`(DB/IPC)↔ 解析后对象(前端);edit 复用 refs 前后签名一致。
