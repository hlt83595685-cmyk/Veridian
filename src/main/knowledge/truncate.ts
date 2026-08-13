// Truncate a chunk excerpt to `max` chars without cutting mid-sentence/-table:
// prefer the last paragraph break, then the last sentence end; only if that
// boundary keeps at least half the budget, else hard-cut.
export function truncateAtBoundary(text: string, max: number): string {
	if (text.length <= max) return text
	const slice = text.slice(0, max)
	const para = slice.lastIndexOf('\n\n')
	if (para >= max * 0.5) return slice.slice(0, para).trimEnd()
	const m = slice.match(/[\s\S]*[。！？.!?\n]/)
	if (m && m[0].length >= max * 0.5) return m[0].trimEnd()
	return slice.trimEnd()
}
