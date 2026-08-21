// The repo layout translator for github-kind workspaces. Single
// responsibility: convert between the index database and the human-readable
// working-tree layout (the repo is the source of truth; the index db is a
// disposable cache):
//
//   <repoRoot>/
//   ├── collections.json              # [{ key, name, parent_key }]
//   └── papers/<item.key>/
//       ├── item.json                 # metadata + creators/tags/collections
//       └── files/<attachment files>  # real PDFs/markdown/image dirs
//
// It knows nothing about git (GitWorkspaceService) or scheduling
// (WorkspaceSyncService). All DB access here is direct SQL on the index db
// -- deliberately NOT through the Services, so imports never emit domain
// events (no export loops); a single workspace.dataRefreshed event after the
// whole import is the UI's refresh signal.
import type Database from 'better-sqlite3'
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'fs'
import { basename, join, sep } from 'path'
import { isInside, moveInto } from './storagePaths'

interface ItemJson {
  key: string
  type: string
  title: string | null
  abstract: string | null
  year: number | null
  doi: string | null
  url: string | null
  journal: string | null
  publisher: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  isbn: string | null
  language: string | null
  extra: string | null
  deleted: number
  conversion_failed: number
  updated_at: number
  version: number
  added_by: string | null
  creators: Array<{
    first_name: string | null; last_name: string; orcid: string | null
    role: string; position: number
  }>
  tags: string[]
  collections: string[]
  attachments: Array<{
    filename: string | null
    type: string
    mime_type: string | null
    url: string | null
    is_dir: boolean
  }>
}

const papersDir = (repoRoot: string): string => join(repoRoot, 'papers')

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Filesystem-safe folder name derived from an item title. */
export function sanitizeTitle(title: string | null): string {
  let s = (title ?? '').normalize('NFC')
  s = s.replace(/[\\/:*?"<>|]/g, ' ')   // Windows-illegal chars
  s = s.replace(/\p{Cc}/gu, ' ')        // control chars (Unicode Control category)
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (s.length > 100) s = s.slice(0, 100).trim()
  if (!s) return 'untitled'
  if (WIN_RESERVED.test(s)) s = '_' + s
  return s
}

/** `base` if free, else base-2, base-3, ... not in `taken`. */
export function uniqueDirName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const cand = `${base}-${i}`
    if (!taken.has(cand)) return cand
  }
}

/** Map item key -> its current folder name by scanning each papers/<dir>/item.json. */
function scanKeyToDir(repoRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  const dir = papersDir(repoRoot)
  if (!existsSync(dir)) return map
  for (const entry of readdirSync(dir)) {
    const jsonPath = join(dir, entry, 'item.json')
    if (!existsSync(jsonPath)) continue
    try {
      const j = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { key?: string }
      if (j.key) map.set(j.key, entry)
    } catch { /* skip unparseable */ }
  }
  return map
}

// ── Export: index db -> working tree ─────────────────────────────────────────

export function exportCollections(db: Database.Database, repoRoot: string): void {
  const rows = db.prepare(`
    SELECT c.key, c.name, p.key AS parent_key
    FROM collections c LEFT JOIN collections p ON p.id = c.parent_id
    ORDER BY c.id
  `).all()
  writeFileSync(join(repoRoot, 'collections.json'), JSON.stringify(rows, null, 2), 'utf-8')
}

/**
 * Write papers/<key>/item.json for each id and relocate any attachment whose
 * file still lives outside the repo (imports, pdf2md outputs, downloads)
 * into papers/<key>/files/ so collaborators actually receive it. Relocation
 * updates attachments.path via direct SQL -- no events, no loops.
 */
