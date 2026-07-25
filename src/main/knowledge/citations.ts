// Citation marker parsing -- pure, testable without Electron.
// The agent's system prompt asks for inline [^item_key:seq] markers.

export interface RawCitation { itemKey: string; seq: number }

export function extractCitations(text: string): RawCitation[] {
	const out: RawCitation[] = []
	const seen = new Set<string>()
	for (const m of text.matchAll(/\[\^([A-Za-z0-9_-]+):(\d+)\]/g)) {
		const k = `${m[1]}:${m[2]}`
		if (seen.has(k)) continue
		seen.add(k)
		out.push({ itemKey: m[1], seq: Number(m[2]) })
	}
	return out
}
