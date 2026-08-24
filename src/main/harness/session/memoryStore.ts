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

  truncateToLastUserMessage(sessionId: number): void {
    const list = this.rows.get(sessionId) ?? []
    let cut = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].kind === 'user-message') { cut = i; break }
    }
    if (cut >= 0) this.rows.set(sessionId, list.slice(0, cut))
  }
}
