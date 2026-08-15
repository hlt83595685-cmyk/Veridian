# 编辑=载回主输入框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 去掉气泡内联编辑;点编辑把消息载回主 composer(完整 @/chips/删除),发送即替换该轮(用新文字+新附件+当前 scope)。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、better-sqlite3、React。

参见 spec:`docs/superpowers/specs/2026-08-15-edit-in-composer-design.md`

---

## Task 1: 后端 `editLastAndResend(refs, scope)` + IPC

**Files:** `src/main/knowledge/agent.ts`, `src/shared/ipc-contract.ts`, `src/main/ipc/handlers.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`

- [ ] **Step 1: agent.ts** —— 整体替换 `editLastAndResend`:
```ts
export function editLastAndResend(conversationId: number, newQuestion: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null): void {
	const kdb = getKnowledgeDb()
	const lastUser = kdb.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
		.get(conversationId) as { id: number } | undefined
	if (!lastUser) return
	const scope = scopeCollectionId ?? null
	kdb.prepare('UPDATE conversations SET scope_collection_id = ? WHERE id = ?').run(scope, conversationId)
	kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, lastUser.id)
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(conversationId, 'user', newQuestion, JSON.stringify(enrichRefs(refs)))
	runTurn(conversationId, refs, scopeToFilter(scope))
}
```

- [ ] **Step 2: 契约** —— `ipc-contract.ts` 的 `knowledge:editResend` 改为:
```ts
  'knowledge:editResend':         z.tuple([id, z.string().min(1).max(4000), z.array(knowledgeRef).max(5).optional(), z.number().int().positive().nullable().optional()]),
```

- [ ] **Step 3: handler** —— `handlers.ts` 的 `knowledge:editResend` 改为:
```ts
  'knowledge:editResend':         (_e, conversationId: number, question: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null) =>
    Agent.editLastAndResend(conversationId, question, refs, scopeCollectionId),
```

- [ ] **Step 4: preload** —— `editResend` 改为:
```ts
    editResend: (conversationId: number, question: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null) =>
      call('knowledge:editResend', conversationId, question, refs, scopeCollectionId),
```

- [ ] **Step 5: env.d.ts** —— `editResend` 改为:
```ts
    editResend: (conversationId: number, question: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null) => Promise<void>
```
  (KnowledgeRef 已在 env.d.ts import;若无则 `import type { KnowledgeRef }` 已存在于 knowledge.ask 处,复用即可。)

- [ ] **Step 6: typecheck + build + test** —— 全绿。报数。

- [ ] **Step 7: Commit**:
```bash
git add src/main/knowledge/agent.ts src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: editResend takes new refs + scope (edit uses current attachments)"
```

---

## Task 2: `KnowledgePage.tsx` 编辑载回 composer

**Files:** `src/renderer/src/components/knowledge/KnowledgePage.tsx`, `src/renderer/src/i18n/index.ts`

- [ ] **Step 1: DisplayMessage.refs 扩为完整形**:
```ts
	refs?: { type: string; itemKey?: string; path?: string; name?: string; label: string }[]
```

- [ ] **Step 2: editing 状态** —— 在其它 useState 附近加:
```ts
	const [editing, setEditing] = useState<number | null>(null)
```

- [ ] **Step 3: send 支持编辑** —— 替换 `send()` 里从 `const refs = ...` 到函数结尾 `}` 为:
```ts
		const refs = pendingRefs.map((p) => p.ref)
		const sentRefs = pendingRefs.map((p) => ({ ...p.ref, label: p.label }))
		const wasEditing = editing !== null
		setInput('')
		setPendingRefs([])
		setMention(null)
		setEditing(null)
		streamingRef.current = ''
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [], refs: sentRefs }])
		setChatState('searching')
		if (wasEditing && conversationId !== null) {
			await window.veridian.knowledge.editResend(conversationId, q, refs.length ? refs : undefined, scopeCollectionId)
		} else {
			const id = await window.veridian.knowledge.ask(q, conversationId, refs.length ? refs : undefined, scopeCollectionId)
			setConversationId(id)
		}
	}
```

- [ ] **Step 4: 用 startEdit/cancelEdit 取代旧 editResend** —— 整体删除现有 `function editResend(text: string) {...}`,替换为:
```ts
	function startEdit(msg: DisplayMessage): void {
		if (busyRef.current) return
		setInput(msg.content)
		setPendingRefs((msg.refs ?? []).map((r) => ({
			ref: r.type === 'item' ? { type: 'item', itemKey: r.itemKey ?? '' }
				: r.type === 'file' ? { type: 'file', path: r.path ?? '' }
				: { type: 'skill', name: r.name ?? '' },
			label: r.label,
		})))
		setEditing(typeof msg.id === 'number' ? msg.id : null)
		setMessages((prev) => {
			const idx = prev.findIndex((m) => m.id === msg.id)
			return idx === -1 ? prev : prev.slice(0, idx)
		})
		requestAnimationFrame(() => textareaRef.current?.focus())
	}

	function cancelEdit(): void {
		setEditing(null)
		setInput('')
		setPendingRefs([])
		if (conversationId !== null) void refreshMessages(conversationId)
	}
```

