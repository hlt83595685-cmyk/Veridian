import { randomUUID } from 'crypto'
import { getDb } from './index'

export interface Item {
  id: number
  key: string
  type: string
  title: string | null
  abstract: string | null
  year: number | null
  doi: string | null
  url: string | null
  journal: string | null
  publisher: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  isbn: string | null
  language: string | null
  extra: string | null
  deleted: number   // 0 = active, 1 = trash
  library_id: number
  created_at: number
  updated_at: number
  version: number
}

export function getAllItems(libraryId = 1): Item[] {
  return getDb()
    .prepare('SELECT * FROM items WHERE library_id = ? AND deleted = 0 ORDER BY updated_at DESC')
    .all(libraryId) as Item[]
}

export function getTrashedItems(libraryId = 1): Item[] {
  return getDb()
    .prepare('SELECT * FROM items WHERE library_id = ? AND deleted = 1 ORDER BY updated_at DESC')
    .all(libraryId) as Item[]
}

export function getAllItemsWithTags(libraryId = 1, deleted = 0): Item[] {
  const items = getDb()
    .prepare('SELECT * FROM items WHERE library_id = ? AND deleted = ? ORDER BY updated_at DESC')
    .all(libraryId, deleted) as Item[]

  if (items.length === 0) return items

  // Fetch all tag associations in one query and group by item_id
  const rows = getDb().prepare(`
    SELECT it.item_id, t.name
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id IN (${items.map(() => '?').join(',')})
    ORDER BY t.name
  `).all(...items.map((i) => i.id)) as { item_id: number; name: string }[]

  const tagMap = new Map<number, string[]>()
  for (const row of rows) {
    const arr = tagMap.get(row.item_id) ?? []
    arr.push(row.name)
    tagMap.set(row.item_id, arr)
  }

  return items.map((item) => ({ ...item, tags: tagMap.get(item.id) ?? [] }))
}

export function getItemsByCollectionWithTags(collectionId: number): Item[] {
  const items = getDb().prepare(`
    SELECT i.* FROM items i
    JOIN collection_items ci ON ci.item_id = i.id
    WHERE ci.collection_id = ? AND i.deleted = 0
    ORDER BY i.updated_at DESC
  `).all(collectionId) as Item[]

  if (items.length === 0) return items

  const rows = getDb().prepare(`
    SELECT it.item_id, t.name
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    WHERE it.item_id IN (${items.map(() => '?').join(',')})
    ORDER BY t.name
  `).all(...items.map((i) => i.id)) as { item_id: number; name: string }[]

  const tagMap = new Map<number, string[]>()
  for (const row of rows) {
    const arr = tagMap.get(row.item_id) ?? []
    arr.push(row.name)
    tagMap.set(row.item_id, arr)
  }

  return items.map((item) => ({ ...item, tags: tagMap.get(item.id) ?? [] }))
}

export function getItemById(id: number): Item | undefined {
  return getDb().prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined
}

export function createItem(data: Partial<Item>): Item {
  const db = getDb()
  const key = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO items (
      key, type, title, abstract, year, doi, url,
      journal, publisher, volume, issue, pages, isbn, language, extra,
      library_id, created_at, updated_at, deleted
    ) VALUES (
      @key, @type, @title, @abstract, @year, @doi, @url,
      @journal, @publisher, @volume, @issue, @pages, @isbn, @language, @extra,
      @library_id, @created_at, @updated_at, 0
    )
  `).run({
    key,
    type: data.type ?? 'journalArticle',
    title: data.title ?? null,
    abstract: data.abstract ?? null,
    year: data.year ?? null,
    doi: data.doi ?? null,
    url: data.url ?? null,
    journal: data.journal ?? null,
    publisher: data.publisher ?? null,
    volume: data.volume ?? null,
    issue: data.issue ?? null,
    pages: data.pages ?? null,
    isbn: data.isbn ?? null,
    language: data.language ?? null,
    extra: data.extra ?? null,
    library_id: data.library_id ?? 1,
    created_at: now,
    updated_at: now,
  })
  return getDb().prepare('SELECT * FROM items WHERE key = ?').get(key) as Item
}

export function updateItem(id: number, data: Partial<Item>): void {
  const now = Math.floor(Date.now() / 1000)
  const fields = [
    'title','abstract','year','doi','url',
    'journal','publisher','volume','issue','pages','isbn','language','extra'
  ]
  const setClauses = fields.map((f) => `${f} = COALESCE(@${f}, ${f})`).join(', ')
  getDb().prepare(`
    UPDATE items SET ${setClauses}, updated_at = @updated_at, version = version + 1
    WHERE id = @id
  `).run({ ...data, id, updated_at: now })
}

export function trashItem(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare('UPDATE items SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id)
}

export function restoreItem(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare('UPDATE items SET deleted = 0, updated_at = ? WHERE id = ?').run(now, id)
}

export function permanentlyDeleteItem(id: number): void {
  getDb().prepare('DELETE FROM items WHERE id = ?').run(id)
}

export function emptyTrash(libraryId = 1): number {
  const result = getDb()
    .prepare('DELETE FROM items WHERE library_id = ? AND deleted = 1')
    .run(libraryId)
  return result.changes
}

export function searchItems(query: string): Item[] {
  return getDb().prepare(`
    SELECT i.* FROM items i
    JOIN items_fts ON items_fts.rowid = i.id
    WHERE items_fts MATCH ? AND i.deleted = 0
    ORDER BY rank
  `).all(query) as Item[]
}
