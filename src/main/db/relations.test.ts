import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { RELATION_TYPES, linkItems, unlink, listRelationsForItem, deleteRelationsForItem, setWikilinksForNote, listBacklinks, deleteRelationsForNote } from './relations'

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

  it('sets a note\'s wikilink out-edges idempotently and reconciles on change', () => {
    setWikilinksForNote(5, [{ kind: 'item', id: 2 }, { kind: 'note', id: 9 }])
    expect(listBacklinks('item', 2)).toHaveLength(1)
    expect(listBacklinks('note', 9)).toHaveLength(1)
    setWikilinksForNote(5, [{ kind: 'note', id: 9 }, { kind: 'item', id: 3 }])
    expect(listBacklinks('item', 2)).toHaveLength(0)
    expect(listBacklinks('item', 3)).toHaveLength(1)
    expect(listBacklinks('note', 9)).toHaveLength(1)
  })

  it('listBacklinks returns incoming edges of any rel_type', () => {
    linkItems(1, 2, 'extends', 'ai')
    setWikilinksForNote(7, [{ kind: 'item', id: 2 }])
    const back = listBacklinks('item', 2)
    expect(back).toHaveLength(2)
    expect(back.map((b) => b.rel_type).sort()).toEqual(['extends', 'wikilink'])
  })

  it('deleteRelationsForNote removes edges where the note is src or dst', () => {
    setWikilinksForNote(5, [{ kind: 'item', id: 2 }])
    setWikilinksForNote(8, [{ kind: 'note', id: 5 }])
    deleteRelationsForNote(5)
    expect(listBacklinks('item', 2)).toHaveLength(0)
    expect(listBacklinks('note', 5)).toHaveLength(0)
  })
})
