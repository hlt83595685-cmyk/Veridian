# P2-A · 笔记 + 双链(Wikilinks / Backlinks)—— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1 的 `notes`/`relations` 之上做 Obsidian 式双链:论文笔记 + 独立笔记(概念页),`[[标题]]` 保存时解析进 `relations`(`rel_type='wikilink'`),反向链接反查,笔记页/详情页可编辑与跳转。

**Architecture:** 后端扩展 notes/relations/items 仓储 + 一个纯函数 `wikilinks.ts`(正则提取 + 标题解析)+ `NoteService.saveNote`(保存即对账出链边)+ notes:* IPC。前端:共享 `NoteEditor`(textarea + `[[` 补全 + react-markdown/remark-wiki-link 预览,编辑/预览切换)、`Backlinks`、独立 `NotePage`(中区查看器,镜像 itemStore 查看器模式),详情页"笔记"标签接入,wikilink 点击导航/未解析建页。

**Tech Stack:** TypeScript(strict, TABS), better-sqlite3, vitest, React 18, zustand, react-markdown(+ remark-gfm/remark-math 已在用),新增 `remark-wiki-link`。

**验证规则:** 不要 `npm rebuild better-sqlite3`/electron-rebuild(DB 测试在 Electron ABI 下 `describe.skip`,正常)。每任务:`npx tsc -p tsconfig.node.json --noEmit`、`npx tsc -p tsconfig.web.json --noEmit`、`npx vitest run <file>`;渲染器任务必跑 `npm run build`。DB 仓储测试沿用现有 `dbUsable`/`describe.skip` + `vi.mock('./index')` 模式(见 `src/main/db/relations.test.ts`)。

---

## 文件结构

| 文件 | 职责 | 新建/修改 |
|---|---|---|
| `src/main/db/notes.ts` | 增 `listStandaloneNotes`/`findNoteByTitle` | 修改 |
| `src/main/db/items.ts` | 增 `findItemByTitle` | 修改 |
| `src/main/db/relations.ts` | 增 `setWikilinksForNote`/`listBacklinks`/`deleteRelationsForNote` | 修改 |
| `src/main/knowledge/wikilinks.ts` | `extractWikiTargets`(正则)+ `resolveWikiTargets` | 新建 |
| `src/main/services/NoteService.ts` | `saveNote`/`getBacklinks`/`deleteNote`/`listStandalone` | 修改 |
| `src/shared/ipc-contract.ts` / `handlers.ts` / `preload/index.ts` / `env.d.ts` | notes:* 通道 | 修改 |
| `src/renderer/src/stores/itemStore.ts` | `noteViewerId` + `openNote/closeNote` | 修改 |
| `src/renderer/src/components/notes/NoteEditor.tsx` | 编辑器(补全+预览+切换) | 新建 |
| `src/renderer/src/components/notes/Backlinks.tsx` | 反链列表 | 新建 |
| `src/renderer/src/components/notes/NotePage.tsx` | 独立笔记页(中区) | 新建 |
| `src/renderer/src/components/notes/wikiMarkdown.tsx` | remark-wiki-link 配置 + `[[]]` 点击处理 | 新建 |
| `src/renderer/src/components/layout/MainLayout.tsx` | 中区接入 NotePage | 修改 |
| `src/renderer/src/components/detail-panel/DetailPane.tsx` | "笔记"标签接 NoteEditor + Backlinks | 修改 |
| `src/renderer/src/components/item-tree/CollectionPane.tsx` | 左栏"笔记"列表 + 新建 | 修改 |
| `src/renderer/src/i18n/index.ts` | 文案 | 修改 |

依赖顺序:1 notes/items 仓储 → 2 relations 仓储 → 3 wikilinks → 4 NoteService → 5 IPC → 6 NoteEditor(+装 remark-wiki-link)→ 7 详情页笔记标签 → 8 NotePage + 左栏 + 导航 → 9 验证。

---

## Task 1: notes/items 仓储扩展

**Files:** Modify `src/main/db/notes.ts`, `src/main/db/items.ts`; Test `src/main/db/notes.test.ts`(增用例)

- [ ] **Step 1: 写失败测试** 追加到 `src/main/db/notes.test.ts` 的 `suite('notes repo', ...)` 内(该文件已用 `dbUsable`/`vi.mock('./index')`,内存表含 notes):

```typescript
	it('lists standalone notes (item_id NULL) newest first', () => {
		createNote({ itemId: 7, content: 'paper note' })
		createNote({ title: 'Concept A', content: 'a' })
		createNote({ title: 'Concept B', content: 'b' })
		const list = listStandaloneNotes()
		expect(list.map((n) => n.title)).toEqual(['Concept B', 'Concept A'])
	})

	it('finds a standalone note by title, case-insensitively', () => {
		createNote({ title: 'Chiral Plasmonics', content: 'x' })
		expect(findNoteByTitle('chiral plasmonics')?.title).toBe('Chiral Plasmonics')
		expect(findNoteByTitle('nope')).toBeUndefined()
	})
```
Update the import line to include the new fns: `import { createNote, getNote, listNotesByItem, updateNote, deleteNote, listStandaloneNotes, findNoteByTitle } from './notes'`. Also change the in-memory `CREATE TABLE notes` in `beforeEach` to include `updated_at INTEGER NOT NULL DEFAULT (unixepoch())` if not already (it is, per Task-3 of P1).

- [ ] **Step 2: 运行确认失败** `npx vitest run src/main/db/notes.test.ts` → FAIL(函数未导出)。

