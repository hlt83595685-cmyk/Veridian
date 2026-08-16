# P1 · AI 写能力地基 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Veridian 的聊天 AI 从只读问答升级为能对当前库执行写操作——建笔记、打标签、归类、建立条目间链接、补元数据、标星——并为知识图谱打下 `notes`(一等公民)与 `relations`(边)两张数据地基。

**Architecture:** 纯 Main 进程。新增两张表(重建 `notes` 使 `item_id` 可空并加 `title/origin/updated_by`;新建 `relations`)与对应仓储/服务,复用现有事件总线(`emit`)让既有面板即时刷新。给 tool-loop agent 增加一组写工具 + 结构感知读工具,item 通过 `item_key`(精确 + 唯一前缀兜底)解析。所有 AI 产生的笔记/边标 `origin='ai'`。

**Tech Stack:** TypeScript(strict, TABS), better-sqlite3, vitest, 现有 `getDb()` 每工作区一库 / `emit()` 事件总线 / OpenAI 兼容 function-calling(`providers.ts`)。

**Scope 说明(相对总设计的细化):**
- P1 里 `link_items` **直接写入** `relations`(`origin='ai'`,可删可逆)。总设计 §6 的"链接进审核队列(`suggestions`)"依赖 P4 的审核收件箱 UI——队列没有审核界面就是死数据,故 `suggestions` 表与分级审批**推迟到 P4**一并做。P1 只保证每条边带 `origin` 标记,后续可回溯/清理。
- P1 不做任何新面板(笔记编辑器、图谱、收件箱都在后续期)。标签/分类/元数据/星标的改动经现有事件在既有 UI 即时可见;笔记/边先由测试与聊天"改动摘要"验证。

---

## 文件结构

| 文件 | 职责 | 新建/修改 |
|---|---|---|
| `src/main/db/index.ts` | 迁移 9:重建 `notes`、新建 `relations` | 修改 |
| `src/main/db/notes.ts` | 笔记仓储(CRUD) | 新建 |
| `src/main/db/relations.ts` | 关系/边仓储(建/删/查双向) | 新建 |
| `src/main/db/tags.ts` | 新增**追加式** `addTagsToItem` | 修改 |
| `src/main/db/items.ts` | `permanentlyDeleteItem` 里清理关系 | 修改 |
| `src/shared/events.ts` | 新增 `note.changed` / `relation.changed` | 修改 |
| `src/shared/types.ts` | `RetrievalStep.tool` 扩充写/读工具名 | 修改 |
| `src/main/services/NoteService.ts` | 建/改/删笔记 + 发事件 | 新建 |
| `src/main/services/RelationService.ts` | 建/删边 + 发事件 | 新建 |
| `src/main/knowledge/agentTools.ts` | 写/读工具的 def + 执行器 + key 解析 | 新建 |
| `src/main/knowledge/agent.ts` | 接线工具 + 系统提示 | 修改 |
| `src/renderer/src/components/knowledge/RetrievalTrace.tsx` | 新工具的图标兜底 | 修改 |
| 对应 `*.test.ts` | 单测 | 新建 |

依赖顺序:迁移 → 事件/类型 → 仓储 → 服务 → 工具 → agent 接线 → 渲染兜底 → 全量验证。

---

## Task 1: 迁移 9 —— 重建 notes、新建 relations

