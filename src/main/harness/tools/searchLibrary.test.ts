// 工具体本身很薄，值得测的是它对**模型给的参数**有多不信任，以及失败路径。
// 模型会传 "8"、-1、0.5、NaN，也会传空字符串。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SearchHit } from '../../knowledge/search'

const calls = vi.hoisted(() => ({ args: [] as unknown[], hits: [] as SearchHit[] }))

vi.mock('../../knowledge/search', () => ({
	hybridSearch: async (...a: unknown[]) => {
		calls.args.push(a)
		return calls.hits
	},
}))
vi.mock('../../services/WorkspaceContextService', () => ({
	getActiveWorkspace: () => ({ id: 7 }),
}))
const scope = vi.hoisted(() => ({ result: { ids: [1, 2] } as unknown }))
vi.mock('./collections', () => ({ scopeByCollection: () => scope.result }))

import { searchLibrary } from './searchLibrary'

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
	chunkId: 1, itemId: 1, itemKey: 'ABCD', headingPath: 'Methods',
	seq: 0, text: 'the measured value was 42', score: 1, ...over,
})

const run = (args: Record<string, unknown>): Promise<string> =>
	searchLibrary.execute(args, {} as never) as Promise<string>

beforeEach(() => {
	calls.args.length = 0
	calls.hits = []
})

describe('search_library', () => {
	it('把命中渲染成带 key 和小节的段落', async () => {
		calls.hits = [hit(), hit({ itemKey: 'WXYZ', headingPath: '', text: 'second' })]
		const out = await run({ query: 'measured value' })
		expect(out).toContain('[1] key=ABCD §Methods')
		expect(out).toContain('the measured value was 42')
		// 没有小节时不留一个空的 § 挂在那里
		expect(out).toContain('[2] key=WXYZ\n')
		expect(out).not.toContain('§\n')
	})

	it('空结果如实说，而不是返回空串', async () => {
		const out = await run({ query: 'nothing here' })
		expect(out).toContain('no results')
		expect(out).toContain('nothing here')
	})

	it('空 query 直接拒，不去打扰检索层', async () => {
		expect(await run({ query: '   ' })).toContain('error')
		expect(calls.args).toEqual([])
	})

	it('默认取 6 条', async () => {
		await run({ query: 'q' })
		// 第四个参数是分类 filter，不限定时为 undefined
		expect(calls.args[0]).toEqual([7, 'q', 6, undefined])
	})

	// 只列能真的传进来的值：类型不对的（'abc'）和缺席的（undefined）由 defineTool
	// 的 schema 挡在工具体之前，见下面那条。
	it.each([
		['超上限', 999, 20],
		['零', 0, 6],
		['负数', -3, 6],
		['小数', 2.7, 2],
	])('top_k %s（%s）收敛到 %i', async (_label, given, want) => {
		await run({ query: 'q', top_k: given })
		expect((calls.args[0] as unknown[])[2]).toBe(want)
	})

	it('类型不对的 top_k 被 schema 挡住，根本进不到工具体', async () => {
		await expect(run({ query: 'q', top_k: 'abc' })).rejects.toThrow(/invalid arguments/)
		expect(calls.args).toEqual([])
	})

	it('用的是当前工作区的 id', async () => {
		await run({ query: 'q' })
		expect((calls.args[0] as unknown[])[0]).toBe(7)
	})
})

describe('限定分类', () => {
	it('把分类解析成 itemIds 传给检索层', async () => {
		scope.result = { ids: [10, 11] }
		await run({ query: 'q', collection: '综述' })
		expect((calls.args[0] as unknown[])[3]).toEqual({ itemIds: [10, 11] })
	})

	it('不给 collection 时不带 filter，搜全库', async () => {
		await run({ query: 'q' })
		expect((calls.args[0] as unknown[])[3]).toBeUndefined()
	})

	// 用户说「在这个分类里找」，翻遍全库给的是另一个问题的答案，而他不会知道
	// 范围被换过。所以解析失败必须停下来，不能悄悄降级。
	it('分类解析不了时报错，**不**退回全库', async () => {
		scope.result = { error: 'no collection named "x"' }
		const out = await run({ query: 'q', collection: 'x' })
		expect(out).toContain('error')
		expect(calls.args).toEqual([])
	})

	it('空分类如实说，不去检索层白跑一趟', async () => {
		scope.result = { ids: [] }
		expect(await run({ query: 'q', collection: '空的' })).toContain('is empty')
		expect(calls.args).toEqual([])
	})
})
