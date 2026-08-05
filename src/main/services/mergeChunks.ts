// Pure planning logic for merging N per-chunk MinerU precision results into one.
// Each chunk is an independent parse job with its own images/ folder whose
// basenames can collide across chunks, so every chunk's referenced images get a
// c{i}_ namespace prefix before merge; the caller copies files accordingly and
// the downstream normalizeImages step re-numbers everything to figN. Pure (no
// fs) so it unit-tests under plain vitest -- mirrors markdownImages.ts.

export interface ChunkInput {
	md: string          // this chunk's full.md content
	images: string[]    // basenames present in this chunk's images dir
}

export interface ChunkImageCopy {
	chunk: number       // 0-based index into the chunks array
	from: string        // original basename in that chunk's images dir
	to: string          // namespaced basename in the merged images dir (c{i}_...)
}

export interface ChunkMergePlan {
	content: string             // merged markdown, chunks joined by \n\n---\n\n
	copies: ChunkImageCopy[]    // image files to copy into the merged images dir
}

// Markdown ![alt](path "title") and HTML <img src="path"> -- same as markdownImages.ts
const MD_REF = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g
const HTML_REF = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi

function isExternal(ref: string): boolean {
	return /^(https?:|data:|file:|veridian-file:)/i.test(ref)
}

function basenameOf(ref: string): string {
	const clean = ref.split(/[?#]/)[0]
	const parts = clean.split(/[\\/]/)
	return parts[parts.length - 1]
}

/**
 * Merge N chunk markdowns into one document, namespacing each chunk's referenced
 * images to c{i}_<name> so cross-chunk basename collisions can't clobber each
 * other. Only images actually referenced by a chunk's markdown are copied;
 * anything unreferenced is dropped (the same outcome normalizeImages would reach
 * downstream). Chunks are concatenated in array order, separated by a horizontal
 * rule -- consistent with the free Agent mode's merge.
 */
export function planChunkMerge(chunks: ChunkInput[]): ChunkMergePlan {
	const copies: ChunkImageCopy[] = []
	const parts: string[] = []

	chunks.forEach((chunk, i) => {
		const available = new Set(chunk.images)
		const mapping = new Map<string, string>()   // original basename -> c{i+1}_basename

		const assign = (ref: string): string | null => {
			if (isExternal(ref)) return null
			const base = basenameOf(ref)
			if (!available.has(base)) return null
			let target = mapping.get(base)
			if (!target) {
				target = `c${i + 1}_${base}`
				mapping.set(base, target)
				copies.push({ chunk: i, from: base, to: target })
			}
			return target
		}

		const rewrite = (text: string, re: RegExp): string =>
			text.replace(re, (whole, pre: string, ref: string, post: string) => {
				const target = assign(ref)
				return target === null ? whole : `${pre}images/${target}${post}`
			})

		let content = rewrite(chunk.md, MD_REF)
		content = rewrite(content, HTML_REF)
		parts.push(content)
	})

	return { content: parts.join('\n\n---\n\n'), copies }
}
