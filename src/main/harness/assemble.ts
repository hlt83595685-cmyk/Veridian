// 上下文装配：统一掌管 token 预算。
//
// 优先级（高→低），超预算时从低的开始削减：
//   1. 系统提示 + 工具 schema —— 固定开销，永不参与淘汰
//   2. 本轮附件 —— 放不下则截断，并如实标注
//   3. 历史消息 —— 从最旧开始丢弃
//
// 旧实现没有预算这回事：引用给 8000 字符、检索给 N×1200 字符，谁也不管总量。
//
// token 用字符数近似（chars/4）。近似值只用于取舍，不对用户展示；精确计数留到
// 接入用量遥测时。
import { deriveMessages } from './session/derive'
import type { ChatMessage, SessionEvent } from './session/types'
import type { ToolSchema } from './seams/llm'

export interface AssembleInput {
  events: SessionEvent[]
  systemPrompt: string
  tools: ToolSchema[]
  budget: { contextWindow: number; reserveForOutput: number }
}

export interface AssembleReport {
  fixedTokens: number
  usedTokens: number
  droppedTurns: number
  truncatedAttachments: number
}

export interface AssembleOutput {
  messages: ChatMessage[]
  /** 供上下文检查器与遥测使用；本期不展示。 */
  report: AssembleReport
}

const tok = (s: string | null): number => Math.ceil((s?.length ?? 0) / 4)

/** 附件可占用的比例：留出余地给历史，避免一篇长论文把对话挤没。 */
const ATTACHMENT_SHARE = 0.7

export function assemble(input: AssembleInput): AssembleOutput {
  const { events, systemPrompt, tools, budget } = input
  const fixedTokens = tok(systemPrompt) + tok(JSON.stringify(tools))
  const room = Math.max(0, budget.contextWindow - budget.reserveForOutput - fixedTokens)

  // 附件先按预算裁剪，改写事件流后再投影——这样截断标注自然进入最终文本，
  // 而不需要在投影之后再去字符串里补一句。
  let truncatedAttachments = 0
  const attachmentBudget = Math.floor(room * ATTACHMENT_SHARE)
  let attachmentUsed = 0
  const adjusted: SessionEvent[] = events.map((e) => {
    if (e.kind !== 'attachment-resolved' || !e.result.ok) return e
    const allowChars = Math.max(0, (attachmentBudget - attachmentUsed) * 4)
    if (e.result.text.length <= allowChars) {
      attachmentUsed += tok(e.result.text)
      return e
    }
    truncatedAttachments++
    const cut = e.result.text.slice(0, allowChars)
    attachmentUsed += tok(cut)
    return { ...e, result: { ...e.result, text: cut, shownBytes: cut.length, truncated: true } }
  })

  const projected = deriveMessages(adjusted)

  // 历史从最旧丢弃；最后一条永远保留（否则这一轮就没有问题可答了）。
  let droppedTurns = 0
  const kept = [...projected]
  const used = (): number => kept.reduce((n, m) => n + tok(m.content), 0)
  while (kept.length > 1 && used() > room) {
    kept.shift()
    droppedTurns++
  }

  return {
    messages: [{ role: 'system', content: systemPrompt }, ...kept],
    report: { fixedTokens, usedTokens: fixedTokens + used(), droppedTurns, truncatedAttachments },
  }
}