export function exportItems(db: Database.Database, repoRoot: string, itemIds: number[]): void {
  const keyToDir = scanKeyToDir(repoRoot)
  const taken = new Set(keyToDir.values())

  for (const id of itemIds) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as
      (Omit<ItemJson, 'creators' | 'tags' | 'collections' | 'attachments'> & { id: number; title: string | null }) | undefined
    if (!item) continue   // deleted since being marked dirty -- reconcileDeletions handles the dir

    // Folder name: reuse the item's existing folder (found by key), else make
    // a fresh sanitized-title folder, deduped against current folder names.
    let dirName = keyToDir.get(item.key)
    if (!dirName) {
      dirName = uniqueDirName(sanitizeTitle(item.title), taken)
      taken.add(dirName)
      keyToDir.set(item.key, dirName)
    }
    const dir = join(papersDir(repoRoot), dirName)
    const files = join(dir, 'files')
    mkdirSync(files, { recursive: true })

    // Relocate out-of-repo attachment payloads into the item's files/ dir
    const atts = db.prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id').all(id) as Array<{
      id: number; type: string; filename: string | null; path: string | null
      url: string | null; mime_type: string | null
    }>
    // Canonical naming: the folder already carries the human-readable title,
    // so the files inside use UNIFORM names -- Full.pdf / Full.md / images/.
    // These are per-item singletons written with overwrite semantics (a
    // re-conversion or re-import replaces the previous copy in place). Only
    // additional non-canonical files keep uniquePath collision handling.
    let pdfNamed = false
    for (const att of atts) {
      if (!att.path) continue
      // "Already in place" means inside THIS item's files/ dir -- not merely
      // somewhere under the content root. A folder-backed library keeps its
      // conversion scratch area at <contentRoot>/.veridian-tmp, so the broader
      // test mistook freshly converted output for output that had already been
      // relocated and skipped it, stranding every Full.md outside the library.
      if (isInside(att.path, files)) {
        // Migrate legacy names (<stem>.pdf / <stem>.md) to the canonical ones
        // in place, so older items converge on Full.* too.
        let want: string | null = null
        if (att.type === 'imagedir') want = 'images'
        else if (att.type === 'markdown') want = 'Full.md'
        else if (att.type === 'pdf' && !pdfNamed) want = 'Full.pdf'
        if (att.type === 'pdf') pdfNamed = true
        if (want && basename(att.path) !== want) {
          const dest = join(files, want)
          try {
            if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
            renameSync(att.path, dest)
            db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?')
              .run(dest, want, att.id)
            att.path = dest
            att.filename = want
          } catch (err) {
            console.warn(`[WorkspaceFiles] canonical rename failed (${att.path}):`, err)
          }
        }
        continue
      }
      const isFirstPdf = att.type === 'pdf' && !pdfNamed
      const isCanonical = att.type === 'imagedir' || att.type === 'markdown' || isFirstPdf
      let name: string
      if (att.type === 'imagedir') name = 'images'
      else if (att.type === 'markdown') name = 'Full.md'
      else if (isFirstPdf) name = 'Full.pdf'
      else name = att.filename ?? basename(att.path)
      const dest = isCanonical ? join(files, name) : uniquePath(files, name)
      // MOVE, don't copy: the old copy-and-repoint left a full duplicate of
      // every PDF behind in userData forever (hundreds of MB per library, all
      // of it unreferenced). moveInto replaces the destination wholesale, so
      // an imagedir can't merge stale images from a previous conversion, and
      // it leaves the source intact when it fails -- in which case we do NOT
      // repoint, so the attachment keeps pointing at the copy that still exists.
      if (moveInto(att.path, dest)) {
        if (isFirstPdf) pdfNamed = true
        db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?')
          .run(dest, basename(dest), att.id)
        att.path = dest
        att.filename = basename(dest)
      } else {
        console.warn(`[WorkspaceFiles] attachment relocation failed, keeping source: ${att.path}`)
      }
    }

    // Reconcile files/: anything not backed by an attachment row is an orphan
    // (a superseded canonical name, or debris from older builds) and is
    // removed so the repo mirrors the item's attachments exactly.
    const expected = new Set<string>()
    for (const att of atts) {
      if (att.path && isInside(att.path, files)) expected.add(basename(att.path))
    }
    try {
      for (const entry of readdirSync(files)) {
        if (expected.has(entry)) continue
        try { rmSync(join(files, entry), { recursive: true, force: true }) } catch { /* ignore */ }
      }
    } catch { /* files dir unreadable -- skip reconcile */ }

    const creators = db.prepare(`
      SELECT c.first_name, c.last_name, c.orcid, ic.role, ic.position
      FROM item_creators ic JOIN creators c ON c.id = ic.creator_id
      WHERE ic.item_id = ? ORDER BY ic.position
    `).all(id) as ItemJson['creators']

    const tags = (db.prepare(`
      SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.item_id = ? ORDER BY t.name
    `).all(id) as Array<{ name: string }>).map((r) => r.name)

    const collections = (db.prepare(`
      SELECT c.key FROM collection_items ci JOIN collections c ON c.id = ci.collection_id
      WHERE ci.item_id = ?
    `).all(id) as Array<{ key: string }>).map((r) => r.key)

    const json: ItemJson = {
      key: item.key, type: item.type, title: item.title, abstract: item.abstract,
      year: item.year, doi: item.doi, url: item.url, journal: item.journal,
      publisher: item.publisher, volume: item.volume, issue: item.issue,
      pages: item.pages, isbn: item.isbn, language: item.language, extra: item.extra,
      deleted: item.deleted, conversion_failed: item.conversion_failed ?? 0,
      updated_at: item.updated_at, version: item.version,
      added_by: item.added_by,
      creators, tags, collections,
      attachments: atts.map((a) => ({
        filename: a.filename, type: a.type, mime_type: a.mime_type,
        url: a.url, is_dir: a.type === 'imagedir',
      })),
    }
    writeFileSync(join(dir, 'item.json'), JSON.stringify(json, null, 2), 'utf-8')
  }
}

