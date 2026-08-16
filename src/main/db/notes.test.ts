import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('./index', () => ({ getDb: () => db }))

import { createNote, getNote, listNotesByItem, updateNote, deleteNote } from './notes'

suite('notes repo', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, title TEXT, content TEXT,
        origin TEXT NOT NULL DEFAULT 'user', updated_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `)
  })
  afterEach(() => { db.close() })

  it('creates and reads a note on an item', () => {
    const id = createNote({ itemId: 7, title: 'Summary', content: 'body', origin: 'ai' })
    const n = getNote(id)!
    expect(n.item_id).toBe(7)
    expect(n.title).toBe('Summary')
    expect(n.origin).toBe('ai')
    expect(n.updated_by).toBe('ai')
  })

  it('lists notes for an item', () => {
    createNote({ itemId: 7, content: 'a', origin: 'ai' })
    createNote({ itemId: 7, content: 'b', origin: 'user' })
    createNote({ itemId: 9, content: 'c', origin: 'user' })
    expect(listNotesByItem(7)).toHaveLength(2)
  })

  it('updates content and stamps updated_by', () => {
    const id = createNote({ itemId: 7, content: 'old', origin: 'ai' })
    updateNote(id, { content: 'new', updatedBy: 'user' })
    const n = getNote(id)!
    expect(n.content).toBe('new')
    expect(n.updated_by).toBe('user')
  })

  it('deletes a note', () => {
    const id = createNote({ itemId: 7, content: 'x', origin: 'user' })
    deleteNote(id)
    expect(getNote(id)).toBeUndefined()
  })
})
