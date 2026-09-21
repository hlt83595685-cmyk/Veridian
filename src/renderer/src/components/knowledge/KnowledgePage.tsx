import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useAssistantStore } from '../../stores/assistantStore'
import { HorseBadge } from './HorseBadge'
import type { Horse } from '../../../../shared/types'
import type { DomainEvent } from '../../../../shared/events'
import type {
	ApprovalDecision, ApprovalRequest, AttachmentStatus, ContextReport, TraceEntry, TurnTrace,
} from '../../../../shared/types'
import { ApprovalCard } from './ApprovalCard'
import { ContextMeter } from './ContextMeter'
import { ChatMessageView, type CitationInfo } from './ChatMessage'
import { ProcessTrace } from './ProcessTrace'
import { parseTrace } from './parseTrace'
import { Composer, type PendingRef } from './Composer'

interface ConversationRow {
	id: number
	title: string
	created_at: number
	scope_collection_id: number | null
	/** 这段对话归哪匹马跑。老对话是 null，解析时退回默认马。 */
	horse_id: string | null
}
interface DisplayMessage {
	id: number | 'streaming'
	role: 'user' | 'assistant'
	content: string
	citations: CitationInfo[]
	/** 这一轮的执行轨迹（阶段说明 + 工具调用）与耗时。 */
	trace?: TurnTrace
	context?: ContextReport | null
	refs?: { type: string; itemKey?: string; path?: string; name?: string; label: string; status?: AttachmentStatus }[]
}

type ChatState = 'idle' | 'searching' | 'answering' | 'error'

