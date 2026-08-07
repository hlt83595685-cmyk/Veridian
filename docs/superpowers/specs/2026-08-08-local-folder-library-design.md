# Local Folder Library (`folder` workspace) — Design

Date: 2026-08-08
Status: Approved (design), pending implementation plan

## Goal

Let the user open an existing on-disk library folder (Veridian's `papers/`
repo layout) as an editable local workspace, with **no git involved**. Data is
imported from the folder for display; edits made in the app are written back to
the folder. This is the durable local-only alternative to GitHub sync (which
OOM-crashes on large repos — tracked separately, out of scope here).

## Scope

**In scope:** a new `folder` workspace kind — import from a chosen folder on
activation, write changes back to that folder, all without git.

**Out of scope (deferred):** any change to GitHub (`github`) workspace behavior
or its large-repo OOM problem. The `github` code paths must remain
byte-for-byte behaviorally identical. No remote sync, no file watching, no
multi-folder merge.

## Concept: a third workspace kind

| kind | index.db | `papers/` files | git |
|------|----------|-----------------|-----|
| `local` (existing) | sole data store | — | — |
| **`folder` (new)** | disposable cache | **source of truth** | — |
| `github` (existing) | disposable cache | source of truth | sync |

`folder` reuses the existing repo-layout translator (`WorkspaceFiles`):
`importAll` (papers/ → index.db) and `exportItems`/`exportCollections`/
`reconcileDeletions` (index.db → papers/). It simply **skips every git step**
(`ensureClone`, `commitAll`, `sync`).

Why this can't OOM like github: activation only parses small `item.json` files
and stores attachment *paths* (never loads PDFs), and write-back only writes
files. There is no git object packing — the operation that exhausts the heap on
a 1.9 GB repo.

## Data / schema

- `LocalWorkspaceKind`: add `'folder'`. `ActiveWorkspace.kind`: add `'folder'`.
- **Migration 9**: `ALTER TABLE workspaces ADD COLUMN content_root TEXT`.
  Holds the user's chosen library root (the folder that contains `papers/`).
  `null` for `local`/`github`.
- **Deliberately NOT reusing `local_path`.** `local_path` means "where the
  index.db / clone lives"; `content_root` means "the user's data folder". A
  `folder` workspace keeps its index.db in the app-managed
  `userData/workspaces/<id>/index.db` (a cache — never written inside the
  user's folder), and points `content_root` at the user's folder. Separate
  columns keep the two meanings from colliding — this is the crux of avoiding
  conflict with the existing `local` flow.

`shared/types.ts` `LocalWorkspace`: add `content_root: string | null`.

## Path normalization (picked folder → content root)

The user picks a folder; per their intent the path may end in `papers/`. A pure
function `normalizeContentRoot(pickedPath)` decides the root (string-only, unit
tested):

- basename is `papers` → root = parent directory.
- otherwise → root = the picked path itself (its `papers/` subdir is the data).

Caller then validates: if `root/papers` exists → import it; if not → treat as a
new empty library (the first write-back creates `papers/`). Either is accepted.

## Activation flow (new branch in `setActiveWorkspace`)

For `ws.kind === 'folder'`:

1. `base = workspaceBaseDir(id, null)` (app-managed cache dir, ignores
   `local_path`).
2. `grantAccess(base)` and `grantAccess(content_root)` (pathGuard whitelist).
3. `openWorkspaceDb(join(base, 'index.db'))`.
4. **Self-heal** (mirror github): `exportMissingItems(db, content_root)` to
   rescue any in-app changes stranded in the cached index.db from a crashed
   session (writes them to `papers/`), so step 5 can't discard them.
5. `importAll(db, content_root)` — rebuild the index from the folder.
6. `active = { id, kind: 'folder', repoRoot: content_root }`
   (`repoRoot` is reused as "the file-tree root"; works for github and folder).
7. `setAttribution(null)` (local, no GitHub identity).
8. No `ensureClone`, no `sync`, no git — anywhere.

If `content_root` is missing/deleted at activation: catch, surface an error, do
not crash; leave the previous/personal context active.

## Write-back flow (`WorkspaceSyncService`, git gated)

Today export is gated on `kind === 'github'`. Generalize to "synced-to-files"
workspaces = `github` **or** `folder`:

- The event subscription and `scheduleSync` fire for `github` and `folder`.
- Refactor `exportAndCommit` → `exportChanges(repoRoot)` doing only the file
  writes (`exportCollections` + `exportItems` + `reconcileDeletions`).
- The `workspace.sync` job and the flush hook branch on kind:
  - `folder`: `exportChanges(...)` only — **no `commitAll`, no `sync`**.
  - `github`: `exportChanges(...)` → `commitAll(...)` → `sync(...)` → (if
    pulled) `importAll` — **unchanged behavior**, just re-expressed.

Result: in-app add/edit/delete/pdf2md → 3s debounce → files written back into
`content_root/papers/`. The folder stays a faithful, portable copy.

## Creation UX (workspace switcher "New" dialog)

- Add a third kind option: **"本地文献库文件夹" / "Local library folder"**.
- Selecting it reveals a folder picker (reuse the existing directory-picker
  IPC).
- On submit: `normalizeContentRoot(picked)` → `content_root`; create the
  workspace via `createWorkspace(name, 'folder', null, null, null, contentRoot)`.
- `createWorkspace` gains a `contentRoot` parameter; the
  `localWorkspaces:create` IPC contract + preload signature extend to match.

## Existing-data path

The user points at `C:\D\Veridian\Data\repo` (or `...\repo\papers`) → their 15
papers import and display, editable, writing back to that folder, no git, no
crash. The 1.9 GB `.git` there is ignored by folder mode and may be deleted
manually to reclaim space.

## Components touched

- `src/main/db/index.ts` — migration 9 (`content_root`).
- `src/shared/types.ts` — `LocalWorkspaceKind` + `LocalWorkspace.content_root`.
- `src/main/services/LocalWorkspaceService.ts` — `createWorkspace(contentRoot)`.
- `src/main/services/WorkspaceContextService.ts` — `folder` activation branch;
  `normalizeContentRoot` (new pure helper + test).
- `src/main/services/WorkspaceSyncService.ts` — git gating → files-only for
  `folder`, github unchanged.
- `src/shared/ipc-contract.ts`, `src/preload/index.ts`, `env.d.ts` —
  `localWorkspaces:create` gains `contentRoot`; directory-picker wiring.
- `src/renderer/.../WorkspaceSwitcher.tsx` (create dialog) — new kind + picker.
- `src/renderer/src/i18n/index.ts` — labels (zh + en; NOT locales/*.json).

## Testing

- Unit: `normalizeContentRoot` (papers-suffix vs plain root).
- Manual: create a `folder` workspace on `C:\D\Veridian\Data\repo`, confirm the
  15 papers appear; add/edit an item and confirm it writes into
  `repo/papers/...`; deactivate/reactivate and confirm it re-reads; confirm no
  git activity and no crash.

## Non-goals / risks

- Not a fix for github OOM (separate work).
- No live filesystem watching: external edits to the folder show up only on
  re-activation.
- Hard-crash window between an in-app edit and the 3s write-back is covered by
  the step-4 self-heal on next activation.
