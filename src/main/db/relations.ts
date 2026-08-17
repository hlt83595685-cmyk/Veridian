import { getDb } from './index'

// Fixed, small vocabulary of typed edges. Extend deliberately (also update the
// agent tool description + any UI legend).
export const RELATION_TYPES = ['extends', 'contradicts', 'related', 'cites', 'same_method'] as const
export type RelationType = (typeof RELATION_TYPES)[number]

export interface Relation {
  id: number
  src_kind: string
  src_id: number
  dst_kind: string
  dst_id: number
  rel_type: string
  origin: string
  created_at: number
}

function assertRelType(t: string): asserts t is RelationType {
  if (!(RELATION_TYPES as readonly string[]).includes(t)) {
    throw new Error(`invalid rel_type "${t}" (expected one of ${RELATION_TYPES.join(', ')})`)
  }
}

/** Create a directed item→item edge. Returns false if it already existed. */
export function linkItems(srcItemId: number, dstItemId: number, relType: string, origin: 'user' | 'ai'): boolean {
  assertRelType(relType)
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type, origin)
    VALUES ('item', ?, 'item', ?, ?, ?)
  `).run(srcItemId, dstItemId, relType, origin)
  return info.changes > 0
}

export function unlink(srcItemId: number, dstItemId: number, relType: string): void {
  getDb().prepare(`
    DELETE FROM relations
    WHERE src_kind = 'item' AND src_id = ? AND dst_kind = 'item' AND dst_id = ? AND rel_type = ?
  `).run(srcItemId, dstItemId, relType)
}

/** All edges touching this item, in either direction. */
export function listRelationsForItem(itemId: number): Relation[] {
  return getDb().prepare(`
    SELECT * FROM relations
    WHERE (src_kind = 'item' AND src_id = ?) OR (dst_kind = 'item' AND dst_id = ?)
    ORDER BY id
  `).all(itemId, itemId) as Relation[]
}

export function deleteRelationsForItem(itemId: number): void {
  getDb().prepare(`
    DELETE FROM relations WHERE (src_kind = 'item' AND src_id = ?) OR (dst_kind = 'item' AND dst_id = ?)
  `).run(itemId, itemId)
}

// Wikilinks live in the same edge table as the AI's typed links, but with a
// dedicated rel_type outside RELATION_TYPES (they are user-authored [[ ]], not
// the AI's extends/contradicts/... vocabulary).
export const WIKILINK_REL = 'wikilink'
export type LinkEndpoint = { kind: 'item' | 'note'; id: number }

/** Replace ALL wikilink out-edges of a note with the given target set (add new,
 *  drop removed). Self-links (note -> itself) are ignored. */
export function setWikilinksForNote(noteId: number, targets: LinkEndpoint[]): void {
  const db = getDb()
  const del = db.prepare("DELETE FROM relations WHERE src_kind = 'note' AND src_id = ? AND rel_type = ?")
  const ins = db.prepare(`
    INSERT OR IGNORE INTO relations (src_kind, src_id, dst_kind, dst_id, rel_type, origin)
    VALUES ('note', ?, ?, ?, ?, 'user')
  `)
  db.transaction(() => {
    del.run(noteId, WIKILINK_REL)
    for (const t of targets) {
      if (t.kind === 'note' && t.id === noteId) continue
      ins.run(noteId, t.kind, t.id, WIKILINK_REL)
    }
  })()
}

/** All edges pointing AT this object (incoming), any rel_type. */
export function listBacklinks(kind: 'item' | 'note', id: number): Relation[] {
  return getDb().prepare(
    'SELECT * FROM relations WHERE dst_kind = ? AND dst_id = ? ORDER BY id'
  ).all(kind, id) as Relation[]
}

/** Remove every edge where this note is an endpoint (src or dst). For when a
 *  note is deleted. */
export function deleteRelationsForNote(noteId: number): void {
  getDb().prepare(
    "DELETE FROM relations WHERE (src_kind = 'note' AND src_id = ?) OR (dst_kind = 'note' AND dst_id = ?)"
  ).run(noteId, noteId)
}
