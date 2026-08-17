import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let dbUsable = true
try { new Database(':memory:').close() } catch { dbUsable = false }
const suite = dbUsable ? describe : describe.skip

let db: Database.Database
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('../db/index', () => ({ getDb: () => db }))
vi.mock('../core/Notifier', () => ({ emit: () => {} }))
vi.mock('../db/oplog', () => ({ appendOp: () => {} }))

import { saveNote } from './NoteService'
import { getNote } from '../db/notes'

suite('NoteService.saveNote origin', () => {
	beforeEach(() => {
		db = new Database(':memory:')
		db.exec(`
			CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, title TEXT, deleted INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
			CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, title TEXT, content TEXT,
				origin TEXT DEFAULT 'user', updated_by TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
			CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_kind TEXT, src_id INTEGER, dst_kind TEXT, dst_id INTEGER,
				rel_type TEXT, origin TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type));
		`)
	})
	afterEach(() => { db.close() })

	it('tags a newly created note with origin=ai when asked', () => {
		const id = saveNote({ title: 'Concept', content: 'body', origin: 'ai' })
		const n = getNote(id)!
		expect(n.origin).toBe('ai')
		expect(n.updated_by).toBe('ai')
	})

	it('defaults origin to user when omitted (unchanged behavior)', () => {
		const id = saveNote({ title: 'Mine', content: 'body' })
		expect(getNote(id)!.origin).toBe('user')
	})

	it('records updated_by=ai on an ai update', () => {
		const id = saveNote({ title: 'X', content: 'a' })
		saveNote({ id, content: 'b', origin: 'ai' })
		expect(getNote(id)!.updated_by).toBe('ai')
	})
})
