// One-off maintenance that runs at startup, before any conversion is queued.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { basename, join, resolve } from 'path'
import { app } from 'electron'
import { createHash } from 'crypto'
import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { getPersonalDb } from '../db'
import { convertedDir } from './ConversionService'
import { isInside, moveInto } from './storagePaths'

/**
 * Libraries with no content root used to keep conversion output in the scratch
 * area permanently. Move those payloads into their real home so the scratch
 * area can be treated as scratch (and so the next conversion of an item with
 * the same id can't wipe them).
 *
 * This must cover every rootless library, not just whichever database happens
 * to be active: at startup the real active workspace hasn't been restored yet
 * (that happens later, asynchronously, over IPC), so `getDb()` here would
 * always resolve to the personal db and silently skip every other rootless
 * library forever. Instead this opens each rootless library's own database
 * directly -- the personal db, plus every DB-only local workspace (kind
 * 'local' with no local_path) found in the personal db's workspace registry.
 */
function migrateLibrary(db: Database.Database, key: string, legacyRoot: string): number {
  let moved = 0
  try {
    const rows = db.prepare('SELECT id, item_id, path FROM attachments WHERE path IS NOT NULL')
      .all() as Array<{ id: number; item_id: number; path: string }>
    for (const r of rows) {
      if (!isInside(r.path, legacyRoot) || !existsSync(r.path)) continue
      const name = basename(r.path) === 'images' ? 'images' : (r.path.endsWith('.md') ? 'Full.md' : basename(r.path))
      const dest = join(convertedDir(key, r.item_id), name)
      if (!moveInto(r.path, dest)) continue
      db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?').run(dest, name, r.id)
      moved++
    }
  } catch (err) {
    console.warn(`[GC] migration failed for library ${key}:`, (err as Error).message)
  }
  return moved
}

