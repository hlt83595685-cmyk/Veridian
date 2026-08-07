# Local Folder Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `local` workspace folder-backed — import an on-disk `papers/` library folder on activation and write in-app edits back to it, with no git.

**Architecture:** Reuse the `WorkspaceFiles` repo-layout translator (`importAll` / `exportItems` / `exportCollections` / `reconcileDeletions` / `exportMissingItems`) for a `local` workspace whose `local_path` names a content-root folder. The index.db stays an app-managed cache under `userData/workspaces/<id>/`; the folder is the source of truth. Every git step (`ensureClone`/`commitAll`/`sync`) is skipped for `local`. GitHub behavior is preserved, just re-expressed.

**Tech Stack:** Electron main process, better-sqlite3, TypeScript, vitest.

**Design:** `docs/superpowers/specs/2026-08-08-local-folder-library-design.md`

**Note on testing:** Main-process code that touches Electron + native better-sqlite3 cannot be unit-tested here (the repo's `db/items.test.ts` is skipped for this reason). Only the pure path helper gets a unit test (Task 1). Tasks 2–4 are verified by `npm run typecheck` + `npm run build` and the end-to-end manual check in Task 5.

---

### Task 1: `normalizeContentRoot` pure helper

Decides the content root from the folder the user picked: a path ending in a `papers` segment resolves to its parent; anything else is used as-is. Case-insensitive (Windows folder names).

**Files:**
- Create: `src/main/services/contentRoot.ts`
- Test: `src/main/services/contentRoot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/services/contentRoot.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { normalizeContentRoot } from './contentRoot'

describe('normalizeContentRoot', () => {
  it('strips a trailing "papers" segment to its parent', () => {
    const root = join('C:', 'D', 'Veridian', 'Data', 'repo')
    expect(normalizeContentRoot(join(root, 'papers'))).toBe(root)
  })

  it('is case-insensitive on the papers segment', () => {
    const root = join('C:', 'lib')
    expect(normalizeContentRoot(join(root, 'Papers'))).toBe(root)
  })

  it('tolerates a trailing separator', () => {
    const root = join('C:', 'lib')
    expect(normalizeContentRoot(join(root, 'papers') + '\\')).toBe(root)
  })

  it('keeps a non-papers folder as-is', () => {
    const p = join('C:', 'D', 'Veridian', 'Data', 'repo')
    expect(normalizeContentRoot(p)).toBe(p)
  })

  it('normalizes redundant separators but preserves the folder', () => {
    const p = join('C:', 'lib', 'mine')
    expect(normalizeContentRoot(p)).toBe(p)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- contentRoot`
Expected: FAIL — `Cannot find module './contentRoot'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/services/contentRoot.ts`:

```ts
import { basename, dirname, normalize } from 'path'

// The user picks the folder that IS (or contains) their `papers/` library.
// If they pick the `papers` folder itself, the content root is its parent
// (importAll/exportItems operate on the root that CONTAINS papers/ +
// collections.json). Any other folder is treated as the root directly.
// Case-insensitive: Windows folder names are.
export function normalizeContentRoot(pickedPath: string): string {
  const p = normalize(pickedPath.trim())
  return basename(p).toLowerCase() === 'papers' ? dirname(p) : p
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- contentRoot`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/contentRoot.ts src/main/services/contentRoot.test.ts
git commit -m "feat: normalizeContentRoot helper for folder-backed local workspaces"
```

---

### Task 2: Folder-backed activation in WorkspaceContextService

Rewrite the `local` branch of `setActiveWorkspace` so a `local` workspace with a `local_path` imports from that folder (index.db in an app-managed cache dir), and a `local` workspace without one stays a plain DB-only library. GitHub branch unchanged, only re-indented to own its `base`.

**Files:**
- Modify: `src/main/services/WorkspaceContextService.ts`

- [ ] **Step 1: Add the import**

At the top of `src/main/services/WorkspaceContextService.ts`, below the existing `import { getStatus } from './GitHubService'` line, add:

```ts
import { normalizeContentRoot } from './contentRoot'
```

- [ ] **Step 2: Rewrite the base computation + branch**

Replace this block (currently after `const ws = getWorkspace(id)` / `if (!ws) throw ...`):

```ts
  const base = workspaceBaseDir(id, ws.local_path)
  grantAccess(base)

  if (ws.kind === 'github') {
    const repoRoot = join(base, 'repo')
    await ensureClone(repoRoot, ws.repo_owner!, ws.repo_name!)
    grantAccess(repoRoot)
    openWorkspaceDb(join(base, 'index.db'))
    const db = getDb()

    // Self-healing activation, in this exact order:
    // 1. Rescue stranded local items (index rows without a tree entry --
    //    e.g. a crash before the sync debounce fired) into the tree and
    //    commit, so step 3's tree-as-truth import can't discard them.
    const recovered = exportMissingItems(db, repoRoot)
    if (recovered > 0) {
      console.log(`[WorkspaceContext] recovered ${recovered} stranded local item(s)`)
      await commitAll(repoRoot, 'veridian: recover local changes')
    }
    // 2. Pull remote changes (best-effort -- offline activation still works
    //    with the last-known tree; ensureClone alone never pulls an
    //    already-existing clone, which previously left remote data invisible)
    try { await sync(repoRoot) }
    catch (err) { console.warn('[WorkspaceContext] initial sync failed (offline?):', (err as Error).message) }
    // 3. Rebuild the index from the (now up-to-date) tree
    importAll(db, repoRoot)

    active = { id, kind: 'github', repoRoot }
  }
  else {
    // Local/private workspace: its own isolated database, no git involved
    openWorkspaceDb(join(base, 'index.db'))
    active = { id, kind: 'local', repoRoot: null }
  }
```

with:

```ts
  if (ws.kind === 'github') {
    const base = workspaceBaseDir(id, ws.local_path)
    grantAccess(base)
    const repoRoot = join(base, 'repo')
    await ensureClone(repoRoot, ws.repo_owner!, ws.repo_name!)
    grantAccess(repoRoot)
    openWorkspaceDb(join(base, 'index.db'))
    const db = getDb()

    // Self-healing activation, in this exact order:
    // 1. Rescue stranded local items (index rows without a tree entry --
    //    e.g. a crash before the sync debounce fired) into the tree and
    //    commit, so step 3's tree-as-truth import can't discard them.
    const recovered = exportMissingItems(db, repoRoot)
    if (recovered > 0) {
      console.log(`[WorkspaceContext] recovered ${recovered} stranded local item(s)`)
      await commitAll(repoRoot, 'veridian: recover local changes')
    }
    // 2. Pull remote changes (best-effort -- offline activation still works
    //    with the last-known tree; ensureClone alone never pulls an
    //    already-existing clone, which previously left remote data invisible)
    try { await sync(repoRoot) }
    catch (err) { console.warn('[WorkspaceContext] initial sync failed (offline?):', (err as Error).message) }
    // 3. Rebuild the index from the (now up-to-date) tree
    importAll(db, repoRoot)

    active = { id, kind: 'github', repoRoot }
  }
  else {
    // Local workspace. Folder-backed when local_path names a content root:
    // import from and write back to that folder, no git. The index.db is an
    // app-managed CACHE (userData/workspaces/<id>), never written inside the
    // user's folder -- so local_path here means "the content root", not "where
    // the db lives". No content root => a plain DB-only private library.
    const base = workspaceBaseDir(id, null)
    grantAccess(base)
    openWorkspaceDb(join(base, 'index.db'))

    const contentRoot = ws.local_path ? normalizeContentRoot(ws.local_path) : null
    if (contentRoot) {
      grantAccess(contentRoot)
      const db = getDb()
      // Rescue changes stranded in the cached index.db by a crash before the
      // last write-back, then rebuild from the folder (tree = source of truth).
      const recovered = exportMissingItems(db, contentRoot)
      if (recovered > 0) {
        console.log(`[WorkspaceContext] recovered ${recovered} stranded local item(s)`)
      }
      importAll(db, contentRoot)
    }
    active = { id, kind: 'local', repoRoot: contentRoot }
  }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/main/services/WorkspaceContextService.ts
git commit -m "feat: folder-backed local workspace activation (import from papers/, no git)"
```

---

### Task 3: Files-only write-back in WorkspaceSyncService

Let a `local` workspace with a `repoRoot` (folder-backed) write edits back to its folder, reusing the export path but skipping all git. Gate on `repoRoot` presence rather than `kind === 'github'`, and split export from commit.

**Files:**
- Modify: `src/main/services/WorkspaceSyncService.ts`

- [ ] **Step 1: Split `exportAndCommit` into `exportChanges`**

Replace:

```ts
/** Export pending changes to the working tree and commit. Returns commit made. */
async function exportAndCommit(repoRoot: string): Promise<boolean> {
  const db = getDb()
  const failed = new Set(
    (db.prepare('SELECT id FROM items WHERE conversion_failed = 1').all() as Array<{ id: number }>)
      .map((r) => r.id)
  )
  const rawIds = exportAllItems
    ? (db.prepare('SELECT id FROM items').all() as Array<{ id: number }>).map((r) => r.id)
    : [...dirtyItems]
  const ids = rawIds.filter((id) => !failed.has(id))
  dirtyItems = new Set()
  const doCollections = collectionsDirty || exportAllItems
  collectionsDirty = false
  exportAllItems = false

  if (doCollections) exportCollections(db, repoRoot)
  if (ids.length > 0) exportItems(db, repoRoot, ids)
  reconcileDeletions(db, repoRoot)

  return commitAll(repoRoot, `veridian: update ${new Date().toISOString()}`)
}
```

with:

```ts
/** Write pending changes to the working tree (no git). */
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
  dirtyItems = new Set()
  const doCollections = collectionsDirty || exportAllItems
  collectionsDirty = false
  exportAllItems = false

  if (doCollections) exportCollections(db, repoRoot)
  if (ids.length > 0) exportItems(db, repoRoot, ids)
  reconcileDeletions(db, repoRoot)
}
```

- [ ] **Step 2: Gate `scheduleSync` on repoRoot instead of github**

In `scheduleSync`, replace:

```ts
    const ctx = getActiveWorkspace()
    if (ctx.kind !== 'github' || !ctx.repoRoot || jobQueued) return