/**
 * Export any items the index db knows but the tree doesn't -- stranded local
 * work (e.g. a crash before the debounce fired, or an old bug). Called on
 * every activation BEFORE importAll so tree-as-truth can never silently
 * discard local-only items. Returns how many were recovered.
 */
export function exportMissingItems(
  db: Database.Database, repoRoot: string, includeFailed: boolean
): number {
  const keyToDir = scanKeyToDir(repoRoot)
  // Local folder workspaces rescue everything, conversion failures included --
  // the user picked that folder as where their library lives, so a paper whose
  // markdown failed still belongs there (its PDF and metadata are fine, and it
  // gains Full.md whenever a retry succeeds). Github workspaces keep holding
  // failures back so collaborators never receive half-converted items.
  const rows = db.prepare(
    includeFailed ? 'SELECT id, key FROM items' : 'SELECT id, key FROM items WHERE conversion_failed = 0'
  ).all() as Array<{ id: number; key: string }>
  const missing = rows.filter((r) => !keyToDir.has(r.key))
  if (missing.length > 0) {
    exportCollections(db, repoRoot)
    exportItems(db, repoRoot, missing.map((r) => r.id))
  }
  return missing.length
}

/**
 * Remove papers/<key> dirs for items the user EXPLICITLY deleted locally --
 * driven by the tombstones table (written by ItemService.deleteItem/
 * emptyTrash), never by "dir not in my index db". The old absence-based rule
 * couldn't distinguish "I deleted this" from "a collaborator added this and
 * I haven't pulled it into my index yet", and would push destructive commits
 * that wiped other people's items. Applied tombstones are cleared so they
 * don't accumulate.
 */
