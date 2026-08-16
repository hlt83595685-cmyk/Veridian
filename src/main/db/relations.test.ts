import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { RELATION_TYPES, linkItems, unlink, listRelationsForItem, deleteRelationsForItem } from './relations'

suite('relations repo', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, src_kind TEXT NOT NULL, src_id INTEGER NOT NULL,
        dst_kind TEXT NOT NULL, dst_id INTEGER NOT NULL, rel_type TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type)
      );
    `)
  })
  afterEach(() => { db.close() })

  it('rejects an unknown rel_type', () => {
    expect(() => linkItems(1, 2, 'nonsense', 'ai')).toThrow(/rel_type/)
  })

  it('creates an item↔item edge and is idempotent', () => {
    expect(linkItems(1, 2, 'related', 'ai')).toBe(true)
    expect(linkItems(1, 2, 'related', 'ai')).toBe(false)   // duplicate ignored
    expect(listRelationsForItem(1)).toHaveLength(1)
  })

  it('lists edges in both directions', () => {
    linkItems(1, 2, 'extends', 'ai')
    linkItems(3, 1, 'contradicts', 'user')
    const rels = listRelationsForItem(1)
    expect(rels).toHaveLength(2)
    expect(rels.map((r) => r.rel_type).sort()).toEqual(['contradicts', 'extends'])
  })

  it('unlinks and bulk-deletes for an item', () => {
    linkItems(1, 2, 'related', 'ai')
    linkItems(1, 3, 'cites', 'ai')
    unlink(1, 2, 'related')
    expect(listRelationsForItem(1)).toHaveLength(1)
    deleteRelationsForItem(1)
    expect(listRelationsForItem(1)).toHaveLength(0)
  })

  it('exposes the fixed rel_type vocabulary', () => {
    expect(RELATION_TYPES).toEqual(['extends', 'contradicts', 'related', 'cites', 'same_method'])
  })
})
