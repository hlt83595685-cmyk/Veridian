# 存储落地与暂存区生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让数据落在用户选定的位置，C 盘只保留数据库与配置；搬迁改为「移动」不留副本；临时区回归临时并可安全回收存量。

**Architecture:** 一个缺陷两处发作——「搬迁」被实现成「复制 + 改指向，从不删源」，于是 `userData/attachments`（560MB）与 `userData/conversions`（431MB）在本机堆出约 1GB **零引用**垃圾。另有暂存区兼作永久存储（无内容根的库）导致谁也不敢清理。方案：抽出统一的移动语义（同卷 rename / 跨卷回退，失败保留源）；暂存区跟随库的位置，使搬迁退化为同卷瞬时重命名；无内容根的库给产物一个永久落点；导出后即清该篇暂存；启动时做一次保守的引用扫描回收存量。

**Tech Stack:** TypeScript (strict, 无 `any`)、Electron 主进程、better-sqlite3、vitest。

**缩进约定（务必遵守）：** 本计划触及的所有文件（`src/main/services/*.ts`、`src/main/index.ts`）均使用 **2 空格缩进**。新建文件同样 2 空格。不要用 tab。

**验证约定：** 触库测试在本机 Electron ABI 下会被 `dbUsable` 守卫跳过（既有约定，不是失败）。**纯逻辑测试必须真实跑过。** 本机 Node 24 自带 `node:sqlite`，可用它对真实代码补执行验证（`bulk-import-robustness` 分支已验证此手法有效）——各任务标注了何时需要。

**绝对禁止：** 运行 `npm rebuild` / `electron-rebuild`（会破坏用户正在运行的 Electron app）。

---

### Task 1: 存储工具 — 移动语义与路径归属判定

两条被反复用到的基础能力，抽成独立模块，纯逻辑、可独立测试。

**Files:**
- Create: `src/main/services/storagePaths.ts`
- Test: `src/main/services/storagePaths.test.ts` (create)

- [ ] **Step 1: 写失败测试**

创建 `src/main/services/storagePaths.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The cross-volume path can't be provoked with real directories, so renameSync
// is stubbed to raise EXDEV on demand.
const h = vi.hoisted(() => ({ forceExdev: false }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (h.forceExdev) {
        const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        err.code = 'EXDEV'
        throw err
      }
      return actual.renameSync(from, to)
    },
  }
})

import { isInside, moveInto } from './storagePaths'

describe('isInside', () => {
  it('accepts the directory itself and its descendants', () => {
    expect(isInside(join('C:', 'lib'), join('C:', 'lib'))).toBe(true)
    expect(isInside(join('C:', 'lib', 'a.pdf'), join('C:', 'lib'))).toBe(true)
  })
  it('rejects a prefix-sharing sibling', () => {
    expect(isInside(join('C:', 'lib-backup', 'a.pdf'), join('C:', 'lib'))).toBe(false)
  })
  it('does not let staging dir 1 claim staging dir 10', () => {
    const root = join('C:', 'conv')
    expect(isInside(join(root, '10', 'full.md'), join(root, '1'))).toBe(false)
    expect(isInside(join(root, '1', 'full.md'), join(root, '1'))).toBe(true)
  })
  it('tolerates a trailing separator on the directory', () => {
    expect(isInside(join('C:', 'lib', 'a.pdf'), join('C:', 'lib') + require('path').sep)).toBe(true)
  })
})

describe('moveInto', () => {
  let root: string
  beforeEach(() => {
    h.forceExdev = false
    root = mkdtempSync(join(tmpdir(), 'veridian-move-'))
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('moves a file and removes the source', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'out', 'b.txt')
    writeFileSync(src, 'hello', 'utf-8')

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('hello')
  })

  it('moves a directory with nested contents', () => {
    const src = join(root, 'images')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'fig1.jpg'), 'x', 'utf-8')
    writeFileSync(join(src, 'sub', 'fig2.jpg'), 'y', 'utf-8')
    const dest = join(root, 'out', 'images')

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(join(dest, 'fig1.jpg'), 'utf-8')).toBe('x')
    expect(readFileSync(join(dest, 'sub', 'fig2.jpg'), 'utf-8')).toBe('y')
  })

  it('replaces whatever is already at the destination', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'b.txt')
    writeFileSync(src, 'new', 'utf-8')
    writeFileSync(dest, 'old', 'utf-8')

    expect(moveInto(src, dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('new')
  })

  it('falls back to copy+remove across volumes (EXDEV)', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'out', 'b.txt')
    writeFileSync(src, 'hello', 'utf-8')
    h.forceExdev = true

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('hello')
  })

  it('returns false and leaves the source when the move fails', () => {
    const src = join(root, 'missing.txt')   // never created
    expect(moveInto(src, join(root, 'out.txt'))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/storagePaths.test.ts`
