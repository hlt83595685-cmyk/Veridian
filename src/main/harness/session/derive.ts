// 模型消息只能由此投影产生。任何旁路拼接都会被 assertProjectionMatches 抓住。
//
// 「模型可见即已记录」：进入模型请求的每一段内容都必须能从日志重建。这条不变量
// 让「这轮到底发了什么」永远可回放，上下文检查器是它的免费副产品。
import type { AttachmentRef, AttachmentResult } from '../seams/attachment'
import type { ChatMessage, SessionEvent } from './types'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 把一次附件解析渲染成自描述块。
 *
 * 失败时把**真实原因**放在内容本该出现的位置。旧实现在这里说谎（不论什么错都告诉
 * 模型「没有转换文本」），而那句谎正是在训练模型放弃 @ 转而去检索全库。
 */
export function renderAttachment(ref: AttachmentRef, r: AttachmentResult): string {
  const key = ref.type === 'item' ? ref.itemKey : ref.path
  if (!r.ok) {
    const hint =
      r.reason === 'not_converted'
        ? '这篇尚未转换为 Markdown，无法读取正文。可以先对它执行 PDF 转换。'
        : r.reason === 'permission_denied'
          ? '该文件不在允许访问的范围内。'
          : r.reason === 'not_found'
            ? '找不到这个条目。'
            : r.detail
    return `<paper item_key="${esc(key)}" title="${esc(r.title ?? key)}" error="${r.reason}">\n${hint}\n</paper>`
  }
  const head =
    `<paper item_key="${esc(key)}" title="${esc(r.title)}" truncated="${r.truncated}"` +
    (r.truncated ? ` total_bytes="${r.totalBytes}" shown_bytes="${r.shownBytes}"` : '') +
    '>'
  const tail = r.truncated
    ? `\n\n[内容因预算截断：原文 ${r.totalBytes} 字节，此处显示 ${r.shownBytes} 字节。需要其余部分可再次询问具体章节。]`
    : ''
  return `${head}\n${r.text}${tail}\n</paper>`
}

/**
 * 一次工具调用被打断时补上的答复。
 *
 * 为什么必须补：OpenAI 兼容的接口要求带 tool_calls 的 assistant 消息后面**必须**
 * 跟着对应的 tool 消息。日志里留下一条没有答复的 tool-call（回合被中止、或者
 * 派发层抛了），这段对话此后每一次重放都是非法形状，问什么都 400——一次意外
 * 变成永久损坏。
 *
 * 补在**投影**里而不是回头改日志：日志记的是真实发生过的事（我们确实问了、确实
 * 没等到答复），改它就是篡改历史。投影的职责本来就是把事实变成 API 认的形状。
 * 这样已经损坏的老对话不用迁移也能立刻恢复。
 */
const INTERRUPTED = 'error: interrupted'

export function deriveMessages(events: SessionEvent[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pendingUser: { text: string; blocks: string[] } | null = null
  /** 已经发出、还没见到 tool-result 的调用 id。 */
  let unanswered: string | null = null

  /** 把悬空的工具调用补一条答复。任何会离开「工具往返」的地方都要先调它。 */
  const settle = (): void => {
    if (unanswered === null) return
    out.push({ role: 'tool', content: INTERRUPTED, tool_call_id: unanswered })
    unanswered = null
  }

  const flush = (): void => {
    if (!pendingUser) return
    out.push({ role: 'user', content: [pendingUser.text, ...pendingUser.blocks].join('\n\n') })
    pendingUser = null
  }

  for (const e of events) {
    switch (e.kind) {
      case 'user-message':
        settle()
        flush()
        pendingUser = { text: e.text, blocks: [] }
        break
      case 'attachment-resolved':
        if (pendingUser) pendingUser.blocks.push(renderAttachment(e.ref, e.result))
        break
      case 'tool-call':
        // 上一条还没答复就又发起一条：同样是断口，先把上一条结掉。
        settle()
        flush()
        unanswered = e.id
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: e.id, type: 'function', function: { name: e.name, arguments: e.args } }],
          // 思考模式要求原样回传。字段的**存在**本身就是要求，所以带 tool_calls
          // 的这条一律给出——没有思考内容就给空串。缺字段和给空串是两回事，
          // 缺了就是 400。
          reasoning_content: e.reasoning ?? '',
        })
        break
      case 'tool-result':
        // 正常配对：这条答复对上了，断口不存在。
        if (unanswered === e.id) unanswered = null
        else settle()
        flush()
        out.push({ role: 'tool', content: e.result, tool_call_id: e.id })
        break
      case 'assistant-message':
        settle()
        flush()
        // 不带 tool_calls 的 assistant 消息**不**加这个字段：API 只对工具轮有
        // 这个要求，而给不支持思考模式的供应商多塞一个未知字段会招来另一种 400。
        out.push({ role: 'assistant', content: e.text })
        break
      default:
        break // turn-start / turn-end 不进模型视图
    }
  }
  // 日志末尾还悬着的，同样补上——回合被中止时就停在这里。
  settle()
  flush()
  return out
}

/** 开发期不变量：发出去的消息必须与投影逐条一致。 */
export function assertProjectionMatches(sent: ChatMessage[], events: SessionEvent[]): void {
  const strip = (m: ChatMessage[]): string => JSON.stringify(m.filter((x) => x.role !== 'system'))
  if (strip(sent) !== strip(deriveMessages(events))) {
    throw new Error('harness invariant violated: sent messages are not reconstructable from the session log')
  }
}
