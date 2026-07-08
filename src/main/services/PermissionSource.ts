// Role lookups against the control plane. Poll-based, not push-based -- the
// self-hosted stack deliberately omits Supabase's Realtime service (see
// control-plane-selfhost.tex §4), so membership/role changes propagate on
// the cadence callers choose to refresh() at (app launch, before every sync
// push/pull, manual refresh button), not instantly.
import type { MemberRole } from '../../shared/types'
import { getClient } from './ControlPlaneClient'

export interface PermissionSource {
  /** null = not a member of this workspace at all. */
  getRole(workspaceId: string): Promise<MemberRole | null>
  refresh(): Promise<void>
}

// Cache of workspace_id -> role for the current session, repopulated by refresh().
let roleCache = new Map<string, MemberRole>()
let lastRefreshed = 0

export const supabasePermissionSource: PermissionSource = {
  async getRole(workspaceId) {
    // Refresh lazily if the cache has never been populated or is stale
    // (older than 5 minutes) -- cheap safety net between explicit refresh()
    // calls from WorkspaceService/SyncEngine call sites.
    if (roleCache.size === 0 || Date.now() - lastRefreshed > 5 * 60_000) {
      await this.refresh()
    }
    return roleCache.get(workspaceId) ?? null
  },

  async refresh() {
    const client = getClient()
    if (!client) { roleCache = new Map(); return }

    const { data: userData } = await client.auth.getUser()
    if (!userData?.user) { roleCache = new Map(); return }

    const { data, error } = await client
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('user_id', userData.user.id)

    if (error) {
      console.warn('[PermissionSource] refresh failed:', error.message)
      return
    }

    const next = new Map<string, MemberRole>()
    for (const row of data ?? []) next.set(row.workspace_id, row.role as MemberRole)
    roleCache = next
    lastRefreshed = Date.now()
  },
}
