import type { Horse, ToolInfo, ToolKind } from '../../../../../shared/types'
import { cappedTools, danglingTools } from './stations'

// 装配清单：从池子里勾。
//
// 池子是全局的（插件注册了什么就有什么），勾选是每匹马自己的。新工具冒出来时
// **默认不勾**——否则装一个插件就让所有马同时变强，装配也就不再有意义。
//
// 「勾了但被上限卡住」不隐藏而是标出来：藏起来会让人以为没勾上，然后反复去勾。

const KIND_TONE: Record<ToolKind, { fg: string; bg: string; border: string }> = {
	read: { fg: 'var(--muted)', bg: 'var(--muted-bg)', border: 'var(--border)' },
	'write-library': { fg: 'var(--primary)', bg: 'var(--primary-soft)', border: 'var(--primary-light)' },
	'write-fs': { fg: 'var(--warn-fg)', bg: 'var(--warn-bg)', border: 'var(--warn-border)' },
	destructive: { fg: 'var(--danger-fg)', bg: 'var(--danger-bg)', border: 'var(--danger-border)' },
}

const KIND_LABEL: Record<ToolKind, string> = {
	read: 'read',
	'write-library': 'library',
	'write-fs': 'files',
	destructive: 'delete',
}

interface Props {
	horse: Horse
	pool: ToolInfo[]
	onToggle: (name: string, on: boolean) => void
}

export function ToolPicker({ horse, pool, onToggle }: Props): JSX.Element {
	const capped = new Set(cappedTools(horse, pool).map((t) => t.name))
	const dangling = danglingTools(horse, pool)

	if (pool.length === 0) {
		return (
			<div style={emptyStyle}>
				No tools are registered yet. Tools arrive with plugins; this list fills in as you install them.
			</div>
		)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
			{pool.map((tool) => {
				const on = horse.tools.includes(tool.name)
				const blocked = on && capped.has(tool.name)
				const tone = KIND_TONE[tool.kind]
				return (
					<label
						key={tool.name}
						style={{
							display: 'flex',
							alignItems: 'flex-start',
							gap: 8,
							padding: '8px 10px',
							borderRadius: 9,
							cursor: 'pointer',
							border: `1px solid ${on ? 'var(--primary-light)' : 'var(--border)'}`,
							background: on ? 'var(--primary-soft)' : 'var(--surface)',
						}}
					>
						<input
							type="checkbox"
							checked={on}
							onChange={(e) => onToggle(tool.name, e.target.checked)}
							style={{ marginTop: 2, flexShrink: 0 }}
						/>
						<span style={{ minWidth: 0, flex: 1 }}>
							<span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
								<span style={nameStyle}>{tool.name}</span>
								<span
									style={{
										fontSize: 9.5,
										fontWeight: 700,
										padding: '1px 5px',
										borderRadius: 5,
										flexShrink: 0,
										color: tone.fg,
										background: tone.bg,
										border: `1px solid ${tone.border}`,
									}}
								>
									{KIND_LABEL[tool.kind]}
								</span>
							</span>
							<span style={descStyle}>{tool.description}</span>
							{/* 装了却用不了必须说出来，否则用户只会反复去勾同一个框。 */}
							{blocked && (
								<span style={blockedStyle}>
									Equipped, but this horse’s ceiling stops it. Raise the ceiling to use it.
								</span>
							)}
						</span>
					</label>
				)
			})}

			{dangling.length > 0 && (
				<div style={danglingStyle}>
					Equipped but no longer registered: {dangling.join(', ')}. The choice is kept in case the
					plugin comes back.
				</div>
			)}
		</div>
	)
}

const nameStyle: React.CSSProperties = {
	fontSize: 12.5,
	fontWeight: 600,
	color: 'var(--foreground)',
	fontFamily: 'ui-monospace, monospace',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
}

const descStyle: React.CSSProperties = {
	display: 'block',
	fontSize: 11,
	lineHeight: 1.55,
	color: 'var(--muted)',
	marginTop: 2,
}

const blockedStyle: React.CSSProperties = {
	display: 'block',
	fontSize: 10.5,
	lineHeight: 1.5,
	color: 'var(--warn-fg)',
	marginTop: 4,
}

const danglingStyle: React.CSSProperties = {
	padding: '8px 10px',
	borderRadius: 9,
	border: '1px dashed var(--border-strong)',
	fontSize: 10.5,
	lineHeight: 1.55,
	color: 'var(--muted)',
}

const emptyStyle: React.CSSProperties = {
	padding: 12,
	borderRadius: 10,
	border: '1px dashed var(--border-strong)',
	color: 'var(--muted)',
	fontSize: 12.5,
	lineHeight: 1.6,
}
