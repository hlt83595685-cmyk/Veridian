// Single write path for everything workspace-related. Unlike the local
// SQLite-backed services (ItemService, TagService, ...), writes here go to
// the remote control plane (see control-plane/schema.sql) via
// ControlPlaneClient -- but the discipline is identical: every mutation ends
// with an emit() so the renderer refreshes through the same domain-event
// stream, never a manual reload.
import type {
  Workspace, WorkspaceMember, WorkspaceInvite, MemberRole, WorkspaceKind,
  SyncBackendType, ControlPlaneStatus,
} from '../../shared/types'
import * as ControlPlane from './ControlPlaneClient'
import { supabasePermissionSource } from './PermissionSource'
import { emit } from '../core/Notifier'

function requireClient() {
  return ControlPlane.requireClient()
}

// ── Control plane connection + auth ──────────────────────────────────────────

export function configureControlPlane(url: string, anonKey: string): void {
  ControlPlane.configure(url, anonKey)
}

export async function getControlPlaneStatus(): Promise<ControlPlaneStatus> {
  const configured = ControlPlane.isConfigured()
  if (!configured) return { configured: false, signedIn: false, email: null }

  const client = ControlPlane.getClient()
  if (!client) return { configured: true, signedIn: false, email: null }

  const { data } = await client.auth.getUser()
  return { configured: true, signedIn: !!data?.user, email: data?.user?.email ?? null }
}

export async function signIn(email: string, password: string): Promise<{ error: string | null }> {
  const client = requireClient()
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) return { error: error.message }
  await supabasePermissionSource.refresh()
  emit({ type: 'controlPlane.changed' })
  return { error: null }
}

/**
 * Only succeeds while the control plane has GOTRUE_DISABLE_SIGNUP=false (the
 * default -- see control-plane/docker-compose.yml). A freshly signed-up
 * account can see and do nothing until someone invites it to a workspace, so
 * open signup is a convenience for testing/onboarding, not a security hole.
 * In the hardened mode (signup disabled), this call fails and accounts must
 * be created by the admin via control-plane/scripts/invite-user.mjs instead.
 */
export async function signUp(email: string, password: string): Promise<{ error: string | null }> {
  const client = requireClient()
  const { error } = await client.auth.signUp({ email, password })
  if (error) return { error: error.message }
  emit({ type: 'controlPlane.changed' })
  return { error: null }
}

export async function signOut(): Promise<void> {
  const client = ControlPlane.getClient()
  if (client) await client.auth.signOut()
  emit({ type: 'controlPlane.changed' })
}

// ── Workspaces ────────────────────────────────────────────────────────────────

export async function listWorkspaces(): Promise<Workspace[]> {
  const client = requireClient()
  const { data: userData } = await client.auth.getUser()
  if (!userData?.user) return []

  const { data, error } = await client
    .from('workspace_members')
    .select('role, workspaces(*)')
    .eq('user_id', userData.user.id)

  if (error) throw new Error(error.message)

  return (data ?? [])
    .filter((row) => row.workspaces)
    .map((row) => ({ ...(row.workspaces as unknown as Workspace), my_role: row.role as MemberRole }))
}

export async function createWorkspace(
  name: string,
  kind: WorkspaceKind,
  syncBackendType: SyncBackendType,
  syncBackendConfig: Record<string, unknown>
): Promise<Workspace> {
  const client = requireClient()
  const { data: userData } = await client.auth.getUser()
  if (!userData?.user) throw new Error('Not signed in')

  const { data: ws, error } = await client
    .from('workspaces')
    .insert({
      name, kind, owner_id: userData.user.id,
      sync_backend_type: syncBackendType, sync_backend_config: syncBackendConfig,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)

  const { error: memberError } = await client
    .from('workspace_members')
    .insert({ workspace_id: ws.id, user_id: userData.user.id, role: 'owner' as MemberRole })
  if (memberError) throw new Error(memberError.message)

  await supabasePermissionSource.refresh()
  emit({ type: 'workspace.changed', ids: [ws.id] })
  return { ...(ws as Workspace), my_role: 'owner' }
}

// ── Members ───────────────────────────────────────────────────────────────────

export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('workspace_members')
    .select('workspace_id, user_id, role, joined_at, profiles(email)')
    .eq('workspace_id', workspaceId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(error.message)

  return (data ?? []).map((row) => ({
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    role: row.role as MemberRole,
    joined_at: row.joined_at,
    email: (row.profiles as unknown as { email: string } | null)?.email,
  }))
}

export async function updateMemberRole(
  workspaceId: string, userId: string, role: MemberRole
): Promise<void> {
  const client = requireClient()
  const { error } = await client
    .from('workspace_members')
    .update({ role })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  emit({ type: 'workspace.changed', ids: [workspaceId] })
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  const client = requireClient()
  const { error } = await client
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  emit({ type: 'workspace.changed', ids: [workspaceId] })
}

// ── Invites ───────────────────────────────────────────────────────────────────

export async function inviteMember(
  workspaceId: string, email: string, role: MemberRole
): Promise<WorkspaceInvite> {
  const client = requireClient()
  const { data, error } = await client
    .from('invites')
    .insert({ workspace_id: workspaceId, email, role })
    .select()
    .single()
  if (error) throw new Error(error.message)
  emit({ type: 'workspace.changed', ids: [workspaceId] })
  return data as WorkspaceInvite
}

export async function listInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
  const client = requireClient()
  const { data, error } = await client
    .from('invites')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as WorkspaceInvite[]
}

export async function revokeInvite(inviteId: string): Promise<void> {
  const client = requireClient()
  const { error } = await client.from('invites').update({ status: 'revoked' }).eq('id', inviteId)
  if (error) throw new Error(error.message)
  emit({ type: 'workspace.changed', ids: [] })
}

/**
 * Accepting an invite requires the invitee to already be signed in with an
 * account whose email matches the invite. The actual validate+insert-member+
 * mark-accepted sequence runs atomically server-side via the
 * accept_workspace_invite() Postgres function (control-plane/schema.sql) --
 * a plain client-side multi-step version doesn't work here: the invitee
 * isn't a member yet, so the ordinary members_write RLS policy (which
 * requires already being an owner/admin member) would reject their own
 * insert, and there is no safe way to let a client-side UPDATE flip just the
 * `status` column on invites without RLS also having to trust the rest of
 * the row (role, workspace_id) unchanged.
 */
export async function acceptInvite(token: string): Promise<Workspace> {
  const client = requireClient()
  const { data: userData } = await client.auth.getUser()
  if (!userData?.user) throw new Error('Sign in first, using the email the invite was sent to')

  const { data, error } = await client.rpc('accept_workspace_invite', { p_token: token })
  if (error) throw new Error(error.message)

  await supabasePermissionSource.refresh()
  emit({ type: 'workspace.changed', ids: [(data as Workspace).id] })
  return data as Workspace
}
