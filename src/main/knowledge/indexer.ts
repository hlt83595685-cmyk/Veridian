// Index pipeline: Full.md -> chunks -> FTS (always, offline-safe) -> cloud
// embeddings (marked embedded=1 as they land; failures stay pending and are
// retried on the next scan). Driven by domain events, never by direct calls
// from ConversionService -- attachment.changed fires when a markdown
// attachment is registered, which is exactly the moment a Full.md appears.
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { getDb } from '../db'
import { getActiveWorkspace } from '../services/WorkspaceContextService'
import { subscribe, emit } from '../core/Notifier'
import { chunkMarkdown } from './chunker'
import { getKnowledgeDb, ensureVecTable, clearIndex, isVecAvailable, getMeta } from './db'
import { getEmbeddingConfig, embedBatch } from './providers'

const EMBED_BATCH = 32

let scanning = false
let rescanQueued = false
let debounceTimer: NodeJS.Timeout | null = null

interface MdItemRow {
	item_id: number
	key: string
	path: string
}

function activeWorkspaceId(): number {
	return getActiveWorkspace().id ?? 0   // 0 = personal library
}

/** All non-trashed items in the active library that own a markdown attachment. */
function listMarkdownItems(): MdItemRow[] {
	return getDb().prepare(`
		SELECT a.item_id, i.key, a.path
		FROM attachments a
		JOIN items i ON i.id = a.item_id
		WHERE a.type = 'markdown' AND i.deleted = 0 AND a.path IS NOT NULL
	`).all() as MdItemRow[]
}

function md5(s: string): string {
	return createHash('md5').update(s).digest('hex')
}

function progress(state: 'running' | 'done' | 'error', message: string, pending = 0): void {
	emit({
		type: 'job.progress',
		job: { id: 'knowledge-index', type: 'knowledge', label: 'AI index', state, message, pending },
	})
}

/**
 * Phase 1 for one item: (re)build chunk rows + FTS. Cheap and offline-safe.
 * Returns true if the item's chunks were (re)created, false if already fresh.
 */
function ensureChunks(wsId: number, row: MdItemRow): boolean {
	const kdb = getKnowledgeDb()
	let text: string
	try { text = readFileSync(row.path, 'utf-8') } catch { return false }
	const hash = md5(text)

	const fresh = kdb.prepare(
		'SELECT COUNT(*) AS n FROM chunks WHERE workspace_id = ? AND item_key = ? AND content_hash = ?'
	).get(wsId, row.key, hash) as { n: number }
	if (fresh.n > 0) return false

	const chunks = chunkMarkdown(text)
	const old = kdb.prepare('SELECT id FROM chunks WHERE workspace_id = ? AND item_key = ?')
		.all(wsId, row.key) as { id: number }[]

	const insertChunk = kdb.prepare(`
		INSERT INTO chunks (workspace_id, item_id, item_key, heading_path, seq, text, content_hash)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`)
	const insertFts = kdb.prepare('INSERT INTO fts_chunks (rowid, text) VALUES (?, ?)')
	const delChunk = kdb.prepare('DELETE FROM chunks WHERE id = ?')
	const delFts = kdb.prepare('DELETE FROM fts_chunks WHERE rowid = ?')

	kdb.transaction(() => {
		for (const o of old) {
			delChunk.run(o.id)
			delFts.run(o.id)
			if (isVecAvailable()) {
				try { kdb.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(o.id)) } catch { /* table may not exist yet */ }
			}
		}
		for (const c of chunks) {
			const info = insertChunk.run(wsId, row.item_id, row.key, c.headingPath, c.seq, c.text, hash)
			insertFts.run(info.lastInsertRowid, c.text)
		}
	})()
	return true
}

/** Phase 2: embed every chunk still missing a vector (network, may fail). */
async function embedPending(wsId: number): Promise<{ embedded: number; failed: boolean }> {
	const cfg = getEmbeddingConfig()
	if (!cfg) return { embedded: 0, failed: false }   // not configured: FTS-only mode

	const kdb = getKnowledgeDb()
	const pending = kdb.prepare(
		'SELECT id, text FROM chunks WHERE workspace_id = ? AND embedded = 0 ORDER BY id'
	).all(wsId) as { id: number; text: string }[]
	if (pending.length === 0) return { embedded: 0, failed: false }

	let done = 0
	for (let i = 0; i < pending.length; i += EMBED_BATCH) {
		const batch = pending.slice(i, i + EMBED_BATCH)
		let vectors: number[][]
		try {
			vectors = await embedBatch(cfg, batch.map((b) => b.text))
		} catch (err) {
			console.warn('[knowledge] embedding batch failed:', (err as Error).message)
			return { embedded: done, failed: true }
		}
		const dim = vectors[0]?.length ?? 0
		if (!dim) return { embedded: done, failed: true }
		if (!ensureVecTable(cfg.model, dim)) {
			// Model/dimension changed since the index was built: stop here; the
			// user is prompted to rebuild from settings.
			console.warn('[knowledge] embedding model changed -- rebuild required')
			return { embedded: done, failed: true }
		}

		const markEmbedded = kdb.prepare('UPDATE chunks SET embedded = 1 WHERE id = ?')
		const markWithBlob = kdb.prepare('UPDATE chunks SET embedded = 1, embedding = ? WHERE id = ?')
		kdb.transaction(() => {
			for (let j = 0; j < batch.length; j++) {
				const f32 = new Float32Array(vectors[j])
				if (isVecAvailable()) {
					kdb.prepare('INSERT OR REPLACE INTO vec_chunks (rowid, embedding) VALUES (?, ?)')
						.run(BigInt(batch[j].id), f32)
					markEmbedded.run(batch[j].id)
				} else {
					markWithBlob.run(Buffer.from(f32.buffer), batch[j].id)
				}
			}
		})()
		done += batch.length
		progress('running', `embedding ${done}/${pending.length}`, pending.length - done)
	}
	return { embedded: done, failed: false }
}