**Files:**
- Modify: `src/main/db/index.ts`(在 `if (current < 8)` 块之后、`runMigrations` 函数结尾 `}` 之前追加)
- Test: `src/main/db/migration9.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/db/migration9.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

// The migration-9 SQL, extracted so it can run against a bare db in the test.
import { MIGRATION_9_SQL } from './index'

suite('migration 9', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    // Pre-9 shape: notes attached to items only.
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, key TEXT);
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        content TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO items (id, key) VALUES (1, 'k1');
      INSERT INTO notes (item_id, content) VALUES (1, 'legacy note');
    `)
  })
  afterEach(() => { db.close() })

  it('makes notes.item_id nullable and adds title/origin/updated_by, preserving rows', () => {
    db.exec(MIGRATION_9_SQL)
    const cols = (db.pragma('table_info(notes)') as { name: string; notnull: number }[])
    const itemId = cols.find((c) => c.name === 'item_id')!
    expect(itemId.notnull).toBe(0)                    // nullable now
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['title', 'origin', 'updated_by'])
    )
    const kept = db.prepare('SELECT content FROM notes WHERE id = 1').get() as { content: string }
    expect(kept.content).toBe('legacy note')
    // Standalone note (no item) is now allowed.
    expect(() => db.prepare("INSERT INTO notes (content) VALUES ('standalone')").run()).not.toThrow()
  })

  it('creates relations with a uniqueness guard', () => {
    db.exec(MIGRATION_9_SQL)
    db.prepare(`INSERT INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type)
                VALUES ('item', 1, 'item', 2, 'related')`).run()
    expect(() => db.prepare(`INSERT INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type)
                VALUES ('item', 1, 'item', 2, 'related')`).run()).toThrow()
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/main/db/migration9.test.ts`
Expected: FAIL —— `MIGRATION_9_SQL` 未导出。

- [ ] **Step 3: 实现迁移**

在 `src/main/db/index.ts` 顶部(import 之后、`runMigrations` 之前)导出 SQL 常量:

```typescript
// Migration 9 SQL, exported so migration9.test.ts can exercise it against a bare
// db. notes is rebuilt (SQLite cannot drop a NOT NULL constraint in-place) to
// make it a first-class knowledge-base node: standalone (item_id NULL) allowed,
// with a title and provenance flags. relations are the graph edges.
export const MIGRATION_9_SQL = `
  ALTER TABLE notes RENAME TO notes_old;
  CREATE TABLE notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
    title      TEXT,
    content    TEXT,
    origin     TEXT NOT NULL DEFAULT 'user',
    updated_by TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  INSERT INTO notes (id, item_id, content, created_at, updated_at)
    SELECT id, item_id, content, created_at, updated_at FROM notes_old;
  DROP TABLE notes_old;

  CREATE TABLE IF NOT EXISTS relations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    src_kind   TEXT NOT NULL,
    src_id     INTEGER NOT NULL,
    dst_kind   TEXT NOT NULL,
    dst_id     INTEGER NOT NULL,
    rel_type   TEXT NOT NULL,
    origin     TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type)
  );
  CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(src_kind, src_id);
  CREATE INDEX IF NOT EXISTS idx_relations_dst ON relations(dst_kind, dst_id);
`
```

在 `runMigrations` 里 `if (current < 8) { ... }` 之后追加:

```typescript
  if (current < 9) {
    db.exec(MIGRATION_9_SQL)
    db.exec(`INSERT INTO schema_version VALUES (9)`)
  }
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/main/db/migration9.test.ts`
Expected: PASS(若原生模块不可用则整套 skip —— 也算通过)。

- [ ] **Step 5: 提交**

```bash
git add src/main/db/index.ts src/main/db/migration9.test.ts
git commit -m "feat(db): migration 9 — first-class notes + relations table"
```

---

## Task 2: 事件与类型扩充

**Files:**
- Modify: `src/shared/events.ts`(`DomainEvent` 联合)
- Modify: `src/shared/types.ts`(`RetrievalStep.tool`)

无独立测试(纯类型),由后续任务的编译验证。

- [ ] **Step 1: 加事件**

在 `src/shared/events.ts` 的 `DomainEvent` 联合里,`| { type: 'creator.changed'; itemIds: number[] }` 之后加两行:

```typescript
  | { type: 'note.changed'; itemIds: number[] }
  | { type: 'relation.changed'; itemIds: number[] }
```

- [ ] **Step 2: 扩 RetrievalStep 工具名**

把 `src/shared/types.ts` 里 `RetrievalStep.tool` 的类型改为:

```typescript
export interface RetrievalStep {
  tool: 'search_library' | 'read_context' | 'get_item_info' | 'load_skill'
    | 'create_note' | 'add_tags' | 'add_to_collection' | 'link_items'
    | 'update_metadata' | 'set_star' | 'list_collections' | 'list_tags' | 'read_notes'
  label: string
  hits?: { key: string; title: string; chars: number }[]
}
```

- [ ] **Step 3: 编译验证**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: 通过(无新错误)。

- [ ] **Step 4: 提交**

```bash
git add src/shared/events.ts src/shared/types.ts
git commit -m "feat(shared): note/relation events + write-tool retrieval steps"
```

---

## Task 3: 笔记仓储 `notes.ts`

**Files:**
- Create: `src/main/db/notes.ts`
- Test: `src/main/db/notes.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/db/notes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { createNote, getNote, listNotesByItem, updateNote, deleteNote } from './notes'

suite('notes repo', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, title TEXT, content TEXT,
        origin TEXT NOT NULL DEFAULT 'user', updated_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
  })
  afterEach(() => { db.close() })

  it('creates and reads a note on an item', () => {
    const id = createNote({ itemId: 7, title: 'Summary', content: 'body', origin: 'ai' })
    const n = getNote(id)!
    expect(n.item_id).toBe(7)
    expect(n.title).toBe('Summary')
    expect(n.origin).toBe('ai')
    expect(n.updated_by).toBe('ai')
  })

  it('lists notes for an item', () => {
    createNote({ itemId: 7, content: 'a', origin: 'ai' })
    createNote({ itemId: 7, content: 'b', origin: 'user' })
    createNote({ itemId: 9, content: 'c', origin: 'user' })
    expect(listNotesByItem(7)).toHaveLength(2)
  })

  it('updates content and stamps updated_by', () => {
    const id = createNote({ itemId: 7, content: 'old', origin: 'ai' })
    updateNote(id, { content: 'new', updatedBy: 'user' })
    const n = getNote(id)!
    expect(n.content).toBe('new')
    expect(n.updated_by).toBe('user')
  })

  it('deletes a note', () => {
    const id = createNote({ itemId: 7, content: 'x', origin: 'user' })
    deleteNote(id)
    expect(getNote(id)).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/main/db/notes.test.ts`
Expected: FAIL —— `./notes` 不存在。

- [ ] **Step 3: 实现仓储**

`src/main/db/notes.ts`:

```typescript
import { getDb } from './index'

export interface Note {
  id: number
  item_id: number | null
  title: string | null
  content: string | null
  origin: string       // 'user' | 'ai'
  updated_by: string   // 'user' | 'ai'
  created_at: number
  updated_at: number
}

export interface NoteInput {
  itemId?: number | null
  title?: string | null
  content?: string | null
  origin?: 'user' | 'ai'
}

export function createNote(input: NoteInput): number {
  const origin = input.origin ?? 'user'
  const info = getDb().prepare(`
    INSERT INTO notes (item_id, title, content, origin, updated_by)
    VALUES (@item_id, @title, @content, @origin, @updated_by)
  `).run({
    item_id: input.itemId ?? null,
    title: input.title ?? null,
    content: input.content ?? null,
    origin,
    updated_by: origin,   // creator is the first editor
  })
  return Number(info.lastInsertRowid)
}

export function getNote(id: number): Note | undefined {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | undefined
}

export function listNotesByItem(itemId: number): Note[] {
  return getDb().prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id').all(itemId) as Note[]
}

export function updateNote(id: number, patch: { title?: string | null; content?: string | null; updatedBy: 'user' | 'ai' }): void {
  getDb().prepare(`
    UPDATE notes
    SET title = COALESCE(@title, title),
        content = COALESCE(@content, content),
        updated_by = @updated_by,
        updated_at = unixepoch()
    WHERE id = @id
  `).run({ id, title: patch.title ?? null, content: patch.content ?? null, updated_by: patch.updatedBy })
}

export function deleteNote(id: number): void {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id)
}

/** Manual cascade for permanent item deletion (FK cascade needs PRAGMA on). */
export function deleteNotesForItem(itemId: number): void {
  getDb().prepare('DELETE FROM notes WHERE item_id = ?').run(itemId)
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/main/db/notes.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/db/notes.ts src/main/db/notes.test.ts
git commit -m "feat(db): notes repository (first-class notes CRUD)"
```

---

## Task 4: 关系仓储 `relations.ts`

**Files:**
- Create: `src/main/db/relations.ts`
- Test: `src/main/db/relations.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/db/relations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { RELATION_TYPES, linkItems, unlink, listRelationsForItem, deleteRelationsForItem } from './relations'

suite('relations repo', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, src_kind TEXT NOT NULL, src_id INTEGER NOT NULL,
        dst_kind TEXT NOT NULL, dst_id INTEGER NOT NULL, rel_type TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type)
      );
    `)
  })
  afterEach(() => { db.close() })

  it('rejects an unknown rel_type', () => {
    expect(() => linkItems(1, 2, 'nonsense', 'ai')).toThrow(/rel_type/)
  })

  it('creates an item↔item edge and is idempotent', () => {
    expect(linkItems(1, 2, 'related', 'ai')).toBe(true)
    expect(linkItems(1, 2, 'related', 'ai')).toBe(false)   // duplicate ignored
    expect(listRelationsForItem(1)).toHaveLength(1)
  })

  it('lists edges in both directions', () => {
    linkItems(1, 2, 'extends', 'ai')
    linkItems(3, 1, 'contradicts', 'user')
    const rels = listRelationsForItem(1)
    expect(rels).toHaveLength(2)
    expect(rels.map((r) => r.rel_type).sort()).toEqual(['contradicts', 'extends'])
  })

  it('unlinks and bulk-deletes for an item', () => {
    linkItems(1, 2, 'related', 'ai')
    linkItems(1, 3, 'cites', 'ai')
    unlink(1, 2, 'related')
    expect(listRelationsForItem(1)).toHaveLength(1)
    deleteRelationsForItem(1)
    expect(listRelationsForItem(1)).toHaveLength(0)
  })

  it('exposes the fixed rel_type vocabulary', () => {
    expect(RELATION_TYPES).toEqual(['extends', 'contradicts', 'related', 'cites', 'same_method'])
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/main/db/relations.test.ts`
Expected: FAIL —— `./relations` 不存在。

- [ ] **Step 3: 实现仓储**

`src/main/db/relations.ts`:

```typescript
import { getDb } from './index'

// Fixed, small vocabulary of typed edges. Extend deliberately (also update the
// agent tool description + any UI legend).
export const RELATION_TYPES = ['extends', 'contradicts', 'related', 'cites', 'same_method'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

export interface Relation {
  id: number
  src_kind: string
  src_id: number
  dst_kind: string
  dst_id: number
  rel_type: string
  origin: string
  created_at: number
}

function assertRelType(t: string): asserts t is RelationType {
  if (!(RELATION_TYPES as readonly string[]).includes(t)) {
    throw new Error(`invalid rel_type "${t}" (expected one of ${RELATION_TYPES.join(', ')})`)
  }
}

/** Create a directed item→item edge. Returns false if it already existed. */
export function linkItems(srcItemId: number, dstItemId: number, relType: string, origin: 'user' | 'ai'): boolean {
  assertRelType(relType)
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type, origin)
    VALUES ('item', ?, 'item', ?, ?, ?)
  `).run(srcItemId, dstItemId, relType, origin)
  return info.changes > 0
}

