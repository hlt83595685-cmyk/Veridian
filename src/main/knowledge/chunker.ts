// Markdown chunker for the knowledge index. Pure function, no I/O.
//
// Strategy: split on ATX headings to keep semantic sections together, then
// slide a character window over any section that exceeds the budget. Char
// budget approximates ~500 tokens across mixed Chinese/English text (CJK is
// ~1 token/char, English ~4 chars/token -- 1500 chars is a safe middle).

export interface MdChunk {
	headingPath: string   // "Introduction > Methods", '' for preamble
	seq: number           // global order within the document, cited as [^key:seq]
	text: string
}

const MAX_CHARS = 1500
const OVERLAP_CHARS = 220

interface Section {
	headingPath: string
	body: string
}

function splitSections(md: string): Section[] {
	const lines = md.split('\n')
	const sections: Section[] = []
	const stack: { level: number; title: string }[] = []
	let buf: string[] = []

	const flush = (): void => {
		const body = buf.join('\n').trim()
		if (body) sections.push({ headingPath: stack.map((h) => h.title).join(' > '), body })
		buf = []
	}

	let inFence = false
	for (const line of lines) {
		if (/^(```|~~~)/.test(line.trim())) inFence = !inFence
		const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
		if (m) {
			flush()
			const level = m[1].length
			while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
			stack.push({ level, title: m[2].trim() })
		} else {
			buf.push(line)
		}
	}
	flush()
	return sections
}

/** Drop pure-image lines and inline HTML noise; keep prose intact. */
function cleanBody(body: string): string {
	return body
		.split('\n')
		.filter((l) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(l))
		.join('\n')
		.replace(/<\/?(?:table|tr|td|th|tbody|thead|html|body)[^>]*>/gi, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/** Split an oversized body on paragraph boundaries with a trailing overlap. */
function windowBody(body: string): string[] {
	if (body.length <= MAX_CHARS) return [body]
	const paras = body.split(/\n\n+/)
	const out: string[] = []
	let cur = ''
	for (const p of paras) {
		// A single paragraph larger than the budget gets hard-split.
		if (p.length > MAX_CHARS) {
			if (cur) { out.push(cur); cur = '' }
			for (let i = 0; i < p.length; i += MAX_CHARS - OVERLAP_CHARS) {
				out.push(p.slice(i, i + MAX_CHARS))
				if (i + MAX_CHARS >= p.length) break
			}
			continue
		}
		if (cur && cur.length + p.length + 2 > MAX_CHARS) {
			out.push(cur)
			cur = cur.slice(-OVERLAP_CHARS) + '\n\n' + p
		} else {
			cur = cur ? cur + '\n\n' + p : p
		}
	}
	if (cur) out.push(cur)
	return out
}

export function chunkMarkdown(md: string): MdChunk[] {
	const chunks: MdChunk[] = []
	let seq = 0
	for (const section of splitSections(md)) {
		const body = cleanBody(section.body)
		if (!body) continue
		for (const text of windowBody(body)) {
			// Prefix the heading path so the embedding carries section context.
			const prefixed = section.headingPath ? `${section.headingPath}\n${text}` : text
			chunks.push({ headingPath: section.headingPath, seq: seq++, text: prefixed })
		}
	}
	return chunks
}
