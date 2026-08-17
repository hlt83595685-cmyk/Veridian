import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useCollectionStore } from '../../stores/collectionStore'
import type { DomainEvent } from '../../../../shared/events'
import type { KnowledgeRef } from '../../../../shared/ipc-contract'
import type { Item, RetrievalStep } from '../../../../shared/types'
import { IMPORTANT_SCOPE } from '../../../../shared/types'
import { ChatMessageView, type CitationInfo } from './ChatMessage'
import { Chip, PaperclipIcon } from './Chip'
import { ToolIcon } from './RetrievalTrace'

interface ConversationRow { id: number; title: string; created_at: number; scope_collection_id: number | null }
interface DisplayMessage {
	id: number | 'streaming'
	role: 'user' | 'assistant'
	content: string
	citations: CitationInfo[]
	steps?: RetrievalStep[]
	refs?: { type: string; itemKey?: string; path?: string; name?: string; label: string }[]
}

type ChatState = 'idle' | 'searching' | 'answering' | 'error'

// @-mention (library items) and /-mention (installed skills) both resolve to
// one of these, rendered as a removable chip in the composer.
interface PendingRef { ref: KnowledgeRef; label: string }
interface MentionCandidate { label: string; sub: string; ref: KnowledgeRef; token: string }
type MentionTrigger = { kind: 'at' | 'slash'; start: number; query: string } | null

const TASK_MODES = ['review', 'compare', 'contradict', 'classify', 'tag', 'notes'] as const

