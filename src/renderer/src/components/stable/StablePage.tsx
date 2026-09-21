import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { Pipeline } from './pipeline/Pipeline'
import { deriveStations, type StationId } from './pipeline/stations'
import { Pasture, type PastureHorse } from './pasture/Pasture'
import { discoverSkins, loadSkin, type LoadedSkin, type SkinSpec } from './pasture/skins'
import { useMotionStore } from '../../stores/motionStore'
import { HorseRoster } from './HorseRoster'
import { EquipPanel } from './EquipPanel'
import type { Horse, ToolInfo, ToolKind } from '../../../../shared/types'

// The stable: where the horses live. A horse is an agent -- you equip it by
// fitting parts to its body rather than filling in a settings form. Today the
// stable holds exactly one horse, so the page opens straight onto it; the
// multi-horse roster (and agents supervising each other) is what the name is
// reserving room for.
//
// Two slots are wired to configuration that already exists (chat model,
// embedding model); the rest are empty sockets waiting on the plugin
// container, and say so rather than pretending.

/** Settings keys backing the slots that are already real. */
const MODEL_KEYS = {
	model: {
		base: 'knowledge.chat.baseURL',
		model: 'knowledge.chat.model',
		key: 'knowledge.chat.apiKey',
	},
	retrieval: {
		base: 'knowledge.embedding.baseURL',
		model: 'knowledge.embedding.model',
		key: 'knowledge.embedding.apiKey',
	},
} as const

type Fitted = Partial<Record<'model' | 'retrieval', string>>


