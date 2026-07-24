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
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'fs'
import { basename, join } from 'path'

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
  updated_at: number
  version: number
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
const itemDir = (repoRoot: string, key: string): string => join(papersDir(repoRoot), key)
const filesDir = (repoRoot: string, key: string): string => join(itemDir(repoRoot, key), 'files')

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
  for (const id of itemIds) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as
      (Omit<ItemJson, 'creators' | 'tags' | 'collections' | 'attachments'> & { id: number }) | undefined
    if (!item) continue   // deleted since being marked dirty -- reconcileDeletions handles the dir

    const dir = itemDir(repoRoot, item.key)
    const files = filesDir(repoRoot, item.key)
    mkdirSync(files, { recursive: true })

    // Relocate out-of-repo attachment payloads into the item's files/ dir
    const atts = db.prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id').all(id) as Array<{
      id: number; type: string; filename: string | null; path: string | null
      url: string | null; mime_type: string | null
    }>
    // Canonical naming: locally-managed copies carry UUID filenames (import
    // dedup) and conversion outputs inherit them -- ugly and meaningless in
    // a shared repo. Name repo files after the item's PDF instead:
    //   <original>.pdf / <original>.md / images/
    const pdfStem = (() => {
      const pdf = atts.find((a) => a.type === 'pdf' && a.filename)
      return pdf?.filename?.replace(/\.pdf$/i, '') ?? null
    })()
    for (const att of atts) {
      if (!att.path) continue
      if (att.path.startsWith(repoRoot)) continue
      // Conversion outputs (markdown/imagedir) are singletons per item with
      // CANONICAL names -- a re-conversion must overwrite the previous repo
      // copy, never stack foo-1.md / images-1 next to it. Only real user
      // files (PDFs etc.) get uniquePath collision handling.
      const isConversion = att.type === 'imagedir' || att.type === 'markdown'
      let name: string
      if (att.type === 'imagedir') name = 'images'
      else if (att.type === 'markdown') name = `${pdfStem ?? 'fulltext'}.md`
      else name = att.filename ?? basename(att.path)
      const dest = isConversion ? join(files, name) : uniquePath(files, name)
      try {
        if (att.type === 'imagedir') {
          // cpSync onto an existing dir MERGES old and new contents -- stale
          // images from the previous conversion would survive. Clean first.
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
          cpSync(att.path, dest, { recursive: true })
        } else {
          copyFileSync(att.path, dest)   // plain overwrite for files
        }
        db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?')
          .run(dest, basename(dest), att.id)
        att.path = dest
        att.filename = basename(dest)
      } catch (err) {
        console.warn(`[WorkspaceFiles] attachment relocation failed (${att.path}):`, err)
      }
    }

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
      deleted: item.deleted, updated_at: item.updated_at, version: item.version,
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
export function exportMissingItems(db: Database.Database, repoRoot: string): number {
  const rows = db.prepare('SELECT id, key FROM items').all() as Array<{ id: number; key: string }>
  const missing = rows.filter((r) => !existsSync(join(itemDir(repoRoot, r.key), 'item.json')))
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
  const clear = db.prepare("DELETE FROM tombstones WHERE object_type = 'item' AND key = ?")
  for (const { key } of tombs) {
    const target = join(dir, key)
    if (existsSync(target)) {
      try { rmSync(target, { recursive: true, force: true }) } catch { /* ignore */ }
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
        if (tombstoned.has(entry)) continue
        const jsonPath = join(dir, entry, 'item.json')
        if (!existsSync(jsonPath)) continue
        try {
          const json = JSON.parse(readFileSync(jsonPath, 'utf-8')) as ItemJson
          if (json.key !== entry) json.key = entry   // dir name wins on mismatch
          importItem(db, repoRoot, json)
          treeKeys.add(entry)
        } catch (err) {
          console.warn(`[WorkspaceFiles] skipping unparseable ${jsonPath}:`, err)
        }
      }
    }

    // Anything in the db but not in the tree was deleted remotely
    const stale = (db.prepare('SELECT id, key FROM items').all() as Array<{ id: number; key: string }>)
      .filter((r) => !treeKeys.has(r.key))
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

function importItem(db: Database.Database, repoRoot: string, json: ItemJson): void {
  const existing = db.prepare('SELECT id FROM items WHERE key = ?').get(json.key) as { id: number } | undefined

  const fields = {
    key: json.key, type: json.type ?? 'journalArticle', title: json.title ?? null,
    abstract: json.abstract ?? null, year: json.year ?? null, doi: json.doi ?? null,
    url: json.url ?? null, journal: json.journal ?? null, publisher: json.publisher ?? null,
    volume: json.volume ?? null, issue: json.issue ?? null, pages: json.pages ?? null,
    isbn: json.isbn ?? null, language: json.language ?? null, extra: json.extra ?? null,
    deleted: json.deleted ?? 0, updated_at: json.updated_at ?? Math.floor(Date.now() / 1000),
    version: json.version ?? 0,
  }

  let itemId: number
  if (existing) {
    db.prepare(`
      UPDATE items SET type=@type, title=@title, abstract=@abstract, year=@year,
        doi=@doi, url=@url, journal=@journal, publisher=@publisher, volume=@volume,
        issue=@issue, pages=@pages, isbn=@isbn, language=@language, extra=@extra,
        deleted=@deleted, updated_at=@updated_at, version=@version
      WHERE key=@key
    `).run(fields)
    itemId = existing.id
  } else {
    const info = db.prepare(`
      INSERT INTO items (key, type, title, abstract, year, doi, url, journal, publisher,
        volume, issue, pages, isbn, language, extra, deleted, library_id,
        created_at, updated_at, version)
      VALUES (@key, @type, @title, @abstract, @year, @doi, @url, @journal, @publisher,
        @volume, @issue, @pages, @isbn, @language, @extra, @deleted, 1,
        @updated_at, @updated_at, @version)
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
  const files = filesDir(repoRoot, json.key)
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
      if (name === '.git') continue
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
