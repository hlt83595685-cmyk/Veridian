// 工具目录：注册表里现在有些什么。
//
// 装配界面要列出可勾选项，就必须能问到这个池子。池子是**全局**的（插件注册了
// 什么就有什么），和任何一匹马无关——哪匹马能用其中哪些，由 Horse.tools 决定。
//
// 读实时注册表而不是维护一份清单：插件随时可以挂载/卸载，任何缓存都会和真相
// 漂移，而漂移的方向恰好是「界面上还留着一个已经不存在的工具」。
import { getHarness } from './boot'
import { kindOf } from './tools/kinds'
import type { ToolInfo } from '../../shared/types'

export function listTools(): ToolInfo[] {
	return getHarness()
		.tools.schemas()
		.map((s) => ({
			name: s.name,
			description: s.description ?? '',
			kind: kindOf(s.name),
		}))
		.sort((a, b) => a.name.localeCompare(b.name))
}
