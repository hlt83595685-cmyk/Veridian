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