Expected: FAIL — 模块 `./storagePaths` 不存在。

- [ ] **Step 3: 实现**

创建 `src/main/services/storagePaths.ts`：

```typescript
// Shared storage primitives. Relocation across the app is "move", never
// "copy and forget": the old copy-and-repoint behaviour left a full duplicate
// of every PDF and every conversion package behind on the system drive.
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, sep } from 'path'

/**
 * Is `p` the directory `dir` itself, or something inside it?
 *
 * Bounded at a path separator on purpose: a bare `startsWith` would let
 * `<root>/10` look like it lives in `<root>/1`, and `C:\lib-backup` look like
 * it lives in `C:\lib` -- both of which would mis-target a deletion.
 */
export function isInside(p: string, dir: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return p === dir || p === dir.replace(/[\\/]+$/, '') || p.startsWith(prefix)
}

/**
 * Move a file or directory onto `dest`, replacing anything already there.
 *
 * Same volume takes renameSync (atomic and instant -- which is why staging
 * lives next to its destination). Across volumes renameSync raises EXDEV, so
 * fall back to copy-then-remove.
 *
 * Returns false on failure, and on failure THE SOURCE IS LEFT INTACT: callers
 * treat that as "not relocated" and keep pointing at the source, so a failed
 * move can never destroy the only copy.
 */
export function moveInto(src: string, dest: string): boolean {
  try {
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    try {
      renameSync(src, dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true })
      else copyFileSync(src, dest)
      // The payload is safely at dest now; a source we fail to unlink is mere
      // leftover for the GC, not a reason to report failure.
      try { rmSync(src, { recursive: true, force: true }) } catch { /* GC reclaims it */ }
    }
    return true
  } catch (err) {
    console.warn(`[storage] move failed (${src} -> ${dest}):`, (err as Error).message)
    return false
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/services/storagePaths.test.ts`
Expected: PASS，9 tests passed。**这些测试不碰数据库，必须真实通过，不允许 skip。**

- [ ] **Step 5: 提交**

```bash
git add src/main/services/storagePaths.ts src/main/services/storagePaths.test.ts
git commit -m "feat(storage): move semantics + separator-bounded path containment"
```

---

### Task 2: 暂存区跟随库的位置（P2）

暂存目录不再写死 `userData`。位置由激活工作空间时决定，随 `ActiveWorkspace` 一起对外提供，`ConversionService` 只管读。

放置规则：
- **github** → `<工作空间基目录>/tmp`（与 `repo` 同级、**在 git 工作树之外**，因此无需处理 `.gitignore`，也不会被 `commitAll` 的 `statusMatrix` 看到）
- **folder-backed local** → `<内容根>/.veridian-tmp`（用户选定的文件夹内，同卷）
- **personal / 无内容根** → `null`，`ConversionService` 回退到 `userData/conversions`（这类库没有用户选定位置，`userData` 就是其存储根）

**Files:**
- Modify: `src/main/services/WorkspaceContextService.ts`（接口 + 三处 `active =` 赋值）
- Modify: `src/main/services/ConversionService.ts`（`stagingDir`）

- [ ] **Step 1: ActiveWorkspace 增加 stagingRoot**

`src/main/services/WorkspaceContextService.ts` 的接口（第 24-28 行）：

```typescript
export interface ActiveWorkspace {
  id: number | null            // null = personal library
  kind: 'personal' | 'local' | 'github'
  repoRoot: string | null      // content root: github clone, or a folder-backed local library
}
```

