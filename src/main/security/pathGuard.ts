// File-access whitelist for every path that crosses the IPC boundary or the
// veridian-file:// protocol. realpathSync collapses `..` segments and symlinks
// BEFORE the prefix check, so traversal and link-based escapes both fail.
import { realpathSync } from 'fs'
import { resolve, sep, dirname } from 'path'
import { app } from 'electron'
import { getStoragePath } from '../services/SettingsService'

export class AccessDeniedError extends Error {
  constructor(p: string) {
    super(`Access denied: ${p}`)
    this.name = 'AccessDeniedError'
  }
}

// Extra roots registered at runtime (e.g. a PDF the user explicitly picked via
// a native dialog lives outside the storage root -- the dialog result is
// trusted because the user chose it, so its directory becomes readable).
const grantedRoots = new Set<string>()

export function grantAccess(fileOrDir: string): void {
  try {
    grantedRoots.add(realpathSync(resolve(fileOrDir)))
  } catch {
    // path may not exist yet (output file); grant its parent instead
    try { grantedRoots.add(realpathSync(resolve(dirname(fileOrDir)))) } catch { /* ignore */ }
  }
}

function allowedRoots(): string[] {
  const roots = [app.getPath('userData')]
  const storage = getStoragePath()
  if (storage) roots.push(storage)
  const out: string[] = []
  for (const r of roots) {
    try { out.push(realpathSync(r)) } catch { /* not created yet */ }
  }
  out.push(...grantedRoots)
  return out
}

function assertInside(p: string): string {
  let real: string
  try {
    real = realpathSync(resolve(p))
  } catch {
    throw new AccessDeniedError(p)
  }
  const ok = allowedRoots().some(
    (dir) => real === dir || real.startsWith(dir + sep)
  )
  if (!ok) throw new AccessDeniedError(p)
  return real
}

export function assertReadable(p: string): string {
  return assertInside(p)
}

export function assertWritable(p: string): string {
  // For writes the file itself may not exist yet -- validate its directory,
  // then return the intended absolute path.
  const abs = resolve(p)
  try {
    return assertInside(abs)
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      assertInside(dirname(abs))
      return abs
    }
    throw err
  }
}
