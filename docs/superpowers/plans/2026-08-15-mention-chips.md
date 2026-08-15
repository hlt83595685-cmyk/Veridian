# @ 提及改 chips 区(可复用 Chip)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 抽出可复用 `Chip`/`PaperclipIcon`;选中 @ 文献即在输入框内成可删 chip(textarea 不留 @文字);发送后气泡内部显示 chip,去掉气泡上方模块。全前端,不上 contenteditable。

**Tech Stack:** TypeScript(strict, tabs, 无 `any`)、React。

参见 spec:`docs/superpowers/specs/2026-08-15-mention-chips-design.md`

---

## Task 1: 可复用 `Chip` 组件

**Files:** Create `src/renderer/src/components/knowledge/Chip.tsx`

- [ ] **Step 1: 建文件**(tab 缩进):
```tsx
import type { JSX } from 'react'

/** Shared paperclip line-icon (currentColor), used by ref chips. */
export function PaperclipIcon({ size = 11 }: { size?: number }): JSX.Element {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
			<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
		</svg>
	)
}

/** Reusable pill: optional leading icon, ellipsis label, optional remove (×)
 *  and/or whole-chip click. Reuse across composer / bubble / future filters. */
export function Chip({ label, icon, onRemove, onClick, title, size = 'md', maxWidth = 240 }: {
	label: string
	icon?: JSX.Element
	onRemove?: () => void
	onClick?: () => void
	title?: string
	size?: 'sm' | 'md'
	maxWidth?: number
}): JSX.Element {
	const fs = size === 'sm' ? 11 : 11.5
	return (
		<span
			onClick={onClick}
			title={title ?? label}
			style={{
				display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth,
				padding: onRemove ? '2px 4px 2px 8px' : '1px 8px', borderRadius: 999,
				background: 'var(--muted-bg)', border: '1px solid var(--border)',
				color: 'var(--foreground-3)', fontSize: fs, cursor: onClick ? 'pointer' : 'default',
			}}
		>
			{icon}
			<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
			{onRemove && (
				<button
					onClick={(e) => { e.stopPropagation(); onRemove() }}
					style={{ border: 'none', background: 'none', padding: '0 2px', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', flexShrink: 0 }}
					aria-label="remove"
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
				</button>
			)}
		</span>
	)
}
```

- [ ] **Step 2: typecheck** —— `npm run typecheck` → 无输出。（若 `import type { JSX }` 报错,改为不 import、直接用全局 `JSX.Element`——本项目其它 .tsx 用的是全局 `JSX.Element`,与之保持一致即可。）

- [ ] **Step 3: Commit**:
```bash
git add src/renderer/src/components/knowledge/Chip.tsx
git commit -m "feat: reusable Chip + PaperclipIcon components"
```

---

## Task 2: 输入区改 chips（`KnowledgePage.tsx`）

**Files:** Modify `src/renderer/src/components/knowledge/KnowledgePage.tsx`, `src/renderer/src/i18n/index.ts`

- [ ] **Step 1: import** —— 顶部加:
```ts
import { Chip, PaperclipIcon } from './Chip'
```

- [ ] **Step 2: PendingRef 改型**:
```ts
interface PendingRef { ref: KnowledgeRef; label: string }
```

- [ ] **Step 3: applyMention 删 @文字 + 加 chip(去重)** —— 整体替换:
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

- [ ] **Step 4: detectMention 去掉 committed 判断** —— 整体替换:
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

- [ ] **Step 5: send 用全部 pendingRefs** —— 替换 `send` 里 `const refs = ...` 到 `setMessages(...)` 之间为:
```ts
		const refs = pendingRefs.map((p) => p.ref)
		const sentRefs = pendingRefs.map((p) => ({ type: p.ref.type, label: p.label }))
		setInput('')
		setPendingRefs([])
		setMention(null)
		streamingRef.current = ''
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [], refs: sentRefs }])
```
（其后 `setChatState` 与 `knowledge.ask(...)` 不变。）

