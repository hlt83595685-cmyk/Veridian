// 状态推导是这个界面的承重逻辑：一站画成什么样、说什么话，全从这里出。
// 尤其是「跳过 ≠ 中断」和「装了但被卡住 ≠ 没装」这两组区分。
import { describe, it, expect } from 'vitest'
import {
	cappedTools, danglingTools, deriveStations, equippedTools, type RigInput,
} from './stations'
import type { Horse, ToolInfo, ToolKind } from '../../../../../shared/types'

const horse = (over: Partial<Horse> = {}): Horse => ({
	id: 'h1', name: 'Veridian', skin: 'bay', ceiling: 'read',
	tools: [], isDefault: true, createdAt: 0, ...over,
})

const tool = (name: string, kind: ToolKind = 'read'): ToolInfo => ({
	name, description: name, kind,
})

const POOL = [tool('search_library'), tool('edit_item', 'write-library'), tool('nuke', 'destructive')]

const rig = (over: Partial<RigInput> = {}): RigInput => ({
	horse: horse(), chatModel: 'deepseek-chat', skillCount: 0, pool: POOL, ...over,
})

describe('主链路', () => {
	it('没配模型是 fatal —— 请求走到这里就停下', () => {
		expect(deriveStations(rig({ chatModel: undefined })).model.state).toBe('fatal')
	})

	it('没配 embedding 只是 skip —— 助手照样能回答', () => {
		const s = deriveStations(rig({ embeddingModel: undefined }))
		expect(s.retrieval.state).toBe('skip')
		expect(s.model.state).toBe('ok')
	})

	it('skip 和 fatal 是两回事，不能混成同一种灰', () => {
		const s = deriveStations(rig({ chatModel: undefined, embeddingModel: undefined }))
		expect(s.retrieval.state).not.toBe(s.model.state)
	})

	it('站里显示的是原因，不是「跳过」两个字', () => {
		expect(deriveStations(rig()).retrieval.detail).toBe('no embedding')
	})
})

describe('技能', () => {
	it('装了就报数', () => {
		expect(deriveStations(rig({ skillCount: 3 })).skills).toMatchObject({
			state: 'ok', detail: '3 installed',
		})
	})
	it('没装是 skip，不是坏了', () => {
		expect(deriveStations(rig()).skills.state).toBe('skip')
	})
})

describe('工具站', () => {
	it('一个都没勾 = closed', () => {
		expect(deriveStations(rig()).tools).toMatchObject({ state: 'closed', detail: 'none equipped' })
	})

	it('勾了且能用 = ok，报的是能用的数量', () => {
		const s = deriveStations(rig({ horse: horse({ tools: ['search_library'] }) }))
		expect(s.tools).toMatchObject({ state: 'ok', detail: '1 equipped' })
	})

	it('勾了但全被 ceiling 卡住 = locked，和「没勾」分开说', () => {
		const s = deriveStations(rig({ horse: horse({ ceiling: 'read', tools: ['nuke'] }) }))
		expect(s.tools).toMatchObject({ state: 'locked', detail: '1 blocked' })
	})

	it('一半能用一半被卡：按能用的算 ok，但两个数都要报', () => {
		const s = deriveStations(rig({
			horse: horse({ ceiling: 'read', tools: ['search_library', 'nuke'] }),
		}))
		// 只报「1」会和面板底部的「装了 2 个」对不上，让人以为哪边算错了
		expect(s.tools).toMatchObject({ state: 'ok', detail: '1 of 2 usable' })
	})

	it('抬高 ceiling 就解锁，不用重新勾', () => {
		const equipped = { tools: ['nuke'] }
		expect(deriveStations(rig({ horse: horse({ ...equipped, ceiling: 'read' }) })).tools.state)
			.toBe('locked')
		expect(deriveStations(rig({ horse: horse({ ...equipped, ceiling: 'destructive' }) })).tools.state)
			.toBe('ok')
	})
})

describe('审批站', () => {
	it('没有能跑的调用 = closed', () => {
		expect(deriveStations(rig()).approval.state).toBe('closed')
	})

	it('全是读工具 = skip：不会弹任何窗', () => {
		const s = deriveStations(rig({ horse: horse({ tools: ['search_library'] }) }))
		expect(s.approval).toMatchObject({ state: 'skip', detail: 'reads only' })
	})

	it('有写工具才会问你', () => {
		const s = deriveStations(rig({
			horse: horse({ ceiling: 'write-library', tools: ['edit_item'] }),
		}))
		expect(s.approval).toMatchObject({ state: 'ok', detail: 'asks first' })
	})

	it('写工具被 ceiling 卡住时轮不到审批 —— 拒绝发生在问你之前', () => {
		const s = deriveStations(rig({ horse: horse({ ceiling: 'read', tools: ['edit_item'] }) }))
		expect(s.approval.state).toBe('closed')
	})
})

describe('清单与池子的对账', () => {
	it('只算池子里真实存在的', () => {
		const h = horse({ tools: ['search_library', 'ghost_tool'] })
		expect(equippedTools(h, POOL).map((t) => t.name)).toEqual(['search_library'])
	})

	it('插件卸载后名字保留，界面上单独标出来', () => {
		const h = horse({ tools: ['search_library', 'ghost_tool'] })
		expect(danglingTools(h, POOL)).toEqual(['ghost_tool'])
	})

	it('装了但超出 ceiling 的能单独列出来 —— 装了却用不了必须说', () => {
		const h = horse({ ceiling: 'write-library', tools: ['edit_item', 'nuke'] })
		expect(cappedTools(h, POOL).map((t) => t.name)).toEqual(['nuke'])
	})

	it('ceiling 恰好等于工具的档位时算通过，不是越界', () => {
		const h = horse({ ceiling: 'write-library', tools: ['edit_item'] })
		expect(cappedTools(h, POOL)).toEqual([])
	})
})
