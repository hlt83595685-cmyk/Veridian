import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
	BLAST_RADIUS_LIMIT,
	type ApprovalChange,
	type ApprovalDecision,
	type ApprovalRequest,
	type ToolKind,
} from '../../../../shared/types'

// The gate. A write never happens on the model's say-so alone, and what it is
// asking for has to be legible without reading raw JSON -- so this shows the
// change itself, before and after.
//
// It lives in the transcript rather than in a modal: a modal interrupts
// reading, and two queued requests would fight over the screen. In the
// transcript they queue naturally, in the order they were asked.

const TONE: Record<ToolKind, { fg: string; bg: string; border: string }> = {
	read: { fg: 'var(--muted)', bg: 'transparent', border: 'var(--border)' },
	'write-library': { fg: 'var(--primary)', bg: 'var(--primary-soft)', border: 'var(--primary-light)' },
	'write-fs': { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', border: 'var(--warn-border)' },
	destructive: { fg: 'var(--danger-fg)', bg: 'var(--danger-bg)', border: 'var(--danger-border)' },
}

interface Props {
	request: ApprovalRequest
	/** Set once settled; the card then reports the outcome instead of asking. */
	decision?: ApprovalDecision
	onDecide: (decision: ApprovalDecision) => void
}

export function ApprovalCard({ request, decision, onDecide }: Props): JSX.Element {
	const { t } = useTranslation('common')
	const [open, setOpen] = useState(false)
	const tone = TONE[request.kind] ?? TONE.read
	// Past the limit a per-row list is theatre: nobody checks 4,000 rows, so the
	// request is re-framed around the number instead.
	const bulk = request.affected > BLAST_RADIUS_LIMIT
	const settled = decision !== undefined
	// Standing permission is deliberately withheld for bulk and destructive work
	// -- see the button row below.
	const offersSession = !bulk && request.kind !== 'destructive'

	return (
		<div
			style={{
				alignSelf: 'flex-start',
				maxWidth: '92%',
				// Width follows content; the floor only stops the action row from
				// wrapping into a heap.
				minWidth: 320,
				borderRadius: 12,
				border: `1px solid ${bulk && !settled ? 'var(--danger-border)' : tone.border}`,
				background: bulk && !settled ? 'var(--danger-bg)' : tone.bg,
				overflow: 'hidden',
				opacity: settled ? 0.75 : 1,
			}}
		>
			<div style={{ padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<ShieldIcon tone={bulk && !settled ? 'var(--danger-fg)' : tone.fg} />
					<span
						style={{
							fontSize: 12.5,
							fontWeight: 700,
							color: bulk && !settled ? 'var(--danger-fg)' : 'var(--foreground)',
						}}
					>
						{bulk ? t('knowledge.approval.bulkTitle', { count: request.affected }) : request.summary}
					</span>
					<span style={{ flex: 1 }} />
					<span
						style={{
							fontSize: 10.5,
							fontFamily: 'ui-monospace, monospace',
							color: 'var(--muted-2)',
							flexShrink: 0,
						}}
					>
						{request.tool}
					</span>
				</div>

				{bulk && (
					<div style={{ fontSize: 11.5, color: 'var(--foreground-2)', lineHeight: 1.6 }}>
						{t('knowledge.approval.bulkHint', { limit: BLAST_RADIUS_LIMIT })}
					</div>
				)}

				{!bulk && request.changes.length > 0 && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						{request.changes.map((c, i) => (
							<ChangeRow key={i} change={c} />
						))}
					</div>
				)}

				{settled ? (
					<div style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>
						{t(`knowledge.approval.outcome.${decision}`)}
					</div>
				) : (
					<div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
						<button onClick={() => onDecide('allow-once')} style={btn('primary')}>
							{bulk ? t('knowledge.approval.proceedAnyway') : t('knowledge.approval.allowOnce')}
						</button>
						<button onClick={() => onDecide('deny')} style={btn('plain')}>
							{t('knowledge.approval.deny')}
						</button>
						{/* "Stop asking me" should never be how a thousand-row change or a
						    deletion gets through. */}
						{offersSession && (
							<button onClick={() => onDecide('allow-session')} style={btn('plain')}>
								{t('knowledge.approval.allowSession')}
							</button>
						)}
						<span style={{ flex: 1 }} />
						<button onClick={() => setOpen((v) => !v)} style={btn('link')}>
							{open ? t('knowledge.approval.hideDetail') : t('knowledge.approval.showDetail')}
						</button>
					</div>
				)}

				{open && (
					<>
						{bulk && request.changes.length > 0 && (
							<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
								<div style={labelStyle}>
									{t('knowledge.approval.sample', {
										shown: request.changes.length,
										total: request.affected,
									})}
								</div>
								{request.changes.map((c, i) => (
									<ChangeRow key={i} change={c} />
								))}
							</div>
						)}
						<div>
							<div style={labelStyle}>{t('knowledge.tool.arguments')}</div>
							<pre style={preStyle}>{pretty(request.args)}</pre>
						</div>
					</>
				)}
			</div>
		</div>
	)
}

function ChangeRow({ change }: { change: ApprovalChange }): JSX.Element {
	if (change.type === 'file') {
		return (
			<div style={rowStyle}>
				<span style={{ ...cellStyle, flex: 1 }}>{change.path}</span>
				<span style={{ color: 'var(--muted)', flexShrink: 0 }}>{change.op}</span>
				{change.bytesBefore !== undefined && change.bytesAfter !== undefined && (
					<span style={{ color: 'var(--muted-2)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
						{change.bytesBefore} → {change.bytesAfter} B
					</span>
				)}
			</div>
		)
	}
	return (
		<div style={{ ...rowStyle, flexWrap: 'wrap' }}>
			<span style={{ ...cellStyle, maxWidth: 200, color: 'var(--foreground-2)' }}>{change.title}</span>
			<span style={{ color: 'var(--muted-2)', flexShrink: 0 }}>{change.field}</span>
			<span style={{ ...cellStyle, ...diffStyle('before') }}>{change.before ?? '∅'}</span>
			<span style={{ color: 'var(--muted-2)', flexShrink: 0 }}>→</span>
			<span style={{ ...cellStyle, ...diffStyle('after') }}>{change.after ?? '∅'}</span>
		</div>
	)
}

function ShieldIcon({ tone }: { tone: string }): JSX.Element {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke={tone}
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ flexShrink: 0 }}
			aria-hidden="true"
		>
			<path d="M12 3l7.5 3v5.5c0 4.4-3 8.3-7.5 9.5-4.5-1.2-7.5-5.1-7.5-9.5V6z" />
			<path d="M12 9v4" />
			<circle cx="12" cy="16.2" r="0.2" strokeWidth="2.2" />
		</svg>
	)
}

function pretty(json: string): string {
	try {
		return JSON.stringify(JSON.parse(json), null, 2)
	} catch {
		return json
	}
}

const rowStyle: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 6,
	fontSize: 11.5,
	lineHeight: 1.7,
	minWidth: 0,
}

