import { describe, it, expect } from 'vitest'
import { citationBody, citationPhrase, citationHeading, normalizeForMatch } from './citeLocate'

// Mimics the chunker's output shape: chunk.text is prefixed with its heading
// breadcrumb ("A > B\n<body>"). Kept as a literal so this renderer test does not
// import across into the main-process chunker (that cross-project import trips
// tsc's project boundary).
const methods = { headingPath: 'Introduction > Methods', text: 'Introduction > Methods\nWe trained the model using stochastic gradient descent on a large corpus.' }
const intro = { headingPath: 'Introduction', text: 'Introduction\nIntro prose about transformers and attention mechanisms in detail.' }
// Approximates the reader's syntax-free rendered text.
const rendered = normalizeForMatch('Introduction Intro prose about transformers and attention mechanisms in detail. Methods We trained the model using stochastic gradient descent on a large corpus.')

describe('citeLocate', () => {
	it('chunk text is prefixed with the heading breadcrumb (why raw matching failed)', () => {
		expect(methods.text.startsWith(methods.headingPath)).toBe(true)
	})
	it('citationBody strips the breadcrumb prefix', () => {
		expect(citationBody(methods).trimStart()).toMatch(/^We trained the model/)
	})
	it('citationPhrase is body prose that exists in the rendered text, not the breadcrumb', () => {
		for (const c of [methods, intro]) {
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
