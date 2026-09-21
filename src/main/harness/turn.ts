// 回合驱动。
//
// 除了流式增量与生命周期，还向界面发三类可观测事件：附件去向、工具调用、
// 上下文预算。三者都遵循同一条规矩——**模型看到的，用户必须也能看到**。
import { randomUUID } from 'crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { emit } from '../core/Notifier'
import { assemble } from './assemble'
import { abandonApprovals } from './approvals'
import { assertProjectionMatches } from './session/derive'
import type { SessionStore } from './session/types'
import type { AttachmentRef } from './seams/attachment'
import type { ToolSchema } from './seams/llm'
import { kindOf } from './tools/kinds'
import { forgetCallOrigin, noteCallOrigin } from './tools/policy'
import { scopeFor } from './tools/equipment'
import { horseFor } from './activeHorse'
import type { AttachmentStatus, ContextReport, ToolCallRecord, TraceEntry } from '../../shared/types'

const MAX_ROUNDS = 8

/**
 * 这一回合要告诉模型哪些工具。
 *
 * 传 scope key 而不是裸调 schemas()：注册表按这匹马的装配遮罩解析可见性，没装
 * 的工具**模型压根看不到**。看不到就不会去调，这比让它调完再被拒要好——被拒
 * 会白烧一轮，还可能让它反复重试同一个工具。
 *
 * 认不出是哪匹马就一个工具都不给：不知道按谁的规矩办时，正确答案是什么都不做。
 */
function toWireSchemas(ctx: Context, conversationId: number): ToolSchema[] {
  const horse = horseFor(conversationId)
  if (!horse) return []
  const key = scopeFor(horse)
  const visible = key ? ctx.tools.schemas(key) : []
  return visible.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description ?? '', parameters: s.parameters },
  }))
}

/**
 * 派发一次工具调用。
 *
 * 任何失败——参数不是合法 JSON、被闸门拒绝、工具自己抛了——都返回字符串结果，
 * 绝不抛出。工具错误是模型要读的反馈，不是控制流异常；抛出去会中断整个回合，
 * 模型也就失去了纠正的机会。
 */
async function dispatch(
  ctx: Context,
  cid: number,
  tc: { id: string; name: string; args: string },
  signal: AbortSignal,
): Promise<{ ok: boolean; text: string }> {
  let args: unknown
  try {
    args = JSON.parse(tc.args || '{}')
  } catch {
    return { ok: false, text: 'error: invalid arguments' }
  }

  // 管线不携带会话身份，但审批卡片必须发到正确的对话窗口去。
  noteCallOrigin(tc.id, cid)
  try {
    const r = await ctx.tools.execute({ callId: CallId(tc.id), name: tc.name, arguments: args, signal })
    const text = r.content?.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? ''
    return { ok: !r.isError, text }
  } catch (err) {
    // **绝不让异常从这里逃出去。**
    //
    // 逃出去的后果不是「这一轮失败」，而是「这段对话永久损坏」：调用方在这之前
    // 已经写了一条 tool-call 事件，异常会跳过配对的 tool-result，日志里从此留下
    // 一个没有答复的工具调用。之后每次重放，发给 API 的都是「assistant 带
    // tool_calls，后面却没有 tool 消息」——任何 OpenAI 兼容的接口都拒收这个形状，
    // 于是这段对话再也问不了任何问题。
    //
    // 中止也走这条路：用户点停止时 execute 会 reject，那一样会留下断口。
    const aborted = (err as Error)?.name === 'AbortError' || signal.aborted
    return { ok: false, text: aborted ? 'error: interrupted' : `error: ${(err as Error)?.message ?? 'tool failed'}` }
  } finally {
    forgetCallOrigin(tc.id)
  }
}

/** 模型窗口未配置时的保守默认。近似单位与 assemble 一致（字符/4）。 */
const DEFAULT_BUDGET = { contextWindow: 128000, reserveForOutput: 4000 }

export interface RunTurnOptions {
  conversationId: number
  question: string
  refs: AttachmentRef[]
  systemPrompt: string
  signal: AbortSignal
  budget?: { contextWindow: number; reserveForOutput: number }
  /** 附件最终去向定下来时回调一次，供入口写进 UI 投影。 */
  onAttachments?: (attachments: AttachmentStatus[]) => void
}

export interface TurnResult {
  /** 本回合完成的工具调用，按发生顺序。入口把它挂到助手消息上落库。 */
  calls: ToolCallRecord[]
  /**
   * 执行轨迹：模型的阶段说明 + 工具调用，按发生顺序。
   *
   * 界面用它做那条可展开的过程条。注意 note 那部分**过去是被丢掉的**——
   * 它跟着 chatReset 一起清掉了，而那恰恰是整条轨迹里最可读的部分。
   */
  trace: TraceEntry[]
  /** 回合总耗时，供「已完成 · 用时 18s」那行显示。 */
  elapsedMs: number
  /** 最后一次装配的上下文报告——也就是真正产出这个回答的那一份。 */
  context: ContextReport | null
}

