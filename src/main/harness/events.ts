// 所有 harness 事件在此声明类型与派发模式。
//
// 声明不是文档，是行为前提：未声明类型的事件，waterfall 的参数传递不符合预期
// （监听者收到的首个参数会是 next 而不是实参）。新增事件必须先在此登记。
import type { AttachmentRef, AttachmentResult } from './seams/attachment'

export interface TurnStart {
  turnId: string
  sessionId: number
}

export interface TurnEnd {
  turnId: string
  reason: 'done' | 'aborted' | 'error'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 回合开始。@mode emit */
    'turn/start'(e: TurnStart): void
    /** 回合结束。@mode emit */
    'turn/end'(e: TurnEnd): void
    /** 一次附件解析已完成。@mode emit */
    'attachment/resolved'(ref: AttachmentRef, result: AttachmentResult): void
  }
}
