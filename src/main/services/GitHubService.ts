// GitHub connectivity for the git sync backend. The PAT is strictly
// per-device: stored via SettingsService (safeStorage-encrypted, same path
// as the MinerU API token), never written to the control plane -- each
// collaborator brings their own token with whatever repo access the
// workspace owner granted them on GitHub itself (see design.tex §5.2).
import { getSetting, setSetting } from './SettingsService'
import { emit } from '../core/Notifier'

const TOKEN_KEY = 'github.oauthToken'

const API_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Veridian',
})

/** The single credential accessor. Everything downstream (git onAuth, API
 *  calls, commit author) reads the current token from here. */
export function getGitHubToken(): string {
  const v = getSetting(TOKEN_KEY)
  return typeof v === 'string' ? v : ''
}

export function setGitHubToken(token: string): void {
  setSetting(TOKEN_KEY, token)
  emit({ type: 'github.authChanged' })
}

export function clearGitHubToken(): void {
  setSetting(TOKEN_KEY, '')
  emit({ type: 'github.authChanged' })
}

export interface GitHubStatus {
  authed: boolean
  login: string | null
  avatarUrl: string | null
  error: string | null
}

export async function getStatus(): Promise<GitHubStatus> {
  const token = getGitHubToken()
  if (!token) return { authed: false, login: null, avatarUrl: null, error: null }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { authed: false, login: null, avatarUrl: null, error: `GitHub HTTP ${res.status}` }
    const user = (await res.json()) as { login?: string; avatar_url?: string }
    return { authed: true, login: user.login ?? null, avatarUrl: user.avatar_url ?? null, error: null }
  } catch (err) {
    return { authed: false, login: null, avatarUrl: null, error: (err as Error).message }
  }
}

/**
 * Repositories the stored PAT can reach (owned + collaborator + org),
 * newest-activity first -- feeds the "connect a collaborative repo" picker.
 * Fine-grained PATs only ever see the repos they were scoped to, so this
 * list is usually short and exact.
 */
export async function listRepos(): Promise<import('../../shared/types').GitHubRepoInfo[]> {
  const token = getGitHubToken()
  if (!token) throw new Error('no_pat')
  const res = await fetch(
    'https://api.github.com/user/repos?per_page=100&sort=updated',
    { headers: API_HEADERS(token), signal: AbortSignal.timeout(15_000) }
  )
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  const repos = (await res.json()) as Array<{
    name: string
    full_name: string
    private: boolean
    owner: { login: string }
    permissions?: { push?: boolean }
  }>
  return repos.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    push: !!r.permissions?.push,
  }))
}

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i
  )
  return m ? { owner: m[1], repo: m[2] } : null
}

export interface RepoAccessResult {
  ok: boolean
  // Stable codes the renderer translates; raw HTTP details pass through as-is.
  code: 'ok_write' | 'ok_read' | 'no_pat' | 'invalid_url' | 'not_found' | 'http_error' | 'network'
  detail?: string
}

/**
 * Verifies the stored PAT can reach the given repo, and whether it has push
 * (write) access -- editors need write, viewers only read. 404 covers both
 * "doesn't exist" and "no permission": GitHub deliberately doesn't reveal
 * which, and neither do we.
 */
export async function testRepoAccess(repoUrl: string): Promise<RepoAccessResult> {
  const token = getGitHubToken()
  if (!token) return { ok: false, code: 'no_pat' }

  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) return { ok: false, code: 'invalid_url' }

  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 404) return { ok: false, code: 'not_found' }
    if (!res.ok) return { ok: false, code: 'http_error', detail: `HTTP ${res.status}` }
    const repo = (await res.json()) as { permissions?: { push?: boolean } }
    return repo.permissions?.push
      ? { ok: true, code: 'ok_write' }
      : { ok: true, code: 'ok_read' }
  } catch (err) {
    return { ok: false, code: 'network', detail: (err as Error).message }
  }
}

export interface Invitation {
  id: number
  repoOwner: string
  repoName: string
  repoFullName: string
  inviterLogin: string
}

export type InviteResult =
  | { ok: true; alreadyCollaborator: boolean }
  | { ok: false; code: 'not_found' | 'forbidden' | 'http_error' | 'network'; detail?: string }

/**
 * Invites a GitHub user as a collaborator with write access. 201 = invitation
 * sent; 204 = already a collaborator (treated as success, no invite needed).
 * 404 covers both "user doesn't exist" and "repo not accessible" -- GitHub
 * deliberately doesn't reveal which, matching testRepoAccess's convention.
 */
export async function inviteCollaborator(owner: string, repo: string, username: string): Promise<InviteResult> {
  const token = getGitHubToken()
  if (!token) return { ok: false, code: 'not_found' }
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`, {
      method: 'PUT',
      headers: { ...API_HEADERS(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission: 'push' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 201) return { ok: true, alreadyCollaborator: false }
    if (res.status === 204) return { ok: true, alreadyCollaborator: true }
    if (res.status === 404) return { ok: false, code: 'not_found' }
    if (res.status === 403) return { ok: false, code: 'forbidden' }
    return { ok: false, code: 'http_error', detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, code: 'network', detail: (err as Error).message }
  }
}

/** Pending repository invitations for the current user (accept/decline elsewhere). */
export async function listInvitations(): Promise<Invitation[]> {
  const token = getGitHubToken()
  if (!token) return []
  const res = await fetch('https://api.github.com/user/repository_invitations', {
    headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return []
  const raw = (await res.json()) as Array<{
    id: number
    repository: { name: string; full_name: string; owner: { login: string } }
    inviter: { login: string } | null
  }>
  return raw.map((r) => ({
    id: r.id,
    repoOwner: r.repository.owner.login,
    repoName: r.repository.name,
    repoFullName: r.repository.full_name,
    inviterLogin: r.inviter?.login ?? 'unknown',
  }))
}

export async function acceptInvitation(id: number): Promise<void> {
  const token = getGitHubToken()
  if (!token) throw new Error('no_auth')
  const res = await fetch(`https://api.github.com/user/repository_invitations/${id}`, {
    method: 'PATCH', headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
}

export async function declineInvitation(id: number): Promise<void> {
  const token = getGitHubToken()
  if (!token) throw new Error('no_auth')
  const res = await fetch(`https://api.github.com/user/repository_invitations/${id}`, {
    method: 'DELETE', headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
}
