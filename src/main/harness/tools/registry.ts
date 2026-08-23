// 工具注册表。
//
// kind 现在只用到 read；写工具的审批与门控是后续任务，但字段现在就留出来，
// 避免届时改动每一个工具的定义。
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '../seams/llm'

export type ToolKind = 'read' | 'write-library' | 'write-fs' | 'destructive'

export interface HarnessTool {
  name: string
  kind: ToolKind
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

export class ToolsService extends Service {
  private readonly reg = new Map<string, HarnessTool>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** 返回注销函数，便于通过 ctx.effect 让注册随插件卸载而回滚。 */
  register(tool: HarnessTool): () => void {
    this.reg.set(tool.name, tool)
    return () => {
      this.reg.delete(tool.name)
    }
  }

  schemas(): ToolSchema[] {
    return [...this.reg.values()].map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  /**
   * 执行一个工具。任何失败都以字符串结果返回，绝不抛出——工具错误是模型要读的
   * 反馈，不是控制流异常。抛出去会中断整个回合，模型也就失去了纠正的机会。
   */
  async run(name: string, argsJson: string): Promise<string> {
    const tool = this.reg.get(name)
    if (!tool) return `error: unknown tool "${name}"`
    let args: Record<string, unknown>
    try {
      args = JSON.parse(argsJson || '{}') as Record<string, unknown>
    } catch {
      return 'error: invalid arguments'
    }
    try {
      return await tool.execute(args)
    } catch (err) {
      return `error: ${(err as Error).message}`
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }
}
