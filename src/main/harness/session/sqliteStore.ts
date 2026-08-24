// 生产存储：追加到 knowledge.db。表是只追加的，没有 UPDATE 路径——日志是真相源，
// 改写日志等于改写历史。
import { getKnowledgeDb } from '../../knowledge/db'
import type { SessionEvent, SessionStore } from './types'

export function ensureSessionEventTable(): void {
  getKnowledgeDb().exec(`
    CREATE TABLE IF NOT EXISTS harness_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_harness_events_session ON harness_events(session_id, id);
  `)
}

export class SqliteSessionStore implements SessionStore {
  append(sessionId: number, event: SessionEvent): void {
    getKnowledgeDb()
      .prepare('INSERT INTO harness_events (session_id, payload) VALUES (?, ?)')
      .run(sessionId, JSON.stringify(event))
  }

  read(sessionId: number): SessionEvent[] {
    const rows = getKnowledgeDb()
      .prepare('SELECT payload FROM harness_events WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ payload: string }>
    return rows.map((r) => JSON.parse(r.payload) as SessionEvent)
  }

  truncateToLastUserMessage(sessionId: number): void {
    const kdb = getKnowledgeDb()
    const row = kdb
      .prepare(
        `SELECT id FROM harness_events
         WHERE session_id = ? AND json_extract(payload, '$.kind') = 'user-message'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId) as { id: number } | undefined
    if (!row) return
    kdb.prepare('DELETE FROM harness_events WHERE session_id = ? AND id >= ?').run(sessionId, row.id)
  }
}
