import { getDb } from './index'

export interface Tag {
  id: number
  name: string
}

export function getTagsByItem(itemId: number): Tag[] {
  return getDb().prepare(`
    SELECT t.* FROM tags t
    JOIN item_tags it ON it.tag_id = t.id
    WHERE it.item_id = ?
    ORDER BY t.name
  `).all(itemId) as Tag[]
}

export function getAllTags(): Tag[] {
  return getDb().prepare('SELECT * FROM tags ORDER BY name').all() as Tag[]
}

export function setTagsForItem(itemId: number, tagNames: string[]): void {
  const db = getDb()
  const deleteLinks = db.prepare('DELETE FROM item_tags WHERE item_id = ?')
  const upsertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)')
  const getTag = db.prepare('SELECT id FROM tags WHERE name = ?')
  const linkTag = db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)')

  db.transaction(() => {
    deleteLinks.run(itemId)
    for (const name of tagNames) {
      upsertTag.run(name)
      const row = getTag.get(name) as { id: number }
      linkTag.run(itemId, row.id)
    }
  })()
}

export function deleteOrphanTags(): void {
  getDb().prepare(`
    DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM item_tags)
  `).run()
}
