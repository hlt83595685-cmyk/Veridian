// Sorts image file paths by their figN numeric suffix (fig1, fig2, fig10...)
// so display order matches the markdown's actual figure order -- filename
// string sort would put fig10 before fig2. Files without a figN pattern sort
// after numbered ones, in their original relative order.
const FIG_RE = /fig(\d+)\.[^/\\]+$/i

function figNumber(path: string): number | null {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const m = base.match(FIG_RE)
  return m ? parseInt(m[1], 10) : null
}

export function sortByFigNumber(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const na = figNumber(a)
    const nb = figNumber(b)
    if (na !== null && nb !== null) return na - nb
    if (na !== null) return -1
    if (nb !== null) return 1
    return 0   // preserve relative order of two non-numbered entries
  })
}
