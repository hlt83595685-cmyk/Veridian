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
import type { AttachmentStatus, ContextReport } from '../../shared/types'

export interface AssembleInput {
  events: SessionEvent[]
  systemPrompt: string
  tools: ToolSchema[]
  budget: { contextWindow: number; reserveForOutput: number }
}

export interface AssembleOutput {
  messages: ChatMessage[]
  /** 预算账目。原样发给界面的上下文检查器。 */
  report: ContextReport
  /** 本回合每篇附件的最终去向。截断只有在预算已知时才定得下来，所以由这里
   *  产出，而不是解析时。界面据此渲染芯片。 */
  attachments: AttachmentStatus[]
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
  // 事件流是整个会话的，裁剪要覆盖全部附件（旧回合的论文同样占预算），但
  // **报告只描述本回合**：否则第二次提问会把第一次的论文也算成它的附件，
  // 芯片就会挂到错误的消息上。本回合 = 最后一个 turn-start 之后。
  let truncatedAttachments = 0
  const attachmentBudget = Math.floor(room * ATTACHMENT_SHARE)
  let attachmentUsed = 0
  let thisTurnAttachmentTokens = 0
  const attachments: AttachmentStatus[] = []
  const turnStart = events.map((e) => e.kind).lastIndexOf('turn-start')

  const adjusted: SessionEvent[] = events.map((e, i) => {
    if (e.kind !== 'attachment-resolved') return e
    const thisTurn = i > turnStart
    const key = e.ref.type === 'item' ? e.ref.itemKey : e.ref.path
    if (!e.result.ok) {
      if (thisTurn) {
        attachments.push({
          key,
          title: e.result.title ?? key,
          ok: false,
          reason: e.result.reason,
          detail: e.result.detail,
          totalBytes: 0,
          shownBytes: 0,
          truncated: false,
        })
      }
      return e
    }
    const allowChars = Math.max(0, (attachmentBudget - attachmentUsed) * 4)
    const fits = e.result.text.length <= allowChars
    const cut = fits ? e.result.text : e.result.text.slice(0, allowChars)
    attachmentUsed += tok(cut)
    if (thisTurn) {
      thisTurnAttachmentTokens += tok(cut)
      if (!fits) truncatedAttachments++
      attachments.push({
        key,
        title: e.result.title,
        ok: true,
        totalBytes: e.result.text.length,
        shownBytes: cut.length,
        truncated: !fits,
      })
    }
    if (fits) return e
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
    report: {
      contextWindow: budget.contextWindow,
      reserveForOutput: budget.reserveForOutput,
      fixedTokens,
      attachmentTokens: thisTurnAttachmentTokens,
      // 其余部分：这一轮之前的所有对话（含旧回合折进用户消息里的附件正文）。
      // 本回合附件必定在最后一条消息里，而最后一条永不淘汰，所以这个减法安全。
      historyTokens: Math.max(0, used() - thisTurnAttachmentTokens),
      usedTokens: fixedTokens + used(),
      messageCount: kept.length,
      droppedTurns,
      truncatedAttachments,
    },
    attachments,
  }
}
