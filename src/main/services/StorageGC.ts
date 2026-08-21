// One-off maintenance that runs at startup, before any conversion is queued.
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { getDb } from '../db'
import { getActiveWorkspace } from './WorkspaceContextService'
import { convertedDir, stagingRootDir } from './ConversionService'
import { isInside, moveInto } from './storagePaths'

/**
 * Libraries with no content root used to keep conversion output in the scratch
 * area permanently. Move those payloads into their real home so the scratch
 * area can be treated as scratch (and so the next conversion of an item with
 * the same id can't wipe them).
 */
export function migrateStagedPayloads(): number {
  if (getActiveWorkspace().repoRoot != null) return 0
  const db = getDb()
  const staging = stagingRootDir()
  const rows = db.prepare('SELECT id, item_id, path FROM attachments WHERE path IS NOT NULL')
    .all() as Array<{ id: number; item_id: number; path: string }>
  let moved = 0
  for (const r of rows) {
    if (!isInside(r.path, staging) || !existsSync(r.path)) continue
    const name = basename(r.path) === 'images' ? 'images' : (r.path.endsWith('.md') ? 'Full.md' : basename(r.path))
    const dest = join(convertedDir(r.item_id), name)
    if (!moveInto(r.path, dest)) continue
    db.prepare('UPDATE attachments SET path = ?, filename = ? WHERE id = ?').run(dest, name, r.id)
    moved++
  }
  return moved
}
