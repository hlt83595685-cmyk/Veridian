import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

// The migration-9 SQL, extracted so it can run against a bare db in the test.
import { MIGRATION_9_SQL } from './index'

suite('migration 9', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    // Pre-9 shape: notes attached to items only.
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, key TEXT);
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        content TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO items (id, key) VALUES (1, 'k1');
      INSERT INTO notes (item_id, content) VALUES (1, 'legacy note');
    `)
  })
  afterEach(() => { db.close() })

  it('makes notes.item_id nullable and adds title/origin/updated_by, preserving rows', () => {
    db.exec(MIGRATION_9_SQL)
    const cols = (db.pragma('table_info(notes)') as { name: string; notnull: number }[])
    const itemId = cols.find((c) => c.name === 'item_id')!
    expect(itemId.notnull).toBe(0)                    // nullable now
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['title', 'origin', 'updated_by'])
    )
    const kept = db.prepare('SELECT content FROM notes WHERE id = 1').get() as { content: string }
    expect(kept.content).toBe('legacy note')
    const prov = db.prepare('SELECT origin, updated_by FROM notes WHERE id = 1').get() as { origin: string; updated_by: string }
    expect(prov.origin).toBe('user')
    expect(prov.updated_by).toBe('user')
    // Standalone note (no item) is now allowed.
    expect(() => db.prepare("INSERT INTO notes (content) VALUES ('standalone')").run()).not.toThrow()
  })

  it('creates relations with a uniqueness guard', () => {
    db.exec(MIGRATION_9_SQL)
    db.prepare(`INSERT INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type)
                VALUES ('item', 1, 'item', 2, 'related')`).run()
    expect(() => db.prepare(`INSERT INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type)
                VALUES ('item', 1, 'item', 2, 'related')`).run()).toThrow()
  })
})
