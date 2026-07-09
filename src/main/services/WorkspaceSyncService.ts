// Decides WHEN a github workspace syncs, composing the pieces that know HOW:
// Notifier events mark items dirty, a debounce coalesces bursts (an import
// touching items+tags+attachments becomes one commit), and the actual work
// runs as a serial 'workspace.sync' job -- progress reaches the status bar
// through the same job.progress stream pdf2md uses.
import { basename } from 'path'
import { subscribe, emit } from '../core/Notifier'
import { registerJobType, enqueue } from '../core/JobQueue'
import { getDb } from '../db'
import { getActiveWorkspace, setFlushHook } from './WorkspaceContextService'
import { exportItems, exportCollections, reconcileDeletions, importAll } from './WorkspaceFiles'
import { commitAll, sync } from './GitWorkspaceService'

const DEBOUNCE_MS = 3000

let dirtyItems = new Set<number>()
let collectionsDirty = false
let exportAllItems = false
let debounceTimer: NodeJS.Timeout | null = null
let jobQueued = false

interface SyncPayload {
  workspaceId: number
  repoRoot: string
  pushAfterExport: boolean
}

function markDirty(ids: number[]): void {
  for (const id of ids) dirtyItems.add(id)
}

/** Export pending changes to the working tree and commit. Returns commit made. */
async function exportAndCommit(repoRoot: string): Promise<boolean> {
  const db = getDb()
  const ids = exportAllItems
    ? (db.prepare('SELECT id FROM items').all() as Array<{ id: number }>).map((r) => r.id)
    : [...dirtyItems]
  dirtyItems = new Set()
  const doCollections = collectionsDirty || exportAllItems
  collectionsDirty = false
  exportAllItems = false

  if (doCollections) exportCollections(db, repoRoot)
  if (ids.length > 0) exportItems(db, repoRoot, ids)
  reconcileDeletions(db, repoRoot)

  return commitAll(repoRoot, `veridian: update ${new Date().toISOString()}`)
}

function scheduleSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const ctx = getActiveWorkspace()
    if (ctx.kind !== 'github' || !ctx.repoRoot || jobQueued) return
    jobQueued = true
    enqueue<SyncPayload>('workspace.sync', basename(ctx.repoRoot) === 'repo' ? `workspace #${ctx.id}` : basename(ctx.repoRoot), {
      workspaceId: ctx.id!, repoRoot: ctx.repoRoot, pushAfterExport: true,
    })
  }, DEBOUNCE_MS)
}

export function initWorkspaceSyncService(): void {
  registerJobType<SyncPayload>('workspace.sync', async (payload, ctx) => {
    jobQueued = false
    const activeCtx = getActiveWorkspace()
    // The user may have switched away while this job sat in the queue; the
    // index db it would export from is gone. Pending changes were flushed by
    // the switch hook, so skipping is safe.
    if (activeCtx.id !== payload.workspaceId || !activeCtx.repoRoot) {
      console.log('[WorkspaceSync] skipping sync for inactive workspace', payload.workspaceId)
      return
    }

    ctx.progress('导出更改...')
    await exportAndCommit(activeCtx.repoRoot)

    ctx.progress('与 GitHub 同步中...')
    const { pulled } = await sync(activeCtx.repoRoot)

    if (pulled) {
      ctx.progress('导入远端更改...')
      importAll(getDb(), activeCtx.repoRoot)
      emit({ type: 'workspace.dataRefreshed' })
    }
  }, { concurrency: 1, maxAttempts: 2 })

  // Every data mutation while a github workspace is active marks work for
  // the next debounce window. Import runs via direct SQL (WorkspaceFiles)
  // precisely so it emits none of these -- no export loops.
  subscribe((e) => {
    if (getActiveWorkspace().kind !== 'github') return
    switch (e.type) {
      case 'item.created':
        // Bulk imports emit an empty id list ("unspecified set changed") --
        // without this, nothing they created would ever be exported
        if (e.ids.length === 0) exportAllItems = true
        markDirty(e.ids); scheduleSync(); break
      case 'item.modified':
      case 'item.trashed':
      case 'item.restored':
        markDirty(e.ids); scheduleSync(); break
      case 'item.deleted':
        scheduleSync(); break   // reconcileDeletions handles removed dirs
      case 'tag.changed':
      case 'creator.changed':
      case 'attachment.changed':
        markDirty(e.itemIds); scheduleSync(); break
      case 'collection.changed':
        // Membership changes only carry collection ids -- affected items are
        // unknown, so re-export everything (libraries are small; correctness
        // over cleverness for v1)
        collectionsDirty = true; exportAllItems = true; scheduleSync(); break
      default:
        break
    }
  })

  // Flush hook: run export+commit synchronously-ish before a context switch
  // closes the index db (push is best-effort; the commit is what matters --
  // it survives locally until the next activation syncs it).
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
}

/** Manual "sync now" from the workspace switcher. */
export function syncNow(): void {
  const ctx = getActiveWorkspace()
  if (ctx.kind !== 'github' || !ctx.repoRoot) throw new Error('No GitHub workspace is active')
  if (jobQueued) return
  jobQueued = true
  enqueue<SyncPayload>('workspace.sync', `workspace #${ctx.id}`, {
    workspaceId: ctx.id!, repoRoot: ctx.repoRoot, pushAfterExport: true,
  })
}
