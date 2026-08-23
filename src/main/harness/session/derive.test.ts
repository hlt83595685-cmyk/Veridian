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
