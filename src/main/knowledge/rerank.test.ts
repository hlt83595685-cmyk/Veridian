import { describe, it, expect } from 'vitest'
import { parseRanking, reorderByRanking } from './rerank'
import type { SearchHit } from './search'

function hit(chunkId: number): SearchHit {
	return {
		chunkId, itemId: chunkId, itemKey: `K${chunkId}`,
		headingPath: '', seq: chunkId, text: `t${chunkId}`, score: 0,
	}
}

describe('parseRanking', () => {
	it('parses a bare JSON array', () => {
		expect(parseRanking('[2,0,1]')).toEqual([2, 0, 1])
	})
	it('extracts the array from surrounding prose', () => {
		expect(parseRanking('Here you go: [3, 1] done')).toEqual([3, 1])
	})
	it('drops non-integer entries', () => {
		expect(parseRanking('[0, 1.5, "x", 2]')).toEqual([0, 2])
	})
	it('returns [] on garbage', () => {
		expect(parseRanking('no array here')).toEqual([])
		expect(parseRanking('')).toEqual([])
	})
})

describe('reorderByRanking', () => {
	const hits = [hit(10), hit(11), hit(12)]

	it('reorders by the given indices', () => {
		expect(reorderByRanking([2, 0, 1], hits, 3).map((h) => h.chunkId)).toEqual([12, 10, 11])
	})
	it('ignores out-of-range and duplicate indices', () => {
		expect(reorderByRanking([5, 0, 0, 1], hits, 3).map((h) => h.chunkId)).toEqual([10, 11, 12])
	})
	it('backfills uncovered candidates in original order', () => {
		expect(reorderByRanking([1], hits, 3).map((h) => h.chunkId)).toEqual([11, 10, 12])
	})
	it('caps at topK', () => {
		expect(reorderByRanking([2, 0, 1], hits, 2).map((h) => h.chunkId)).toEqual([12, 10])
	})
	it('empty order == fused top-K', () => {
		expect(reorderByRanking([], hits, 2).map((h) => h.chunkId)).toEqual([10, 11])
	})
})
