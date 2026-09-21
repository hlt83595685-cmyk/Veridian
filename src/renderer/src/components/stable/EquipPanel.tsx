import { useTranslation } from 'react-i18next'
import type { Horse, ToolInfo, ToolKind } from '../../../../shared/types'
import type { LoadedSkin } from './pasture/skins'
import { HorsePortrait } from './HorsePortrait'
import { ToolPicker } from './pipeline/ToolPicker'
import { equippedTools, type Station, type StationId } from './pipeline/stations'

// 链路图右边的面板。
//
// 没选站时介绍这匹马本身——那一栏原来是空白，让人以为界面没加载出来。
// 选了站就只讲那一站：它现在什么状态、为什么、在哪儿改。

const CEILINGS: ToolKind[] = ['read', 'write-library', 'write-fs', 'destructive']

const CEILING_TONE: Record<ToolKind, string> = {
	read: 'var(--muted)',
	'write-library': 'var(--primary)',
	'write-fs': 'var(--warn-fg)',
	destructive: 'var(--danger-fg)',
}

/** 哪些站是「到设置里改」，以及去哪个设置页。其余的要么当场可改，要么只读。 */
const OPENS_SETTINGS: StationId[] = ['model', 'retrieval']

interface Props {
	horse: Horse
	skin: LoadedSkin | undefined
	selected: StationId | null
	stations: Record<StationId, Station>
	pool: ToolInfo[]
	onSelectStation: (id: StationId | null) => void
	onCeiling: (ceiling: ToolKind) => void
	onToggleTool: (name: string, on: boolean) => void
	onOpenSettings: () => void
	onOpenSkills: () => void
}

export function EquipPanel({
	horse, skin, selected, stations, pool,
	onSelectStation, onCeiling, onToggleTool, onOpenSettings, onOpenSkills,
}: Props): JSX.Element {
	const { t } = useTranslation('common')
	const usable = equippedTools(horse, pool).length

	if (!selected) {
		return (
			<Frame>
				<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
					{skin && <HorsePortrait skin={skin} scale={3} />}
					<div style={{ minWidth: 0 }}>
						<h2 style={h2Style}>{horse.name}</h2>
						<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
							<span style={{ fontSize: 11, fontWeight: 700, color: CEILING_TONE[horse.ceiling] }}>
								{t(`stable.ceiling.${horse.ceiling}.label`)}
							</span>
							{horse.isDefault && (
								<span style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>
									· {t('stable.defaultMark')}
								</span>
							)}
						</div>
					</div>
				</div>

				<p style={pStyle}>{t('stable.pickStation')}</p>
				<Divider />

				{/* 每一站的当前状态，和图上一一对应。点一站两边一起走。 */}
				<div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
					{(Object.keys(stations) as StationId[]).map((id) => {
						const s = stations[id]
						return (
							<button
								key={id}
								onClick={() => onSelectStation(id)}
								style={rowStyle}
							>
								<span
									style={{
										width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
										background: s.state === 'ok' ? 'var(--primary)' : 'transparent',
										border: `1.5px solid ${dotColor(s)}`,
									}}
								/>
								<span style={{ fontSize: 12.5, color: 'var(--foreground-2)', flexShrink: 0 }}>
									{t(`stable.station.${id}.name`)}
								</span>
								<span style={{ flex: 1 }} />
								<span style={detailStyle}>{s.detail}</span>
							</button>
						)
					})}
				</div>

				<div style={{ flex: 1 }} />
				<div style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>
					{t('stable.equippedCount', { n: usable, total: pool.length })}
				</div>
			</Frame>
		)
	}

	const station = stations[selected]

	return (
		<Frame>
			<div>
				<div style={kickerStyle}>{selected}</div>
				<h2 style={h2Style}>{t(`stable.station.${selected}.name`)}</h2>
			</div>
			<p style={pStyle}>{t(`stable.station.${selected}.desc`)}</p>
			<Divider />

			{selected === 'ceiling' ? (
				<>
					<div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('stable.ceilingLabel')}</div>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						{CEILINGS.map((c) => (
							<button
								key={c}
								onClick={() => onCeiling(c)}
								style={{
									display: 'flex', alignItems: 'baseline', gap: 8,
									padding: '7px 10px', borderRadius: 9, textAlign: 'left',
									border: `1px solid ${c === horse.ceiling ? 'var(--primary)' : 'var(--border)'}`,
									background: c === horse.ceiling ? 'var(--primary-soft)' : 'var(--surface)',
								}}
							>
								<span
									style={{
										fontSize: 12.5, fontWeight: 600, flexShrink: 0,
										color: c === horse.ceiling ? 'var(--primary)' : 'var(--foreground-2)',
									}}
								>
									{t(`stable.ceiling.${c}.label`)}
								</span>
								<span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
									{t(`stable.ceiling.${c}.effect`)}
								</span>
							</button>
						))}
					</div>
					<div style={fineStyle}>{t('stable.ceilingCaveat')}</div>
				</>
			) : selected === 'tools' ? (
				<>
					<ToolPicker horse={horse} pool={pool} onToggle={onToggleTool} />
					<div style={fineStyle}>{t('stable.poolHint')}</div>
				</>
			) : (
				<>
					<StatusBox station={station} />
					{OPENS_SETTINGS.includes(selected) && (
						<>
							<div style={fineStyle}>{t('stable.sharedByAll')}</div>
							<button onClick={onOpenSettings} style={ctaStyle}>{t('stable.configure')}</button>
						</>
					)}
					{selected === 'skills' && (
						<button onClick={onOpenSkills} style={ctaStyle}>{t('stable.openSkills')}</button>
					)}
				</>
			)}

			<div style={{ flex: 1 }} />
			<button onClick={() => onSelectStation(null)} style={backStyle}>
				{t('stable.zoomOut')}
			</button>
		</Frame>
	)
}

