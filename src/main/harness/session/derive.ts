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

export function deriveMessages(events: SessionEvent[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pendingUser: { text: string; blocks: string[] } | null = null

  const flush = (): void => {
    if (!pendingUser) return
    out.push({ role: 'user', content: [pendingUser.text, ...pendingUser.blocks].join('\n\n') })
    pendingUser = null
  }

  for (const e of events) {
    switch (e.kind) {
      case 'user-message':
        flush()
        pendingUser = { text: e.text, blocks: [] }
        break
      case 'attachment-resolved':
        if (pendingUser) pendingUser.blocks.push(renderAttachment(e.ref, e.result))
        break
      case 'tool-call':
        flush()
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: e.id, type: 'function', function: { name: e.name, arguments: e.args } }],
        })
        break
      case 'tool-result':
        flush()
        out.push({ role: 'tool', content: e.result, tool_call_id: e.id })
        break
      case 'assistant-message':
        flush()
        out.push({ role: 'assistant', content: e.text })
        break
      default:
        break // turn-start / turn-end 不进模型视图
    }
  }
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
