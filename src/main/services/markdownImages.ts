// Pure planning logic for normalizing converted-markdown image references:
// every referenced image becomes images/figN.<ext> (N = order of first
// appearance) and the caller applies the returned renames to the image files
// on disk. Pure (no fs) so it unit-tests under plain vitest; the fs side
// (two-phase rename) lives in ConversionService.

export interface ImageRename {
  from: string   // original basename in the images dir
  to: string     // figN.<ext>
}

export interface RenamePlan {
  content: string          // markdown with refs rewritten to images/figN.ext
  renames: ImageRename[]   // apply these to the images dir (order-safe via two-phase)
}

// Markdown ![alt](path "title") and HTML <img src="path">
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
 * Scan `md` for image references whose basenames exist in `availableImages`
 * (basenames of files in the images dir). Assign fig1..figN by first
 * appearance, rewrite refs to `images/figN.ext`, and return the file renames.
 */
export function planImageRenames(md: string, availableImages: string[]): RenamePlan {
  const available = new Set(availableImages)
  const mapping = new Map<string, string>()   // original basename -> figN.ext
  let counter = 0

  const assign = (ref: string): string | null => {
    if (isExternal(ref)) return null
    const base = basenameOf(ref)
    if (!available.has(base)) return null
    let target = mapping.get(base)
    if (!target) {
      counter++
      const dot = base.lastIndexOf('.')
      const ext = dot > 0 ? base.slice(dot) : ''
      target = `fig${counter}${ext}`
      mapping.set(base, target)
    }
    return target
  }

  const rewrite = (text: string, re: RegExp): string =>
    text.replace(re, (whole, pre: string, ref: string, post: string) => {
      const target = assign(ref)
      return target === null ? whole : `${pre}images/${target}${post}`
    })

  let content = rewrite(md, MD_REF)
  content = rewrite(content, HTML_REF)

  const renames: ImageRename[] = [...mapping.entries()]
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => ({ from, to }))

  return { content, renames }
}
