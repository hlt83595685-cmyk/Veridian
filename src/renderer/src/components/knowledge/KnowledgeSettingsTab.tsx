import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Preset {
	id: string
	label: string
	baseURL: string
	model: string
}

const CHAT_PRESETS: Preset[] = [
	{ id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
	{ id: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
	{ id: 'moonshot', label: 'Kimi (Moonshot)', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
	{ id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
]

const EMBEDDING_PRESETS: Preset[] = [
	{ id: 'zhipu', label: '智谱 embedding-3', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'embedding-3' },
	{ id: 'openai', label: 'OpenAI text-embedding-3-small', baseURL: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
	{ id: 'siliconflow', label: 'SiliconFlow BGE-M3', baseURL: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
]

interface ProviderState {
	preset: string
	baseURL: string
	model: string
	apiKey: string
}

const EMPTY: ProviderState = { preset: '', baseURL: '', model: '', apiKey: '' }

export function KnowledgeSettingsTab(): JSX.Element {
	const { t } = useTranslation('common')
	const [storagePath, setStoragePath] = useState('')
	const [chat, setChat] = useState<ProviderState>(EMPTY)
	const [embedding, setEmbedding] = useState<ProviderState>(EMPTY)
	const [reuseChatKey, setReuseChatKey] = useState(false)
	const [testState, setTestState] = useState<{ which: 'chat' | 'embedding' | null; result: string | null | 'pending' }>({ which: null, result: null })
	const [status, setStatus] = useState<{
		items: number; indexedItems: number; pendingChunks: number; totalChunks: number
		embeddingModel: string | null; vecAvailable: boolean
	} | null>(null)
	const [rebuilding, setRebuilding] = useState(false)

	useEffect(() => {
		void loadAll()
	}, [])

	async function loadAll(): Promise<void> {
		const [sp, cPreset, cBase, cModel, cKey, ePreset, eBase, eModel, eKey, reuse, st] = await Promise.all([
			window.veridian.settings.get('knowledge.storagePath'),
			window.veridian.settings.get('knowledge.chat.preset'),
			window.veridian.settings.get('knowledge.chat.baseURL'),
			window.veridian.settings.get('knowledge.chat.model'),
			window.veridian.settings.get('knowledge.chat.apiKey'),
			window.veridian.settings.get('knowledge.embedding.preset'),
			window.veridian.settings.get('knowledge.embedding.baseURL'),
			window.veridian.settings.get('knowledge.embedding.model'),
			window.veridian.settings.get('knowledge.embedding.apiKey'),
			window.veridian.settings.get('knowledge.embedding.reuseChatKey'),
			window.veridian.knowledge.indexStatus().catch(() => null),
		])
		setStoragePath(typeof sp === 'string' ? sp : '')
		setChat({
			preset: typeof cPreset === 'string' ? cPreset : '',
			baseURL: typeof cBase === 'string' ? cBase : '',
			model: typeof cModel === 'string' ? cModel : '',
			apiKey: typeof cKey === 'string' ? cKey : '',
		})
		setEmbedding({
			preset: typeof ePreset === 'string' ? ePreset : '',
			baseURL: typeof eBase === 'string' ? eBase : '',
			model: typeof eModel === 'string' ? eModel : '',
			apiKey: typeof eKey === 'string' ? eKey : '',
		})
		setReuseChatKey(reuse === true)
		setStatus(st)
	}

	const browseStorage = async (): Promise<void> => {
		const picked = await window.veridian.knowledge.pickStoragePath()
		if (picked) setStoragePath(picked)
	}

	function applyPreset(kind: 'chat' | 'embedding', presetId: string): void {
		const list = kind === 'chat' ? CHAT_PRESETS : EMBEDDING_PRESETS
		const preset = list.find((p) => p.id === presetId)
		const next: ProviderState = preset
			? { preset: presetId, baseURL: preset.baseURL, model: preset.model, apiKey: kind === 'chat' ? chat.apiKey : embedding.apiKey }
			: { ...(kind === 'chat' ? chat : embedding), preset: presetId }
		if (kind === 'chat') setChat(next)
		else setEmbedding(next)
	}

	async function saveField(key: string, value: string | boolean): Promise<void> {
		await window.veridian.settings.set(key, value)
	}

	async function test(which: 'chat' | 'embedding'): Promise<void> {
		setTestState({ which, result: 'pending' })
		const result = await window.veridian.knowledge.testProvider(which)
		setTestState({ which, result })
	}

	async function rebuild(): Promise<void> {
		if (!window.confirm(t('settings.knowledge.rebuildConfirm'))) return
		setRebuilding(true)
		try {
			await window.veridian.knowledge.rebuildIndex()
			const st = await window.veridian.knowledge.indexStatus()
			setStatus(st)
		} finally {
			setRebuilding(false)
		}
	}

	const modelChanged = status?.embeddingModel && embedding.model && status.embeddingModel !== embedding.model

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
			<Section label={t('settings.knowledge.title')}>
				<div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
					{t('settings.knowledge.storageDesc')}
				</div>
				<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
					<div style={{
						flex: 1, padding: '7px 10px', borderRadius: 8,
						border: '1px solid var(--border)', background: 'var(--muted-bg)',
						fontSize: 12, color: storagePath ? 'var(--foreground)' : 'var(--muted)',
						overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
					}}>
						{storagePath || t('settings.knowledge.storagePlaceholder')}
					</div>
					<button onClick={browseStorage} style={primaryBtnStyle}>
						{t('settings.knowledge.browse')}
					</button>
				</div>
			</Section>

			<ProviderSection
				title={t('settings.knowledge.chatLabel')}
				desc={t('settings.knowledge.chatDesc')}
				presets={CHAT_PRESETS}
				state={chat}
				onPreset={(id) => { applyPreset('chat', id); void saveField('knowledge.chat.preset', id) }}
				onBaseURL={(v) => { setChat((s) => ({ ...s, baseURL: v })); void saveField('knowledge.chat.baseURL', v) }}
				onModel={(v) => { setChat((s) => ({ ...s, model: v })); void saveField('knowledge.chat.model', v) }}
				onApiKey={(v) => { setChat((s) => ({ ...s, apiKey: v })); void saveField('knowledge.chat.apiKey', v) }}
				onTest={() => void test('chat')}
				testState={testState.which === 'chat' ? testState.result : null}
				t={t}
			/>

			<ProviderSection
				title={t('settings.knowledge.embeddingLabel')}
				desc={t('settings.knowledge.embeddingDesc')}
				presets={EMBEDDING_PRESETS}
				state={embedding}
				onPreset={(id) => { applyPreset('embedding', id); void saveField('knowledge.embedding.preset', id) }}
				onBaseURL={(v) => { setEmbedding((s) => ({ ...s, baseURL: v })); void saveField('knowledge.embedding.baseURL', v) }}
				onModel={(v) => { setEmbedding((s) => ({ ...s, model: v })); void saveField('knowledge.embedding.model', v) }}
				onApiKey={(v) => { setEmbedding((s) => ({ ...s, apiKey: v })); void saveField('knowledge.embedding.apiKey', v) }}
				onTest={() => void test('embedding')}
				testState={testState.which === 'embedding' ? testState.result : null}
				disabled={reuseChatKey}
				t={t}
				extra={
					<label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--foreground-2)', marginTop: 8 }}>
						<input
							type="checkbox"
							checked={reuseChatKey}
							onChange={(e) => {
								setReuseChatKey(e.target.checked)
								void saveField('knowledge.embedding.reuseChatKey', e.target.checked)
							}}
						/>
						{t('settings.knowledge.reuseChatKey')}
					</label>
				}
			/>

			<Section label={t('settings.knowledge.indexStatus')}>
				{status && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--foreground-2)' }}>
						<div>{t('settings.knowledge.indexedOf', { indexed: status.indexedItems, total: status.items })}</div>
						{status.pendingChunks > 0 && (
							<div style={{ color: 'var(--muted)' }}>
								{t('settings.knowledge.pendingChunks', { count: status.pendingChunks })}
							</div>
						)}
						{!status.vecAvailable && (
							<div style={{ color: 'var(--warning, #d97706)' }}>{t('settings.knowledge.noVecWarning')}</div>
						)}
						{modelChanged && (
							<div style={{ color: 'var(--warning, #d97706)' }}>{t('settings.knowledge.modelChangedHint')}</div>
						)}
					</div>
				)}
				<button onClick={() => void rebuild()} disabled={rebuilding} style={{ ...secondaryBtnStyle, marginTop: 10 }}>
					{rebuilding ? t('settings.knowledge.rebuilding') : t('settings.knowledge.rebuildBtn')}
				</button>
			</Section>
		</div>
	)
}

function ProviderSection(props: {
	title: string
	desc: string
	presets: Preset[]
	state: ProviderState
	onPreset: (id: string) => void
	onBaseURL: (v: string) => void
	onModel: (v: string) => void
	onApiKey: (v: string) => void
	onTest: () => void
	testState: string | null
	disabled?: boolean
	extra?: React.ReactNode
	t: (key: string, opts?: Record<string, unknown>) => string
}): JSX.Element {
	const { title, desc, presets, state, onPreset, onBaseURL, onModel, onApiKey, onTest, testState, disabled, extra, t } = props
	return (
		<Section label={title}>
			<div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>{desc}</div>
			<div style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
				<Field label={t('settings.knowledge.preset')}>
					<select value={state.preset} onChange={(e) => onPreset(e.target.value)} style={inputStyle}>
						<option value="">{t('settings.knowledge.presetCustom')}</option>
						{presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
					</select>
				</Field>
				<Field label={t('settings.knowledge.baseUrl')}>
					<input value={state.baseURL} onChange={(e) => onBaseURL(e.target.value)} style={inputStyle} placeholder="https://api.example.com/v1" />
				</Field>
				<Field label={t('settings.knowledge.model')}>
					<input value={state.model} onChange={(e) => onModel(e.target.value)} style={inputStyle} />
				</Field>
				<Field label={t('settings.knowledge.apiKey')}>
					<input
						type="password"
						value={state.apiKey}
						onChange={(e) => onApiKey(e.target.value)}
						style={inputStyle}
						placeholder={t('settings.knowledge.apiKeyPlaceholder')}
					/>
				</Field>
				{extra}
				<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
					<button onClick={onTest} disabled={testState === 'pending'} style={secondaryBtnStyle}>
						{testState === 'pending' ? t('settings.knowledge.testing') : t('settings.knowledge.testBtn')}
					</button>
					{testState && testState !== 'pending' && (
						<span style={{ fontSize: 12, color: testState === null ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)' }}>
							{testState === null ? t('settings.knowledge.testOk') : t('settings.knowledge.testFail', { detail: testState })}
						</span>
					)}
				</div>
			</div>
		</Section>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
			<div style={{ width: 90, fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{label}</div>
			<div style={{ flex: 1 }}>{children}</div>
		</div>
	)
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
			<div style={{
				fontSize: 11, fontWeight: 600, color: 'var(--muted)',
				textTransform: 'uppercase', letterSpacing: '0.06em',
			}}>
				{label}
			</div>
			<div style={{
				padding: '12px 14px', borderRadius: 10,
				background: 'var(--surface-2)', border: '1px solid var(--border)',
			}}>
				{children}
			</div>
		</div>
	)
}

const inputStyle: React.CSSProperties = {
	width: '100%', height: 30, padding: '0 10px', borderRadius: 8,
	border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground)', fontSize: 12,
}

const primaryBtnStyle: React.CSSProperties = {
	height: 32, padding: '0 16px', borderRadius: 8,
	border: 'none', background: 'var(--primary)',
	color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}

const secondaryBtnStyle: React.CSSProperties = {
	height: 32, padding: '0 16px', borderRadius: 8,
	border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground-2)', fontSize: 13, cursor: 'pointer',
}
