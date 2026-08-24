import type { AttachmentRef, AttachmentResult } from '../seams/attachment'

export type SessionEvent =
  | { kind: 'turn-start'; turnId: string }
  | { kind: 'turn-end'; turnId: string; reason: 'done' | 'aborted' | 'error' }
  | { kind: 'user-message'; text: string; refs: AttachmentRef[] }
  | { kind: 'attachment-resolved'; ref: AttachmentRef; result: AttachmentResult }
  | { kind: 'assistant-message'; text: string }
  | { kind: 'tool-call'; id: string; name: string; args: string }
  | { kind: 'tool-result'; id: string; name: string; result: string }

/**
 * 存储放在接口后面，纯逻辑才能脱离 better-sqlite3 测试——它按 Electron ABI 构建，
 * 普通 node 下加载不了，直接依赖它的测试会被 skip，等于没测。
 */
export interface SessionStore {
  append(sessionId: number, event: SessionEvent): void
  read(sessionId: number): SessionEvent[]
  /**
   * 回退到最后一条 user-message 之前，用于重新生成与编辑重发。
   *
   * 这是日志唯一的非追加操作，语义是「这一轮没发生过」而不是「改写历史」——
   * 用户主动要求重来，日志就该反映重来后的事实。
   */
  truncateToLastUserMessage(sessionId: number): void
}

// 复用现有类型，不重新声明——重复声明必然漂移。
// 注意 content 是 string | null：带 tool_calls 的 assistant 消息按 OpenAI 约定为 null。
export type { ChatMessage, ToolCall } from '../../knowledge/providers'