function dotColor(s: Station): string {
	if (s.state === 'fatal') return 'var(--danger-border)'
	if (s.state === 'locked') return 'var(--warn-border)'
	if (s.state === 'ok') return 'var(--primary)'
	return 'var(--border-strong)'
}

/** 一站的当前值。通了用主色，没通就照实说，不假装它是个待办。 */
function StatusBox({ station }: { station: Station }): JSX.Element {
	const ok = station.state === 'ok'
	const bad = station.state === 'fatal'
	return (
		<div
			style={{
				padding: '10px 12px',
				borderRadius: 10,
				border: `1px ${ok ? 'solid' : 'dashed'} ${
					bad ? 'var(--danger-border)' : ok ? 'var(--primary-light)' : 'var(--border-strong)'
				}`,
				background: bad ? 'var(--danger-bg)' : ok ? 'var(--primary-soft)' : 'transparent',
			}}
		>
			<div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 3 }}>
				{ok ? t_current : t_state}
			</div>
			<div
				style={{
					fontSize: 13, fontWeight: 600, wordBreak: 'break-all',
					fontFamily: 'ui-monospace, monospace',
					color: bad ? 'var(--danger-fg)' : ok ? 'var(--foreground)' : 'var(--muted)',
				}}
			>
				{station.detail}
			</div>
		</div>
	)
}

// 这两个词在整个面板里各只出现一次，不值得为它们各开一个 i18n key。
const t_current = 'Currently'
const t_state = 'State'

function Frame({ children }: { children: React.ReactNode }): JSX.Element {
	return (
		<div
			style={{
				width: 320,
				height: '100%',
				overflowY: 'auto',
				padding: '16px 16px 18px',
				borderRadius: 14,
				border: '1px solid var(--border)',
				background: 'var(--surface)',
				display: 'flex',
				flexDirection: 'column',
				gap: 11,
				boxSizing: 'border-box',
			}}
		>
			{children}
		</div>
	)
}

const Divider = (): JSX.Element => <div style={{ height: 1, background: 'var(--separator)' }} />

const rowStyle: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 8,
	padding: '6px 8px',
	borderRadius: 8,
	border: 'none',
	background: 'transparent',
	textAlign: 'left',
	cursor: 'pointer',
}

const detailStyle: React.CSSProperties = {
	fontSize: 11,
	color: 'var(--muted-2)',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
	maxWidth: 140,
	fontFamily: 'ui-monospace, monospace',
}

const kickerStyle: React.CSSProperties = {
	fontSize: 10,
	fontWeight: 700,
	letterSpacing: '.06em',
	textTransform: 'uppercase',
	color: 'var(--muted-2)',
}

const h2Style: React.CSSProperties = {
	margin: 0,
	fontSize: 17,
	fontWeight: 700,
	color: 'var(--foreground)',
	letterSpacing: '-.01em',
}

const pStyle: React.CSSProperties = {
	margin: 0,
	fontSize: 12.5,
	lineHeight: 1.6,
	color: 'var(--foreground-2)',
}

const fineStyle: React.CSSProperties = {
	fontSize: 10.5,
	color: 'var(--muted-2)',
	lineHeight: 1.6,
}

const ctaStyle: React.CSSProperties = {
	height: 34,
	borderRadius: 9,
	border: 'none',
	background: 'var(--primary)',
	color: '#fff',
	fontSize: 12.5,
	fontWeight: 600,
	flexShrink: 0,
	cursor: 'pointer',
}

const backStyle: React.CSSProperties = {
	height: 28,
	borderRadius: 'var(--radius-md)',
	border: '1px solid var(--border)',
	background: 'var(--surface)',
	color: 'var(--foreground-2)',
	fontSize: 12,
	fontWeight: 500,
	flexShrink: 0,
	cursor: 'pointer',
}
