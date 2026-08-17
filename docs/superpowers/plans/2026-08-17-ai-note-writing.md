# AI 笔记写作能力扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 助手能建独立概念笔记、整体重写已有笔记,所有 AI 笔记写入走 `NoteService.saveNote`,使正文里的 `[[双链]]` 自动建反向链接。

**Architecture:** 改动集中在主进程四处:`NoteService.saveNote` 加 `origin` 参数;`agentTools.ts` 改 `create_note`(可建独立笔记 + 走 saveNote)、新增 `update_note`/`list_notes`、`read_notes` 输出补 id;`shared/types.ts` 的 `RetrievalStep` 工具联合类型加两名;`modes.ts` 的 `notes` 模式工具集加两名。渲染层零改动。

**Tech Stack:** Electron 主进程 TypeScript(strict,TAB 缩进于 `knowledge/`,2-space 于 `db/`、`services/`)、better-sqlite3、vitest。

**Branch:** 从 `main` 建 `ai-note-writing` 分支实施。

**前置事实(已核实,勿改错方向):**
- `NoteService` 已导出:`saveNote`、`getNote`、`listNotesByItem`、`listStandaloneNotes`(P2-A)。`getNote(id)` 返回 `Note | undefined`,`Note` 有 `id/item_id/title/content/origin/updated_by`。
- `db/notes.ts`:`createNote(input: NoteInput)` 的 `NoteInput.origin?: 'user'|'ai'`;`updateNote(id, { title?, content?, updatedBy })`,SQL 用 `COALESCE(@title, title)` / `COALESCE(@content, content)`(传 null 保留旧值)。
- `agentTools.ts`:`executeAgentTool` 顶部已算 `const key = String(a.item_key ?? '')`;`step(tool, label)` 的 `tool` 类型 = `RetrievalStep['tool']`;`resolveItem(key)` 按 key 精确/唯一前缀解析论文。
- `toolRegistry.ts` 的 `TOOL_REGISTRY` 由 `[...BASE_READ_TOOLS, ...AGENT_ACTION_TOOLS]` 构建,`buildTools(mode)` 按 `mode.tools` 名字解析、未知名丢弃。所以工具加进 `agentTools.ts` 的数组即自动注册,只需再把名字加进 `modes.ts` 的 `notes` 模式。
- `agentTools.test.ts` 用内存 sqlite(`dbUsable` 守卫,本机 Electron ABI 下跳过)+ `vi.mock('../db')`/`'../db/index'`/Notifier/oplog,端到端跑 `executeAgentTool`;其建表已含 `items/notes/relations/collections/...`。
- DB/服务测试在本机因 better-sqlite3 ABI 不匹配而 **skip**(预期,勿 `npm rebuild`/`electron-rebuild`)。纯逻辑测试正常运行。

---

## Task 1: `NoteService.saveNote` 接受 `origin` 参数

**Files:**
- Modify: `src/main/services/NoteService.ts`(2-space 缩进)
- Test: `src/main/services/NoteService.test.ts`(新建)

- [ ] **Step 1: 写失败测试** — 新建 `src/main/services/NoteService.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('../db/index', () => ({ getDb: () => db }))
vi.mock('../core/Notifier', () => ({ emit: () => {} }))
vi.mock('../db/oplog', () => ({ appendOp: () => {} }))

import { saveNote } from './NoteService'
import { getNote } from '../db/notes'

suite('NoteService.saveNote origin', () => {
	beforeEach(() => {
		db = new Database(':memory:')
		db.exec(`
			CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, title TEXT, deleted INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
			CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, title TEXT, content TEXT,
				origin TEXT DEFAULT 'user', updated_by TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
			CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_kind TEXT, src_id INTEGER, dst_kind TEXT, dst_id INTEGER,
				rel_type TEXT, origin TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type));
		`)
	})
	afterEach(() => { db.close() })

	it('tags a newly created note with origin=ai when asked', () => {
		const id = saveNote({ title: 'Concept', content: 'body', origin: 'ai' })
		const n = getNote(id)!
		expect(n.origin).toBe('ai')
		expect(n.updated_by).toBe('ai')
	})

	it('defaults origin to user when omitted (unchanged behavior)', () => {
		const id = saveNote({ title: 'Mine', content: 'body' })
		expect(getNote(id)!.origin).toBe('user')
	})

	it('records updated_by=ai on an ai update', () => {
		const id = saveNote({ title: 'X', content: 'a' })      // user-created
		saveNote({ id, content: 'b', origin: 'ai' })            // ai-updated
		expect(getNote(id)!.updated_by).toBe('ai')
	})
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run src/main/services/NoteService.test.ts`
  Expected: 若本机 sqlite 可用则 FAIL(`saveNote` 尚不接受 `origin`,TS 编译错误或 origin 仍为 'user');若 sqlite 不可用则整套 skip —— 无论哪种,继续实现。

