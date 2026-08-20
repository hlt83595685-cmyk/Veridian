# 批量导入健壮性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让批量导入中「一篇 PDF 出错」只影响那一篇——既不再卡住整批的「搬进用户文件夹」，也不再让任何已导入的条目在重启后被误删。

**Architecture:** 三处外科式修复。(1) 转换的「全部转完」信号改由 `JobQueue` 自身记账派生，取代 `ConversionService` 里那个在异常路径会漏减、一旦漏减就永久卡死的手工计数器。(2) `WorkspaceFiles.importAll` 的「删除陈旧条目」加一道保险：只删除确实被导出过（至少一个附件位于内容根之内）的条目，纯本地条目永不删除。(3) 本地文件夹型工作空间不再把 `conversion_failed=1` 的条目排除在导出之外，并让该状态经 `item.json` 往返保留；github 工作空间行为逐字节不变。

**Tech Stack:** TypeScript (strict, 无 `any`)、Electron 主进程、better-sqlite3、vitest。

**缩进约定（务必遵守）：** 本计划触及的所有文件（`src/main/core/JobQueue.ts`、`src/main/services/*.ts`）均使用 **2 空格缩进**。新建的测试文件同样用 2 空格。不要用 tab。

**验证约定：** DB 相关测试在本机 Electron ABI 下会被 `dbUsable` 守卫跳过（属既有约定，不是失败）。Task 1 的 JobQueue 测试是**纯逻辑、不碰 DB，必须真实跑过**——它正是 Bug C 的回归测试。

---

### Task 1: JobQueue 派生空闲信号（修复卡死）

`JobQueue` 已经健壮记账：每个任务无论成功还是抛错，都在 `run()` 内被结算，`drain()` 的 `.finally` 里减活跃计数。本任务把「某类任务全部干完」做成 JobQueue 自己的能力，供 `ConversionService` 取代易漏减的手工计数器。

注意一个易漏的边界：任务失败后若还有重试次数，它会在 `setTimeout` 退避期间**既不在 `running` 也不在 `queue`**。若不单独记账，`isBusy` 会在退避窗口内误报「空闲」。因此引入 `retrying` 计数。

**Files:**
- Modify: `src/main/core/JobQueue.ts`
- Test: `src/main/core/JobQueue.test.ts` (create)

- [ ] **Step 1: 写失败测试**

创建 `src/main/core/JobQueue.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'

// Notifier pulls in electron's BrowserWindow; the queue's progress events are
// irrelevant here, so stub the whole module.
vi.mock('./Notifier', () => ({ emit: () => {} }))

import { registerJobType, enqueue, isBusy } from './JobQueue'

// The queue keeps module-level state, so every test registers its own job type
// name to stay isolated from the others.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('JobQueue idle signalling', () => {
  it('fires onIdle once after a batch completes', async () => {
    const onIdle = vi.fn()
    registerJobType<number>('t.ok', async () => {}, { concurrency: 1, onIdle })

    enqueue('t.ok', 'a', 1)
    enqueue('t.ok', 'b', 2)
    await flush()

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(isBusy('t.ok')).toBe(false)
  })

  it('still fires onIdle when a job throws (idle signal never wedges)', async () => {
    const onIdle = vi.fn()
    registerJobType<number>('t.throw', async (n) => {
      if (n === 1) throw new Error('boom')
    }, { concurrency: 1, maxAttempts: 1, onIdle })

    enqueue('t.throw', 'bad', 1)
    enqueue('t.throw', 'good', 2)
    await flush()

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(isBusy('t.throw')).toBe(false)
  })

  it('stays busy while a failed job waits for its retry backoff', async () => {
    registerJobType<number>('t.retry', async () => { throw new Error('boom') },
      { concurrency: 1, maxAttempts: 2 })

    enqueue('t.retry', 'r', 1)
    await flush()

    // First attempt failed; the retry is sitting in its backoff timer. Neither
    // running nor queued -- but the type is NOT idle.
    expect(isBusy('t.retry')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/core/JobQueue.test.ts`
