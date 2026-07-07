// Single write path for items. Every mutation runs in a transaction, appends
// to the oplog, and emits a DomainEvent after commit -- UI refresh and future
// sync both hang off that event stream.
import { getDb } from '../db'
import {
  getAllItemsWithTags, getItemsByCollectionWithTags, getItemById,
  createItem as repoCreate, updateItem as repoUpdate,
  trashItem as repoTrash, restoreItem as repoRestore,
  permanentlyDeleteItem as repoDelete, searchItems as repoSearch,
  type Item,
} from '../db/items'
import { appendOp, addTombstone } from '../db/oplog'
import { emit } from '../core/Notifier'

export function listItems(libraryId = 1): Item[] {
  return getAllItemsWithTags(libraryId, 0)
}

export function listTrashed(libraryId = 1): Item[] {
  return getAllItemsWithTags(libraryId, 1)
}

export function listByCollection(collectionId: number): Item[] {
  return getItemsByCollectionWithTags(collectionId)
}

export function getItem(id: number): Item | undefined {
  return getItemById(id)
}

export function search(query: string): Item[] {
  return repoSearch(query)
}

export function createItem(data: Partial<Item>): Item {
  const item = getDb().transaction(() => {
    const created = repoCreate(data)
    appendOp('item', created.id, 'create', data)
    return created
  })()
  emit({ type: 'item.created', ids: [item.id] })
  return item
}

export function updateItem(id: number, data: Partial<Item>): void {
  getDb().transaction(() => {
    repoUpdate(id, data)
    appendOp('item', id, 'modify', data)
  })()
  emit({ type: 'item.modified', ids: [id] })
}

export function trashItem(id: number): void {
  getDb().transaction(() => {
    repoTrash(id)
    appendOp('item', id, 'trash')
  })()
  emit({ type: 'item.trashed', ids: [id] })
}

export function restoreItem(id: number): void {
  getDb().transaction(() => {
    repoRestore(id)
    appendOp('item', id, 'restore')
  })()
  emit({ type: 'item.restored', ids: [id] })
}

export function deleteItem(id: number): void {
  getDb().transaction(() => {
    const item = getItemById(id)
    if (item) addTombstone('item', item.key)
    repoDelete(id)
    appendOp('item', id, 'delete')
  })()
  emit({ type: 'item.deleted', ids: [id] })
}

export function emptyTrash(libraryId = 1): number {
  const db = getDb()
  const count = db.transaction(() => {
    const rows = db.prepare(
      'SELECT id, key FROM items WHERE library_id = ? AND deleted = 1'
    ).all(libraryId) as { id: number; key: string }[]
    for (const r of rows) {
      addTombstone('item', r.key)
      appendOp('item', r.id, 'delete')
    }
    db.prepare('DELETE FROM items WHERE library_id = ? AND deleted = 1').run(libraryId)
    return rows.length
  })()
  emit({ type: 'item.deleted', ids: [] })
  return count
}
