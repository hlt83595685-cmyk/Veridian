// 新链路的入口，契约与旧的 agent.ask 一致（返回 conversationId）。
//
// 分工：`harness_events` 是真相源，`messages` 表是**给 UI 看的投影**。入口负责
// 投影，harness 内部只管日志——两者职责不混。
import { getKnowledgeDb } from '../knowledge/db'
import { getActiveWorkspace } from '../services/WorkspaceContextService'
import { listInstalledSkills } from '../knowledge/skills'
import { horseForNewConversation } from './activeHorse'
import { getHarness } from './boot'
import { runTurn } from './turn'
import { SqliteSessionStore } from './session/sqliteStore'
import { deriveMessages } from './session/derive'
import type { AttachmentRef } from './seams/attachment'
import type { KnowledgeRef } from '../../shared/ipc-contract'
import type { TurnTrace } from '../../shared/types'

const BASE_PROMPT = `你是 Veridian（文献管理器）内置的研究助手，只回答关于用户自己文献库的问题。

规则：
- 用户附上的论文全文会以 <paper …> 块出现在他的消息里。直接依据它回答。
- 若某个 <paper> 块带 error 属性，说明那篇没能读取。如实告诉用户原因，并给出下一步（例如先执行转换），不要假装读到了内容。
- 若某个 <paper> 块 truncated="true"，说明正文被预算截断。回答时说明这一点，必要时请用户指明想看的章节。
- 问题涉及「库里有没有讲过」「哪几篇提到过」这类需要查证的事时，先用 search_library 检索，不要凭记忆回答。
- 用户提到某个**分类**时（「X 分类里的文献」「把 X 里的都…」），先用 list_collections 确认名字，再用 list_collection_items 取出条目——分类名要精确匹配才能用。不要拿全库的检索结果冒充某个分类的内容。
- 会改动文库的工具（写笔记、加标签、订正题录、标星）动手前会请用户确认。所以：先说清你打算改什么、改成什么，再调用；一次只改一件事，不要把一堆改动塞进一次调用。
- 订正题录时，只填你**有依据**的字段。没把握的宁可不填，也不要猜一个值写进去——那比留空更难被发现。
- 用用户提问所使用的语言回答。简洁、准确，数字与结论照原文引述。`

/**
 * 每回合重新拼一次提示词，因为已装技能的清单会变。
 *
 * 清单必须进提示词：load_skill 是按名字取的，模型不知道有哪些名字，那个工具
 * 就等于不存在。这也是为什么只把工具接回来还不够。
 */
function systemPrompt(): string {
	const skills = listInstalledSkills()
	if (!skills.length) return BASE_PROMPT
	const lines = skills.map((s) => `- ${s.name}：${s.description}`).join('\n')
	return `${BASE_PROMPT}

可用技能（用 load_skill 按名字加载正文，相关时先加载再动手）：
${lines}`
}

const abortControllers = new Map<number, AbortController>()

/** 与 assemble 报告里的 AttachmentStatus.key 对齐，用于回填标签。 */
function refKey(r: KnowledgeRef): string {
  return r.type === 'item' ? r.itemKey : r.type === 'file' ? r.path : r.name
}

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

/** 起一个回合并把结果投影给 UI。ask / regenerate / editResend 共用。
 *
 *  `userMessageId` 是本轮提问在 messages 表里的行号；附件状态解析出来后回填到
 *  它的 refs 列，这样切走再切回来、或者重启之后，芯片上的「已读全文／未转换／
 *  被截断」还在——事件流是一次性的，投影必须落库。 */
function launch(
  convId: number,
  question: string,
  refs: KnowledgeRef[] | undefined,
  userMessageId: number | null,
): void {
  const kdb = getKnowledgeDb()
  const ac = new AbortController()
  abortControllers.set(convId, ac)
  const store = new SqliteSessionStore()
  const byKey = new Map((refs ?? []).map((r) => [refKey(r), r]))

  void runTurn(getHarness(), store, {
    conversationId: convId,
    question,
    refs: toAttachmentRefs(refs),
    systemPrompt: systemPrompt(),
    signal: ac.signal,
    onAttachments: (attachments) => {
      if (userMessageId === null) return
      // 标签用解析出来的标题：界面那边的 label 只活在渲染进程（IPC 只传
      // KnowledgeRef，不含 label），而 status.title 是刚从库里读出来的真标题。
      const payload = attachments.map((a) => ({
        ...(byKey.get(a.key) ?? { type: 'item' as const, itemKey: a.key }),
        label: a.title,
        status: a,
      }))
      kdb.prepare('UPDATE messages SET refs = ? WHERE id = ?').run(JSON.stringify(payload), userMessageId)
    },
  })
    .then(({ trace, elapsedMs, context }) => {
      // 回合结束后，把日志里最后一条助手消息投影到 UI 表。工具调用与上下文
      // 报告都挂在这条消息上——它们是产出这个回答的过程，重开会话时要跟着
      // 一起回来。
      const msgs = deriveMessages(store.read(convId))
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content)
      if (lastAssistant?.content) {
        kdb
          .prepare(
            'INSERT INTO messages (conversation_id, role, content, steps, context) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            convId,
            'assistant',
            lastAssistant.content,
            // steps 列现在存整条轨迹（阶段说明 + 工具调用 + 耗时）。老行里是
            // 裸的 ToolCallRecord[]，读的时候归一，不做迁移。
            JSON.stringify({ entries: trace, elapsedMs } satisfies TurnTrace),
            context ? JSON.stringify(context) : null,
          )
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
  horseId?: string,
): Promise<number> {
  const kdb = getKnowledgeDb()
  let convId = conversationId
  if (convId === null) {
    // 建对话时把马钉下来，之后不再跟着默认马变：换了默认马以后，旧对话的行为
    // 不该跟着变，否则「这个回答当时是谁给的」就无从追溯。
    const info = kdb
      .prepare('INSERT INTO conversations (workspace_id, title, horse_id) VALUES (?, ?, ?)')
      .run(
        getActiveWorkspace().id ?? 0,
        question.slice(0, 60),
        horseId ?? horseForNewConversation()?.id ?? null,
      )
    convId = Number(info.lastInsertRowid)
  }
  // UI 投影：先把用户这条写进 messages，界面立刻能显示。
  const userMsg = kdb
    .prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
    .run(convId, 'user', question, '[]')
  launch(convId, question, refs, Number(userMsg.lastInsertRowid))
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
  launch(conversationId, lastUser.content, [], lastUser.id)
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
  const userMsg = kdb
    .prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
    .run(conversationId, 'user', newQuestion, '[]')
  launch(conversationId, newQuestion, refs, Number(userMsg.lastInsertRowid))
}

export function stopGeneration(conversationId: number): void {
  abortControllers.get(conversationId)?.abort()
}
