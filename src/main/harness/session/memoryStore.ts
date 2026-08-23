import type { SessionEvent, SessionStore } from './types'

/** 测试用存储。生产用 SqliteSessionStore。 */
export class MemorySessionStore implements SessionStore {
  private readonly rows = new Map<number, SessionEvent[]>()

  append(sessionId: number, event: SessionEvent): void {
    const list = this.rows.get(sessionId) ?? []
    list.push(event)
    this.rows.set(sessionId, list)
  }

  read(sessionId: number): SessionEvent[] {
    return [...(this.rows.get(sessionId) ?? [])]
  }
}
