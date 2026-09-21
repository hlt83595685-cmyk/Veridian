// 装配界面的模型层：一次提问真实经过的那条路。
//
// 取代原来的马匹解剖图。那版把能力挂在身体部位上，好看但撒谎——部位之间没有
// 先后，而真实的链路是有的：检索在上下文之前，闸门在工具之前。链路图能表达
// 「这一站没通，后面就走不下去」，解剖图不能。
//
// 这个文件只管**推导**，不画任何东西。几何常量放这里是因为 Pipeline.tsx 和
// 面板都要用同一套坐标去对齐；状态推导放这里是因为它是承重逻辑，必须能单测。
import type { Horse, ToolInfo, ToolKind } from '../../../../../shared/types'

export type StationId =
	| 'retrieval'
	| 'context'
	| 'model'
	| 'skills'
	| 'ceiling'
	| 'approval'
	| 'tools'

/**
 * 一站的状态。
 *
 * `skip` 和 `fatal` 是**两回事**，这也是整张图最想说清楚的一件事：没配
 * embedding 只是不检索，助手照样能回答；没配模型才是真的走不下去。
 */
export type StationState = 'ok' | 'skip' | 'closed' | 'locked' | 'fatal'

export interface Station {
	id: StationId
	state: StationState
	/** 站内那行小字：当前值，或没通的**原因**。 */
	detail: string
}

// ── 几何 ────────────────────────────────────────────────────────────────────
// 三条泳道：上方旁路（没接进来的）、中间主链路、下方行动支路。
// 主链路等距——间距不匀会让人以为疏密有含义。

export const VIEW = { w: 620, h: 296 }
export const LANE = { bypass: 38, rail: 116, ceiling: 172, approval: 214, tools: 264 }
export const ENTRY_X = 46
export const EXIT_X = 574
/** 支路所在的竖线：模型正下方。 */
export const BRANCH_X = 440

export const RAIL_X: Record<'retrieval' | 'context' | 'model', number> = {
	retrieval: 180,
	context: 310,
	model: 440,
}
export const SKILLS_X = 440

/** 主链路上的站；旁路与支路上的比它小一号。 */
export const RAIL_BOX = { w: 49, h: 20 }
export const SIDE_BOX = { w: 45, h: 18 }

// ── 推导 ────────────────────────────────────────────────────────────────────

export interface RigInput {
	horse: Horse
	/** 已配好的模型名，来自设置。undefined = 没配。 */
	chatModel?: string
	embeddingModel?: string
	/** 已安装的技能数。 */
	skillCount: number
	/** 注册表里现有的工具（池子）。 */
	pool: ToolInfo[]
}

const CEILING_ORDER: ToolKind[] = ['read', 'write-library', 'write-fs', 'destructive']

const CEILING_SHORT: Record<ToolKind, string> = {
	read: 'READ',
	'write-library': 'LIB',
	'write-fs': 'FS',
	destructive: 'DEL',
}

/** 这匹马装上的工具里，还真实存在于池子里的那些。 */
export function equippedTools(horse: Horse, pool: ToolInfo[]): ToolInfo[] {
	return pool.filter((t) => horse.tools.includes(t.name))
}

/**
 * 装上了、但插件已经卸载的名字。
 *
 * 保留而不是清掉：卸载往往是临时的（升级、排错），清了用户得重勾一遍。界面上
 * 灰掉标注即可。
 */
export function danglingTools(horse: Horse, pool: ToolInfo[]): string[] {
	const known = new Set(pool.map((t) => t.name))
	return horse.tools.filter((n) => !known.has(n))
}

function withinCeiling(kind: ToolKind, ceiling: ToolKind): boolean {
	return CEILING_ORDER.indexOf(kind) <= CEILING_ORDER.indexOf(ceiling)
}

/** 装上了但被 ceiling 卡住的工具——装了却用不了，界面必须说出来。 */
export function cappedTools(horse: Horse, pool: ToolInfo[]): ToolInfo[] {
	return equippedTools(horse, pool).filter((t) => !withinCeiling(t.kind, horse.ceiling))
}

export function deriveStations(input: RigInput): Record<StationId, Station> {
	const { horse, chatModel, embeddingModel, skillCount, pool } = input
	const equipped = equippedTools(horse, pool)
	const capped = cappedTools(horse, pool)
	const usable = equipped.filter((t) => withinCeiling(t.kind, horse.ceiling))
	// 只有会改动用户东西的调用才需要点头；全是读工具就不会有任何弹窗。
	const writable = usable.filter((t) => t.kind !== 'read')

	const st = (id: StationId, state: StationState, detail: string): Station => ({ id, state, detail })

	return {
		// 模型是唯一不可缺的一站。没有它，请求走到这里就停下。
		model: chatModel ? st('model', 'ok', chatModel) : st('model', 'fatal', 'not configured'),

		retrieval: embeddingModel
			? st('retrieval', 'ok', embeddingModel)
			: st('retrieval', 'skip', 'no embedding'),

		context: st('context', 'ok', 'auto budget'),

		skills: skillCount > 0
			? st('skills', 'ok', `${skillCount} installed`)
			: st('skills', 'skip', 'none installed'),

		ceiling: st('ceiling', 'ok', CEILING_SHORT[horse.ceiling]),

		// 装了工具但一个都跑不了 = 被权限卡住，这和「没装工具」要分开说。
		// 有一部分被卡住时报「能用的 / 装上的」两个数：只报一个数会和面板底部
		// 那行「装了几个」对不上，让人以为哪边算错了。
		tools: equipped.length === 0
			? st('tools', 'closed', 'none equipped')
			: usable.length === 0
				? st('tools', 'locked', `${capped.length} blocked`)
				: capped.length > 0
					? st('tools', 'ok', `${usable.length} of ${equipped.length} usable`)
					: st('tools', 'ok', `${usable.length} equipped`),

		approval: usable.length === 0
			? st('approval', 'closed', 'no calls')
			: writable.length === 0
				? st('approval', 'skip', 'reads only')
				: st('approval', 'ok', 'asks first'),
	}
}
