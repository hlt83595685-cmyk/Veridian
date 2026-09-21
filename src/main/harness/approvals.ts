// 写操作的闸门。
//
// 工具要动用户的东西时，调用 requestApproval() 并 await 它——回合就停在这里，
// 直到用户点了按钮。这是「人在环上」那一层，也是提示注入的最后一道防线：
// 就算模型被论文里的指令骗了，动手之前仍要经过这一关。
//
// 会话级放行只记在内存里，不落库：它的语义就是「这段对话里别再问了」，
// 重启之后重新问一遍是正确行为，不是缺陷。
import { randomUUID } from 'crypto'
import { emit } from '../core/Notifier'
import type {
  ApprovalChange,
  ApprovalDecision,
  ApprovalRequest,
  ToolKind,
} from '../../shared/types'

/** 卡片里最多摆几条改动；`affected` 才是真实条数。 */
const SAMPLE_LIMIT = 20

interface Pending {
  request: ApprovalRequest
  settle: (decision: ApprovalDecision) => void
}

const pending = new Map<string, Pending>()

/** conversationId -> 该会话已放行的工具类别。 */
const sessionAllowed = new Map<number, Set<ToolKind>>()

export interface ApprovalAsk {
  conversationId: number
  tool: string
  kind: ToolKind
  summary: string
  /** 真实受影响条数。changes 可能只是其中的样本。 */
  affected: number
  changes: ApprovalChange[]
  args: string
}

/**
 * 请求批准。已获会话级放行的类别直接通过，但**仍然发事件**——放行不等于隐身，
 * 用户必须能看到那一刻发生了什么。
 */
export function requestApproval(ask: ApprovalAsk): Promise<ApprovalDecision> {
  const request: ApprovalRequest = {
    id: randomUUID(),
    conversationId: ask.conversationId,
    tool: ask.tool,
    kind: ask.kind,
    summary: ask.summary,
    affected: ask.affected,
    changes: ask.changes.slice(0, SAMPLE_LIMIT),
    args: ask.args,
  }

  if (sessionAllowed.get(ask.conversationId)?.has(ask.kind)) {
    emit({ type: 'knowledge.approval', request })
    emit({ type: 'knowledge.approvalResolved', id: request.id, decision: 'allow-once' })
    return Promise.resolve('allow-once')
  }

  emit({ type: 'knowledge.approval', request })
  return new Promise<ApprovalDecision>((resolve) => {
    pending.set(request.id, { request, settle: resolve })
  })
}

/** 用户点了按钮。未知 id 静默忽略——重复点击或迟到的点击不该让主进程抛错。 */
export function resolveApproval(id: string, decision: ApprovalDecision): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  if (decision === 'allow-session') {
    const set = sessionAllowed.get(entry.request.conversationId) ?? new Set<ToolKind>()
    set.add(entry.request.kind)
    sessionAllowed.set(entry.request.conversationId, set)
  }
  emit({ type: 'knowledge.approvalResolved', id, decision })
  entry.settle(decision)
}

/**
 * 回合结束/中止时清场。悬而未决的请求一律按拒绝结算——绝不能让它们默认通过，
 * 也不能让 await 永远挂着把回合卡死。
 */
export function abandonApprovals(conversationId: number): void {
  for (const [id, entry] of [...pending]) {
    if (entry.request.conversationId !== conversationId) continue
    pending.delete(id)
    emit({ type: 'knowledge.approvalResolved', id, decision: 'deny' })
    entry.settle('deny')
  }
}

/** 新对话开始时忘掉上一段的放行。 */
export function clearSessionAllowances(conversationId: number): void {
  sessionAllowed.delete(conversationId)
}

/** 仅供测试。 */
export function _state(): { pending: number; allowances: number } {
  return { pending: pending.size, allowances: sessionAllowed.size }
}
