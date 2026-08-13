import { describe, it, expect } from 'vitest'
import { hasCJK } from './queryTranslate'

describe('hasCJK', () => {
	it('detects Chinese', () => {
		expect(hasCJK('注意力机制')).toBe(true)
	})
	it('is false for pure ASCII/English', () => {
		expect(hasCJK('transformer attention')).toBe(false)
	})
	it('detects mixed Chinese + English', () => {
		expect(hasCJK('transformer 注意力')).toBe(true)
	})
	it('is false for empty', () => {
		expect(hasCJK('')).toBe(false)
	})
})
