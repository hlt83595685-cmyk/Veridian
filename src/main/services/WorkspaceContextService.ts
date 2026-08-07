// Owns "which workspace is the app currently operating on". Switching swaps
// the active database context (db/index.ts routing), so every existing
// service/repo -- imports, pdf2md, the browser-extension server, tags,
// collections -- transparently reads and writes the active workspace with
// zero changes to any of them.
//
// For github-kind workspaces: ensures a local clone exists, opens the
// per-workspace index db, and rebuilds it from the working tree (the repo
// files are the source of truth; the index db is a disposable cache).
import { join } from 'path'
import { mkdirSync } from 'fs'
import { app } from 'electron'
import { openWorkspaceDb, closeWorkspaceDb, getDb } from '../db'
import { getWorkspace } from './LocalWorkspaceService'
import { ensureClone, commitAll, sync } from './GitWorkspaceService'
import { importAll, exportMissingItems } from './WorkspaceFiles'
import { grantAccess } from '../security/pathGuard'
import { emit } from '../core/Notifier'
import { getStatus } from './GitHubService'
import { normalizeContentRoot } from './contentRoot'
import { setAttribution } from './attribution'
import { setSetting } from './SettingsService'

export interface ActiveWorkspace {
  id: number | null            // null = personal library
  kind: 'personal' | 'local' | 'github'
  repoRoot: string | null      // set only for github workspaces
}

let active: ActiveWorkspace = { id: null, kind: 'personal', repoRoot: null }

// Set by WorkspaceSyncService -- flushes unexported changes to the working
// tree (and commits) before the index db closes on a switch away. Registered
// as a hook to avoid a module import cycle between the two services.
let flushHook: (() => Promise<void>) | null = null
export function setFlushHook(fn: () => Promise<void>): void {
  flushHook = fn
}

export function getActiveWorkspace(): ActiveWorkspace {
  return active
}

function workspaceBaseDir(id: number, localPath: string | null): string {
  // User-chosen storage root wins; app default otherwise. Either way the
  // clone and index live together under this directory.
  const dir = localPath && localPath.trim()
    ? localPath
    : join(app.getPath('userData'), 'workspaces', String(id))
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function setActiveWorkspace(id: number | null): Promise<ActiveWorkspace> {
  if (id === active.id) return active

  // Leaving a github workspace: persist pending changes first so nothing is
  // stranded in an index db that's about to close.
  if (active.kind === 'github' && flushHook) {
    try { await flushHook() }
    catch (err) { console.warn('[WorkspaceContext] flush before switch failed:', err) }
  }

  if (id === null) {
    closeWorkspaceDb()
    active = { id: null, kind: 'personal', repoRoot: null }
    setAttribution(null)
    setSetting('session.workspaceId', null)
    emit({ type: 'workspace.dataRefreshed' })
    return active
  }

  const ws = getWorkspace(id)
  if (!ws) throw new Error(`Workspace ${id} not found`)

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

  // Attribution follows the active workspace: github -> current GitHub login,
  // anything else -> null. A github workspace can only be activated after auth
  // succeeds, so the login is available here.
  if (active.kind === 'github') {
    const s = await getStatus().catch(() => null)
    setAttribution(s?.login ?? null)
  } else {
    setAttribution(null)
  }

  setSetting('session.workspaceId', id)
  emit({ type: 'workspace.dataRefreshed' })
  return active
}