export function unlink(srcItemId: number, dstItemId: number, relType: string): void {
  getDb().prepare(`
    DELETE FROM relations
    WHERE src_kind = 'item' AND src_id = ? AND dst_kind = 'item' AND dst_id = ? AND rel_type = ?
  `).run(srcItemId, dstItemId, relType)
}

/** All edges touching this item, in either direction. */
export function listRelationsForItem(itemId: number): Relation[] {
  return getDb().prepare(`
    SELECT * FROM relations
    WHERE (src_kind = 'item' AND src_id = ?) OR (dst_kind = 'item' AND dst_id = ?)
    ORDER BY id
  `).all(itemId, itemId) as Relation[]
}

export function deleteRelationsForItem(itemId: number): void {
  getDb().prepare(`
    DELETE FROM relations WHERE (src_kind = 'item' AND src_id = ?) OR (dst_kind = 'item' AND dst_id = ?)
  `).run(itemId, itemId)
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/main/db/relations.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/db/relations.ts src/main/db/relations.test.ts
git commit -m "feat(db): relations repository (typed graph edges)"
```

---

## Task 5: 追加式打标签 + 永久删除级联清理

**Files:**
- Modify: `src/main/db/tags.ts`(新增 `addTagsToItem`)
- Modify: `src/main/db/items.ts`(`permanentlyDeleteItem` 清理笔记/关系)
- Test: `src/main/db/tags.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/db/tags.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { addTagsToItem, getTagsByItem } from './tags'

suite('addTagsToItem', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE item_tags (item_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (item_id, tag_id));
    `)
  })
  afterEach(() => { db.close() })

  it('adds tags without removing existing ones', () => {
    addTagsToItem(1, ['graphene'])
    addTagsToItem(1, ['graphene', 'battery'])   // graphene already present
    expect(getTagsByItem(1).map((t) => t.name).sort()).toEqual(['battery', 'graphene'])
  })

  it('trims and ignores empty tag names', () => {
    addTagsToItem(1, ['  x  ', '', '   '])
    expect(getTagsByItem(1).map((t) => t.name)).toEqual(['x'])
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/main/db/tags.test.ts`
Expected: FAIL —— `addTagsToItem` 未导出。

- [ ] **Step 3: 实现**

在 `src/main/db/tags.ts` 末尾追加(**追加式**,不同于既有替换式 `setTagsForItem`):

```typescript
/** Add tags to an item without clearing existing ones (used by the AI). */
export function addTagsToItem(itemId: number, tagNames: string[]): void {
  const db = getDb()
  const upsertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
  const getTag = db.prepare('SELECT id FROM tags WHERE name = ?')
  const linkTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)')
  db.transaction(() => {
    for (const raw of tagNames) {
      const name = raw.trim()
      if (!name) continue
      upsertTag.run(name)
      const row = getTag.get(name) as { id: number }
      linkTag.run(itemId, row.id)
    }
  })()
}
```

在 `src/main/db/items.ts` 顶部 import 之后加:

```typescript
import { deleteRelationsForItem } from './relations'
import { deleteNotesForItem } from './notes'
```

把 `permanentlyDeleteItem` 改为先清理关系/笔记(关系无 FK,笔记 FK 在 PRAGMA 关闭时不级联,故显式删):

```typescript
export function permanentlyDeleteItem(id: number): void {
  deleteRelationsForItem(id)
  deleteNotesForItem(id)
  getDb().prepare('DELETE FROM items WHERE id = ?').run(id)
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/main/db/tags.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/db/tags.ts src/main/db/items.ts src/main/db/tags.test.ts
git commit -m "feat(db): additive addTagsToItem + cascade cleanup on permanent delete"
```

---

## Task 6: 服务层 NoteService / RelationService(发事件)

**Files:**
- Create: `src/main/services/NoteService.ts`
- Create: `src/main/services/RelationService.ts`

沿用 `CreatorService` 模式(仓储 + `appendOp` + `emit`)。无独立单测(薄封装),由 Task 8 的执行器集成测试与编译覆盖。参考 `src/main/services/CreatorService.ts` 的写法。

- [ ] **Step 1: NoteService**

`src/main/services/NoteService.ts`:

```typescript
import { createNote as repoCreate, updateNote as repoUpdate, deleteNote as repoDelete, listNotesByItem, type NoteInput } from '../db/notes'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export { listNotesByItem }

export function createNote(input: NoteInput): number {
  const id = repoCreate(input)
  appendOp('note', id, 'create', { itemId: input.itemId ?? null, origin: input.origin ?? 'user' })
  if (input.itemId != null) emit({ type: 'note.changed', itemIds: [input.itemId] })
  return id
}

export function updateNote(id: number, itemId: number | null, patch: { title?: string | null; content?: string | null; updatedBy: 'user' | 'ai' }): void {
  repoUpdate(id, patch)
  appendOp('note', id, 'modify', {})
  if (itemId != null) emit({ type: 'note.changed', itemIds: [itemId] })
}

export function deleteNote(id: number, itemId: number | null): void {
  repoDelete(id)
  appendOp('note', id, 'delete', {})
  if (itemId != null) emit({ type: 'note.changed', itemIds: [itemId] })
}
```

- [ ] **Step 2: RelationService**

`src/main/services/RelationService.ts`:

```typescript
import { linkItems as repoLink, unlink as repoUnlink, listRelationsForItem } from '../db/relations'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export { listRelationsForItem }

/** Returns false if the edge already existed. */
export function linkItems(srcItemId: number, dstItemId: number, relType: string, origin: 'user' | 'ai'): boolean {
  const created = repoLink(srcItemId, dstItemId, relType, origin)
  if (created) {
    appendOp('relation', srcItemId, 'create', { dst: dstItemId, relType, origin })
    emit({ type: 'relation.changed', itemIds: [srcItemId, dstItemId] })
  }
  return created
}

export function unlink(srcItemId: number, dstItemId: number, relType: string): void {
  repoUnlink(srcItemId, dstItemId, relType)
  emit({ type: 'relation.changed', itemIds: [srcItemId, dstItemId] })
}
```

- [ ] **Step 3: 编译验证**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 通过。（若 `appendOp` 的 `object_type` 有联合类型约束,按其允许集调整;`oplog.ts` 当前签名接受任意字符串 —— 见该文件。）

- [ ] **Step 4: 提交**

```bash
git add src/main/services/NoteService.ts src/main/services/RelationService.ts
git commit -m "feat(services): NoteService + RelationService with domain events"
```

---

## Task 7: agent 写/读工具 `agentTools.ts`

**Files:**
- Create: `src/main/knowledge/agentTools.ts`
- Test: `src/main/knowledge/agentTools.test.ts`

- [ ] **Step 1: 写失败测试**(执行器直连内存库,验证 DB 状态)

`src/main/knowledge/agentTools.test.ts`:

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

import { executeAgentTool, AGENT_ACTION_TOOL_NAMES } from './agentTools'

suite('agent write tools', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, title TEXT, deleted INTEGER DEFAULT 0,
        abstract TEXT, year INTEGER, journal TEXT, doi TEXT, url TEXT, publisher TEXT, volume TEXT,
        issue TEXT, pages TEXT, isbn TEXT, language TEXT, extra TEXT, updated_at INTEGER DEFAULT 0, version INTEGER DEFAULT 0, starred INTEGER DEFAULT 0);
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
      CREATE TABLE item_tags (item_id INTEGER, tag_id INTEGER, PRIMARY KEY (item_id, tag_id));
      CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER DEFAULT 1, parent_id INTEGER, name TEXT, key TEXT UNIQUE);
      CREATE TABLE collection_items (collection_id INTEGER, item_id INTEGER, PRIMARY KEY (collection_id, item_id));
      CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, title TEXT, content TEXT,
        origin TEXT DEFAULT 'user', updated_by TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
      CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_kind TEXT, src_id INTEGER, dst_kind TEXT, dst_id INTEGER,
        rel_type TEXT, origin TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type));
      INSERT INTO items (key, title) VALUES ('AAAA1111', 'Paper A'), ('BBBB2222', 'Paper B');
    `)
  })
  afterEach(() => { db.close() })

  it('add_tags attaches tags to the resolved item', async () => {
    const { step } = await executeAgentTool('add_tags', JSON.stringify({ item_key: 'AAAA1111', tags: ['graphene', 'battery'] }))
    expect(step.tool).toBe('add_tags')
    const n = db.prepare('SELECT COUNT(*) AS n FROM item_tags').get() as { n: number }
    expect(n.n).toBe(2)
  })

  it('create_note writes an ai-origin note on the item', async () => {
    await executeAgentTool('create_note', JSON.stringify({ item_key: 'AAAA1111', title: 'Summary', content: 'body' }))
    const note = db.prepare('SELECT * FROM notes').get() as { origin: string; title: string }
    expect(note.origin).toBe('ai')
    expect(note.title).toBe('Summary')
  })

  it('link_items creates a typed edge between two papers', async () => {
    await executeAgentTool('link_items', JSON.stringify({ from_key: 'AAAA1111', to_key: 'BBBB2222', rel_type: 'extends' }))
    const rel = db.prepare('SELECT * FROM relations').get() as { rel_type: string; origin: string }
    expect(rel.rel_type).toBe('extends')
    expect(rel.origin).toBe('ai')
  })

  it('add_to_collection creates the collection when missing', async () => {
    await executeAgentTool('add_to_collection', JSON.stringify({ item_key: 'AAAA1111', collection: 'Energy' }))
    const c = db.prepare('SELECT * FROM collections').get() as { name: string }
    expect(c.name).toBe('Energy')
    const link = db.prepare('SELECT COUNT(*) AS n FROM collection_items').get() as { n: number }
    expect(link.n).toBe(1)
  })

  it('update_metadata patches only provided fields', async () => {
    await executeAgentTool('update_metadata', JSON.stringify({ item_key: 'AAAA1111', year: 2021 }))
    const it = db.prepare("SELECT year, title FROM items WHERE key = 'AAAA1111'").get() as { year: number; title: string }
    expect(it.year).toBe(2021)
    expect(it.title).toBe('Paper A')   // untouched
  })

  it('resolves a truncated (unique prefix) key', async () => {
    await executeAgentTool('set_star', JSON.stringify({ item_key: 'AAAA', starred: true }))
    const it = db.prepare("SELECT starred FROM items WHERE key = 'AAAA1111'").get() as { starred: number }
    expect(it.starred).toBe(1)
  })

  it('returns an error step for an unknown item key', async () => {
    const { result } = await executeAgentTool('add_tags', JSON.stringify({ item_key: 'ZZZZ', tags: ['x'] }))
    expect(result).toMatch(/not found/i)
  })

  it('exposes the action tool name set', () => {
    expect(AGENT_ACTION_TOOL_NAMES.has('create_note')).toBe(true)
    expect(AGENT_ACTION_TOOL_NAMES.has('search_library')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行,确认失败**

Run: `npx vitest run src/main/knowledge/agentTools.test.ts`
Expected: FAIL —— `./agentTools` 不存在。

- [ ] **Step 3: 实现工具模块**

`src/main/knowledge/agentTools.ts`:

```typescript
// AI library-action tools: the write half of the chat agent (the read half —
// search_library / read_context / get_item_info — lives in agent.ts). Each
// executor resolves an item_key (exact, then unique-prefix fallback for the
// truncated UUID keys folder-backed libraries use), performs the mutation via a
// Service (which emits a domain event), and returns a short confirmation plus a
// RetrievalStep for the trace panel. AI-created notes/edges are tagged origin='ai'.
import { getDb } from '../db'
import { addTagsToItem, getAllTags } from '../db/tags'
import { getAllCollections, createCollection, addItemToCollection } from '../db/collections'
import { updateItem, setStarred } from '../db/items'
import { createNote, listNotesByItem } from '../services/NoteService'
import { linkItems } from '../services/RelationService'
import { RELATION_TYPES } from '../db/relations'
import { emit } from '../core/Notifier'
import type { ToolDef } from './providers'
import type { RetrievalStep } from '../../shared/types'

