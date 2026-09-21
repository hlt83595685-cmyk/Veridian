// 装配遮罩：模型**看得见**哪些工具。
//
// 跑在真 ToolRuntime + 真 createScope 上。这一层全部的内容就是「DSH 的 scope
// 语义有没有被用对」，自己搭个假的来测就只是在测那个假货。
//
// 注意分工：restrict() 只管可见性，拦不住派发（dispatch 按 exec.agent 找
// scope，我们没有 agent）。拦截由 policy.ts 的 guard 负责，见 policy.test.ts。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { release, scopeFor, setEquipmentHost, _equipmentSize } from './equipment'
import type { Horse } from '../../../shared/types'

const horse = (over: Partial<Horse> = {}): Horse => ({
	id: 'h1', name: 'Groom', skin: 'bay', ceiling: 'read',
	tools: [], isDefault: true, createdAt: 0, ...over,
})

let ctx: Context
let teardown: () => void

/** 可见工具名，按这匹马的遮罩解析。 */
function visible(h: Horse): string[] {
	const key = scopeFor(h)
	if (!key) return []
	return ctx.tools.schemas(key).map((s) => s.name).sort()
}

beforeEach(async () => {
	ctx = new Context()
	ctx.plugin(SystemPrompt, {})
	ctx.plugin(Tools, {})
	for (let i = 0; i < 100 && !ctx.tools; i++) await new Promise((r) => setTimeout(r, 10))

	for (const name of ['get_item_info', 'search_library', 'load_skill']) {
		ctx.tools.register(defineTool({
			name, description: name, parameters: {},
			output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
			async execute() { return name },
		}))
	}

	// createScope 继承的是**铸造它的插件**的依赖 API，拿裸的根 context 会报
	// 「cannot get property "tools" without inject」。
	await new Promise<void>((resolve) => {
		ctx.plugin({
			inject: ['tools'],
			apply(c: Context) {
				teardown = setEquipmentHost(c)
				resolve()
			},
		})
	})
})

afterEach(() => teardown?.())

describe('装配遮罩', () => {
	it('只看得见装上的', () => {
		expect(visible(horse({ tools: ['search_library'] }))).toEqual(['search_library'])
	})

	it('什么都没装就一个都看不见', () => {
		expect(visible(horse())).toEqual([])
	})

	it('全局视图不受影响 —— 遮罩是这匹马的，不是全app的', () => {
		visible(horse({ tools: ['search_library'] }))
		expect(ctx.tools.schemas().map((s) => s.name).sort())
			.toEqual(['get_item_info', 'load_skill', 'search_library'])
	})

	it('两匹马各看各的', () => {
		const a = horse({ id: 'a', tools: ['search_library'] })
		const b = horse({ id: 'b', tools: ['load_skill', 'get_item_info'] })
		expect(visible(a)).toEqual(['search_library'])
		expect(visible(b)).toEqual(['get_item_info', 'load_skill'])
		// 再查一次 a，确认没被 b 的遮罩污染
		expect(visible(a)).toEqual(['search_library'])
	})

	it('改了装配立刻生效 —— 加勾的能出来', () => {
		const h = horse({ tools: ['search_library'] })
		expect(visible(h)).toEqual(['search_library'])
		// 遮罩是**取交集**的：不先撤销旧的就重新 restrict，可见集合只会越来越小，
		// 新勾上的工具永远出不来。这条用例钉的就是那个坑。
		expect(visible({ ...h, tools: ['search_library', 'load_skill'] }))
			.toEqual(['load_skill', 'search_library'])
	})

	it('取消勾选也立刻生效', () => {
		const h = horse({ tools: ['search_library', 'load_skill'] })
		expect(visible(h)).toHaveLength(2)
		expect(visible({ ...h, tools: [] })).toEqual([])
	})

	it('装了一个不存在的工具名，不会凭空变出来', () => {
		expect(visible(horse({ tools: ['ghost_tool'] }))).toEqual([])
	})

	it('同一匹马反复查只铸造一个 scope', () => {
		const h = horse({ tools: ['search_library'] })
		visible(h); visible(h); visible(h)
		expect(_equipmentSize()).toBe(1)
	})

	it('马被删掉时 scope 一并撤销', () => {
		visible(horse({ id: 'a', tools: ['search_library'] }))
		visible(horse({ id: 'b', tools: ['load_skill'] }))
		expect(_equipmentSize()).toBe(2)
		release('a')
		expect(_equipmentSize()).toBe(1)
	})

	it('没有宿主 context 时返回 null，而不是抛', () => {
		teardown()
		expect(scopeFor(horse({ tools: ['search_library'] }))).toBeNull()
	})
})
