import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContextReport } from '../../../../shared/types'

// What the model was actually handed. The collapsed row is a usage bar plus,
// when it matters, a warning that older turns were evicted -- "it forgot the
// start of our conversation" is otherwise invisible until the answers go
// strange. Expanding breaks the window down by what consumed it.

function fmt(tokens: number): string {
	if (tokens < 1000) return String(tokens)
	return `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}K`
}

const SEG_COLOR = {
	fixed: 'var(--muted-2)',
	attachments: 'var(--primary)',
	history: 'var(--foreground-3)',
} as const

export function ContextMeter({ report }: { report: ContextReport }): JSX.Element {
	const { t } = useTranslation('common')
	const [open, setOpen] = useState(false)

	const total = Math.max(1, report.contextWindow)
	const pct = (n: number): string => `${(n / total) * 100}%`
	const usedPct = Math.round((report.usedTokens / total) * 100)
	const free = Math.max(0, report.contextWindow - report.reserveForOutput - report.usedTokens)
	const evicted = report.droppedTurns > 0

	return (
		<div style={{ alignSelf: 'flex-start', maxWidth: '88%', minWidth: 260 }}>
			<button
				onClick={() => setOpen((v) => !v)}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					width: '100%',
					padding: '3px 2px',
					border: 'none',
					background: 'transparent',
					fontSize: 11,
					color: 'var(--muted)',
					textAlign: 'left',
				}}
			>
				<span
					style={{
						display: 'flex',
						width: 76,
						height: 4,
						borderRadius: 999,
						background: 'var(--muted-bg)',
						overflow: 'hidden',
						flexShrink: 0,
					}}
				>
					<span style={{ width: pct(report.fixedTokens), background: SEG_COLOR.fixed }} />
					<span style={{ width: pct(report.attachmentTokens), background: SEG_COLOR.attachments }} />
					<span style={{ width: pct(report.historyTokens), background: SEG_COLOR.history }} />
				</span>
				<span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
					{t('knowledge.context.used', {
						used: fmt(report.usedTokens),
						total: fmt(report.contextWindow),
						pct: usedPct,
					})}
				</span>
				{evicted && (
					<span style={{ color: 'var(--warn-fg)', flexShrink: 0 }}>
						· {t('knowledge.context.dropped', { count: report.droppedTurns })}
					</span>
				)}
				<span style={{ flex: 1 }} />
				<svg
					width="11"
					height="11"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					style={{
						flexShrink: 0,
						color: 'var(--muted-2)',
						transform: open ? 'rotate(90deg)' : 'none',
						transition: 'transform .15s',
					}}
					aria-hidden="true"
				>
					<path d="m9 6 6 6-6 6" />
				</svg>
			</button>

			{open && (
				<div
					style={{
						marginTop: 5,
						padding: '9px 11px',
						borderRadius: 9,
						border: '1px solid var(--border)',
						background: 'var(--surface)',
						display: 'flex',
						flexDirection: 'column',
						gap: 5,
					}}
				>
					<Row color={SEG_COLOR.fixed} label={t('knowledge.context.fixed')} value={fmt(report.fixedTokens)} />
					<Row
						color={SEG_COLOR.attachments}
						label={t('knowledge.context.attachments')}
						value={fmt(report.attachmentTokens)}
					/>
					<Row color={SEG_COLOR.history} label={t('knowledge.context.history')} value={fmt(report.historyTokens)} />
					<Row label={t('knowledge.context.free')} value={fmt(free)} dim />
					<div style={{ height: 1, background: 'var(--separator)', margin: '2px 0' }} />
					<Row label={t('knowledge.context.messages')} value={String(report.messageCount)} dim />
					{evicted && (
						<Row
							label={t('knowledge.context.droppedLabel')}
							value={String(report.droppedTurns)}
							tone="var(--warn-fg)"
						/>
					)}
					{report.truncatedAttachments > 0 && (
						<Row
							label={t('knowledge.context.truncatedLabel')}
							value={String(report.truncatedAttachments)}
							tone="var(--warn-fg)"
						/>
					)}
					<div style={{ fontSize: 10, color: 'var(--muted-2)', marginTop: 2 }}>
						{t('knowledge.context.approx')}
					</div>
				</div>
			)}
		</div>
	)
}

function Row({
	label,
	value,
	color,
	dim,
	tone,
}: {
	label: string
	value: string
	color?: string
	dim?: boolean
	tone?: string
}): JSX.Element {
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}>
			{color ? (
				<span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
			) : (
				<span style={{ width: 7, flexShrink: 0 }} />
			)}
			<span style={{ color: tone ?? (dim ? 'var(--muted)' : 'var(--foreground-2)') }}>{label}</span>
			<span style={{ flex: 1 }} />
			<span
				style={{
					color: tone ?? (dim ? 'var(--muted)' : 'var(--foreground-2)'),
					fontVariantNumeric: 'tabular-nums',
					fontFamily: 'ui-monospace, monospace',
				}}
			>
				{value}
			</span>
		</div>
	)
}
