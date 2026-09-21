import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeRef } from '../../../../shared/ipc-contract'
import type { Item } from '../../../../shared/types'
import { Chip, PaperclipIcon } from './Chip'

// @-mention (library items) and /-mention (installed skills) both resolve to
// one of these, rendered as a removable chip above the text area.
export interface PendingRef {
	ref: KnowledgeRef
	label: string
}

interface MentionCandidate {
	label: string
	sub: string
	ref: KnowledgeRef
	token: string
}

type MentionTrigger = { kind: 'at' | 'slash'; start: number; query: string } | null

const MAX_HEIGHT = 200

// Horizontal room around the composer box. Doubles as the ceiling on how far
// the focus glow may spread: MainLayout's <main> clips its children, so a glow
// wider than this gets sliced off flat at the page edge -- which is how a
// "glow" turns back into a hard-edged rectangle. Also matches the message
// list's own 20px side padding so the box lines up with the bubbles above it.
const SIDE_PAD = 20

// Four stops rather than one flat ring: a bright hairline core, then three
// widening, fading layers. A single spread-only shadow reads as an outline;
// light needs the falloff. Total reach is 19px, just inside SIDE_PAD.
const FOCUS_GLOW = [
	'0 0 0 1px rgba(139, 110, 249, 0.40)',
	'0 0 4px rgba(139, 110, 249, 0.38)',
	'0 0 10px rgba(139, 110, 249, 0.28)',
	'0 0 18px 1px rgba(139, 110, 249, 0.18)',
].join(', ')

export function refKey(r: KnowledgeRef): string {
	return r.type === 'item' ? `item:${r.itemKey}` : r.type === 'file' ? `file:${r.path}` : `skill:${r.name}`
}

interface Props {
	value: string
	onChange: (v: string) => void
	pendingRefs: PendingRef[]
	onAddRef: (r: PendingRef) => void
	onRemoveRef: (index: number) => void
	busy: boolean
	disabled: boolean
	editing: boolean
	onCancelEdit: () => void
	onSend: () => void
	onStop: () => void
	/** Assigned the textarea node so the page can focus it (e.g. when starting an edit). */
	focusRef?: React.MutableRefObject<HTMLTextAreaElement | null>
}

