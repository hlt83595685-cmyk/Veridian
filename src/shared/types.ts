export interface Item {
  id: number
  key: string
  type: string
  title: string | null
  abstract: string | null
  year: number | null
  doi: string | null
  url: string | null
  journal: string | null
  publisher: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  isbn: string | null
  language: string | null
  extra: string | null
  deleted: number
  library_id: number
  created_at: number
  updated_at: number
  version: number
  added_by: string | null
  conversion_failed: number
  starred: number  // local-only "important" mark (0/1)
  tags?: string[]  // populated by getAllItemsWithTags
}

// Result of a manual "check for updates" (About panel). Reuses electron-updater
// under the hood; 'available' means a newer release exists and is now
// downloading (the existing update-downloaded prompt handles install).
export type UpdateCheckResult =
  | { status: 'dev' }
  | { status: 'not-available'; version: string }
  | { status: 'available'; version: string }
  | { status: 'error'; message: string }

export type ItemType =
  | 'journalArticle'
  | 'book'
  | 'bookSection'
  | 'thesis'
  | 'conferencePaper'
  | 'report'
  | 'webpage'
  | 'preprint'

export const ITEM_TYPE_LABELS: Record<ItemType, { zh: string; en: string }> = {
  journalArticle: { zh: '期刊论文', en: 'Journal Article' },
  book:           { zh: '书籍',     en: 'Book' },
  bookSection:    { zh: '书章节',   en: 'Book Section' },
  thesis:         { zh: '学位论文', en: 'Thesis' },
  conferencePaper:{ zh: '会议论文', en: 'Conference Paper' },
  report:         { zh: '报告',     en: 'Report' },
  webpage:        { zh: '网页',     en: 'Webpage' },
  preprint:       { zh: '预印本',   en: 'Preprint' },
}

export interface Creator {
  id?: number
  first_name: string | null
  last_name: string
  orcid?: string | null
  role: 'author' | 'editor' | 'translator'
  position: number
}

export interface Collection {
  id: number
  library_id: number
  parent_id: number | null
  name: string
  key: string
}

// AI-chat search-scope sentinel: a reserved (negative, never a real collection
// id) value meaning "only important-marked (starred) papers". Whole library is
// null; a positive value is a real collection id.
export const IMPORTANT_SCOPE = -1

export interface Tag {
  id: number
  name: string
}

export interface Attachment {
  id: number
  item_id: number
  type: 'pdf' | 'link' | 'other' | 'imagedir' | 'markdown'
  filename: string | null
  path: string | null
  url: string | null
  mime_type: string | null
  size: number | null
}

export interface ImportResult {
  canceled: boolean
  imported: number
}

// ── Local workspaces ──────────────────────────────────────────────────────────
// Workspaces are a local-first concept: rows in the local SQLite database,
// optionally bound to a GitHub repository (identity/permissions for shared
// workspaces are GitHub's own PAT + repo-collaborator model -- no separate
// account system). 'local' = private, this machine only.

export type LocalWorkspaceKind = 'local' | 'github'

export interface LocalWorkspace {
  id: number
  name: string
  kind: LocalWorkspaceKind
  repo_owner: string | null
  repo_name: string | null
  /** User-chosen storage root for the clone + index; null = app default. */
  local_path: string | null
  created_at: number
}

export interface RepoTreeNode {
  name: string
  /** Absolute path on this machine (inside the workspace clone). */
  absPath: string
  isDir: boolean
  children?: RepoTreeNode[]
}

export interface GitHubRepoInfo {
  owner: string
  name: string
  full_name: string
  private: boolean
  push: boolean
}

// ── Workspace / control-plane types (dormant) ─────────────────────────────────
// Retained for a possible future cloud-account mode (startup sign-in etc.);
// the active workspace flow no longer uses the self-hosted control plane.
// See readme/workspace-sync/design.tex for the full architecture. These
// mirror control-plane/schema.sql's tables; ids are Postgres uuids (strings),
// not the local SQLite integer ids used by Item/Collection/etc.

