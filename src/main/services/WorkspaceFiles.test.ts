import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { sanitizeTitle, uniqueDirName, importAll } from './WorkspaceFiles'

// better-sqlite3 is built for Electron's ABI here; under plain node these
// suites skip, matching the project's existing DB-test convention.
let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

describe('sanitizeTitle', () => {
  it('strips Windows-illegal characters', () => {
    expect(sanitizeTitle('a/b:c*d?e"f<g>h|i\\j')).toBe('a b c d e f g h i j')
  })
  it('collapses whitespace and trims', () => {
    expect(sanitizeTitle('  hello    world  ')).toBe('hello world')
  })
  it('trims trailing dots and spaces', () => {
    expect(sanitizeTitle('report...  ')).toBe('report')
  })
  it('falls back to untitled for empty/null', () => {
    expect(sanitizeTitle('')).toBe('untitled')
    expect(sanitizeTitle(null)).toBe('untitled')
    expect(sanitizeTitle('   ')).toBe('untitled')
  })
  it('prefixes Windows reserved names', () => {
    expect(sanitizeTitle('CON')).toBe('_CON')
    expect(sanitizeTitle('lpt1')).toBe('_lpt1')
  })
  it('truncates to 100 chars', () => {
    expect(sanitizeTitle('x'.repeat(200)).length).toBeLessThanOrEqual(100)
  })
})

describe('uniqueDirName', () => {
  it('returns the base when free', () => {
    expect(uniqueDirName('paper', new Set())).toBe('paper')
  })
  it('appends -2 on first collision', () => {
    expect(uniqueDirName('paper', new Set(['paper']))).toBe('paper-2')
  })
  it('skips to the next free suffix', () => {
    expect(uniqueDirName('paper', new Set(['paper', 'paper-2']))).toBe('paper-3')
  })
})

suite('importAll deletion guard', () => {
  let db: Database.Database
  let root: string

  const SCHEMA = `
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, type TEXT,
      title TEXT, abstract TEXT, year INTEGER, doi TEXT, url TEXT, journal TEXT,
      publisher TEXT, volume TEXT, issue TEXT, pages TEXT, isbn TEXT, language TEXT,
      extra TEXT, deleted INTEGER DEFAULT 0, library_id INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0, version INTEGER DEFAULT 0,
      added_by TEXT, conversion_failed INTEGER DEFAULT 0);
    CREATE TABLE creators (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT, orcid TEXT);
    CREATE TABLE item_creators (item_id INTEGER, creator_id INTEGER, role TEXT, position INTEGER,
      PRIMARY KEY (item_id, creator_id, role));
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
    CREATE TABLE item_tags (item_id INTEGER, tag_id INTEGER, PRIMARY KEY (item_id, tag_id));
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER,
      name TEXT, key TEXT UNIQUE, parent_id INTEGER);
    CREATE TABLE collection_items (collection_id INTEGER, item_id INTEGER,
      PRIMARY KEY (collection_id, item_id));
    CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, type TEXT,
      filename TEXT, path TEXT, url TEXT, mime_type TEXT, size INTEGER);
    CREATE TABLE tombstones (id INTEGER PRIMARY KEY AUTOINCREMENT, object_type TEXT, key TEXT);
  `

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(SCHEMA)
    root = mkdtempSync(join(tmpdir(), 'veridian-wf-'))
    mkdirSync(join(root, 'papers'), { recursive: true })
  })
  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps a local-only item whose attachments live outside the content root', () => {
    db.prepare("INSERT INTO items (key, type, title) VALUES ('LOCAL1', 'journalArticle', 'Local paper')").run()
    // Its PDF still sits in the app's staging/attachment area, never exported.
    db.prepare("INSERT INTO attachments (item_id, type, filename, path) VALUES (1, 'pdf', 'a.pdf', ?)")
      .run(join(tmpdir(), 'veridian-elsewhere', 'a.pdf'))

    importAll(db, root)

    const rows = db.prepare("SELECT key FROM items").all() as Array<{ key: string }>
    expect(rows.map((r) => r.key)).toEqual(['LOCAL1'])
  })

  it('still deletes an item that was exported but is now gone from the tree', () => {
    db.prepare("INSERT INTO items (key, type, title) VALUES ('GONE1', 'journalArticle', 'Removed remotely')").run()
    // It HAS been exported before: its attachment path is inside the content root.
    db.prepare("INSERT INTO attachments (item_id, type, filename, path) VALUES (1, 'pdf', 'Full.pdf', ?)")
      .run(join(root, 'papers', 'Removed remotely', 'files', 'Full.pdf'))

    importAll(db, root)

    const count = db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('keeps an item that is present in the tree', () => {
    const dir = join(root, 'papers', 'Kept')
    mkdirSync(join(dir, 'files'), { recursive: true })
    writeFileSync(join(dir, 'item.json'), JSON.stringify({
      key: 'KEEP1', type: 'journalArticle', title: 'Kept', attachments: [], creators: [], tags: [], collections: [],
    }), 'utf-8')

    importAll(db, root)

    const rows = db.prepare("SELECT key FROM items").all() as Array<{ key: string }>
    expect(rows.map((r) => r.key)).toEqual(['KEEP1'])
  })
})