export function Composer({
	value, onChange, pendingRefs, onAddRef, onRemoveRef,
	busy, disabled, editing, onCancelEdit, onSend, onStop, focusRef,
}: Props): JSX.Element {
	const { t } = useTranslation('common')
	const taRef = useRef<HTMLTextAreaElement | null>(null)
	const reqRef = useRef(0)
	const [focused, setFocused] = useState(false)
	const [mention, setMention] = useState<MentionTrigger>(null)
	const [candidates, setCandidates] = useState<MentionCandidate[]>([])
	const [index, setIndex] = useState(0)

	const setTa = (el: HTMLTextAreaElement | null): void => {
		taRef.current = el
		if (focusRef) focusRef.current = el
	}

	// Grow with the content instead of sitting at a fixed height: an empty
	// composer shouldn't reserve four lines of dead space, and a long question
	// shouldn't be typed through a two-line slot.
	useEffect(() => {
		const el = taRef.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + 'px'
	}, [value])

	// Resolve candidates for the active trigger. @ searches library items; /
	// (only valid as the very first token) lists installed skills.
	useEffect(() => {
		if (!mention) { setCandidates([]); return }
		const reqId = ++reqRef.current
		const q = mention.query.toLowerCase()
		if (mention.kind === 'slash') {
			window.veridian.skills.list().then((skills) => {
				if (reqRef.current !== reqId) return
				setCandidates(
					skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8).map((s) => ({
						label: '/' + s.name, sub: s.description,
						ref: { type: 'skill', name: s.name }, token: `/${s.name} `,
					}))
				)
				setIndex(0)
			}).catch(() => setCandidates([]))
			return
		}
		// Empty-query search returns nothing (FTS needs a term) -- fall back to the
		// most recently touched items so a bare "@" isn't empty.
		const lookup = q
			? window.veridian.items.search(mention.query).catch(() => [])
			: window.veridian.items.getAll().catch(() => [])
		lookup.then((items: Item[]) => {
			if (reqRef.current !== reqId) return
			setCandidates(items.slice(0, 20).map((it) => ({
				label: it.title ?? it.key, sub: t('knowledge.mentionItem'),
				ref: { type: 'item', itemKey: it.key }, token: `@${it.title ?? it.key} `,
			})))
			setIndex(0)
		})
	}, [mention, t])

	function detectMention(text: string, cursor: number): MentionTrigger {
		const head = text.slice(0, cursor)
		const at = head.match(/(?:^|\s)@([^@\n]*)$/)
		if (at) return { kind: 'at', start: cursor - at[1].length - 1, query: at[1] }
		const slash = head.match(/^\/(\S*)$/)
		if (slash) return { kind: 'slash', start: 0, query: slash[1] }
		return null
	}

	function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
		const next = e.target.value
		onChange(next)
		setMention(detectMention(next, e.target.selectionStart ?? next.length))
	}

	function applyMention(cand: MentionCandidate): void {
		if (!mention) return
		const cursor = taRef.current?.selectionStart ?? value.length
		const before = value.slice(0, mention.start)
		onChange(before + value.slice(cursor))
		if (!pendingRefs.some((p) => refKey(p.ref) === refKey(cand.ref))) {
			onAddRef({ ref: cand.ref, label: cand.label })
		}
		setMention(null)
		requestAnimationFrame(() => {
			taRef.current?.focus()
			taRef.current?.setSelectionRange(before.length, before.length)
		})
	}

	// The "@ 引用文献" affordance: @-mention is only discoverable if you already
	// know to type "@", so clicking the hint types it for you.
	function triggerAt(): void {
		const el = taRef.current
		if (!el) return
		const cursor = el.selectionStart ?? value.length
		const before = value.slice(0, cursor)
		const needsSpace = before.length > 0 && !/\s$/.test(before)
		const inserted = (needsSpace ? ' @' : '@')
		const next = before + inserted + value.slice(cursor)
		onChange(next)
		const at = before.length + inserted.length
		setMention({ kind: 'at', start: at - 1, query: '' })
		requestAnimationFrame(() => {
			el.focus()
			el.setSelectionRange(at, at)
		})
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
		if (mention && candidates.length > 0) {
			if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % candidates.length); return }
			if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + candidates.length) % candidates.length); return }
			if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(candidates[index]); return }
			if (e.key === 'Escape') { e.preventDefault(); setMention(null); return }
		}
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
	}

	const canSend = value.trim().length > 0 && !disabled

	return (
		<div style={{ padding: `10px ${SIDE_PAD}px ${SIDE_PAD}px`, position: 'relative' }}>
			{mention && candidates.length > 0 && (
				<div style={popupStyle}>
					{candidates.map((c, i) => (
						<div
							key={c.token + i}
							onMouseDown={(e) => { e.preventDefault(); applyMention(c) }}
							onMouseEnter={() => setIndex(i)}
							style={{
								display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 10px',
								borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
								background: i === index ? 'var(--surface-2)' : 'transparent',
							}}
						>
							<span style={{
								color: 'var(--foreground)', fontWeight: 600, flexShrink: 0,
								overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220,
							}}>
								{c.label}
							</span>
							<span style={{
								color: 'var(--muted)', fontSize: 11, flex: 1, minWidth: 0,
								overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
							}}>
								{c.sub}
							</span>
						</div>
					))}
				</div>
			)}

			{/* Focus is signalled by the glow alone -- the border keeps its resting
			    colour. Tinting it as well produced two rings of different shapes:
			    this rounded one, plus the square one globals.css forces onto any
			    focused textarea (killed via .composer-input). */}
			<div
				style={{
					display: 'flex', flexDirection: 'column',
					border: '1px solid var(--border)',
					borderRadius: 14,
					background: 'var(--surface)',
					boxShadow: focused ? FOCUS_GLOW : 'var(--shadow-xs)',
					transition: 'box-shadow .18s ease',
					opacity: disabled ? 0.6 : 1,
				}}
			>
				{editing && (
					<div style={{
						display: 'flex', alignItems: 'center', gap: 8,
						padding: '8px 12px 0', fontSize: 11.5, color: 'var(--muted)',
					}}>
						<span>{t('knowledge.editingNote')}</span>
						<button onClick={onCancelEdit} style={linkBtnStyle}>{t('knowledge.cancel')}</button>
					</div>
				)}

				{pendingRefs.length > 0 && (
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 12px 0' }}>
						{pendingRefs.map((p, i) => (
							<Chip
								key={refKey(p.ref) + i}
								icon={<PaperclipIcon />}
								label={p.label}
								maxWidth={260}
								onRemove={() => onRemoveRef(i)}
							/>
						))}
					</div>
				)}

				<textarea
					ref={setTa}
					className="composer-input"
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					placeholder={t('knowledge.inputPlaceholder')}
					disabled={disabled}
					rows={1}
					style={textareaStyle}
				/>

				<div style={{
					display: 'flex', alignItems: 'center', gap: 10,
					padding: '0 8px 8px 10px',
				}}>
					<button onClick={triggerAt} disabled={disabled} style={attachBtnStyle}>
						<PaperclipIcon />
						{t('knowledge.attachHint')}
					</button>
					<div style={{ flex: 1 }} />
					<span style={{ fontSize: 11, color: 'var(--muted-2)', whiteSpace: 'nowrap' }}>
						{t('knowledge.sendHint')}
					</span>
					{busy ? (
						<button onClick={onStop} title={t('knowledge.stop')} style={circleBtnStyle('var(--surface-2)')}>
							<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
								<rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="var(--foreground-2)" />
							</svg>
						</button>
					) : (
						<button
							onClick={onSend}
							disabled={!canSend}
							title={editing ? t('knowledge.update') : t('knowledge.send')}
							style={circleBtnStyle(canSend ? 'var(--primary)' : 'var(--muted-bg)')}
						>
							<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
								<path
									d="M8 13V3.5M8 3.5L3.8 7.7M8 3.5l4.2 4.2"
									stroke={canSend ? '#fff' : 'var(--muted-2)'}
									strokeWidth="1.9"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</button>
					)}
				</div>
			</div>
		</div>
	)
}

