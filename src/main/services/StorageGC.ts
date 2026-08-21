// One-off maintenance that runs at startup, before any conversion is queued.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { basename, join, resolve } from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { getDb, getPersonalDb } from '../db'
import { getActiveWorkspace } from './WorkspaceContextService'
import { convertedDir, stagingRootDir } from './ConversionService'
import { isInside, moveInto } from './storagePaths'

/**
 * Libraries with no content root used to keep conversion output in the scratch
 * area permanently. Move those payloads into their real home so the scratch
 * area can be treated as scratch (and so the next conversion of an item with
 * the same id can't wipe them).
 */
export function migrateStagedPayloads(): number {
  if (getActiveWorkspace().repoRoot != null) return 0
  const db = getDb()
  const staging = stagingRootDir()
  const rows = db.prepare('SELECT id, item_id, path FROM attachments WHERE path IS NOT NULL')
    .all() as Array<{ id: number; item_id: number; path: string }>
  let moved = 0
  for (const r of rows) {
    if (!isInside(r.path, staging) || !existsSync(r.path)) continue
    const name = basename(r.path) === 'images' ? 'images' : (r.path.endsWith('.md') ? 'Full.md' : basename(r.path))
    const dest = join(convertedDir(r.item_id), name)
    if (!moveInto(r.path, dest)) continue
    db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?').run(dest, name, r.id)
    moved++
  }
  return moved
}

/**
 * MinerU leaves a full working set behind: a copy of the source PDF, page
 * layout coordinates, raw model output and content listings. Measured at 82%
 * of the scratch area on a real library, and nothing user-facing can be
 * recovered from any of it. Everything else -- notably `full.md` and
 * `images/` -- is the actual conversion product and is kept even when nothing
 * references it, because an unreferenced product is the sole remaining copy
 * of a deleted item's work and the only possible input for a future recovery
 * feature. Unknown names default to `product`: keep what we don't understand.
 */
export function classifyStagingFile(name: string): 'debris' | 'product' {
  const n = name.toLowerCase()
  if (n.endsWith('_origin.pdf')) return 'debris'
  if (n === 'layout.json') return 'debris'
  if (n.endsWith('_model.json')) return 'debris'
  if (n.includes('content_list')) return 'debris'
  return 'product'
}

/** Compare paths case- and form-insensitively (Windows). */
function norm(p: string): string {
  return resolve(p).toLowerCase()
}

/** Every attachment path, plus md5 -> the paths that carry it, across the
 *  personal library and every registered workspace index. Returns null if any
 *  database can't be read -- callers must then do nothing at all. */
function collectRoots(): { paths: Set<string>; byMd5: Map<string, string[]> } | null {
  const paths = new Set<string>()
  const byMd5 = new Map<string, string[]>()
  const add = (db: Database.Database): void => {
    for (const r of db.prepare('SELECT path, md5 FROM attachments').all() as Array<{ path: string | null; md5: string | null }>) {
      if (r.path) paths.add(norm(r.path))
      if (r.md5 && r.path) {
        const list = byMd5.get(r.md5) ?? []
        list.push(r.path)
        byMd5.set(r.md5, list)
      }
    }
  }
  try {
    const personal = getPersonalDb()
    add(personal)
    const ids = personal.prepare('SELECT id, local_path FROM workspaces').all() as Array<{ id: number; local_path: string | null }>
    for (const w of ids) {
      const base = w.local_path && w.local_path.trim()
        ? w.local_path
        : join(app.getPath('userData'), 'workspaces', String(w.id))
      const idx = join(base, 'index.db')
      if (!existsSync(idx)) continue
      const wdb = new DatabaseCtor(idx, { readonly: true })
      try { add(wdb) } finally { wdb.close() }
    }
  } catch (err) {
    console.warn('[GC] skipping sweep, a database could not be read:', (err as Error).message)
    return null
  }
  return { paths, byMd5 }
}

/**
 * Reclaim the bulk data the old copy-and-repoint relocation left behind.
 * Runs once at startup, before any conversion is queued, so nothing in flight
 * can be caught mid-write. Conservative by construction: proves redundancy
 * before deleting, and bails out entirely if any database is unreadable.
 */
export function sweepStorage(): { freedBytes: number; files: number } {
  const roots = collectRoots()
  if (!roots) return { freedBytes: 0, files: 0 }
  let freedBytes = 0
  let files = 0

  const del = (p: string): void => {
    try {
      const st = statSync(p)
      const size = st.isDirectory() ? 0 : st.size
      rmSync(p, { recursive: true, force: true })
      freedBytes += size
      files++
    } catch { /* already gone */ }
  }

  // conversions/: in an unreferenced item dir, drop the intermediates and keep
  // the product.
  const convRoot = join(app.getPath('userData'), 'conversions')
  if (existsSync(convRoot)) {
    for (const itemDir of readdirSync(convRoot)) {
      const dir = join(convRoot, itemDir)
      let referenced = false
      const walk = (d: string): string[] => {
        const out: string[] = []
        for (const e of readdirSync(d)) {
          const p = join(d, e)
          if (statSync(p).isDirectory()) out.push(p, ...walk(p))
          else out.push(p)
        }
        return out
      }
      let entries: string[] = []
      try { entries = walk(dir) } catch { continue }
      for (const p of entries) {
        if (roots.paths.has(norm(p))) { referenced = true; break }
      }
      if (referenced) continue          // still live -- leave the whole dir alone
      for (const p of entries) {
        if (classifyStagingFile(basename(p)) === 'debris') del(p)
      }
    }
  }

  // attachments/: delete only files we can PROVE are redundant -- the same
  // bytes must still exist at a DIFFERENT path that a database references.
  //
  // "md5 appears in the referenced set" is NOT sufficient: a referenced file's
  // own md5 is in that set, so any hiccup in path comparison would make a live
  // file look like a duplicate of itself and delete it. Requiring a different,
  // existing path makes the survival of the content an observed fact.
  const attRoot = join(app.getPath('userData'), 'attachments')
  if (existsSync(attRoot)) {
    for (const name of readdirSync(attRoot)) {
      const p = join(attRoot, name)
      try { if (statSync(p).isDirectory()) continue } catch { continue }
      if (roots.paths.has(norm(p))) continue
      let hash: string
      try { hash = createHash('md5').update(readFileSync(p)).digest('hex') }
      catch { continue }
      const survivors = (roots.byMd5.get(hash) ?? [])
        .filter((q) => norm(q) !== norm(p) && existsSync(q))
      if (survivors.length > 0) del(p)
    }
  }

  return { freedBytes, files }
}
