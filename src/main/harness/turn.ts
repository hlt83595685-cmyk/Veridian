// 回合驱动。
//
// 发出的是**现有**的渲染层事件，界面一行不改——这样出问题时能分清是架构错了
// 还是界面错了。UI 重写是独立的一期。
import { randomUUID } from 'crypto'
import type { Context } from '@deepseek-ai/cordis'
import { emit } from '../core/Notifier'
import { assemble } from './assemble'
import { assertProjectionMatches } from './session/derive'
import type { SessionStore } from './session/types'
import type { AttachmentRef } from './seams/attachment'
import type { RetrievalStep } from '../../shared/types'

const MAX_ROUNDS = 8

/** 模型窗口未配置时的保守默认。近似单位与 assemble 一致（字符/4）。 */
const DEFAULT_BUDGET = { contextWindow: 128000, reserveForOutput: 4000 }

export interface RunTurnOptions {
  conversationId: number
  question: string
  refs: AttachmentRef[]
  systemPrompt: string
  signal: AbortSignal
  budget?: { contextWindow: number; reserveForOutput: number }
}

export async function runTurn(ctx: Context, store: SessionStore, opts: RunTurnOptions): Promise<void> {
  const cid = opts.conversationId
  const turnId = randomUUID()
  const budget = opts.budget ?? DEFAULT_BUDGET

  ctx.emit('turn/start', { turnId, sessionId: cid })
  store.append(cid, { kind: 'turn-start', turnId })
  store.append(cid, { kind: 'user-message', text: opts.question, refs: opts.refs })

  // 附件逐个解析并入日志——模型可见即已记录。
  for (const ref of opts.refs) {
    const result = await ctx.attachment.resolve(ref)
    store.append(cid, { kind: 'attachment-resolved', ref, result })
    ctx.emit('attachment/resolved', ref, result)
  }

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      emit({
        type: 'knowledge.chatState',
        conversationId: cid,
        state: round === 0 ? 'searching' : 'answering',
      })

      const events = store.read(cid)
      const tools = ctx.tools.schemas()
      const { messages } = assemble({ events, systemPrompt: opts.systemPrompt, tools, budget })
      assertProjectionMatches(messages.filter((m) => m.role !== 'system'), events)

      const r = await ctx.llm.stream(
        { messages, tools },
        (delta) => { emit({ type: 'knowledge.chatDelta', conversationId: cid, delta }) },
        opts.signal,
      )

      if (!r.toolCalls.length) {
        store.append(cid, { kind: 'assistant-message', text: r.text })
        break
      }

      // 这一轮流出来的只是调工具前的思考，从答案气泡里清掉——答案只该是最后
      // 那一轮（不再调工具的那轮）的输出。
      emit({ type: 'knowledge.chatReset', conversationId: cid })

      for (const tc of r.toolCalls) {
        store.append(cid, { kind: 'tool-call', id: tc.id, name: tc.name, args: tc.args })
        const out = await ctx.tools.run(tc.name, tc.args)
        store.append(cid, { kind: 'tool-result', id: tc.id, name: tc.name, result: out })
        // step.tool 是渲染层穷举消费的联合类型（RetrievalTrace 的 ICON_PATHS）。
        // 新增工具名时必须同时补 ICON_PATHS 与 i18n 的 doing.* 文案，否则 web
        // 端类型检查失败且运行时崩溃。
        const step: RetrievalStep = { tool: 'get_item_info', label: tc.name }
        emit({ type: 'knowledge.step', conversationId: cid, step })
      }
    }

    store.append(cid, { kind: 'turn-end', turnId, reason: 'done' })
    ctx.emit('turn/end', { turnId, reason: 'done' })
    emit({ type: 'knowledge.chatState', conversationId: cid, state: 'done' })
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    const reason = aborted ? 'aborted' : 'error'
    store.append(cid, { kind: 'turn-end', turnId, reason })
    ctx.emit('turn/end', { turnId, reason })
    emit({
      type: 'knowledge.chatState',
      conversationId: cid,
      state: aborted ? 'done' : 'error',
      detail: aborted ? 'stopped' : (err as Error).message,
    })
  }
}
