// Contract-first IPC: the single source of truth for every channel's argument
// schema. The main-process gateway validates incoming args against these
// schemas before any handler runs; the preload bridge derives its channel list
// from the same object. Adding a channel without declaring it here is a
// compile-time error on both sides.
import { z } from 'zod'

const id = z.number().int().positive()
const optionalLibraryId = z.number().int().positive().optional()

const itemPatch = z.object({
  type: z.string().max(64).optional(),
  title: z.string().max(2000).nullable().optional(),
  abstract: z.string().max(20000).nullable().optional(),
  year: z.number().int().min(0).max(3000).nullable().optional(),
  doi: z.string().max(256).nullable().optional(),
  url: z.string().max(2048).nullable().optional(),
  journal: z.string().max(512).nullable().optional(),
  publisher: z.string().max(512).nullable().optional(),
  volume: z.string().max(64).nullable().optional(),
  issue: z.string().max(64).nullable().optional(),
  pages: z.string().max(64).nullable().optional(),
  isbn: z.string().max(64).nullable().optional(),
  language: z.string().max(64).nullable().optional(),
  extra: z.string().max(20000).nullable().optional(),
  library_id: optionalLibraryId,
}).strict()

const creator = z.object({
  id: z.number().int().optional(),
  first_name: z.string().max(256).nullable(),
  last_name: z.string().max(256),
  orcid: z.string().max(64).nullable().optional(),
  role: z.enum(['author', 'editor', 'translator']),
  position: z.number().int().min(0),
})

const pathString = z.string().min(1).max(1024)
const uuid = z.string().uuid()
const memberRole = z.enum(['owner', 'admin', 'editor', 'viewer'])
const syncBackendConfig = z.record(z.string(), z.unknown())

export const contract = {
  // Items
  'items:getAll':          z.tuple([optionalLibraryId]),
  'items:getTrashed':      z.tuple([optionalLibraryId]),
  'items:getByCollection': z.tuple([id]),
  'items:getById':         z.tuple([id]),
  'items:create':          z.tuple([itemPatch]),
  'items:update':          z.tuple([id, itemPatch]),
  'items:trash':           z.tuple([id]),
  'items:restore':         z.tuple([id]),
  'items:delete':          z.tuple([id]),
  'items:emptyTrash':      z.tuple([optionalLibraryId]),
  'items:search':          z.tuple([z.string().max(512)]),
  'items:fetchMetadata':   z.tuple([id]),

  // Creators
  'creators:getByItem':    z.tuple([id]),
  'creators:setForItem':   z.tuple([id, z.array(creator).max(200)]),

  // Tags
  'tags:getByItem':        z.tuple([id]),
  'tags:getAll':           z.tuple([]),
  'tags:setForItem':       z.tuple([id, z.array(z.string().min(1).max(120)).max(100)]),

  // Collections
  'collections:getAll':     z.tuple([optionalLibraryId]),
  'collections:create':     z.tuple([z.string().min(1).max(256), optionalLibraryId, id.optional()]),
  'collections:rename':     z.tuple([id, z.string().min(1).max(256)]),
  'collections:delete':     z.tuple([id]),
  'collections:addItem':    z.tuple([id, id]),
  'collections:removeItem': z.tuple([id, id]),
  'collections:getItems':   z.tuple([id]),

  // Attachments
  'attachments:getByItem':    z.tuple([id]),
  'attachments:add':          z.tuple([id]),
  'attachments:remove':       z.tuple([id]),
  'attachments:getPath':      z.tuple([id]),
  'attachments:openExternal': z.tuple([id]),
  'attachments:openPath':     z.tuple([pathString]),

  // Import
  'import:openDialog': z.tuple([id.optional()]),

  // File system (all paths pass through pathGuard in the handlers)
  'fs:readFile':     z.tuple([pathString]),
  'fs:readTextFile': z.tuple([pathString]),
  'fs:writeFile':    z.tuple([pathString, z.instanceof(Uint8Array)]),
  'fs:listDir':      z.tuple([pathString]),
  'pdfjs:workerPath': z.tuple([]),

  // Settings
  'settings:get':             z.tuple([z.string().max(128)]),
  'settings:set':             z.tuple([z.string().max(128), z.unknown()]),
  'settings:pickStoragePath': z.tuple([]),

  // Tools / conversion
  'shell:openExternal': z.tuple([z.string().url().max(2048)]),
  'tool:pick-pdf':      z.tuple([]),
  'tool:pick-dir':      z.tuple([]),
  'tool:pdf2md':        z.tuple([pathString, pathString]),
  'pdf2md:convertItem': z.tuple([id]),

  // Control plane (self-hosted Supabase OSS subset -- see control-plane/)
  'controlPlane:configure': z.tuple([z.string().url().max(512), z.string().min(10).max(2048)]),
  'controlPlane:getStatus': z.tuple([]),
  'controlPlane:signIn':    z.tuple([z.string().email().max(320), z.string().min(6).max(256)]),
  'controlPlane:signOut':   z.tuple([]),

  // Workspaces (control-plane data: identity/membership/roles/invites only --
  // never literature data, which lives in the git/cloud-folder data plane)
  'workspaces:list':             z.tuple([]),
  'workspaces:create':           z.tuple([
    z.string().min(1).max(256), z.enum(['private', 'shared']),
    z.enum(['git', 'cloud_folder']), syncBackendConfig,
  ]),
  'workspaces:listMembers':      z.tuple([uuid]),
  'workspaces:updateMemberRole': z.tuple([uuid, uuid, memberRole]),
  'workspaces:removeMember':     z.tuple([uuid, uuid]),
  'workspaces:listInvites':      z.tuple([uuid]),
  'workspaces:invite':           z.tuple([uuid, z.string().email().max(320), memberRole]),
  'workspaces:revokeInvite':     z.tuple([uuid]),
  'workspaces:acceptInvite':     z.tuple([z.string().min(10).max(256)]),
} as const

export type IpcChannel = keyof typeof contract
