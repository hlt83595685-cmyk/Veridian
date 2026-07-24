import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { setAttribution } from '../services/attribution'

// better-sqlite3 is compiled for Electron's ABI (electron-rebuild in
// postinstall), so it typically CANNOT load under vitest's plain-node runtime
// -- rebuilding it for node would break the Electron app. Detect that once and
// skip the DB-backed cases when the native module is unavailable, keeping the
// suite green. The attribution holder itself is fully covered by
// attribution.test.ts (pure JS); createItem's added_by wiring is verified by
// the block-B manual E2E.
let dbUsable = true
try {
  new Database(':memory:').close()
} catch {
  dbUsable = false
}

let db: Database.Database

vi.mock('./index', () => ({
  getDb: () => db,
}))

import { createItem } from './items'

const suite = dbUsable ? describe : describe.skip

suite('createItem attribution', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, type TEXT, title TEXT,
        abstract TEXT, year INTEGER, doi TEXT, url TEXT, journal TEXT,
        publisher TEXT, volume TEXT, issue TEXT, pages TEXT, isbn TEXT,
        language TEXT, extra TEXT, deleted INTEGER DEFAULT 0, library_id INTEGER DEFAULT 1,
        created_at INTEGER, updated_at INTEGER, version INTEGER DEFAULT 0, added_by TEXT
      );
    `)
    setAttribution(null)
  })

  afterEach(() => { db.close() })

  it('writes added_by from the attribution holder', () => {
    setAttribution('octocat')
    const item = createItem({ title: 'Test' })
    expect(item.added_by).toBe('octocat')
  })

  it('writes null added_by when no attribution set', () => {
    const item = createItem({ title: 'Test' })
    expect(item.added_by).toBeNull()
  })
})