```

with:

```ts
    const ctx = getActiveWorkspace()
    // Any workspace with a file tree (github OR folder-backed local) writes
    // back; personal / DB-only local have no repoRoot and never enqueue.
    if (!ctx.repoRoot || jobQueued) return
```

- [ ] **Step 3: Branch the sync job on kind**

In the `registerJobType<SyncPayload>('workspace.sync', ...)` handler, replace:

```ts
    ctx.progress('导出更改...')
    console.log('[WorkspaceSync] export start')
    await exportAndCommit(activeCtx.repoRoot)
    console.log('[WorkspaceSync] export+commit done')

    ctx.progress('与 GitHub 同步中...')
    const { pulled } = await sync(activeCtx.repoRoot)
    console.log('[WorkspaceSync] network sync done')

    if (pulled) {
      ctx.progress('导入远端更改...')
      importAll(getDb(), activeCtx.repoRoot)
      emit({ type: 'workspace.dataRefreshed' })
    }
```

with:

```ts
    ctx.progress('导出更改...')
    console.log('[WorkspaceSync] export start')
    exportChanges(activeCtx.repoRoot)
    console.log('[WorkspaceSync] export done')

    // Folder-backed local stops here -- files written, no git. Only github
    // commits and talks to the network.
    if (activeCtx.kind === 'github') {
      await commitAll(activeCtx.repoRoot, `veridian: update ${new Date().toISOString()}`)
      ctx.progress('与 GitHub 同步中...')
      const { pulled } = await sync(activeCtx.repoRoot)
      console.log('[WorkspaceSync] network sync done')

      if (pulled) {
        ctx.progress('导入远端更改...')
        importAll(getDb(), activeCtx.repoRoot)
        emit({ type: 'workspace.dataRefreshed' })
      }
    }
