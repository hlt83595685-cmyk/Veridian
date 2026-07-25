import { describe, it, expect } from 'vitest'
import { extractCitations } from './citations'

describe('extractCitations', () => {
	it('parses inline markers', () => {
		expect(extractCitations('X is 5 [^AB12CD34:5] and Y is 6 [^ZZ99:0].')).toEqual([
			{ itemKey: 'AB12CD34', seq: 5 },
			{ itemKey: 'ZZ99', seq: 0 },
		])
	})
	it('deduplicates repeated markers', () => {
		expect(extractCitations('[^K1:1] again [^K1:1]')).toHaveLength(1)
	})
	it('ignores plain footnotes and malformed markers', () => {
		expect(extractCitations('[^1] [^key:] [key:2]')).toEqual([])
	})
})
