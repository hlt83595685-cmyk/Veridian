// Contract-first IPC: the single source of truth for every channel's argument
// schema. The main-process gateway validates incoming args against these
// schemas before any handler runs; the preload bridge derives its channel list
// from the same object. Adding a channel without declaring it here is a
// compile-time error on both sides.
import { z } from 'zod'
import { PLUGIN_ID_RE } from './plugin'

const id = z.number().int().positive()
const pluginId = z.string().regex(PLUGIN_ID_RE)

/** 一匹马的装配清单。工具**名字**是开集——插件可以注册任何名字——所以这里只
 *  能限长度与条数，不能像 ceiling 那样枚举成闭集。 */
const toolNames = z.array(z.string().min(1).max(64)).max(100)
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

// @-mention context attached to a knowledge:ask call -- resolved server-side
// into extra hidden context messages, kept out of the 4000-char question cap.
const knowledgeRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item'), itemKey: z.string().min(1).max(64) }),
  z.object({ type: z.literal('file'), path: pathString }),
  z.object({ type: z.literal('skill'), name: z.string().min(1).max(64) }),
])

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
  'items:setStarred':      z.tuple([id, z.boolean()]),

  // App info / updates
  'app:version':   z.tuple([]),
  'updates:check': z.tuple([]),

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
  'attachments:reveal':       z.tuple([id]),

  // Import
  'import:openDialog': z.tuple([id.optional()]),
  'import:paths':      z.tuple([z.array(pathString).max(500), id.optional()]),

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

  // Plugins. Config/enable/source are per plugin id; fetch streams its result back
  // as 'plugin:fetch:event' pushes (see preload), so the invoke itself returns at once.
  'plugin:list':       z.tuple([]),
  'plugin:setConfig':  z.tuple([pluginId, z.string().min(1).max(32), z.string().max(4096)]),
  'plugin:setEnabled': z.tuple([pluginId, z.boolean()]),
  'plugin:source':     z.tuple([pluginId]),
  'plugin:fetch':      z.tuple([z.object({
    id: z.string().min(1).max(64),
    pluginId,
    url: z.string().max(4096),
    method: z.string().max(16),
    headers: z.record(z.string(), z.string()),
    body: z.string().max(1_000_000).optional(),
  })]),
  'plugin:fetchAbort': z.tuple([z.string().min(1).max(64)]),

  // Session restore -- workspaceId is persisted by the main process itself
  // (WorkspaceContextService); the viewer (which file/type was open) is
  // renderer-only state, so it needs this dedicated write channel rather
  // than widening the generic settings:set whitelist.
  'session:saveViewer': z.tuple([
    z.object({
      type: z.enum(['pdf', 'markdown', 'gallery']),
      path: z.string().max(4096),
      filename: z.string().max(512),
    }).nullable(),
  ]),

  // Tools / conversion
  'shell:openExternal': z.tuple([z.string().url().max(2048)]),
  'tool:pick-pdf':      z.tuple([]),
  'tool:pick-dir':      z.tuple([]),
  'tool:pdf2md':        z.tuple([pathString, pathString]),
  'pdf2md:convertItem': z.tuple([id]),

  // Local workspaces (rows in the local SQLite DB; shared ones are bound to
  // a GitHub repo -- identity/permissions are GitHub's own PAT + repo
  // collaborator model, no separate account system)
  'localWorkspaces:list':   z.tuple([]),
  'localWorkspaces:create': z.tuple([
    z.string().min(1).max(256), z.enum(['local', 'github']),
    z.string().max(256).nullable(), z.string().max(256).nullable(),
    z.string().max(1024).nullable(),   // user-chosen local storage root
  ]),
  'localWorkspaces:remove': z.tuple([id]),
  'workspace:setActive':    z.tuple([id.nullable()]),
  'workspace:syncNow':      z.tuple([]),
  'workspace:listRepoTree': z.tuple([]),

  // GitHub OAuth (data-plane credential, strictly per-device -- never synced)
  'github:loginStart':  z.tuple([]),
  'github:loginCancel': z.tuple([]),
  'github:logout':      z.tuple([]),
  'github:getStatus':   z.tuple([]),
  'github:testRepo':    z.tuple([z.string().min(1).max(512)]),
  'github:listRepos':   z.tuple([]),
  'github:avatarPath':  z.tuple([z.string().min(1).max(64)]),
  'github:inviteCollaborator': z.tuple([
    z.string().min(1).max(256), z.string().min(1).max(256), z.string().min(1).max(64),
  ]),
  'github:listInvitations':    z.tuple([]),
  'github:acceptInvitation':   z.tuple([z.number().int().positive()]),
  'github:declineInvitation':  z.tuple([z.number().int().positive()]),
  'github:listCollaborators':  z.tuple([z.string().min(1).max(256), z.string().min(1).max(256)]),

  // AI knowledge base (RAG). ask returns a conversation id immediately; the
  // streamed answer arrives via knowledge.chatDelta / chatState domain events.
  'knowledge:ask':                z.tuple([z.string().min(1).max(4000), id.nullable(), z.array(knowledgeRef).max(5).optional(), z.string().min(1).max(64).optional()]),
  'knowledge:stop':               z.tuple([id]),
  // 马 = agent。ceiling 是闭集，绝不接受任意字符串——权限只能被明确写入。
  'horses:list':                  z.tuple([]),
  // 可装配的工具池。与马无关，读的是当前注册表。
  // 叫 agentTools 不叫 tools：preload 里 `tools` 早就被 shell/PDF 那组占了
  // （openExternal / pickPdf / pdf2md），同名会变成一个静默覆盖的重复键。
  'agentTools:list':              z.tuple([]),
  'horses:create':                z.tuple([z.string().min(1).max(40), z.string().min(1).max(60), z.enum(['read', 'write-library', 'write-fs', 'destructive']), toolNames.optional()]),
  'horses:update':                z.tuple([z.string().min(1).max(64), z.object({ name: z.string().min(1).max(40).optional(), skin: z.string().min(1).max(60).optional(), ceiling: z.enum(['read', 'write-library', 'write-fs', 'destructive']).optional(), tools: toolNames.optional() })]),
  'horses:setDefault':            z.tuple([z.string().min(1).max(64)]),
  'horses:remove':                z.tuple([z.string().min(1).max(64)]),
  // 审批决定：id 是主进程生成的 uuid，决定是三选一的闭集。
  'knowledge:resolveApproval':    z.tuple([z.string().min(1).max(64), z.enum(['allow-once', 'allow-session', 'deny'])]),
  'knowledge:regenerate':         z.tuple([id]),
  'knowledge:editResend':         z.tuple([id, z.string().min(1).max(4000), z.array(knowledgeRef).max(5).optional(), z.string().min(1).max(64).optional()]),
  'knowledge:listConversations':  z.tuple([]),
  'knowledge:getMessages':        z.tuple([id]),
  'knowledge:getChunk':           z.tuple([z.string().min(1), z.number().int().nonnegative()]),
  'knowledge:deleteConversation': z.tuple([id]),
  'knowledge:rebuildIndex':       z.tuple([]),
  'knowledge:indexStatus':        z.tuple([]),
  'knowledge:pickStoragePath':    z.tuple([]),
  'knowledge:testProvider':       z.tuple([z.enum(['chat', 'embedding'])]),

  // Notes: standalone / per-item notes with [[wikilink]] cross-references.
  'notes:listByItem':     z.tuple([id]),
  'notes:listStandalone': z.tuple([]),
  'notes:get':            z.tuple([id]),
  'notes:save':           z.tuple([z.object({ id: id.optional(), itemId: id.nullable().optional(), title: z.string().max(300).nullable().optional(), content: z.string().max(200000).nullable().optional() })]),
  'notes:delete':         z.tuple([id]),
  'notes:backlinks':      z.tuple([z.enum(['item', 'note']), id]),
  'notes:resolveTitle':   z.tuple([z.string().max(300)]),

  // Skills: reusable instruction blocks (SKILL.md, no code execution) the
  // chat agent can load on demand -- see src/main/knowledge/skills.ts.
  'skills:list':              z.tuple([]),
  'skills:installFromGithub': z.tuple([z.string().url().max(2048)]),
  'skills:installFromZip':    z.tuple([]),   // opens its own native file picker
  'skills:uninstall':         z.tuple([z.string().min(1).max(64)]),
} as const

export type IpcChannel = keyof typeof contract
export type KnowledgeRef = z.infer<typeof knowledgeRef>