- [ ] **Step 3: 实现.** 追加到 `src/main/db/notes.ts` 末尾:

```typescript
/** Standalone notes (not attached to any paper), newest first. */
export function listStandaloneNotes(): Note[] {
	return getDb().prepare('SELECT * FROM notes WHERE item_id IS NULL ORDER BY updated_at DESC, id DESC').all() as Note[]
}

/** A standalone note whose title matches (case-insensitive, trimmed); newest
 *  wins on collision. Used to resolve [[Title]] wikilinks. */
export function findNoteByTitle(title: string): Note | undefined {
	return getDb().prepare(
		'SELECT * FROM notes WHERE item_id IS NULL AND lower(trim(title)) = lower(trim(?)) ORDER BY updated_at DESC, id DESC LIMIT 1'
	).get(title) as Note | undefined
}
```

In `src/main/db/items.ts`, add (near `findItemByDoi`):

```typescript
/** An active item whose title matches (case-insensitive, trimmed). Used to
 *  resolve [[Title]] wikilinks to a paper. */
export function findItemByTitle(title: string): Item | undefined {
	return getDb().prepare(
		'SELECT * FROM items WHERE deleted = 0 AND lower(trim(title)) = lower(trim(?)) ORDER BY updated_at DESC LIMIT 1'
	).get(title) as Item | undefined
}
```

- [ ] **Step 4: 运行确认通过** `npx vitest run src/main/db/notes.test.ts`(通过或原生不可用则 skip);`npx tsc -p tsconfig.node.json --noEmit` 干净。

- [ ] **Step 5: 提交**
```
git add src/main/db/notes.ts src/main/db/items.ts src/main/db/notes.test.ts
git commit -m "feat(db): list standalone notes + find note/item by title (wikilink resolution)"
```

---

## Task 2: relations 仓储 —— wikilink 对账 + 反链 + 级联

**Files:** Modify `src/main/db/relations.ts`; Test `src/main/db/relations.test.ts`(增用例)

- [ ] **Step 1: 写失败测试** 追加到 `src/main/db/relations.test.ts` 的 `suite('relations repo', ...)`:

```typescript
	it('sets a note\'s wikilink out-edges idempotently and reconciles on change', () => {
		setWikilinksForNote(5, [{ kind: 'item', id: 2 }, { kind: 'note', id: 9 }])
		expect(listBacklinks('item', 2)).toHaveLength(1)
		expect(listBacklinks('note', 9)).toHaveLength(1)
		// re-save with a different target set: 2 dropped, 3 added, 9 kept
		setWikilinksForNote(5, [{ kind: 'note', id: 9 }, { kind: 'item', id: 3 }])
		expect(listBacklinks('item', 2)).toHaveLength(0)
		expect(listBacklinks('item', 3)).toHaveLength(1)
		expect(listBacklinks('note', 9)).toHaveLength(1)
	})

	it('listBacklinks returns incoming edges of any rel_type', () => {
		linkItems(1, 2, 'extends', 'ai')          // item 1 -> item 2 (typed)
		setWikilinksForNote(7, [{ kind: 'item', id: 2 }]) // note 7 -> item 2 (wikilink)
		const back = listBacklinks('item', 2)
		expect(back).toHaveLength(2)
		expect(back.map((b) => b.rel_type).sort()).toEqual(['extends', 'wikilink'])
	})

	it('deleteRelationsForNote removes edges where the note is src or dst', () => {
		setWikilinksForNote(5, [{ kind: 'item', id: 2 }])
		setWikilinksForNote(8, [{ kind: 'note', id: 5 }])
		deleteRelationsForNote(5)
		expect(listBacklinks('item', 2)).toHaveLength(0)
		expect(listBacklinks('note', 5)).toHaveLength(0)
	})
```
Update the import: `import { RELATION_TYPES, linkItems, unlink, listRelationsForItem, deleteRelationsForItem, setWikilinksForNote, listBacklinks, deleteRelationsForNote } from './relations'`.

- [ ] **Step 2: 运行确认失败** `npx vitest run src/main/db/relations.test.ts` → FAIL。

- [ ] **Step 3: 实现.** 追加到 `src/main/db/relations.ts`:

```typescript
// Wikilinks live in the same edge table as the AI's typed links, but with a
// dedicated rel_type outside RELATION_TYPES (they are user-authored [[ ]], not
// the AI's extends/contradicts/... vocabulary).
export const WIKILINK_REL = 'wikilink'
export type LinkEndpoint = { kind: 'item' | 'note'; id: number }

/** Replace ALL wikilink out-edges of a note with the given target set (add new,
 *  drop removed). Self-links (note -> itself) are ignored. */
export function setWikilinksForNote(noteId: number, targets: LinkEndpoint[]): void {
	const db = getDb()
	const del = db.prepare("DELETE FROM relations WHERE src_kind = 'note' AND src_id = ? AND rel_type = ?")
	const ins = db.prepare(`
		INSERT OR IGNORE INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type, origin)
		VALUES ('note', ?, ?, ?, ?, 'user')
	`)
	db.transaction(() => {
		del.run(noteId, WIKILINK_REL)
		for (const t of targets) {
			if (t.kind === 'note' && t.id === noteId) continue   // no self-loop
			ins.run(noteId, t.kind, t.id, WIKILINK_REL)
		}
	})()
}

/** All edges pointing AT this object (incoming), any rel_type. */
export function listBacklinks(kind: 'item' | 'note', id: number): Relation[] {
	return getDb().prepare(
		'SELECT * FROM relations WHERE dst_kind = ? AND dst_id = ? ORDER BY id'
	).all(kind, id) as Relation[]
}

/** Remove every edge where this note is an endpoint (src or dst). For when a
 *  note is deleted. */
export function deleteRelationsForNote(noteId: number): void {
	getDb().prepare(
		"DELETE FROM relations WHERE (src_kind = 'note' AND src_id = ?) OR (dst_kind = 'note' AND dst_id = ?)"
	).run(noteId, noteId)
}
```