- [ ] **Step 3: 实现** — 在 `src/main/services/NoteService.ts` 把 `saveNote` 改为(签名加 `origin`,create/update 分支用它;链接对账与事件不变):

```typescript
/** Create or update a note, then reconcile its wikilink out-edges from the
 *  content. `origin` tags who authored the change (default 'user'; AI writes
 *  pass 'ai'). Returns the note id. */
export function saveNote(input: {
	id?: number; itemId?: number | null;
	title?: string | null; content?: string | null;
	origin?: 'user' | 'ai'
}): number {
	const origin = input.origin ?? 'user'
	let id = input.id
	if (id == null) {
		id = repoCreate({ itemId: input.itemId ?? null, title: input.title ?? null, content: input.content ?? '', origin })
		appendOp('note', id, 'create', { itemId: input.itemId ?? null })
	} else {
		repoUpdate(id, { title: input.title ?? null, content: input.content ?? null, updatedBy: origin })
		appendOp('note', id, 'modify', {})
	}
	setWikilinksForNote(id, resolveTargets(input.content ?? '', id))
	const itemId = input.itemId ?? getNote(id)?.item_id ?? null
	emit({ type: 'note.changed', itemIds: itemId != null ? [itemId] : [] })
	emit({ type: 'relation.changed', itemIds: itemId != null ? [itemId] : [] })
	return id
}
```

- [ ] **Step 4: 跑测试确认通过** — Run: `npx vitest run src/main/services/NoteService.test.ts`
  Expected: PASS(或 skip)。再 `npx tsc -p tsconfig.node.json --noEmit` → 干净。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/NoteService.ts src/main/services/NoteService.test.ts
git commit -m "feat(services): saveNote accepts origin (user|ai) for AI-authored notes"
```

---

## Task 2: agentTools —— create_note(独立+saveNote)、update_note、list_notes、read_notes 补 id

**Files:**
- Modify: `src/shared/types.ts:194-200`(RetrievalStep 工具联合类型)
- Modify: `src/main/knowledge/agentTools.ts`(TAB 缩进)
- Test: `src/main/knowledge/agentTools.test.ts`(补用例)

- [ ] **Step 1: 扩展 RetrievalStep 工具联合类型.** 在 `src/shared/types.ts` 把:

```typescript
export interface RetrievalStep {
  tool: 'search_library' | 'read_context' | 'get_item_info' | 'load_skill'
    | 'create_note' | 'add_tags' | 'add_to_collection' | 'link_items'
    | 'update_metadata' | 'set_star' | 'list_collections' | 'list_items' | 'list_tags' | 'read_notes' | 'read_item'
```

改为(加 `'update_note' | 'list_notes'`):

```typescript
export interface RetrievalStep {
  tool: 'search_library' | 'read_context' | 'get_item_info' | 'load_skill'
    | 'create_note' | 'update_note' | 'list_notes' | 'add_tags' | 'add_to_collection' | 'link_items'
    | 'update_metadata' | 'set_star' | 'list_collections' | 'list_items' | 'list_tags' | 'read_notes' | 'read_item'
```

- [ ] **Step 2: 补失败测试.** 在 `src/main/knowledge/agentTools.test.ts` 的 `suite('agent write tools', ...)` 里追加(该套件的 `beforeEach` 已建 items/notes/relations 表,并插入 `AAAA1111=Paper A`、`BBBB2222=Paper B`):

```typescript
	it('create_note without item_key makes a standalone concept note + wikilink edge', async () => {
		await executeAgentTool('create_note', JSON.stringify({ title: 'Contrastive Learning', content: 'see [[Paper B]]' }))
		const note = db.prepare("SELECT * FROM notes WHERE title = 'Contrastive Learning'").get() as { id: number; item_id: number | null; origin: string }
		expect(note.item_id).toBeNull()
		expect(note.origin).toBe('ai')
		// [[Paper B]] resolved to item id 2 -> a wikilink edge note->item
		const edge = db.prepare("SELECT * FROM relations WHERE rel_type = 'wikilink'").get() as { src_kind: string; dst_kind: string; dst_id: number } | undefined
		expect(edge).toBeTruthy()
		expect(edge!.src_kind).toBe('note')
		expect(edge!.dst_kind).toBe('item')
		expect(edge!.dst_id).toBe(2)
	})

