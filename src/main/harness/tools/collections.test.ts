// 这组工具真正的难点是**名字解析**：用户嘴里只有名字，模型手里也只有名字，
// 而底下的 API 要 id。解析不出来时必须把现有名字列回去——模型拿着一句
// "no such collection" 只会重试同一个名字。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Collection, Item } from '../../../shared/types'

const db = vi.hoisted(() => ({
	collections: [] as Collection[],
	/** collectionId → items */
	items: {} as Record<number, Item[]>,
}))

vi.mock('../../services/CollectionService', () => ({ listAll: () => db.collections }))
vi.mock('../../services/ItemService', () => ({
	listByCollection: (id: number) => db.items[id] ?? [],
}))

import { listCollectionItems, listCollections, scopeByCollection } from './collections'

const col = (id: number, name: string, parent: number | null = null): Collection =>
	({ id, library_id: 1, parent_id: parent, name, key: 'k' + id })

const item = (id: number, title: string, over: Partial<Item> = {}): Item =>
	({ id, key: 'K' + id, type: 'journalArticle', title, year: 2020, journal: 'J', ...over } as Item)

type Tool = { execute: (a: Record<string, unknown>, e: never) => Promise<unknown> }
const run = (t: Tool, a: Record<string, unknown> = {}): Promise<string> =>
	t.execute(a, {} as never) as Promise<string>

beforeEach(() => {
	db.collections = [col(1, '等离激元传感与生物医学应用'), col(2, '综述'), col(3, '子类', 1)]
	db.items = { 1: [item(10, 'Plasmonic sensing'), item(11, 'Biomedical SERS')], 2: [], 3: [item(30, 'Sub')] }
})

describe('list_collections', () => {
	it('列出名字和条目数 —— 名字是用户和模型唯一共有的抓手', async () => {
		const out = await run(listCollections)
		expect(out).toContain('等离激元传感与生物医学应用')
		expect(out).toContain('2 item(s)')
	})

	it('写出父分类 —— 同名子分类挂在不同父下是常事', async () => {
		expect(await run(listCollections)).toContain('子类 (under 等离激元传感与生物医学应用)')
	})

	it('一个分类都没有时说清楚', async () => {
		db.collections = []
		expect(await run(listCollections)).toBe('the library has no collections')
	})
})

describe('list_collection_items', () => {
	it('返回 key + 标题，模型据此才能逐条动手', async () => {
		const out = await run(listCollectionItems, { collection: '等离激元传感与生物医学应用' })
		expect(out).toContain('K10 | Plasmonic sensing')
		expect(out).toContain('2020, J')
	})

	it('名字大小写和首尾空白不算数', async () => {
		expect(await run(listCollectionItems, { collection: '  综述  ' })).toContain('is empty')
	})

	it('认不出名字时**把现有的列回去**，而不是只说找不到', async () => {
		const out = await run(listCollectionItems, { collection: '不存在的分类' })
		expect(out).toContain('error')
		expect(out).toContain('综述')
	})

	it('只说了一半名字时给出候选', async () => {
		const out = await run(listCollectionItems, { collection: '等离激元' })
		expect(out).toContain('did you mean')
		expect(out).toContain('等离激元传感与生物医学应用')
	})

	it('重名时要求用户澄清，不擅自挑一个', async () => {
		db.collections = [col(1, '综述'), col(2, '综述', 9)]
		const out = await run(listCollectionItems, { collection: '综述' })
		expect(out).toContain('matches 2 collections')
	})

	it('有子分类时说出来，不静默漏掉也不擅自展开', async () => {
		const out = await run(listCollectionItems, { collection: '等离激元传感与生物医学应用' })
		expect(out).toContain('sub-collections not included')
		expect(out).toContain('子类')
	})

	it('超出上限时报总数，别让模型以为就这么多', async () => {
		db.items[1] = Array.from({ length: 150 }, (_, i) => item(i, 't' + i))
		const out = await run(listCollectionItems, { collection: '等离激元传感与生物医学应用' })
		expect(out).toContain('150 item(s)')
		expect(out).toContain('showing 100 of 150')
	})

	it('limit 收敛到上限内', async () => {
		db.items[1] = Array.from({ length: 50 }, (_, i) => item(i, 't' + i))
		const out = await run(listCollectionItems, { collection: '等离激元传感与生物医学应用', limit: 3 })
		expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3)
	})
})

describe('scopeByCollection（给 search_library 用）', () => {
	it('解析成 itemIds', () => {
		expect(scopeByCollection('综述')).toEqual({ ids: [] })
		expect(scopeByCollection('等离激元传感与生物医学应用')).toEqual({ ids: [10, 11] })
	})

	it('解析不了时给出可读原因，调用方据此停下来而不是退回全库', () => {
		const r = scopeByCollection('没有这个')
		expect(r).toHaveProperty('error')
		expect((r as { error: string }).error).toContain('existing collections')
	})
})
