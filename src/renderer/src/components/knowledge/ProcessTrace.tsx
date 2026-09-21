import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolKind, TraceEntry } from '../../../../shared/types'
import { formatElapsed } from './parseTrace'

// 执行轨迹：这一轮里**实际发生**了什么。
//
// 叫 trace 不叫 thinking 是有意的——展示的是检索、读文件、工具调用和阶段说明，
// 不是模型的内部推理。把它标成「思考」会让用户以为看到的是模型的心里话。
//
// 三个层级，密度依次降低：
//   ① 阶段说明   模型自己的话，最可读，最该被看到（第 0 轮 = 打算做什么）
//   ② 工具行为   一行一件，字重和颜色都压下去——它是过程，不是内容
//   ③ 阶段性发现 同样是模型的话，但已经是结果（第 1 轮之后）
//
// 层级不靠猜文本语气，靠**轮次**：第 0 轮说的是计划，之后各轮说的是发现。
//
// 运行时自动展开，结束后 500ms 自动收起——过程该被看见，但看完就不该继续占地方。

/** 收起前的停留。太快看不清最后一步，太慢挡住答案。 */
const COLLAPSE_DELAY_MS = 500

const KIND_MARK: Record<ToolKind, string> = {
	read: '⌕',
	'write-library': '✎',
	'write-fs': '▤',
	destructive: '⚠',
}

interface Props {
	entries: TraceEntry[]
	/** 回合还在跑。跑着就展开，且不显示耗时（还没有终值）。 */
	running: boolean
	elapsedMs: number
	/** 当前阶段的一句话，仅运行时显示在最上面。 */
	statusLabel?: string
}

export function ProcessTrace({ entries, running, elapsedMs, statusLabel }: Props): JSX.Element | null {
	const { t } = useTranslation('common')
	// null = 跟着 running 走；true/false = 用户点过，以用户为准。
	const [override, setOverride] = useState<boolean | null>(null)
	const [autoOpen, setAutoOpen] = useState(running)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		if (running) {
			if (timer.current) clearTimeout(timer.current)
			setAutoOpen(true)
			return
		}
		// 收起前留一下：最后一步刚出现就消失，等于没显示。
		timer.current = setTimeout(() => setAutoOpen(false), COLLAPSE_DELAY_MS)
		return () => {
			if (timer.current) clearTimeout(timer.current)
		}
	}, [running])

	// 用户一旦手动开合过，就不再被自动行为改写——自动只是默认，不是接管。
	const open = override ?? autoOpen

	if (entries.length === 0 && !running) return null

	const elapsed = formatElapsed(elapsedMs)
	const summary = running
		? statusLabel ?? t('knowledge.trace.running')
		: [t('knowledge.trace.done'), elapsed && t('knowledge.trace.elapsed', { time: elapsed })]
			.filter(Boolean)
			.join(' · ')

	return (
		<div style={{ alignSelf: 'flex-start', maxWidth: '88%', minWidth: 0, width: '100%' }}>
			<button
				onClick={() => setOverride(!open)}
				style={{
					display: 'flex', alignItems: 'center', gap: 6,
					border: 'none', background: 'none', padding: '2px 0',
					color: 'var(--muted)', fontSize: 12, cursor: 'pointer',
				}}
			>
				{running && <span className="chat-dot-pulse" />}
				<span>{summary}</span>
				<Chevron open={open} />
			</button>

			{open && entries.length > 0 && (
				<div style={{ marginTop: 6, paddingLeft: 2, display: 'flex', flexDirection: 'column', gap: 7 }}>
					{entries.map((e, i) => (e.kind === 'note'
						? <Note key={`n${i}`} text={e.text} lead={e.round === 0} />
						: <Tool key={e.call.id} entry={e} />
					))}
				</div>
			)}
		</div>
	)
}

/**
 * ① / ③ 模型的话。
 *
 * 第 0 轮是「打算做什么」，给足对比度；之后各轮是「发现了什么」，正常正文。
 * 两者都保留换行——模型常用短段落分点，压成一行会读不出结构。
 */
function Note({ text, lead }: { text: string; lead: boolean }): JSX.Element {
	return (
		<div
			style={{
				fontSize: lead ? 13 : 12.5,
				lineHeight: 1.65,
				color: lead ? 'var(--foreground)' : 'var(--foreground-2)',
				fontWeight: lead ? 600 : 400,
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-word',
			}}
		>
			{text}
		</div>
	)
}

/** ② 工具行为。一行一件，字重和颜色都压下去——它是过程，不是内容。 */
function Tool({ entry }: { entry: Extract<TraceEntry, { kind: 'tool' }> }): JSX.Element {
	const { call } = entry
	const running = call.ok === undefined
	const failed = call.ok === false
	return (
		<div
			style={{
				display: 'flex', alignItems: 'baseline', gap: 7,
				fontSize: 11.5,
				color: failed ? 'var(--danger-fg)' : 'var(--muted)',
				minWidth: 0,
			}}
		>
			<span style={{ flexShrink: 0, opacity: 0.75 }}>{KIND_MARK[call.kind]}</span>
			<span style={{ fontFamily: 'ui-monospace, monospace', flexShrink: 0 }}>{call.name}</span>
			<span style={{
				overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
				minWidth: 0, opacity: 0.8,
			}}>
				{summarizeArgs(call.args)}
			</span>
			<span style={{ flex: 1 }} />
			{running
				? <span className="chat-dot-pulse" style={{ flexShrink: 0 }} />
				: (
					<span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>
						{formatElapsed(call.durationMs ?? 0)}
					</span>
				)}
		</div>
	)
}

/** 参数摘成一行。模型给的是原始 JSON，整段铺开会把这一层的密度毁掉。 */
function summarizeArgs(raw: string): string {
	if (!raw) return ''
	try {
		const o = JSON.parse(raw) as Record<string, unknown>
		return Object.entries(o)
			.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
			.join(' ')
			.slice(0, 120)
	} catch {
		return raw.slice(0, 120)
	}
}

function Chevron({ open }: { open: boolean }): JSX.Element {
	return (
		<svg
			width="11" height="11" viewBox="0 0 24 24" fill="none"
			stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
			style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }}
		>
			<path d="M9 18l6-6-6-6" />
		</svg>
	)
}