- [ ] **Step 5: ChatMessageView 传 onEdit** —— 把渲染处的 `onEditResend={...}` 改为:
```tsx
							onEdit={m.role === 'user' && m.id === lastUserId ? () => startEdit(m) : undefined}
```
  (删掉旧 `onRegenerate` 保留不动;仅替换 onEditResend→onEdit。)

- [ ] **Step 6: composer 编辑指示 + 按钮文案** —— 在 chips strip(`{pendingRefs.length > 0 && ...}`)之前插入编辑指示条:
```tsx
							{editing !== null && (
								<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11.5, color: 'var(--muted)' }}>
									<span>{t('knowledge.editingNote')}</span>
									<button onClick={cancelEdit} style={{ border: 'none', background: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', fontSize: 11.5 }}>{t('knowledge.cancel')}</button>
								</div>
							)}
```
  发送按钮文案改为:
```tsx
									{editing !== null ? t('knowledge.update') : t('knowledge.send')}
```

- [ ] **Step 7: i18n** —— 顶层 `knowledge` 段 zh/en 加:
  - zh:`update: '更新',` `editingNote: '编辑中',`
  - en:`update: 'Update',` `editingNote: 'Editing',`

- [ ] **Step 8: typecheck + build** —— 全绿(注意 `startEdit`/`cancelEdit` 在 JSX 前声明即可,函数声明会提升)。

- [ ] **Step 9: Commit**:
```bash
git add src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/i18n/index.ts
git commit -m "feat: edit loads the message back into the composer (full @/chips)"
```

---

## Task 3: `ChatMessage.tsx` 去掉内联编辑

**Files:** `src/renderer/src/components/knowledge/ChatMessage.tsx`

- [ ] **Step 1: props** —— `ChatMessageView` 的 `onEditResend?: (text: string) => void` 改为 `onEdit?: () => void`(解构与类型都改)。
- [ ] **Step 2: 删内联编辑** —— 删除 `const [editing, setEditing] = useState(false)` 与 `const [draft, setDraft] = useState(content)`;把用户分支从 `{editing ? (...) : (<>...</>)}` 简化为直接渲染气泡(取非编辑态那份):
```tsx
	if (role === 'user') {
		return (
			<div className="msg-row" style={{ alignSelf: 'flex-end', maxWidth: '80%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
				<div style={{ padding: '9px 13px', borderRadius: '14px 14px 4px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: 13.5, lineHeight: 1.55 }}>
					{refs && refs.length > 0 && (
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
							{refs.map((r, i) => (
								<Chip key={i} icon={<PaperclipIcon size={10} />} label={r.label} size="sm" maxWidth={240} />
							))}
						</div>
					)}
					<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
				</div>
				{isLast && onEdit && (
					<div className="msg-actions">
						<ActBtn title={t('knowledge.edit')} path={ICON_EDIT} onClick={onEdit} />
					</div>
				)}
			</div>
		)
	}
```
- [ ] **Step 3: 清理 import** —— 若 `useState` 在 ChatMessage.tsx 已无其它用处,删除其 import(否则保留)。
- [ ] **Step 4: typecheck + build** —— 全绿。
- [ ] **Step 5: Commit**:
```bash
git add src/renderer/src/components/knowledge/ChatMessage.tsx
git commit -m "feat: drop inline bubble edit; edit button loads composer"
```

---

## Task 4: App 内手动验证

**Files:** 无。

- [ ] **Step 1** —— dev server 未开则启动(先问用户)。
- [ ] **Step 2 载入** —— 点某用户消息编辑 → 文字进入主输入框、附件成 chip;该消息+其回答从列表暂时消失;出现"编辑中·取消"、发送按钮变"更新"。
- [ ] **Step 3 完整功能** —— 编辑态可 `@` 加文献、× 删 chip、改文字。
- [ ] **Step 4 更新** —— 点"更新" → 替换原轮,按新文字+新附件作答(带附件时直接读 md 不多余搜)。
- [ ] **Step 5 取消** —— 点"取消" → 输入框清空、列表恢复原样(未丢消息)。
- [ ] **Step 6 回归** —— 普通发送、复制、重新生成、/技能、多词 @ 均正常。
- [ ] **Step 7: 无需提交**。

---

## Self-Review
- **Spec 覆盖**:editResend 收新 refs+scope(Task 1)✅;DisplayMessage.refs 完整形(Task 2)✅;send 编辑分支(Task 2)✅;startEdit/cancelEdit + editing 状态(Task 2)✅;composer 更新按钮+取消(Task 2)✅;去内联编辑、onEdit(Task 3)✅;取消不丢消息(cancelEdit refreshMessages)✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:`editResend`(IPC/preload/env/agent)四处签名一致;`onEdit` 取代 `onEditResend`;`msg.refs`→pendingRefs 重建的 KnowledgeRef 与联合类型一致;`sentRefs` 完整形与 DisplayMessage.refs 一致。