function resolveItem(key: string): { id: number; title: string | null } | null {
  const db = getDb()
  let row = db.prepare('SELECT id, title FROM items WHERE key = ? AND deleted = 0')
    .get(key) as { id: number; title: string | null } | undefined
  if (!row) {
    const like = key.replace(/[\\%_]/g, '\\$&') + '%'
    const hits = db.prepare("SELECT id, title FROM items WHERE key LIKE ? ESCAPE '\\' AND deleted = 0 LIMIT 2")
      .all(like) as { id: number; title: string | null }[]
    if (hits.length === 1) row = hits[0]
  }
  return row ?? null
}

export const AGENT_READ_TOOLS: ToolDef[] = [
  { type: 'function', function: {
      name: 'list_collections',
      description: 'List the collections (folders) in the current library, so you can file papers correctly.',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
      name: 'list_tags',
      description: 'List every tag already used in the current library, to reuse consistent tag names.',
      parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
      name: 'read_notes',
      description: 'Read the notes already attached to one paper.',
      parameters: { type: 'object', properties: { item_key: { type: 'string' } }, required: ['item_key'] } } },
]

export const AGENT_WRITE_TOOLS: ToolDef[] = [
  { type: 'function', function: {
      name: 'create_note',
      description: 'Attach a note to a paper. Use for summaries or observations the user asks you to save.',
      parameters: { type: 'object', properties: {
        item_key: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
      }, required: ['item_key', 'content'] } } },
  { type: 'function', function: {
      name: 'add_tags',
      description: 'Add one or more keyword tags to a paper (existing tags are kept).',
      parameters: { type: 'object', properties: {
        item_key: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      }, required: ['item_key', 'tags'] } } },
  { type: 'function', function: {
      name: 'add_to_collection',
      description: 'File a paper into a collection (folder), creating the collection if it does not exist.',
      parameters: { type: 'object', properties: {
        item_key: { type: 'string' }, collection: { type: 'string' },
      }, required: ['item_key', 'collection'] } } },
  { type: 'function', function: {
      name: 'link_items',
      description: `Create a typed link between two papers. rel_type must be one of: ${RELATION_TYPES.join(', ')}.`,
      parameters: { type: 'object', properties: {
        from_key: { type: 'string' }, to_key: { type: 'string' }, rel_type: { type: 'string' },
      }, required: ['from_key', 'to_key', 'rel_type'] } } },
  { type: 'function', function: {
      name: 'update_metadata',
      description: 'Correct bibliographic fields of a paper. Only pass fields you want to change.',
      parameters: { type: 'object', properties: {
        item_key: { type: 'string' },
        title: { type: 'string' }, abstract: { type: 'string' }, year: { type: 'number' },
        journal: { type: 'string' }, doi: { type: 'string' }, url: { type: 'string' },
        volume: { type: 'string' }, issue: { type: 'string' }, pages: { type: 'string' },
      }, required: ['item_key'] } } },
  { type: 'function', function: {
      name: 'set_star',
      description: 'Mark or unmark a paper as important (starred).',
      parameters: { type: 'object', properties: {
        item_key: { type: 'string' }, starred: { type: 'boolean' },
      }, required: ['item_key', 'starred'] } } },
]