export function KnowledgePage(): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const { workspaces, activeWorkspaceId } = useWorkspaceStore()
	const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)

	const [conversations, setConversations] = useState<ConversationRow[]>([])
	// 马厩，用来把 conversation.horse_id 解析成名字，以及给新对话做选择。
	const [horses, setHorses] = useState<Horse[]>([])
	// 新对话还没建，先记住选了谁；建好之后就以库里那条为准。
	const [pendingHorseId, setPendingHorseId] = useState<string | null>(null)

	useEffect(() => {
		void window.veridian.horses.list().then((list) => {
			setHorses(list)
			// 新对话默认落在默认马上，和主进程建对话时的兜底一致。
			setPendingHorseId((cur) => cur ?? list.find((h) => h.isDefault)?.id ?? list[0]?.id ?? null)
		}).catch(() => setHorses([]))
	}, [])
	const [conversationId, setConversationId] = useState<number | null>(null)
	const [messages, setMessages] = useState<DisplayMessage[]>([])
	const [input, setInput] = useState('')
	const [chatState, setChatState] = useState<ChatState>('idle')
	const [stateDetail, setStateDetail] = useState<string | null>(null)
	// 进行中那一轮的执行轨迹：模型的阶段说明 + 工具调用，按发生顺序。回合落库后
	// 从数据库连着助手消息一起回来，所以这里清空。
	const [liveTrace, setLiveTrace] = useState<TraceEntry[]>([])
	// 回合开始的时刻，用来实时显示「用时」。落库后以持久化的耗时为准。
	const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
	// Budget accounting for the turn in flight; replaced by the persisted copy
	// on the assistant message once it lands.
	const [liveContext, setLiveContext] = useState<ContextReport | null>(null)
	// Approval requests for the turn in flight. Settled ones stay on screen with
	// their outcome -- a decision you made is part of the record, not a dialog
	// that vanishes.
	const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
	const [decisions, setDecisions] = useState<Record<string, ApprovalDecision>>({})
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

	// `pendingRefs` is the source of truth sent to ask(); the composer's own text
	// is just what the user sees and can freely edit.
	const [pendingRefs, setPendingRefs] = useState<PendingRef[]>([])
	const [editing, setEditing] = useState<number | null>(null)
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)

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
			} else if (e.type === 'knowledge.approval') {
				if (e.request.conversationId !== activeConvIdRef.current) return
				setApprovals((prev) => (prev.some((r) => r.id === e.request.id) ? prev : [...prev, e.request]))
			} else if (e.type === 'knowledge.approvalResolved') {
				setDecisions((prev) => ({ ...prev, [e.id]: e.decision }))
			} else if (e.type === 'knowledge.context') {
				if (e.conversationId !== activeConvIdRef.current) return
				setLiveContext(e.report)
			} else if (e.type === 'knowledge.traceNote') {
				// 模型调工具前说的那段话。过去跟着 chatReset 一起被丢掉，而它恰恰是
				// 整条轨迹里最可读的部分。
				if (e.conversationId !== activeConvIdRef.current) return
				setLiveTrace((prev) => [...prev, { kind: 'note', text: e.text, round: e.round }])
			} else if (e.type === 'knowledge.toolCall') {
				if (e.conversationId !== activeConvIdRef.current) return
				setLiveTrace((prev) => {
					// 同一个 id 会来两次：先「进行中」，跑完再来一条带结果的。就地更新。
					const i = prev.findIndex((x) => x.kind === 'tool' && x.call.id === e.call.id)
					if (i === -1) return [...prev, { kind: 'tool', call: e.call }]
					const next = [...prev]
					next[i] = { kind: 'tool', call: e.call }
					return next
				})
			} else if (e.type === 'knowledge.attachments') {
				// Attach to the optimistic user bubble that's already on screen, so
				// the chips fill in mid-turn rather than only after the reload that
				// follows chatState:'done'.
				if (e.conversationId !== activeConvIdRef.current) return
				const byKey = new Map(e.attachments.map((a) => [a.key, a]))
				setMessages((prev) => {
					const idx = prev.map((m) => m.role).lastIndexOf('user')
					if (idx === -1) return prev
					const target = prev[idx]
					const next = [...prev]
					next[idx] = {
						...target,
						refs: (target.refs ?? []).map((r) => {
							const status = byKey.get(r.itemKey ?? r.path ?? '')
							return status ? { ...r, status } : r
						}),
					}
					return next
				})
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
					// The persisted copy on the assistant message takes over here.
					setLiveTrace([])
					setLiveContext(null)
					setApprovals([])
					setDecisions({})
					void refreshMessages(e.conversationId)
				} else if (e.state === 'error') {
					setChatState('error')
					busyRef.current = false
					// 故意不清 liveTrace：失败的回合不会写助手消息，已经跑过的工具
					// assistant message, so nothing persists the tools it already
					// ran. Their side effects happened -- hiding them would be a lie.
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
				setLiveTrace([])
				setLiveContext(null)
				setApprovals([])
				setDecisions({})
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
	}, [messages, chatState])

	async function refreshConversations(): Promise<void> {
		const list = await window.veridian.knowledge.listConversations()
		setConversations(list)
	}

	async function refreshMessages(id: number): Promise<void> {
		const rows = await window.veridian.knowledge.getMessages(id)
		setMessages(rows.map((r) => ({
			id: r.id, role: r.role as 'user' | 'assistant', content: r.content,
			citations: JSON.parse(r.citations || '[]'),
			// steps 列存过三种形状（RetrievalStep[] / ToolCallRecord[] / TurnTrace），
			// parseTrace 统一归一，不做数据迁移。
			trace: parseTrace(r.steps),
			context: r.context ? (JSON.parse(r.context) as ContextReport) : null,
			refs: JSON.parse(r.refs || '[]'),
		})))
	}

	function startNewConversation(): void {
		setConversationId(null)
		setMessages([])
		setChatState('idle')
		streamingRef.current = ''
		setLiveTrace([])
		setLiveContext(null)
		setApprovals([])
		setDecisions({})
		setStateDetail(null)
		busyRef.current = false
		setPendingRefs([])
		pinTopRef.current = false
		setSpacerH(0)
	}

	async function openConversation(id: number): Promise<void> {
		// Reset all transient streaming state so the previous conversation's in-flight
		// status / thinking / partial bubble never bleeds into this one. If the target
		// itself is the one still generating, keep it "busy" and let its live events
		// repaint it.
		streamingRef.current = ''
		setLiveTrace([])
		setLiveContext(null)
		setApprovals([])
		setDecisions({})
		setStateDetail(null)
		pinTopRef.current = false
		setSpacerH(0)
		const running = id === runningConvIdRef.current
		busyRef.current = running
		setChatState(running ? 'searching' : 'idle')
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
		setTurnStartedAt(Date.now())
		const refs = pendingRefs.map((p) => p.ref)
		const sentRefs = pendingRefs.map((p) => ({ ...p.ref, label: p.label }))
		const wasEditing = editing !== null
		setInput('')
		setPendingRefs([])
		setEditing(null)
		streamingRef.current = ''
		setLiveTrace([])
		setLiveContext(null)
		setApprovals([])
		setDecisions({})
		// Subsequent turns pin the new question to the top of the chat; the spacer
		// provides the room needed to scroll it up. The very first turn stays natural.
		const subsequentTurn = messages.length > 0
		pinTopRef.current = subsequentTurn
		if (subsequentTurn) setSpacerH(chatScrollRef.current?.clientHeight ?? 0)
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [], refs: sentRefs }])
		setChatState('searching')
		if (wasEditing && conversationId !== null) {
			runningConvIdRef.current = conversationId
			await window.veridian.knowledge.editResend(conversationId, q, refs.length ? refs : undefined)
		} else {
			if (conversationId !== null) runningConvIdRef.current = conversationId
			const id = await window.veridian.knowledge.ask(
				q, conversationId, refs.length ? refs : undefined,
				// 只有新建时才用得上；已有对话的马是建的时候钉死的。
				conversationId === null ? pendingHorseId ?? undefined : undefined,
			)
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
		setTurnStartedAt(Date.now())
		runningConvIdRef.current = conversationId
		streamingRef.current = ''
		setLiveTrace([])
		setLiveContext(null)
		setApprovals([])
		setDecisions({})
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

	// Mirror the turn state onto the toolbar's horse, so the user can leave this
	// page mid-answer and still see that something is running.
	useEffect(() => {
		useAssistantStore
			.getState()
			.setStatus(busy ? 'running' : chatState === 'error' ? 'error' : 'idle')
	}, [busy, chatState])

	const scopeLabel = activeWs?.name ?? t('knowledge.personalLibrary')
	const lastId = messages[messages.length - 1]?.id
	const lastUserId = [...messages].reverse().find((m) => m.role === 'user')?.id

	// 这段对话归哪匹马跑。和主进程 horseFor() 同样的三层退让：绑定的那匹 →
	// 那匹被删了就退回默认 → 一匹都没有就不显示。两边不一致会让界面撒谎。
	const boundId = conversationId === null
		? pendingHorseId
		: conversations.find((c) => c.id === conversationId)?.horse_id ?? null
	const boundHorse = horses.find((h) => h.id === boundId)
		?? horses.find((h) => h.isDefault)
		?? horses[0]
		?? null

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
					<span style={{ flex: 1 }} />
					{/* 这段对话归哪匹马跑。新对话可以选，已有对话只读——绑定是建对话
					    时钉死的，改了会让「这个回答当时是谁给的」对不上。 */}
					<HorseBadge
						horses={horses}
						horse={boundHorse}
						editable={conversationId === null}
						onPick={setPendingHorseId}
					/>
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
							{/* Tools ran before the answer was written, so the cards sit
							    above the bubble they produced. */}
							{/* 这一轮的执行轨迹，收在答案上方。历史消息默认是收起的，
							    点一下重新展开。 */}
							{m.trace && m.trace.entries.length > 0 && (
								<ProcessTrace
									entries={m.trace.entries}
									running={false}
									elapsedMs={m.trace.elapsedMs}
								/>
							)}
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
							{/* Budget for the assembly that produced this answer, under
							    the bubble it produced. */}
							{m.context && <ContextMeter report={m.context} />}
						</Fragment>
					))}
					{/* 进行中那一轮：轨迹在运行时自动展开，结束后自动收起。落库之后
					    上面那份持久化的会顶替它。 */}
					{(busy || liveTrace.length > 0) && (
						<ProcessTrace
							entries={liveTrace}
							running={busy}
							elapsedMs={turnStartedAt ? Date.now() - turnStartedAt : 0}
							statusLabel={t(chatState === 'answering' ? 'knowledge.doing.answering' : 'knowledge.doing.searching')}
						/>
					)}
					{liveContext && <ContextMeter report={liveContext} />}
					{approvals.map((r) => (
						<ApprovalCard
							key={r.id}
							request={r}
							decision={decisions[r.id]}
							onDecide={(d) => {
								setDecisions((prev) => ({ ...prev, [r.id]: d }))
								void window.veridian.knowledge.resolveApproval(r.id, d)
							}}
						/>
					))}
					{chatState === 'error' && (
						<div style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--danger, #dc2626)' }}>
							{t('knowledge.error', { detail: stateDetail ?? '' })}
						</div>
					)}
					<div ref={bottomRef} />
					<div style={{ flexShrink: 0, height: spacerH }} />
				</div>

				{/* 原来这里有一条固定在输入框上方的状态行。它现在和执行轨迹的摘要行
				    说的是同一件事，两处一起亮着只是重复——状态跟着轨迹走，留在
				    对话流里，位置和它描述的过程对得上。 */}

				<Composer
					value={input}
					onChange={setInput}
					pendingRefs={pendingRefs}
					onAddRef={(r) => setPendingRefs((prev) => [...prev, r])}
					onRemoveRef={(i) => setPendingRefs((prev) => prev.filter((_, j) => j !== i))}
					busy={busy}
					disabled={chatConfigured === false}
					editing={editing !== null}
					onCancelEdit={cancelEdit}
					onSend={() => void send()}
					onStop={() => void stop()}
					focusRef={textareaRef}
				/>
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

const notConfiguredBanner: React.CSSProperties = {
	padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2)',
	border: '1px solid var(--border)', color: 'var(--foreground-2)', fontSize: 12.5,
}
