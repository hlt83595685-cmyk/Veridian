// 把本期的接缝与工具挂到根 context 上。
//
// 工具注册表用 DSH 的 `@deepseek-ai/dsh-tools`，不再自己写一个：它给的是一条
// 五段执行管线（策略闸门 / 单调守卫 / 环绕包装 / 结果改写 / 只读观察），我们的
// ceiling 和用户审批各占其中一段，见 tools/policy.ts。
//
// ToolRuntime 的 `static inject = ['systemPrompt']` —— 不挂 system-prompt 它
// 就不会激活，ctx.tools 会一直是 undefined。这是唯一一个必须一起挂的伙伴。
//
// 注册与策略都走 ctx.effect，于是「注册即效果、卸载即回滚」——插件卸载时工具和
// 闸门一起消失，不需要谁记得去清理。
import type { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { LlmService } from './seams/llm'
import { AttachmentService } from './seams/attachment'
import { getItemInfo } from './tools/getItemInfo'
import { searchLibrary } from './tools/searchLibrary'
import { loadSkill } from './tools/loadSkill'
import { COLLECTION_TOOLS } from './tools/collections'
import { WRITE_TOOLS } from './tools/writeTools'
import { declareKind } from './tools/kinds'
import { installPolicy } from './tools/policy'
import { setEquipmentHost } from './tools/equipment'
import { horseFor } from './activeHorse'

const builtinTools = {
	inject: ['tools'],
	apply(ctx: Context) {
		for (const tool of [getItemInfo, searchLibrary, loadSkill, ...COLLECTION_TOOLS]) {
			ctx.effect(() => ctx.tools.register(tool))
			ctx.effect(() => declareKind(tool.name, 'read'))
		}
		// 写工具必须同时登记 kind，否则 kindOf 会按 read 兜底——ceiling 放行、
		// 审批不问，整套护栏对它们形同虚设。见 kinds.ts 的说明。
		for (const tool of WRITE_TOOLS) {
			ctx.effect(() => ctx.tools.register(tool))
			ctx.effect(() => declareKind(tool.name, 'write-library'))
		}
		// 对话还没有绑定到具体的马，先用默认那匹。等绑定做好了，这里换成按
		// conversationId 查即可，policy 和 equipment 那边都不用动。
		ctx.effect(() => setEquipmentHost(ctx))
		ctx.effect(() => installPolicy(ctx, { horse: horseFor }))
	},
}

/**
 * 取出插件本体。
 *
 * dsh 那几个包是 ESM-only，而主进程产物是 CJS。electron-vite 把
 * `import Tools from '@deepseek-ai/dsh-tools'` 直接编成
 * `const Tools = require('@deepseek-ai/dsh-tools')`，**不加 interop** ——
 * 于是 Tools 是命名空间对象 `{ default, defineTool, … }`，没有 apply，
 * cordis 当场拒收：invalid plugin, expect function or object with an
 * "apply" method。开发环境（真 ESM）看不出来，只有打包后才炸。
 *
 * 两种形态都认，所以将来构建改回真 ESM 也不用动。具名导入不受影响——
 * 它们本来就是命名空间上的属性。
 */
function asPlugin<T>(mod: T): T {
	return (mod as { default?: T }).default ?? mod
}

export function mountHarnessPlugins(root: Context): void {
	root.plugin(LlmService)
	root.plugin(AttachmentService)
	root.plugin(asPlugin(SystemPrompt), {})
	root.plugin(asPlugin(Tools), {})
	root.plugin(builtinTools)
}
