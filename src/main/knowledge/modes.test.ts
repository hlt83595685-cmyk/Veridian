import { describe, it, expect } from 'vitest'
import { routeMode, getMode, MODES } from './modes'

describe('routeMode', () => {
	it('defaults to qa when nothing matches', () => {
		expect(routeMode('这篇论文的主要结论是什么?').id).toBe('qa')
	})
	it('explicit modeId overrides keyword detection', () => {
		expect(routeMode('随便一句话', 'review').id).toBe('review')
	})
	it('falls back to qa for an unknown explicit modeId', () => {
		expect(routeMode('随便一句话', 'nonsense').id).toBe('qa')
	})
	it('auto-detects classify / tag / review / compare / contradict', () => {
		expect(routeMode('把这些论文分类归档').id).toBe('classify')
		expect(routeMode('给这些论文打标签').id).toBe('tag')
		expect(routeMode('写一篇综述').id).toBe('review')
		expect(routeMode('对比这几篇的方法').id).toBe('compare')
		expect(routeMode('找出它们之间的矛盾').id).toBe('contradict')
	})
	it('every mode exposes a non-empty tool list and qa has no write tools', () => {
		for (const m of MODES) expect(m.tools.length).toBeGreaterThan(0)
		const qa = getMode('qa')
		for (const w of ['add_tags', 'add_to_collection', 'create_note', 'link_items', 'update_metadata', 'set_star', 'list_items'])
			expect(qa.tools).not.toContain(w)
	})
})