const cellStyle: React.CSSProperties = {
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
	minWidth: 0,
	fontFamily: 'ui-monospace, monospace',
}

const diffStyle = (side: 'before' | 'after'): React.CSSProperties => ({
	maxWidth: 220,
	padding: '0 5px',
	borderRadius: 4,
	background: side === 'before' ? 'var(--danger-bg)' : 'var(--primary-soft)',
	color: side === 'before' ? 'var(--danger-fg)' : 'var(--foreground)',
	textDecoration: side === 'before' ? 'line-through' : 'none',
})

const labelStyle: React.CSSProperties = {
	fontSize: 10,
	fontWeight: 700,
	letterSpacing: '0.05em',
	textTransform: 'uppercase',
	color: 'var(--muted-2)',
	marginBottom: 3,
}

const preStyle: React.CSSProperties = {
	margin: 0,
	padding: '7px 9px',
	borderRadius: 7,
	background: 'var(--muted-bg)',
	color: 'var(--foreground-2)',
	fontSize: 11.5,
	lineHeight: 1.5,
	fontFamily: 'ui-monospace, monospace',
	whiteSpace: 'pre-wrap',
	wordBreak: 'break-word',
	maxHeight: 220,
	overflowY: 'auto',
}

const btn = (kind: 'primary' | 'plain' | 'link'): React.CSSProperties => ({
	height: 27,
	padding: kind === 'link' ? 0 : '0 12px',
	borderRadius: 7,
	border: kind === 'plain' ? '1px solid var(--border)' : 'none',
	background: kind === 'primary' ? 'var(--primary)' : kind === 'plain' ? 'var(--surface)' : 'transparent',
	color: kind === 'primary' ? '#fff' : kind === 'link' ? 'var(--muted)' : 'var(--foreground-2)',
	fontSize: 11.5,
	fontWeight: 600,
	flexShrink: 0,
})
