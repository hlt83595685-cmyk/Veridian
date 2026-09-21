// 三个内置工具在**真的** ToolRuntime 上注册一遍。
//
// 单元测试各自 mock 了自己的依赖，证明的是工具体的逻辑；这一个证明的是接线：
// defineTool 的产物能不能被注册、schema 长成什么样、模型看到的参数对不对。
// harness 重构时断掉的正是这一层，所以它值得单独钉住。
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

// 只把「碰外部世界」的东西挡掉：数据库、electron、工作区。工具定义本身是真的。
vi.mock('../../db', () => ({ getDb: () => { throw new Error('not used in this test') } }))
vi.mock('../../knowledge/search', () => ({ hybridSearch: async () => [] }))
vi.mock('../../knowledge/skills', () => ({ listInstalledSkills: () => [], getSkillBody: () => null }))
vi.mock('../../services/WorkspaceContextService', () => ({ getActiveWorkspace: () => ({ id: 1 }) }))
vi.mock('../../services/NoteService', () => ({ saveNote: () => 1 }))
vi.mock('../../services/TagService', () => ({ mergeTagsForItem: () => ({ added: 0, total: 0 }) }))
vi.mock('../../services/ItemService', () => ({ updateItem: () => {}, setStarred: () => {}, listByCollection: () => [] }))
vi.mock('../../services/CollectionService', () => ({ listAll: () => [] }))

import { getItemInfo } from './getItemInfo'
import { searchLibrary } from './searchLibrary'
import { loadSkill } from './loadSkill'
import { WRITE_TOOLS } from './writeTools'
import { COLLECTION_TOOLS } from './collections'
import { declareKind, kindOf, _resetKinds } from './kinds'

interface Schema {
	name: string
	description?: string
	parameters: { properties?: Record<string, { type?: string }>; required?: string[] }
}

let schemas: Schema[]

beforeAll(async () => {
	const ctx = new Context()
	ctx.plugin(SystemPrompt, {})
	ctx.plugin(Tools, {})
	for (let i = 0; i < 100 && !ctx.tools; i++) await new Promise((r) => setTimeout(r, 10))

	_resetKinds()
	for (const tool of [getItemInfo, searchLibrary, loadSkill, ...COLLECTION_TOOLS]) {
		ctx.tools.register(tool)
		declareKind(tool.name, 'read')
	}
	for (const tool of WRITE_TOOLS) {
		ctx.tools.register(tool)
		declareKind(tool.name, 'write-library')
	}
	schemas = ctx.tools.schemas() as unknown as Schema[]
})

const byName = (n: string): Schema => {
	const s = schemas.find((x) => x.name === n)
	if (!s) throw new Error(`${n} not registered`)
	return s
}

describe('内置工具的注册', () => {
	it('读写工具都进了注册表', () => {
		expect(schemas.map((s) => s.name).sort()).toEqual([
			'add_tags', 'fix_metadata', 'get_item_info', 'list_collection_items',
			'list_collections', 'load_skill', 'search_library', 'star_item', 'write_note',
		])
	})

	it('kind 登记正确 —— 漏登记会让写工具被当成 read，整套护栏对它形同虚设', () => {
		for (const n of ['get_item_info', 'load_skill', 'search_library', 'list_collections', 'list_collection_items']) {
			expect(kindOf(n)).toBe('read')
		}
		for (const n of ['write_note', 'add_tags', 'fix_metadata', 'star_item']) {
			expect(kindOf(n)).toBe('write-library')
		}
	})

	it('每个都有描述，否则模型不知道什么时候该用', () => {
		for (const s of schemas) expect(s.description && s.description.length).toBeGreaterThan(10)
	})

	it('search_library：query 必填，top_k 选填且是 number', () => {
		const s = byName('search_library')
		expect(s.parameters.required).toEqual(['query'])
		expect(s.parameters.properties?.query.type).toBe('string')
		expect(s.parameters.properties?.top_k.type).toBe('number')
	})

	it('load_skill：name 必填', () => {
		const s = byName('load_skill')
		expect(s.parameters.required).toEqual(['name'])
	})

	it('get_item_info：item_key 必填', () => {
		const s = byName('get_item_info')
		expect(s.parameters.required).toEqual(['item_key'])
	})

	it('schema 里不含 execute / output —— 那些绝不能上到线上去', () => {
		for (const s of schemas) {
			expect(s).not.toHaveProperty('execute')
			expect(s).not.toHaveProperty('output')
		}
	})
})