export const AGENT_ACTION_TOOLS: ToolDef[] = [...AGENT_READ_TOOLS, ...AGENT_WRITE_TOOLS]
export const AGENT_ACTION_TOOL_NAMES = new Set(AGENT_ACTION_TOOLS.map((t) => t.function.name))

type Step = RetrievalStep['tool']

function step(tool: Step, label: string): RetrievalStep {
  return { tool, label }
}

export async function executeAgentTool(name: string, argsJson: string): Promise<{ result: string; step: RetrievalStep }> {
  let a: Record<string, unknown>
  try { a = JSON.parse(argsJson || '{}') } catch { return { result: 'error: invalid arguments', step: step(name as Step, '(bad args)') } }
  const key = String(a.item_key ?? '')

  if (name === 'list_collections') {
    const names = getAllCollections().map((c) => c.name)
    return { result: names.length ? names.join('\n') : '(no collections)', step: step('list_collections', `${names.length} collections`) }
  }
  if (name === 'list_tags') {
    const names = getAllTags().map((t) => t.name)
    return { result: names.length ? names.join(', ') : '(no tags)', step: step('list_tags', `${names.length} tags`) }
  }
  if (name === 'read_notes') {
    const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('read_notes', key) }
    const notes = listNotesByItem(item.id)
    const body = notes.length ? notes.map((n) => `- ${n.title ?? '(untitled)'}: ${n.content ?? ''}`).join('\n') : '(no notes)'
    return { result: body, step: step('read_notes', item.title ?? key) }
  }

  if (name === 'create_note') {
    const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('create_note', key) }
    createNote({ itemId: item.id, title: a.title ? String(a.title) : null, content: String(a.content ?? ''), origin: 'ai' })
    return { result: `note added to "${item.title ?? key}"`, step: step('create_note', item.title ?? key) }
  }
  if (name === 'add_tags') {
    const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('add_tags', key) }
    const tags = Array.isArray(a.tags) ? a.tags.map(String) : []
    addTagsToItem(item.id, tags)
    emit({ type: 'tag.changed', itemIds: [item.id] })
    return { result: `tagged "${item.title ?? key}" with: ${tags.join(', ')}`, step: step('add_tags', tags.join(', ')) }
  }
  if (name === 'add_to_collection') {
    const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('add_to_collection', key) }
    const cname = String(a.collection ?? '').trim()
    if (!cname) return { result: 'error: empty collection name', step: step('add_to_collection', '(empty)') }
    const existing = getAllCollections().find((c) => c.name === cname)
    const col = existing ?? createCollection(cname)
    addItemToCollection(col.id, item.id)
    emit({ type: 'collection.changed', ids: [col.id] })
    return { result: `filed "${item.title ?? key}" into "${cname}"`, step: step('add_to_collection', cname) }
  }
  if (name === 'link_items') {
    const src = resolveItem(String(a.from_key ?? '')); const dst = resolveItem(String(a.to_key ?? ''))
    if (!src) return { result: `item not found: ${a.from_key}`, step: step('link_items', String(a.from_key ?? '')) }
    if (!dst) return { result: `item not found: ${a.to_key}`, step: step('link_items', String(a.to_key ?? '')) }
    const relType = String(a.rel_type ?? '')
    try {
      const created = linkItems(src.id, dst.id, relType, 'ai')
      return { result: created ? `linked "${src.title ?? src.id}" —${relType}→ "${dst.title ?? dst.id}"` : 'link already existed', step: step('link_items', relType) }
    } catch (err) {
      return { result: `error: ${(err as Error).message}`, step: step('link_items', relType) }
    }
  }
  if (name === 'update_metadata') {
    const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('update_metadata', key) }
    const patch: Record<string, unknown> = {}
    for (const f of ['title', 'abstract', 'year', 'journal', 'doi', 'url', 'volume', 'issue', 'pages'] as const) {
      if (a[f] !== undefined) patch[f] = a[f]
    }
    updateItem(item.id, patch as Parameters<typeof updateItem>[1])
    emit({ type: 'item.modified', ids: [item.id] })
    return { result: `updated metadata of "${item.title ?? key}"`, step: step('update_metadata', Object.keys(patch).join(', ')) }
  }
  if (name === 'set_star') {
    const item = resolveItem(key); if (!item) return { result: `item not found: ${key}`, step: step('set_star', key) }
    setStarred(item.id, Boolean(a.starred))
    emit({ type: 'item.modified', ids: [item.id] })
    return { result: `${a.starred ? 'starred' : 'unstarred'} "${item.title ?? key}"`, step: step('set_star', item.title ?? key) }
  }

  return { result: `error: unknown tool ${name}`, step: step(name as Step, '(unknown)') }
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `npx vitest run src/main/knowledge/agentTools.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/knowledge/agentTools.ts src/main/knowledge/agentTools.test.ts
git commit -m "feat(knowledge): AI library-action tools (write + structure-aware read)"
```

