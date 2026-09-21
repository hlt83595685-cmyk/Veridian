// 工具的权限类别。
//
// 这是**我们的**策略词汇，不是 DSH 的：`ToolDefinition` 没有留元数据槽，
// 而 kind 决定的两件事（ceiling 拦不拦、界面卡片画什么图标）都是 Veridian
// 自己的语义。所以放在注册表之外，按工具名索引。
//
// 做成可登记的而不是一张写死的常量表：工具是插件注册进来的，核心代码不可能
// 预先知道所有名字。登记返回注销函数，跟 ctx.effect 的用法一致——插件卸载时
// 类别跟着工具一起消失。
import type { ToolKind } from '../../../shared/types'

const kinds = new Map<string, ToolKind>()

/** 登记一个工具的类别，返回注销函数。 */
export function declareKind(name: string, kind: ToolKind): () => void {
	kinds.set(name, kind)
	return () => {
		kinds.delete(name)
	}
}

/**
 * 未登记的名字按 read 算。
 *
 * 这是保守的一侧：忘了登记的工具会被当成只读，于是 ceiling 放行它——所以
 * **新增写工具时必须同时登记**，否则闸门形同虚设。反过来把默认设成
 * destructive 会让每个读工具都要审批，没人会忍受，最后一定被绕过。
 */
export function kindOf(name: string): ToolKind {
	return kinds.get(name) ?? 'read'
}

/** 由低到高。ceiling 是「最多允许到哪一档」，比较时用它的下标。 */
const ORDER: ToolKind[] = ['read', 'write-library', 'write-fs', 'destructive']

/** kind 是否在 ceiling 允许的范围内。 */
export function withinCeiling(kind: ToolKind, ceiling: ToolKind): boolean {
	return ORDER.indexOf(kind) <= ORDER.indexOf(ceiling)
}

/** 仅供测试。 */
export function _resetKinds(): void {
	kinds.clear()
}
