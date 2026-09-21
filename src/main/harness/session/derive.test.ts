import { describe, it, expect } from 'vitest'
import { MemorySessionStore } from './memoryStore'
import { deriveMessages, assertProjectionMatches } from './derive'

function store(): MemorySessionStore {
  const s = new MemorySessionStore()
  s.append(1, { kind: 'turn-start', turnId: 't1' })
  return s
}

describe('deriveMessages', () => {
  it('projects a plain question into one user message', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: '什么是对比学习？', refs: [] })
    expect(deriveMessages(s.read(1))).toEqual([
      { role: 'user', content: '什么是对比学习？' },
    ])
  })

  it('appends resolved attachments after the question, not as system messages', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: '这篇讲了什么？', refs: [{ type: 'item', itemKey: 'K1' }] })
    s.append(1, {
      kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K1' },
      result: {
        ok: true, itemKey: 'K1', title: 'Paper A', text: 'BODY',
        totalBytes: 4, shownBytes: 4, truncated: false,
      },
    })
    const msgs = deriveMessages(s.read(1))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toContain('这篇讲了什么？')
    expect(msgs[0].content).toContain('<paper item_key="K1" title="Paper A" truncated="false">')
    expect(msgs[0].content).toContain('BODY')
  })

  it('states the real reason when an attachment could not be read', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: '看看这篇', refs: [{ type: 'item', itemKey: 'K2' }] })
    s.append(1, {
      kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K2' },
      result: { ok: false, title: 'Paper B', reason: 'not_converted', detail: 'no markdown attachment' },
    })
    const content = deriveMessages(s.read(1))[0].content ?? ''
    expect(content).toContain('error="not_converted"')
    expect(content).not.toContain('no converted markdown text is available')
  })

  it('discloses truncation with real byte counts', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K3' }] })
    s.append(1, {
      kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K3' },
      result: {
        ok: true, itemKey: 'K3', title: 'P', text: 'HEAD',
        totalBytes: 62310, shownBytes: 4, truncated: true,
      },
    })
    const content = deriveMessages(s.read(1))[0].content ?? ''
    expect(content).toContain('truncated="true"')
    expect(content).toContain('62310')
    expect(content).toContain('4')
  })

  it('keeps a tool call and its result adjacent and in order', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [] })
    s.append(1, { kind: 'tool-call', id: 'c1', name: 'get_item_info', args: '{"item_key":"K1"}' })
    s.append(1, { kind: 'tool-result', id: 'c1', name: 'get_item_info', result: '{"title":"A"}' })
    s.append(1, { kind: 'assistant-message', text: '答案' })
    const msgs = deriveMessages(s.read(1))
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(msgs[1].tool_calls?.[0].id).toBe('c1')
    expect(msgs[2].tool_call_id).toBe('c1')
  })
})

describe('assertProjectionMatches', () => {
  it('passes when the sent messages equal the projection', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [] })
    const msgs = deriveMessages(s.read(1))
    expect(() => { assertProjectionMatches(msgs, s.read(1)) }).not.toThrow()
  })

  it('throws when content was smuggled in outside the log', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [] })
    const smuggled = [...deriveMessages(s.read(1)), { role: 'user' as const, content: '偷偷加的' }]
    expect(() => { assertProjectionMatches(smuggled, s.read(1)) }).toThrow(/not reconstructable/i)
  })
})