- [ ] **Step 6: chips 区 UI** —— 在输入列 `</select>` 之后、`<textarea` 之前插入:
```tsx
							{pendingRefs.length > 0 && (
								<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
									{pendingRefs.map((p, i) => (
										<Chip key={i} icon={<PaperclipIcon />} label={p.label} maxWidth={260}
											onRemove={() => setPendingRefs((prev) => prev.filter((_, j) => j !== i))} />
									))}
								</div>
							)}
```

- [ ] **Step 7: i18n** —— 顶层 `knowledge` 段 zh/en 加 `removeRef: '移除',` / `removeRef: 'Remove',`（Chip 的 × 用固定 aria-label 即可,无需 i18n;此键留作 title 备用,可省。若不用则跳过本步）。

- [ ] **Step 8: 残留检查** —— 全局搜本文件 `p.token` / `PendingRef` 旧用法,确保无残留。

- [ ] **Step 9: typecheck + build** —— `npm run typecheck`;`npm run build`。

- [ ] **Step 10: Commit**:
```bash
git add src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/i18n/index.ts
git commit -m "feat: @-mentions become removable chips in the composer (reuse Chip)"
```

---

## Task 3: 气泡内 chip（`ChatMessage.tsx`,复用 Chip）

**Files:** Modify `src/renderer/src/components/knowledge/ChatMessage.tsx`

- [ ] **Step 1: import** —— 加 `import { Chip, PaperclipIcon } from './Chip'`。

- [ ] **Step 2: chip 移到气泡内** —— 用户分支非编辑态 `<>...</>` 整体替换为(删掉气泡上方旧 chips 块,气泡内先渲染 chips 再渲染文字):
```tsx
					<>
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
						{isLast && onEditResend && (
							<div className="msg-actions">
								<ActBtn title={t('knowledge.edit')} path={ICON_EDIT} onClick={() => { setDraft(content); setEditing(true) }} />
							</div>
						)}
					</>
```
(编辑态分支、`ActBtn`/`ICON_EDIT`、外层 `.msg-row` 不动。)

- [ ] **Step 3: typecheck + build** —— `npm run typecheck`;`npm run build`。

- [ ] **Step 4: Commit**:
```bash
git add src/renderer/src/components/knowledge/ChatMessage.tsx
git commit -m "feat: @-ref chips inside the user bubble via shared Chip"
```

---

## Task 4: App 内手动验证

**Files:** 无。

- [ ] **Step 1** —— dev server 未开则启动(先问用户)。
- [ ] **Step 2 输入成 chip** —— `@` 选一篇 → 输入框内出现 📎 标题 chip,textarea 无"@标题"文字;× 可删;重复同一篇不重复加。
- [ ] **Step 3 多词/技能** —— `@gold nano` 多词成 chip;`/技能` 成 chip。
- [ ] **Step 4 发送 + 气泡** —— 问题文字 + chip → 发送 → 气泡**内**顶部显示 chip、下面文字;上方无独立模块。
- [ ] **Step 5 端到端** —— 重新生成/编辑仍带 refs(直接读 md);刷新 chip 仍在。
- [ ] **Step 6: 无需提交**。

---

## Self-Review
- **Spec 覆盖**:可复用 `Chip`/`PaperclipIcon`(Task 1)✅;输入区复用 Chip + 删@文字+去重(Task 2)✅;detectMention 去 committed(Task 2)✅;send 用全部 pendingRefs(Task 2)✅;气泡内 chip 复用 Chip、去上方模块(Task 3)✅;/ 技能同样成 chip✅。
- **占位符扫描**:无 TBD/TODO;代码步骤含完整代码。
- **类型一致性**:`Chip` props 在两处调用一致;`PendingRef.label` 替 `.token`;`refKey` 覆盖三类;`JSX.Element` 用法与项目一致(Task 1 Step 2 备注)。
