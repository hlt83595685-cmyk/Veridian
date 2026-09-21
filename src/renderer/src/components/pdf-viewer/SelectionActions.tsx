import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { pluginRuntime, PluginNotConfiguredError, type PluginAction } from '../../plugins/PluginRuntime'
import { clampToViewport } from '../item-tree/clampToViewport'
import { useUiStore } from '../../stores/uiStore'

const MAX_SELECTION = 4000
const BUBBLE_W = 420

interface Rect { left: number; top: number; right: number; bottom: number }
interface Pending { text: string; rect: Rect; actions: PluginAction[] }
interface Active { action: PluginAction; text: string; rect: Rect; truncated: boolean }

type BubbleState =
	| { status: 'loading' | 'streaming' | 'done'; output: string }
	| { status: 'error'; output: string; message: string }
	| { status: 'unconfigured'; missing: string[] }

/** Selecting text inside `containerRef` shows one badge per plugin action; clicking runs it. */
export function SelectionActions({ containerRef }: { containerRef: RefObject<HTMLElement | null> }): JSX.Element | null {
	const [pending, setPending] = useState<Pending | null>(null)
	const [active, setActive] = useState<Active | null>(null)
	const badgeRef = useRef<HTMLDivElement>(null)
	const bubbleRef = useRef<HTMLDivElement>(null)
	const generation = useRef(0)
	const downInside = useRef(false)   // did the current press start inside the badge/bubble?

	useEffect(() => {
		const inside = (target: EventTarget | null): boolean => {
			const n = target as Node | null
			return !!n && (!!badgeRef.current?.contains(n) || !!bubbleRef.current?.contains(n))
		}
		const onDown = (e: MouseEvent): void => {
			downInside.current = inside(e.target)
			if (downInside.current) return
			generation.current++
			setPending(null)
			setActive(null)
		}
		const onUp = (e: MouseEvent): void => {
			// a drag that began inside the bubble but ended outside it must not start a new selection
			if (inside(e.target) || downInside.current) return
			const mine = ++generation.current
			// Let the browser finish updating the selection before reading it.
			setTimeout(async () => {
				const s = window.getSelection()
				const container = containerRef.current
				const text = s?.toString().trim() ?? ''
				if (!s || s.rangeCount === 0 || !text || !container ||
					!container.contains(s.anchorNode) || !container.contains(s.focusNode)) return
				const r = s.getRangeAt(0).getBoundingClientRect()
				const actions = await pluginRuntime.listActions().catch(() => [])
				if (mine !== generation.current || actions.length === 0) return
				setPending({ text, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, actions })
			}, 0)
		}
		// The badge is positioned from the selection's rect at mouseup, so it would stay behind
		// when the page scrolls; hide it. (The bubble is left alone: it scrolls its own content.)
		const onScroll = (e: Event): void => { if (!inside(e.target)) setPending(null) }
		document.addEventListener('mousedown', onDown)
		document.addEventListener('mouseup', onUp)
		document.addEventListener('scroll', onScroll, true)
		return () => {
			document.removeEventListener('mousedown', onDown)
			document.removeEventListener('mouseup', onUp)
			document.removeEventListener('scroll', onScroll, true)
		}
	}, [containerRef])

	if (active) {
		return <ActionBubble innerRef={bubbleRef} active={active} onClose={() => setActive(null)} />
	}
	if (!pending) return null

	const badgeW = pending.actions.length * 64 + 8
	return (
		<div
			ref={badgeRef}
			// keep the text selected while the badge is clicked
			onMouseDown={(e) => e.preventDefault()}
			style={{
				position: 'fixed', zIndex: 300, display: 'flex', gap: 4,
				left: clampToViewport(pending.rect.right - 8, badgeW, window.innerWidth),
				top: clampToViewport(pending.rect.bottom + 6, 28, window.innerHeight),
			}}
		>
			{pending.actions.map((a) => (
				<button
					key={a.pluginId + ':' + a.actionId}
					onClick={() => {
						setActive({
							action: a,
							text: pending.text.slice(0, MAX_SELECTION),
							rect: pending.rect,
							truncated: pending.text.length > MAX_SELECTION,
						})
						setPending(null)
					}}
					style={{
						height: 28, padding: '0 12px', borderRadius: 'var(--radius-md)',
						border: 'none', background: 'var(--primary)', color: '#fff',
						fontSize: 12, fontWeight: 600, boxShadow: 'var(--shadow-md)',
					}}
				>
					{a.title}
				</button>
			))}
		</div>
	)
}

