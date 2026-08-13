// Hybrid retrieval: FTS5 BM25 (exact terms -- compound names, authors) fused
// with vector KNN (paraphrase, cross-lingual) via Reciprocal Rank Fusion.
// RRF works on ranks, not raw scores, so the two incompatible score spaces
// never need normalizing.
import { getKnowledgeDb, isVecAvailable, getMeta } from './db'
import { getEmbeddingConfig, embedBatch } from './providers'
import { rerankHits } from './rerank'

export interface SearchHit {
	chunkId: number
	itemId: number
	itemKey: string
	headingPath: string
	seq: number
	text: string
	score: number
}

const CANDIDATES = 30
const RRF_K = 60
const RERANK_POOL = 20   // fused candidates handed to the reranker; it returns topK

/** Fuse ranked id lists: score(id) = sum over lists of 1/(k + rank). Exported for tests. */
export function rrfFuse(rankLists: number[][], k = RRF_K): Map<number, number> {
	const scores = new Map<number, number>()
	for (const list of rankLists) {
		list.forEach((id, rank) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
		})
	}
	return scores
}

/** FTS5 MATCH is a query language; quote each token so user input can't break it. */
export function toFtsQuery(q: string): string {
	const tokens = q.split(/\s+/).map((t) => t.replace(/"/g, '')).filter(Boolean)
	if (!tokens.length) return '""'
	return tokens.map((t) => `"${t}"`).join(' OR ')
}

function ftsSearch(wsId: number, query: string): number[] {
	const kdb = getKnowledgeDb()
	try {
		return (kdb.prepare(`
			SELECT f.rowid AS id
			FROM fts_chunks f
			JOIN chunks c ON c.id = f.rowid
			WHERE fts_chunks MATCH ? AND c.workspace_id = ?
			ORDER BY bm25(fts_chunks)
			LIMIT ${CANDIDATES}
		`).all(toFtsQuery(query), wsId) as { id: number }[]).map((r) => r.id)
	} catch {
		return []   // malformed query after sanitizing shouldn't kill the search
	}
}

async function vectorSearch(wsId: number, query: string): Promise<number[]> {
	const cfg = getEmbeddingConfig()
	if (!cfg) return []
	// Vectors indexed under a different model are incomparable garbage.
	if (getMeta('embedding.model') !== cfg.model) return []

	let qvec: Float32Array
	try {
		const [v] = await embedBatch(cfg, [query])
		qvec = new Float32Array(v)
	} catch {
		return []   // offline: FTS side still answers
	}

	const kdb = getKnowledgeDb()
	if (isVecAvailable()) {
		try {
			// Over-fetch, then filter to the workspace (vec0 can't pre-filter).
			const rows = kdb.prepare(`
				SELECT rowid AS id, distance FROM vec_chunks
				WHERE embedding MATCH ? ORDER BY distance LIMIT ${CANDIDATES * 4}
			`).all(qvec) as { id: number | bigint; distance: number }[]
			const ids = rows.map((r) => Number(r.id))
			if (!ids.length) return []
			const inWs = new Set((kdb.prepare(
				`SELECT id FROM chunks WHERE workspace_id = ? AND id IN (${ids.join(',')})`
			).all(wsId) as { id: number }[]).map((r) => r.id))
			return ids.filter((id) => inWs.has(id)).slice(0, CANDIDATES)
		} catch (err) {
			console.warn('[knowledge] vec search failed:', err)
			return []
		}
	}

	// JS cosine fallback over BLOB embeddings (fine below a few thousand papers)
	const rows = kdb.prepare(
		'SELECT id, embedding FROM chunks WHERE workspace_id = ? AND embedded = 1 AND embedding IS NOT NULL'
	).all(wsId) as { id: number; embedding: Buffer }[]
	const scored = rows.map((r) => {
		const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
		let dot = 0, na = 0, nb = 0
		const n = Math.min(v.length, qvec.length)
		for (let i = 0; i < n; i++) { dot += v[i] * qvec[i]; na += v[i] * v[i]; nb += qvec[i] * qvec[i] }
		return { id: r.id, s: dot / (Math.sqrt(na) * Math.sqrt(nb) || 1) }
	})
	return scored.sort((a, b) => b.s - a.s).slice(0, CANDIDATES).map((r) => r.id)
}

export interface ChunkLocation { headingPath: string; text: string }

/** Look up a single chunk's heading + raw text by (item, seq). Used to scroll a
 *  clicked citation to its exact spot in the markdown reader. */
export function getChunkBySeq(wsId: number, itemKey: string, seq: number): ChunkLocation | null {
	const row = getKnowledgeDb().prepare(
		'SELECT heading_path, text FROM chunks WHERE workspace_id = ? AND item_key = ? AND seq = ?'
	).get(wsId, itemKey, seq) as { heading_path: string; text: string } | undefined
	return row ? { headingPath: row.heading_path, text: row.text } : null
}

export async function hybridSearch(wsId: number, query: string, topK = 8): Promise<SearchHit[]> {
	const [ftsIds, vecIds] = await Promise.all([
		Promise.resolve(ftsSearch(wsId, query)),
		vectorSearch(wsId, query),
	])
	const fused = rrfFuse([ftsIds, vecIds])
	// Over-select a rerank pool; the reranker narrows it to topK. If reranking is
	// unavailable it falls back to this RRF order, so behaviour degrades safely.
	const pool = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, RERANK_POOL)
	if (!pool.length) return []

	const kdb = getKnowledgeDb()
	const rows = kdb.prepare(
		`SELECT id, item_id, item_key, heading_path, seq, text FROM chunks WHERE id IN (${pool.map(([id]) => id).join(',')})`
	).all() as { id: number; item_id: number; item_key: string; heading_path: string; seq: number; text: string }[]
	const byId = new Map(rows.map((r) => [r.id, r]))
	const candidates = pool.flatMap(([id, score]) => {
		const r = byId.get(id)
		return r ? [{
			chunkId: r.id, itemId: r.item_id, itemKey: r.item_key,
			headingPath: r.heading_path, seq: r.seq, text: r.text, score,
		}] : []
	})
	return rerankHits(query, candidates, topK)
}