export async function runTurn(ctx: Context, store: SessionStore, opts: RunTurnOptions): Promise<TurnResult> {
  const cid = opts.conversationId
  const turnId = randomUUID()
  const budget = opts.budget ?? DEFAULT_BUDGET
  const calls: ToolCallRecord[] = []
  const trace: TraceEntry[] = []
  const startedAtTurn = Date.now()
  let context: ContextReport | null = null

  // 用户点停止时，把悬着的审批一并按拒绝结算。
  //
  // 没有这一句，中止就中止不掉：审批闸门 await 在 requestApproval 上，而它只有
  // 用户点按钮才会 settle——AbortSignal 传不进那个 Promise。回合会一直挂着，
  // 界面停在「运行中」，谁也不知道它在等什么。
  const onAbort = (): void => abandonApprovals(cid)
  opts.signal.addEventListener('abort', onAbort, { once: true })

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
      const tools = toWireSchemas(ctx, cid)
      const { messages, report, attachments } = assemble({ events, systemPrompt: opts.systemPrompt, tools, budget })
      assertProjectionMatches(messages.filter((m) => m.role !== 'system'), events)

      // 每轮都覆盖：产出答案的是最后一轮，检查器要看的也是那一份。
      context = report
      emit({ type: 'knowledge.context', conversationId: cid, report })

      // 只在第一轮报告附件：此时预算已知（truncated 是终值），而后续轮次的
      // 装配会因为历史增长得出不同的截断结果，界面上的芯片不该随之跳动。
      if (round === 0 && attachments.length > 0) {
        opts.onAttachments?.(attachments)
        emit({ type: 'knowledge.attachments', conversationId: cid, attachments })
      }

      const r = await ctx.chat.stream(
        { messages, tools },
        (delta) => { emit({ type: 'knowledge.chatDelta', conversationId: cid, delta }) },
        opts.signal,
      )

      if (!r.toolCalls.length) {
        store.append(cid, { kind: 'assistant-message', text: r.text, reasoning: r.reasoning || undefined })
        break
      }

      // 这一轮流出来的是「打算做什么 / 发现了什么」，不是答案。从气泡里清掉，
      // 但**不要丢掉**——收进执行轨迹。过去这段话直接没了，而它恰恰是整条轨迹
      // 里最可读的部分（「继续推进下一阶段：正在核验高校名单」这种）。
      const note = r.text.trim()
      if (note) {
        trace.push({ kind: 'note', text: note, round })
        emit({ type: 'knowledge.traceNote', conversationId: cid, text: note, round })
      }
      emit({ type: 'knowledge.chatReset', conversationId: cid })

      for (const [i, tc] of r.toolCalls.entries()) {
        // reasoning 只挂在本轮第一条上：它是「这一轮想了什么」，不是某一次调用
        // 的属性。每条都挂会让同一段思考在回传时重复出现好几遍。
        store.append(cid, {
          kind: 'tool-call', id: tc.id, name: tc.name, args: tc.args,
          reasoning: i === 0 && r.reasoning ? r.reasoning : undefined,
        })

        // 先发一张「进行中」的卡片：模型一开口要调工具，界面就该显示出来，
        // 而不是等它跑完。卡片按 id 更新，下面那次发送覆盖这一次。
        const kind = kindOf(tc.name)
        emit({
          type: 'knowledge.toolCall',
          conversationId: cid,
          call: { id: tc.id, name: tc.name, kind, args: tc.args },
        })

        const startedAt = Date.now()
        const out = await dispatch(ctx, cid, tc, opts.signal)
        store.append(cid, { kind: 'tool-result', id: tc.id, name: tc.name, result: out.text })

        const record: ToolCallRecord = {
          id: tc.id,
          name: tc.name,
          kind,
          args: tc.args,
          result: out.text,
          ok: out.ok,
          durationMs: Date.now() - startedAt,
        }
        calls.push(record)
        trace.push({ kind: 'tool', call: record })
        emit({ type: 'knowledge.toolCall', conversationId: cid, call: record })
      }
    }

    store.append(cid, { kind: 'turn-end', turnId, reason: 'done' })
    ctx.emit('turn/end', { turnId, reason: 'done' })
    emit({ type: 'knowledge.chatState', conversationId: cid, state: 'done' })
    opts.signal.removeEventListener('abort', onAbort)
    return { calls, trace, context, elapsedMs: Date.now() - startedAtTurn }
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
    // 中断/出错也要把已经跑过的工具交出去：那些副作用真的发生了，界面上不能
    // 因为回合失败就当它们没存在过。
    opts.signal.removeEventListener('abort', onAbort)
    return { calls, trace, context, elapsedMs: Date.now() - startedAtTurn }
  }
}
