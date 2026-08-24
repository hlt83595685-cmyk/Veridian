// 新链路的入口，契约与旧的 agent.ask 一致（返回 conversationId）。
//
// 分工：`harness_events` 是真相源，`messages` 表是**给 UI 看的投影**。入口负责
// 投影，harness 内部只管日志——两者职责不混。
import { getKnowledgeDb } from '../knowledge/db'
import { getActiveWorkspace } from '../services/WorkspaceContextService'
import { getHarness } from './boot'
import { runTurn } from './turn'
import { SqliteSessionStore } from './session/sqliteStore'
import { deriveMessages } from './session/derive'
import type { AttachmentRef } from './seams/attachment'
import type { KnowledgeRef } from '../../shared/ipc-contract'

const SYSTEM_PROMPT = `你是 Veridian（文献管理器）内置的研究助手，只回答关于用户自己文献库的问题。

规则：
- 用户附上的论文全文会以 <paper …> 块出现在他的消息里。直接依据它回答。
- 若某个 <paper> 块带 error 属性，说明那篇没能读取。如实告诉用户原因，并给出下一步（例如先执行转换），不要假装读到了内容。
- 若某个 <paper> 块 truncated="true"，说明正文被预算截断。回答时说明这一点，必要时请用户指明想看的章节。
- 用用户提问所使用的语言回答。简洁、准确，数字与结论照原文引述。`

const abortControllers = new Map<number, AbortController>()

function toAttachmentRefs(refs: KnowledgeRef[] | undefined): AttachmentRef[] {
  if (!refs?.length) return []
  const out: AttachmentRef[] = []
  for (const r of refs) {
    if (r.type === 'item') out.push({ type: 'item', itemKey: r.itemKey })
    else if (r.type === 'file') out.push({ type: 'file', path: r.path })
    // skill 引用在第一条竖线里没有对应能力，忽略
  }
  return out
}

/** 起一个回合并把结果投影给 UI。ask / regenerate / editResend 共用。 */
function launch(convId: number, question: string, refs: KnowledgeRef[] | undefined): void {
  const kdb = getKnowledgeDb()
  const ac = new AbortController()
  abortControllers.set(convId, ac)
  const store = new SqliteSessionStore()

  void runTurn(getHarness(), store, {
    conversationId: convId,
    question,
    refs: toAttachmentRefs(refs),
    systemPrompt: SYSTEM_PROMPT,
    signal: ac.signal,
  })
    .then(() => {
      // 回合结束后，把日志里最后一条助手消息投影到 UI 表。
      const msgs = deriveMessages(store.read(convId))
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content)
      if (lastAssistant?.content) {
        kdb
          .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
          .run(convId, 'assistant', lastAssistant.content)
      }
    })
    .finally(() => {
      abortControllers.delete(convId)
    })
}

export async function ask(
  question: string,
  conversationId: number | null,
  refs?: KnowledgeRef[],
): Promise<number> {
  const kdb = getKnowledgeDb()
  let convId = conversationId
  if (convId === null) {
    const info = kdb
      .prepare('INSERT INTO conversations (workspace_id, title) VALUES (?, ?)')
      .run(getActiveWorkspace().id ?? 0, question.slice(0, 60))
    convId = Number(info.lastInsertRowid)
  }
  // UI 投影：先把用户这条写进 messages，界面立刻能显示。
  kdb
    .prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
    .run(convId, 'user', question, '[]')
  launch(convId, question, refs)
  return convId
}

/** 重新生成：把日志与 UI 投影都退回到最后一次提问之前，然后重跑。 */
export function regenerate(conversationId: number): void {
  const kdb = getKnowledgeDb()
  const lastUser = kdb
    .prepare("SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
    .get(conversationId) as { id: number; content: string } | undefined
  if (!lastUser) return
  kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id > ?').run(conversationId, lastUser.id)
  new SqliteSessionStore().truncateToLastUserMessage(conversationId)
  launch(conversationId, lastUser.content, [])
}

/** 编辑重发：替换最后一次提问，其后的一切作废。 */
export function editLastAndResend(
  conversationId: number,
  newQuestion: string,
  refs?: KnowledgeRef[],
): void {
  const kdb = getKnowledgeDb()
  const lastUser = kdb
    .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
    .get(conversationId) as { id: number } | undefined
  if (!lastUser) return
  kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, lastUser.id)
  new SqliteSessionStore().truncateToLastUserMessage(conversationId)
  kdb
    .prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
    .run(conversationId, 'user', newQuestion, '[]')
  launch(conversationId, newQuestion, refs)
}

export function stopGeneration(conversationId: number): void {
  abortControllers.get(conversationId)?.abort()
}
