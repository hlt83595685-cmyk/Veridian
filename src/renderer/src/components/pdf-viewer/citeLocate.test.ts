import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../../../main/knowledge/chunker'
import { citationBody, citationPhrase, citationHeading, normalizeForMatch } from './citeLocate'

const sample = `# Introduction

Intro prose about transformers and attention mechanisms in detail.

## Methods

We trained the model using stochastic gradient descent on a large corpus.
`

describe('citeLocate against real chunker output', () => {
	const chunks = chunkMarkdown(sample)
	// Approximates the reader's syntax-free rendered text.
	const rendered = normalizeForMatch(sample)
	const methods = chunks.find((c) => c.headingPath.endsWith('Methods'))!

	it('chunker prefixes chunk text with the heading breadcrumb (why raw matching failed)', () => {
		expect(methods.text.startsWith(methods.headingPath)).toBe(true)
	})

	it('citationBody strips the breadcrumb prefix', () => {
		expect(citationBody(methods).trimStart()).toMatch(/^We trained the model/)
	})

	it('citationPhrase is body prose that exists in the rendered text, not the breadcrumb', () => {
		for (const c of chunks) {
			const phrase = citationPhrase(c)
			expect(phrase.length).toBeGreaterThanOrEqual(8)
			expect(rendered).toContain(phrase)
			expect(phrase.startsWith('introduction')).toBe(false)
		}
	})

	it('citationHeading returns the last breadcrumb segment', () => {
		expect(citationHeading(methods)).toBe('methods')
	})
})