const textareaStyle: React.CSSProperties = {
	width: '100%',
	minHeight: 44,
	maxHeight: MAX_HEIGHT,
	padding: '12px 14px 6px',
	border: 'none',
	background: 'transparent',
	color: 'var(--foreground)',
	fontSize: 13.5,
	lineHeight: 1.55,
	resize: 'none',
	fontFamily: 'inherit',
	outline: 'none',
	overflowY: 'auto',
}

const circleBtnStyle = (bg: string): React.CSSProperties => ({
	width: 30, height: 30, borderRadius: '50%', border: 'none', background: bg,
	display: 'flex', alignItems: 'center', justifyContent: 'center',
	cursor: 'pointer', flexShrink: 0, transition: 'background .15s',
})

const attachBtnStyle: React.CSSProperties = {
	display: 'flex', alignItems: 'center', gap: 5,
	height: 26, padding: '0 8px', borderRadius: 7,
	border: 'none', background: 'transparent', color: 'var(--muted)',
	fontSize: 11.5, cursor: 'pointer', flexShrink: 0,
}

const linkBtnStyle: React.CSSProperties = {
	border: 'none', background: 'none', padding: 0,
	color: 'var(--primary)', cursor: 'pointer', fontSize: 11.5,
}

const popupStyle: React.CSSProperties = {
	position: 'absolute', left: SIDE_PAD, right: SIDE_PAD, bottom: '100%', marginBottom: 2,
	maxHeight: 240, overflowY: 'auto', padding: 5, borderRadius: 12,
	border: '1px solid var(--border)', background: 'var(--surface)',
	boxShadow: 'var(--shadow-lg)', zIndex: 20,
}
