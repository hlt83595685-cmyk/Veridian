import { getTagsByItem, getAllTags, setTagsForItem as repoSet, deleteOrphanTags, type Tag } from '../db/tags'
import { getDb } from '../db'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export function listByItem(itemId: number): Tag[] {
  return getTagsByItem(itemId)
}

export function listAll(): Tag[] {
  return getAllTags()
}

export function setTagsForItem(itemId: number, tagNames: string[]): void {
  getDb().transaction(() => {
    repoSet(itemId, tagNames)
    deleteOrphanTags()
    appendOp('item', itemId, 'modify', { tags: tagNames })
  })()
  emit({ type: 'tag.changed', itemIds: [itemId] })
}

// Merge new keywords into existing tags without clobbering user-added ones
export function mergeTagsForItem(itemId: number, newNames: string[]): { added: number; total: number } {
  const existing = getTagsByItem(itemId).map((t) => t.name)
  const existingLower = new Set(existing.map((n) => n.toLowerCase()))
  const additions = newNames.filter((k) => !existingLower.has(k.toLowerCase()))
  if (additions.length === 0) return { added: 0, total: existing.length }
  setTagsForItem(itemId, [...existing, ...additions])
  return { added: additions.length, total: existing.length + additions.length }
}