---

## Task 8: 把工具接线进 agent + 系统提示

**Files:**
- Modify: `src/main/knowledge/agent.ts`

- [ ] **Step 1: 导入工具模块**

在 `src/main/knowledge/agent.ts` 顶部 import 段(`import { listInstalledSkills, getSkillBody } from './skills'` 附近)加:

```typescript
import { AGENT_ACTION_TOOLS, AGENT_ACTION_TOOL_NAMES, executeAgentTool } from './agentTools'
```

- [ ] **Step 2: runTool 委派动作工具**

在 `runTool` 函数体最前面(`let args: Record<string, unknown>` 解析之前)加一条委派:

```typescript
	if (AGENT_ACTION_TOOL_NAMES.has(name)) return executeAgentTool(name, argsJson)
```

（动作工具自解析参数、不受只读检索的 `filter` 约束,故先行返回。）

- [ ] **Step 3: 把动作工具加入 tools 列表**

在 `runTurn` 里,把:

```typescript
		const tools = listInstalledSkills().length ? [...BASE_TOOLS, LOAD_SKILL_TOOL] : BASE_TOOLS
```

改为:

```typescript
		const tools = [
			...BASE_TOOLS,
			...AGENT_ACTION_TOOLS,
			...(listInstalledSkills().length ? [LOAD_SKILL_TOOL] : []),
		]
```

