import { describe, it, expect } from 'vitest'
import { citeUrlTransform } from './citeUrl'

describe('citeUrlTransform', () => {
	it('preserves our private veridian-cite:// scheme (react-markdown would strip it)', () => {
		expect(citeUrlTransform('veridian-cite://ABCD/0')).toBe('veridian-cite://ABCD/0')
	})
	it('still sanitizes dangerous schemes', () => {
		expect(citeUrlTransform('javascript:alert(1)')).toBe('')
	})
	it('passes normal http(s) links through', () => {
		expect(citeUrlTransform('https://example.com')).toBe('https://example.com')
	})
})