Expected: FAIL — `isBusy` 不存在（`SyntaxError: The requested module './JobQueue' does not provide an export named 'isBusy'`，或 TS 报未导出）。

- [ ] **Step 3: 实现**

在 `src/main/core/JobQueue.ts` 修改：

`JobTypeConfig` 接口加 `onIdle`：

```typescript
interface JobTypeConfig {
  concurrency: number
  maxAttempts: number
  handler: JobHandler<unknown>
  onIdle?: () => void
}
```

模块级状态加一个退避计数（放在 `const running = ...` 那行下面）：

```typescript
const retrying = new Map<string, number>()  // type -> jobs waiting out a backoff
```

`registerJobType` 接受并保存 `onIdle`：

```typescript
export function registerJobType<P>(
  type: string,
  handler: JobHandler<P>,
  opts: { concurrency?: number; maxAttempts?: number; onIdle?: () => void } = {}
): void {
  types.set(type, {
    concurrency: opts.concurrency ?? 1,
    maxAttempts: opts.maxAttempts ?? 1,
    handler: handler as JobHandler<unknown>,
    onIdle: opts.onIdle,
  })
}
```

新增导出 `isBusy`（放在 `pendingOf` 下面）：

```typescript
/**
 * Is this job type still working? True while anything is running, queued, or
 * waiting out a retry backoff. Derived from the queue's own bookkeeping, which
 * settles every job exactly once even when its handler throws -- callers get an
 * idle signal that cannot wedge.
 */
export function isBusy(type: string): boolean {
  return (running.get(type) ?? 0) > 0 || pendingOf(type) > 0 || (retrying.get(type) ?? 0) > 0
}
```

`drain()` 的 `.finally` 里，在 `drain()` 之后判定空闲：

```typescript
      run(job, cfg).finally(() => {
        running.set(job.type, (running.get(job.type) ?? 1) - 1)
        drain()
        if (!isBusy(job.type)) cfg.onIdle?.()
      })
```

`run()` 的重试分支要把退避期计入忙碌：

```typescript
    if (job.attempts < cfg.maxAttempts) {
      const backoff = Math.min(30_000, 1000 * 2 ** job.attempts)
      pushStatus(job, 'queued', `失败，${Math.round(backoff / 1000)}s 后重试...`)
      retrying.set(job.type, (retrying.get(job.type) ?? 0) + 1)
      setTimeout(() => {
        retrying.set(job.type, (retrying.get(job.type) ?? 1) - 1)
        queue.push(job)
        drain()
      }, backoff)
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/core/JobQueue.test.ts`
Expected: PASS，3 tests passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/core/JobQueue.ts src/main/core/JobQueue.test.ts
git commit -m "feat(queue): per-type onIdle + isBusy derived from queue bookkeeping"
```

---

### Task 2: ConversionService 改用队列空闲信号（消除卡死根因）

删掉 `pendingConversions` 手工计数器——它的 `--` 在 `finally` 里，但 `stagingDir()`（内部 `rmSync`+`mkdirSync`，Windows 上遇文件占用会抛 `EBUSY`/`EPERM`）在 `try` **之外**，一旦抛错该篇永不减计数，`hasPendingConversions()` 永远为真，「搬进用户文件夹」的 sync 永不触发。

**Files:**
- Modify: `src/main/services/ConversionService.ts:74-83`（计数器与访问器）、`:86-123`（处理器主体）、`:147`、`:166`（两处 `++`）

- [ ] **Step 1: 改造计数器与访问器**

把 `src/main/services/ConversionService.ts` 中这段（原 74-83 行）：

```typescript
let pendingConversions = 0
let onIdle: (() => void) | null = null

export function hasPendingConversions(): boolean {
  return pendingConversions > 0
}

