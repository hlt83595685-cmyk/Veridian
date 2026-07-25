import { describe, it, expect } from 'vitest'
import { rrfFuse, toFtsQuery } from './search'

describe('rrfFuse', () => {
	it('ranks items appearing in both lists above single-list items', () => {
		const fused = rrfFuse([[1, 2, 3], [2, 4, 5]])
		const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
		expect(sorted[0]).toBe(2)   // rank 2 + rank 1 beats everything single-listed
	})

	it('respects rank order within a single list', () => {
		const fused = rrfFuse([[7, 8, 9]])
		expect(fused.get(7)!).toBeGreaterThan(fused.get(8)!)
		expect(fused.get(8)!).toBeGreaterThan(fused.get(9)!)
	})

	it('handles empty lists', () => {
		expect(rrfFuse([[], []]).size).toBe(0)
		expect(rrfFuse([[1], []]).size).toBe(1)
	})
})

describe('toFtsQuery', () => {
	it('quotes tokens and ORs them', () => {
		expect(toFtsQuery('deep learning')).toBe('"deep" OR "learning"')
	})
	it('strips embedded quotes so user input cannot break MATCH syntax', () => {
		expect(toFtsQuery('a"b NEAR(x)')).toBe('"ab" OR "NEAR(x)"')
	})
	it('handles empty input', () => {
		expect(toFtsQuery('  ')).toBe('""')
	})
})
