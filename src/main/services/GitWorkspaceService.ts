// Thin git layer for github-kind workspaces, via isomorphic-git (pure JS --
// no system git required on the user's machine). Single responsibility:
// bytes in/out of the repository. It knows nothing about item.json layout
// (WorkspaceFiles.ts) or when to sync (WorkspaceSyncService.ts).
//
// Every stage writes a breadcrumb to <workspace dir>/sync.log (one level
// above the repo, so it's never committed) -- if the process dies hard
// (native abort / OOM leaves no JS stack), the last line on disk pinpoints
// the stage that killed it.
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import * as fs from 'fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getPat, getStatus } from './GitHubService'

function breadcrumb(dir: string, msg: string): void {
  console.log(`[git] ${msg}`)
  try {
    appendFileSync(join(dir, '..', 'sync.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch { /* logging must never throw */ }
}

function onAuth(): { username: string; password: string } {
  const pat = getPat()
  if (!pat) throw new Error('no_pat')
  // GitHub accepts a PAT over basic auth with this fixed username
  return { username: 'x-access-token', password: pat }
}

// Author identity is cached after one lookup -- the commit path must not
// depend on a live network call (it used to fetch /user on EVERY commit).
let cachedAuthor: { name: string; email: string } | null = null

async function author(): Promise<{ name: string; email: string }> {
  if (cachedAuthor) return cachedAuthor
  const status = await getStatus().catch(() => null)
  const login = status?.login ?? 'veridian'
  cachedAuthor = { name: login, email: `${login}@users.noreply.github.com` }
  return cachedAuthor
}

function repoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`
}

/**
 * Ensure a local clone exists at `dir`. Full clone on purpose: shallow
 * (depth-limited) repositories are a known trouble spot for isomorphic-git's
 * push/pull object walks, and literature repos are small. A clone of a
 * completely empty repository (just created on GitHub, no commits) fails
 * with NoRefSpec-style errors -- fall back to init + addRemote so the first
 * sync's push creates the initial branch.
 */
export async function ensureClone(dir: string, owner: string, repo: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) return
  mkdirSync(dir, { recursive: true })
  breadcrumb(dir, `clone start ${owner}/${repo}`)
  try {
    await git.clone({
      fs, http, dir,
      url: repoUrl(owner, repo),
      singleBranch: true,
      onAuth,
    })
    breadcrumb(dir, 'clone done')
  } catch (err) {
    breadcrumb(dir, `clone failed (${(err as Error).message}), init fallback`)
    await git.init({ fs, dir, defaultBranch: 'main' })
    await git.addRemote({ fs, dir, remote: 'origin', url: repoUrl(owner, repo), force: true })
    breadcrumb(dir, 'init fallback done')
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
  breadcrumb(dir, 'statusMatrix start')
  const matrix = await git.statusMatrix({ fs, dir })
  breadcrumb(dir, `statusMatrix done (${matrix.length} entries)`)
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
  if (!dirty) { breadcrumb(dir, 'commit skipped (clean)'); return false }
  breadcrumb(dir, 'commit start')
  const sha = await git.commit({ fs, dir, message, author: await author() })
  breadcrumb(dir, `commit done ${sha.slice(0, 8)}`)
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

  breadcrumb(dir, `pull start (${branch})`)
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
    breadcrumb(dir, `pull done (pulled=${pulled})`)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    breadcrumb(dir, `pull failed: ${msg}`)
    // A repo with no remote branch yet (init fallback for an empty repo, or
    // remote deleted) has nothing to pull -- proceed straight to push.
    if (!/could not find|no merge base|NotFoundError/i.test(msg)) throw err
  }

  breadcrumb(dir, 'push start')
  await git.push({ fs, http, dir, remote: 'origin', ref: branch, onAuth })
  breadcrumb(dir, 'push done')
  return { pulled }
}
