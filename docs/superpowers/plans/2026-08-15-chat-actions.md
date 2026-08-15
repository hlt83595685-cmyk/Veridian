# 对话操作(复制/重新生成/编辑重问)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 对话补上复制答案、重新生成、编辑重问,均只作用于最后一轮。

**Architecture:** `agent.ts` 抽出 `runTurn` 供三条入口复用;新增 `regenerate` / `editLastAndResend` + IPC;前端在消息上加动作按钮 + 内联编辑。scope 保留、refs 不持久化。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、better-sqlite3、React、既有流式事件。

参见 spec:`docs/superpowers/specs/2026-08-15-chat-actions-design.md`

---

## Task 1: 后端 —— 抽 `runTurn`,加 `regenerate` / `editLastAndResend`

**Files:** Modify `src/main/knowledge/agent.ts`

- [ ] **Step 1: 加 scope 解析 helper** —— 在 `ask` 之前加:

```ts
function scopeToFilter(scope: number | null): import('./search').ScopeFilter | undefined {
	if (scope === IMPORTANT_SCOPE) {
		const ids = getDb().prepare('SELECT id FROM items WHERE starred = 1 AND deleted = 0').all() as { id: number }[]
		return { itemIds: ids.map((r) => r.id) }
	}
	if (scope !== null) {
		const ids = getDb().prepare('SELECT item_id FROM collection_items WHERE collection_id = ?').all(scope) as { item_id: number }[]
		return { itemIds: ids.map((r) => r.item_id) }
	}
	return undefined
}

function conversationFilter(convId: number): import('./search').ScopeFilter | undefined {
	const row = getKnowledgeDb().prepare('SELECT scope_collection_id FROM conversations WHERE id = ?')
		.get(convId) as { scope_collection_id: number | null } | undefined
	return scopeToFilter(row?.scope_collection_id ?? null)
}
```

- [ ] **Step 2: 加 `runTurn`** —— 在 helper 之后加(把原 `ask` 里 cfg 检查 → 循环 → 落库整段搬进来,`convId` 现为 non-null 故去掉 `!`):

```ts
function runTurn(convId: number, refs: KnowledgeRef[] | undefined, filter: import('./search').ScopeFilter | undefined): void {
	const cfg = getChatConfig()
	if (!cfg) {
		emit({ type: 'knowledge.chatState', conversationId: convId, state: 'error', detail: 'not_configured' })
		return
	}
	const kdb = getKnowledgeDb()
	const messages: ChatMessage[] = [
		{ role: 'system', content: buildSystemPrompt() },
		...resolveRefs(refs),
		...getMessages(convId).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
	]
	const tools = listInstalledSkills().length ? [...BASE_TOOLS, LOAD_SKILL_TOOL] : BASE_TOOLS
	const ac = new AbortController()
	abortControllers.set(convId, ac)
	const steps: RetrievalStep[] = []
	void (async () => {
		try {
			let finalText = ''
			for (let round = 0; round < MAX_ROUNDS; round++) {
				emit({ type: 'knowledge.chatState', conversationId: convId, state: round === 0 ? 'searching' : 'answering' })
				const result = await chatStream(cfg, messages, tools, (delta) => {
					emit({ type: 'knowledge.chatDelta', conversationId: convId, delta })
				}, ac.signal)
				if (result.toolCalls.length === 0) { finalText = result.content; break }
				messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
				for (const tc of result.toolCalls) {
					emit({ type: 'knowledge.chatState', conversationId: convId, state: 'searching', detail: tc.function.name })
					const { result: toolResult, step } = await runTool(tc.function.name, tc.function.arguments, filter)
					steps.push(step)
					emit({ type: 'knowledge.step', conversationId: convId, step })
					messages.push({ role: 'tool', content: toolResult, tool_call_id: tc.id })
				}
				finalText = result.content
			}
			const citations = resolveCitations(extractCitations(finalText))
			kdb.prepare('INSERT INTO messages (conversation_id, role, content, citations, steps) VALUES (?, ?, ?, ?, ?)')
				.run(convId, 'assistant', finalText, JSON.stringify(citations), JSON.stringify(steps))
			emit({ type: 'knowledge.chatState', conversationId: convId, state: 'done' })
		} catch (err) {
			const aborted = (err as Error).name === 'AbortError'
			if (!aborted) console.error('[knowledge] runTurn failed:', err)
			emit({ type: 'knowledge.chatState', conversationId: convId, state: aborted ? 'done' : 'error', detail: aborted ? 'stopped' : (err as Error).message })
		} finally {
			abortControllers.delete(convId)
		}
	})()
}
```