改为（顺手修正 `repoRoot` 那句已过时的注释——folder-backed local 同样会设置它）：

```typescript
export interface ActiveWorkspace {
  id: number | null            // null = personal library
  kind: 'personal' | 'local' | 'github'
  repoRoot: string | null      // content root: github clone, or a folder-backed local library
  // Where conversions do their scratch work. Kept on the same volume as the
  // content root so relocating finished output is an instant rename instead of
  // a cross-drive copy of hundreds of megabytes -- and so bulk data never
  // lands on the system drive for a library the user placed elsewhere.
  // null = no content root; ConversionService falls back to userData.
  stagingRoot: string | null
}
```

- [ ] **Step 2: 三处赋值补上 stagingRoot**

模块级默认值（第 30 行）：

```typescript
let active: ActiveWorkspace = { id: null, kind: 'personal', repoRoot: null, stagingRoot: null }
```

切回个人库（`if (id === null)` 分支内，第 66 行）：

```typescript
    active = { id: null, kind: 'personal', repoRoot: null, stagingRoot: null }
```

github 分支的 `active = { id, kind: 'github', repoRoot }` 改为（`base` 变量在该分支内已存在）：

```typescript
    active = { id, kind: 'github', repoRoot, stagingRoot: join(base, 'tmp') }
```

本地分支的 `active = { id, kind: 'local', repoRoot: contentRoot }` 改为：

```typescript
  active = {
    id, kind: 'local', repoRoot: contentRoot,
    stagingRoot: contentRoot ? join(contentRoot, '.veridian-tmp') : null,
  }
```

- [ ] **Step 3: ConversionService 使用它**

`src/main/services/ConversionService.ts` 顶部加入 import（与现有 import 同组，不要新起一行 import 'path'）：

```typescript
import { getActiveWorkspace } from './WorkspaceContextService'
```

把 `stagingDir` 函数体的第一行：

```typescript
  const dir = join(app.getPath('userData'), 'conversions', String(itemId))
```

改为：

```typescript
  const dir = join(stagingRootDir(), String(itemId))
```

并在 `stagingDir` 之前新增：

```typescript
/**
 * Root of the scratch area. Follows the active library's location so bulk data
 * stays off the system drive and the later relocation is a same-volume rename;
 * libraries with no content root of their own fall back to userData.
 */
export function stagingRootDir(): string {
  return getActiveWorkspace().stagingRoot ?? join(app.getPath('userData'), 'conversions')
}
```

- [ ] **Step 4: 验证**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无错误。若报 `ActiveWorkspace` 缺少 `stagingRoot`，说明漏了某处赋值——全局搜索 `kind: 'personal'`、`kind: 'local'`、`kind: 'github'` 补齐。

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/WorkspaceContextService.ts src/main/services/ConversionService.ts
git commit -m "feat(storage): staging root follows the active library's location"
```

---

### Task 3: 导出改为移动（P1）

`exportItems` 现在把附件 `copyFileSync`/`cpSync` 进内容根后更新路径，**源文件永久留在 `userData/attachments`**（本机 560MB 全部无引用）。改为移动。

**Files:**
- Modify: `src/main/services/WorkspaceFiles.ts`（`exportItems` 的搬迁循环）

- [ ] **Step 1: 引入工具**

在 `src/main/services/WorkspaceFiles.ts` 的 import 区加入：

```typescript
import { moveInto } from './storagePaths'
```

- [ ] **Step 2: 搬迁循环改为移动**

把 `exportItems` 中这段（把不在 repo 内的附件搬进 `files/` 的分支）：

```typescript
      try {
        if (att.type === 'imagedir') {
          // cpSync onto an existing dir MERGES old and new contents -- stale
          // images from the previous conversion would survive. Clean first.
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
          cpSync(att.path, dest, { recursive: true })
        } else {
          copyFileSync(att.path, dest)   // plain overwrite for files
        }
        if (isFirstPdf) pdfNamed = true
        db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?')
          .run(dest, basename(dest), att.id)
        att.path = dest
        att.filename = basename(dest)
      } catch (err) {
        console.warn(`[WorkspaceFiles] attachment relocation failed (${att.path}):`, err)
      }
