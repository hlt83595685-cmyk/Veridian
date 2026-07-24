// Fetches a GitHub user's avatar once and caches it under userData/avatars,
// then serves the local path (renderer loads it via veridian-file://). This
// avoids per-render network calls and any renderer CSP restriction on remote
// images. No expiry -- avatars rarely change; v1 keeps the first copy.
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { app, net } from 'electron'
import { grantAccess } from '../security/pathGuard'

function avatarsDir(): string {
  const dir = join(app.getPath('userData'), 'avatars')
  mkdirSync(dir, { recursive: true })
  return dir
}

// GitHub logins are [A-Za-z0-9-]; reject anything else so the login can't
// escape the avatars dir via path characters.
function safeLogin(login: string): string | null {
  return /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null
}

export async function getAvatarPath(login: string): Promise<string | null> {
  const safe = safeLogin(login)
  if (!safe) return null
  const dest = join(avatarsDir(), `${safe}.png`)
  if (existsSync(dest)) { grantAccess(dest); return dest }
  try {
    const res = await net.fetch(`https://github.com/${safe}.png?size=64`)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    writeFileSync(dest, buf)
    grantAccess(dest)
    return dest
  } catch {
    return null
  }
}
