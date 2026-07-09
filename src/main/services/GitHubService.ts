// GitHub connectivity for the git sync backend. The PAT is strictly
// per-device: stored via SettingsService (safeStorage-encrypted, same path
// as the MinerU API token), never written to the control plane -- each
// collaborator brings their own token with whatever repo access the
// workspace owner granted them on GitHub itself (see design.tex §5.2).
import { getSetting, setSetting } from './SettingsService'
import { emit } from '../core/Notifier'

const PAT_KEY = 'github.pat'

const API_HEADERS = (pat: string): Record<string, string> => ({
  Authorization: `Bearer ${pat}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Veridian',   // required by the GitHub API
})

export function getPat(): string {
  const v = getSetting(PAT_KEY)
  return typeof v === 'string' ? v : ''
}

export function setPat(pat: string): void {
  setSetting(PAT_KEY, pat)
  emit({ type: 'settings.changed', keys: [PAT_KEY] })
}

export interface GitHubStatus {
  hasPat: boolean
  login: string | null
  error: string | null
}

/** Validates the stored PAT by asking GitHub who it belongs to. */
export async function getStatus(): Promise<GitHubStatus> {
  const pat = getPat()
  if (!pat) return { hasPat: false, login: null, error: null }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: API_HEADERS(pat), signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { hasPat: true, login: null, error: `GitHub HTTP ${res.status}` }
    const user = (await res.json()) as { login?: string }
    return { hasPat: true, login: user.login ?? null, error: null }
  } catch (err) {
    return { hasPat: true, login: null, error: (err as Error).message }
  }
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
  const pat = getPat()
  if (!pat) return { ok: false, code: 'no_pat' }

  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) return { ok: false, code: 'invalid_url' }

  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: API_HEADERS(pat), signal: AbortSignal.timeout(10_000),
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
