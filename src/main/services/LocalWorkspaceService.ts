// Local-first workspaces: rows in the local SQLite database, optionally
// bound to a GitHub repository. No control-plane account involved --
// identity and permissions for shared (github-kind) workspaces are GitHub's
// own PAT + repo-collaborator model; a collaborator "joins" a workspace by
// connecting the same repo from their own machine. Same single-write-path +
// domain-event discipline as every other local service.
import { getDb } from '../db'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'
import type { LocalWorkspace, LocalWorkspaceKind } from '../../shared/types'

export function listWorkspaces(): LocalWorkspace[] {
  return getDb()
    .prepare('SELECT * FROM workspaces ORDER BY created_at ASC')
    .all() as LocalWorkspace[]
}

export function createWorkspace(
  name: string,
  kind: LocalWorkspaceKind,
  repoOwner: string | null,
  repoName: string | null
): LocalWorkspace {
  if (kind === 'github' && (!repoOwner || !repoName)) {
    throw new Error('GitHub workspaces need a bound repository')
  }
  const db = getDb()
  const ws = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO workspaces (name, kind, repo_owner, repo_name)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), kind, kind === 'github' ? repoOwner : null, kind === 'github' ? repoName : null)
    const created = db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(info.lastInsertRowid) as LocalWorkspace
    appendOp('workspace', created.id, 'create', { name: created.name, kind })
    return created
  })()
  emit({ type: 'workspace.changed', ids: [String(ws.id)] })
  return ws
}

/**
 * Removes the workspace record only -- never touches the GitHub repository
 * or any literature data. Rebinding the same repo later recreates it.
 */
export function removeWorkspace(id: number): void {
  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    appendOp('workspace', id, 'delete')
  })()
  emit({ type: 'workspace.changed', ids: [String(id)] })
}
