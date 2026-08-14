import type { RetrievalStep } from '../../../../shared/types'

/** Fold a turn's steps into the collapsed-summary numbers. */
export function summarizeSteps(steps: RetrievalStep[]): { searches: number; sources: number } {
	const keys = new Set<string>()
	let searches = 0
	for (const s of steps) {
		if (s.tool === 'search_library') searches++
		for (const h of s.hits ?? []) keys.add(h.key)
	}
	return { searches, sources: keys.size }
}
