import type { SearchHit } from './search'

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