export function setOnConversionsIdle(fn: () => void): void {
  onIdle = fn
}
```

替换为：

```typescript
// Busy-ness is derived from the JobQueue's own bookkeeping rather than a manual
// counter: a handler that throws before its finally block used to leak a count
// and wedge the idle signal forever, which stranded a whole batch's converted
// files in staging instead of relocating them into the workspace folder.
let onIdleHook: (() => void) | null = null

export function hasPendingConversions(): boolean {
  return isBusy('pdf2md')
}

export function setOnConversionsIdle(fn: () => void): void {
  onIdleHook = fn
}
```

并把顶部第 10 行的 import 改为同时引入 `isBusy`：

```typescript
import { registerJobType, enqueue, isBusy } from '../core/JobQueue'
```

- [ ] **Step 2: 把 stagingDir 挪进 try，并去掉 finally**

把处理器（原 86-123 行）的头部：

```typescript
  registerJobType<Pdf2mdPayload>('pdf2md', async (payload, ctx) => {
    const { itemId, pdfPath } = payload
    const outputPath = join(stagingDir(itemId), `${basename(pdfPath, '.pdf')}.md`)
    try {
      const mode = getPdf2mdMode()
```

改为（`stagingDir` 进入 try，使其抛错走正常的失败路径而非逃逸）：

```typescript
  registerJobType<Pdf2mdPayload>('pdf2md', async (payload, ctx) => {
    const { itemId, pdfPath } = payload
    try {
      const outputPath = join(stagingDir(itemId), `${basename(pdfPath, '.pdf')}.md`)
      const mode = getPdf2mdMode()
```

并把结尾的 `catch`/`finally`（原 115-123 行）：

```typescript
    } catch (err) {
      setConversionFailed(itemId, true)    // hold this item out of sync
      emit({ type: 'item.modified', ids: [itemId] })   // surface the red flag in the list now
      throw err                            // keep JobQueue's error reporting
    } finally {
      pendingConversions--
      if (pendingConversions === 0) onIdle?.()
    }
  }, { concurrency: 1, maxAttempts: 1 })
```

改为：

```typescript
    } catch (err) {
      setConversionFailed(itemId, true)    // flag the item; it still exports
      emit({ type: 'item.modified', ids: [itemId] })   // surface the red flag in the list now
      throw err                            // keep JobQueue's error reporting
    }
  }, { concurrency: 1, maxAttempts: 1, onIdle: () => onIdleHook?.() })
```

- [ ] **Step 3: 删掉两处计数器自增**

`autoConvertPdfToMd`（原 147 行）删掉 `pendingConversions++`，只留 enqueue：

```typescript
  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfPath), { itemId, pdfPath })
```

`manualConvertPdfToMd`（原 166 行）同样删掉它上面的 `pendingConversions++`，只留：

```typescript
  enqueue<Pdf2mdPayload>('pdf2md', basename(pdfAtt.path), { itemId, pdfPath: pdfAtt.path })
```

- [ ] **Step 4: 确认再无残留引用**

Run: `grep -n "pendingConversions" src/main/services/ConversionService.ts`
Expected: 无输出（该标识符已彻底移除）。

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无新增错误（该项目存在既有基线错误；对比改动前后数量应一致）。

- [ ] **Step 5: 跑全量测试并提交**

Run: `npm test`
Expected: 既有测试全部通过（DB 类按既有约定 skip）。

```bash
git add src/main/services/ConversionService.ts
git commit -m "fix(conversion): derive idle from JobQueue so a throwing job can't wedge the batch"
```

---

### Task 3: importAll 删除加保险（纯本地条目永不删）

`importAll` 以文件树为真相，把「索引里有、树里没有」的条目一律删除。但本地刚导入、尚未导出的条目也符合这个描述，于是被当成「远端已删除」误删。本任务加一道保险：**只删除确实被导出过的条目**——判据是「至少一个附件的路径位于内容根之内」，与 `exportItems` 现有的 `att.path.startsWith(repoRoot)` 判断一致。

不用 SQL `LIKE` 匹配路径前缀：Windows 路径里的 `_` 会被 `LIKE` 当成通配符，造成误判。改为取出路径在 JS 里 `startsWith`。

**Files:**
- Modify: `src/main/services/WorkspaceFiles.ts:331-334`
- Test: `src/main/services/WorkspaceFiles.test.ts`（在现有纯函数测试后追加一个 DB suite）

- [ ] **Step 1: 写失败测试**

在 `src/main/services/WorkspaceFiles.test.ts` **文件顶部**，把现有第 1-2 行的 import 替换为：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sanitizeTitle, uniqueDirName, importAll } from './WorkspaceFiles'

// better-sqlite3 is built for Electron's ABI here; under plain node these
// suites skip, matching the project's existing DB-test convention.
let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip
```

