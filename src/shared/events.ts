import type { ApprovalDecision, ApprovalRequest, AttachmentStatus, ContextReport, ToolCallRecord } from './types'

// Domain events -- the single vocabulary shared by main-process subscribers
// (sync engine, indexers) and the renderer query cache. Every write that goes
// through a Service MUST emit one of these; UI refresh is driven entirely by
// this stream, never by manual reloads.

export interface JobStatus {
  id: string
  type: string
  label: string            // human-readable, e.g. the filename being converted
  state: 'queued' | 'running' | 'done' | 'error'
  message: string
  chunk?: string
  pending: number          // jobs still waiting behind this one
  progress?: number        // 0..1 completion of the CURRENT job; absent = indeterminate
}

export type DomainEvent =
  | { type: 'item.created'; ids: number[] }
  | { type: 'item.modified'; ids: number[] }
  | { type: 'item.trashed'; ids: number[] }
  | { type: 'item.restored'; ids: number[] }
  | { type: 'item.deleted'; ids: number[] }
  | { type: 'attachment.changed'; itemIds: number[] }
  | { type: 'tag.changed'; itemIds: number[] }
  | { type: 'collection.changed'; ids: number[] }
  | { type: 'creator.changed'; itemIds: number[] }
  | { type: 'note.changed'; itemIds: number[] }
  | { type: 'relation.changed'; itemIds: number[] }
  | { type: 'settings.changed'; keys: string[] }
  | { type: 'job.progress'; job: JobStatus }
  | { type: 'workspace.changed'; ids: string[] }
  // The active data context was replaced wholesale (workspace switched, or a
  // pull imported remote changes) -- every cached query is stale.
  | { type: 'workspace.dataRefreshed' }
  | { type: 'controlPlane.changed' }
  | { type: 'github.authChanged' }
  // AI knowledge base: index contents changed (re-query status), and the
  // chat stream (deltas + lifecycle) pushed from AgentService to the panel.
  | { type: 'knowledge.indexChanged' }
  | { type: 'knowledge.chatDelta'; conversationId: number; delta: string }
  | { type: 'knowledge.chatReset'; conversationId: number }
  | { type: 'knowledge.chatState'
      conversationId: number
      state: 'searching' | 'answering' | 'done' | 'error'
      detail?: string }
  // Emitted twice per tool call: once on dispatch (ok undefined) and again on
  // completion. The renderer upserts by `call.id`, so the card appears the
  // moment the model asks for the tool rather than after it finishes.
  | { type: 'knowledge.toolCall'; conversationId: number; call: ToolCallRecord }
  /**
   * 模型在调工具之前吐的那段话。过去它跟着 chatReset 一起被丢掉，但那是整条
   * 轨迹里最可读的部分——「继续推进下一阶段：正在核验高校名单」这种。
   */
  | { type: 'knowledge.traceNote'; conversationId: number; text: string; round: number }
  // What each @-mentioned paper resolved to, once the budget is known. Emitted
  // after the first assembly of a turn, so `truncated` is final rather than
  // provisional.
  | { type: 'knowledge.attachments'; conversationId: number; attachments: AttachmentStatus[] }
  // Emitted once per round with that round's budget accounting. Later rounds
  // overwrite earlier ones, so what the renderer holds is the assembly that
  // actually produced the answer.
  | { type: 'knowledge.context'; conversationId: number; report: ContextReport }
  // A write is parked waiting for the user. The turn does not proceed until
  // `knowledge:resolveApproval` comes back with a decision.
  | { type: 'knowledge.approval'; request: ApprovalRequest }
  // The request was settled (by the user, or automatically by a standing
  // session allowance) -- the card stops asking and shows the outcome.
  | { type: 'knowledge.approvalResolved'; id: string; decision: ApprovalDecision }
  | { type: 'skills.changed' }

export type DomainEventType = DomainEvent['type']