	it('create_note without a title for a standalone note errors', async () => {
		const { result } = await executeAgentTool('create_note', JSON.stringify({ content: 'no title here' }))
		expect(result).toMatch(/title/i)
		expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toMatchObject({ n: 0 })
	})

	it('update_note overwrites content and re-reconciles edges', async () => {
		// seed a standalone note linking to Paper A
		await executeAgentTool('create_note', JSON.stringify({ title: 'Topic', content: 'link [[Paper A]]' }))
		const before = db.prepare("SELECT id FROM notes WHERE title = 'Topic'").get() as { id: number }
		expect(db.prepare("SELECT dst_id FROM relations WHERE rel_type='wikilink'").get()).toMatchObject({ dst_id: 1 })
		// rewrite to link Paper B instead
		await executeAgentTool('update_note', JSON.stringify({ note_id: before.id, content: 'now [[Paper B]]' }))
		const note = db.prepare("SELECT content, updated_by FROM notes WHERE id = ?").get(before.id) as { content: string; updated_by: string }
		expect(note.content).toBe('now [[Paper B]]')
		expect(note.updated_by).toBe('ai')
		const edges = db.prepare("SELECT dst_id FROM relations WHERE rel_type='wikilink'").all() as { dst_id: number }[]
		expect(edges).toEqual([{ dst_id: 2 }])   // old edge to Paper A dropped, new to Paper B
	})

	it('update_note errors on a missing note', async () => {
		const { result } = await executeAgentTool('update_note', JSON.stringify({ note_id: 999, content: 'x' }))
		expect(result).toMatch(/not found/i)
	})

	it('list_notes lists standalone concept notes with ids', async () => {
		await executeAgentTool('create_note', JSON.stringify({ title: 'Alpha', content: '' }))
		const { result, step } = await executeAgentTool('list_notes', '{}')
		expect(step.tool).toBe('list_notes')
		expect(result).toMatch(/Alpha/)
		expect(result).toMatch(/id \d+/)
	})

	it('read_notes includes note ids', async () => {
		await executeAgentTool('create_note', JSON.stringify({ item_key: 'AAAA1111', title: 'S', content: 'b' }))
		const { result } = await executeAgentTool('read_notes', JSON.stringify({ item_key: 'AAAA1111' }))
		expect(result).toMatch(/id \d+/)
	})

