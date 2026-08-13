import { describe, it, expect } from 'vitest'
import { truncateAtBoundary } from './truncate'

describe('truncateAtBoundary', () => {
	it('returns short text unchanged', () => {
		expect(truncateAtBoundary('hello', 20)).toBe('hello')
	})
	it('cuts at the last sentence end within budget', () => {
		const t = 'First sentence. Second sentence. Third goes over the limit here.'
		expect(truncateAtBoundary(t, 40)).toBe('First sentence. Second sentence.')
	})
	it('cuts at a paragraph break', () => {
		const t = 'Para one has enough text here.\n\nPara two continues well past the limit boundary.'
		expect(truncateAtBoundary(t, 45)).toBe('Para one has enough text here.')
	})
	it('hard-cuts when no boundary in the second half', () => {
		expect(truncateAtBoundary('x'.repeat(100), 30)).toBe('x'.repeat(30))
	})
	it('handles CJK sentence enders', () => {
		const t = '第一句话。第二句话。第三句话超过了限制字数继续写下去。'
		expect(truncateAtBoundary(t, 12)).toBe('第一句话。第二句话。')
	})
})