```

替换为：

```typescript
      // MOVE, don't copy: the old copy-and-repoint left a full duplicate of
      // every PDF behind in userData forever (hundreds of MB per library, all
      // of it unreferenced). moveInto replaces the destination wholesale, so
      // an imagedir can't merge stale images from a previous conversion, and
      // it leaves the source intact when it fails -- in which case we do NOT
      // repoint, so the attachment keeps pointing at the copy that still exists.
      if (moveInto(att.path, dest)) {
        if (isFirstPdf) pdfNamed = true
        db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?')
          .run(dest, basename(dest), att.id)
        att.path = dest
        att.filename = basename(dest)
      } else {
        console.warn(`[WorkspaceFiles] attachment relocation failed, keeping source: ${att.path}`)
      }
```

- [ ] **Step 3: 清理因此不再使用的 import**

Run: `grep -n "copyFileSync\|cpSync" src/main/services/WorkspaceFiles.ts`

若 `copyFileSync` / `cpSync` 在该文件中已无其它使用处，从顶部 `from 'fs'` 的 import 列表里删掉它们（**只删本次改动造成的孤儿，不要动其它 import**）。若仍有使用则保留。

- [ ] **Step 4: 验证**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无错误（未使用的 import 会在此暴露）。

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/WorkspaceFiles.ts
git commit -m "fix(storage): relocate attachments by moving, not copying"
```

---

### Task 4: 导出后清理该篇暂存（P4）

**Files:**
- Modify: `src/main/services/ConversionService.ts`（新增 `clearStagingIfRelocated`）
- Modify: `src/main/services/WorkspaceSyncService.ts`（`exportChanges` 返回 id；两个调用点触发清理）

- [ ] **Step 1: ConversionService 新增守卫式清理**

在 `src/main/services/ConversionService.ts` 的 `stagingDir` 之后新增（并把 `isInside` 加进 import：`import { isInside } from './storagePaths'`）：

```typescript
/**
 * Drop an item's scratch directory once its payloads have been relocated.
 *
 * Guarded: if any attachment of this item still points inside the scratch
 * directory, the relocation didn't finish (moveInto keeps the source on
 * failure) and the scratch copy is still the live one -- so leave it alone.
 */
export function clearStagingIfRelocated(db: Database.Database, itemId: number): void {
  const dir = join(stagingRootDir(), String(itemId))
  if (!existsSync(dir)) return
  const rows = db.prepare('SELECT path FROM attachments WHERE item_id = ? AND path IS NOT NULL')
    .all(itemId) as Array<{ path: string }>
  if (rows.some((r) => isInside(r.path, dir))) return
  try { rmSync(dir, { recursive: true, force: true }) }
  catch (err) { console.warn(`[conversion] staging cleanup failed (${dir}):`, (err as Error).message) }
}
```

该文件顶部需要 `Database` 类型（若尚未引入）：

```typescript
import type Database from 'better-sqlite3'
```

- [ ] **Step 2: exportChanges 返回导出的 id**

`src/main/services/WorkspaceSyncService.ts` 的 `exportChanges` 签名与结尾：

```typescript
function exportChanges(repoRoot: string, includeFailed: boolean): void {
```

改为：

```typescript
function exportChanges(repoRoot: string, includeFailed: boolean): number[] {
```

并把函数体最后三行：

```typescript
  if (doCollections) exportCollections(db, repoRoot)
  if (ids.length > 0) exportItems(db, repoRoot, ids)
  reconcileDeletions(db, repoRoot)
}
```

改为：

```typescript
  if (doCollections) exportCollections(db, repoRoot)
  if (ids.length > 0) exportItems(db, repoRoot, ids)
  reconcileDeletions(db, repoRoot)
  return ids
}
```

- [ ] **Step 3: 两个调用点在导出后清理**

顶部 import 加入 `clearStagingIfRelocated`（该文件已从 `./ConversionService` 引入 `hasPendingConversions, setOnConversionsIdle`，追加到同一行）：

