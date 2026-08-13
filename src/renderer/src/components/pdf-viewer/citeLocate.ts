// Pure helpers for locating a cited chunk inside the rendered markdown. Kept
// free of React/DOM so they can be unit-tested against real chunker output.

// Strip markdown punctuation and collapse whitespace so a chunk's raw text can
// be matched against the reader's rendered (syntax-free) text.
export function normalizeForMatch(s: string): string {
	return s.replace(/[#*_`~>|[\]()]/g, ' ').replace(/\s+/g, ' ').toLowerCase()
}

// The chunker stores each chunk prefixed with its heading breadcrumb
// ("A > B\n<body>"). Return just the body -- the breadcrumb never appears
// contiguously in the rendered document, so matching on it always fails.
export function citationBody(target: { text: string; headingPath: string }): string {
	return target.headingPath && target.text.startsWith(target.headingPath)
		? target.text.slice(target.headingPath.length)
		: target.text
}

// Normalized leading phrase used to find the chunk's start in the rendered text.
export function citationPhrase(target: { text: string; headingPath: string }): string {
	return normalizeForMatch(citationBody(target)).trim().slice(0, 30)
}

// The chunk's own section heading (last breadcrumb segment), used as a fallback
// scroll anchor when the body text can't be matched.
export function citationHeading(target: { headingPath: string }): string {
	return normalizeForMatch(target.headingPath.split('>').pop() ?? '').trim()
}