function bubblePosition(rect: Rect): CSSProperties {
	const left = clampToViewport(rect.left, BUBBLE_W, window.innerWidth)
	const below = window.innerHeight - rect.bottom - 16
	const above = rect.top - 16
	if (below >= 140 || below >= above) return { left, top: rect.bottom + 8, maxHeight: Math.min(320, below) }
	return { left, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(320, above) }
}

const linkBtn: CSSProperties = {
	marginTop: 8, padding: 0, border: 'none', background: 'none',
	color: 'var(--primary)', fontSize: 12, textDecoration: 'underline',
}

function ActionBubble({ active, innerRef, onClose }: {
	active: Active
	innerRef: RefObject<HTMLDivElement>
	onClose: () => void
}): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const setSettingsTab = useUiStore((s) => s.setSettingsTab)
	const [state, setState] = useState<BubbleState>({ status: 'loading', output: '' })

	useEffect(() => {
		const ctl = new AbortController()
		let acc = ''
		setState({ status: 'loading', output: '' })
		pluginRuntime
			.runAction(active.action.pluginId, active.action.actionId, active.text, (chunk) => {
				acc += chunk
				setState({ status: 'streaming', output: acc })
			}, ctl.signal)
			.then(() => setState({ status: 'done', output: acc }))
			.catch((err: unknown) => {
				if (ctl.signal.aborted) return
				if (err instanceof PluginNotConfiguredError) setState({ status: 'unconfigured', missing: err.missing })
				else setState({ status: 'error', output: acc, message: err instanceof Error ? err.message : String(err) })
			})
		return () => ctl.abort()
	}, [active])

	useEffect(() => {
		const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
		window.addEventListener('keydown', h)
		return () => window.removeEventListener('keydown', h)
	}, [onClose])

	const goSettings = (): void => {
		setSettingsTab('plugins')
		setPage('settings')
	}

	return (
		<div
			ref={innerRef}
			style={{
				position: 'fixed', zIndex: 300, width: BUBBLE_W, maxWidth: 'calc(100vw - 16px)', overflowY: 'auto',
				background: 'var(--bg-elevated)', color: 'var(--foreground)',
				border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
				boxShadow: 'var(--shadow-lg)', padding: '10px 14px',
				fontSize: 13, lineHeight: 1.65,
				...bubblePosition(active.rect),
			}}
		>
			{state.status === 'unconfigured' ? (
				<>
					<div>{t('settings.plugins.bubble.notConfigured', { fields: state.missing.join(', ') })}</div>
					<button onClick={goSettings} style={linkBtn}>{t('settings.plugins.bubble.goSettings')}</button>
				</>
			) : (
				<>
					{state.status === 'loading' && (
						<span style={{ color: 'var(--muted)' }}>{t('settings.plugins.bubble.loading')}</span>
					)}
					{state.output && (
						<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{state.output}</div>
					)}
					{state.status === 'error' && (
						<div style={{ color: 'var(--danger-fg)', marginTop: state.output ? 8 : 0 }}>
							{t('settings.plugins.bubble.failed', { message: state.message })}
						</div>
					)}
					{active.truncated && (
						<div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8 }}>
							{t('settings.plugins.bubble.truncated', { max: MAX_SELECTION })}
						</div>
					)}
				</>
			)}
		</div>
	)
}
