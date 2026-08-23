// 模型接缝：定义 + 提供者。换模型只换提供者，回合流程不动。
import { Service, type Context } from '@deepseek-ai/cordis'
import { getChatConfig, chatStream } from '../../knowledge/providers'
import type { ChatMessage } from '../session/types'

// 复用现有的工具 schema 类型，不重新声明——重复声明必然漂移。
export type { ToolDef as ToolSchema } from '../../knowledge/providers'
import type { ToolDef } from '../../knowledge/providers'

export interface LlmRequest {
  messages: ChatMessage[]
  tools: ToolDef[]
}

export interface LlmResult {
  text: string
  toolCalls: Array<{ id: string; name: string; args: string }>
}

export class LlmService extends Service {
  // 服务名由 super(ctx, name) 决定。Cordis 4 没有 `static [Service.provide]`——
  // 那样写在 JS 下静默无效（键名会变成字符串 "undefined"），只有类型检查能抓到。
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * 回调式而非 AsyncIterable：底层 chatStream 就是「onDelta 回调 + await 结果」，
   * 包成迭代器要么丢流式（先收集再吐出），要么额外搭一层队列桥接。第一条竖线选
   * 诚实且简单的形状；真需要拉取式迭代再另说。
   */
  async stream(req: LlmRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<LlmResult> {
    const cfg = getChatConfig()
    if (!cfg) throw new Error('chat model is not configured')
    const r = await chatStream(cfg, req.messages, req.tools, onText, signal)
    return {
      text: r.content,
      toolCalls: r.toolCalls.map((t) => ({ id: t.id, name: t.function.name, args: t.function.arguments })),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmService
  }
}