export function migrateStagedPayloads(): number {
  // The legacy flat layout -- NOT stagingRootDir(), which is scoped to
  // whichever workspace happens to be active right now.
  const legacyRoot = join(app.getPath('userData'), 'conversions')
  let moved = 0

  moved += migrateLibrary(getPersonalDb(), 'personal', legacyRoot)

  let rows: Array<{ id: number; local_path: string | null }> = []
  try {
    rows = getPersonalDb().prepare("SELECT id, local_path FROM workspaces WHERE kind = 'local'")
      .all() as Array<{ id: number; local_path: string | null }>
  } catch (err) {
    console.warn('[GC] could not read workspace registry for migration:', (err as Error).message)
    return moved
  }

  for (const w of rows) {
    if (w.local_path && w.local_path.trim()) continue   // has a content root -- not rootless
    const idx = join(app.getPath('userData'), 'workspaces', String(w.id), 'index.db')
    if (!existsSync(idx)) continue
    let wdb: Database.Database | null = null
    try {
      wdb = new DatabaseCtor(idx)
      moved += migrateLibrary(wdb, `ws${w.id}`, legacyRoot)
    } catch (err) {
      console.warn(`[GC] could not open workspace ${w.id} for migration:`, (err as Error).message)
    } finally {
      try { wdb?.close() } catch { /* already closed */ }
    }
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

/** Every referenced attachment path across the personal library and every
 *  registered workspace index, indexed both as a set and by the on-disk size of
 *  the file each one points at. Returns null if any database can't be read --
 *  callers must then do nothing at all.
 *
 *  Size rather than the `md5` column on purpose: `importItem` rebuilds
 *  attachment rows without an md5 whenever the index is rebuilt from the file
 *  tree, so on a real library that column is empty and any proof resting on it
 *  never fires. Size comes from the filesystem, survives every rebuild, and
 *  narrows the candidates enough that the content comparison stays cheap. */
function collectRoots(): { paths: Set<string>; bySize: Map<number, string[]> } | null {
  const paths = new Set<string>()
  const bySize = new Map<number, string[]>()
  const add = (db: Database.Database): void => {
    for (const r of db.prepare('SELECT path FROM attachments WHERE path IS NOT NULL').all() as Array<{ path: string }>) {
      paths.add(norm(r.path))
      let size: number
      try {
        const st = statSync(r.path)
        if (st.isDirectory()) continue
        size = st.size
      } catch { continue }   // referenced file is gone; it can prove nothing
      const list = bySize.get(size) ?? []
      list.push(r.path)
      bySize.set(size, list)
    }
  }
  try {
    const personal = getPersonalDb()
    add(personal)

    // Finding every index db matters more than it looks: a database we fail to
    // read is a set of live files we'd see as unreferenced, and the sweep
    // deletes on exactly that basis. `local_path` cannot be used as the base
    // for all kinds -- for a folder-backed local workspace it names the CONTENT
    // ROOT while the index still lives under the app's own workspaces dir, so
    // treating it as the base skipped those databases entirely. Take the union
    // of both candidates, and sweep the workspaces dir directly so a row we
    // never see can't hide one.
    const indexPaths = new Set<string>()
    const wsRoot = join(app.getPath('userData'), 'workspaces')
    if (existsSync(wsRoot)) {
      for (const entry of readdirSync(wsRoot)) {
        const p = join(wsRoot, entry, 'index.db')
        if (existsSync(p)) indexPaths.add(p)
      }
    }
    const rows = personal.prepare('SELECT id, local_path FROM workspaces').all() as Array<{ id: number; local_path: string | null }>
    for (const w of rows) {
      if (!w.local_path || !w.local_path.trim()) continue
      const p = join(w.local_path, 'index.db')     // github workspaces keep the index beside their clone
      if (existsSync(p)) indexPaths.add(p)
    }
    for (const idx of indexPaths) {
      const wdb = new DatabaseCtor(idx, { readonly: true })
      try { add(wdb) } finally { wdb.close() }
    }
  } catch (err) {
    console.warn('[GC] skipping sweep, a database could not be read:', (err as Error).message)
    return null
  }
  return { paths, bySize }
}

/** Is `name` an item-directory name -- i.e. purely digits (an item id)? */
export function isItemDirName(name: string): boolean {
  return /^\d+$/.test(name)
}

/** Every scratch root that can hold per-item conversion output: the legacy
 *  flat bucket (which now also holds the namespaced `conversions/<key>`
 *  buckets), each workspace's own tmp dir, and -- for a workspace with a
 *  content root -- both places its staging area can live (a github clone's
 *  `tmp`, or a folder-backed local library's `.veridian-tmp`). */
function scratchRoots(): string[] {
  const roots = [join(app.getPath('userData'), 'conversions')]
  try {
    const rows = getPersonalDb().prepare('SELECT id, local_path FROM workspaces')
      .all() as Array<{ id: number; local_path: string | null }>
    for (const w of rows) {
      roots.push(join(app.getPath('userData'), 'workspaces', String(w.id), 'tmp'))
      if (w.local_path && w.local_path.trim()) {
        roots.push(join(w.local_path, 'tmp'))
        roots.push(join(w.local_path, '.veridian-tmp'))
      }
    }
  } catch (err) {
    console.warn('[GC] could not read workspace registry for sweep:', (err as Error).message)
  }
  return roots
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

  // In an unreferenced item dir, drop the intermediates and keep the product;
  // then, if that left the item dir empty, remove it too.
  const processItemDir = (dir: string): void => {
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
    try { entries = walk(dir) } catch { return }
    if (entries.some((p) => roots.paths.has(norm(p)))) return   // still live -- leave the whole dir alone
    for (const p of entries) {
      if (classifyStagingFile(basename(p)) === 'debris') del(p)
    }
    try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }) }
    catch { /* not empty, or already gone */ }
  }

  // An item directory is found at depth 1 (`<root>/<itemId>`) or depth 2
  // (`<root>/<libraryKey>/<itemId>`, the namespaced conversions layout).
  // Depth-1 entries that aren't item dirs themselves are checked one level
  // deeper as a possible library-key bucket, then removed if that emptied them.
  for (const root of scratchRoots()) {
    if (!existsSync(root)) continue
    let entries: string[] = []
    try { entries = readdirSync(root) } catch { continue }
    for (const name of entries) {
      const p1 = join(root, name)
      let isDir = false
      try { isDir = statSync(p1).isDirectory() } catch { continue }
      if (!isDir) continue
      if (isItemDirName(name)) { processItemDir(p1); continue }
      let sub: string[] = []
      try { sub = readdirSync(p1) } catch { continue }
      for (const name2 of sub) {
        const p2 = join(p1, name2)
        let isDir2 = false
        try { isDir2 = statSync(p2).isDirectory() } catch { continue }
        if (isDir2 && isItemDirName(name2)) processItemDir(p2)
      }
      try { if (readdirSync(p1).length === 0) rmSync(p1, { recursive: true, force: true }) }
      catch { /* not empty, or already gone */ }
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
      let size: number
      try {
        const st = statSync(p)
        if (st.isDirectory()) continue
        size = st.size
      } catch { continue }
      if (roots.paths.has(norm(p))) continue

      // Only referenced files of exactly this size could be the survivor, so
      // hashing stays proportional to the leftovers rather than to the library.
      const candidates = (roots.bySize.get(size) ?? []).filter((q) => norm(q) !== norm(p))
      if (candidates.length === 0) continue
      let hash: string
      try { hash = createHash('md5').update(readFileSync(p)).digest('hex') }
      catch { continue }
      const survives = candidates.some((q) => {
        try { return createHash('md5').update(readFileSync(q)).digest('hex') === hash }
        catch { return false }   // unreadable proves nothing
      })
      if (survives) del(p)
    }
  }

  return { freedBytes, files }
}