```typescript
import { hasPendingConversions, setOnConversionsIdle, clearStagingIfRelocated } from './ConversionService'
```

sync 任务内：

```typescript
    exportChanges(activeCtx.repoRoot, activeCtx.kind !== 'github')
```

改为：

```typescript
    const exported = exportChanges(activeCtx.repoRoot, activeCtx.kind !== 'github')
    for (const id of exported) clearStagingIfRelocated(getDb(), id)
```

flush hook 内：

```typescript
    exportChanges(ctx.repoRoot, ctx.kind !== 'github')   // write files (github AND folder-backed local)
```

改为：

```typescript
    const exported = exportChanges(ctx.repoRoot, ctx.kind !== 'github')   // write files (github AND folder-backed local)
    for (const id of exported) clearStagingIfRelocated(getDb(), id)
```

- [ ] **Step 4: 验证**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无错误。

Run: `npm test`
Expected: 全部通过。

用 `node:sqlite` 对真实的 `clearStagingIfRelocated` 补一次执行验证（临时文件，**验证完必须删除并确认工作树干净**）：建一个内存库，`attachments` 表插入一条指向暂存目录内的路径 → 调用后目录**仍在**；把该路径改到暂存目录之外 → 调用后目录**已删**；再验证 `<root>/10` 内的附件不会阻止 `<root>/1` 被清理。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/ConversionService.ts src/main/services/WorkspaceSyncService.ts
git commit -m "feat(conversion): clear an item's staging dir once it is relocated"
```

---

### Task 5: 无内容根的库 — 产物落入永久区（P3）

**Files:**
- Modify: `src/main/services/ConversionService.ts`（转换成功收尾）
- Create: `src/main/services/StorageGC.ts`（本任务只放迁移函数；Task 6 再补 GC）
- Modify: `src/main/index.ts`（启动时调用迁移）

- [ ] **Step 1: 转换收尾时落永久区**

在 `src/main/services/ConversionService.ts` 新增（放在 `clearStagingIfRelocated` 之后）：

```typescript
/** Permanent home for conversion output of libraries that have no content
 *  root of their own. A directory per item, because the markdown references
 *  its figures as `images/figN.jpg` -- md and images must stay siblings. */
export function convertedDir(itemId: number): string {
  return join(app.getPath('userData'), 'converted', String(itemId))
}
```

在转换处理器成功收尾处，把这两行：

```typescript
      grantAccess(mdPath)
      registerAttachment(itemId, mdPath)
```

替换为：

```typescript
      // A library with no content root never runs an export, so the scratch
      // area would become these files' permanent home -- and the scratch area
      // gets wiped wholesale by the next conversion. Give them a real home now.
      let finalMd = mdPath
      let finalImages = imagesDir
      if (getActiveWorkspace().repoRoot == null) {
        const home = convertedDir(itemId)
        rmSync(home, { recursive: true, force: true })   // re-conversion overwrites
        if (moveInto(mdPath, join(home, 'Full.md'))) finalMd = join(home, 'Full.md')
        if (finalImages && moveInto(finalImages, join(home, 'images'))) {
          finalImages = join(home, 'images')
        }
      }
      grantAccess(finalMd)
      registerAttachment(itemId, finalMd)
```

为此需要把 imagesDir 提升到该作用域。把精准模式分支中的：

```typescript
        mdPath = result.mdPath
        if (result.imagesDir) {
          normalizeImages(mdPath, result.imagesDir)   // figN names, in staging
          grantAccess(result.imagesDir)
          registerAttachmentDir(itemId, result.imagesDir, basename(result.imagesDir))
        }
```

改为（登记推迟到搬家之后，避免登记出旧路径）：

```typescript
        mdPath = result.mdPath
        if (result.imagesDir) {
          normalizeImages(mdPath, result.imagesDir)   // figN names, in staging
          imagesDir = result.imagesDir
        }
```

并在 `let mdPath: string` 旁声明：

```typescript
      let imagesDir: string | null = null
