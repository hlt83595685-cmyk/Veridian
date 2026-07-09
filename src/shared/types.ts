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
  tags?: string[]  // populated by getAllItemsWithTags
}

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

export interface Tag {
  id: number
  name: string
}

export interface Attachment {
  id: number
  item_id: number
  type: 'pdf' | 'link' | 'other'
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
