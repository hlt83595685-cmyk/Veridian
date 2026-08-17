import { describe, it, expect } from 'vitest'
import { TOOL_REGISTRY, buildTools } from './toolRegistry'
import { MODES, getMode } from './modes'

describe('toolRegistry', () => {
	it('resolves every tool name referenced by every mode', () => {
		for (const m of MODES)
			for (const name of m.tools)
				expect(TOOL_REGISTRY[name], `${m.id} → ${name}`).toBeDefined()
	})
	it('buildTools gates to the mode tools and appends load_skill only when skills exist', () => {
		const qa = getMode('qa')
		const names = buildTools(qa, false).map((t) => t.function.name)
		expect(names.sort()).toEqual(['get_item_info', 'read_context', 'read_item', 'search_library'].sort())
		expect(names).not.toContain('load_skill')
		expect(buildTools(qa, true).map((t) => t.function.name)).toContain('load_skill')
	})
})