	it('exposes the new tool names', () => {
		expect(AGENT_ACTION_TOOL_NAMES.has('update_note')).toBe(true)
		expect(AGENT_ACTION_TOOL_NAMES.has('list_notes')).toBe(true)
	})
```

- [ ] **Step 3: 跑测试确认失败** — Run: `npx vitest run src/main/knowledge/agentTools.test.ts`
  Expected: FAIL(新工具未实现;若 sqlite 不可用则 skip —— 仍继续)。

- [ ] **Step 4: 实现 — 改导入.** 在 `src/main/knowledge/agentTools.ts` 顶部把:

```typescript
import { createNote, listNotesByItem } from '../services/NoteService'
```

改为:

```typescript
import { saveNote, getNote, listNotesByItem, listStandaloneNotes } from '../services/NoteService'
```

- [ ] **Step 5: 实现 — 加 `list_notes` 读工具定义.** 在 `AGENT_READ_TOOLS` 数组里,`read_notes` 定义之后追加:

```typescript
	{ type: 'function', function: {
			name: 'list_notes',
			description: 'List standalone concept notes (id + title) — notes not attached to any paper. Use to find a concept note to update, or to check whether a [[Title]] concept page already exists before creating it.',
			parameters: { type: 'object', properties: {} } } },
```

- [ ] **Step 6: 实现 — 改 `create_note` 定义 + 加 `update_note` 定义.** 在 `AGENT_WRITE_TOOLS` 数组里,把现有 `create_note` 定义替换为下面两个定义(注意 `create_note` 的 `required` 去掉了 `item_key`):

```typescript
	{ type: 'function', function: {
			name: 'create_note',
			description: 'Create a note. Provide item_key to attach it to a paper, OR omit item_key to create a standalone concept note (then title is REQUIRED and becomes the concept\'s identity). In the body you may write [[Title]] to link to other notes/papers — those become backlinks automatically. Use for summaries, observations, or concept pages the user asks you to save.',
			parameters: { type: 'object', properties: {
				item_key: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
			}, required: ['content'] } } },
	{ type: 'function', function: {
			name: 'update_note',
			description: 'Overwrite an existing note (identified by note_id) with new title/content. Read the note first via read_notes or list_notes so you do not discard the user\'s text. [[Title]] links in the new content are re-reconciled into backlinks.',
			parameters: { type: 'object', properties: {
				note_id: { type: 'number' }, title: { type: 'string' }, content: { type: 'string' },
			}, required: ['note_id'] } } },
```

- [ ] **Step 7: 实现 — `read_notes` 输出补 id.** 在 `executeAgentTool` 里把 `read_notes` 分支的 body 行:

```typescript
		const body = notes.length ? notes.map((n) => `- ${n.title ?? '(untitled)'}: ${n.content ?? ''}`).join('\n') : '(no notes)'
```

改为:

```typescript
		const body = notes.length ? notes.map((n) => `- [id ${n.id}] ${n.title ?? '(untitled)'}: ${n.content ?? ''}`).join('\n') : '(no notes)'
```

- [ ] **Step 8: 实现 — `list_notes` 执行分支.** 在 `executeAgentTool` 里(紧接 `read_notes` 分支之后)加:

```typescript
	if (name === 'list_notes') {
		const notes = listStandaloneNotes()
		const body = notes.length ? notes.map((n) => `[id ${n.id}] ${n.title ?? '(untitled)'}`).join('\n') : '(no standalone notes)'
		return { result: body, step: step('list_notes', `${notes.length} notes`) }
	}
```

- [ ] **Step 9: 实现 — 改 `create_note` 执行分支.** 把现有:

```typescript
	if (name === 'create_note') {
		const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('create_note', key) }
		createNote({ itemId: item.id, title: a.title ? String(a.title) : null, content: String(a.content ?? ''), origin: 'ai' })
		return { result: `note added to "${item.title ?? key}"`, step: step('create_note', item.title ?? key) }
	}
```

替换为(支持独立笔记 + 走 saveNote):

```typescript
	if (name === 'create_note') {
		const title = a.title != null ? String(a.title) : null
		const content = String(a.content ?? '')
		if (key) {
			const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('create_note', key) }
			const id = saveNote({ itemId: item.id, title, content, origin: 'ai' })
			return { result: `note ${id} added to "${item.title ?? key}"`, step: step('create_note', item.title ?? key) }
		}
		if (!title || !title.trim()) return { result: 'error: a standalone concept note needs a title', step: step('create_note', '(no title)') }
		const id = saveNote({ title, content, origin: 'ai' })
		return { result: `standalone note ${id} created: "${title}"`, step: step('create_note', title) }
	}
```

- [ ] **Step 10: 实现 — 加 `update_note` 执行分支.** 紧接上面的 `create_note` 分支之后加:

```typescript
	if (name === 'update_note') {
		const noteId = Number(a.note_id)
		if (!Number.isInteger(noteId) || noteId <= 0) return { result: 'error: note_id must be a positive integer', step: step('update_note', '(bad id)') }
		const existing = getNote(noteId); if (!existing) return { result: `note not found: ${noteId}`, step: step('update_note', String(noteId)) }
		const title = a.title != null ? String(a.title) : existing.title
		const content = a.content != null ? String(a.content) : (existing.content ?? '')
		saveNote({ id: noteId, title, content, origin: 'ai' })
		return { result: `note ${noteId} updated`, step: step('update_note', title ?? String(noteId)) }
	}
