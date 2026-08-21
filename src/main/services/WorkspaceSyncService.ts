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
import { hasPendingConversions, setOnConversionsIdle, clearStagingIfRelocated } from './ConversionService'

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

/** Write pending changes to the working tree (no git). */
function exportChanges(repoRoot: string, includeFailed: boolean): number[] {
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
  dirtyItems = new Set()
  const doCollections = collectionsDirty || exportAllItems
  collectionsDirty = false
  exportAllItems = false

  if (doCollections) exportCollections(db, repoRoot)
  if (ids.length > 0) exportItems(db, repoRoot, ids)
  reconcileDeletions(db, repoRoot)
  return ids
}

function scheduleSync(): void {
  // Hold sync while a pdf2md conversion is in flight so the PDF and its
  // converted attachments commit together (one commit, not two). The idle
  // hook re-invokes scheduleSync when conversions settle.
  if (hasPendingConversions()) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const ctx = getActiveWorkspace()
    // Any workspace with a file tree (github OR folder-backed local) writes
    // back; personal / DB-only local have no repoRoot and never enqueue.
    if (!ctx.repoRoot || jobQueued) return
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
    console.log('[WorkspaceSync] export start')
    const exported = exportChanges(activeCtx.repoRoot, activeCtx.kind !== 'github')
    for (const id of exported) clearStagingIfRelocated(getDb(), id)
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
  }, { concurrency: 1, maxAttempts: 2 })

  // When all in-flight conversions finish, run the sync that was held back.
  setOnConversionsIdle(() => scheduleSync())

  // Every data mutation while a github workspace is active marks work for
  // the next debounce window. Import runs via direct SQL (WorkspaceFiles)
  // precisely so it emits none of these -- no export loops.
  subscribe((e) => {
    // Fire for any workspace with a file tree (github or folder-backed local).
    if (!getActiveWorkspace().repoRoot) return
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
    if (!ctx.repoRoot) return
    const exported = exportChanges(ctx.repoRoot, ctx.kind !== 'github')   // write files (github AND folder-backed local)
    for (const id of exported) clearStagingIfRelocated(getDb(), id)
    if (ctx.kind === 'github') {
      try {
        await commitAll(ctx.repoRoot, `veridian: update ${new Date().toISOString()}`)
        await sync(ctx.repoRoot)
      } catch (err) {
        console.warn('[WorkspaceSync] push on switch failed (will retry next activation):', err)
      }
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