- [ ] **Step 4: 运行确认通过** `npx vitest run src/main/db/relations.test.ts`;`npx tsc -p tsconfig.node.json --noEmit` 干净。

- [ ] **Step 5: 提交**
```
git add src/main/db/relations.ts src/main/db/relations.test.ts
git commit -m "feat(db): wikilink edges (setWikilinksForNote), backlinks query, note cascade"
```

---

## Task 3: wikilinks.ts —— 提取 + 解析(纯函数)

**Files:** Create `src/main/knowledge/wikilinks.ts`, `src/main/knowledge/wikilinks.test.ts`

- [ ] **Step 1: 写失败测试** `src/main/knowledge/wikilinks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { extractWikiTargets } from './wikilinks'

describe('extractWikiTargets', () => {
	it('pulls the target title out of [[..]], stripping alias and anchor', () => {
		const md = '见 [[Chiral Plasmonics]] 和 [[石墨负极综述|综述]],以及 [[Note#heading]] 与自身 [[Chiral Plasmonics]]。'
		expect(extractWikiTargets(md)).toEqual(['Chiral Plasmonics', '石墨负极综述', 'Note'])
	})
	it('trims whitespace and dedupes case-insensitively (keeps first form)', () => {
		expect(extractWikiTargets('[[ A ]] [[a]] [[B]]')).toEqual(['A', 'B'])
	})
	it('returns [] when there are no wikilinks', () => {
		expect(extractWikiTargets('plain text [not a link]')).toEqual([])
	})
})
```

- [ ] **Step 2: 运行确认失败** `npx vitest run src/main/knowledge/wikilinks.test.ts` → FAIL。

- [ ] **Step 3: 实现** `src/main/knowledge/wikilinks.ts`:

```typescript
// Parse Obsidian-style [[wikilinks]] out of note markdown. Same syntax the
// renderer's remark-wiki-link plugin uses, but here in plain Node (regex) so the
// main process needn't pull in the remark toolchain. Alias ([[t|alias]]) and
// heading anchors ([[t#h]]) are stripped down to the bare target title.
const WIKILINK_RE = /\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g

/** Ordered, de-duplicated (case-insensitive) list of target titles referenced
 *  by [[..]] in the given markdown. */
export function extractWikiTargets(markdown: string): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const m of markdown.matchAll(WIKILINK_RE)) {
		const title = m[1].trim()
		if (!title) continue
		const key = title.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(title)
	}
	return out
}
```

- [ ] **Step 4: 运行确认通过** `npx vitest run src/main/knowledge/wikilinks.test.ts`;typecheck 干净。

- [ ] **Step 5: 提交**
```
git add src/main/knowledge/wikilinks.ts src/main/knowledge/wikilinks.test.ts
git commit -m "feat(knowledge): extractWikiTargets — parse [[wikilinks]] from note markdown"
```

---

## Task 4: NoteService —— saveNote 对账 + 反链 + 删除

**Files:** Modify `src/main/services/NoteService.ts`

READ 现有 `src/main/services/NoteService.ts`(P1:重导出 `listNotesByItem`,`createNote`/`updateNote`/`deleteNote` 走仓储 + `appendOp` + `emit`)。本任务加一个"高阶" saveNote(建/改 + 解析 wikilink + 对账边),并加 backlinks/standalone。无独立单测(集成逻辑,由 wikilinks/relations 单测 + typecheck 覆盖);逻辑简单直白。

- [ ] **Step 1: 实现.** 把 `NoteService.ts` 改为(在现有导入基础上增加):