然后在文件**末尾**追加：

```typescript
suite('importAll deletion guard', () => {
  let db: Database.Database
  let root: string

  const SCHEMA = `
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, type TEXT,
      title TEXT, abstract TEXT, year INTEGER, doi TEXT, url TEXT, journal TEXT,
      publisher TEXT, volume TEXT, issue TEXT, pages TEXT, isbn TEXT, language TEXT,
      extra TEXT, deleted INTEGER DEFAULT 0, library_id INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, version INTEGER DEFAULT 0,
      added_by TEXT, conversion_failed INTEGER DEFAULT 0);
    CREATE TABLE creators (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT, orcid TEXT);
    CREATE TABLE item_creators (item_id INTEGER, creator_id INTEGER, role TEXT, position INTEGER,
      PRIMARY KEY (item_id, creator_id, role));
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
    CREATE TABLE item_tags (item_id INTEGER, tag_id INTEGER, PRIMARY KEY (item_id, tag_id));
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER,
      name TEXT, key TEXT UNIQUE, parent_id INTEGER);
    CREATE TABLE collection_items (collection_id INTEGER, item_id INTEGER,
      PRIMARY KEY (collection_id, item_id));
    CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, type TEXT,
      filename TEXT, path TEXT, url TEXT, mime_type TEXT, size INTEGER);
    CREATE TABLE tombstones (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT, key TEXT);
  `

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(SCHEMA)
    root = mkdtempSync(join(tmpdir(), 'veridian-wf-'))
    mkdirSync(join(root, 'papers'), { recursive: true })
  })
  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps a local-only item whose attachments live outside the content root', () => {
    db.prepare("INSERT INTO items (key, type, title) VALUES ('LOCAL1', 'journalArticle', 'Local paper')").run()
    // Its PDF still sits in the app's staging/attachment area, never exported.
    db.prepare("INSERT INTO attachments (item_id, type, filename, path) VALUES (1, 'pdf', 'a.pdf', ?)")
      .run(join(tmpdir(), 'veridian-elsewhere', 'a.pdf'))

    importAll(db, root)

    const rows = db.prepare("SELECT key FROM items").all() as Array<{ key: string }>
    expect(rows.map((r) => r.key)).toEqual(['LOCAL1'])
  })

  it('still deletes an item that was exported but is now gone from the tree', () => {
    db.prepare("INSERT INTO items (key, type, title) VALUES ('GONE1', 'journalArticle', 'Removed remotely')").run()
    // It HAS been exported before: its attachment path is inside the content root.
    db.prepare("INSERT INTO attachments (item_id, type, filename, path) VALUES (1, 'pdf', 'Full.pdf', ?)")
      .run(join(root, 'papers', 'Removed remotely', 'files', 'Full.pdf'))

    importAll(db, root)

    const count = db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('keeps an item that is present in the tree', () => {
    const dir = join(root, 'papers', 'Kept')
    mkdirSync(join(dir, 'files'), { recursive: true })
    writeFileSync(join(dir, 'item.json'), JSON.stringify({
      key: 'KEEP1', type: 'journalArticle', title: 'Kept', attachments: [], creators: [], tags: [], collections: [],
    }), 'utf-8')

    importAll(db, root)

    const rows = db.prepare("SELECT key FROM items").all() as Array<{ key: string }>
    expect(rows.map((r) => r.key)).toEqual(['KEEP1'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/WorkspaceFiles.test.ts`
