import { describe, it, expect } from 'vitest'
import { summarizeSteps } from './retrievalTrace'
import type { RetrievalStep } from '../../../../shared/types'

const steps: RetrievalStep[] = [
	{ tool: 'search_library', label: 'q1', hits: [{ key: 'A', title: 'A', chars: 100 }, { key: 'B', title: 'B', chars: 200 }] },
	{ tool: 'read_context', label: 'A:2' },
	{ tool: 'search_library', label: 'q2', hits: [{ key: 'A', title: 'A', chars: 150 }, { key: 'C', title: 'C', chars: 120 }] },
]

describe('summarizeSteps', () => {
	it('counts searches and unique sources', () => {
		expect(summarizeSteps(steps)).toEqual({ searches: 2, sources: 3 })
	})
	it('handles empty', () => {
		expect(summarizeSteps([])).toEqual({ searches: 0, sources: 0 })
	})
})