```typescript
import { createNote as repoCreate, updateNote as repoUpdate, deleteNote as repoDelete, listNotesByItem, listStandaloneNotes, findNoteByTitle, getNote, type NoteInput, type Note } from '../db/notes'
import { findItemByTitle } from '../db/items'
import { setWikilinksForNote, listBacklinks, deleteRelationsForNote, type LinkEndpoint } from '../db/relations'
import { extractWikiTargets } from '../knowledge/wikilinks'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export { listNotesByItem, listStandaloneNotes, getNote }

/** Resolve a note's [[..]] targets to concrete item/note endpoints. Unresolved
 *  titles are dropped (no edge). Priority: standalone note first, then paper. */
function resolveTargets(content: string, selfNoteId: number): LinkEndpoint[] {
	const out: LinkEndpoint[] = []
	for (const title of extractWikiTargets(content)) {
		const note = findNoteByTitle(title)
		if (note && note.id !== selfNoteId) { out.push({ kind: 'note', id: note.id }); continue }
		const item = findItemByTitle(title)
		if (item) out.push({ kind: 'item', id: item.id })
	}
	return out
}

/** Create or update a note, then reconcile its wikilink out-edges from the
 *  content. Returns the note id. */
export function saveNote(input: { id?: number; itemId?: number | null; title?: string | null; content?: string | null }): number {
	let id = input.id
	if (id == null) {
		id = repoCreate({ itemId: input.itemId ?? null, title: input.title ?? null, content: input.content ?? '', origin: 'user' })
		appendOp('note', id, 'create', { itemId: input.itemId ?? null })
	} else {
		repoUpdate(id, { title: input.title ?? null, content: input.content ?? null, updatedBy: 'user' })
		appendOp('note', id, 'modify', {})
	}
	setWikilinksForNote(id, resolveTargets(input.content ?? '', id))
	const itemId = input.itemId ?? getNote(id)?.item_id ?? null
	if (itemId != null) emit({ type: 'note.changed', itemIds: [itemId] })
	emit({ type: 'relation.changed', itemIds: itemId != null ? [itemId] : [] })
	return id
}

export function deleteNote(id: number): void {
	const note = getNote(id)
	deleteRelationsForNote(id)
	repoDelete(id)
	appendOp('note', id, 'delete', {})
	if (note?.item_id != null) emit({ type: 'note.changed', itemIds: [note.item_id] })
	emit({ type: 'relation.changed', itemIds: [] })
}

/** Backlinks (incoming edges) resolved to display rows. */
export function getBacklinks(kind: 'item' | 'note', id: number): { kind: 'item' | 'note'; id: number; title: string; relType: string }[] {
	return listBacklinks(kind, id).map((r) => {
		const title = r.src_kind === 'note'
			? (getNote(r.src_id)?.title ?? '(untitled note)')
			: (findItemById(r.src_id)?.title ?? '(unknown)')
		return { kind: r.src_kind as 'item' | 'note', id: r.src_id, title, relType: r.rel_type }
	})
}
```
Add `import { getItemById as findItemById } from '../db/items'` (it exists in items.ts as `getItemById`). Keep the P1 `createNote`/`updateNote`/`deleteNote` exports if other code uses them — check with `grep -rn "NoteService" src` first; if `agentTools.ts` imports `createNote` from NoteService (it does), KEEP `export function createNote` too (don't remove it). Simplest: leave the existing P1 exports intact and ADD the new functions above; only rename the new delete to avoid clashing — if a `deleteNote` already exists, merge (make the existing one also call `deleteRelationsForNote`). Reconcile duplicate names before finishing.

- [ ] **Step 2: 验证** `npx tsc -p tsconfig.node.json --noEmit` 干净(修掉任何重复导出/命名冲突);`npx vitest run`(现有测试保持绿)。

- [ ] **Step 3: 提交**
```
git add src/main/services/NoteService.ts
git commit -m "feat(services): NoteService.saveNote reconciles wikilink edges + getBacklinks"
```

---

## Task 5: IPC —— notes:* 通道

**Files:** Modify `src/shared/ipc-contract.ts`, `src/main/ipc/handlers.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`

READ 每个文件里现有 `knowledge:*` 一组作为样式参照。

- [ ] **Step 1: ipc-contract.** 在 `contract` 里加(zod 校验):
```typescript
  'notes:listByItem':     z.tuple([id]),
  'notes:listStandalone': z.tuple([]),
  'notes:get':            z.tuple([id]),
  'notes:save':           z.tuple([z.object({ id: id.optional(), itemId: id.nullable().optional(), title: z.string().max(300).nullable().optional(), content: z.string().max(200000).nullable().optional() })]),
  'notes:delete':         z.tuple([id]),
  'notes:backlinks':      z.tuple([z.enum(['item', 'note']), id]),
  'notes:resolveTitle':   z.tuple([z.string().max(300)]),
```
(`id` is the existing positive-int zod helper in this file.)

- [ ] **Step 2: handlers.** 在 `src/main/ipc/handlers.ts` 顶部 import NoteService 的方法(与现有 Agent 等同风格),加处理:
```typescript
  'notes:listByItem':     (_e, itemId: number) => NoteService.listNotesByItem(itemId),
  'notes:listStandalone': () => NoteService.listStandaloneNotes(),
  'notes:get':            (_e, id: number) => NoteService.getNote(id) ?? null,
  'notes:save':           (_e, input: { id?: number; itemId?: number | null; title?: string | null; content?: string | null }) => NoteService.saveNote(input),
  'notes:delete':         (_e, id: number) => NoteService.deleteNote(id),
  'notes:backlinks':      (_e, kind: 'item' | 'note', id: number) => NoteService.getBacklinks(kind, id),
  'notes:resolveTitle':   (_e, title: string) => NoteService.resolveTitle(title),
```
并在 NoteService 增一个小工具 `resolveTitle`(供渲染层点击/未解析判断):
```typescript
export function resolveTitle(title: string): { kind: 'item' | 'note'; id: number } | null {
	const note = findNoteByTitle(title)
	if (note) return { kind: 'note', id: note.id }
	const item = findItemByTitle(title)
	if (item) return { kind: 'item', id: item.id }
	return null
}
```
(加到 Task 4 的 NoteService,并 export;若 Task 4 已提交,此处一并补上。)

- [ ] **Step 3: preload.** 在 `src/preload/index.ts` 的 `window.veridian` 里加 `notes` 命名空间(仿 `knowledge`):
```typescript
    notes: {
      listByItem: (itemId: number) => call<Array<{ id: number; item_id: number | null; title: string | null; content: string | null; origin: string; updated_by: string; created_at: number; updated_at: number }>>('notes:listByItem', itemId),
      listStandalone: () => call<Array<{ id: number; item_id: number | null; title: string | null; content: string | null; origin: string; updated_by: string; created_at: number; updated_at: number }>>('notes:listStandalone'),
      get: (id: number) => call<{ id: number; item_id: number | null; title: string | null; content: string | null } | null>('notes:get', id),
      save: (input: { id?: number; itemId?: number | null; title?: string | null; content?: string | null }) => call<number>('notes:save', input),
      delete: (id: number) => call<void>('notes:delete', id),
      backlinks: (kind: 'item' | 'note', id: number) => call<Array<{ kind: 'item' | 'note'; id: number; title: string; relType: string }>>('notes:backlinks', kind, id),
      resolveTitle: (title: string) => call<{ kind: 'item' | 'note'; id: number } | null>('notes:resolveTitle', title),
    },
```

- [ ] **Step 4: env.d.ts.** 在 `src/renderer/src/env.d.ts` 的 `VeridianAPI` 里加与 preload 完全一致的 `notes: { ... }` 类型声明。

- [ ] **Step 5: 验证** `npx tsc -p tsconfig.node.json --noEmit` 与 `npx tsc -p tsconfig.web.json --noEmit` 均干净。

- [ ] **Step 6: 提交**
```
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts src/main/services/NoteService.ts
git commit -m "feat(ipc): notes:* channels (list/get/save/delete/backlinks/resolveTitle)"
```

---

## Task 6: NoteEditor 组件(编辑/预览 + `[[` 补全)+ 装 remark-wiki-link

**Files:** Create `src/renderer/src/components/notes/wikiMarkdown.tsx`, `src/renderer/src/components/notes/NoteEditor.tsx`; Modify `package.json`(装依赖)

- [ ] **Step 1: 装 remark-wiki-link.** Run: `npm install remark-wiki-link` → 确认 `package.json` dependencies 出现它。（纯 JS/远端不下载原生模块,安全。）

- [ ] **Step 2: wikiMarkdown.tsx —— 预览渲染 + 点击处理.** `src/renderer/src/components/notes/wikiMarkdown.tsx`:

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkWikiLink from 'remark-wiki-link'

// Render note markdown with clickable [[wikilinks]]. remark-wiki-link turns
// [[Title]] / [[Title|alias]] into <a> tags; we point their href at a private
// scheme and intercept clicks on the container so the app resolves + navigates.
// `known` (lower-cased titles that resolve) marks existing vs unresolved links.
export function WikiMarkdown({ content, known, onWiki }: {
	content: string
	known: Set<string>
	onWiki: (title: string) => void
}): JSX.Element {
	return (
		<div
			className="wiki-md"
			onClick={(e) => {
				const a = (e.target as HTMLElement).closest('a[href^="veridian-wiki://"]') as HTMLAnchorElement | null
				if (!a) return
				e.preventDefault()
				onWiki(decodeURIComponent(a.getAttribute('href')!.slice('veridian-wiki://'.length)))
			}}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, [remarkWikiLink, {
					aliasDivider: '|',
					hrefTemplate: (permalink: string) => `veridian-wiki://${encodeURIComponent(permalink)}`,
					pageResolver: (name: string) => [name.trim()],
					wikiLinkClassName: 'wiki-link',
					newClassName: 'wiki-link-new',
					permalinks: [...known],   // titles present here render as existing
				}]]}
			>
				{content}
			</ReactMarkdown>
		</div>
	)
}
```
Add minimal CSS to `src/renderer/src/styles/globals.css`:
```css
.wiki-link { color: var(--primary); cursor: pointer; text-decoration: none; }
.wiki-link:hover { text-decoration: underline; }
.wiki-link-new { color: var(--muted); border-bottom: 1px dashed var(--muted); cursor: pointer; }
```
NOTE: `permalinks` must be the lower-cased/normalized forms consistent with `pageResolver`. Pass `known` as titles already lower-cased+trimmed; set `pageResolver: (name) => [name.trim().toLowerCase()]` accordingly so `exists` matching works. Adjust the two to agree.

- [ ] **Step 3: NoteEditor.tsx.** `src/renderer/src/components/notes/NoteEditor.tsx` — textarea + `[[` 补全 + 预览切换 + 自动保存:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WikiMarkdown } from './wikiMarkdown'

interface NoteEditorProps {
	noteId?: number
	itemId?: number | null
	onWiki: (title: string) => void   // click a [[link]]
	onSaved?: (id: number) => void
}

export function NoteEditor({ noteId, itemId, onWiki, onSaved }: NoteEditorProps): JSX.Element {
	const { t } = useTranslation('common')
	const [title, setTitle] = useState('')
	const [content, setContent] = useState('')
	const [mode, setMode] = useState<'edit' | 'preview'>('edit')
	const [titles, setTitles] = useState<string[]>([])   // candidate titles for [[ autocomplete + exists
	const [ac, setAc] = useState<{ from: number; query: string } | null>(null)
	const taRef = useRef<HTMLTextAreaElement>(null)
	const idRef = useRef<number | undefined>(noteId)

	// Load the note + the candidate title set (standalone notes + papers).
	useEffect(() => {
		idRef.current = noteId
		void (async () => {
			if (noteId != null) {
				const n = await window.veridian.notes.get(noteId)
				setTitle(n?.title ?? ''); setContent(n?.content ?? '')
			} else { setTitle(''); setContent('') }
			const [notes, items] = await Promise.all([
				window.veridian.notes.listStandalone(),
				window.veridian.items.getAll(),
			])
			setTitles([...notes.map((n) => n.title ?? ''), ...items.map((i) => i.title ?? '')].filter(Boolean))
		})()
	}, [noteId])

	const known = useMemo(() => new Set(titles.map((s) => s.trim().toLowerCase())), [titles])

	// Debounced save.
	const save = useMemo(() => {
		let timer: ReturnType<typeof setTimeout> | null = null
		return (nextTitle: string, nextContent: string) => {
			if (timer) clearTimeout(timer)
			timer = setTimeout(async () => {
				const savedId = await window.veridian.notes.save({ id: idRef.current, itemId, title: nextTitle, content: nextContent })
				idRef.current = savedId
				onSaved?.(savedId)
			}, 500)
		}
	}, [itemId, onSaved])

	function onContentChange(v: string, caret: number): void {
		setContent(v); save(title, v)
		// [[ autocomplete: find an unclosed [[ before the caret
		const upto = v.slice(0, caret)
		const m = upto.match(/\[\[([^\]\n|#]*)$/)
		setAc(m ? { from: caret - m[1].length, query: m[1] } : null)
	}

	const suggestions = ac ? titles.filter((tt) => tt.toLowerCase().includes(ac.query.toLowerCase())).slice(0, 8) : []

	function insert(tt: string): void {
		if (!ac) return
		const before = content.slice(0, ac.from - 2)  // drop the "[["
		const after = content.slice(ac.from + ac.query.length)
		const next = `${before}[[${tt}]]${after}`
		setContent(next); save(title, next); setAc(null)
		requestAnimationFrame(() => taRef.current?.focus())
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
			<div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
				<input value={title} placeholder={t('notes.titlePlaceholder')}
					onChange={(e) => { setTitle(e.target.value); save(e.target.value, content) }}
					style={{ flex: 1, fontSize: 15, fontWeight: 700, border: 'none', outline: 'none', background: 'transparent', color: 'var(--foreground)' }} />
				<button onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
					style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--foreground-2)' }}>
					{mode === 'edit' ? t('notes.preview') : t('notes.edit')}
				</button>
			</div>
			<div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
				{mode === 'edit' ? (
					<textarea ref={taRef} value={content}
						onChange={(e) => onContentChange(e.target.value, e.target.selectionStart)}
						placeholder={t('notes.bodyPlaceholder')}
						style={{ width: '100%', height: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'var(--foreground)', fontSize: 13, lineHeight: 1.6, fontFamily: 'inherit' }} />
				) : (
					<div style={{ height: '100%', overflowY: 'auto' }}>
						<WikiMarkdown content={content} known={known} onWiki={onWiki} />
					</div>
				)}
				{ac && suggestions.length > 0 && (
					<div style={{ position: 'absolute', bottom: 8, left: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', maxWidth: 320, zIndex: 5 }}>
						{suggestions.map((s) => (
							<div key={s} onMouseDown={(e) => { e.preventDefault(); insert(s) }}
								style={{ padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', color: 'var(--foreground-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								[[{s}]]
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	)
}
```
i18n (`src/renderer/src/i18n/index.ts`, zh+en): `notes.titlePlaceholder`(笔记标题…/Note title…)、`notes.bodyPlaceholder`(正文,输入 [[ 链接…/Body, type [[ to link…)、`notes.preview`(预览/Preview)、`notes.edit`(编辑/Edit)、`notes.backlinks`(反向链接/Backlinks)、`notes.newNote`(新建笔记/New note)、`notes.notesSection`(笔记/Notes)、`notes.createLinked`(新建笔记『{{title}}』?/Create note “{{title}}”?)。

- [ ] **Step 4: 验证** `npx tsc -p tsconfig.web.json --noEmit` 干净;`npm run build` 成功。

- [ ] **Step 5: 提交**
```
git add src/renderer/src/components/notes/wikiMarkdown.tsx src/renderer/src/components/notes/NoteEditor.tsx src/renderer/src/styles/globals.css src/renderer/src/i18n/index.ts package.json package-lock.json
git commit -m "feat(notes-ui): NoteEditor (textarea + [[ autocomplete + wiki markdown preview)"
```

---

## Task 7: Backlinks 组件 + 详情页"笔记"标签(论文笔记)

**Files:** Create `src/renderer/src/components/notes/Backlinks.tsx`, `src/renderer/src/components/notes/resolveWiki.ts`; Modify `src/renderer/src/stores/itemStore.ts`, `src/renderer/src/components/detail-panel/DetailPane.tsx`

> **前置(否则本任务编译不过):** 本任务的导航用到 `itemStore.openNote` 与 `resolveWiki`,它们的完整形态在 Task 8 定义。**先把 Task 8 的 Step 1(itemStore 加 `noteViewerId`/`openNote`/`closeNote` 及各处 `noteViewerId: null` 重置)和 Task 8 的 Step 3(创建 `resolveWiki.ts`)在这里先做掉**,Task 8 届时只做 NotePage/MainLayout/CollectionPane(其 Step 1/3 标记为"已在 Task 7 完成")。这样每个任务都能独立编译。

- [ ] **Step 1: Backlinks.tsx.**
```tsx
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Row = { kind: 'item' | 'note'; id: number; title: string; relType: string }

export function Backlinks({ kind, id, refreshKey, onOpen }: {
	kind: 'item' | 'note'; id: number; refreshKey?: number
	onOpen: (kind: 'item' | 'note', id: number) => void
}): JSX.Element {
	const { t } = useTranslation('common')
	const [rows, setRows] = useState<Row[]>([])
	useEffect(() => { void window.veridian.notes.backlinks(kind, id).then(setRows) }, [kind, id, refreshKey])
	return (
		<div style={{ fontSize: 12.5 }}>
			<div style={{ textTransform: 'uppercase', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 6 }}>
				↩ {t('notes.backlinks')} ({rows.length})
			</div>
			{rows.length === 0 && <div style={{ color: 'var(--muted)' }}>{t('notes.noBacklinks')}</div>}
			{rows.map((r) => (
				<div key={`${r.kind}-${r.id}-${r.relType}`} onClick={() => onOpen(r.kind, r.id)}
					style={{ padding: '4px 0', cursor: 'pointer', color: 'var(--foreground-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{r.kind === 'item' ? '📄 ' : '📝 '}{r.title}
					<span style={{ color: 'var(--muted)', marginLeft: 6 }}>· {r.relType}</span>
				</div>
			))}
		</div>
	)
}
```
i18n add: `notes.noBacklinks`(暂无反向链接/No backlinks yet).

- [ ] **Step 2: DetailPane "笔记" 标签.** READ `DetailPane.tsx`。把 `tab === 'notes'` 的占位块换成:一个 `NoteEditor`(该论文的主笔记)+ `Backlinks`(kind='item')。v1 单条主笔记:进入时 `notes:listByItem(itemId)`,取第一条作为 `noteId`(无则新建走 save 时创建)。实现:
```tsx
// at top of DetailPane.tsx
import { useEffect, useState } from 'react'   // if not present
import { NoteEditor } from '../notes/NoteEditor'
import { Backlinks } from '../notes/Backlinks'
// ...
function NotesTab({ itemId, onWiki }: { itemId: number; onWiki: (title: string) => void }): JSX.Element {
	const [noteId, setNoteId] = useState<number | undefined>(undefined)
	const [refreshKey, setRefreshKey] = useState(0)
	useEffect(() => { void window.veridian.notes.listByItem(itemId).then((ns) => setNoteId(ns[0]?.id)) }, [itemId])
	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16, gap: 12, minHeight: 0 }}>
			<div style={{ flex: 1, minHeight: 120 }}>
				<NoteEditor noteId={noteId} itemId={itemId} onWiki={onWiki} onSaved={(id) => { setNoteId(id); setRefreshKey((k) => k + 1) }} />
			</div>
			<div style={{ borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
				<Backlinks kind="item" id={itemId} refreshKey={refreshKey} onOpen={(k, i) => onWiki('')} />
			</div>
		</div>
	)
}
```
Replace the placeholder render `{tab === 'notes' && (<div ...placeholder...>)}` with `{tab === 'notes' && <NotesTab itemId={item.id} onWiki={handleWiki} />}`. For `handleWiki` / `onOpen` navigation, DetailPane doesn't own routing — pass a handler that calls the itemStore/uiStore (Task 8 adds `openNote`; for now, wire `onWiki`/`onOpen` to a resolver: `async (title) => { const r = await window.veridian.notes.resolveTitle(title); if (r?.kind==='item') useItemStore.getState().setSelectedId(r.id); else if (r?.kind==='note') useItemStore.getState().openNote(r.id) }`). `openNote` lands in Task 8; if not present yet, stub it to a no-op and complete in Task 8. Prefer doing Task 8's itemStore change first if implementing strictly in order — or define `openNote` in itemStore now.

- [ ] **Step 3: 验证** `npx tsc -p tsconfig.web.json --noEmit` 干净;`npm run build` 成功。

- [ ] **Step 4: 提交**
```
git add src/renderer/src/components/notes/Backlinks.tsx src/renderer/src/components/detail-panel/DetailPane.tsx src/renderer/src/i18n/index.ts
git commit -m "feat(notes-ui): Backlinks component + paper Notes tab (editor + backlinks)"
```

---

## Task 8: 独立笔记页 + 左栏"笔记"列表 + wikilink 导航/建页

**Files:** Modify `src/renderer/src/stores/itemStore.ts`, `MainLayout.tsx`, `CollectionPane.tsx`; Create `src/renderer/src/components/notes/NotePage.tsx`

- [ ] **Step 1: itemStore 加 noteViewer.** 在 `ItemStore` 接口与实现里加(镜像 viewer 模式,互斥于文件查看器):
```typescript
	noteViewerId: number | null
	openNote: (id: number) => void
	closeNote: () => void
```
实现:
```typescript
	noteViewerId: null,
	openNote: (id) => set({ noteViewerId: id, viewerPath: null }),
	closeNote: () => set({ noteViewerId: null }),
```
并在 `setActiveCollection` / `setSelectedId`(选论文时)里 `set({ noteViewerId: null })` 以退出笔记页(选论文回到库/详情)。具体:`setSelectedId: (id) => set({ selectedId: id, noteViewerId: null })`;`setActiveCollection` 的 set 里加 `noteViewerId: null`;`openPdf/openMarkdown/openGallery` 各自 set 里加 `noteViewerId: null`。

- [ ] **Step 2: NotePage.tsx.**
```tsx
import { useState } from 'react'
import { useItemStore } from '../../stores/itemStore'
import { NoteEditor } from './NoteEditor'
import { Backlinks } from './Backlinks'
import { resolveWiki } from './resolveWiki'

export function NotePage(): JSX.Element {
	const noteId = useItemStore((s) => s.noteViewerId)!
	const [refreshKey, setRefreshKey] = useState(0)
	return (
		<div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
			<div style={{ flex: 1, padding: 18, minWidth: 0 }}>
				<NoteEditor noteId={noteId} onWiki={resolveWiki} onSaved={() => setRefreshKey((k) => k + 1)} />
			</div>
			<div style={{ flex: '0 0 220px', borderLeft: '1px solid var(--border)', padding: 16, overflowY: 'auto' }}>
				<Backlinks kind="note" id={noteId} refreshKey={refreshKey} onOpen={(k, i) => (k === 'note' ? useItemStore.getState().openNote(i) : useItemStore.getState().setSelectedId(i))} />
			</div>
		</div>
	)
}
```

- [ ] **Step 3: resolveWiki helper.** Create `src/renderer/src/components/notes/resolveWiki.ts` (shared click handler used by NotePage + DetailPane):
```typescript
import { useItemStore } from '../../stores/itemStore'

// Click a [[wikilink]]: resolve the title; open the paper (select) or the note
// (note page); if unresolved, offer to create a standalone note by that title.
export async function resolveWiki(title: string): Promise<void> {
	if (!title.trim()) return
	const r = await window.veridian.notes.resolveTitle(title)
	if (r?.kind === 'item') { useItemStore.getState().setSelectedId(r.id); return }
	if (r?.kind === 'note') { useItemStore.getState().openNote(r.id); return }
	if (window.confirm(`Create note “${title}”?`)) {
		const id = await window.veridian.notes.save({ title, content: '' })
		useItemStore.getState().openNote(id)
	}
}
```
Wire DetailPane's NotesTab (Task 7) `onWiki`/`onOpen` to use `resolveWiki` / `openNote` from itemStore accordingly.

- [ ] **Step 4: MainLayout 接入.** READ `MainLayout.tsx`。取 `const noteViewerId = useItemStore((s) => s.noteViewerId)`。在中区条件链里,`noteViewerId != null` 时渲染 `<NotePage />`(优先于文件查看器与列表;`page==='library'` 前提)。把 kept-mounted 列表 wrapper 的显示条件改为 `page === 'library' && !viewerPath && noteViewerId == null`。条件链改为:
```tsx
{page === 'knowledge' || (page === 'library' && !viewerPath && noteViewerId == null) ? null
  : page === 'settings' ? <SettingsPage />
  : page === 'tools' ? <ToolsPage />
  : noteViewerId != null ? <NotePage />
  : viewerPath ? (viewerType === 'markdown' ? <MarkdownReaderPane /> : viewerType === 'gallery' ? <ImageGalleryPane /> : <PdfReaderPane />)
  : null }
```
(import NotePage.)右侧详情栏条件已是 `page === 'library' && selectedId !== null && !viewerPath` —— 追加 `&& noteViewerId == null`(笔记页时不显示详情栏)。

- [ ] **Step 5: 左栏"笔记"列表.** READ `CollectionPane.tsx`。在分类树下方加一节:标题 `t('notes.notesSection')`,列出 `notes:listStandalone`(用 `note.changed` 事件刷新),点击 `useItemStore.getState().openNote(id)`;一个"＋ {t('notes.newNote')}"按钮 → `const id = await window.veridian.notes.save({ title: '', content: '' }); useItemStore.getState().openNote(id)`。订阅刷新:在该组件 `useEffect` 里 `window.veridian.onDomainEvent((e) => { if (e.type === 'note.changed') reload() })`(仿现有 domain-event 订阅;记得返回时取消订阅)。

- [ ] **Step 6: 验证** `npx tsc -p tsconfig.web.json --noEmit` 干净;`npm run build` 成功。

- [ ] **Step 7: 提交**
```
git add src/renderer/src/stores/itemStore.ts src/renderer/src/components/notes/NotePage.tsx src/renderer/src/components/notes/resolveWiki.ts src/renderer/src/components/layout/MainLayout.tsx src/renderer/src/components/item-tree/CollectionPane.tsx
git commit -m "feat(notes-ui): standalone note page + sidebar notes list + wikilink navigation/create"
```

---

## Task 9: 全量验证 + 手动冒烟

- [ ] **Step 1: 全量** `npm run typecheck && npm run test && npm run build` 全绿(DB 测试 skip 属正常)。
- [ ] **Step 2: 手动冒烟**(复用用户已开 app):
1. 左栏"＋新建笔记"→ 打开空笔记页;写标题"手性等离激元",正文输入 `[[` → 弹补全,选某论文 → `[[论文标题]]`;切"预览"看到蓝色可点链接。
2. 打开那篇论文详情页"笔记"标签 → 反链里出现"📝 手性等离激元"。
3. 点笔记里的 `[[论文]]` 链接 → 跳到该论文(选中)。
4. 写 `[[一个不存在的概念]]` → 预览里灰色虚线;点它 → 确认后新建同名笔记并打开。
5. 删除/改标题不崩;切换分类、开 PDF、AI 问答均不回归。
- [ ] **Step 3: 记录结果**,失败回对应 Task 修复。

---

## 自检(spec 覆盖)
- 笔记模型(论文+独立):notes 仓储 + saveNote(itemId 可空)✅(T1/T4)
- `[[]]` 解析→relations(wikilink):extractWikiTargets + setWikilinksForNote + saveNote 对账 ✅(T2/T3/T4)
- 反向链接:listBacklinks + getBacklinks + Backlinks 组件 ✅(T2/T4/T7)
- 渲染 `[[]]`(remark-wiki-link,exists 样式):wikiMarkdown ✅(T6)
- `[[` 补全:NoteEditor ✅(T6)
- 独立笔记页(中区)+ 右反链 + 左栏入口:NotePage/itemStore/MainLayout/CollectionPane ✅(T8)
- 论文笔记标签:DetailPane NotesTab ✅(T7)
- 点击导航 + 未解析建页:resolveWiki ✅(T8)
- rel_type='wikilink' 独立于 AI 集:WIKILINK_REL ✅(T2)