export function KnowledgePage(): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const { workspaces, activeWorkspaceId } = useWorkspaceStore()
	const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)

	const [conversations, setConversations] = useState<ConversationRow[]>([])
	const [conversationId, setConversationId] = useState<number | null>(null)
	// Reuse the app-wide collection store: it's loaded by App on workspace.dataRefreshed
	// and reloaded on switches -- a local mount-time fetch here races app boot and
	// comes back empty (this page is kept mounted, so it never retries).
	const collections = useCollectionStore((s) => s.collections)
	const [scopeCollectionId, setScopeCollectionId] = useState<number | null>(null)
	const [activeMode, setActiveMode] = useState<string | null>(null)
	const [messages, setMessages] = useState<DisplayMessage[]>([])
	const [input, setInput] = useState('')
	const [chatState, setChatState] = useState<ChatState>('idle')
	const [stateDetail, setStateDetail] = useState<string | null>(null)
	const [liveStep, setLiveStep] = useState<RetrievalStep | null>(null)
	const [chatConfigured, setChatConfigured] = useState<boolean | null>(null)
	const streamingRef = useRef('')
	const bottomRef = useRef<HTMLDivElement>(null)
	const chatScrollRef = useRef<HTMLDivElement>(null)
	const turnAnchorRef = useRef<HTMLDivElement>(null)
	const pinTopRef = useRef(false)
	const [spacerH, setSpacerH] = useState(0)
	const activeConvIdRef = useRef<number | null>(null)
	activeConvIdRef.current = conversationId
	// The conversation that currently has a generation in flight (may differ from
	// the one being viewed once the user switches away mid-run).
	const runningConvIdRef = useRef<number | null>(null)
	// Synchronous re-entrancy guard for send(). chatState alone isn't safe here:
	// its setter is async/batched, so two send() calls within the same tick
	// (IME Enter-to-confirm firing right before Enter-to-submit, a fast
	// double-click) both read the pre-update state and both pass the check --
	// two concurrent streams then interleave their deltas into one bubble,
	// which is exactly the "duplicated while streaming, correct once saved"
	// symptom this fixes.
	const busyRef = useRef(false)

	// @/`/`-mention state. `pendingRefs` is the source of truth sent to ask();
	// the textarea's own text is just what the user sees and can freely edit.
	const [pendingRefs, setPendingRefs] = useState<PendingRef[]>([])
	const [editing, setEditing] = useState<number | null>(null)
	const [mention, setMention] = useState<MentionTrigger>(null)
	const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([])
	const [mentionIndex, setMentionIndex] = useState(0)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const mentionReqRef = useRef(0)

	useEffect(() => {
		void refreshConversations()
		void checkChatConfigured()
	}, [])


	async function checkChatConfigured(): Promise<void> {
		const [b, m, k] = await Promise.all([
			window.veridian.settings.get('knowledge.chat.baseURL'),
			window.veridian.settings.get('knowledge.chat.model'),
			window.veridian.settings.get('knowledge.chat.apiKey'),
		])
		setChatConfigured(!!b && !!m && !!k)
	}

	// Resolve candidates for the active trigger. @ searches library items +
	// workspace text files together; / (only valid as the very first token)
	// lists installed skills. The repo tree is re-fetched on every @ trigger
	// (not cached from mount) -- this page is kept mounted app-wide now
	// (see MainLayout) so a mount-time fetch would go stale across workspace
	// switches and could even race the active workspace still being resolved
	// at very early app boot.
	useEffect(() => {
		if (!mention) { setMentionCandidates([]); return }
		const reqId = ++mentionReqRef.current
		const q = mention.query.toLowerCase()
		if (mention.kind === 'slash') {
			window.veridian.skills.list().then((skills) => {
				if (mentionReqRef.current !== reqId) return
				setMentionCandidates(
					skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 8).map((s) => ({
						label: '/' + s.name, sub: s.description,
						ref: { type: 'skill', name: s.name }, token: `/${s.name} `,
					}))
				)
			}).catch(() => setMentionCandidates([]))
			return
		}

		// Empty-query search returns nothing (FTS needs a term) -- fall back to the
		// most recently touched items so a bare "@" isn't empty. @ mentions a
		// library item by title; the agent reads that item's markdown behind the
		// scenes (resolveRefs), so raw .md files are never surfaced here.
		const lookup = q
			? window.veridian.items.search(mention.query).catch(() => [])
			: window.veridian.items.getAll().catch(() => [])
		lookup.then((items: Item[]) => {
			if (mentionReqRef.current !== reqId) return
			setMentionCandidates(items.slice(0, 20).map((it) => ({
				label: it.title ?? it.key, sub: t('knowledge.mentionItem'),
				ref: { type: 'item', itemKey: it.key }, token: `@${it.title ?? it.key} `,
			})))
			setMentionIndex(0)
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

	function onInputChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
		const value = e.target.value
		setInput(value)
		setMention(detectMention(value, e.target.selectionStart ?? value.length))
	}

	function applyMention(cand: MentionCandidate): void {
		if (!mention) return
		const cursor = textareaRef.current?.selectionStart ?? input.length
		const before = input.slice(0, mention.start)
		const after = input.slice(cursor)
		setInput(before + after)
		const refKey = (r: KnowledgeRef): string =>
			r.type === 'item' ? `item:${r.itemKey}` : r.type === 'file' ? `file:${r.path}` : `skill:${r.name}`
		setPendingRefs((prev) => prev.some((p) => refKey(p.ref) === refKey(cand.ref)) ? prev : [...prev, { ref: cand.ref, label: cand.label }])
		setMention(null)
		requestAnimationFrame(() => {
			textareaRef.current?.focus()
			textareaRef.current?.setSelectionRange(before.length, before.length)
		})
	}

	useEffect(() => {
		const onEvent = (e: DomainEvent): void => {
			if (e.type === 'knowledge.chatDelta') {
				if (e.conversationId !== activeConvIdRef.current) return
				streamingRef.current += e.delta
				setMessages((prev) => {
					const last = prev[prev.length - 1]
					if (last?.id === 'streaming') {
						return [...prev.slice(0, -1), { ...last, content: streamingRef.current }]
					}
					return [...prev, { id: 'streaming', role: 'assistant', content: streamingRef.current, citations: [] }]
				})
			} else if (e.type === 'knowledge.chatReset') {
				// An intermediate (tool-calling) round streamed only preamble/thinking;
				// drop it from the bubble so the bubble ends up holding just the answer.
				if (e.conversationId !== activeConvIdRef.current) return
				streamingRef.current = ''
				setMessages((prev) => (prev[prev.length - 1]?.id === 'streaming' ? prev.slice(0, -1) : prev))
			} else if (e.type === 'knowledge.step') {
				if (e.conversationId !== activeConvIdRef.current) return
				setLiveStep(e.step)
			} else if (e.type === 'knowledge.chatState') {
				// Record generation lifecycle even for a backgrounded conversation the
				// user has switched away from, so its completion is never lost (which
				// otherwise left busy stuck / status bleeding into other sessions).
				if (e.state === 'done' || e.state === 'error') {
					if (e.conversationId === runningConvIdRef.current) runningConvIdRef.current = null
					void refreshConversations()
				}
				if (e.conversationId !== activeConvIdRef.current) return
				setStateDetail(e.detail ?? null)
				if (e.state === 'done') {
					setChatState('idle')
					streamingRef.current = ''
					busyRef.current = false
					setLiveStep(null)
					void refreshMessages(e.conversationId)
				} else if (e.state === 'error') {
					setChatState('error')
					busyRef.current = false
					setLiveStep(null)
				} else {
					setChatState(e.state)
				}
			} else if (e.type === 'workspace.dataRefreshed') {
				// This page is kept mounted app-wide (see MainLayout), so its
				// mount-time conversation fetch can race the active workspace
				// still resolving at very early app boot -- it only ever loads
				// personal-library history (or nothing) and never retries.
				// Re-fetch whenever the active data context settles or switches,
				// same as every other workspace-scoped pane (RepoTreePane, etc.)
				//
				// This event can also fire mid-generation (a background sync pull
				// completing has nothing to do with the user's own action). If a
				// request is in flight, its eventual chatState:'done'/'error' for
				// the old conversationId will be ignored below (conversationId no
				// longer matches activeConvIdRef) and would otherwise leave
				// busyRef stuck true forever -- nothing else ever resets it once
				// this page stops remounting. Stop the orphaned generation and
				// clear the guard here instead of leaving it to time out silently.
				if (busyRef.current && activeConvIdRef.current !== null) {
					void window.veridian.knowledge.stop(activeConvIdRef.current)
				}
				busyRef.current = false
				runningConvIdRef.current = null
				streamingRef.current = ''
				setLiveStep(null)
				setStateDetail(null)
				setConversationId(null)
				setMessages([])
				setChatState('idle')
				void refreshConversations()
			} else if (e.type === 'settings.changed') {
				// Same mount-once-is-no-longer-enough issue: chatConfigured was
				// only ever probed at the very first mount (now app boot, before
				// the user has had a chance to fill in the provider settings) and
				// never re-checked, so finishing first-time setup in Settings
				// never un-disables the chat input without a full app restart.
				if (e.keys.some((k) => k.startsWith('knowledge.chat.'))) void checkChatConfigured()
			}
		}
		return window.veridian.onDomainEvent(onEvent)
	}, [])

	useEffect(() => {
		// Subsequent turns pin the new question to the top of the chat (room below
		// is provided by the spacer); the first turn / streaming just follows the
		// bottom.
		if (pinTopRef.current && turnAnchorRef.current) {
			turnAnchorRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' })
		} else {
			bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
		}
	}, [messages, liveStep, chatState])

	async function refreshConversations(): Promise<void> {
		const list = await window.veridian.knowledge.listConversations()
		setConversations(list)
	}

	async function refreshMessages(id: number): Promise<void> {
		const rows = await window.veridian.knowledge.getMessages(id)
		setMessages(rows.map((r) => ({
			id: r.id, role: r.role as 'user' | 'assistant', content: r.content,
			citations: JSON.parse(r.citations || '[]'),
			steps: JSON.parse(r.steps || '[]'),
			refs: JSON.parse(r.refs || '[]'),
		})))
	}

	function startNewConversation(): void {
		setConversationId(null)
		setMessages([])
		setChatState('idle')
		streamingRef.current = ''
		setLiveStep(null)
		setStateDetail(null)
		busyRef.current = false
		setPendingRefs([])
		setMention(null)
		setScopeCollectionId(null)
		setActiveMode(null)
		pinTopRef.current = false
		setSpacerH(0)
	}

	async function openConversation(id: number): Promise<void> {
		const row = conversations.find((c) => c.id === id)
		const saved = row?.scope_collection_id ?? null
		const valid = saved === IMPORTANT_SCOPE || collections.some((c) => c.id === saved)
		// Reset all transient streaming state so the previous conversation's in-flight
		// status / thinking / partial bubble never bleeds into this one. If the target
		// itself is the one still generating, keep it "busy" and let its live events
		// repaint it.
		streamingRef.current = ''
		setLiveStep(null)
		setStateDetail(null)
		pinTopRef.current = false
		setSpacerH(0)
		const running = id === runningConvIdRef.current
		busyRef.current = running
		setChatState(running ? 'searching' : 'idle')
		setScopeCollectionId(valid ? saved : null)
		setActiveMode(null)
		setConversationId(id)
		await refreshMessages(id)
	}

	async function deleteConversation(id: number, e: React.MouseEvent): Promise<void> {
		e.stopPropagation()
		await window.veridian.knowledge.deleteConversation(id)
		if (conversationId === id) startNewConversation()
		await refreshConversations()
	}

	async function send(): Promise<void> {
		const q = input.trim()
		if (!q || busyRef.current) return
		busyRef.current = true
		const refs = pendingRefs.map((p) => p.ref)
		const sentRefs = pendingRefs.map((p) => ({ ...p.ref, label: p.label }))
		const wasEditing = editing !== null
		setInput('')
		setPendingRefs([])
		setMention(null)
		setEditing(null)
		streamingRef.current = ''
		setLiveStep(null)
		// Subsequent turns pin the new question to the top of the chat; the spacer
		// provides the room needed to scroll it up. The very first turn stays natural.
		const subsequentTurn = messages.length > 0
		pinTopRef.current = subsequentTurn
		if (subsequentTurn) setSpacerH(chatScrollRef.current?.clientHeight ?? 0)
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [], refs: sentRefs }])
		setChatState('searching')
		if (wasEditing && conversationId !== null) {
			runningConvIdRef.current = conversationId
			await window.veridian.knowledge.editResend(conversationId, q, refs.length ? refs : undefined, scopeCollectionId, activeMode)
		} else {
			if (conversationId !== null) runningConvIdRef.current = conversationId
			const id = await window.veridian.knowledge.ask(q, conversationId, refs.length ? refs : undefined, scopeCollectionId, activeMode)
			setConversationId(id)
			runningConvIdRef.current = id
		}
	}

	async function stop(): Promise<void> {
		if (conversationId !== null) await window.veridian.knowledge.stop(conversationId)
		if (conversationId === runningConvIdRef.current) runningConvIdRef.current = null
	}

	function regenerate(): void {
		if (conversationId === null || busyRef.current) return
		busyRef.current = true
		runningConvIdRef.current = conversationId
		streamingRef.current = ''
		setLiveStep(null)
		setMessages((prev) => {
			const last = prev[prev.length - 1]
			return last?.role === 'assistant' ? prev.slice(0, -1) : prev
		})
		setChatState('searching')
		void window.veridian.knowledge.regenerate(conversationId)
	}

	function startEdit(msg: DisplayMessage): void {
		if (busyRef.current) return
		setInput(msg.content)
		setPendingRefs((msg.refs ?? []).map((r) => ({
			ref: r.type === 'item' ? { type: 'item', itemKey: r.itemKey ?? '' }
				: r.type === 'file' ? { type: 'file', path: r.path ?? '' }
				: { type: 'skill', name: r.name ?? '' },
			label: r.label,
		})))
		setEditing(typeof msg.id === 'number' ? msg.id : null)
		setMessages((prev) => {
			const idx = prev.findIndex((m) => m.id === msg.id)
			return idx === -1 ? prev : prev.slice(0, idx)
		})
		requestAnimationFrame(() => textareaRef.current?.focus())
	}

	function cancelEdit(): void {
		setEditing(null)
		setInput('')
		setPendingRefs([])
		if (conversationId !== null) void refreshMessages(conversationId)
	}

	const busy = chatState === 'searching' || chatState === 'answering'
	const scopeLabel = activeWs?.name ?? t('knowledge.personalLibrary')
	const lastId = messages[messages.length - 1]?.id
	const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id

	return (
		<div style={{ display: 'flex', height: '100%' }}>
			{/* Conversation list */}
			<aside style={{
				width: 220, flexShrink: 0, borderRight: '1px solid var(--separator)',
				display: 'flex', flexDirection: 'column', padding: '12px 10px', gap: 8, overflow: 'hidden',
			}}>
				<button onClick={startNewConversation} style={newConvBtnStyle}>
					+ {t('knowledge.newConversation')}
				</button>
				<div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 6px' }}>
					{t('knowledge.history')}
				</div>
				<div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
					{conversations.length === 0 && (
						<div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px' }}>{t('knowledge.emptyHistory')}</div>
					)}
					{conversations.map((c) => (
						<div
							key={c.id}
							onClick={() => void openConversation(c.id)}
							style={{
								display: 'flex', alignItems: 'center', gap: 4, padding: '7px 8px', borderRadius: 8,
								background: conversationId === c.id ? 'var(--surface-2)' : 'transparent',
								cursor: 'pointer', fontSize: 12.5, color: 'var(--foreground-2)',
							}}
						>
							<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{c.title}
							</span>
							<button
								onClick={(e) => void deleteConversation(c.id, e)}
								title={t('knowledge.deleteConversation')}
								style={{ border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 12, padding: 2, flexShrink: 0 }}
							>
								✕
							</button>
						</div>
					))}
				</div>
			</aside>

			{/* Chat column */}
			<div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
				<div style={{
					display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 46, flexShrink: 0,
					borderBottom: '1px solid var(--separator)',
				}}>
					<button onClick={() => setPage('library')} style={backBtnStyle}>← {t('page.back')}</button>
					<span style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)' }}>{t('knowledge.title')}</span>
					<span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 4 }}>
						{t('knowledge.scope', { workspace: scopeLabel })}
					</span>
				</div>

				<div ref={chatScrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
					{chatConfigured === false && (
						<div style={notConfiguredBanner}>
							<span>{t('knowledge.notConfigured')}</span>
						</div>
					)}
					{messages.length === 0 && chatConfigured !== false && (
						<div style={{ margin: 'auto', color: 'var(--muted)', fontSize: 13, textAlign: 'center', maxWidth: 340 }}>
							{t('knowledge.emptyState')}
						</div>
					)}
					{messages.map((m) => (
						<Fragment key={m.id}>
							{m.role === 'user' && m.id === lastUserId && <div ref={turnAnchorRef} style={{ scrollMarginTop: 12 }} />}
							<ChatMessageView
								role={m.role}
								content={m.content}
								citations={m.citations}
								refs={m.refs}
								streaming={m.id === 'streaming'}
								isLast={!busy && (m.role === 'assistant' ? m.id === lastId : m.id === lastUserId)}
								onRegenerate={m.role === 'assistant' && m.id === lastId ? regenerate : undefined}
								onEdit={m.role === 'user' && m.id === lastUserId ? () => startEdit(m) : undefined}
							/>
						</Fragment>
					))}
					{chatState === 'error' && (
						<div style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--danger, #dc2626)' }}>
							{t('knowledge.error', { detail: stateDetail ?? '' })}
						</div>
					)}
					<div ref={bottomRef} />
					<div style={{ flexShrink: 0, height: spacerH }} />
				</div>

				{busy && (
					<div style={{ padding: '6px 20px 0', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--foreground)', overflow: 'hidden' }}>
						<span className="chat-dot-pulse" />
						{chatState === 'answering' ? (
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
								{t('knowledge.doing.answering')}
							</span>
						) : liveStep ? (
							<>
								<ToolIcon tool={liveStep.tool} />
								<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
									{t(`knowledge.doing.${liveStep.tool}`, { q: liveStep.label })}
								</span>
							</>
						) : (
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
								{t('knowledge.doing.searching')}
							</span>
						)}
					</div>
				)}

				<div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--separator)', position: 'relative' }}>
					{mention && mentionCandidates.length > 0 && (
						<div style={mentionPopupStyle}>
							{mentionCandidates.map((c, i) => (
								<div
									key={c.token + i}
									onMouseDown={(e) => { e.preventDefault(); applyMention(c) }}
									onMouseEnter={() => setMentionIndex(i)}
									style={{
										display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 10px',
										borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
										background: i === mentionIndex ? 'var(--surface-2)' : 'transparent',
									}}
								>
									<span style={{ color: 'var(--foreground)', fontWeight: 600, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
										{c.label}
									</span>
									<span style={{ color: 'var(--muted)', fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.sub}</span>
								</div>
							))}
						</div>
					)}
					<div style={{ display: 'flex', gap: 8 }}>
						<div style={composerBoxStyle}>
							<div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 4px 0' }}>
								<select
									value={activeMode ?? 'qa'}
									onChange={(e) => {
										const v = e.target.value
										const nextMode = v === 'qa' ? null : v
										setActiveMode(nextMode)
										// Replace the input when it's empty OR still holds an
										// unedited task template (so switching tasks overwrites the
										// previous template), but never clobber text the user typed.
										const isAutoTemplate = TASK_MODES.some((m) => input === t('knowledge.template.' + m))
										if (nextMode && (input.trim() === '' || isAutoTemplate)) setInput(t('knowledge.template.' + nextMode))
										else if (!nextMode && isAutoTemplate) setInput('')
									}}
									style={taskSelectStyle}
								>
									<option value="qa">{t('knowledge.mode.qa')}</option>
									{TASK_MODES.map((id) => (
										<option key={id} value={id}>{t('knowledge.mode.' + id)}</option>
									))}
								</select>
								<select
									value={scopeCollectionId ?? ''}
									onChange={(e) => setScopeCollectionId(e.target.value ? Number(e.target.value) : null)}
									title={t('knowledge.scopeSelectTitle')}
									style={scopeSelectStyle}
								>
									<option value="">{t('knowledge.scopeWholeLibrary')}</option>
									<option value={IMPORTANT_SCOPE}>{t('knowledge.scopeImportant')}</option>
									{collections.map((c) => (
										<option key={c.id} value={c.id}>{c.name}</option>
									))}
								</select>
							</div>
							{editing !== null && (
								<div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 8px 0', fontSize: 11.5, color: 'var(--muted)' }}>
									<span>{t('knowledge.editingNote')}</span>
									<button onClick={cancelEdit} style={{ border: 'none', background: 'none', padding: 0, color: 'var(--primary)', cursor: 'pointer', fontSize: 11.5 }}>{t('knowledge.cancel')}</button>
								</div>
							)}
							{pendingRefs.length > 0 && (
								<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 8px 0' }}>
									{pendingRefs.map((p, i) => (
										<Chip key={i} icon={<PaperclipIcon />} label={p.label} maxWidth={260}
											onRemove={() => setPendingRefs((prev) => prev.filter((_, j) => j !== i))} />
									))}
								</div>
							)}
							<textarea
							ref={textareaRef}
							value={input}
							onChange={onInputChange}
							onKeyDown={(e) => {
								if (mention && mentionCandidates.length > 0) {
									if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionCandidates.length); return }
									if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return }
									if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionCandidates[mentionIndex]); return }
									if (e.key === 'Escape') { e.preventDefault(); setMention(null); return }
								}
								if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
							}}
							placeholder={t('knowledge.inputPlaceholder')}
							disabled={chatConfigured === false}
							rows={1}
							style={inputStyle}
						/>
						</div>
						{busy ? (
							<button onClick={() => void stop()} style={stopBtnStyle}>{t('knowledge.stop')}</button>
						) : (
							<button onClick={() => void send()} disabled={!input.trim() || chatConfigured === false} style={sendBtnStyle}>
								{editing !== null ? t('knowledge.update') : t('knowledge.send')}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	)
}