- [ ] **Step 3: 重写 `ask` 尾部改调 runTurn** —— 现有 `ask` 从 `const cfg = getChatConfig()` 到函数末尾的 `return convId` 之间(即 cfg 检查、filter 解析、messages/tools/循环那一大段)整体替换为:

```ts
	runTurn(convId, refs, scopeToFilter(scope))
	return convId
}
```
保留 `ask` 前半段(建/更新会话+scope、插入 user 消息)不变。`ask` 仍 `async`(签名兼容),内部不再 await。

- [ ] **Step 4: 加 `regenerate` / `editLastAndResend`** —— 在 `stopGeneration` 附近加:

```ts
export function regenerate(conversationId: number): void {
	const kdb = getKnowledgeDb()
	const last = kdb.prepare('SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
		.get(conversationId) as { id: number; role: string } | undefined
	if (!last) return
	if (last.role === 'assistant') kdb.prepare('DELETE FROM messages WHERE id = ?').run(last.id)
	runTurn(conversationId, [], conversationFilter(conversationId))
}

export function editLastAndResend(conversationId: number, newQuestion: string): void {
	const kdb = getKnowledgeDb()
	const lastUser = kdb.prepare("SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND role = 'user'")
		.get(conversationId) as { id: number | null }
	if (lastUser?.id == null) return
	kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, lastUser.id)
	kdb.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, 'user', newQuestion)
	runTurn(conversationId, [], conversationFilter(conversationId))
}
```

- [ ] **Step 5: typecheck + build + test** —— `npm run typecheck`(无输出);`npm run build`(成功);`npm test`(全绿)。报确切数。

- [ ] **Step 6: Commit**:
```bash
git add src/main/knowledge/agent.ts
git commit -m "feat: extract runTurn; add regenerate + editLastAndResend (last-turn)"
```

---

## Task 2: IPC —— regenerate / editResend

**Files:** `src/shared/ipc-contract.ts`, `src/main/ipc/handlers.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`

- [ ] **Step 1: 契约** —— `ipc-contract.ts` 的 `knowledge:*` 区加:
```ts
  'knowledge:regenerate':         z.tuple([id]),
  'knowledge:editResend':         z.tuple([id, z.string().min(1).max(4000)]),
```

- [ ] **Step 2: handlers** —— 在 `knowledge:stop` 附近加:
```ts
  'knowledge:regenerate':         (_e, conversationId: number) => Agent.regenerate(conversationId),
  'knowledge:editResend':         (_e, conversationId: number, question: string) => Agent.editLastAndResend(conversationId, question),
```

- [ ] **Step 3: preload** —— `knowledge` 对象里加:
```ts
    regenerate: (conversationId: number) => call('knowledge:regenerate', conversationId),
    editResend: (conversationId: number, question: string) => call('knowledge:editResend', conversationId, question),
```

- [ ] **Step 4: env.d.ts** —— `knowledge` 接口加:
```ts
    regenerate: (conversationId: number) => Promise<void>
    editResend: (conversationId: number, question: string) => Promise<void>
```

- [ ] **Step 5: typecheck** —— `npm run typecheck` → 无输出。

- [ ] **Step 6: Commit**:
```bash
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: knowledge:regenerate + knowledge:editResend IPC"
```

---

## Task 3: 前端 —— 动作按钮 + 内联编辑 + 接线

**Files:** `src/renderer/src/components/knowledge/ChatMessage.tsx`, `src/renderer/src/components/knowledge/KnowledgePage.tsx`, `src/renderer/src/styles/globals.css`, `src/renderer/src/i18n/index.ts`

