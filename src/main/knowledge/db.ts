// knowledge.db -- a separate SQLite file holding the RAG index (chunks +
// vectors + FTS) and chat history. Kept apart from the main library DB because
// it is bulky, fully rebuildable, and its location is user-configurable
// (settings key knowledge.storagePath).
//
// Vector search: sqlite-vec's vec0 virtual table. The embedding dimension is
// only known after the first successful embedding call (it depends on which
// cloud model the user picked), so vec_chunks is created lazily and its
// dimension + model are pinned in the meta table. Switching embedding models
// requires a rebuild -- callers detect the mismatch via getIndexMeta().
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { app } from 'electron'
import { getSetting } from '../services/SettingsService'

let db: Database.Database | null = null
let vecAvailable = false

export function knowledgeDir(): string {
	const configured = getSetting('knowledge.storagePath')
	const dir = typeof configured === 'string' && configured.trim()
		? configured
		: join(app.getPath('userData'), 'knowledge')
	mkdirSync(dir, { recursive: true })
	return dir
}

export function isVecAvailable(): boolean {
	getKnowledgeDb()
	return vecAvailable
}

export function getKnowledgeDb(): Database.Database {
	if (db) return db
	db = new Database(join(knowledgeDir(), 'knowledge.db'))
	db.pragma('journal_mode = WAL')

	try {
		sqliteVec.load(db)
		vecAvailable = true
	} catch (err) {
		// Fallback path: hybrid search degrades to FTS-only + JS cosine over
		// embeddings stored in chunks.embedding (BLOB).
		console.warn('[knowledge] sqlite-vec load failed, falling back to JS cosine:', err)
		vecAvailable = false
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS meta (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS chunks (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id INTEGER NOT NULL,          -- 0 = personal library
			item_id      INTEGER NOT NULL,
			item_key     TEXT NOT NULL,
			heading_path TEXT NOT NULL DEFAULT '',
			seq          INTEGER NOT NULL,
			text         TEXT NOT NULL,
			content_hash TEXT NOT NULL,             -- md5 of the source Full.md
			embedded     INTEGER NOT NULL DEFAULT 0, -- 0 until vector written
			embedding    BLOB                        -- used only when vec0 unavailable
		);
		CREATE INDEX IF NOT EXISTS idx_chunks_ws_item ON chunks(workspace_id, item_id);
		CREATE INDEX IF NOT EXISTS idx_chunks_hash    ON chunks(workspace_id, item_key, content_hash);
		-- Standalone FTS5 (not external-content): rowid mirrors chunks.id, and
		-- plain DELETE-by-rowid works during incremental reindex. The text is
		-- stored twice, but the index is disposable by design.
		CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
			text, tokenize='unicode61'
		);
		CREATE TABLE IF NOT EXISTS conversations (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			workspace_id INTEGER NOT NULL,
			title        TEXT NOT NULL,
			created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
			scope_collection_id INTEGER
		);
		CREATE TABLE IF NOT EXISTS messages (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			role            TEXT NOT NULL,           -- 'user' | 'assistant'
			content         TEXT NOT NULL,
			citations       TEXT NOT NULL DEFAULT '[]',  -- JSON [{itemKey,seq,title}]
			created_at      INTEGER NOT NULL DEFAULT (unixepoch())
		);
	`)

	// Additive migration: older DBs have `conversations` without this column.
	const convCols = db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]
	if (!convCols.some((c) => c.name === 'scope_collection_id')) {
		db.exec('ALTER TABLE conversations ADD COLUMN scope_collection_id INTEGER')
	}

	return db
}

export function closeKnowledgeDb(): void {
	db?.close()
	db = null
	vecAvailable = false
}

// ── meta helpers ─────────────────────────────────────────────────────────────

export function getMeta(key: string): string | null {
	const row = getKnowledgeDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
		| { value: string } | undefined
	return row?.value ?? null
}

export function setMeta(key: string, value: string): void {
	getKnowledgeDb()
		.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
		.run(key, value)
}

/**
 * Ensure the vec0 table exists with the given dimension. If a table with a
 * different dimension (or different model) already exists the index must be
 * rebuilt -- returns false in that case, true when ready to insert.
 */
export function ensureVecTable(model: string, dim: number): boolean {
	const d = getKnowledgeDb()
	if (!vecAvailable) {
		// BLOB fallback keys compatibility on the meta record only
		const m = getMeta('embedding.model')
		if (m && m !== model) return false
		setMeta('embedding.model', model)
		setMeta('embedding.dim', String(dim))
		return true
	}
	const existingModel = getMeta('embedding.model')
	const existingDim = getMeta('embedding.dim')
	if (existingModel !== null && (existingModel !== model || existingDim !== String(dim))) return false
	d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}])`)
	setMeta('embedding.model', model)
	setMeta('embedding.dim', String(dim))
	return true
}

/** Wipe the whole index (chunks + vectors + fts), keep conversations. */
export function clearIndex(): void {
	const d = getKnowledgeDb()
	d.exec(`
		DELETE FROM chunks;
		DELETE FROM fts_chunks;
		DELETE FROM meta WHERE key LIKE 'embedding.%';
	`)
	if (vecAvailable) d.exec('DROP TABLE IF EXISTS vec_chunks')
}