const newConvBtnStyle: React.CSSProperties = {
	height: 34, borderRadius: 8, border: '1px solid var(--border)',
	background: 'var(--surface)', color: 'var(--foreground)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
}

const backBtnStyle: React.CSSProperties = {
	display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px',
	borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground-2)', fontSize: 12, fontWeight: 500, flexShrink: 0,
}

const inputStyle: React.CSSProperties = {
	flex: 1, minHeight: 68, maxHeight: 200, padding: '10px 12px',
	border: 'none', background: 'transparent', color: 'var(--foreground)',
	fontSize: 13, resize: 'none', fontFamily: 'inherit', outline: 'none',
}

const composerBoxStyle: React.CSSProperties = {
	display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0,
	border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)',
}

const taskSelectStyle: React.CSSProperties = {
	border: 'none', background: 'transparent', outline: 'none', fontSize: 12,
	padding: '2px 4px', color: 'var(--foreground-2)', cursor: 'pointer', flexShrink: 0,
}

const scopeSelectStyle: React.CSSProperties = {
	border: 'none', background: 'transparent', outline: 'none', fontSize: 12,
	padding: '2px 4px', color: 'var(--foreground-2)', cursor: 'pointer',
	maxWidth: 160, overflow: 'hidden',
	WebkitMaskImage: 'linear-gradient(to right, #000 72%, transparent)',
	maskImage: 'linear-gradient(to right, #000 72%, transparent)',
}

const mentionPopupStyle: React.CSSProperties = {
	position: 'absolute', left: 16, right: 16, bottom: '100%', marginBottom: 6,
	maxHeight: 220, overflowY: 'auto', padding: 4, borderRadius: 10,
	border: '1px solid var(--border)', background: 'var(--surface)', boxShadow: 'var(--shadow-md, 0 4px 16px rgba(0,0,0,0.15))',
	zIndex: 20,
}

const sendBtnStyle: React.CSSProperties = {
	height: 38, padding: '0 18px', borderRadius: 10, border: 'none',
	background: 'var(--primary)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}

const stopBtnStyle: React.CSSProperties = {
	height: 38, padding: '0 18px', borderRadius: 10, border: '1px solid var(--border)',
	background: 'var(--surface)', color: 'var(--danger, #dc2626)', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}

const notConfiguredBanner: React.CSSProperties = {
	padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2)',
	border: '1px solid var(--border)', color: 'var(--foreground-2)', fontSize: 12.5,
}