- [ ] **Step 1: hover CSS** —— `globals.css` 末尾加:
```css
/* Message action buttons: revealed on hover of the message row. */
.msg-row .msg-actions { opacity: 0; transition: opacity 120ms var(--ease); display: flex; gap: 6px; }
.msg-row:hover .msg-actions { opacity: 1; }
.msg-actbtn { border: none; background: none; padding: 2px; cursor: pointer; color: var(--muted); display: inline-flex; }
.msg-actbtn:hover { color: var(--primary); }
```

- [ ] **Step 2: ChatMessage props + icons** —— `ChatMessage.tsx`:
  - `ChatMessageView` 签名加可选 props:`isLast?: boolean`、`onRegenerate?: () => void`、`onEditResend?: (text: string) => void`。
  - 在文件内加一个小图标组件(与活动流风格一致):
```tsx
function ActBtn({ title, onClick, path }: { title: string; onClick: () => void; path: string[] }): JSX.Element {
	return (
		<button className="msg-actbtn" title={title} onClick={onClick}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				{path.map((d, i) => <path key={i} d={d} />)}
			</svg>
		</button>
	)
}
const ICON_COPY = ['M8 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2']
const ICON_REGEN = ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M3 21v-5h5']
const ICON_EDIT = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']
```

- [ ] **Step 3: user 气泡加编辑** —— 把 `if (role === 'user')` 分支改为支持内联编辑(用组件内 `useState`):
```tsx
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(content)
	if (role === 'user') {
		return (
			<div className="msg-row" style={{ alignSelf: 'flex-end', maxWidth: '80%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
				{editing ? (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 360, maxWidth: '80vw' }}>
						<textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3}
							style={{ padding: 8, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--foreground)', fontSize: 13.5, resize: 'vertical' }} />
						<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
							<button className="msg-actbtn" onClick={() => { setEditing(false); setDraft(content) }}>{t('knowledge.cancel')}</button>
							<button className="btn-primary" style={{ padding: '4px 12px', borderRadius: 8, color: '#fff', fontSize: 12 }}
								onClick={() => { const v = draft.trim(); if (v) { setEditing(false); onEditResend?.(v) } }}>{t('knowledge.resend')}</button>
						</div>
					</div>
				) : (
					<>
						<div style={{ padding: '9px 13px', borderRadius: '14px 14px 4px 14px', background: 'var(--primary)', color: '#fff', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
							{content}
						</div>
						{isLast && onEditResend && (
							<div className="msg-actions">
								<ActBtn title={t('knowledge.edit')} path={ICON_EDIT} onClick={() => { setDraft(content); setEditing(true) }} />
							</div>
						)}
					</>
				)}
			</div>
		)
	}
```
  (`t('common.cancel')` 若无则用字面 "取消"/"Cancel";见 Step 6 i18n。)

- [ ] **Step 4: assistant 气泡加复制/重新生成** —— 在 assistant 分支的最外层 `<div style={{ alignSelf: 'flex-start', ... }}>` 上加 `className="msg-row"`,并在**来源列表之后、外层 div 结束前**加动作条:
```tsx
				{!streaming && (
					<div className="msg-actions" style={{ padding: '0 4px' }}>
						<ActBtn title={t('knowledge.copy')} path={ICON_COPY} onClick={() => void navigator.clipboard.writeText(content)} />
						{isLast && onRegenerate && <ActBtn title={t('knowledge.regenerate')} path={ICON_REGEN} onClick={onRegenerate} />}
					</div>
				)}
```

- [ ] **Step 5: KnowledgePage 接线** —— 计算最后一条 assistant / user 的 id,传 props 并实现回调:
  - 在 render 前:
```ts
		const lastId = messages[messages.length - 1]?.id
		const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id
```
  - `<ChatMessageView>` 传:
