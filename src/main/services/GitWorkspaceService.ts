// Thin git layer for github-kind workspaces, via isomorphic-git (pure JS --
// no system git required on the user's machine). Single responsibility:
// bytes in/out of the repository. It knows nothing about item.json layout
// (WorkspaceFiles.ts) or when to sync (WorkspaceSyncService.ts).
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import * as fs from 'fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getPat, getStatus } from './GitHubService'

function onAuth(): { username: string; password: string } {
  const pat = getPat()
  if (!pat) throw new Error('no_pat')
  // GitHub accepts a PAT over basic auth with this fixed username
  return { username: 'x-access-token', password: pat }
}

async function author(): Promise<{ name: string; email: string }> {
  const status = await getStatus().catch(() => null)
  const login = status?.login ?? 'veridian'
  return { name: login, email: `${login}@users.noreply.github.com` }
}

function repoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`
}

/**
 * Ensure a local clone exists at `dir`. A clone of a completely empty
 * repository (just created on GitHub, no commits) fails with NoRefSpec-style
 * errors -- fall back to init + addRemote so the first sync's push creates
 * the initial branch.
 */
export async function ensureClone(dir: string, owner: string, repo: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) return
  mkdirSync(dir, { recursive: true })
  try {
    await git.clone({
      fs, http, dir,
      url: repoUrl(owner, repo),
      singleBranch: true,
      depth: 50,
      onAuth,
    })
  } catch (err) {
    console.warn('[git] clone failed (likely empty repo), falling back to init:', (err as Error).message)
    await git.init({ fs, dir, defaultBranch: 'main' })
    await git.addRemote({ fs, dir, remote: 'origin', url: repoUrl(owner, repo), force: true })
  }
}

async function currentBranch(dir: string): Promise<string> {
  return (await git.currentBranch({ fs, dir, fullname: false })) ?? 'main'
}

/**
 * Stage everything (adds, modifications, deletions) and commit if there is
 * anything to commit. Returns true if a commit was created.
 */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  const matrix = await git.statusMatrix({ fs, dir })
  let dirty = false
  for (const [filepath, head, workdir] of matrix) {
    if (head === 1 && workdir === 0) {
      await git.remove({ fs, dir, filepath })
      dirty = true
    } else if (head !== workdir || workdir === 2) {
      await git.add({ fs, dir, filepath })
      dirty = true
    }
  }
  if (!dirty) return false
  await git.commit({ fs, dir, message, author: await author() })
  return true
}

/**
 * Pull remote changes (fetch + merge, fast-forward when possible), then push
 * local commits. Returns whether the working tree may have changed (so the
 * caller knows to re-import). Merge conflicts throw -- v1 policy is to
 * surface them rather than silently pick a side; per-item JSON files make
 * them rare (two people editing the SAME reference while offline).
 */
export async function sync(dir: string): Promise<{ pulled: boolean }> {
  const branch = await currentBranch(dir)
  let pulled = false

  const before = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null)

  try {
    await git.pull({
      fs, http, dir,
      ref: branch,
      singleBranch: true,
      author: await author(),
      onAuth,
    })
    const after = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null)
    pulled = before !== after
  } catch (err) {
    const msg = (err as Error).message ?? ''
    // A repo with no remote branch yet (init fallback for an empty repo, or
    // remote deleted) has nothing to pull -- proceed straight to push.
    if (!/could not find|no merge base|NotFoundError/i.test(msg)) throw err
  }

  await git.push({ fs, http, dir, remote: 'origin', ref: branch, onAuth })
  return { pulled }
}
