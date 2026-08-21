import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'

// The cross-volume path can't be provoked with real directories, so renameSync
// is stubbed to raise EXDEV on demand.
const h = vi.hoisted(() => ({ forceExdev: false }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (h.forceExdev) {
        const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        err.code = 'EXDEV'
        throw err
      }
      return actual.renameSync(from, to)
    },
  }
})

import { isInside, moveInto } from './storagePaths'

describe('isInside', () => {
  it('accepts the directory itself and its descendants', () => {
    expect(isInside(join('C:', 'lib'), join('C:', 'lib'))).toBe(true)
    expect(isInside(join('C:', 'lib', 'a.pdf'), join('C:', 'lib'))).toBe(true)
  })
  it('rejects a prefix-sharing sibling', () => {
    expect(isInside(join('C:', 'lib-backup', 'a.pdf'), join('C:', 'lib'))).toBe(false)
  })
  it('does not let staging dir 1 claim staging dir 10', () => {
    const root = join('C:', 'conv')
    expect(isInside(join(root, '10', 'full.md'), join(root, '1'))).toBe(false)
    expect(isInside(join(root, '1', 'full.md'), join(root, '1'))).toBe(true)
  })
  it('tolerates a trailing separator on the directory', () => {
    expect(isInside(join('C:', 'lib', 'a.pdf'), join('C:', 'lib') + sep)).toBe(true)
  })
})

describe('moveInto', () => {
  let root: string
  beforeEach(() => {
    h.forceExdev = false
    root = mkdtempSync(join(tmpdir(), 'veridian-move-'))
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('moves a file and removes the source', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'out', 'b.txt')
    writeFileSync(src, 'hello', 'utf-8')

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('hello')
  })

  it('moves a directory with nested contents', () => {
    const src = join(root, 'images')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'fig1.jpg'), 'x', 'utf-8')
    writeFileSync(join(src, 'sub', 'fig2.jpg'), 'y', 'utf-8')
    const dest = join(root, 'out', 'images')

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(join(dest, 'fig1.jpg'), 'utf-8')).toBe('x')
    expect(readFileSync(join(dest, 'sub', 'fig2.jpg'), 'utf-8')).toBe('y')
  })

  it('replaces whatever is already at the destination', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'b.txt')
    writeFileSync(src, 'new', 'utf-8')
    writeFileSync(dest, 'old', 'utf-8')

    expect(moveInto(src, dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe('new')
  })

  it('falls back to copy+remove across volumes (EXDEV)', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'out', 'b.txt')
    writeFileSync(src, 'hello', 'utf-8')
    h.forceExdev = true

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('hello')
  })

  it('returns false and leaves the source when the move fails', () => {
    const src = join(root, 'missing.txt')   // never created
    expect(moveInto(src, join(root, 'out.txt'))).toBe(false)
  })
})