export type WorkspaceKind = 'private' | 'shared'
export type MemberRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type SyncBackendType = 'git' | 'cloud_folder'
export type InviteStatus = 'pending' | 'accepted' | 'revoked'

export interface Workspace {
  id: string
  name: string
  kind: WorkspaceKind
  owner_id: string
  sync_backend_type: SyncBackendType
  sync_backend_config: Record<string, unknown>
  created_at: string
  /** The current user's role in this workspace, joined in by WorkspaceService. */
  my_role?: MemberRole
}

export interface WorkspaceMember {
  workspace_id: string
  user_id: string
  role: MemberRole
  joined_at: string
  /** Populated by WorkspaceService from the auth admin API for display. */
  email?: string
}

export interface WorkspaceInvite {
  id: string
  workspace_id: string
  email: string
  role: MemberRole
  status: InviteStatus
  /**
   * The one-time acceptance code. There is no automatic email for this
   * custom workspace-level invite (unlike GoTrue's own account-invite
   * emails) -- the inviter must relay this out-of-band (Settings/Members UI
   * shows a copy button).
   */
  token: string
  expires_at: string
  created_at: string
}

export interface ControlPlaneStatus {
  configured: boolean
  signedIn: boolean
  email: string | null
}

// What a tool does to the user's data. Deliberately a small closed set while
// tool *names* stay open: plugins register arbitrary tools, so the renderer can
// never switch on the name without breaking the moment someone adds one. The
// kind is also the thing the user actually needs to see at a glance -- "it read
// something" vs "it changed my library" vs "it wrote to disk".
export type ToolKind = 'read' | 'write-library' | 'write-fs' | 'destructive'

// One tool invocation during a turn, shown as a card in the transcript.
// `ok === undefined` means still running.
export interface ToolCallRecord {
  id: string
  name: string
  kind: ToolKind
  args: string      // raw JSON exactly as the model emitted it
  result?: string   // raw tool output, untouched
  ok?: boolean
  durationMs?: number
}

// What the model was actually handed on the final round of a turn. Answers
// "did it still have the start of our conversation?" and "how much of my paper
// fit?" by looking, instead of asking the model and trusting the answer.
//
// Token counts are an approximation (chars/4) used for budgeting decisions;
// they are labelled as approximate wherever shown.
export interface ContextReport {
  contextWindow: number
  reserveForOutput: number
  fixedTokens: number        // system prompt + tool schemas -- never evicted
  attachmentTokens: number
  historyTokens: number
  usedTokens: number
  messageCount: number
  droppedTurns: number       // oldest turns evicted to fit
  truncatedAttachments: number
}

// ── Horses ──────────────────────────────────────────────────────────────────
// A horse is an agent. What distinguishes one from another is deliberately
// small for now: a name, an appearance, and a ceiling on what it is allowed to
// do. Role is not a field -- a read-only horse with good retrieval *is* a
// scout, without anyone declaring it one.
//
// Model configuration is still global. Giving every horse its own provider
// would scatter API keys across rows for a case nobody has yet; when there is a
// reason, it lands as an override rather than a duplicate.

/**
 * 注册表里的一个工具，供装配界面列出可选项。
 *
 * 这是**池子**——插件注册了什么就有什么，与任何一匹马无关。哪匹马能用其中哪些，
 * 由 `Horse.tools` 决定。
 */
/**
 * 执行轨迹里的一条。
 *
 * 展示的是**实际发生的事**——检索、读文件、工具调用、阶段说明——不是模型的内部
 * 推理。所以叫 trace 不叫 thinking。
 *
 * `note` 是模型在调工具之前吐的那段话。它一直存在，只是过去被当成「中间思考」
 * 直接丢掉了；而那恰恰是整条轨迹里最可读的部分。
 */
