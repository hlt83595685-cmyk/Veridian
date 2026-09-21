// 第一条竖线的回归基线。后续所有改动都要保持它绿。
import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const emitted: Array<Record<string, unknown>> = []
vi.mock('../core/Notifier', () => ({
  emit: (e: Record<string, unknown>) => {
    emitted.push(e)
  },
}))

// 真的 activeHorse 会去查马厩（better-sqlite3），vitest 里加载不了。
// 这里给一匹装齐了的马——本文件测的是回合流程，不是装配。
const HORSE = {
  id: 'h1', name: 'Groom', skin: 'bay', ceiling: 'destructive' as const,
  tools: ['get_item_info'], isDefault: true, createdAt: 0,
}
vi.mock('./activeHorse', () => ({ horseFor: () => HORSE }))

import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { runTurn } from './turn'
import { MemorySessionStore } from './session/memoryStore'
import { deriveMessages } from './session/derive'
import { declareKind, _resetKinds } from './tools/kinds'
import { installPolicy } from './tools/policy'

/** 第一轮要求调工具，第二轮给出答案——覆盖完整的工具往返。 */
function fakeLlm(): { stream: (req: unknown, onText: (d: string) => void) => Promise<unknown> } {
  let round = 0
  return {
    async stream(_req, onText) {
      round++
      if (round === 1) {
        onText('让我查一下…')
        return {
          text: '让我查一下…',
          toolCalls: [{ id: 'c1', name: 'get_item_info', args: '{"item_key":"K1"}' }],
        }
      }
      onText('答案是 42。')
      return { text: '答案是 42。', toolCalls: [] }
    },
  }
}

/** 挂真的工具管线，只把工具体换成假的——要验的正是接线本身，stub 掉就等于没验。 */
async function fakeCtx(toolBody?: () => Promise<string>): Promise<Context> {
  const ctx = new Context()
  const bag = ctx as unknown as Record<string, unknown>
  bag.chat = fakeLlm()
  bag.attachment = {
    resolve: async () => ({
      ok: true, itemKey: 'K1', title: 'Paper A', text: 'FULL-BODY',
      totalBytes: 9, shownBytes: 9, truncated: false,
    }),
  }
  // ToolRuntime 的 static inject = ['systemPrompt']，少挂一个 ctx.tools 就是 undefined。
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(Tools, {})
  for (let i = 0; i < 100 && !ctx.tools; i++) await new Promise((r) => setTimeout(r, 10))
  if (!ctx.tools) throw new Error('dsh-tools did not activate')

  ctx.tools.register(defineTool({
    name: 'get_item_info',
    description: 'test double',
    parameters: { item_key: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: toolBody ?? (async () => '{"title":"Paper A"}'),
  }))
  return ctx
}

describe('runTurn 端到端', () => {
  it('走完一次带工具往返的回合，日志与投影一致', async () => {
    emitted.length = 0
    const store = new MemorySessionStore()

    const result = await runTurn(await fakeCtx(), store, {
      conversationId: 1,
      question: '这篇讲了什么？',
      refs: [{ type: 'item', itemKey: 'K1' }],
      systemPrompt: 'SYS',
      signal: new AbortController().signal,
    })

    const events = store.read(1)
    expect(events.map((e) => e.kind)).toEqual([
      'turn-start', 'user-message', 'attachment-resolved',
      'tool-call', 'tool-result', 'assistant-message', 'turn-end',
    ])

    // 附件进的是用户消息，不是独立的 system 消息
    const msgs = deriveMessages(events)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toContain('FULL-BODY')
    expect(msgs.some((m) => m.role === 'system')).toBe(false)

    // 工具调用与结果成对且顺序正确
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(msgs[1].tool_calls?.[0].id).toBe('c1')
    expect(msgs[2].tool_call_id).toBe('c1')

    // 渲染层事件序列
    const types = emitted.map((e) => e.type)
    expect(types[0]).toBe('knowledge.chatState')
    expect(types).toContain('knowledge.chatDelta')
    expect(types).toContain('knowledge.toolCall')
    expect(emitted[emitted.length - 1]).toMatchObject({ type: 'knowledge.chatState', state: 'done' })

    // 工具卡片：先发一张进行中的（ok 未定），跑完再发一张带结果的，同一个 id
    const cards = emitted.filter((e) => e.type === 'knowledge.toolCall').map((e) => e.call as Record<string, unknown>)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({ id: 'c1', name: 'get_item_info', kind: 'read' })
    expect(cards[0].ok).toBeUndefined()
    expect(cards[1]).toMatchObject({ id: 'c1', ok: true, kind: 'read' })
    expect(cards[1].result).toContain('Paper A')

    // 回合把工具调用交还给调用方，供入口落库
    expect(result.calls.map((c) => c.id)).toEqual(['c1'])
  })

  it('中止时结算掉悬着的审批，回合不会永远挂着', async () => {
    emitted.length = 0
    // 真实场景：写工具 → 审批闸门 await 在 requestApproval 上 → 用户没点按钮。
    // 这里用的是真的 approvals 模块，所以那个 Promise 是真的悬着的。
    const ctx = await fakeCtx()
    _resetKinds()
    declareKind('get_item_info', 'write-library')
    installPolicy(ctx, { horse: () => HORSE })

    const ac = new AbortController()
    const store = new MemorySessionStore()
    const turn = runTurn(ctx, store, {
      conversationId: 3, question: 'q', refs: [],
      systemPrompt: 'SYS', signal: ac.signal,
    })

    // 等回合走到审批那一步（卡片发出来就说明到了）。
    for (let i = 0; i < 100; i++) {
      if (emitted.some((e) => e.type === 'knowledge.approval')) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(emitted.some((e) => e.type === 'knowledge.approval')).toBe(true)

    ac.abort()
    const settled = await Promise.race([
      turn.then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('hung'), 1500)),
    ])
    expect(settled).toBe('returned')
    // 悬着的审批按拒绝结算，工具没跑
    expect(store.read(3).some((e) => e.kind === 'tool-result'
      && String((e as { result?: string }).result ?? '').includes('declined'))).toBe(true)
    _resetKinds()
  })

  it('把模型错误变成 error 状态，而不是让异常逃出去', async () => {
    emitted.length = 0
    const ctx = await fakeCtx()
    ;(ctx as unknown as Record<string, unknown>).chat = {
      stream: async () => { throw new Error('provider exploded') },
    }
    const store = new MemorySessionStore()

    // 失败也要正常返回（不是抛出），并且把已经跑过的工具交出来
    const result = await runTurn(ctx, store, {
      conversationId: 2, question: 'q', refs: [],
      systemPrompt: 'SYS', signal: new AbortController().signal,
    })
    expect(result.calls).toEqual([])
    // 装配发生在请求之前，所以「这一轮试图发出去的是什么」依然有据可查
    expect(result.context?.usedTokens).toBeGreaterThan(0)

    expect(store.read(2).at(-1)).toMatchObject({ kind: 'turn-end', reason: 'error' })
    expect(emitted.at(-1)).toMatchObject({ type: 'knowledge.chatState', state: 'error' })
  })
})
