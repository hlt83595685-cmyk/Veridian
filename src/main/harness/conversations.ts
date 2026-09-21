// 会话的增删查。
//
// 这是持久化,不是编排——所以它跟着 harness 走,而不是留在被替换掉的旧编排里。
// `conversations` / `messages` 两张表是**给 UI 看的投影**；真相源是 harness_events。
import { getKnowledgeDb } from '../knowledge/db'
import { getActiveWorkspace } from '../services/WorkspaceContextService'

export interface ConversationRow {
  id: number
  title: string
  created_at: number
  scope_collection_id: number | null
  /** 这段对话归哪匹马跑。老对话是 null，解析时退回默认马。 */
  horse_id: string | null
}

export interface MessageRow {
  id: number
  conversation_id: number
  role: string
  content: string
  citations: string
  created_at: number
  steps: string
  refs: string
  /** JSON ContextReport；助手行才有，旧数据为 null。 */
  context: string | null
}

function wsId(): number {
  return getActiveWorkspace().id ?? 0
}

export function listConversations(): ConversationRow[] {
  return getKnowledgeDb()
    .prepare(
      'SELECT id, title, created_at, scope_collection_id, horse_id FROM conversations WHERE workspace_id = ? ORDER BY id DESC LIMIT 100',
    )
    .all(wsId()) as ConversationRow[]
}

export function getMessages(conversationId: number): MessageRow[] {
  return getKnowledgeDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as MessageRow[]
}

export function deleteConversation(conversationId: number): void {
  const kdb = getKnowledgeDb()
  kdb.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
  kdb.prepare('DELETE FROM harness_events WHERE session_id = ?').run(conversationId)
  kdb.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
}
