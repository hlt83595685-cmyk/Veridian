/// <reference types="vite/client" />

import type {
  Item, Creator, Collection, Tag, Attachment, ImportResult,
  LocalWorkspace, LocalWorkspaceKind, GitHubRepoInfo, RepoTreeNode,
  UpdateCheckResult,
} from '../../shared/types'
import type { DomainEvent } from '../../shared/events'
import type { KnowledgeRef } from '../../shared/ipc-contract'

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
    setStarred: (id: number, starred: boolean) => Promise<void>
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
    reveal: (id: number) => Promise<void>
  }
  settings: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    pickStoragePath: () => Promise<string | null>
  }
  session: {
    saveViewer: (viewer: { type: 'pdf' | 'markdown' | 'gallery'; path: string; filename: string } | null) => Promise<void>
  }
  pdf2md: {
    convertItem: (itemId: number) => Promise<{ error: string | null }>
  }
  localWorkspaces: {
    list: () => Promise<LocalWorkspace[]>
    create: (
      name: string, kind: LocalWorkspaceKind, repoOwner: string | null, repoName: string | null,
      localPath: string | null
    ) => Promise<LocalWorkspace>
    remove: (id: number) => Promise<void>
  }
  workspace: {
    setActive: (id: number | null) => Promise<{ id: number | null; kind: string; repoRoot: string | null }>
    syncNow: () => Promise<void>
    listRepoTree: () => Promise<RepoTreeNode[]>
  }
  github: {
    loginStart: () => Promise<{ userCode: string; verificationUri: string }>
    loginCancel: () => Promise<void>
    logout: () => Promise<void>
    getStatus: () => Promise<{ authed: boolean; login: string | null; avatarUrl: string | null; error: string | null }>
    testRepo: (repoUrl: string) => Promise<{
      ok: boolean
      code: 'ok_write' | 'ok_read' | 'no_pat' | 'invalid_url' | 'not_found' | 'http_error' | 'network'
      detail?: string
    }>
    listRepos: () => Promise<GitHubRepoInfo[]>
    avatarPath: (login: string) => Promise<string | null>
    inviteCollaborator: (owner: string, repo: string, username: string) => Promise<{
      ok: boolean; alreadyCollaborator?: boolean; code?: string; detail?: string
    }>
    listInvitations: () => Promise<Array<{
      id: number; repoOwner: string; repoName: string; repoFullName: string; inviterLogin: string
    }>>
    acceptInvitation: (id: number) => Promise<void>
    declineInvitation: (id: number) => Promise<void>
    listCollaborators: (owner: string, repo: string) => Promise<{
      ok: boolean
      collaborators?: Array<{ login: string; avatarUrl: string; role: string }>
      code?: string
      detail?: string
    }>
  }
  knowledge: {
    ask: (question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null) => Promise<number>
    stop: (conversationId: number) => Promise<void>
    regenerate: (conversationId: number) => Promise<void>
    editResend: (conversationId: number, question: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null) => Promise<void>
    listConversations: () => Promise<Array<{ id: number; title: string; created_at: number; scope_collection_id: number | null }>>
    getMessages: (conversationId: number) => Promise<Array<{
      id: number; conversation_id: number; role: string; content: string
      citations: string; created_at: number; steps: string; refs: string
    }>>
    getChunk: (itemKey: string, seq: number) => Promise<{ headingPath: string; text: string } | null>
    deleteConversation: (conversationId: number) => Promise<void>
    rebuildIndex: () => Promise<void>
    indexStatus: () => Promise<{
      items: number; indexedItems: number; pendingChunks: number; totalChunks: number
      embeddingModel: string | null; vecAvailable: boolean
    }>
    pickStoragePath: () => Promise<string | null>
    testProvider: (which: 'chat' | 'embedding') => Promise<string | null>
  }
  skills: {
    list: () => Promise<Array<{ name: string; description: string }>>
    installFromGithub: (url: string) => Promise<{ name: string; description: string }>
    installFromZip: () => Promise<{ name: string; description: string } | null>
    uninstall: (name: string) => Promise<void>
  }
  onPdf2mdStatus: (cb: (e: {
    jobType: string
    filename: string
    state: 'running' | 'done' | 'error' | 'idle'
    message: string
    chunk?: string
    pending: number
    progress?: number
  }) => void) => void
  offPdf2mdStatus: () => void
  app: {
    version: () => Promise<string>
  }
  updates: {
    check: () => Promise<UpdateCheckResult>
  }
  import: {
    openDialog: (collectionId?: number) => Promise<ImportResult>
    paths: (filePaths: string[], collectionId?: number) => Promise<ImportResult>
    pathForFile: (file: File) => string
  }
  fs: {
    readFile: (filePath: string) => Promise<Uint8Array>
    readTextFile: (filePath: string) => Promise<string>
    writeFile: (filePath: string, data: Uint8Array) => Promise<void>
    pdfjsWorkerPath: () => Promise<string>
    listDir: (dirPath: string) => Promise<string[]>
  }
  /** Returns an unsubscribe function -- see the preload comment on why offDomainEvent(cb) can't work. */
  onDomainEvent: (cb: (e: DomainEvent) => void) => () => void
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
