import { describe, it, expect } from 'vitest'
import { sanitizeTitle, uniqueDirName } from './WorkspaceFiles'

describe('sanitizeTitle', () => {
  it('strips Windows-illegal characters', () => {
    expect(sanitizeTitle('a/b:c*d?e"f<g>h|i\\j')).toBe('a b c d e f g h i j')
  })
  it('collapses whitespace and trims', () => {
    expect(sanitizeTitle('  hello    world  ')).toBe('hello world')
  })
  it('trims trailing dots and spaces', () => {
    expect(sanitizeTitle('report...  ')).toBe('report')
  })
  it('falls back to untitled for empty/null', () => {
    expect(sanitizeTitle('')).toBe('untitled')
    expect(sanitizeTitle(null)).toBe('untitled')
    expect(sanitizeTitle('   ')).toBe('untitled')
  })
  it('prefixes Windows reserved names', () => {
    expect(sanitizeTitle('CON')).toBe('_CON')
    expect(sanitizeTitle('lpt1')).toBe('_lpt1')
  })
  it('truncates to 100 chars', () => {
    expect(sanitizeTitle('x'.repeat(200)).length).toBeLessThanOrEqual(100)
  })
})

describe('uniqueDirName', () => {
  it('returns the base when free', () => {
    expect(uniqueDirName('paper', new Set())).toBe('paper')
  })
  it('appends -2 on first collision', () => {
    expect(uniqueDirName('paper', new Set(['paper']))).toBe('paper-2')
  })
  it('skips to the next free suffix', () => {
    expect(uniqueDirName('paper', new Set(['paper', 'paper-2']))).toBe('paper-3')
  })
})
