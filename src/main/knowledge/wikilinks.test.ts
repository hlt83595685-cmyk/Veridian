import { describe, it, expect } from 'vitest'
import { extractWikiTargets } from './wikilinks'

describe('extractWikiTargets', () => {
	it('extracts a plain [[Title]]', () => {
		expect(extractWikiTargets('see [[Attention]] here')).toEqual(['Attention'])
	})

	it('strips alias and heading', () => {
		expect(extractWikiTargets('[[Transformer|the model]] and [[BERT#Intro]]')).toEqual(['Transformer', 'BERT'])
	})

	it('trims whitespace inside brackets', () => {
		expect(extractWikiTargets('[[  Spaced Title  ]]')).toEqual(['Spaced Title'])
	})

	it('dedupes case-insensitively, keeping first casing and order', () => {
		expect(extractWikiTargets('[[GPT]] then [[gpt]] then [[Adam]]')).toEqual(['GPT', 'Adam'])
	})

	it('ignores empty or whitespace-only targets', () => {
		expect(extractWikiTargets('[[]] and [[   ]] and [[#only-heading]]')).toEqual([])
	})

	it('returns [] when there are no wikilinks', () => {
		expect(extractWikiTargets('plain text with [single] brackets')).toEqual([])
	})

	it('handles multiple links across lines', () => {
		expect(extractWikiTargets('[[A]]\n[[B]]\n[[A|x]]')).toEqual(['A', 'B'])
	})
})
