import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { addTagsToItem, getTagsByItem } from './tags'

suite('addTagsToItem', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE item_tags (item_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (item_id, tag_id));
    `)
  })
  afterEach(() => { db.close() })

  it('adds tags without removing existing ones', () => {
    addTagsToItem(1, ['graphene'])
    addTagsToItem(1, ['graphene', 'battery'])   // graphene already present
    expect(getTagsByItem(1).map((t) => t.name).sort()).toEqual(['battery', 'graphene'])
  })

  it('trims and ignores empty tag names', () => {
    addTagsToItem(1, ['  x  ', '', '   '])
    expect(getTagsByItem(1).map((t) => t.name)).toEqual(['x'])
  })
})
