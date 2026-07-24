import {
  getAttachmentsByItem, addAttachment as repoAdd,
  registerAttachment as repoRegister, registerAttachmentDir as repoRegisterDir,
  removeAttachment as repoRemove, getAttachmentPath,
  addAttachmentFromUrl as repoAddFromUrl,
  type Attachment,
} from '../db/attachments'
import { statSync } from 'fs'
import { basename } from 'path'
import { getDb } from '../db'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'
import { grantAccess } from '../security/pathGuard'

export function listByItem(itemId: number): Attachment[] {
  return getAttachmentsByItem(itemId)
}

export function attachmentPath(id: number): string | null {
  return getAttachmentPath(id)
}

export function addAttachment(itemId: number, srcPath: string): Attachment {
  const att = repoAdd(itemId, srcPath)
  appendOp('attachment', att.id, 'create', { itemId, path: att.path })
  grantAccess(srcPath)
  emit({ type: 'attachment.changed', itemIds: [itemId] })
  return att
}

function findByPath(itemId: number, path: string): Attachment | undefined {
  return getDb()
    .prepare('SELECT * FROM attachments WHERE item_id = ? AND path = ?')
    .get(itemId, path) as Attachment | undefined
}

// Conversion outputs are singletons per item: an item has AT MOST one
// markdown attachment and one imagedir. Path-based dedupe alone is not
// enough -- after a workspace sync relocates the attachment row into the
// repo, a re-conversion writes to a NEW local path and would insert a second
// row (which the exporter then dumps into the repo as foo-1.md / images-1).
// So: if a row of the same type exists anywhere, repoint it instead.
function findByType(itemId: number, type: string): Attachment | undefined {
  return getDb()
    .prepare('SELECT * FROM attachments WHERE item_id = ? AND type = ? ORDER BY id')
    .get(itemId, type) as Attachment | undefined
}

function repointRow(att: Attachment, newPath: string, filename: string): Attachment {
  let size: number | null = null
  try { size = statSync(newPath).isDirectory() ? null : statSync(newPath).size } catch { /* ignore */ }
  getDb().prepare('UPDATE attachments SET path = ?, filename = ?, size = ? WHERE id = ?')
    .run(newPath, filename, size, att.id)
  appendOp('attachment', att.id, 'modify', { itemId: att.item_id, path: newPath })
  return { ...att, path: newPath, filename, size }
}

// Register an existing file (conversion output) without copying. Re-running
// a conversion updates the item's single markdown row in place instead of
// stacking duplicate rows; still emits so the UI and workspace export pick
// up the new content.
export function registerAttachment(itemId: number, filePath: string): Attachment {
  const isMd = filePath.toLowerCase().endsWith('.md')
  const existing = isMd ? findByType(itemId, 'markdown') : findByPath(itemId, filePath)
  let att: Attachment
  if (existing) {
    att = existing.path === filePath
      ? existing
      : repointRow(existing, filePath, basename(filePath))
  } else {
    att = repoRegister(itemId, filePath)
    appendOp('attachment', att.id, 'create', { itemId, path: att.path })
  }
  emit({ type: 'attachment.changed', itemIds: [itemId] })
  return att
}

export function registerAttachmentDir(itemId: number, dirPath: string, displayName: string): Attachment {
  const existing = findByType(itemId, 'imagedir')
  let att: Attachment
  if (existing) {
    att = existing.path === dirPath ? existing : repointRow(existing, dirPath, displayName)
  } else {
    att = repoRegisterDir(itemId, dirPath, displayName)
    appendOp('attachment', att.id, 'create', { itemId, path: att.path, kind: 'imagedir' })
  }
  emit({ type: 'attachment.changed', itemIds: [itemId] })
  return att
}

export async function addAttachmentFromUrl(itemId: number, url: string): Promise<Attachment | null> {
  const att = await repoAddFromUrl(itemId, url)
  if (att) {
    if (att.path) grantAccess(att.path)
    appendOp('attachment', att.id, 'create', { itemId, url })
    emit({ type: 'attachment.changed', itemIds: [itemId] })
  }
  return att
}

export function removeAttachment(id: number): void {
  const row = getDb().prepare('SELECT item_id FROM attachments WHERE id = ?')
    .get(id) as { item_id: number } | undefined
  repoRemove(id)
  appendOp('attachment', id, 'delete')
  if (row) emit({ type: 'attachment.changed', itemIds: [row.item_id] })
}
