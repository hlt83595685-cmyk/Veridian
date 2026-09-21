// 关键性质：认不出的名字**绝不**能落到 getSkillBody 上。那个函数对非法名字会抛
// （skills.ts 的路径穿越防护），而模型编一个名字是家常便饭——异常逃出去会中断
// 整个回合，模型也就失去了改正的机会。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = vi.hoisted(() => ({
	installed: [] as Array<{ name: string; description: string }>,
	bodies: {} as Record<string, string | null>,
	bodyCalls: [] as string[],
}))

vi.mock('../../knowledge/skills', () => ({
	listInstalledSkills: () => store.installed,
	getSkillBody: (name: string) => {
		store.bodyCalls.push(name)
		if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) throw new Error(`invalid skill name "${name}"`)
		return store.bodies[name] ?? null
	},
}))

import { loadSkill } from './loadSkill'

const run = (args: Record<string, unknown>): Promise<string> =>
	loadSkill.execute(args, {} as never) as Promise<string>

beforeEach(() => {
	store.installed = [{ name: 'lit-review', description: '写文献综述' }]
	store.bodies = { 'lit-review': '# 文献综述\n先列出…' }
	store.bodyCalls.length = 0
})

describe('load_skill', () => {
	it('返回已装技能的正文', async () => {
		expect(await run({ name: 'lit-review' })).toContain('# 文献综述')
	})

	it('名字两边的空白不算数', async () => {
		expect(await run({ name: '  lit-review  ' })).toContain('# 文献综述')
	})

	it('认不出的名字回一句能读懂的错，并列出实际有哪些', async () => {
		const out = await run({ name: 'nope' })
		expect(out).toContain('no such skill "nope"')
		expect(out).toContain('lit-review')
	})

	it('路径穿越式的名字不会落到 getSkillBody 上', async () => {
		const out = await run({ name: '../../../Documents' })
		expect(out).toContain('no such skill')
		expect(store.bodyCalls).toEqual([])
	})

	it('一个技能都没装时也说得清楚', async () => {
		store.installed = []
		const out = await run({ name: 'anything' })
		expect(out).toContain('no skills are installed')
		expect(store.bodyCalls).toEqual([])
	})

	it('装了但正文读不出来时不返回空串', async () => {
		store.bodies = { 'lit-review': null }
		expect(await run({ name: 'lit-review' })).toContain('no readable body')
	})
})
