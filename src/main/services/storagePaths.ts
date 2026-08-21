// Shared storage primitives. Relocation across the app is "move", never
// "copy and forget": the old copy-and-repoint behaviour left a full duplicate
// of every PDF and every conversion package behind on the system drive.
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, dirname, join, sep } from 'path'
import { randomUUID } from 'crypto'

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
 * Staged in three phases so `dest` is only ever touched once the
 * replacement payload is confirmed present on `dest`'s volume:
 *
 *   1. Stage: rename (or, across volumes on EXDEV, copy) `src` onto a temp
 *      path beside `dest`. Any failure here leaves `dest` completely
 *      untouched.
 *   2. Clear: remove whatever currently occupies `dest`. Only reached once
 *      the staged payload already exists on this volume. Any failure here
 *      (e.g. `dest` locked by another process) also leaves `dest` untouched
 *      -- the removal simply didn't happen.
 *   3. Swap: same-volume renameSync of the temp path onto `dest`
 *      (metadata-only, effectively atomic). If this somehow fails, `dest`
 *      has already been cleared -- rather than gamble on a synthesized
 *      rollback, the payload is left in place at its temp path and logged
 *      so it can be recovered by hand.
 *
 * Returns false on any failure. Outside of the step-3 edge case above, a
 * false return means `dest` is exactly as it was before the call -- callers
 * rely on that to know it's safe to keep pointing at the old location.
 */
export function moveInto(src: string, dest: string): boolean {
  // Never disturb the destination until the source is known to be there: the
  // destination removal below is irreversible, and callers treat a false
  // return as "nothing changed".
  if (!existsSync(src)) {
    console.warn(`[storage] move skipped, source is missing: ${src}`)
    return false
  }

  const destDir = dirname(dest)
  mkdirSync(destDir, { recursive: true })
  const tmp = join(destDir, `.${basename(dest)}.veridian-move-${randomUUID()}`)

  // Phase 1: stage the payload beside dest, on dest's volume. dest is not
  // touched by anything in this block.
  try {
    renameSync(src, tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') {
      console.warn(`[storage] move failed (${src} -> ${dest}):`, (err as Error).message)
      return false
    }
    try {
      if (statSync(src).isDirectory()) cpSync(src, tmp, { recursive: true })
      else copyFileSync(src, tmp)
    } catch (copyErr) {
      rmSync(tmp, { recursive: true, force: true })
      console.warn(`[storage] move failed (${src} -> ${dest}):`, (copyErr as Error).message)
      return false
    }
    // The payload is safely at tmp now; a source we fail to unlink is mere
    // leftover for the GC, not a reason to report failure.
    try { rmSync(src, { recursive: true, force: true }) } catch { /* GC reclaims it */ }
  }

  // Phase 2: clear dest now that the payload is confirmed on this volume.
  try {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    console.warn(`[storage] move failed, could not clear destination (${dest}):`, (err as Error).message)
    return false
  }

  // Phase 3: same-volume rename, metadata only.
  try {
    renameSync(tmp, dest)
  } catch (err) {
    console.error(
      `[storage] move could not complete the final swap -- payload left at temp path, recover manually: ${tmp}`,
      (err as Error).message
    )
    return false
  }

  return true
}
