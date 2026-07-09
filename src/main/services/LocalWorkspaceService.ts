// Local-first workspaces: rows in the local SQLite database, optionally
// bound to a GitHub repository. No control-plane account involved --
// identity and permissions for shared (github-kind) workspaces are GitHub's
// own PAT + repo-collaborator model; a collaborator "joins" a workspace by
// connecting the same repo from their own machine. Same single-write-path +
// domain-event discipline as every other local service.
import { getPersonalDb } from '../db'
import { emit } from '../core/Notifier'
import type { LocalWorkspace, LocalWorkspaceKind } from '../../shared/types'

// NOTE: the workspaces REGISTRY always lives in the personal database --
// getDb() would route to the currently-active workspace's index db, which
// must never hold the list of workspaces itself.

export function listWorkspaces(): LocalWorkspace[] {
  return getPersonalDb()
    .prepare('SELECT * FROM workspaces ORDER BY created_at ASC')
    .all() as LocalWorkspace[]
}

export function getWorkspace(id: number): LocalWorkspace | undefined {
  return getPersonalDb()
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(id) as LocalWorkspace | undefined
}

export function createWorkspace(
  name: string,
  kind: LocalWorkspaceKind,
  repoOwner: string | null,
  repoName: string | null,
  localPath: string | null
): LocalWorkspace {
  if (kind === 'github' && (!repoOwner || !repoName)) {
    throw new Error('GitHub workspaces need a bound repository')
  }
  const db = getPersonalDb()
  const info = db.prepare(`
    INSERT INTO workspaces (name, kind, repo_owner, repo_name, local_path)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), kind, kind === 'github' ? repoOwner : null, kind === 'github' ? repoName : null, localPath)
  const ws = db
    .prepare('SELECT * FROM workspaces WHERE id = ?')
    .get(info.lastInsertRowid) as LocalWorkspace
  emit({ type: 'workspace.changed', ids: [String(ws.id)] })
  return ws
}

/**
 * Removes the workspace record only -- never touches the GitHub repository
 * or any literature data. Rebinding the same repo later recreates it.
 */
export function removeWorkspace(id: number): void {
  getPersonalDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  emit({ type: 'workspace.changed', ids: [String(id)] })
}