```

- [ ] **Step 11: 跑测试确认通过** — Run: `npx vitest run src/main/knowledge/agentTools.test.ts`
  Expected: PASS(或 skip)。再 `npx tsc -p tsconfig.node.json --noEmit` → 干净(确认 `RetrievalStep` 联合类型已含新名,`createNote` 已无引用不报未用)。

- [ ] **Step 12: 提交**

```bash
git add src/shared/types.ts src/main/knowledge/agentTools.ts src/main/knowledge/agentTools.test.ts
git commit -m "feat(agent): standalone create_note + update_note + list_notes; read_notes shows ids; route via saveNote"
```

---

## Task 3: modes —— 把 update_note / list_notes 加进 notes 模式

**Files:** Modify `src/main/knowledge/modes.ts`(TAB 缩进)
- Test: `src/main/knowledge/modes.test.ts`(补一条)

- [ ] **Step 1: 补失败测试.** `src/main/knowledge/modes.test.ts` 顶部已 `import { routeMode, getMode, MODES } from './modes'`。在文件里(任意 `describe` 内或新加一个 `describe('notes mode tools', () => { ... })`)追加:

```typescript
	it('notes mode exposes the note-writing tools', () => {
		const tools = getMode('notes').tools
		expect(tools).toEqual(expect.arrayContaining(['create_note', 'update_note', 'list_notes', 'read_notes']))
	})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npx vitest run src/main/knowledge/modes.test.ts`
  Expected: FAIL(notes 模式还没有 update_note/list_notes)。此测试为纯逻辑,应真实运行。

- [ ] **Step 3: 实现.** 在 `src/main/knowledge/modes.ts` 把 `notes` 模式的 tools 行:

```typescript
		tools: ['search_library', 'read_item', 'list_items', 'create_note', 'link_items', 'read_notes'],
```

改为(加 `'update_note'`、`'list_notes'`):

```typescript
		tools: ['search_library', 'read_item', 'list_items', 'create_note', 'update_note', 'list_notes', 'link_items', 'read_notes'],
```

- [ ] **Step 4: 实现 — procedure 文案补一句.** 在同一 `notes` 模式对象的 `procedure` 文本里(现有以 "- To connect papers…"、"- End with a one-line summary…" 结尾),在结尾总结句之前插入一条:

```
- You may create standalone concept notes (create_note without item_key, title = the concept) and update existing notes (update_note by note_id — read it first with list_notes/read_notes before overwriting). Cross-link with [[Title]] in the body.
```

（保持原有其它 procedure 文本不动,仅插入这一行。）

- [ ] **Step 5: 跑测试确认通过** — Run: `npx vitest run src/main/knowledge/modes.test.ts`
  Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/knowledge/modes.ts src/main/knowledge/modes.test.ts
git commit -m "feat(modes): notes mode gains update_note + list_notes (+ procedure guidance)"
```

---

## Task 4: 全量验证

**Files:** 无(仅验证)

- [ ] **Step 1: 类型检查** — Run: `npx tsc -p tsconfig.node.json --noEmit`
  Expected: 干净无错。

- [ ] **Step 2: 全量测试** — Run: `npx vitest run`
  Expected: 全绿(DB 相关套件按 Electron ABI skip,属预期;纯逻辑测试如 wikilinks/modes 实跑通过)。

- [ ] **Step 3: 打包(顺带)** — Run: `npm run build`
  Expected: 成功。(本特性无渲染改动,build 非必需,但跑一次确认主进程改动不破坏打包。)

- [ ] **Step 4: 若前三步全过,进入 finishing-a-development-branch 收尾(合并 main + push,与既往一致)。**

---

## 附:验收标准(实现后应满足)

- AI 在 `notes` 模式可:①无 item_key 建独立概念笔记(缺 title 报错);②带 item_key 给论文建笔记;③按 note_id 整体重写笔记;④`list_notes` 列独立笔记 id+标题;⑤`read_notes` 输出含 id。
- 上述①③写入的 `[[Title]]` 自动对账为反向链接边(独立笔记、论文笔记均然),打开被指向对象能在反链栏看到来源;悬空 `[[X]]` 不建边、不建空壳。
- AI 笔记 `origin='ai'`/`updated_by='ai'`;渲染层 `notes:save`(用户手动)仍是 `origin='user'`,行为不变。
- `qa` 等模式仍拿不到这些写工具(mode 门控 + runTool 结构性拒绝,P1 已有,无需改)。