```

在上面新增的 `grantAccess(finalMd)` / `registerAttachment(itemId, finalMd)` **之后**补上图片目录的登记：

```typescript
      if (finalImages) {
        grantAccess(finalImages)
        registerAttachmentDir(itemId, finalImages, basename(finalImages))
      }
```

最后，无内容根的库在此已完成落地，顺手清空该篇暂存：

```typescript
      if (getActiveWorkspace().repoRoot == null) {
        try { rmSync(join(stagingRootDir(), String(itemId)), { recursive: true, force: true }) }
        catch { /* leftover; the GC reclaims it */ }
      }
```

需要的 import：`moveInto` 与 `getActiveWorkspace`（Task 2 已引入后者），以及 `rmSync`（该文件已从 `fs` 引入）。

- [ ] **Step 2: 启动迁移既有数据**

创建 `src/main/services/StorageGC.ts`：

```typescript
// One-off maintenance that runs at startup, before any conversion is queued.
import { existsSync } from 'fs'
import { getDb } from '../db'
import { getActiveWorkspace } from './WorkspaceContextService'
import { convertedDir, stagingRootDir } from './ConversionService'
import { isInside, moveInto } from './storagePaths'
import { basename, join } from 'path'

/**
 * Libraries with no content root used to keep conversion output in the scratch
 * area permanently. Move those payloads into their real home so the scratch
 * area can be treated as scratch (and so the next conversion of an item with
 * the same id can't wipe them).
 */
export function migrateStagedPayloads(): number {
  if (getActiveWorkspace().repoRoot != null) return 0
  const db = getDb()
  const staging = stagingRootDir()
  const rows = db.prepare('SELECT id, item_id, path FROM attachments WHERE path IS NOT NULL')
    .all() as Array<{ id: number; item_id: number; path: string }>
  let moved = 0
  for (const r of rows) {
    if (!isInside(r.path, staging) || !existsSync(r.path)) continue
    const name = basename(r.path) === 'images' ? 'images' : (r.path.endsWith('.md') ? 'Full.md' : basename(r.path))
    const dest = join(convertedDir(r.item_id), name)
    if (!moveInto(r.path, dest)) continue
    db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?').run(dest, name, r.id)
    moved++
  }
  return moved
}
```

- [ ] **Step 3: 启动时调用**

`src/main/index.ts` 中，在 `initConversionService()` / `initWorkspaceSyncService()` / `initKnowledgeIndexer()` 这三行**之后**加入：

```typescript
  try {
    const moved = migrateStagedPayloads()
    if (moved > 0) console.log(`[startup] moved ${moved} staged payload(s) into permanent storage`)
  } catch (err) {
    console.warn('[startup] staged-payload migration failed:', (err as Error).message)
  }
```

并在顶部 import 区加入：

```typescript
import { migrateStagedPayloads } from './services/StorageGC'
```

- [ ] **Step 4: 验证**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: 无错误。

Run: `npm test`
Expected: 全部通过。

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/ConversionService.ts src/main/services/StorageGC.ts src/main/index.ts
git commit -m "feat(storage): permanent home for conversion output of rootless libraries"
```

---

### Task 6: 启动引用扫描回收存量（P5）

以**所有**工作空间的数据库为根集，保守回收 `conversions/` 与 `attachments/` 中的垃圾。

**Files:**
- Modify: `src/main/services/StorageGC.ts`
- Modify: `src/main/index.ts`（启动时调用）
- Test: `src/main/services/StorageGC.test.ts` (create)

- [ ] **Step 1: 写失败测试（纯逻辑部分）**

创建 `src/main/services/StorageGC.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { classifyStagingFile } from './StorageGC'

describe('classifyStagingFile', () => {
  it('marks MinerU intermediates as debris', () => {
    expect(classifyStagingFile('abc_origin.pdf')).toBe('debris')
    expect(classifyStagingFile('layout.json')).toBe('debris')
    expect(classifyStagingFile('abc_model.json')).toBe('debris')
    expect(classifyStagingFile('abc_content_list.json')).toBe('debris')
    expect(classifyStagingFile('abc_content_list_v2.json')).toBe('debris')
  })
  it('marks the conversion product as worth keeping', () => {
    expect(classifyStagingFile('full.md')).toBe('product')
    expect(classifyStagingFile('Full.md')).toBe('product')
    expect(classifyStagingFile('images')).toBe('product')
  })
  it('keeps anything it does not recognise', () => {
    expect(classifyStagingFile('mystery.dat')).toBe('product')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/StorageGC.test.ts`
