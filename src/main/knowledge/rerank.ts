import type { SearchHit } from './search'
import { getChatConfig, chatStream } from './providers'

const PASSAGE_CHARS = 500
const RERANK_TIMEOUT_MS = 15_000

const RERANK_SYSTEM =
	'You are a search re-ranker. Given a query and a numbered list of passages, ' +
	'order the passages from most to least relevant to the query. ' +
	'Output ONLY a JSON array of the passage numbers, most relevant first, e.g. [3,0,1]. No prose.'

/** Pull the first JSON integer array out of the model's reply. Tolerates prose
 *  around it; non-integers are dropped. Returns [] when nothing parses. */
export function parseRanking(content: string): number[] {
	const m = content.match(/\[[\s\S]*?\]/)
	if (!m) return []
	let arr: unknown
	try { arr = JSON.parse(m[0]) } catch { return [] }
	if (!Array.isArray(arr)) return []
	return arr.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
}

/** Reorder `hits` by `order` (indices into hits). Out-of-range/duplicate indices
 *  are skipped; candidates the model never mentioned are appended in their
 *  original (RRF) order. Always returns at most `topK` items and never drops a
 *  candidate that would fit -- so an empty/garbage order degrades to the RRF
 *  top-K, matching pre-rerank behaviour. */
export function reorderByRanking(order: number[], hits: SearchHit[], topK: number): SearchHit[] {
	const seen = new Set<number>()
	const out: SearchHit[] = []
	for (const idx of order) {
		if (idx < 0 || idx >= hits.length || seen.has(idx)) continue
		seen.add(idx)
		out.push(hits[idx])
		if (out.length >= topK) return out
	}
	for (let i = 0; i < hits.length && out.length < topK; i++) {
		if (!seen.has(i)) out.push(hits[i])
	}
	return out
}

/** Re-rank RRF candidates with the configured chat model (listwise, single call).
 *  Any failure -- no chat model, offline, timeout, unparseable reply -- silently
 *  falls back to the RRF top-K, so retrieval never breaks. */
export async function rerankHits(query: string, hits: SearchHit[], topK: number): Promise<SearchHit[]> {
	if (hits.length <= topK) return hits.slice(0, topK)
	const cfg = getChatConfig()
	if (!cfg) return hits.slice(0, topK)

	const list = hits
		.map((h, i) => `[${i}] (${h.headingPath || 'text'}) ${h.text.slice(0, PASSAGE_CHARS)}`)
		.join('\n\n')
	const messages = [
		{ role: 'system' as const, content: RERANK_SYSTEM },
		{ role: 'user' as const, content: `Query: ${query}\n\nPassages:\n${list}` },
	]

	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), RERANK_TIMEOUT_MS)
	try {
		const res = await chatStream(cfg, messages, [], () => {}, ctrl.signal)
		return reorderByRanking(parseRanking(res.content), hits, topK)
	} catch {
		return hits.slice(0, topK)
	} finally {
		clearTimeout(timer)
	}
}
