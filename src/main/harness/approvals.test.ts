// 关于 abandonApprovals：runTurn 把它挂在 opts.signal 的 abort 上。少了那一句，
// 用户点「停止」是停不掉的——审批闸门 await 在 requestApproval 上，而 AbortSignal
// 传不进那个 Promise，回合会一直挂着。turn.ts 里有对应的注释。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const emitted: Array<Record<string, unknown>> = []
vi.mock('../core/Notifier', () => ({
  emit: (e: Record<string, unknown>) => {
    emitted.push(e)
  },
}))

import {
  requestApproval,
  resolveApproval,
  abandonApprovals,
  clearSessionAllowances,
  _state,
  type ApprovalAsk,
} from './approvals'
import type { ApprovalChange } from '../../shared/types'

function ask(over: Partial<ApprovalAsk> = {}): ApprovalAsk {
  return {
    conversationId: 1,
    tool: 'update_metadata',
    kind: 'write-library',
    summary: '修正 1 篇文献的标题',
    affected: 1,
    changes: [],
    args: '{}',
    ...over,
  }
}

const lastRequestId = (): string => {
  const e = [...emitted].reverse().find((x) => x.type === 'knowledge.approval')
  return (e?.request as { id: string }).id
}

describe('approvals', () => {
  beforeEach(() => {
    emitted.length = 0
    clearSessionAllowances(1)
    abandonApprovals(1)
    emitted.length = 0
  })

  it('parks until the user decides', async () => {
    let settled = false
    const p = requestApproval(ask()).then((d) => {
      settled = true
      return d
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(_state().pending).toBe(1)

    resolveApproval(lastRequestId(), 'allow-once')
    expect(await p).toBe('allow-once')
    expect(_state().pending).toBe(0)
  })

  it('denies when the user denies', async () => {
    const p = requestApproval(ask())
    resolveApproval(lastRequestId(), 'deny')
    expect(await p).toBe('deny')
  })

  // 会话放行是按「工具类别」记的，不是按工具名 —— 批准了「改我的库」不等于
  // 批准了「写我的磁盘」。
  it('allow-session admits the same kind without asking again', async () => {
    const first = requestApproval(ask())
    resolveApproval(lastRequestId(), 'allow-session')
    expect(await first).toBe('allow-session')

    emitted.length = 0
    expect(await requestApproval(ask({ tool: 'add_tags' }))).toBe('allow-once')
    // 放行不等于隐身：仍然要发事件，用户看得见发生了什么
    expect(emitted.map((e) => e.type)).toEqual([
      'knowledge.approval',
      'knowledge.approvalResolved',
    ])
  })

  it('does not let a session allowance leak to a more dangerous kind', async () => {
    resolveApproval((requestApproval(ask()), lastRequestId()), 'allow-session')

    let settled = false
    void requestApproval(ask({ kind: 'destructive', tool: 'delete_item' })).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false) // 仍然要问
  })

  it('does not let a session allowance leak to another conversation', async () => {
    resolveApproval((requestApproval(ask()), lastRequestId()), 'allow-session')

    let settled = false
    void requestApproval(ask({ conversationId: 2 })).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    abandonApprovals(2)
  })

  // 一个悬着的请求如果既不通过也不结算，回合会永远卡住；默认必须是拒绝。
  it('settles abandoned requests as denied rather than leaving them hanging', async () => {
    const p = requestApproval(ask())
    abandonApprovals(1)
    expect(await p).toBe('deny')
    expect(_state().pending).toBe(0)
  })

  it('caps the sampled changes but reports the true count', async () => {
    const changes: ApprovalChange[] = Array.from({ length: 90 }, (_, i) => ({
      type: 'field',
      itemKey: `K${i}`,
      title: `Paper ${i}`,
      field: 'title',
      before: 'a',
      after: 'b',
    }))
    void requestApproval(ask({ affected: 90, changes }))
    const req = [...emitted].reverse().find((e) => e.type === 'knowledge.approval')!
      .request as { affected: number; changes: unknown[] }
    expect(req.affected).toBe(90)
    expect(req.changes.length).toBe(20)
    abandonApprovals(1)
  })

  it('ignores a decision for an unknown id instead of throwing', () => {
    expect(() => resolveApproval('nope', 'allow-once')).not.toThrow()
  })
})
