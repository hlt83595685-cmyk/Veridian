import { getDb } from './index'

export interface Creator {
  id: number
  first_name: string | null
  last_name: string
  orcid: string | null
}

export interface ItemCreator extends Creator {
  role: string
  position: number
}

export function getCreatorsByItem(itemId: number): ItemCreator[] {
  return getDb().prepare(`
    SELECT c.*, ic.role, ic.position
    FROM creators c
    JOIN item_creators ic ON ic.creator_id = c.id
    WHERE ic.item_id = ?
    ORDER BY ic.position
  `).all(itemId) as ItemCreator[]
}

export function setCreatorsForItem(
  itemId: number,
  creators: Array<{ first_name?: string | null; last_name: string; role?: string; position?: number }>
): void {
  const db = getDb()
  const deleteStmt = db.prepare('DELETE FROM item_creators WHERE item_id = ?')
  const findOrCreate = db.prepare(`
    INSERT OR IGNORE INTO creators (first_name, last_name) VALUES (@first_name, @last_name)
  `)
  const getId = db.prepare(
    "SELECT id FROM creators WHERE last_name = ? AND COALESCE(first_name,'') = COALESCE(?,'') "
  )
  const link = db.prepare(`
    INSERT OR REPLACE INTO item_creators (item_id, creator_id, role, position)
    VALUES (@item_id, @creator_id, @role, @position)
  `)

  db.transaction(() => {
    deleteStmt.run(itemId)
    creators.forEach((c, i) => {
      findOrCreate.run({ first_name: c.first_name ?? null, last_name: c.last_name })
      const row = getId.get(c.last_name, c.first_name ?? null) as { id: number }
      link.run({ item_id: itemId, creator_id: row.id, role: c.role ?? 'author', position: c.position ?? i })
    })
  })()
}