Expected: FAIL — `classifyStagingFile` 未导出。

- [ ] **Step 3: 实现**

在 `src/main/services/StorageGC.ts` 追加（顶部 import 补 `readdirSync, rmSync, statSync`、`app` from 'electron'、`createHash` from 'crypto'、`readFileSync` from 'fs'、`Database` from 'better-sqlite3'、`getPersonalDb` from '../db'）：

```typescript
/**
 * MinerU leaves a full working set behind: a copy of the source PDF, page
 * layout coordinates, raw model output and content listings. Measured at 82%
 * of the scratch area on a real library, and nothing user-facing can be
 * recovered from any of it. Everything else -- notably `full.md` and
 * `images/` -- is the actual conversion product and is kept even when nothing
 * references it, because an unreferenced product is the sole remaining copy
 * of a deleted item's work and the only possible input for a future recovery
 * feature. Unknown names default to `product`: keep what we don't understand.
 */
export function classifyStagingFile(name: string): 'debris' | 'product' {
  const n = name.toLowerCase()
  if (n.endsWith('_origin.pdf')) return 'debris'
  if (n === 'layout.json') return 'debris'
  if (n.endsWith('_model.json')) return 'debris'
  if (n.includes('content_list')) return 'debris'
  return 'product'
}

/** Compare paths case- and form-insensitively (Windows). */
function norm(p: string): string {
  return resolve(p).toLowerCase()
}

/** Every attachment path, plus md5 -> the paths that carry it, across the
 *  personal library and every registered workspace index. Returns null if any
 *  database can't be read -- callers must then do nothing at all. */
function collectRoots(): { paths: Set<string>; byMd5: Map<string, string[]> } | null {
  const paths = new Set<string>()
  const byMd5 = new Map<string, string[]>()
  const add = (db: Database.Database): void => {
    for (const r of db.prepare('SELECT path, md5 FROM attachments').all() as Array<{ path: string | null; md5: string | null }>) {
      if (r.path) paths.add(norm(r.path))
      if (r.md5 && r.path) {
        const list = byMd5.get(r.md5) ?? []
        list.push(r.path)
        byMd5.set(r.md5, list)
      }
    }
  }
  try {
    const personal = getPersonalDb()
    add(personal)
    const ids = personal.prepare('SELECT id, local_path FROM workspaces').all() as Array<{ id: number; local_path: string | null }>
    for (const w of ids) {
      const base = w.local_path && w.local_path.trim()
        ? w.local_path
        : join(app.getPath('userData'), 'workspaces', String(w.id))
      const idx = join(base, 'index.db')
      if (!existsSync(idx)) continue
      const wdb = new DatabaseCtor(idx, { readonly: true })
      try { add(wdb) } finally { wdb.close() }
    }
  } catch (err) {
    console.warn('[GC] skipping sweep, a database could not be read:', (err as Error).message)
    return null
  }
  return { paths, md5s }
}

/**
 * Reclaim the bulk data the old copy-and-repoint relocation left behind.
 * Runs once at startup, before any conversion is queued, so nothing in flight
 * can be caught mid-write. Conservative by construction: proves redundancy
 * before deleting, and bails out entirely if any database is unreadable.
 */
export function sweepStorage(): { freedBytes: number; files: number } {
  const roots = collectRoots()
  if (!roots) return { freedBytes: 0, files: 0 }
  let freedBytes = 0
  let files = 0

  const del = (p: string): void => {
    try {
      const st = statSync(p)
      const size = st.isDirectory() ? 0 : st.size
      rmSync(p, { recursive: true, force: true })
      freedBytes += size
      files++
    } catch { /* already gone */ }
  }

  // conversions/: in an unreferenced item dir, drop the intermediates and keep
  // the product.
  const convRoot = join(app.getPath('userData'), 'conversions')
  if (existsSync(convRoot)) {
    for (const itemDir of readdirSync(convRoot)) {
      const dir = join(convRoot, itemDir)
      let referenced = false
      const walk = (d: string): string[] => {
        const out: string[] = []
        for (const e of readdirSync(d)) {
          const p = join(d, e)
          if (statSync(p).isDirectory()) out.push(p, ...walk(p))
          else out.push(p)
        }
        return out
      }
      let entries: string[] = []
      try { entries = walk(dir) } catch { continue }
      for (const p of entries) {
        if (roots.paths.has(norm(p))) { referenced = true; break }
      }
      if (referenced) continue          // still live -- leave the whole dir alone
      for (const p of entries) {
        if (classifyStagingFile(basename(p)) === 'debris') del(p)
      }
    }
  }

  // attachments/: delete only files we can PROVE are redundant -- the same
  // bytes must still exist at a DIFFERENT path that a database references.
  //
  // "md5 appears in the referenced set" is NOT sufficient: a referenced file's
  // own md5 is in that set, so any hiccup in path comparison would make a live
  // file look like a duplicate of itself and delete it. Requiring a different,
  // existing path makes the survival of the content an observed fact.
  const attRoot = join(app.getPath('userData'), 'attachments')
  if (existsSync(attRoot)) {
    for (const name of readdirSync(attRoot)) {
      const p = join(attRoot, name)
      try { if (statSync(p).isDirectory()) continue } catch { continue }
      if (roots.paths.has(norm(p))) continue
      let hash: string
      try { hash = createHash('md5').update(readFileSync(p)).digest('hex') }
      catch { continue }
      const survivors = (roots.byMd5.get(hash) ?? [])
        .filter((q) => norm(q) !== norm(p) && existsSync(q))
      if (survivors.length > 0) del(p)
    }
  }

  return { freedBytes, files }
}
```

