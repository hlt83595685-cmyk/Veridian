# Local Folder Library (folder-backed `local` workspace) — Design

Date: 2026-08-08
Status: Approved (design, revised), pending implementation plan

## Goal

Let the user open an existing on-disk library folder (Veridian's `papers/`
repo layout) as an editable local workspace, with **no git involved**. Data is
imported from the folder for display; edits made in the app are written back to
the folder. This is the durable local-only alternative to GitHub sync (which
OOM-crashes on large repos — tracked separately, out of scope here).

## Scope

**In scope:** make the existing `local` workspace kind folder-backed — import
from a chosen folder on activation, write changes back to it, all without git.

**Out of scope (deferred):** any change to GitHub (`github`) workspace behavior
or its large-repo OOM problem. The `github` code paths remain behaviorally
identical. No remote sync, no file watching, no multi-folder merge.

## Key decision: modify `local` in place (no new kind)

Rather than add a third kind, we **redefine `local`** to be folder-backed. This
avoids two competing flows (the conflict originally worried about): `local`
simply *becomes* the folder library. There are no existing DB-only `local`
workspaces to preserve (the user's only workspace is the `github` one), and the
DB-only behavior is retained as a fallback for a `local` workspace with no
folder set.

| kind | index.db | `papers/` files | git |
|------|----------|-----------------|-----|
| `local` **with** folder (new) | disposable cache | **source of truth** | — |
| `local` **without** folder (legacy fallback) | sole data store | — | — |
| `github` (existing, unchanged) | disposable cache | source of truth | sync |

`local`-with-folder reuses the existing repo-layout translator
(`WorkspaceFiles`): `importAll` (papers/ → index.db) and
`exportItems`/`exportCollections`/`reconcileDeletions` (index.db → papers/),
**skipping every git step** (`ensureClone`, `commitAll`, `sync`).

Why this can't OOM like github: activation only parses small `item.json` files
and stores attachment *paths* (never loads PDFs); write-back only writes files.
There is no git object packing — the operation that exhausts the heap on a
1.9 GB repo.

## Data / schema

- **No migration, no new column, no new kind.** Reuse the existing
  `workspaces.local_path` column to hold the user's chosen library folder
  (its "content root", the folder that contains `papers/`).
- Meaning of `local_path` becomes kind-dependent (kind-gated, so unambiguous):
  - `github`: base dir for the clone + index.db (unchanged).
  - `local`: the user's content-root folder. The index.db does **not** live
    here — it stays in the app-managed cache `userData/workspaces/<id>/index.db`
    so the user's folder is never polluted.
- `shared/types.ts`: no type change needed (`local_path` already exists;
  `LocalWorkspaceKind` already includes `'local'`).

## Path normalization (picked folder → content root)

The user picks a folder; the path may end in `papers/`. A pure function
`normalizeContentRoot(pickedPath)` decides the root (string-only, unit tested):

- basename is `papers` → root = parent directory.
- otherwise → root = the picked path itself (its `papers/` subdir is the data).

Caller validation: if `root/papers` exists → import it; if not → treat as a new
empty library (the first write-back creates `papers/`). Both accepted.

## Activation flow (`setActiveWorkspace`, `local` branch rewritten)

For `ws.kind === 'local'`:

1. `contentRoot = ws.local_path` (may be null → legacy DB-only path).
2. `base = workspaceBaseDir(id, null)` (app-managed cache dir — **ignores**
   `local_path` for the index.db location).
3. `grantAccess(base)`; if `contentRoot`, `grantAccess(contentRoot)`.
4. `openWorkspaceDb(join(base, 'index.db'))`.
5. If `contentRoot`:
   - **Self-heal** `exportMissingItems(db, contentRoot)` — rescue any in-app
     changes stranded in the cached index.db from a crashed session (writes
     them to `papers/`) so step 6 can't discard them.
   - `importAll(db, contentRoot)` — rebuild the index from the folder.
6. `active = { id, kind: 'local', repoRoot: contentRoot }` — `repoRoot` reused
   as "the file-tree root" (null for legacy DB-only local; set for
   folder-backed). No git anywhere.
7. `setAttribution(null)`.

If `contentRoot` is set but missing/deleted at activation: catch, surface an
error, do not crash; leave the previous/personal context active.

## Write-back flow (`WorkspaceSyncService`, git gated)

Today export/sync is gated on `kind === 'github'`. Generalize so a `local`
workspace **with a `repoRoot`** also writes back — without git:

- The event subscription and `scheduleSync` fire for `github`, and for `local`
  when `getActiveWorkspace().repoRoot` is set.
- Refactor `exportAndCommit` → `exportChanges(repoRoot)` doing only the file
  writes (`exportCollections` + `exportItems` + `reconcileDeletions`).
- The `workspace.sync` job and the flush hook branch on kind:
  - `local` (with repoRoot): `exportChanges(...)` only — **no `commitAll`, no
    `sync`**.
  - `github`: `exportChanges(...)` → `commitAll(...)` → `sync(...)` → (if
    pulled) `importAll` — **unchanged behavior**, re-expressed.
  - `local` without repoRoot / `personal`: no-op (as today).

Result: in-app add/edit/delete/pdf2md → 3s debounce → files written back into
`contentRoot/papers/`. The folder stays a faithful, portable copy.

## Creation UX (workspace switcher "New" dialog)

- The existing **"本地私人 / Local"** option gains a **folder picker**:
  choosing a folder makes the local workspace folder-backed; leaving it empty
  creates a legacy empty DB-only local workspace.
- On submit with a folder: `normalizeContentRoot(picked)` → stored in
  `local_path`; `createWorkspace(name, 'local', null, null, contentRoot)`
  (the existing `localPath` parameter carries it — no signature change).
- Reuse the existing directory-picker IPC.

## Existing-data path

The user points a new `local` workspace at `C:\D\Veridian\Data\repo` (or
`...\repo\papers`) → their 15 papers import and display, editable, writing back
to that folder, no git, no crash. The 1.9 GB `.git` there is ignored by local
mode and may be deleted manually to reclaim space.

## Components touched

- `src/main/services/WorkspaceContextService.ts` — rewrite the `local`
  activation branch; add `normalizeContentRoot` pure helper (+ unit test).
- `src/main/services/WorkspaceSyncService.ts` — git gating → files-only
  write-back for folder-backed `local`; github unchanged; split
  `exportAndCommit` into `exportChanges` + git steps.
- `src/renderer/.../WorkspaceSwitcher.tsx` (create dialog) — folder picker on
  the local option.
- Directory-picker wiring if not already exposed (`ipc-contract`, `preload`,
  `env.d.ts`).
- `src/renderer/src/i18n/index.ts` — labels (zh + en; NOT locales/*.json).

No DB migration, no `shared/types` change, no new IPC channel for kinds.

## Testing

- Unit: `normalizeContentRoot` (papers-suffix vs plain root).
- Manual: create a folder-backed `local` workspace on `C:\D\Veridian\Data\repo`,
  confirm the 15 papers appear; add/edit an item and confirm it writes into
  `repo/papers/...`; deactivate/reactivate and confirm re-read; confirm no git
  activity and no crash.

## Non-goals / risks

- Not a fix for github OOM (separate work).
- No live filesystem watching: external edits to the folder show up only on
  re-activation.
- Hard-crash window between an in-app edit and the 3s write-back is covered by
  the step-5 self-heal on next activation.
- `local_path` now means different things for `local` vs `github`; mitigated by
  strict kind-gating in the two activation branches.