export function StablePage(): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const [selected, setSelected] = useState<StationId | null>(null)
	// The stable opens on the pasture; picking a horse walks you in to equip it.
	const [view, setView] = useState<'pasture' | 'equip'>('pasture')
	const [grazing, setGrazing] = useState<string | null>(null)
	// Appearance is per horse and picked by the user, so it is stored, not derived.
	const [roster, setRoster] = useState<Horse[]>([])
	const [skins, setSkins] = useState<Record<string, LoadedSkin>>({})
	const catalogue: SkinSpec[] = useMemo(() => discoverSkins(), [])
	const motion = useMotionStore((m) => m.enabled)
	const osReduce = useMotionStore((m) => m.osReduce)
	const setMotionPref = useMotionStore((m) => m.setPref)

	const reload = async (): Promise<Horse[]> => {
		const list = await window.veridian.horses.list()
		setRoster(list)
		return list
	}

	useEffect(() => {
		void reload().then((list) => {
			if (list.length > 0) setGrazing((g) => g ?? list.find((h) => h.isDefault)?.id ?? list[0].id)
		})
	}, [])

	// Load every sprite the roster actually references, once each. Sheets are
	// small and shared between horses wearing the same skin.
	useEffect(() => {
		const wanted = [...new Set(roster.map((h) => h.skin))].filter((id) => !skins[id])
		if (wanted.length === 0) return
		let live = true
		void Promise.all(
			wanted.map((id) => {
				const spec = catalogue.find((c) => c.id === id)
				return spec ? loadSkin(spec).catch(() => null) : Promise.resolve(null)
			}),
		).then((loaded) => {
			if (!live) return
			const next: Record<string, LoadedSkin> = {}
			loaded.forEach((s) => { if (s) next[s.spec.id] = s })
			if (Object.keys(next).length > 0) setSkins((prev) => ({ ...prev, ...next }))
		})
		return () => { live = false }
	}, [roster, catalogue, skins])
	const [fitted, setFitted] = useState<Fitted>({})
	// 工具池与已装技能数：链路图上「工具」和「技能」两站全靠它们推导。
	const [pool, setPool] = useState<ToolInfo[]>([])
	const [skillCount, setSkillCount] = useState(0)

	useEffect(() => {
		void (async () => {
			const next: Fitted = {}
			for (const [id, keys] of Object.entries(MODEL_KEYS) as Array<
				['model' | 'retrieval', (typeof MODEL_KEYS)['model']]
			>) {
				// settings.get is untyped (Promise<unknown>) -- these keys hold plain
				// strings, so coerce here rather than trusting the value's shape.
				const [base, model, apiKey] = (await Promise.all([
					window.veridian.settings.get(keys.base),
					window.veridian.settings.get(keys.model),
					window.veridian.settings.get(keys.key),
				])) as (string | null | undefined)[]
				if (base && model && apiKey) next[id] = model
			}
			setFitted(next)
		})()
	}, [])

	// 池子读的是实时注册表，所以每次进装配都重读——插件可能刚被挂上或卸掉。
	useEffect(() => {
		if (view !== 'equip') return
		void window.veridian.agentTools.list().then(setPool).catch(() => setPool([]))
		void window.veridian.skills.list().then((l) => setSkillCount(l.length)).catch(() => setSkillCount(0))
	}, [view])

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape' && selected) setSelected(null)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [selected])

	const grazingHorse = roster.find((h) => h.id === grazing) ?? null

	// Only horses whose sprite has finished loading can be drawn; the rest
	// appear a frame later rather than crashing the canvas.
	const horses: PastureHorse[] = useMemo(
		() =>
			roster
				.map((h) => ({ id: h.id, name: h.name, skin: skins[h.skin] }))
				.filter((h): h is PastureHorse => Boolean(h.skin)),
		[roster, skins],
	)

	return (
		<div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					padding: '0 16px',
					height: 46,
					flexShrink: 0,
					borderBottom: '1px solid var(--separator)',
				}}
			>
				<button onClick={() => (view === 'equip' ? setView('pasture') : setPage('library'))} style={backBtnStyle}>
					← {view === 'equip' ? t('stable.backToPasture') : t('stable.back')}
				</button>
				<span style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)' }}>
					{view === 'equip' ? (grazingHorse?.name ?? t('stable.title')) : t('stable.title')}
				</span>
				<span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 4 }}>
					{view === 'equip'
						? t(`stable.ceiling.${grazingHorse?.ceiling ?? 'read'}.label`)
						: t('stable.horses', { count: roster.length })}
				</span>
			</header>

			<div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, padding: 14 }}>
				{view === 'pasture' ? (
					<div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
						<Pasture
							horses={horses}
							selected={grazing}
							onSelect={setGrazing}
							onOpen={(id) => {
								setGrazing(id)
								setView('equip')
								setSelected(null)
							}}
						/>
						{/* Who lives here. Appearance and permission ceiling belong to the
						    horse, so they are edited out here where the horse lives -- not
						    buried inside the equipment screen. */}
						<HorseRoster
							horses={roster}
							selected={grazing}
							catalogue={catalogue}
							onSelect={setGrazing}
							onCreate={(name, skin, ceiling) => {
								void window.veridian.horses
									.create(name, skin, ceiling)
									.then((h) => reload().then(() => setGrazing(h.id)))
							}}
							onUpdate={(id, patch) => {
								void window.veridian.horses.update(id, patch).then(reload)
							}}
							onSetDefault={(id) => { void window.veridian.horses.setDefault(id).then(reload) }}
							onRemove={(id) => {
								void window.veridian.horses.remove(id).then(async () => {
									const list = await reload()
									if (!list.some((h) => h.id === id)) setGrazing(list[0]?.id ?? null)
								})
							}}
						/>
						<div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
							<div style={{ flex: 1 }} />
							{/* Windows reports "reduce motion" whenever animation effects are
							    off, which is common and rarely means what the flag implies.
							    Say where the default came from instead of leaving a frozen
							    pasture unexplained. */}
							<label
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 6,
									fontSize: 11,
									color: 'var(--muted)',
									flexShrink: 0,
								}}
								title={osReduce ? t('stable.motionOsHint') : undefined}
							>
								<input
									type="checkbox"
									checked={motion}
									onChange={(e) => setMotionPref(e.target.checked ? 'on' : 'off')}
								/>
								{t('stable.motion')}
								{osReduce && <span style={{ color: 'var(--muted-2)' }}>· {t('stable.motionOs')}</span>}
							</label>
						</div>
					</div>
				) : (
					<>
					{grazingHorse && (() => {
						const stations = deriveStations({
							horse: grazingHorse,
							chatModel: fitted.model,
							embeddingModel: fitted.retrieval,
							skillCount,
							pool,
						})
						return (
							<>
								<Pipeline
									stations={stations}
									selected={selected}
									onSelect={setSelected}
									labelOf={(id) => t(`stable.station.${id}.name`)}
								/>

								{/* 面板从不空白：没选站时介绍这匹马本身，那也是唯一能同时
								    看到它的样子和它的链路的地方。 */}
								<aside style={{ width: 320, flexShrink: 0, minHeight: 0 }}>
									<EquipPanel
										horse={grazingHorse}
										skin={skins[grazingHorse.skin]}
										selected={selected}
										stations={stations}
										pool={pool}
										onSelectStation={setSelected}
										onCeiling={(ceiling: ToolKind) => {
											void window.veridian.horses.update(grazingHorse.id, { ceiling }).then(reload)
										}}
										onToggleTool={(name, on) => {
											const next = on
												? [...grazingHorse.tools, name]
												: grazingHorse.tools.filter((n) => n !== name)
											void window.veridian.horses.update(grazingHorse.id, { tools: next }).then(reload)
										}}
										onOpenSettings={() => setPage('settings')}
										onOpenSkills={() => setPage('settings')}
									/>
								</aside>
							</>
						)
					})()}
					</>
				)}
			</div>
		</div>
	)
}

const backBtnStyle: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 5,
	height: 28,
	padding: '0 10px',
	borderRadius: 'var(--radius-md)',
	border: '1px solid var(--border)',
	background: 'var(--surface)',
	color: 'var(--foreground-2)',
	fontSize: 12,
	fontWeight: 500,
	flexShrink: 0,
}