Expected: 若本机 `dbUsable` 为真，第一个用例 FAIL（`LOCAL1` 被删，得到 `[]` 而非 `['LOCAL1']`）；若 ABI 不匹配则整个 suite 显示 skipped——此时改用 Step 4 的替代验证。

- [ ] **Step 3: 实现保险**

把 `src/main/services/WorkspaceFiles.ts` 中 `importAll` 的这段（原 331-334 行）：

```typescript
    // Anything in the db but not in the tree was deleted remotely
    const stale = (db.prepare('SELECT id, key FROM items').all() as Array<{ id: number; key: string }>)
      .filter((r) => !treeKeys.has(r.key))
    for (const r of stale) db.prepare('DELETE FROM items WHERE id = ?').run(r.id)
```

替换为：

```typescript
    // Anything in the db but not in the tree was deleted remotely -- but ONLY
    // if it ever made it into the tree to begin with. An item whose payloads
    // all still sit outside the content root (fresh import, conversion still
    // pending or failed, a crash before the export ran) has never been
    // exported, so its absence says nothing about a remote deletion. Deleting
    // those was how a batch import could lose everything but the few papers
    // that happened to convert before an error. Prefix-match in JS, not SQL
    // LIKE: '_' in a Windows path is a LIKE wildcard and would mis-match.
    const exported = new Set<number>()
    for (const a of db.prepare('SELECT item_id, path FROM attachments WHERE path IS NOT NULL')
      .all() as Array<{ item_id: number; path: string }>) {
      if (a.path.startsWith(repoRoot)) exported.add(a.item_id)
    }
    const stale = (db.prepare('SELECT id, key FROM items').all() as Array<{ id: number; key: string }>)
      .filter((r) => !treeKeys.has(r.key) && exported.has(r.id))
    for (const r of stale) db.prepare('DELETE FROM items WHERE id = ?').run(r.id)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/services/WorkspaceFiles.test.ts`
Expected: PASS（或 skipped）。

若该 suite 被 skip，用 Node 直接验证判定逻辑，确认前缀匹配对含 `_` 的路径正确：