export function reconcileDeletions(db: Database.Database, repoRoot: string): void {
  const dir = papersDir(repoRoot)
  if (!existsSync(dir)) return
  const tombs = db.prepare("SELECT key FROM tombstones WHERE object_type = 'item'")
    .all() as Array<{ key: string }>
  if (tombs.length === 0) return
  const keyToDir = scanKeyToDir(repoRoot)
  const clear = db.prepare("DELETE FROM tombstones WHERE object_type = 'item' AND key = ?")
  for (const { key } of tombs) {
    const dirName = keyToDir.get(key)
    if (dirName) {
      const target = join(dir, dirName)
      if (existsSync(target)) {
        try { rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
    clear.run(key)
  }
}

// ── Import: working tree -> index db ─────────────────────────────────────────

/**
 * Full rebuild of the index db from the working tree. The tree is the source
 * of truth: items present locally but absent from the tree are deleted
 * (FK cascades clean up creators/tags/attachments/collection links).
 */
export function importAll(db: Database.Database, repoRoot: string): void {
  db.transaction(() => {
    importCollections(db, repoRoot)

    const dir = papersDir(repoRoot)
    const treeKeys = new Set<string>()
    // Locally-deleted items whose tombstone hasn't been applied/pushed yet
    // must not be resurrected by an import that runs before the next export
    const tombstoned = new Set(
      (db.prepare("SELECT key FROM tombstones WHERE object_type = 'item'")
        .all() as Array<{ key: string }>).map((r) => r.key)
    )
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        const jsonPath = join(dir, entry, 'item.json')
        if (!existsSync(jsonPath)) continue
        try {
          const json = JSON.parse(readFileSync(jsonPath, 'utf-8')) as ItemJson
          if (!json.key) continue                 // no identity -> skip
          if (tombstoned.has(json.key)) continue  // locally-deleted, not yet pushed
          importItem(db, repoRoot, json, entry)   // pass the folder name
          treeKeys.add(json.key)
        } catch (err) {
          console.warn(`[WorkspaceFiles] skipping unparseable ${jsonPath}:`, err)
        }
      }
    }

    // Anything in the db but not in the tree was deleted remotely -- but ONLY
    // if it ever made it into the tree to begin with. An item whose payloads
    // all still sit outside the content root (fresh import, conversion still
    // pending or failed, a crash before the export ran) has never been
    // exported, so its absence says nothing about a remote deletion. Deleting
    // those was how a batch import could lose everything but the few papers
    // that happened to convert before an error. Prefix-match in JS, not SQL
    // LIKE: '_' in a Windows path is a LIKE wildcard and would mis-match.
    // Match is bounded at a path separator so a sibling folder that merely
    // shares repoRoot's string prefix (e.g. "C:\Lib-backup") doesn't count.
    const exported = new Set<number>()
    const repoRootPrefix = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep
    for (const a of db.prepare('SELECT item_id, path FROM attachments WHERE path IS NOT NULL')
      .all() as Array<{ item_id: number; path: string }>) {
      if (a.path === repoRoot || a.path.startsWith(repoRootPrefix)) exported.add(a.item_id)
    }
    const stale = (db.prepare('SELECT id, key FROM items').all() as Array<{ id: number; key: string }>)
      .filter((r) => !treeKeys.has(r.key) && exported.has(r.id))
    for (const r of stale) db.prepare('DELETE FROM items WHERE id = ?').run(r.id)

    // items_fts is an external-content FTS5 table -- direct INSERT/UPDATE/
    // DELETE on items doesn't maintain it, so rebuild after a bulk import or
    // full-text search in this workspace would return stale/empty results.
    try { db.prepare("INSERT INTO items_fts(items_fts) VALUES('rebuild')").run() }
    catch (err) { console.warn('[WorkspaceFiles] FTS rebuild failed:', err) }
  })()
}

function importCollections(db: Database.Database, repoRoot: string): void {
  const file = join(repoRoot, 'collections.json')
  if (!existsSync(file)) return
  let rows: Array<{ key: string; name: string; parent_key: string | null }>
  try { rows = JSON.parse(readFileSync(file, 'utf-8')) }
  catch { return }

  // Upsert by key; two passes so parents exist before children reference them
  for (const row of rows) {
    db.prepare(`
      INSERT INTO collections (library_id, name, key) VALUES (1, @name, @key)
      ON CONFLICT(key) DO UPDATE SET name = @name
    `).run({ name: row.name, key: row.key })
  }
  for (const row of rows) {
    db.prepare(`
      UPDATE collections
      SET parent_id = (SELECT id FROM collections WHERE key = @parent_key)
      WHERE key = @key
    `).run({ key: row.key, parent_key: row.parent_key })
  }
  const keys = rows.map((r) => r.key)
  if (keys.length > 0) {
    db.prepare(`
      DELETE FROM collections WHERE key NOT IN (${keys.map(() => '?').join(',')})
    `).run(...keys)
  } else {
    db.prepare('DELETE FROM collections').run()
  }
}

function importItem(db: Database.Database, repoRoot: string, json: ItemJson, dirName: string): void {
  const existing = db.prepare('SELECT id FROM items WHERE key = ?').get(json.key) as { id: number } | undefined

  const fields = {
    key: json.key, type: json.type ?? 'journalArticle', title: json.title ?? null,
    abstract: json.abstract ?? null, year: json.year ?? null, doi: json.doi ?? null,
    url: json.url ?? null, journal: json.journal ?? null, publisher: json.publisher ?? null,
    volume: json.volume ?? null, issue: json.issue ?? null, pages: json.pages ?? null,
    isbn: json.isbn ?? null, language: json.language ?? null, extra: json.extra ?? null,
    deleted: json.deleted ?? 0, conversion_failed: json.conversion_failed ?? 0,
    updated_at: json.updated_at ?? Math.floor(Date.now() / 1000),
    version: json.version ?? 0,
    added_by: json.added_by ?? null,
  }

  let itemId: number
  if (existing) {
    db.prepare(`
      UPDATE items SET type=@type, title=@title, abstract=@abstract, year=@year,
        doi=@doi, url=@url, journal=@journal, publisher=@publisher, volume=@volume,
        issue=@issue, pages=@pages, isbn=@isbn, language=@language, extra=@extra,
        deleted=@deleted, conversion_failed=@conversion_failed,
        updated_at=@updated_at, version=@version, added_by=@added_by
      WHERE key=@key
    `).run(fields)
    itemId = existing.id
  } else {
    const info = db.prepare(`
      INSERT INTO items (key, type, title, abstract, year, doi, url, journal, publisher,
        volume, issue, pages, isbn, language, extra, deleted, conversion_failed, library_id,
        created_at, updated_at, version, added_by)
      VALUES (@key, @type, @title, @abstract, @year, @doi, @url, @journal, @publisher,
        @volume, @issue, @pages, @isbn, @language, @extra, @deleted, @conversion_failed, 1,
        @updated_at, @updated_at, @version, @added_by)
    `).run(fields)
    itemId = Number(info.lastInsertRowid)
  }

  // Creators: rebuild associations from the file
  db.prepare('DELETE FROM item_creators WHERE item_id = ?').run(itemId)
  for (const c of json.creators ?? []) {
    const found = db.prepare(
      'SELECT id FROM creators WHERE last_name = ? AND COALESCE(first_name, \'\') = COALESCE(?, \'\')'
    ).get(c.last_name, c.first_name) as { id: number } | undefined
    const creatorId = found?.id ?? Number(db.prepare(
      'INSERT INTO creators (first_name, last_name, orcid) VALUES (?, ?, ?)'
    ).run(c.first_name, c.last_name, c.orcid ?? null).lastInsertRowid)
    db.prepare(`
      INSERT OR REPLACE INTO item_creators (item_id, creator_id, role, position)
      VALUES (?, ?, ?, ?)
    `).run(itemId, creatorId, c.role ?? 'author', c.position ?? 0)
  }

  // Tags
  db.prepare('DELETE FROM item_tags WHERE item_id = ?').run(itemId)
  for (const name of json.tags ?? []) {
    db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name)
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number }
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)').run(itemId, tag.id)
  }

  // Collection membership (by key)
  db.prepare('DELETE FROM collection_items WHERE item_id = ?').run(itemId)
  for (const colKey of json.collections ?? []) {
    const col = db.prepare('SELECT id FROM collections WHERE key = ?').get(colKey) as { id: number } | undefined
    if (col) {
      db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, item_id) VALUES (?, ?)')
        .run(col.id, itemId)
    }
  }

  // Attachments: rows point at the working-tree files
  db.prepare('DELETE FROM attachments WHERE item_id = ?').run(itemId)
  const files = join(papersDir(repoRoot), dirName, 'files')
  for (const a of json.attachments ?? []) {
    let path: string | null = null
    let size: number | null = null
    if (a.filename) {
      const p = join(files, a.filename)
      if (existsSync(p)) {
        path = p
        if (!a.is_dir) { try { size = statSync(p).size } catch { /* ignore */ } }
      }
    }
    if (!path && !a.url) continue   // payload missing and no link -- skip
    db.prepare(`
      INSERT INTO attachments (item_id, type, filename, path, url, mime_type, size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, a.type ?? 'other', a.filename, path, a.url ?? null, a.mime_type ?? null, size)
  }
}

// ── Repo tree (for the sidebar's repository-files tab) ───────────────────────

export function listRepoTree(repoRoot: string): import('../../shared/types').RepoTreeNode[] {
  const walk = (dir: string): import('../../shared/types').RepoTreeNode[] => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return [] }
    const nodes: import('../../shared/types').RepoTreeNode[] = []
    for (const name of entries) {
      // .veridian-tmp is the conversion scratch area a folder-backed library
      // keeps beside its papers; it holds half-finished output and is no more
      // part of the user's library than .git is.
      if (name === '.git' || name === '.veridian-tmp') continue
      const abs = join(dir, name)
      let isDir = false
      try { isDir = statSync(abs).isDirectory() } catch { continue }
      nodes.push(isDir
        ? { name, absPath: abs, isDir: true, children: walk(abs) }
        : { name, absPath: abs, isDir: false })
    }
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    return nodes
  }
  return walk(repoRoot)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniquePath(dir: string, name: string): string {
  let candidate = join(dir, name)
  if (!existsSync(candidate)) return candidate
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; ; i++) {
    candidate = join(dir, `${stem}-${i}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
}