// 思考模式的模型（DeepSeek thinking 系）单独返回 reasoning_content，并且要求
// **原样回传**，否则下一轮直接 400：
//   The `reasoning_content` in the thinking mode must be passed back to the API.
// 这是一条「模型可见即已记录」的实例：它进了模型的输出，就必须能从日志重建。
describe('reasoning_content 的回传', () => {
  it('带工具调用那一轮的思考挂回 assistant 消息', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'search_library', args: '{}', reasoning: '先查一下' },
    ])
    expect(msgs[1]).toMatchObject({ role: 'assistant', reasoning_content: '先查一下' })
  })

  // 这条是 QwenLM/qwen-code#3579 的教训：API 要求的是这个字段**存在**，不是
  // 「有内容才带」。模型某一轮吐了 tool_calls 却没吐 reasoning，或者是加这个
  // 字段之前留下的老对话，缺字段一样 400。
  it('工具轮没有思考内容时给空串，而不是省掉这个字段', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
    ])
    expect(msgs[1]).toHaveProperty('reasoning_content', '')
  })

  it('老对话（日志里没有 reasoning）也能重放，不会缺字段', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
      { kind: 'tool-result', id: 'c1', name: 'x', result: 'r' },
      { kind: 'assistant-message', text: '答案' },
    ])
    expect(msgs.find((m) => m.tool_calls)).toHaveProperty('reasoning_content', '')
  })

  // 上游的修复只作用于带 tool_calls 的 assistant 消息。给不支持思考模式的
  // 供应商多塞一个未知字段，会招来另一种 400。
  it('不带 tool_calls 的 assistant 消息不加这个字段', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'assistant-message', text: '答案', reasoning: '想了想' },
    ])
    expect(msgs[1]).not.toHaveProperty('reasoning_content')
  })

  it('同一轮多个工具调用，真实思考只出现一次', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'a', args: '{}', reasoning: '想了想' },
      { kind: 'tool-call', id: 'c2', name: 'b', args: '{}' },
    ])
    expect(msgs.filter((m) => m.reasoning_content === '想了想')).toHaveLength(1)
  })

  // Kimi K2.5 那个相关 bug：tool_calls.type 缺失/非法。我们是硬编码 'function'，
  // 不来自模型响应，所以不受影响——钉住它，别哪天改成透传。
  it('tool_calls.type 恒为 function，不透传模型给的值', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'a', args: '{}' },
    ])
    expect(msgs[1].tool_calls?.[0].type).toBe('function')
  })
})

// 「一个对话坏了就一直坏」的根因：日志里留下一条没有答复的 tool-call，之后每
// 次重放都是非法形状（assistant 带 tool_calls，后面没有 tool 消息），任何
// OpenAI 兼容接口都拒收。一次意外变成永久损坏。
describe('悬空的工具调用', () => {
  const idsOf = (msgs: ReturnType<typeof deriveMessages>): string[] =>
    msgs.map((m) => (m.role === 'assistant' && m.tool_calls ? 'A' : m.role === 'tool' ? 'T' : m.role[0]))

  it('日志末尾悬着的调用会被补上答复', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
      { kind: 'turn-end', turnId: 't', reason: 'aborted' },
    ])
    expect(idsOf(msgs)).toEqual(['u', 'A', 'T'])
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'error: interrupted' })
  })

  it('后面又来了新提问时，先把断口补上再接新的一轮', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q1', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
      { kind: 'user-message', text: 'q2', refs: [] },
    ])
    // 关键：assistant(tool_calls) 后面**紧跟** tool，然后才是新的 user
    expect(idsOf(msgs)).toEqual(['u', 'A', 'T', 'u'])
  })

  it('中断之后还能继续对话 —— 这正是之前永久损坏的那条路', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q1', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
      { kind: 'user-message', text: 'q2', refs: [] },
      { kind: 'assistant-message', text: '答案' },
    ])
    expect(idsOf(msgs)).toEqual(['u', 'A', 'T', 'u', 'a'])
    // 每一条 tool_calls 都有配对的答复，没有例外
    for (const [i, m] of msgs.entries()) {
      if (m.role === 'assistant' && m.tool_calls) {
        expect(msgs[i + 1]).toMatchObject({ role: 'tool', tool_call_id: m.tool_calls[0].id })
      }
    }
  })

  it('正常配对时不补，也不改动内容', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
      { kind: 'tool-result', id: 'c1', name: 'x', result: '真结果' },
    ])
    expect(idsOf(msgs)).toEqual(['u', 'A', 'T'])
    expect(msgs.at(-1)).toMatchObject({ content: '真结果' })
  })

  it('连着两条调用只答复了后一条时，前一条也补上', () => {
    const msgs = deriveMessages([
      { kind: 'user-message', text: 'q', refs: [] },
      { kind: 'tool-call', id: 'c1', name: 'x', args: '{}' },
      { kind: 'tool-call', id: 'c2', name: 'y', args: '{}' },
      { kind: 'tool-result', id: 'c2', name: 'y', result: 'r2' },
    ])
    expect(idsOf(msgs)).toEqual(['u', 'A', 'T', 'A', 'T'])
    expect(msgs[2]).toMatchObject({ tool_call_id: 'c1', content: 'error: interrupted' })
    expect(msgs[4]).toMatchObject({ tool_call_id: 'c2', content: 'r2' })
  })
})
