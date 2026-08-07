import { describe, it, expect } from 'vitest'
import { join, dirname } from 'path'
import { normalizeContentRoot } from './contentRoot'

describe('normalizeContentRoot', () => {
  it('strips a trailing "papers" segment to its parent', () => {
    const root = join('C:', 'D', 'Veridian', 'Data', 'repo')
    expect(normalizeContentRoot(join(root, 'papers'))).toBe(root)
  })

  it('is case-insensitive on the papers segment', () => {
    const root = join('C:', 'lib')
    expect(normalizeContentRoot(join(root, 'Papers'))).toBe(root)
  })

  it('tolerates a trailing separator', () => {
    const root = join('C:', 'lib')
    expect(normalizeContentRoot(join(root, 'papers') + '\\')).toBe(root)
  })

  it('keeps a non-papers folder as-is', () => {
    const p = join('C:', 'D', 'Veridian', 'Data', 'repo')
    expect(normalizeContentRoot(p)).toBe(p)
  })

  it('normalizes redundant separators but preserves the folder', () => {
    const p = join('C:', 'lib', 'mine')
    expect(normalizeContentRoot(p)).toBe(p)
  })
})