export type TraceEntry =
	| {
		kind: 'note'
		text: string
		/** 第几轮。第 0 轮说的是「打算做什么」，之后各轮说的是「发现了什么」——
		 *  界面按这个分层级，而不是去猜文本的语气。 */
		round: number
	}
	| { kind: 'tool'; call: ToolCallRecord }

/** 一次回合的完整轨迹，连同耗时——重开会话时要照原样还原。 */
export interface TurnTrace {
	entries: TraceEntry[]
	elapsedMs: number
}

export interface ToolInfo {
	name: string
	description: string
	/** 决定它要不要审批、会不会被 ceiling 拦住。 */
	kind: ToolKind
}

export interface Horse {
  id: string
  name: string
  /** Sprite id from assets/horse-sprites, e.g. 'bay'. */
  skin: string
  /** The most dangerous tool kind this horse may use. Its real power is
   *  min(this, the conversation's ceiling). */
  ceiling: ToolKind
  /**
   * Names of the tools this horse is equipped with — an allow-list, not a
   * description of what exists. Plugins decide what tools the app has at all;
   * this decides which of them one horse can see.
   *
   * Whitelist by default: a tool that appears later is never ticked
   * automatically, for any horse. Otherwise installing one plugin would
   * quietly make every horse more capable, and equipping would stop meaning
   * anything.
   *
   * Orthogonal to `ceiling`: a horse can be equipped with a tool it is not
   * allowed to run (equipped, but capped) — the equip screen shows that as a
   * blocked stage rather than hiding the tool.
   */
  tools: string[]
  /** Exactly one horse is the default: the one that answers unless told
   *  otherwise. Enforced by the store, not by the schema. */
  isDefault: boolean
  createdAt: number
}

export const HORSE_NAME_MAX = 40

// ── Approval ────────────────────────────────────────────────────────────────
// The gate every write passes through. A tool that changes the library, writes
// a file, or deletes something never acts on the model's say-so alone; it
// parks and asks, and what it is asking for has to be legible without reading
// the raw arguments.

export type ApprovalDecision =
  | 'allow-once'
  /** Allow this tool kind for the rest of this conversation. */
  | 'allow-session'
  | 'deny'

/** One concrete change, shown as a before/after so approving is not an act of
 *  faith. Bulk requests carry a sample rather than thousands of these. */
export type ApprovalChange =
  | {
      type: 'field'
      itemKey: string
      title: string
      field: string
      before: string | null
      after: string | null
    }
  | {
      type: 'file'
      path: string
      op: 'create' | 'modify' | 'delete'
      bytesBefore?: number
      bytesAfter?: number
    }

export interface ApprovalRequest {
  id: string
  conversationId: number
  /** Which tool wants to act, and how dangerous its category is. */
  tool: string
  kind: ToolKind
  /** One line the user can act on without expanding anything. */
  summary: string
  /** How many records/files this touches. The number that decides whether an
   *  approval is a real check or a rubber stamp. */
  affected: number
  /** Up to SAMPLE_LIMIT of the changes; `affected` is the true count. */
  changes: ApprovalChange[]
  /** Raw tool arguments, available on expand. */
  args: string
}

/** Above this many affected records, a normal approval card would be a
 *  rubber stamp -- twenty is about as many as anyone actually reads -- so the
 *  request is re-framed around the count instead. */
export const BLAST_RADIUS_LIMIT = 20

export type AttachmentFailureReason =
  | 'not_found'
  | 'not_converted'
  | 'permission_denied'
  | 'unreadable'

// What actually happened to one @-mentioned paper on its way into the model's
// context. Shown on the chip in the sent message, so "did it read my paper?"
// is answered by looking, not by asking the model and trusting the answer.
export interface AttachmentStatus {
  key: string     // itemKey for library items, path for files -- matches the chip's ref
  title: string
  ok: boolean
  reason?: AttachmentFailureReason  // set iff !ok
  detail?: string                   // raw error text, surfaced on hover
  totalBytes: number                // size of the source markdown
  shownBytes: number                // how much of it fit in the budget
  truncated: boolean
}