```tsx
							isLast={!busy && (m.role === 'assistant' ? m.id === lastId : m.id === lastUserId)}
							onRegenerate={m.role === 'assistant' && m.id === lastId ? () => regenerate() : undefined}
							onEditResend={m.role === 'user' && m.id === lastUserId ? (text) => editResend(text) : undefined}
```
  - 加两个函数(靠近 `send`):
```ts
	function regenerate(): void {
		if (conversationId === null || busyRef.current) return
		busyRef.current = true
		streamingRef.current = ''
		setMessages((prev) => prev.filter((m) => !(m.role === 'assistant' && m.id === prev[prev.length - 1]?.id)))
		setChatState('searching')
		void window.veridian.knowledge.regenerate(conversationId)
	}
	function editResend(text: string): void {
		if (conversationId === null || busyRef.current) return
		busyRef.current = true
		streamingRef.current = ''
		setMessages((prev) => {
			const lastUser = [...prev].reverse().find((m) => m.role === 'user')
			return prev
				.filter((m) => !(lastUser && m.role === 'assistant' && m.id > lastUser.id))
				.map((m) => (lastUser && m.id === lastUser.id ? { ...m, content: text } : m))
		})
		setChatState('searching')
		void window.veridian.knowledge.editResend(conversationId, text)
	}
```
  (`m.id` 为 `number | 'streaming'`;比较前排除 'streaming'——过滤时 `typeof m.id === 'number'` 已隐含,因流式态 busy 时按钮不显示。若 typecheck 报 `m.id > lastUser.id` 类型问题,用 `typeof m.id === 'number' && typeof lastUser.id === 'number' && m.id > lastUser.id`。)

- [ ] **Step 6: i18n** —— `i18n/index.ts` 顶层 `knowledge` 段(zh/en)加:
  - zh:`copy: '复制',` `regenerate: '重新生成',` `edit: '编辑',` `resend: '重新发送',` `cancel: '取消',`
  - en:`copy: 'Copy',` `regenerate: 'Regenerate',` `edit: 'Edit',` `resend: 'Resend',` `cancel: 'Cancel',`
  (全部放在顶层 `knowledge` 段,对应 `t('knowledge.copy')` 等。)

- [ ] **Step 7: typecheck + build** —— `npm run typecheck`(无输出);`npm run build`(成功)。

- [ ] **Step 8: Commit**:
```bash
git add src/renderer/src/components/knowledge/ChatMessage.tsx src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/styles/globals.css src/renderer/src/i18n/index.ts
git commit -m "feat: copy / regenerate / edit-and-resend actions on chat messages"
```

---

## Task 4: App 内手动验证

**Files:** 无。

- [ ] **Step 1** —— dev server 未开则启动(先问用户是否已开着 app)。
- [ ] **Step 2 复制** —— hover 助手回答 → 点复制 → 剪贴板得到该回答 markdown 原文。
- [ ] **Step 3 重新生成** —— 对最后一条回答点重新生成 → 旧答消失、重新流式出新答;若设过搜索范围,范围仍生效。
- [ ] **Step 4 编辑重问** —— 点最后一条自己提问的编辑 → 改文字 → 重新发送 → 旧回答被替换、按新问题重答。
- [ ] **Step 5 边界** —— 生成中(busy)时这些按钮不出现/不可点;未配置聊天模型时重新生成给出 not_configured 状态,不崩。
- [ ] **Step 6: 无需提交**。

---

## Self-Review
- **Spec 覆盖**:runTurn 抽取 + 三入口(Task 1)✅;scope 保留(`conversationFilter`)✅;refs 丢(regenerate/editResend 传 `[]`)✅;IPC(Task 2)✅;复制/重生成/编辑 UI + 仅最后一轮(Task 3 isLast)✅;busy 时禁用(`!busy`/`busyRef`)✅;not_configured(runTurn 保留)✅;编辑内联(Task 3 editing 态)✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:`regenerate`/`editLastAndResend`/`editResend`/`runTurn`/`scopeToFilter`/`conversationFilter` 各处签名一致;IPC 契约/handler/preload/env 四处签名一致;`m.id` 数字/`'streaming'` 联合类型在比较处按 note 处理。
