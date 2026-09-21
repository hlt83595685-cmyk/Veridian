// steps 列存过三种形状。归一必须**永不抛**——它只影响展示，一条读不出来的
// 轨迹不该让整条消息渲染不出来。
import { describe, it, expect } from 'vitest'
import { formatElapsed, parseTrace } from './parseTrace'
import type { ToolCallRecord } from '../../../../shared/types'

const tool = (id: string): ToolCallRecord =>
	({ id, name: 'search_library', kind: 'read', args: '{}', ok: true, durationMs: 12 })

describe('parseTrace', () => {
	it('新形状：整条轨迹 + 耗时', () => {
		const raw = JSON.stringify({
			entries: [{ kind: 'note', text: '先查一下', round: 0 }, { kind: 'tool', call: tool('c1') }],
			elapsedMs: 18000,
		})
		const t = parseTrace(raw)
		expect(t.elapsedMs).toBe(18000)
		expect(t.entries).toHaveLength(2)
		expect(t.entries[0]).toMatchObject({ kind: 'note', round: 0 })
	})

	it('老形状：裸的 ToolCallRecord[] 包成 tool 条目', () => {
		const t = parseTrace(JSON.stringify([tool('c1'), tool('c2')]))
		expect(t.entries).toEqual([
			{ kind: 'tool', call: tool('c1') },
			{ kind: 'tool', call: tool('c2') },
		])
		expect(t.elapsedMs).toBe(0)
	})

	it('更老的 RetrievalStep[]（没有 name）被滤掉，而不是画出一堆空条目', () => {
		expect(parseTrace(JSON.stringify([{ query: 'x' }, { seq: 1 }])).entries).toEqual([])
	})

	it.each([
		['null', null],
		['空串', ''],
		['不是 JSON', 'not json'],
		['数字', '42'],
		['对象但没有 entries', '{"a":1}'],
	])('%s → 空轨迹，不抛', (_l, raw) => {
		expect(parseTrace(raw)).toEqual({ entries: [], elapsedMs: 0 })
	})

	it('entries 里混了不认识的 kind 就丢掉那几条，其余照常', () => {
		const raw = JSON.stringify({
			entries: [{ kind: 'note', text: 'a', round: 0 }, { kind: '???' }, null],
			elapsedMs: 5,
		})
		expect(parseTrace(raw).entries).toHaveLength(1)
	})

	it('耗时不是数字时退回 0，不显示 NaN', () => {
		expect(parseTrace('{"entries":[],"elapsedMs":"x"}').elapsedMs).toBe(0)
	})
})

describe('formatElapsed', () => {
	it.each([
		[0, ''],
		[-5, ''],
		[400, '<1s'],
		[1000, '1s'],
		[18000, '18s'],
		[59_400, '59s'],
		[65_000, '1m 5s'],
		[684_000, '11m 24s'],
	])('%i ms → %s', (ms, want) => {
		expect(formatElapsed(ms)).toBe(want)
	})
})
