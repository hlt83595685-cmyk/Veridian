// `steps` 列的归一。
//
// 这一列存过三种东西：harness 重构前是 RetrievalStep[]，重构后是
// ToolCallRecord[]，现在是 TurnTrace。老数据一行都不迁移——读的时候归一即可，
// 而且迁移脚本本身就是一次风险，为了一个展示用的列不值得。
import type { ToolCallRecord, TraceEntry, TurnTrace } from '../../../../shared/types'

const EMPTY: TurnTrace = { entries: [], elapsedMs: 0 }

function isToolRecord(v: unknown): v is ToolCallRecord {
	return typeof v === 'object' && v !== null && typeof (v as ToolCallRecord).name === 'string'
}

function isEntry(v: unknown): v is TraceEntry {
	const k = (v as TraceEntry | null)?.kind
	return k === 'note' || k === 'tool'
}

/** 解析 steps 列。任何形状都不抛——它只影响展示，不该让整条消息渲染不出来。 */
export function parseTrace(raw: string | null | undefined): TurnTrace {
	if (!raw) return EMPTY
	let v: unknown
	try {
		v = JSON.parse(raw)
	} catch {
		return EMPTY
	}

	// 新形状
	if (typeof v === 'object' && v !== null && Array.isArray((v as TurnTrace).entries)) {
		const t = v as TurnTrace
		return {
			entries: t.entries.filter(isEntry),
			elapsedMs: Number.isFinite(t.elapsedMs) ? t.elapsedMs : 0,
		}
	}

	// 老形状：裸的 ToolCallRecord[]（更老的 RetrievalStep[] 没有 name，会被滤掉）
	if (Array.isArray(v)) {
		return {
			entries: v.filter(isToolRecord).map((call) => ({ kind: 'tool', call })),
			elapsedMs: 0,
		}
	}

	return EMPTY
}

/** 「用时 18s」。毫秒对人没有意义，秒以下统一说「不到 1s」。 */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return ''
	if (ms < 1000) return '<1s'
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	return `${m}m ${s % 60}s`
}
