import { randomUUID } from 'crypto'
import { getDb } from './index'

export interface Collection {
  id: number
  library_id: number
  parent_id: number | null
  name: string
  key: string
}

export function getAllCollections(libraryId = 1): Collection[] {
  return getDb()
    .prepare('SELECT * FROM collections WHERE library_id = ? ORDER BY name')
    .all(libraryId) as Collection[]
}

export function createCollection(name: string, libraryId = 1, parentId?: number): Collection {
  const key = randomUUID()
  getDb().prepare(`
    INSERT INTO collections (library_id, parent_id, name, key)
    VALUES (@library_id, @parent_id, @name, @key)
  `).run({ library_id: libraryId, parent_id: parentId ?? null, name, key })
  return getDb().prepare('SELECT * FROM collections WHERE key = ?').get(key) as Collection
}

export function renameCollection(id: number, name: string): void {
  getDb().prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, id)
}

export function deleteCollection(id: number): void {
  getDb().prepare('DELETE FROM collections WHERE id = ?').run(id)
}

export function addItemToCollection(collectionId: number, itemId: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO collection_items (collection_id, item_id) VALUES (?, ?)')
    .run(collectionId, itemId)
}

export function removeItemFromCollection(collectionId: number, itemId: number): void {
  getDb()
    .prepare('DELETE FROM collection_items WHERE collection_id = ? AND item_id = ?')
    .run(collectionId, itemId)
}

export function getItemsByCollection(collectionId: number) {
  return getDb().prepare(`
    SELECT i.* FROM items i
    JOIN collection_items ci ON ci.item_id = i.id
    WHERE ci.collection_id = ?
    ORDER BY i.updated_at DESC
  `).all(collectionId)
}
