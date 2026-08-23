// 把本期的接缝与工具挂到根 context 上。
//
// 工具用 ctx.effect 注册，于是「注册即效果、卸载即回滚」——插件卸载时工具自动
// 从注册表消失，不需要谁记得去清理。
import type { Context } from '@deepseek-ai/cordis'
import { LlmService } from './seams/llm'
import { AttachmentService } from './seams/attachment'
import { ToolsService } from './tools/registry'
import { getItemInfo } from './tools/getItemInfo'

const builtinTools = {
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.tools.register(getItemInfo))
  },
}

export function mountHarnessPlugins(root: Context): void {
  root.plugin(LlmService)
  root.plugin(AttachmentService)
  root.plugin(ToolsService)
  root.plugin(builtinTools)
}
