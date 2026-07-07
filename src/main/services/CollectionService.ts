import {
  getAllCollections, createCollection as repoCreate, renameCollection as repoRename,
  deleteCollection as repoDelete, addItemToCollection as repoAddItem,
  removeItemFromCollection as repoRemoveItem, type Collection,
} from '../db/collections'
import { getDb } from '../db'
import { appendOp } from '../db/oplog'
import { emit } from '../core/Notifier'

export function listAll(libraryId = 1): Collection[] {
  return getAllCollections(libraryId)
}

export function createCollection(name: string, libraryId = 1, parentId?: number): Collection {
  const col = getDb().transaction(() => {
    const created = repoCreate(name, libraryId, parentId)
    appendOp('collection', created.id, 'create', { name, parentId })
    return created
  })()
  emit({ type: 'collection.changed', ids: [col.id] })
  return col
}

export function renameCollection(id: number, name: string): void {
  getDb().transaction(() => {
    repoRename(id, name)
    appendOp('collection', id, 'modify', { name })
  })()
  emit({ type: 'collection.changed', ids: [id] })
}

export function deleteCollection(id: number): void {
  getDb().transaction(() => {
    repoDelete(id)
    appendOp('collection', id, 'delete')
  })()
  emit({ type: 'collection.changed', ids: [id] })
}

export function addItemToCollection(collectionId: number, itemId: number): void {
  repoAddItem(collectionId, itemId)
  appendOp('collection', collectionId, 'modify', { addItem: itemId })
  emit({ type: 'collection.changed', ids: [collectionId] })
}

export function removeItemFromCollection(collectionId: number, itemId: number): void {
  repoRemoveItem(collectionId, itemId)
  appendOp('collection', collectionId, 'modify', { removeItem: itemId })
  emit({ type: 'collection.changed', ids: [collectionId] })
}
