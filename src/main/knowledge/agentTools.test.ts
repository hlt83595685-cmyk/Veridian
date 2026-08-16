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

import { executeAgentTool, AGENT_ACTION_TOOL_NAMES } from './agentTools'

suite('agent write tools', () => {
	beforeEach(() => {
		db = new Database(':memory:')
		db.exec(`
			CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, title TEXT, deleted INTEGER DEFAULT 0,
				abstract TEXT, year INTEGER, journal TEXT, doi TEXT, url TEXT, publisher TEXT, volume TEXT,
				issue TEXT, pages TEXT, isbn TEXT, language TEXT, extra TEXT, updated_at INTEGER DEFAULT 0, version INTEGER DEFAULT 0, starred INTEGER DEFAULT 0);
			CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
			CREATE TABLE item_tags (item_id INTEGER, tag_id INTEGER, PRIMARY KEY (item_id, tag_id));
			CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, library_id INTEGER DEFAULT 1, parent_id INTEGER, name TEXT, key TEXT UNIQUE);
			CREATE TABLE collection_items (collection_id INTEGER, item_id INTEGER, PRIMARY KEY (collection_id, item_id));
			CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, title TEXT, content TEXT,
				origin TEXT DEFAULT 'user', updated_by TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
			CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src_kind TEXT, src_id INTEGER, dst_kind TEXT, dst_id INTEGER,
				rel_type TEXT, origin TEXT DEFAULT 'user', created_at INTEGER DEFAULT 0, UNIQUE (src_kind, src_id, dst_kind, dst_id, rel_type));
			INSERT INTO items (key, title) VALUES ('AAAA1111', 'Paper A'), ('BBBB2222', 'Paper B');
		`)
	})
	afterEach(() => { db.close() })

	it('add_tags attaches tags to the resolved item', async () => {
		const { step } = await executeAgentTool('add_tags', JSON.stringify({ item_key: 'AAAA1111', tags: ['graphene', 'battery'] }))
		expect(step.tool).toBe('add_tags')
		const n = db.prepare('SELECT COUNT(*) AS n FROM item_tags').get() as { n: number }
		expect(n.n).toBe(2)
	})

	it('create_note writes an ai-origin note on the item', async () => {
		await executeAgentTool('create_note', JSON.stringify({ item_key: 'AAAA1111', title: 'Summary', content: 'body' }))
		const note = db.prepare('SELECT * FROM notes').get() as { origin: string; title: string }
		expect(note.origin).toBe('ai')
		expect(note.title).toBe('Summary')
	})

	it('link_items creates a typed edge between two papers', async () => {
		await executeAgentTool('link_items', JSON.stringify({ from_key: 'AAAA1111', to_key: 'BBBB2222', rel_type: 'extends' }))
		const rel = db.prepare('SELECT * FROM relations').get() as { rel_type: string; origin: string }
		expect(rel.rel_type).toBe('extends')
		expect(rel.origin).toBe('ai')
	})

	it('add_to_collection creates the collection when missing', async () => {
		await executeAgentTool('add_to_collection', JSON.stringify({ item_key: 'AAAA1111', collection: 'Energy' }))
		const c = db.prepare('SELECT * FROM collections').get() as { name: string }
		expect(c.name).toBe('Energy')
		const link = db.prepare('SELECT COUNT(*) AS n FROM collection_items').get() as { n: number }
		expect(link.n).toBe(1)
	})

	it('update_metadata patches only provided fields', async () => {
		await executeAgentTool('update_metadata', JSON.stringify({ item_key: 'AAAA1111', year: 2021 }))
		const it = db.prepare("SELECT year, title FROM items WHERE key = 'AAAA1111'").get() as { year: number; title: string }
		expect(it.year).toBe(2021)
		expect(it.title).toBe('Paper A')   // untouched
	})

	it('resolves a truncated (unique prefix) key', async () => {
		await executeAgentTool('set_star', JSON.stringify({ item_key: 'AAAA', starred: true }))
		const it = db.prepare("SELECT starred FROM items WHERE key = 'AAAA1111'").get() as { starred: number }
		expect(it.starred).toBe(1)
	})

	it('returns an error step for an unknown item key', async () => {
		const { result } = await executeAgentTool('add_tags', JSON.stringify({ item_key: 'ZZZZ', tags: ['x'] }))
		expect(result).toMatch(/not found/i)
	})

	it('exposes the action tool name set', () => {
		expect(AGENT_ACTION_TOOL_NAMES.has('create_note')).toBe(true)
		expect(AGENT_ACTION_TOOL_NAMES.has('search_library')).toBe(false)
	})
})
