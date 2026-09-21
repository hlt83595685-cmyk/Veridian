import { useTranslation } from 'react-i18next'
import type { AttachmentStatus } from '../../../../shared/types'
import { Chip, PaperclipIcon } from './Chip'

// A chip that answers "did it actually read my paper?" without asking the
// model. The old assistant swallowed attachment failures and told the model
// "no converted text", which is what trained it to abandon @ and fall back to
// searching the whole library -- so the failure has to be visible here, in the
// message the user sent, with the reason attached.

type Tone = 'ok' | 'warn' | 'bad'

// Tokens, not literals: the tints are alpha and work on either ground, but the
// ink must flip with the theme or the failure text goes unreadable on dark.
const TONE: Record<Tone, { fg: string; bg: string; border: string }> = {
	ok: { fg: 'var(--foreground-3)', bg: 'var(--muted-bg)', border: 'var(--border)' },
	warn: { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', border: 'var(--warn-border)' },
	bad: { fg: 'var(--danger-fg)', bg: 'var(--danger-bg)', border: 'var(--danger-border)' },
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
	return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Rendered inside the chip, after the title, as a dim suffix. */
function StatusIcon({ tone }: { tone: Tone }): JSX.Element {
	if (tone === 'ok') return <PaperclipIcon size={10} />
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			strokeLinecap="round"
			style={{ flexShrink: 0 }}
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9.2" strokeWidth="1.8" />
			<path d="M12 7.4v5.4" />
			<circle cx="12" cy="16.6" r="0.2" strokeWidth="2.4" />
		</svg>
	)
}

export function AttachmentChip({
	label,
	status,
}: {
	label: string
	status?: AttachmentStatus
}): JSX.Element {
	const { t } = useTranslation('common')

	// No status yet: the turn is still resolving, or this is an old message from
	// before statuses were recorded. Show the plain chip rather than guessing.
	if (!status) {
		return <Chip icon={<PaperclipIcon size={10} />} label={label} size="sm" maxWidth={240} />
	}

	const tone: Tone = !status.ok ? 'bad' : status.truncated ? 'warn' : 'ok'

	const suffix = !status.ok
		? t(`knowledge.attach.${status.reason ?? 'unreadable'}`)
		: status.truncated
			? t('knowledge.attach.truncated', {
					shown: formatBytes(status.shownBytes),
					total: formatBytes(status.totalBytes),
				})
			: t('knowledge.attach.full', { size: formatBytes(status.totalBytes) })

	// Hover carries the raw error text -- classifying the failure is for the
	// glanceable label; diagnosing it needs the untouched message.
	const title = status.detail ? `${status.title}\n\n${suffix}\n${status.detail}` : `${status.title}\n\n${suffix}`
	const c = TONE[tone]

	return (
		<span
			title={title}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 5,
				maxWidth: 300,
				padding: '1px 8px',
				borderRadius: 999,
				background: c.bg,
				border: `1px solid ${c.border}`,
				color: c.fg,
				fontSize: 11,
			}}
		>
			<StatusIcon tone={tone} />
			<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
			<span style={{ opacity: 0.75, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>· {suffix}</span>
		</span>
	)
}
