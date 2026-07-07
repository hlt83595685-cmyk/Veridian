import { getDb } from './index'

// Append-only operation log. The future sync engine uploads rows with
// synced = 0; local undo can replay inverse operations. Payload is the patch
// that was applied, JSON-encoded.
export function appendOp(
  objectType: string,
  objectId: number,
  op: 'create' | 'modify' | 'trash' | 'restore' | 'delete',
  payload?: unknown
): void {
  getDb().prepare(`
    INSERT INTO oplog (object_type, object_id, op, payload)
    VALUES (?, ?, ?, ?)
  `).run(objectType, objectId, op, payload === undefined ? null : JSON.stringify(payload))
}

export function addTombstone(objectType: string, key: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO tombstones (object_type, key) VALUES (?, ?)
  `).run(objectType, key)
}