- [ ] **Step 4: 系统提示增加"库操作"段**

把 `BASE_SYSTEM_PROMPT` 末尾(现有以 `Never write math as plain text.` 结尾的模板字符串内)追加:

```typescript
- Library actions: you can MODIFY the user's library, but ONLY when they explicitly ask you to organise, annotate, or fix something (e.g. "tag this", "add a note", "link these two", "put it in a collection", "fix the year"). For plain questions you must NEVER modify anything.
  - create_note(item_key, title, content): save a note on a paper.
  - add_tags(item_key, tags): add keyword tags (call list_tags first to reuse existing names).
  - add_to_collection(item_key, collection): file a paper into a collection (call list_collections first).
  - link_items(from_key, to_key, rel_type): connect two papers; rel_type ∈ extends | contradicts | related | cites | same_method.
  - update_metadata(item_key, ...fields): correct bibliographic fields.
  - set_star(item_key, starred): mark a paper important.
  After acting, tell the user in one line exactly what you changed.
```

- [ ] **Step 5: 类型检查 + 全量单测**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run`
Expected: 类型通过;单测全绿(DB 用例在原生模块不可用时 skip)。

- [ ] **Step 6: 提交**

```bash
git add src/main/knowledge/agent.ts
git commit -m "feat(knowledge): wire library-action tools + action guidance into agent"
```

---

## Task 9: 检索轨迹面板 —— 新工具图标兜底

**Files:**
- Modify: `src/renderer/src/components/knowledge/RetrievalTrace.tsx`

- [ ] **Step 1: 查看现有 ICON_PATHS 与查找逻辑**

Read `src/renderer/src/components/knowledge/RetrievalTrace.tsx`,定位 `ICON_PATHS`(按 `step.tool` 取 SVG path 的映射)与其取用处。

- [ ] **Step 2: 为写/读动作补一个通用"动作"图标兜底**

在 `ICON_PATHS` 对象里为新工具加同一个"铅笔/闪电"通用 path(避免 `undefined` 导致空图标)。示例(用一个简单铅笔 path 作兜底,所有动作工具共用):

```typescript
const ACTION_ICON = 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'   // pencil
// ...在 ICON_PATHS 中:
  create_note: ACTION_ICON,
  add_tags: ACTION_ICON,
  add_to_collection: ACTION_ICON,
  link_items: ACTION_ICON,
  update_metadata: ACTION_ICON,
  set_star: ACTION_ICON,
  list_collections: ACTION_ICON,
  list_tags: ACTION_ICON,
  read_notes: ACTION_ICON,
