import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DomainEvent, JobStatus } from '../shared/events'

// Every invoke goes through the gateway envelope: { ok, data } on success,
// { ok: false, error } on failure. Unwrapping here keeps renderer call sites
// working with plain values / thrown Errors.
async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as {
    ok: boolean; data?: T; error?: string
  }
  if (!res.ok) throw new Error(res.error ?? `IPC ${channel} failed`)
  return res.data as T
}

// ── Push-event plumbing ───────────────────────────────────────────────────────
// All ipcRenderer.on listeners are registered once at the top level; renderer
// callbacks are swapped in and out of module-scope slots.

type DomainEventCb = (e: DomainEvent) => void
type Pdf2mdStatusCb = (e: {
  filename: string
  state: 'running' | 'done' | 'error' | 'idle'
  message: string
  chunk?: string
  pending: number
}) => void
type Pdf2mdProgressCb = (p: { state: string; message?: string; progress?: number }) => void

const _domainEventCbs = new Set<DomainEventCb>()
let _pdf2mdStatusCb: Pdf2mdStatusCb | null = null
let _pdf2mdProgressCb: Pdf2mdProgressCb | null = null

ipcRenderer.on('domain-event', (_ev, e: DomainEvent) => {
  for (const cb of _domainEventCbs) cb(e)

  // Legacy adapter: surface job progress (pdf2md, workspace.sync, ...)
  // through the old status API so the status bar shows all background work.
  if (e.type === 'job.progress') {
    const job: JobStatus = e.job
    _pdf2mdStatusCb?.({
      filename: job.label,
      state: job.state === 'queued' ? 'running' : job.state,
      message: job.message,
      chunk: job.chunk,
      pending: job.pending,
    })
  }
})
ipcRenderer.on('tool:pdf2md:progress', (_ev, p) => { _pdf2mdProgressCb?.(p) })

const veridianAPI = {
  items: {
    getAll: (libraryId?: number) => call('items:getAll', libraryId),
    getTrashed: (libraryId?: number) => call('items:getTrashed', libraryId),
    getByCollection: (collectionId: number) => call('items:getByCollection', collectionId),
    getById: (id: number) => call('items:getById', id),
    create: (data: Record<string, unknown>) => call('items:create', data),
    update: (id: number, data: Record<string, unknown>) => call('items:update', id, data),
    trash: (id: number) => call('items:trash', id),
    restore: (id: number) => call('items:restore', id),
    delete: (id: number) => call('items:delete', id),
    emptyTrash: (libraryId?: number) => call('items:emptyTrash', libraryId),
    fetchMetadata: (itemId: number) => call('items:fetchMetadata', itemId),
    search: (query: string) => call('items:search', query),
  },
  creators: {
    getByItem: (itemId: number) => call('creators:getByItem', itemId),
    setForItem: (itemId: number, creators: unknown[]) => call('creators:setForItem', itemId, creators),
  },
  tags: {
    getByItem: (itemId: number) => call('tags:getByItem', itemId),
    getAll: () => call('tags:getAll'),
    setForItem: (itemId: number, tagNames: string[]) => call('tags:setForItem', itemId, tagNames),
  },
  collections: {
    getAll: (libraryId?: number) => call('collections:getAll', libraryId),
    create: (name: string, libraryId?: number, parentId?: number) =>
      call('collections:create', name, libraryId, parentId),
    rename: (id: number, name: string) => call('collections:rename', id, name),
    delete: (id: number) => call('collections:delete', id),
    addItem: (collectionId: number, itemId: number) => call('collections:addItem', collectionId, itemId),
    removeItem: (collectionId: number, itemId: number) => call('collections:removeItem', collectionId, itemId),
    getItems: (collectionId: number) => call('collections:getItems', collectionId),
  },
  attachments: {
    getByItem: (itemId: number) => call('attachments:getByItem', itemId),
    add: (itemId: number) => call('attachments:add', itemId),
    remove: (id: number) => call('attachments:remove', id),
    getPath: (id: number) => call('attachments:getPath', id),
    openExternal: (id: number) => call('attachments:openExternal', id),
    openPath: (filePath: string) => call('attachments:openPath', filePath),
  },
  import: {
    openDialog: (collectionId?: number) => call('import:openDialog', collectionId),
  },
  fs: {
    readFile: (filePath: string) => call<Uint8Array>('fs:readFile', filePath),
    readTextFile: (filePath: string) => call<string>('fs:readTextFile', filePath),
    writeFile: (filePath: string, data: Uint8Array) => call('fs:writeFile', filePath, data),
    pdfjsWorkerPath: () => call<string>('pdfjs:workerPath'),
    listDir: (dirPath: string) => call<string[]>('fs:listDir', dirPath),
  },
  settings: {
    get: (key: string) => call('settings:get', key),
    set: (key: string, value: unknown) => call('settings:set', key, value),
    pickStoragePath: () => call('settings:pickStoragePath'),
  },
  pdf2md: {
    convertItem: (itemId: number) => call('pdf2md:convertItem', itemId),
  },
  localWorkspaces: {
    list: () => call('localWorkspaces:list'),
    create: (name: string, kind: string, repoOwner: string | null, repoName: string | null, localPath: string | null) =>
      call('localWorkspaces:create', name, kind, repoOwner, repoName, localPath),
    remove: (id: number) => call('localWorkspaces:remove', id),
  },
  workspace: {
    setActive: (id: number | null) => call('workspace:setActive', id),
    syncNow: () => call('workspace:syncNow'),
    listRepoTree: () => call('workspace:listRepoTree'),
  },
  github: {
    setPat: (pat: string) => call('github:setPat', pat),
    getStatus: () => call('github:getStatus'),
    testRepo: (repoUrl: string) => call('github:testRepo', repoUrl),
    listRepos: () => call('github:listRepos'),
  },
  // Domain-event stream: the renderer query cache subscribes here
  onDomainEvent: (cb: DomainEventCb) => { _domainEventCbs.add(cb) },
  offDomainEvent: (cb: DomainEventCb) => { _domainEventCbs.delete(cb) },
  // pdf2md status (queue-level, single LED) -- legacy adapter over job.progress
  onPdf2mdStatus: (cb: Pdf2mdStatusCb) => { _pdf2mdStatusCb = cb },
  offPdf2mdStatus: () => { _pdf2mdStatusCb = null },
  tools: {
    openExternal: (url: string) => call('shell:openExternal', url),
    pickPdf: () => call('tool:pick-pdf'),
    pickDir: () => call('tool:pick-dir'),
    pdf2md: (filePath: string, outputDir: string) => call('tool:pdf2md', filePath, outputDir),
    onPdf2mdProgress: (cb: Pdf2mdProgressCb) => { _pdf2mdProgressCb = cb },
    offPdf2mdProgress: () => { _pdf2mdProgressCb = null },
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('veridian', veridianAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.veridian = veridianAPI
}
