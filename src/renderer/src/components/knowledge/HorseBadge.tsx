import { useTranslation } from 'react-i18next'
import type { Horse, ToolKind } from '../../../../shared/types'

// 这段对话归哪匹马跑。
//
// 建对话时钉死，之后不再跟着默认马变——换了默认马以后旧对话的行为不该跟着变，
// 否则「这个回答当时是谁给的」就无从追溯。所以：**新对话可选，已有对话只读**。
// 这不是偷懒，是把数据模型的语义如实呈现出来。

const CEILING_TONE: Record<ToolKind, string> = {
	read: 'var(--muted)',
	'write-library': 'var(--primary)',
	'write-fs': 'var(--warn-fg)',
	destructive: 'var(--danger-fg)',
}

interface Props {
	horses: Horse[]
	/** 已选/已绑定的那匹。null = 还没加载出来。 */
	horse: Horse | null
	/** true 时可改（对话还没建）。 */
	editable: boolean
	onPick: (id: string) => void
}

export function HorseBadge({ horses, horse, editable, onPick }: Props): JSX.Element | null {
	const { t } = useTranslation('common')
	if (!horse) return null

	const tone = CEILING_TONE[horse.ceiling]
	const label = t(`stable.ceiling.${horse.ceiling}.label`)

	if (!editable) {
		return (
			<span style={boxStyle} title={t('knowledge.horseFixed')}>
				<Dot color={tone} />
				<span style={nameStyle}>{horse.name}</span>
				<span style={{ ...capStyle, color: tone }}>{label}</span>
			</span>
		)
	}

	return (
		<span style={{ ...boxStyle, paddingRight: 4 }}>
			<Dot color={tone} />
			<select
				value={horse.id}
				onChange={(e) => onPick(e.target.value)}
				title={t('knowledge.horsePick')}
				style={{
					border: 'none', background: 'transparent', font: 'inherit',
					fontSize: 11.5, fontWeight: 600, color: 'var(--foreground-2)',
					cursor: 'pointer', outline: 'none', maxWidth: 140,
				}}
			>
				{horses.map((h) => (
					<option key={h.id} value={h.id}>{h.name}</option>
				))}
			</select>
			<span style={{ ...capStyle, color: tone }}>{label}</span>
		</span>
	)
}

const Dot = ({ color }: { color: string }): JSX.Element => (
	<span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
)

const boxStyle: React.CSSProperties = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: 6,
	height: 24,
	padding: '0 9px',
	borderRadius: 12,
	border: '1px solid var(--border)',
	background: 'var(--surface)',
	flexShrink: 0,
}

const nameStyle: React.CSSProperties = {
	fontSize: 11.5,
	fontWeight: 600,
	color: 'var(--foreground-2)',
	maxWidth: 140,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
}

const capStyle: React.CSSProperties = {
	fontSize: 10,
	fontWeight: 700,
	fontFamily: 'ui-monospace, monospace',
	flexShrink: 0,
}
