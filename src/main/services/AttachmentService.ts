import {
  getAttachmentsByItem, addAttachment as repoAdd,
  registerAttachment as repoRegister, registerAttachmentDir as repoRegisterDir,
  removeAttachment as repoRemove, getAttachmentPath,
  addAttachmentFromUrl as repoAddFromUrl,
  type Attachment,
} from '../db/attachments'
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

// Register an existing file (conversion output) without copying
export function registerAttachment(itemId: number, filePath: string): Attachment {
  const att = repoRegister(itemId, filePath)
  appendOp('attachment', att.id, 'create', { itemId, path: att.path })
  emit({ type: 'attachment.changed', itemIds: [itemId] })
  return att
}

export function registerAttachmentDir(itemId: number, dirPath: string, displayName: string): Attachment {
  const att = repoRegisterDir(itemId, dirPath, displayName)
  appendOp('attachment', att.id, 'create', { itemId, path: att.path, kind: 'imagedir' })
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
