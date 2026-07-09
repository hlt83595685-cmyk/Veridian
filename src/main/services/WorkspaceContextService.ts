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

function workspaceBaseDir(id: number): string {
  const dir = join(app.getPath('userData'), 'workspaces', String(id))
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
    emit({ type: 'workspace.dataRefreshed' })
    return active
  }

  const ws = getWorkspace(id)
  if (!ws) throw new Error(`Workspace ${id} not found`)

  const base = workspaceBaseDir(id)

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

  emit({ type: 'workspace.dataRefreshed' })
  return active
}
