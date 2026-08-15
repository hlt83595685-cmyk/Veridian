/** Shared paperclip line-icon (currentColor), used by ref chips. */
export function PaperclipIcon({ size = 11 }: { size?: number }): JSX.Element {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
			<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
		</svg>
	)
}

/** Reusable pill: optional leading icon, ellipsis label, optional remove (x)
 *  and/or whole-chip click. Reuse across composer / bubble / future filters. */
export function Chip({ label, icon, onRemove, onClick, title, size = 'md', maxWidth = 240 }: {
	label: string
	icon?: JSX.Element
	onRemove?: () => void
	onClick?: () => void
	title?: string
	size?: 'sm' | 'md'
	maxWidth?: number
}): JSX.Element {
	const fs = size === 'sm' ? 11 : 11.5
	return (
		<span
			onClick={onClick}
			title={title ?? label}
			style={{
				display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth,
				padding: onRemove ? '2px 4px 2px 8px' : '1px 8px', borderRadius: 999,
				background: 'var(--muted-bg)', border: '1px solid var(--border)',
				color: 'var(--foreground-3)', fontSize: fs, cursor: onClick ? 'pointer' : 'default',
			}}
		>
			{icon}
			<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
			{onRemove && (
				<button
					onClick={(e) => { e.stopPropagation(); onRemove() }}
					style={{ border: 'none', background: 'none', padding: '0 2px', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', flexShrink: 0 }}
					aria-label="remove"
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
				</button>
			)}
		</span>
	)
}
