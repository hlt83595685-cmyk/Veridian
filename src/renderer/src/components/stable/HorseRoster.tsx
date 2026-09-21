import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Horse, ToolKind } from '../../../../shared/types'
import type { SkinSpec } from './pasture/skins'

// The strip under the pasture: who lives here, and the way to add one.
//
// Ceiling is picked at creation and shown on every row, because it is the only
// thing that actually distinguishes one horse from another right now -- a
// read-only horse and a library-writing horse are different animals, and the
// difference has to be visible without opening anything.

const CEILINGS: ToolKind[] = ['read', 'write-library', 'write-fs', 'destructive']

const CEILING_TONE: Record<ToolKind, string> = {
	read: 'var(--muted)',
	'write-library': 'var(--primary)',
	'write-fs': 'var(--warn-fg)',
	destructive: 'var(--danger-fg)',
}

interface Props {
	horses: Horse[]
	selected: string | null
	catalogue: SkinSpec[]
	onSelect: (id: string) => void
	onCreate: (name: string, skin: string, ceiling: ToolKind) => void
	onUpdate: (id: string, patch: { name?: string; skin?: string; ceiling?: ToolKind }) => void
	onSetDefault: (id: string) => void
	onRemove: (id: string) => void
}

export function HorseRoster({
	horses, selected, catalogue, onSelect, onCreate, onUpdate, onSetDefault, onRemove,
}: Props): JSX.Element {
	const { t } = useTranslation('common')
	const [adding, setAdding] = useState(false)
	const [name, setName] = useState('')
	const [skin, setSkin] = useState(catalogue[0]?.id ?? '')
	const [ceiling, setCeiling] = useState<ToolKind>('read')

	const current = horses.find((h) => h.id === selected) ?? null

	function submit(): void {
		if (!name.trim() || !skin) return
		onCreate(name.trim(), skin, ceiling)
		setName('')
		setCeiling('read')
		setAdding(false)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
			<div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
				{horses.map((h) => (
					<button
						key={h.id}
						onClick={() => onSelect(h.id)}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 6,
							padding: '3px 10px',
							borderRadius: 999,
							fontSize: 11.5,
							fontWeight: 600,
							border: `1px solid ${h.id === selected ? 'var(--primary)' : 'var(--border)'}`,
							background: h.id === selected ? 'var(--primary-soft)' : 'var(--surface)',
							color: h.id === selected ? 'var(--primary)' : 'var(--foreground-2)',
						}}
					>
						{h.name}
						<span style={{ color: CEILING_TONE[h.ceiling], fontSize: 10, fontWeight: 700 }}>
							{t(`stable.ceiling.${h.ceiling}.short`)}
						</span>
						{h.isDefault && (
							<span style={{ color: 'var(--muted-2)', fontSize: 10 }}>{t('stable.defaultMark')}</span>
						)}
					</button>
				))}
				<button onClick={() => setAdding((v) => !v)} style={addBtnStyle}>
					{adding ? t('stable.cancel') : `+ ${t('stable.newHorse')}`}
				</button>
			</div>

			{adding && (
				<div style={panelStyle}>
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') submit()
							if (e.key === 'Escape') setAdding(false)
						}}
						placeholder={t('stable.namePlaceholder')}
						maxLength={40}
						autoFocus
						style={inputStyle}
					/>
					<select value={skin} onChange={(e) => setSkin(e.target.value)} style={inputStyle}>
						{catalogue.map((c) => (
							<option key={c.id} value={c.id}>
								{c.label}
							</option>
						))}
					</select>
					<select
						value={ceiling}
						onChange={(e) => setCeiling(e.target.value as ToolKind)}
						title={t('stable.ceilingHint')}
						style={inputStyle}
					>
						{CEILINGS.map((c) => (
							<option key={c} value={c}>
								{t(`stable.ceiling.${c}.label`)}
							</option>
						))}
					</select>
					<button onClick={submit} disabled={!name.trim()} style={primaryBtnStyle}>
						{t('stable.create')}
					</button>
				</div>
			)}

			{current && !adding && (
				<div style={panelStyle}>
					<span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{current.name}</span>
					<select
						value={current.skin}
						onChange={(e) => onUpdate(current.id, { skin: e.target.value })}
						style={inputStyle}
					>
						{catalogue.map((c) => (
							<option key={c.id} value={c.id}>
								{c.label}
							</option>
						))}
					</select>
					<select
						value={current.ceiling}
						onChange={(e) => onUpdate(current.id, { ceiling: e.target.value as ToolKind })}
						title={t('stable.ceilingHint')}
						style={inputStyle}
					>
						{CEILINGS.map((c) => (
							<option key={c} value={c}>
								{t(`stable.ceiling.${c}.label`)}
							</option>
						))}
					</select>
					{!current.isDefault && (
						<button onClick={() => onSetDefault(current.id)} style={plainBtnStyle}>
							{t('stable.makeDefault')}
						</button>
					)}
					{/* The last horse cannot go: an empty stable means nothing can answer,
					    which is a broken app rather than a configuration. */}
					{horses.length > 1 && (
						<button onClick={() => onRemove(current.id)} style={dangerBtnStyle}>
							{t('stable.remove')}
						</button>
					)}
				</div>
			)}
		</div>
	)
}

const panelStyle: React.CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	gap: 7,
	flexWrap: 'wrap',
	padding: '7px 9px',
	borderRadius: 10,
	border: '1px solid var(--border)',
	background: 'var(--surface)',
}

const inputStyle: React.CSSProperties = {
	height: 27,
	padding: '0 8px',
	borderRadius: 7,
	border: '1px solid var(--border)',
	background: 'var(--bg-elevated)',
	color: 'var(--foreground)',
	fontSize: 12,
}

const addBtnStyle: React.CSSProperties = {
	padding: '3px 10px',
	borderRadius: 999,
	fontSize: 11.5,
	fontWeight: 600,
	border: '1px dashed var(--border-strong)',
	background: 'transparent',
	color: 'var(--muted)',
}

const primaryBtnStyle: React.CSSProperties = {
	height: 27,
	padding: '0 12px',
	borderRadius: 7,
	border: 'none',
	background: 'var(--primary)',
	color: '#fff',
	fontSize: 11.5,
	fontWeight: 600,
}

const plainBtnStyle: React.CSSProperties = {
	height: 27,
	padding: '0 10px',
	borderRadius: 7,
	border: '1px solid var(--border)',
	background: 'var(--bg-elevated)',
	color: 'var(--foreground-2)',
	fontSize: 11.5,
	fontWeight: 600,
}

const dangerBtnStyle: React.CSSProperties = {
	...plainBtnStyle,
	color: 'var(--danger-fg)',
	borderColor: 'var(--danger-border)',
}
