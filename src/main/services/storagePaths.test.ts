import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { join, sep } from 'path'
import { tmpdir } from 'os'

// The cross-volume path can't be provoked with real directories, so renameSync
// is stubbed to raise EXDEV on demand. copyFileSync can likewise be stubbed to
// fail on demand, to provoke a staging failure with a pre-existing destination
// (a real cross-platform trigger for that, e.g. a locked file, isn't reliable
// to construct in a test). rmSync is stubbed to fail for one specific path
// (set via h.failClearDest), simulating a destination locked by another
// process without disturbing the tmp/src cleanups rmSync is also used for.
const h = vi.hoisted(() => ({
  forceExdev: false,
  forceCopyFail: false,
  failClearDest: null as string | null,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (h.forceExdev) {
        // Only the first rename (src -> temp) crosses volumes in the
        // scenario being simulated; the temp path is constructed beside
        // dest, so the later temp -> dest swap is same-volume for real. The
        // flag is consumed on first use so that swap goes through normally.
        h.forceExdev = false
        const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
        err.code = 'EXDEV'
        throw err
      }
      return actual.renameSync(from, to)
    },
    copyFileSync: (from: string, to: string): void => {
      if (h.forceCopyFail) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return actual.copyFileSync(from, to)
    },
    rmSync: (path: string, options?: unknown): void => {
      if (h.failClearDest && path === h.failClearDest) {
        const err = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException
        err.code = 'EBUSY'
        throw err
      }
      return actual.rmSync(path, options as Parameters<typeof actual.rmSync>[1])
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
  it('ignores case, since Windows paths do', () => {
    // The two sides reach callers from different sources -- one read back from
    // the database, one just built with join -- and a false negative here would
    // let a deletion run over a file that really is inside.
    expect(isInside(join('C:', 'Lib', 'A.pdf'), join('c:', 'lib'))).toBe(true)
    expect(isInside(join('C:', 'LIB'), join('c:', 'lib'))).toBe(true)
  })
  it('still rejects a prefix-sharing sibling regardless of case', () => {
    expect(isInside(join('C:', 'LIB-backup', 'a.pdf'), join('c:', 'lib'))).toBe(false)
  })
})

describe('moveInto', () => {
  let root: string
  beforeEach(() => {
    h.forceExdev = false
    h.forceCopyFail = false
    h.failClearDest = null
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

  it('moves a directory across volumes via the recursive-copy fallback', () => {
    // The images/ directory of a conversion takes this path whenever the
    // scratch area and the library folder sit on different drives, so the
    // recursive branch of the EXDEV fallback needs its own coverage.
    const src = join(root, 'images')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'fig1.jpg'), 'x', 'utf-8')
    writeFileSync(join(src, 'sub', 'fig2.jpg'), 'y', 'utf-8')
    const dest = join(root, 'out', 'images')
    h.forceExdev = true

    expect(moveInto(src, dest)).toBe(true)
    expect(existsSync(src)).toBe(false)
    expect(readFileSync(join(dest, 'fig1.jpg'), 'utf-8')).toBe('x')
    expect(readFileSync(join(dest, 'sub', 'fig2.jpg'), 'utf-8')).toBe('y')
    expect(readdirSync(join(root, 'out')).filter((f) => f.includes('veridian-move'))).toEqual([])
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

  it('leaves an existing destination untouched when the source is missing', () => {
    const src = join(root, 'missing.txt')          // never created
    const dest = join(root, 'keep.txt')
    writeFileSync(dest, 'precious', 'utf-8')

    expect(moveInto(src, dest)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('precious')
  })

  it('leaves an existing destination intact when the source cannot be moved', () => {
    // The implementation routes a directory source through cpSync, not
    // copyFileSync, so a directory source wouldn't actually provoke the
    // failure here -- it would succeed via cpSync. Use a file source and force
    // the copyFileSync fallback itself to fail, which genuinely exercises
    // "staging failed, destination untouched".
    const src = join(root, 'a.txt')
    writeFileSync(src, 'new', 'utf-8')
    const dest = join(root, 'keep.txt')
    writeFileSync(dest, 'precious', 'utf-8')
    h.forceExdev = true     // force the copy path
    h.forceCopyFail = true  // and make that copy fail

    expect(moveInto(src, dest)).toBe(false)
    expect(readFileSync(dest, 'utf-8')).toBe('precious')
    expect(readFileSync(src, 'utf-8')).toBe('new')
  })

  it('returns the payload to the source when the destination cannot be cleared', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'locked.txt')
    writeFileSync(src, 'payload', 'utf-8')
    writeFileSync(dest, 'old', 'utf-8')
    h.failClearDest = dest

    expect(moveInto(src, dest)).toBe(false)
    expect(readFileSync(src, 'utf-8')).toBe('payload')   // caller can still use it
    expect(readFileSync(dest, 'utf-8')).toBe('old')      // destination untouched
    expect(readdirSync(root).filter((f) => f.includes('veridian-move'))).toEqual([])
  })

  it('leaves no temp files behind on success', () => {
    const src = join(root, 'a.txt')
    const dest = join(root, 'out', 'b.txt')
    writeFileSync(src, 'hello', 'utf-8')

    expect(moveInto(src, dest)).toBe(true)
    expect(readdirSync(join(root, 'out')).filter((f) => f.includes('veridian-move'))).toEqual([])
  })
})
