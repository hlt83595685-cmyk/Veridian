// 第一条竖线的回归基线。后续所有改动都要保持它绿。
import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const emitted: Array<Record<string, unknown>> = []
vi.mock('../core/Notifier', () => ({
  emit: (e: Record<string, unknown>) => {
    emitted.push(e)
  },
}))

import { runTurn } from './turn'
import { MemorySessionStore } from './session/memoryStore'
import { deriveMessages } from './session/derive'

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

function fakeCtx(): Context {
  const ctx = new Context()
  const bag = ctx as unknown as Record<string, unknown>
  bag.llm = fakeLlm()
  bag.attachment = {
    resolve: async () => ({
      ok: true, itemKey: 'K1', title: 'Paper A', text: 'FULL-BODY',
      totalBytes: 9, shownBytes: 9, truncated: false,
    }),
  }
  bag.tools = { schemas: () => [], run: async () => '{"title":"Paper A"}' }
  return ctx
}

describe('runTurn 端到端', () => {
  it('走完一次带工具往返的回合，日志与投影一致', async () => {
    emitted.length = 0
    const store = new MemorySessionStore()

    await runTurn(fakeCtx(), store, {
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
    expect(types).toContain('knowledge.step')
    expect(emitted[emitted.length - 1]).toMatchObject({ type: 'knowledge.chatState', state: 'done' })
  })

  it('把模型错误变成 error 状态，而不是让异常逃出去', async () => {
    emitted.length = 0
    const ctx = fakeCtx()
    ;(ctx as unknown as Record<string, unknown>).llm = {
      stream: async () => { throw new Error('provider exploded') },
    }
    const store = new MemorySessionStore()

    await expect(runTurn(ctx, store, {
      conversationId: 2, question: 'q', refs: [],
      systemPrompt: 'SYS', signal: new AbortController().signal,
    })).resolves.toBeUndefined()

    expect(store.read(2).at(-1)).toMatchObject({ kind: 'turn-end', reason: 'error' })
    expect(emitted.at(-1)).toMatchObject({ type: 'knowledge.chatState', state: 'error' })
  })
})
