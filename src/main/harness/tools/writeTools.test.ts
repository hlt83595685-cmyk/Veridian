// 写工具是包一层现成 Service，所以要测的不是业务逻辑（那边有自己的测试），
// 而是**包装层容易出错的地方**：认不出的 key、空输入、以及「只改给了的字段」。
import { describe, it, expect, beforeEach, vi } from 'vitest'

const calls = vi.hoisted(() => ({
	saveNote: [] as unknown[],
	mergeTags: [] as unknown[],
	updateItem: [] as unknown[],
	setStarred: [] as unknown[],
	/** key → id。不在表里的 key 视为不存在。 */
	items: {} as Record<string, number>,
}))

vi.mock('../../db', () => ({
	getDb: () => ({
		prepare: () => ({
			get: (key: string) => {
				const id = calls.items[key]
				return id === undefined ? undefined : { id }
			},
		}),
	}),
}))
vi.mock('../../services/NoteService', () => ({
	saveNote: (input: unknown) => { calls.saveNote.push(input); return 42 },
}))
vi.mock('../../services/TagService', () => ({
	mergeTagsForItem: (id: number, names: string[]) => {
		calls.mergeTags.push([id, names])
		return { added: names.length, total: names.length + 1 }
	},
}))
vi.mock('../../services/ItemService', () => ({
	updateItem: (id: number, patch: unknown) => { calls.updateItem.push([id, patch]) },
	setStarred: (id: number, on: boolean) => { calls.setStarred.push([id, on]) },
}))

import { addTags, fixMetadata, starItem, writeNote, WRITE_TOOLS } from './writeTools'

type Tool = { execute: (args: Record<string, unknown>, exec: never) => Promise<unknown> }
const run = (t: Tool, args: Record<string, unknown>): Promise<string> =>
	t.execute(args, {} as never) as Promise<string>

beforeEach(() => {
	calls.saveNote.length = 0
	calls.mergeTags.length = 0
	calls.updateItem.length = 0
	calls.setStarred.length = 0
	calls.items = { GOOD: 7 }
})

describe('认不出的 item_key', () => {
	it.each([
		['add_tags', () => run(addTags, { item_key: 'NOPE', tags: ['x'] })],
		['fix_metadata', () => run(fixMetadata, { item_key: 'NOPE', title: 'x' })],
		['star_item', () => run(starItem, { item_key: 'NOPE', starred: true })],
		['write_note', () => run(writeNote, { title: 't', content: 'c', item_key: 'NOPE' })],
	])('%s 停下来报错，而不是默默改错东西', async (_n, go) => {
		expect(await go()).toContain('no such item')
		expect([...calls.mergeTags, ...calls.updateItem, ...calls.setStarred, ...calls.saveNote])
			.toEqual([])
	})
})

describe('write_note', () => {
	it('不给 item_key 就是独立概念页', async () => {
		const out = await run(writeNote, { title: 'Attention', content: '# hi' })
		expect(out).toContain('created note #42')
		expect(calls.saveNote[0]).toMatchObject({ itemId: null, title: 'Attention', origin: 'ai' })
	})

	it('挂到文献下时解析成内部 id', async () => {
		await run(writeNote, { title: 't', content: 'c', item_key: 'GOOD' })
		expect(calls.saveNote[0]).toMatchObject({ itemId: 7 })
	})

	it('标题为空直接拒 —— 无标题的笔记在界面上认不出来', async () => {
		expect(await run(writeNote, { title: '   ', content: 'c' })).toContain('error')
		expect(calls.saveNote).toEqual([])
	})

	it('标成 ai 写的，用户必须能分辨是谁写的', async () => {
		await run(writeNote, { title: 't', content: 'c' })
		expect(calls.saveNote[0]).toMatchObject({ origin: 'ai' })
	})
})

describe('add_tags', () => {
	it('走 merge 而不是 set —— 模型不知道现有标签，set 会删掉它没提的', async () => {
		await run(addTags, { item_key: 'GOOD', tags: ['nlp', 'survey'] })
		expect(calls.mergeTags[0]).toEqual([7, ['nlp', 'survey']])
	})

	it('去掉空白项', async () => {
		await run(addTags, { item_key: 'GOOD', tags: ['  nlp  ', '', '   '] })
		expect(calls.mergeTags[0]).toEqual([7, ['nlp']])
	})

	it('一个有效标签都没有时不调 Service', async () => {
		expect(await run(addTags, { item_key: 'GOOD', tags: ['', ' '] })).toContain('error')
		expect(calls.mergeTags).toEqual([])
	})
})

describe('fix_metadata', () => {
	it('只改给了的字段', async () => {
		await run(fixMetadata, { item_key: 'GOOD', year: 2017, journal: 'NeurIPS' })
		expect(calls.updateItem[0]).toEqual([7, { year: 2017, journal: 'NeurIPS' }])
	})

	it('没给任何字段时报错，而不是静默「成功」', async () => {
		expect(await run(fixMetadata, { item_key: 'GOOD' })).toContain('error')
		expect(calls.updateItem).toEqual([])
	})

	it('白名单之外的字段一概不动，哪怕模型传了', async () => {
		await run(fixMetadata, { item_key: 'GOOD', title: 'T', deleted: 1, library_id: 9 })
		expect(calls.updateItem[0]).toEqual([7, { title: 'T' }])
	})
})

describe('star_item', () => {
	it('两个方向都支持', async () => {
		await run(starItem, { item_key: 'GOOD', starred: true })
		await run(starItem, { item_key: 'GOOD', starred: false })
		expect(calls.setStarred).toEqual([[7, true], [7, false]])
	})
})

describe('暴露面', () => {
	it('不把删除交给模型 —— destructive 那一档还没人审过', () => {
		const names = WRITE_TOOLS.map((t) => t.name)
		expect(names).not.toContain('trash_item')
		expect(names).not.toContain('delete_item')
		expect(names).not.toContain('empty_trash')
	})
})
