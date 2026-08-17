// Obsidian-style wikilink parsing for notes. A link is [[Title]], optionally
// with a #heading and/or a |alias: [[Title#heading|alias]]. We only care about
// the Title (the link target); heading and alias are display concerns.
const WIKI_RE = /\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g

/** Extract distinct link target titles from note markdown, in first-seen order,
 *  de-duplicated case-insensitively (the first occurrence's casing is kept).
 *  Empty/whitespace-only targets (e.g. [[]] or [[#heading]]) are skipped. */
export function extractWikiTargets(md: string): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const m of md.matchAll(WIKI_RE)) {
		const title = m[1].trim()
		if (!title) continue
		const key = title.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		out.push(title)
	}
	return out
}
