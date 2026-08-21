// Shared storage primitives. Relocation across the app is "move", never
// "copy and forget": the old copy-and-repoint behaviour left a full duplicate
// of every PDF and every conversion package behind on the system drive.
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, sep } from 'path'

/**
 * Is `p` the directory `dir` itself, or something inside it?
 *
 * Bounded at a path separator on purpose: a bare `startsWith` would let
 * `<root>/10` look like it lives in `<root>/1`, and `C:\lib-backup` look like
 * it lives in `C:\lib` -- both of which would mis-target a deletion.
 */
export function isInside(p: string, dir: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return p === dir || p === dir.replace(/[\\/]+$/, '') || p.startsWith(prefix)
}

/**
 * Move a file or directory onto `dest`, replacing anything already there.
 *
 * Same volume takes renameSync (atomic and instant -- which is why staging
 * lives next to its destination). Across volumes renameSync raises EXDEV, so
 * fall back to copy-then-remove.
 *
 * Returns false on failure, and on failure THE SOURCE IS LEFT INTACT: callers
 * treat that as "not relocated" and keep pointing at the source, so a failed
 * move can never destroy the only copy.
 */
export function moveInto(src: string, dest: string): boolean {
  // Never disturb the destination until the source is known to be there: the
  // destination removal below is irreversible, and callers treat a false
  // return as "nothing changed".
  if (!existsSync(src)) {
    console.warn(`[storage] move skipped, source is missing: ${src}`)
    return false
  }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    try {
      renameSync(src, dest)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true })
      else copyFileSync(src, dest)
      // The payload is safely at dest now; a source we fail to unlink is mere
      // leftover for the GC, not a reason to report failure.
      try { rmSync(src, { recursive: true, force: true }) } catch { /* GC reclaims it */ }
    }
    return true
  } catch (err) {
    console.warn(`[storage] move failed (${src} -> ${dest}):`, (err as Error).message)
    return false
  }
}