注意 import 中 better-sqlite3 需要值导入以便打开只读库，与既有类型导入区分；`resolve` 来自 `path`：

```typescript
import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { basename, join, resolve } from 'path'
```

- [ ] **Step 4: 启动时调用**

`src/main/index.ts` 中紧接 Task 5 加入的迁移调用之后：

```typescript
  try {
    const { freedBytes, files } = sweepStorage()
    if (files > 0) console.log(`[startup] reclaimed ${files} file(s), ${Math.round(freedBytes / 1024 / 1024)}MB`)
  } catch (err) {
    console.warn('[startup] storage sweep failed:', (err as Error).message)
  }
```

并把 import 改为：

```typescript
import { migrateStagedPayloads, sweepStorage } from './services/StorageGC'
```

- [ ] **Step 5: 验证并提交**

Run: `npx vitest run src/main/services/StorageGC.test.ts`
Expected: PASS，3 tests passed（纯逻辑，必须真实通过）。

Run: `npm run typecheck`
Expected: 无错误。

Run: `npm test`
Expected: 全部通过。

Run: `npm run build`
Expected: 构建成功。

用 `node:sqlite` 对 `sweepStorage` 的判定规则补一次执行验证（临时文件，**验证完必须删除并确认工作树干净**）：造一个假的 `conversions/<id>/` 含中间产物与 `full.md` → 无引用时中间产物被删而 `full.md` 保留；把 `full.md` 加入某个库的 attachments 引用 → 整个目录原封不动。

```bash
git add src/main/services/StorageGC.ts src/main/services/StorageGC.test.ts src/main/index.ts
git commit -m "feat(storage): startup reference sweep reclaims leftover bulk data"
```

---

## 完成标准

- `npm run typecheck`（web + node）无新增错误。
- `npm test` 全绿；**Task 1 与 Task 6 的纯逻辑测试必须真实跑过，不得是 skip**。
- `npm run build` 成功。
- Task 4、Task 6 各自的 `node:sqlite` 执行验证做过，且临时文件已删除、工作树干净。

## 不在本次范围

可配置存储根（个人库/纯数据库型库指定存放位置）、孤儿数据恢复、MinerU 残渣源头缩减、`attachments` 中 PDF 的跨条目去重。
