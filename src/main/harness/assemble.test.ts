import { describe, it, expect } from 'vitest'
import { assemble } from './assemble'
import type { SessionEvent } from './session/types'

const SYS = 'SYSTEM'
const budget = { contextWindow: 1000, reserveForOutput: 100 } // 近似单位：字符/4

function withHistory(n: number): SessionEvent[] {
  const out: SessionEvent[] = []
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'user-message', text: `Q${i} ${'x'.repeat(200)}`, refs: [] })
    out.push({ kind: 'assistant-message', text: `A${i}` })
  }
  return out
}

describe('assemble', () => {
  it('never evicts the system prompt', () => {
    const r = assemble({ events: withHistory(30), systemPrompt: SYS, tools: [], budget })
    expect(r.messages[0]).toEqual({ role: 'system', content: SYS })
  })

  it('drops the oldest history first', () => {
    const r = assemble({ events: withHistory(30), systemPrompt: SYS, tools: [], budget })
    const body = r.messages.map((m) => m.content ?? '').join('\n')
    expect(body).not.toContain('Q0 ')
    expect(body).toContain('Q29 ')
    expect(r.report.droppedTurns).toBeGreaterThan(0)
  })

  it('keeps the attachment even when history must go', () => {
    const events: SessionEvent[] = [
      ...withHistory(30),
      { kind: 'user-message', text: '这篇讲了什么？', refs: [{ type: 'item', itemKey: 'K1' }] },
      {
        kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K1' },
        result: {
          ok: true, itemKey: 'K1', title: 'P', text: 'IMPORTANT-BODY',
          totalBytes: 14, shownBytes: 14, truncated: false,
        },
      },
    ]
    const r = assemble({ events, systemPrompt: SYS, tools: [], budget })
    expect(r.messages.map((m) => m.content ?? '').join('\n')).toContain('IMPORTANT-BODY')
  })

  it('truncates an oversized attachment and says so with real numbers', () => {
    const big = 'B'.repeat(20000)
    const events: SessionEvent[] = [
      { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K1' }] },
      {
        kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K1' },
        result: {
          ok: true, itemKey: 'K1', title: 'P', text: big,
          totalBytes: big.length, shownBytes: big.length, truncated: false,
        },
      },
    ]
    const r = assemble({ events, systemPrompt: SYS, tools: [], budget })
    const body = r.messages.map((m) => m.content ?? '').join('\n')
    expect(body).toContain('truncated="true"')
    expect(body).toContain(String(big.length))
    expect(body.length).toBeLessThan(big.length)
    expect(r.report.truncatedAttachments).toBe(1)
  })

  // 芯片只信 report.attachments。它错了，界面就会告诉用户「已读全文」而模型
  // 其实什么也没拿到——正是旧实现那个谎的翻版，所以这几条单独钉住。
  describe('report.attachments', () => {
    const resolved = (
      itemKey: string,
      result: Extract<SessionEvent, { kind: 'attachment-resolved' }>['result'],
    ): SessionEvent => ({ kind: 'attachment-resolved', ref: { type: 'item', itemKey }, result })

    it('reports a fully-read attachment with its real size', () => {
      const text = 'C'.repeat(300)
      const r = assemble({
        events: [
          { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K1' }] },
          resolved('K1', { ok: true, itemKey: 'K1', title: 'Paper One', text, totalBytes: 300, shownBytes: 300, truncated: false }),
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      expect(r.attachments).toEqual([
        { key: 'K1', title: 'Paper One', ok: true, totalBytes: 300, shownBytes: 300, truncated: false },
      ])
    })

    it('reports truncation with shownBytes strictly below totalBytes', () => {
      const big = 'B'.repeat(20000)
      const r = assemble({
        events: [
          { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K1' }] },
          resolved('K1', { ok: true, itemKey: 'K1', title: 'P', text: big, totalBytes: big.length, shownBytes: big.length, truncated: false }),
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      const [a] = r.attachments
      expect(a.truncated).toBe(true)
      expect(a.totalBytes).toBe(big.length)
      expect(a.shownBytes).toBeLessThan(a.totalBytes)
      expect(a.shownBytes).toBeGreaterThan(0)
    })

    it('reports a failure with its reason and raw detail, never as ok', () => {
      const r = assemble({
        events: [
          { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K9' }] },
          resolved('K9', { ok: false, title: 'Unconverted Paper', reason: 'not_converted', detail: 'no markdown attachment' }),
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      expect(r.attachments).toEqual([
        {
          key: 'K9', title: 'Unconverted Paper', ok: false, reason: 'not_converted',
          detail: 'no markdown attachment', totalBytes: 0, shownBytes: 0, truncated: false,
        },
      ])
    })

    it('keeps one entry per attachment, in order, when some fail', () => {
      const r = assemble({
        events: [
          { kind: 'user-message', text: 'q', refs: [] },
          resolved('A', { ok: true, itemKey: 'A', title: 'A', text: 'aaa', totalBytes: 3, shownBytes: 3, truncated: false }),
          resolved('B', { ok: false, title: 'B', reason: 'not_found', detail: 'no item with key B' }),
          resolved('C', { ok: true, itemKey: 'C', title: 'C', text: 'ccc', totalBytes: 3, shownBytes: 3, truncated: false }),
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      expect(r.attachments.map((a) => [a.key, a.ok])).toEqual([['A', true], ['B', false], ['C', true]])
    })

    it('reports only this turn’s attachments, not earlier turns’', () => {
      // 事件流是整条会话。若把旧回合的附件也算进来，第二次提问的芯片上会挂出
      // 第一次的论文——用户会以为这一轮读了它，其实没有。
      const r = assemble({
        events: [
          { kind: 'turn-start', turnId: 't1' },
          { kind: 'user-message', text: 'q1', refs: [{ type: 'item', itemKey: 'OLD' }] },
          resolved('OLD', { ok: true, itemKey: 'OLD', title: 'Old Paper', text: 'ooo', totalBytes: 3, shownBytes: 3, truncated: false }),
          { kind: 'assistant-message', text: 'a1' },
          { kind: 'turn-end', turnId: 't1', reason: 'done' },
          { kind: 'turn-start', turnId: 't2' },
          { kind: 'user-message', text: 'q2', refs: [{ type: 'item', itemKey: 'NEW' }] },
          resolved('NEW', { ok: true, itemKey: 'NEW', title: 'New Paper', text: 'nnn', totalBytes: 3, shownBytes: 3, truncated: false }),
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      expect(r.attachments.map((a) => a.key)).toEqual(['NEW'])
    })

    it('still sends the earlier turn’s attachment text even though it is not reported', () => {
      const r = assemble({
        events: [
          { kind: 'turn-start', turnId: 't1' },
          { kind: 'user-message', text: 'q1', refs: [{ type: 'item', itemKey: 'OLD' }] },
          resolved('OLD', { ok: true, itemKey: 'OLD', title: 'Old Paper', text: 'OLD-BODY', totalBytes: 8, shownBytes: 8, truncated: false }),
          { kind: 'assistant-message', text: 'a1' },
          { kind: 'turn-end', turnId: 't1', reason: 'done' },
          { kind: 'turn-start', turnId: 't2' },
          { kind: 'user-message', text: 'q2', refs: [] },
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      expect(r.messages.map((m) => m.content ?? '').join('\n')).toContain('OLD-BODY')
      expect(r.attachments).toEqual([])
    })

    it('does not let a failed attachment consume budget from a later one', () => {
      const text = 'D'.repeat(400)
      const r = assemble({
        events: [
          { kind: 'user-message', text: 'q', refs: [] },
          resolved('BAD', { ok: false, title: 'BAD', reason: 'unreadable', detail: 'EACCES' }),
          resolved('GOOD', { ok: true, itemKey: 'GOOD', title: 'GOOD', text, totalBytes: 400, shownBytes: 400, truncated: false }),
        ],
        systemPrompt: SYS, tools: [], budget,
      })
      expect(r.attachments[1]).toMatchObject({ key: 'GOOD', ok: true, truncated: false, shownBytes: 400 })
    })
  })

  it('counts the tool schemas as fixed overhead that never gets evicted', () => {
    const tools = [{
      type: 'function' as const,
      function: { name: 'x'.repeat(400), description: 'd', parameters: {} },
    }]
    const r = assemble({ events: withHistory(30), systemPrompt: SYS, tools, budget })
    expect(r.report.fixedTokens).toBeGreaterThan(100)
    expect(r.messages[0]).toEqual({ role: 'system', content: SYS })
  })
})