/** Full scan of the active workspace. Serialized; re-queues if called mid-run. */
export async function scanAndIndex(): Promise<void> {
	if (scanning) { rescanQueued = true; return }
	scanning = true
	try {
		const wsId = activeWorkspaceId()
		const rows = listMarkdownItems()
		let changed = 0
		for (const row of rows) {
			if (ensureChunks(wsId, row)) changed++
		}
		// Prune chunks whose item no longer has a markdown attachment (deleted /
		// trashed items drop out of listMarkdownItems).
		const kdb = getKnowledgeDb()
		const liveKeys = new Set(rows.map((r) => r.key))
		const stale = kdb.prepare('SELECT DISTINCT item_key FROM chunks WHERE workspace_id = ?')
			.all(wsId) as { item_key: string }[]
		for (const s of stale) {
			if (liveKeys.has(s.item_key)) continue
			const ids = kdb.prepare('SELECT id FROM chunks WHERE workspace_id = ? AND item_key = ?')
				.all(wsId, s.item_key) as { id: number }[]
			kdb.transaction(() => {
				for (const { id } of ids) {
					kdb.prepare('DELETE FROM chunks WHERE id = ?').run(id)
					kdb.prepare('DELETE FROM fts_chunks WHERE rowid = ?').run(id)
					if (isVecAvailable()) {
						try { kdb.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(id)) } catch { /* ok */ }
					}
				}
			})()
		}

		const { embedded, failed } = await embedPending(wsId)
		if (changed || embedded) emit({ type: 'knowledge.indexChanged' })
		progress(failed ? 'error' : 'done', failed ? 'embedding incomplete (will retry)' : '')
	} catch (err) {
		console.error('[knowledge] scan failed:', err)
		progress('error', (err as Error).message)
	} finally {
		scanning = false
		if (rescanQueued) {
			rescanQueued = false
			void scanAndIndex()
		}
	}
}

export async function rebuildIndex(): Promise<void> {
	clearIndex()
	emit({ type: 'knowledge.indexChanged' })
	await scanAndIndex()
}

export interface IndexStatus {
	items: number          // items with markdown in the active library
	indexedItems: number   // items with at least one chunk
	pendingChunks: number  // chunks awaiting embedding
	totalChunks: number
	embeddingModel: string | null
	vecAvailable: boolean
}

export function getIndexStatus(): IndexStatus {
	const wsId = activeWorkspaceId()
	const kdb = getKnowledgeDb()
	const total = (kdb.prepare('SELECT COUNT(*) AS n FROM chunks WHERE workspace_id = ?').get(wsId) as { n: number }).n
	const pending = (kdb.prepare('SELECT COUNT(*) AS n FROM chunks WHERE workspace_id = ? AND embedded = 0').get(wsId) as { n: number }).n
	const indexed = (kdb.prepare('SELECT COUNT(DISTINCT item_key) AS n FROM chunks WHERE workspace_id = ?').get(wsId) as { n: number }).n
	return {
		items: listMarkdownItems().length,
		indexedItems: indexed,
		pendingChunks: pending,
		totalChunks: total,
		embeddingModel: getMeta('embedding.model'),
		vecAvailable: isVecAvailable(),
	}
}

function scheduleScan(delayMs: number): void {
	if (debounceTimer) clearTimeout(debounceTimer)
	debounceTimer = setTimeout(() => { void scanAndIndex() }, delayMs)
}

export function initKnowledgeIndexer(): void {
	subscribe((e) => {
		// New markdown attachment (conversion finished / import) or a workspace
		// switch / remote pull replacing the whole data context.
		if (e.type === 'attachment.changed') scheduleScan(5_000)
		else if (e.type === 'workspace.dataRefreshed') scheduleScan(10_000)
		else if (e.type === 'settings.changed' && e.keys.some((k) => k.startsWith('knowledge.embedding'))) {
			scheduleScan(3_000)
		}
	})
	// Startup catch-up scan, delayed so app boot isn't competing with it.
	scheduleScan(15_000)
}