```

若取用处形如 `ICON_PATHS[step.tool] ?? FALLBACK`,则确认存在 `?? FALLBACK`;若无,改为 `ICON_PATHS[step.tool] ?? ACTION_ICON` 以彻底避免空值。

- [ ] **Step 3: 构建验证(渲染器不能只靠 typecheck —— 见项目记忆)**

Run: `npm run build`
Expected: 成功(打包无错,无大小写撞名等)。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/knowledge/RetrievalTrace.tsx
git commit -m "feat(knowledge-ui): show library-action steps in retrieval trace"
```

---

## Task 10: 全量验证 + 手动 E2E 冒烟

**Files:** 无(仅验证)

- [ ] **Step 1: 全量类型检查 + 单测 + 构建**

Run:
```bash
npm run typecheck && npm run test && npm run build
```
Expected: 三者全绿。

- [ ] **Step 2: 手动冒烟(需真实模型配置)**

启动 app(若用户已开着实例则复用,勿另起 —— 见项目记忆),在知识助手里对某篇已导入论文验证:
1. "给这篇论文打上 石墨烯、储能 两个标签" → 详情页标签即时出现,聊天回一句改动摘要。
2. "把它归到 储能材料 分类" → 左栏出现该分类并含此条目。
3. "给这篇写一条一句话摘要笔记" → `notes` 表新增一条 `origin='ai'`(可用 DB 检查或后续笔记 UI 验证)。
4. "把这篇和《X》建立 extends 关系" → `relations` 表新增一条 `origin='ai'`。
5. 纯提问一句(如"这篇讲了什么") → **不触发任何写工具**(检索轨迹里只有 search_library)。

- [ ] **Step 3: 记录结果**

把冒烟结果记在 PR/提交说明;如某步失败,回到对应 Task 修复。

---

## 自检(spec 覆盖)

- 写能力(建笔记/打标签/加分类/建链/补元数据/标星):Task 3–8 覆盖 ✅
- 结构感知读工具(list_collections/list_tags/read_notes):Task 7 ✅
- 一等公民笔记(可空 item_id + title + origin):Task 1、3 ✅
- relations 边(图谱数据地基):Task 1、4 ✅
- AI 产出标 `origin='ai'`:Task 3、4、7 ✅
- 既有 UI 即时刷新(事件):Task 2、6、7(tag/collection/item 事件)✅
- 审批/`suggestions` 队列:**按 scope 说明推迟到 P4**(P1 直接写入 + origin 标记)——非遗漏,已在开头 Scope 说明 ✅
- 渲染器不回归(build):Task 9、10 ✅
