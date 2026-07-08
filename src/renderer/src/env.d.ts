/// <reference types="vite/client" />

import type {
  Item, Creator, Collection, Tag, Attachment, ImportResult,
  Workspace, WorkspaceMember, WorkspaceInvite, MemberRole, WorkspaceKind,
  SyncBackendType, ControlPlaneStatus,
} from '../../shared/types'
import type { DomainEvent } from '../../shared/events'

interface VeridianAPI {
  items: {
    getAll: (libraryId?: number) => Promise<Item[]>
    getTrashed: (libraryId?: number) => Promise<Item[]>
    getByCollection: (collectionId: number) => Promise<Item[]>
    getById: (id: number) => Promise<Item | undefined>
    create: (data: Partial<Item>) => Promise<Item>
    update: (id: number, data: Partial<Item>) => Promise<void>
    trash: (id: number) => Promise<void>
    restore: (id: number) => Promise<void>
    delete: (id: number) => Promise<void>
    emptyTrash: (libraryId?: number) => Promise<void>
    fetchMetadata: (itemId: number) => Promise<{ source: 'crossref' | 'markdown' | 'none'; titleUpdated: boolean; tagsAdded: number }>
    search: (query: string) => Promise<Item[]>
  }
  creators: {
    getByItem: (itemId: number) => Promise<Creator[]>
    setForItem: (itemId: number, creators: Creator[]) => Promise<void>
  }
  tags: {
    getByItem: (itemId: number) => Promise<Tag[]>
    getAll: () => Promise<Tag[]>
    setForItem: (itemId: number, tagNames: string[]) => Promise<void>
  }
  collections: {
    getAll: (libraryId?: number) => Promise<Collection[]>
    create: (name: string, libraryId?: number, parentId?: number) => Promise<Collection>
    rename: (id: number, name: string) => Promise<void>
    delete: (id: number) => Promise<void>
    addItem: (collectionId: number, itemId: number) => Promise<void>
    removeItem: (collectionId: number, itemId: number) => Promise<void>
    getItems: (collectionId: number) => Promise<Item[]>
  }
  attachments: {
    getByItem: (itemId: number) => Promise<Attachment[]>
    add: (itemId: number) => Promise<Attachment | null>
    remove: (id: number) => Promise<void>
    getPath: (id: number) => Promise<string | null>
    openExternal: (id: number) => Promise<void>
    openPath: (filePath: string) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    pickStoragePath: () => Promise<string | null>
    notifyLocale: (locale: string) => void
  }
  pdf2md: {
    convertItem: (itemId: number) => Promise<{ error: string | null }>
  }
  controlPlane: {
    configure: (url: string, anonKey: string) => Promise<void>
    getStatus: () => Promise<ControlPlaneStatus>
    signIn: (email: string, password: string) => Promise<{ error: string | null }>
    signUp: (email: string, password: string) => Promise<{ error: string | null }>
    signOut: () => Promise<void>
  }
  workspaces: {
    list: () => Promise<Workspace[]>
    create: (
      name: string, kind: WorkspaceKind, backendType: SyncBackendType, config: Record<string, unknown>
    ) => Promise<Workspace>
    listMembers: (workspaceId: string) => Promise<WorkspaceMember[]>
    updateMemberRole: (workspaceId: string, userId: string, role: MemberRole) => Promise<void>
    removeMember: (workspaceId: string, userId: string) => Promise<void>
    listInvites: (workspaceId: string) => Promise<WorkspaceInvite[]>
    invite: (workspaceId: string, email: string, role: MemberRole) => Promise<WorkspaceInvite>
    revokeInvite: (inviteId: string) => Promise<void>
    acceptInvite: (token: string) => Promise<Workspace>
  }
  onPdf2mdStatus: (cb: (e: {
    filename: string
    state: 'running' | 'done' | 'error' | 'idle'
    message: string
    chunk?: string
    pending: number
  }) => void) => void
  offPdf2mdStatus: () => void
  onToolsOpen: (cb: (tab: string) => void) => void
  offToolsOpen: () => void
  onSettingsOpen: (cb: (tab: string) => void) => void
  offSettingsOpen: () => void
  onSetLocale: (cb: (locale: string) => void) => void
  offSetLocale: () => void
  import: {
    openDialog: (collectionId?: number) => Promise<ImportResult>
  }
  fs: {
    readFile: (filePath: string) => Promise<Uint8Array>
    readTextFile: (filePath: string) => Promise<string>
    writeFile: (filePath: string, data: Uint8Array) => Promise<void>
    pdfjsWorkerPath: () => Promise<string>
    listDir: (dirPath: string) => Promise<string[]>
  }
  onDomainEvent: (cb: (e: DomainEvent) => void) => void
  offDomainEvent: (cb: (e: DomainEvent) => void) => void
  tools: {
    openExternal: (url: string) => Promise<void>
    pickPdf: () => Promise<string | null>
    pickDir: () => Promise<string | null>
    pdf2md: (filePath: string, outputDir: string) => Promise<{ outPath?: string; error?: string }>
    onPdf2mdProgress: (cb: (p: { state: string; message?: string; progress?: number }) => void) => void
    offPdf2mdProgress: () => void
  }
}

declare global {
  interface Window {
    veridian: VeridianAPI
    electron: {
      ipcRenderer: {
        send: (channel: string, ...args: unknown[]) => void
        on: (channel: string, func: (...args: unknown[]) => void) => () => void
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
      }
    }
  }
}
