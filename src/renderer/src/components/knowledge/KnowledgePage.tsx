import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { DomainEvent } from '../../../../shared/events'
import { ChatMessageView, type CitationInfo } from './ChatMessage'

interface ConversationRow { id: number; title: string; created_at: number }
interface DisplayMessage {
	id: number | 'streaming'
	role: 'user' | 'assistant'
	content: string
	citations: CitationInfo[]
}

type ChatState = 'idle' | 'searching' | 'answering' | 'error'

export function KnowledgePage(): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const { workspaces, activeWorkspaceId } = useWorkspaceStore()
	const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)

	const [conversations, setConversations] = useState<ConversationRow[]>([])
	const [conversationId, setConversationId] = useState<number | null>(null)
	const [messages, setMessages] = useState<DisplayMessage[]>([])
	const [input, setInput] = useState('')
	const [chatState, setChatState] = useState<ChatState>('idle')
	const [stateDetail, setStateDetail] = useState<string | null>(null)
	const [chatConfigured, setChatConfigured] = useState<boolean | null>(null)
	const streamingRef = useRef('')
	const bottomRef = useRef<HTMLDivElement>(null)
	const activeConvIdRef = useRef<number | null>(null)
	activeConvIdRef.current = conversationId
	// Synchronous re-entrancy guard for send(). chatState alone isn't safe here:
	// its setter is async/batched, so two send() calls within the same tick
	// (IME Enter-to-confirm firing right before Enter-to-submit, a fast
	// double-click) both read the pre-update state and both pass the check --
	// two concurrent streams then interleave their deltas into one bubble,
	// which is exactly the "duplicated while streaming, correct once saved"
	// symptom this fixes.
	const busyRef = useRef(false)

	useEffect(() => {
		void refreshConversations()
		Promise.all([
			window.veridian.settings.get('knowledge.chat.baseURL'),
			window.veridian.settings.get('knowledge.chat.model'),
			window.veridian.settings.get('knowledge.chat.apiKey'),
		]).then(([b, m, k]) => setChatConfigured(!!b && !!m && !!k))
	}, [])

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
			} else if (e.type === 'knowledge.chatState') {
				if (e.conversationId !== activeConvIdRef.current) return
				setStateDetail(e.detail ?? null)
				if (e.state === 'done') {
					setChatState('idle')
					streamingRef.current = ''
					busyRef.current = false
					void refreshMessages(e.conversationId)
					void refreshConversations()
				} else if (e.state === 'error') {
					setChatState('error')
					busyRef.current = false
				} else {
					setChatState(e.state)
				}
			}
		}
		window.veridian.onDomainEvent(onEvent)
		return () => window.veridian.offDomainEvent(onEvent)
	}, [])

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages])

	async function refreshConversations(): Promise<void> {
		const list = await window.veridian.knowledge.listConversations()
		setConversations(list)
	}

	async function refreshMessages(id: number): Promise<void> {
		const rows = await window.veridian.knowledge.getMessages(id)
		setMessages(rows.map((r) => ({
			id: r.id, role: r.role as 'user' | 'assistant', content: r.content,
			citations: JSON.parse(r.citations || '[]'),
		})))
	}

	function startNewConversation(): void {
		setConversationId(null)
		setMessages([])
		setChatState('idle')
	}

	async function openConversation(id: number): Promise<void> {
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
		setInput('')
		streamingRef.current = ''
		setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: q, citations: [] }])
		setChatState('searching')
		const id = await window.veridian.knowledge.ask(q, conversationId)
		setConversationId(id)
	}

	async function stop(): Promise<void> {
		if (conversationId !== null) await window.veridian.knowledge.stop(conversationId)
	}

	const busy = chatState === 'searching' || chatState === 'answering'
	const scopeLabel = activeWs?.name ?? t('knowledge.personalLibrary')

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

				<div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
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
						<ChatMessageView
							key={m.id}
							role={m.role}
							content={m.content}
							citations={m.citations}
							streaming={m.id === 'streaming'}
						/>
					))}
					{busy && (
						<div style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
							<span className="chat-dot-pulse" />
							{chatState === 'searching'
								? (stateDetail ? t('knowledge.searchingTool', { query: stateDetail }) : t('knowledge.searching'))
								: t('knowledge.answering')}
						</div>
					)}
					{chatState === 'error' && (
						<div style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--danger, #dc2626)' }}>
							{t('knowledge.error', { detail: stateDetail ?? '' })}
						</div>
					)}
					<div ref={bottomRef} />
				</div>

				<div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--separator)', display: 'flex', gap: 8 }}>
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
						}}
						placeholder={t('knowledge.inputPlaceholder')}
						disabled={chatConfigured === false}
						rows={1}
						style={inputStyle}
					/>
					{busy ? (
						<button onClick={() => void stop()} style={stopBtnStyle}>{t('knowledge.stop')}</button>
					) : (
						<button onClick={() => void send()} disabled={!input.trim() || chatConfigured === false} style={sendBtnStyle}>
							{t('knowledge.send')}
						</button>
					)}
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
	flex: 1, minHeight: 38, maxHeight: 120, padding: '9px 12px', borderRadius: 10,
	border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--foreground)',
	fontSize: 13, resize: 'none', fontFamily: 'inherit',
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
