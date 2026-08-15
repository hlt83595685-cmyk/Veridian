# @ 提及改 chips 区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 选中 @ 文献即在输入框内成 📎 chip(textarea 不留 @文字);发送后气泡内部显示 chip,去掉气泡上方独立模块。全前端,不上 contenteditable。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、React。

参见 spec:`docs/superpowers/specs/2026-08-15-mention-chips-design.md`

---

## Task 1: 输入区改 chips(`KnowledgePage.tsx`)

**Files:** Modify `src/renderer/src/components/knowledge/KnowledgePage.tsx`

- [ ] **Step 1: PendingRef 改型** —— 接口由 `{ ref: KnowledgeRef; token: string }` 改为:
```ts
interface PendingRef { ref: KnowledgeRef; label: string }
```

- [ ] **Step 2: applyMention 改为删 @文字 + 加 chip(去重)** —— 整体替换:
```ts
	function applyMention(cand: MentionCandidate): void {
		if (!mention) return
		const cursor = textareaRef.current?.selectionStart ?? input.length
		const before = input.slice(0, mention.start)
		const after = input.slice(cursor)
		setInput(before + after)
		const refKey = (r: KnowledgeRef): string =>
			r.type === 'item' ? `item:${r.itemKey}` : r.type === 'file' ? `file:${r.path}` : `skill:${r.name}`
		setPendingRefs((prev) => prev.some((p) => refKey(p.ref) === refKey(cand.ref)) ? prev : [...prev, { ref: cand.ref, label: cand.label }])
		setMention(null)
		requestAnimationFrame(() => {
			textareaRef.current?.focus()
			textareaRef.current?.setSelectionRange(before.length, before.length)
		})
	}
```

- [ ] **Step 3: detectMention 去掉已提交判断** —— 整体替换(不再引用 pendingRefs):
```ts
	function detectMention(text: string, cursor: number): MentionTrigger {
		const head = text.slice(0, cursor)
		const at = head.match(/(?:^|\s)@([^@\n]*)$/)
		if (at) return { kind: 'at', start: cursor - at[1].length - 1, query: at[1] }
		const slash = head.match(/^\/(\S*)$/)
		if (slash) return { kind: 'slash', start: 0, query: slash[1] }
		return null
	}
```

- [ ] **Step 4: send 用全部 pendingRefs** —— 替换 `send` 里从 `const refs = ...` 到 `setMessages(...)` 之间的几行为:
```ts
		const refs = pendingRefs.map((p) => p.ref)
		const sentRefs = pendingRefs.map((p) => ({ type: p.ref.type, label: p.label }))
		setInput('')
		setPendingRefs([])
		setMention(null)
		streamingRef.current = ''
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [], refs: sentRefs }])
```
（其后 `setChatState('searching')` 与 `knowledge.ask(q, conversationId, refs.length ? refs : undefined, scopeCollectionId)` 不变。）

- [ ] **Step 5: chips 区 UI** —— 在输入列里 `</select>` 之后、`<textarea` 之前插入:
```tsx
							{pendingRefs.length > 0 && (
								<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
									{pendingRefs.map((p, i) => (
										<span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 260, padding: '2px 4px 2px 8px', borderRadius: 999, background: 'var(--muted-bg)', border: '1px solid var(--border)', color: 'var(--foreground-3)', fontSize: 11.5 }}>
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
											<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
											<button onClick={() => setPendingRefs((prev) => prev.filter((_, j) => j !== i))} title={t('knowledge.removeRef')} style={{ border: 'none', background: 'none', padding: '0 2px', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', flexShrink: 0 }}>
												<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
											</button>
										</span>
									))}
								</div>
							)}
```

- [ ] **Step 6: i18n** —— `i18n/index.ts` 顶层 `knowledge` 段 zh/en 各加 `removeRef: '移除',` / `removeRef: 'Remove',`。

- [ ] **Step 7: 清理** —— 若 `MentionCandidate` 的 `token` 字段现在只用于下拉 `key`,保留即可(不必删);确认没有其它地方仍引用 `PendingRef.token`(全局搜 `.token` 于本文件,除 MentionCandidate 的 token 外应无 PendingRef.token 残留)。

- [ ] **Step 8: typecheck + build** —— `npm run typecheck`(无输出);`npm run build`(成功)。修掉任何 `p.token`/类型残留报错。

- [ ] **Step 9: Commit**:
```bash
git add src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/i18n/index.ts
git commit -m "feat: @-mentions become removable chips in the composer (no inline @-text)"
```

---

## Task 2: 气泡内 chip(`ChatMessage.tsx`)

**Files:** Modify `src/renderer/src/components/knowledge/ChatMessage.tsx`

- [ ] **Step 1: 移除气泡上方 chips + 改到气泡内** —— 在用户分支非编辑态的 `<>...</>` 里:删除气泡 div **上方**那个 `{refs && refs.length > 0 && (<div ...>chips</div>)}` 块;把气泡 div 改为**内部**先渲染 chips、再渲染文字。整体把该 `<>` 内容替换为:
```tsx
					<>
						<div style={{ padding: '9px 13px', borderRadius: '14px 14px 4px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: 13.5, lineHeight: 1.55 }}>
							{refs && refs.length > 0 && (
								<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
									{refs.map((r, i) => (
										<span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 240, padding: '1px 8px', borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground-3)', fontSize: 11 }}>
											<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
											<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
										</span>
									))}
								</div>
							)}
							<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
						</div>
						{isLast && onEditResend && (
							<div className="msg-actions">
								<ActBtn title={t('knowledge.edit')} path={ICON_EDIT} onClick={() => { setDraft(content); setEditing(true) }} />
							</div>
						)}
					</>
```
(编辑态分支、`ActBtn`/`ICON_EDIT`、外层 `.msg-row` 容器均不动。)

- [ ] **Step 2: typecheck + build** —— `npm run typecheck`(无输出);`npm run build`(成功)。

- [ ] **Step 3: Commit**:
```bash
git add src/renderer/src/components/knowledge/ChatMessage.tsx
git commit -m "feat: show @-ref chips inside the user bubble (drop the above-bubble module)"
```

---

## Task 3: App 内手动验证

**Files:** 无。

- [ ] **Step 1** —— dev server 未开则启动(先问用户)。
- [ ] **Step 2 输入成 chip** —— 输入 `@` 选一篇 → 输入框内出现 📎 标题 chip,textarea 里**没有**"@标题"文字;可点 × 删除;可再 @ 加第二篇(重复同一篇不会重复加)。
- [ ] **Step 3 多词/技能** —— `@gold nano` 多词能搜到并成 chip;`/技能` 也成 chip。
- [ ] **Step 4 发送 + 气泡** —— 打问题文字 + chip → 发送 → 气泡**内**顶部显示 chip、下面是问题文字;气泡上方**无**独立模块。
- [ ] **Step 5 端到端** —— 该消息重新生成/编辑仍带 refs(直接读 md);刷新对话 chip 仍在。
- [ ] **Step 6: 无需提交**。

---

## Self-Review
- **Spec 覆盖**:PendingRef 改 label(Task 1)✅;applyMention 删@文字+加chip去重(Task 1)✅;detectMention 去掉 committed 判断(Task 1)✅;send 用全部 pendingRefs(Task 1)✅;输入 chips 区 + × 删除(Task 1)✅;气泡内 chip + 去上方模块(Task 2)✅;/ 技能同样成 chip(走同一 applyMention)✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:`PendingRef.label` 替换 `.token`;`refKey` 覆盖 item/file/skill;`sentRefs`/`DisplayMessage.refs` 与气泡 `refs` 一致;确认无 `p.token` 残留。