Run:
```bash
node -e "const root='C:\\\\D\\\\my_lib'; const p='C:\\\\D\\\\myXlib\\\\a.pdf'; console.log('startsWith:', p.startsWith(root))"
```
Expected: `startsWith: false`（证明 `_` 未被当作通配符——这正是不用 SQL LIKE 的原因）。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/WorkspaceFiles.ts src/main/services/WorkspaceFiles.test.ts
git commit -m "fix(workspace): never delete never-exported local items on importAll"
```

---

### Task 4: 本地库导出失败条目（github 不变）

导出侧目前把 `conversion_failed = 1` 的条目排除在外，导致它们永远不进用户文件夹。本任务对**本地文件夹型工作空间**取消该排除；**github 工作空间保持原样**（用户决定协作策略稍后再定）。

**Files:**
- Modify: `src/main/services/WorkspaceFiles.ts:255-265`（`exportMissingItems` 加参数）
- Modify: `src/main/services/WorkspaceSyncService.ts:34-52`（`exportChanges` 加参数）、`:87`、`:148`（两个调用点）
- Modify: `src/main/services/WorkspaceContextService.ts:89`、`:120`（两个调用点）

- [ ] **Step 1: exportMissingItems 加 includeFailed 参数**

把 `src/main/services/WorkspaceFiles.ts` 的 `exportMissingItems`（原 255-265 行）：

```typescript
export function exportMissingItems(db: Database.Database, repoRoot: string): number {
  const keyToDir = scanKeyToDir(repoRoot)
  const rows = db.prepare('SELECT id, key FROM items WHERE conversion_failed = 0')
    .all() as Array<{ id: number; key: string }>
```

替换为：

```typescript
export function exportMissingItems(
  db: Database.Database, repoRoot: string, includeFailed: boolean
): number {
  const keyToDir = scanKeyToDir(repoRoot)
  // Local folder workspaces rescue everything, conversion failures included --
  // the user picked that folder as where their library lives, so a paper whose
  // markdown failed still belongs there (its PDF and metadata are fine, and it
  // gains Full.md whenever a retry succeeds). Github workspaces keep holding
  // failures back so collaborators never receive half-converted items.
  const rows = db.prepare(
    includeFailed ? 'SELECT id, key FROM items' : 'SELECT id, key FROM items WHERE conversion_failed = 0'
  ).all() as Array<{ id: number; key: string }>
```

同时把该函数上方 doc 注释里的 `Called on every activation BEFORE importAll` 一段保持不变（无需改动）。

- [ ] **Step 2: 更新 WorkspaceContextService 的两个调用点**

`src/main/services/WorkspaceContextService.ts` 第 89 行（github 分支）改为：

```typescript
    const recovered = exportMissingItems(db, repoRoot, false)
```

第 120 行（本地文件夹分支）改为：

```typescript
      const recovered = exportMissingItems(db, contentRoot, true)
```

- [ ] **Step 3: exportChanges 加 includeFailed 参数**

把 `src/main/services/WorkspaceSyncService.ts` 的 `exportChanges`（原 34-52 行）头部：

```typescript
function exportChanges(repoRoot: string): void {
  const db = getDb()
  const failed = new Set(
    (db.prepare('SELECT id FROM items WHERE conversion_failed = 1').all() as Array<{ id: number }>)
      .map((r) => r.id)
  )
  const rawIds = exportAllItems
    ? (db.prepare('SELECT id FROM items').all() as Array<{ id: number }>).map((r) => r.id)
    : [...dirtyItems]
  const ids = rawIds.filter((id) => !failed.has(id))
```

替换为：

```typescript
function exportChanges(repoRoot: string, includeFailed: boolean): void {
  const db = getDb()
  // Github workspaces hold conversion failures back so collaborators never see
  // half-converted items; local folder workspaces export them, because that
  // folder IS the user's library and withholding a paper from it (while
  // importAll treats "not in the tree" as deleted) is how a batch import used
  // to lose papers.
  const failed = includeFailed ? new Set<number>() : new Set(
    (db.prepare('SELECT id FROM items WHERE conversion_failed = 1').all() as Array<{ id: number }>)
      .map((r) => r.id)
  )
  const rawIds = exportAllItems
    ? (db.prepare('SELECT id FROM items').all() as Array<{ id: number }>).map((r) => r.id)
    : [...dirtyItems]
  const ids = rawIds.filter((id) => !failed.has(id))
```

- [ ] **Step 4: 更新 exportChanges 的两个调用点**

`src/main/services/WorkspaceSyncService.ts` 第 87 行（sync 任务内）改为：

```typescript
    exportChanges(activeCtx.repoRoot, activeCtx.kind !== 'github')
```

第 148 行（切库前的 flush hook 内）改为：

```typescript
    exportChanges(ctx.repoRoot, ctx.kind !== 'github')   // write files (github AND folder-backed local)
```

- [ ] **Step 5: 类型检查、测试、提交**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无新增错误（若有 `exportMissingItems`/`exportChanges` 参数数量报错，说明漏改了调用点）。

Run: `npm test`
Expected: 全部通过。

```bash
git add src/main/services/WorkspaceFiles.ts src/main/services/WorkspaceSyncService.ts src/main/services/WorkspaceContextService.ts
git commit -m "fix(workspace): export conversion-failed items in local folder workspaces"
```

---

### Task 5: conversion_failed 经 item.json 往返保留

失败条目现在会写进本地库的文件树，但 `item.json` 不带 `conversion_failed`，于是 `importAll` 回读后该状态丢失（红旗消失、条目看起来正常，实则没有 markdown）。本任务让它往返保留，缺省 `0` 向后兼容旧文件。

**Files:**
- Modify: `src/main/services/WorkspaceFiles.ts`（`ItemJson` 接口、`exportItems` 的 json 组装、`importItem` 的 fields 与 SQL）
- Test: `src/main/services/WorkspaceFiles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/main/services/WorkspaceFiles.test.ts` 的 `suite('importAll deletion guard', ...)` **内部**追加一个用例：

```typescript
  it('restores conversion_failed from item.json', () => {
    const dir = join(root, 'papers', 'Failed one')
    mkdirSync(join(dir, 'files'), { recursive: true })
    writeFileSync(join(dir, 'item.json'), JSON.stringify({
      key: 'FAIL1', type: 'journalArticle', title: 'Failed one', conversion_failed: 1,
      attachments: [], creators: [], tags: [], collections: [],
    }), 'utf-8')

    importAll(db, root)

    const row = db.prepare("SELECT conversion_failed AS f FROM items WHERE key = 'FAIL1'")
      .get() as { f: number }
    expect(row.f).toBe(1)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/WorkspaceFiles.test.ts`
Expected: FAIL — 得到 `0`（或该列未被写入），因为 `importItem` 尚未处理该字段。（ABI 不匹配时 skipped，则依赖 Step 4 的类型检查与 Step 5 的构建把关。）

- [ ] **Step 3: 实现往返**

在 `src/main/services/WorkspaceFiles.ts` 的 `ItemJson` 接口里，`deleted: number` 那行下面加：

```typescript
  conversion_failed: number
```

在 `exportItems` 组装 `json` 的对象里（`deleted: item.deleted,` 所在那行之后）加：

```typescript
      conversion_failed: item.conversion_failed ?? 0,
```

在 `importItem` 的 `fields` 对象里（`deleted: json.deleted ?? 0,` 那行之后）加：

```typescript
    conversion_failed: json.conversion_failed ?? 0,
```

把 `importItem` 的 UPDATE 语句里 `deleted=@deleted,` 改为：

```typescript
        deleted=@deleted, conversion_failed=@conversion_failed,
```

把 INSERT 的列清单里 `extra, deleted, library_id,` 改为：

```typescript
      INSERT INTO items (key, type, title, abstract, year, doi, url, journal, publisher,
        volume, issue, pages, isbn, language, extra, deleted, conversion_failed, library_id,
```

并把对应的 VALUES 里 `@extra, @deleted, 1,` 改为：

```typescript
        @volume, @issue, @pages, @isbn, @language, @extra, @deleted, @conversion_failed, 1,
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `npx vitest run src/main/services/WorkspaceFiles.test.ts`
Expected: PASS（或 skipped）。

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无新增错误。

- [ ] **Step 5: 全量验证并提交**

Run: `npm test`
Expected: 全部通过。

Run: `npm run build`
Expected: 构建成功（渲染层未改动，但按项目约定仍跑一次打包关卡）。

```bash
git add src/main/services/WorkspaceFiles.ts src/main/services/WorkspaceFiles.test.ts
git commit -m "feat(workspace): round-trip conversion_failed through item.json"
```

---

## 完成标准

- `npx tsc -p tsconfig.node.json --noEmit` 与 `npx tsc -p tsconfig.web.json --noEmit` 无新增错误。
- `npm test` 全绿（DB 类 suite 在 Electron ABI 下 skip 属预期）。
- `npm run build` 成功。
- Task 1 的三个 JobQueue 用例**真实跑过**（不依赖 DB），其中「抛错仍触发 onIdle」即 Bug C 的回归测试。

## 不在本次范围

闪退（OOM / 原生崩溃，需单独复现定位）、`userData/conversions` 暂存残渣清理、MinerU 重试与限流节流、github 协作库的失败条目策略。
