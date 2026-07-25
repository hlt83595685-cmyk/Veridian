import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from './chunker'

describe('chunkMarkdown', () => {
	it('returns empty for empty input', () => {
		expect(chunkMarkdown('')).toEqual([])
		expect(chunkMarkdown('\n\n')).toEqual([])
	})

	it('tracks nested heading paths', () => {
		const md = '# Intro\nhello world\n## Methods\nsome method text\n# Results\nfindings'
		const chunks = chunkMarkdown(md)
		expect(chunks.map((c) => c.headingPath)).toEqual(['Intro', 'Intro > Methods', 'Results'])
		expect(chunks[1].text).toContain('some method text')
		expect(chunks[1].text.startsWith('Intro > Methods')).toBe(true)
	})

	it('resets heading stack when a sibling heading appears', () => {
		const md = '## A\nx\n## B\ny'
		const paths = chunkMarkdown(md).map((c) => c.headingPath)
		expect(paths).toEqual(['A', 'B'])
	})

	it('assigns sequential global seq', () => {
		const md = '# A\naaa\n# B\nbbb\n# C\nccc'
		expect(chunkMarkdown(md).map((c) => c.seq)).toEqual([0, 1, 2])
	})

	it('splits oversized sections with overlap', () => {
		const para = 'word '.repeat(120).trim()          // ~600 chars
		const md = `# Big\n${para}\n\n${para}\n\n${para}\n\n${para}`
		const chunks = chunkMarkdown(md)
		expect(chunks.length).toBeGreaterThan(1)
		for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1500 + 'Big\n'.length)
		// Overlap: the tail of chunk N appears at the head of chunk N+1
		const tail = chunks[0].text.slice(-50)
		expect(chunks[1].text).toContain(tail.slice(0, 30))
	})

	it('drops standalone image lines but keeps prose', () => {
		const md = '# S\nbefore\n\n![fig1](images/fig1.png)\n\nafter'
		const [c] = chunkMarkdown(md)
		expect(c.text).toContain('before')
		expect(c.text).toContain('after')
		expect(c.text).not.toContain('fig1.png')
	})

	it('does not treat # inside code fences as headings', () => {
		const md = '# Real\n```\n# not a heading\n```\ntail'
		const chunks = chunkMarkdown(md)
		expect(chunks).toHaveLength(1)
		expect(chunks[0].headingPath).toBe('Real')
		expect(chunks[0].text).toContain('# not a heading')
	})

	it('handles Chinese text within budget', () => {
		const md = `# 引言\n${'中文内容。'.repeat(200)}`   // 1000 chars
		const chunks = chunkMarkdown(md)
		expect(chunks).toHaveLength(1)
	})
})
