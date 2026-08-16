import { getDb } from './index'

export interface Note {
  id: number
  item_id: number | null
  title: string | null
  content: string | null
  origin: string       // 'user' | 'ai'
  updated_by: string   // 'user' | 'ai'
  created_at: number
  updated_at: number
}

export interface NoteInput {
  itemId?: number | null
  title?: string | null
  content?: string | null
  origin?: 'user' | 'ai'
}

export function createNote(input: NoteInput): number {
  const origin = input.origin ?? 'user'
  const info = getDb().prepare(`
    INSERT INTO notes (item_id, title, content, origin, updated_by)
    VALUES (@item_id, @title, @content, @origin, @updated_by)
  `).run({
    item_id: input.itemId ?? null,
    title: input.title ?? null,
    content: input.content ?? null,
    origin,
    updated_by: origin,   // creator is the first editor
  })
  return Number(info.lastInsertRowid)
}

export function getNote(id: number): Note | undefined {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | undefined
}

export function listNotesByItem(itemId: number): Note[] {
  return getDb().prepare('SELECT * FROM notes WHERE item_id = ? ORDER BY id').all(itemId) as Note[]
}

export function updateNote(id: number, patch: { title?: string | null; content?: string | null; updatedBy: 'user' | 'ai' }): void {
  getDb().prepare(`
    UPDATE notes
    SET title = COALESCE(@title, title),
        content = COALESCE(@content, content),
        updated_by = @updated_by,
        updated_at = unixepoch()
    WHERE id = @id
  `).run({ id, title: patch.title ?? null, content: patch.content ?? null, updated_by: patch.updatedBy })
}

export function deleteNote(id: number): void {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id)
}

/** Manual cascade for permanent item deletion (FK cascade needs PRAGMA on). */
export function deleteNotesForItem(itemId: number): void {
  getDb().prepare('DELETE FROM notes WHERE item_id = ?').run(itemId)
}