```

- [ ] **Step 4: Fire the event subscription for folder-backed local**

Replace:

```ts
  subscribe((e) => {
    if (getActiveWorkspace().kind !== 'github') return
```

with:

```ts
  subscribe((e) => {
    // Fire for any workspace with a file tree (github or folder-backed local).
    if (!getActiveWorkspace().repoRoot) return
```

- [ ] **Step 5: Update the flush hook**

Replace:

```ts
  setFlushHook(async () => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    const ctx = getActiveWorkspace()
    if (ctx.kind !== 'github' || !ctx.repoRoot) return
    const committed = await exportAndCommit(ctx.repoRoot)
    if (committed) {
      try { await sync(ctx.repoRoot) }
      catch (err) { console.warn('[WorkspaceSync] push on switch failed (will retry next activation):', err) }
    }
  })
```

with:

```ts
  setFlushHook(async () => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    const ctx = getActiveWorkspace()
    if (!ctx.repoRoot) return
    exportChanges(ctx.repoRoot)   // write files (github AND folder-backed local)
    if (ctx.kind === 'github') {
      try {
        await commitAll(ctx.repoRoot, `veridian: update ${new Date().toISOString()}`)
        await sync(ctx.repoRoot)
      } catch (err) {
        console.warn('[WorkspaceSync] push on switch failed (will retry next activation):', err)
      }
    }
  })
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (If it reports `commitAll` unused, it is still used in Step 3/Step 5 — both reference it; no change needed.)

- [ ] **Step 7: Commit**

```bash
git add src/main/services/WorkspaceSyncService.ts
git commit -m "feat: write-back for folder-backed local workspaces (files only, no git)"
```

---

### Task 4: Create-dialog hint for the local folder

The create flow already calls `tools.pickDir()` and passes the result as `localPath` for a `local` workspace, so folder-backed creation works with no functional change. Add a one-line hint so the user knows the picked folder is imported as their library.

**Files:**
- Modify: `src/renderer/src/i18n/index.ts`
- Modify: `src/renderer/src/components/workspace/WorkspaceDialog.tsx`

- [ ] **Step 1: Add the i18n hint (zh + en)**

In `src/renderer/src/i18n/index.ts`, in the **zh** `workspace.create` object (which contains `kindLocal`, `kindGithub`, `repoUrlPlaceholder`, `submit`), add:

```ts
      localFolderHint: '「本地」会让你选一个文件夹作为文献库：选含 papers/ 的文件夹即导入现有文献；留空则新建空库。不涉及 git。',
```

In the **en** `workspace.create` object add:

```ts
      localFolderHint: '"Local" lets you pick a folder as the library: choose one containing papers/ to import existing items, or leave it empty for a new library. No git involved.',
```

- [ ] **Step 2: Show the hint when the local kind is selected**

In `src/renderer/src/components/workspace/WorkspaceDialog.tsx`, inside `CreateSection`, immediately after the `</select>` that closes the kind dropdown (the `<select value={kind} ...>` element), add:

```tsx
      {kind === 'local' && (
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          {t('workspace.create.localFolderHint')}
        </div>
      )}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n/index.ts src/renderer/src/components/workspace/WorkspaceDialog.tsx
git commit -m "feat: hint that a local workspace picks a folder library"
```

---

### Task 5: End-to-end verification + release prep

**Files:** none (verification only), then version bump if shipping.

- [ ] **Step 1: Full check**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests pass (contentRoot suite included), build succeeds.

- [ ] **Step 2: Manual verification in the running app**

1. Start the app (`npm run dev`, or the installed build).
2. Workspace switcher → 管理 → 新建：name it, kind = 本地, submit; in the OS folder picker choose `C:\D\Veridian\Data\repo`.
3. Switch to that workspace. **Expected:** the 15 papers appear; opening one shows its PDF/markdown; no crash; console shows NO git/sync activity.
4. Edit an item (e.g. change a title / add a tag). Wait ~3s. **Expected:** `C:\D\Veridian\Data\repo\papers\<key>\item.json` updates on disk (check mtime/content).
5. Switch to personal library and back. **Expected:** the edit persists and re-imports; still no crash.
6. Confirm `C:\D\Veridian\Data\repo\.git` was never modified (its mtime is unchanged) — folder mode ignores git.

- [ ] **Step 3: (If shipping) bump version and update README**

Edit `package.json` `"version"` (e.g. `0.1.8` → `0.1.9`), then:

```bash
npm install --package-lock-only --ignore-scripts
```

Update the README version badge (`src`: `version-0.1.8` → `version-0.1.9`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json README.md
git commit -m "chore: bump version for local folder library"
```

---

## Self-Review

**Spec coverage:**
- "modify `local` in place, no new kind" → Tasks 2–3 rewrite the `local` branch; no `LocalWorkspaceKind`/`ActiveWorkspace.kind` change. ✓
- "reuse `local_path` as content root, index.db in app-managed cache" → Task 2 (`workspaceBaseDir(id, null)` + `contentRoot = ws.local_path`). ✓
- "no migration/no new column/no shared-types change" → confirmed; no such task. ✓
- "path normalization pure fn + test" → Task 1. ✓
- "activation: self-heal → importAll, no git" → Task 2 local branch. ✓
- "write-back: files only for local, github unchanged" → Task 3. ✓
- "creation UX: local option picks folder" → already wired (`tools.pickDir`); Task 4 adds the clarifying hint. ✓
- "existing-data path (C:\D\Veridian\Data\repo)" → Task 5 manual verify. ✓

**Placeholder scan:** none — every code step shows full old/new text.

**Type consistency:** `normalizeContentRoot(string): string` defined in Task 1, imported/used in Task 2. `exportChanges(repoRoot: string): void` defined in Task 3 Step 1, used in Steps 3 & 5. `commitAll`/`sync`/`importAll`/`exportItems`/`exportCollections`/`reconcileDeletions`/`exportMissingItems` already imported in both services. `ActiveWorkspace.repoRoot` (existing field) is the gating signal throughout Task 3.
