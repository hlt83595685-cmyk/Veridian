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

export async function ask(
  question: string,
  conversationId: number | null,
  refs?: KnowledgeRef[],
): Promise<number> {
  const kdb = getKnowledgeDb()
  const ws = getActiveWorkspace().id ?? 0

  let convId = conversationId
  if (convId === null) {
    const info = kdb
      .prepare('INSERT INTO conversations (workspace_id, title) VALUES (?, ?)')
      .run(ws, question.slice(0, 60))
    convId = Number(info.lastInsertRowid)
  }

  // UI 投影：先把用户这条写进 messages，界面立刻能显示。
  kdb
    .prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
    .run(convId, 'user', question, '[]')

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

  return convId
}

export function stopGeneration(conversationId: number): void {
  abortControllers.get(conversationId)?.abort()
}
