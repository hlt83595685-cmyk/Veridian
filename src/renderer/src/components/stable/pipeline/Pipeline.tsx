import {
	BRANCH_X, ENTRY_X, EXIT_X, LANE, RAIL_BOX, RAIL_X, SIDE_BOX, SKILLS_X, VIEW,
	type Station, type StationId, type StationState,
} from './stations'

// 一次提问真实经过的路，画成图。
//
// 三条规矩：
//   1. 三条泳道 —— 上方旁路（没接进来的）、中间主链路、下方行动支路。
//   2. 主链路等距。间距不匀会让人以为疏密有含义。
//   3. 没通的连接不假装连着：抬离、拦杆、虚线，都是同一个意思。
//
// 闸门**不是**支路上的一个盒子。真实实现里每一次工具调用都要串着走完
// 上限 → 审批 两段（dsh-tools 的 pre-execute / guard），读工具也走，只是审批
// 那段直通。所以画成「模型 → 上限 → 审批 → 工具」的竖直串联——这个顺序本身
// 就说明了每次调用都要走完，不必再加一个括号去圈它（那个括号总在和回灌线抢
// 同一片空地，而且它想说的话，串联已经说了）。

const TONE: Record<StationState, { stroke: string; fill: string; ink: string; dashed: boolean }> = {
	ok: { stroke: 'var(--primary)', fill: 'var(--primary-soft)', ink: 'var(--foreground)', dashed: false },
	skip: { stroke: 'var(--border-strong)', fill: 'var(--surface)', ink: 'var(--muted-2)', dashed: true },
	closed: { stroke: 'var(--border-strong)', fill: 'var(--surface)', ink: 'var(--muted-2)', dashed: true },
	locked: { stroke: 'var(--warn-border)', fill: 'var(--warn-bg)', ink: 'var(--warn-fg)', dashed: true },
	fatal: { stroke: 'var(--danger-border)', fill: 'var(--danger-bg)', ink: 'var(--danger-fg)', dashed: false },
}

interface Props {
	stations: Record<StationId, Station>
	selected: StationId | null
	onSelect: (id: StationId | null) => void
	labelOf: (id: StationId) => string
}

export function Pipeline({ stations, selected, onSelect, labelOf }: Props): JSX.Element {
	const s = stations
	const modelOk = s.model.state === 'ok'
	const onRail = s.retrieval.state === 'ok'
	const toolsLive = s.tools.state === 'ok'
	// 上限拦住的位置就是拦杆的位置：拒绝发生在**问你之前**，用户不会为一个
	// 根本不会执行的调用挨一次弹窗。
	const capped = s.tools.state === 'locked'

	// 主链路按实际在轨的站铺线段，跳过的那站抬到旁路去。
	const railIds: Array<'retrieval' | 'context' | 'model'> = ['retrieval', 'context', 'model']
	const segments: Array<[number, number]> = []
	let cursor = ENTRY_X + 6
	for (const id of railIds) {
		if (id === 'retrieval' && !onRail) continue
		segments.push([cursor, RAIL_X[id] - RAIL_BOX.w])
		cursor = RAIL_X[id] + RAIL_BOX.w
	}
	if (modelOk) segments.push([cursor, EXIT_X - 7])

	return (
		<div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
			<svg
				viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
				style={{ width: '100%', height: 'auto', display: 'block' }}
				role="img"
				aria-label="A request travels the rail; skipped stations sit above it, and every tool call descends through the ceiling and approval gates before it runs"
				onClick={() => onSelect(null)}
			>
				<defs>
					<marker id="rig-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
						<path d="M0 0 L7 3.5 L0 7 z" fill="var(--primary)" />
					</marker>
				</defs>

				{/* ── 行动支路 ── */}
				<VLink from={LANE.rail + RAIL_BOX.h} to={LANE.ceiling - 14} on={toolsLive || capped} />
				<Chip
					id="ceiling" y={LANE.ceiling} station={s.ceiling} label={labelOf('ceiling')}
					note="blocks outright" selected={selected} onSelect={onSelect}
				/>
				<VLink from={LANE.ceiling + 14} to={LANE.approval - 14} on={toolsLive} barred={capped} />
				{/* 「读工具直通」只在审批真的会拦人时才有意义。审批本身已经是
				    「轮不到」或「只有读」的时候，站里那行小字已经说清楚了，再挂
				    一句只是重复。 */}
				<Chip
					id="approval" y={LANE.approval} station={s.approval} label={labelOf('approval')}
					note={s.approval.state === 'ok' ? 'reads pass through' : ''}
					selected={selected} onSelect={onSelect}
				/>
				<VLink from={LANE.approval + 14} to={LANE.tools - SIDE_BOX.h} on={toolsLive} />
				{toolsLive && <Feedback />}

				{/* ── 主链路 ── */}
				{segments.map(([x1, x2]) => (
					<line
						key={`${x1}-${x2}`} x1={x1} y1={LANE.rail} x2={x2} y2={LANE.rail}
						stroke="var(--primary)" strokeWidth={2.2} markerEnd="url(#rig-arrow)"
					/>
				))}

				{/* ── 旁路残桩 ── */}
				{!onRail && <Stub x={RAIL_X.retrieval} />}
				<SkillsLink live={s.skills.state === 'ok'} />

				<Terminal x={ENTRY_X} live label="Question" />
				<Terminal x={EXIT_X} live={modelOk} label="Answer" />
				{!modelOk && <Broken x={cursor + 12} />}

				{/* 盒子最后画，压在线之上 */}
				{railIds.map((id) => {
					const off = id === 'retrieval' && !onRail
					return (
						<Box
							key={id} id={id} x={RAIL_X[id]} y={off ? LANE.bypass : LANE.rail}
							station={s[id]} label={labelOf(id)} big={!off}
							selected={selected} onSelect={onSelect}
						/>
					)
				})}
				<Box
					id="skills" x={SKILLS_X} y={LANE.bypass} station={s.skills} label={labelOf('skills')}
					big={false} selected={selected} onSelect={onSelect}
				/>
				<Box
					id="tools" x={BRANCH_X} y={LANE.tools} station={s.tools} label={labelOf('tools')}
					big={false} selected={selected} onSelect={onSelect}
				/>
			</svg>
		</div>
	)
}

// ── 零件 ────────────────────────────────────────────────────────────────────

interface BoxProps {
	id: StationId
	x: number
	y: number
	station: Station
	label: string
	big: boolean
	selected: StationId | null
	onSelect: (id: StationId) => void
}

function Box({ id, x, y, station, label, big, selected, onSelect }: BoxProps): JSX.Element {
	const t = TONE[station.state]
	const { w, h } = big ? RAIL_BOX : SIDE_BOX
	// 主链路上的站永远实线：它在轨道上，就是通的。旁路和支路上的没通就虚线。
	const dashed = !big && t.dashed
	return (
		<g
			className="rig-hit"
			transform={`translate(${x},${y})`}
			onClick={(e) => { e.stopPropagation(); onSelect(id) }}
			style={{ cursor: 'pointer' }}
		>
			{selected === id && (
				<rect
					x={-w - 6} y={-h - 6} width={(w + 6) * 2} height={(h + 6) * 2} rx={13}
					fill="none" stroke="var(--primary)" strokeWidth={1.5} opacity={0.42}
				/>
			)}
			<rect
				x={-w} y={-h} width={w * 2} height={h * 2} rx={9}
				fill={t.fill} stroke={t.stroke} strokeWidth={big ? 1.9 : 1.5}
				strokeDasharray={dashed ? '5 4' : undefined}
			/>
			<text y={-3} textAnchor="middle" fontSize={big ? 12.5 : 11.5} fontWeight={700} fill={t.ink}>
				{label}
			</text>
			<text y={11} textAnchor="middle" fontSize={9} fill="var(--muted-2)" fontFamily="ui-monospace, monospace">
				{station.detail}
			</text>
		</g>
	)
}

/** 闸门的一段。药丸形，比工具盒子矮——它是通道上的一道关卡，不是一站产物。 */
function Chip({
	id, y, station, label, note, selected, onSelect,
}: {
	id: StationId
	y: number
	station: Station
	label: string
	note: string
	selected: StationId | null
	onSelect: (id: StationId) => void
}): JSX.Element {
	const t = TONE[station.state]
	const w = 64
	return (
		<g
			transform={`translate(${BRANCH_X},${y})`}
			onClick={(e) => { e.stopPropagation(); onSelect(id) }}
			style={{ cursor: 'pointer' }}
		>
			{selected === id && (
				<rect
					x={-w - 5} y={-19} width={(w + 5) * 2} height={38} rx={19}
					fill="none" stroke="var(--primary)" strokeWidth={1.5} opacity={0.42}
				/>
			)}
			<rect
				x={-w} y={-14} width={w * 2} height={28} rx={14}
				fill={t.fill} stroke={t.stroke} strokeWidth={1.6}
				strokeDasharray={station.state === 'ok' ? undefined : '5 4'}
			/>
			{/* 名字靠左、当前值靠右各自贴边。原来两个都用固定 x，标签一长就压在
			    一起——中文「上限」两个字不会，英文 Ceiling / Approval 会。 */}
			<text x={-w + 12} y={4} fontSize={11} fontWeight={700} fill={t.ink}>{label}</text>
			<text
				x={w - 12} y={4} textAnchor="end" fontSize={9} fill={t.ink} opacity={0.75}
				fontFamily="ui-monospace, monospace"
			>
				{station.detail}
			</text>
			{note && (
				<text x={w + 12} y={4} fontSize={9} fill="var(--muted-2)" fontFamily="ui-monospace, monospace">
					{note}
				</text>
			)}
		</g>
	)
}

/** 一段竖直连接。通了是实线带箭头，没通是虚线；被拦住的那段额外加一根拦杆。 */
function VLink({ from, to, on, barred }: { from: number; to: number; on: boolean; barred?: boolean }): JSX.Element {
	return (
		<>
			{on ? (
				<line
					x1={BRANCH_X} y1={from} x2={BRANCH_X} y2={to}
					stroke="var(--primary)" strokeWidth={1.8} markerEnd="url(#rig-arrow)"
				/>
			) : (
				<line
					x1={BRANCH_X} y1={from} x2={BRANCH_X} y2={to - 4}
					stroke="var(--border-strong)" strokeWidth={1.3} strokeDasharray="3 4"
				/>
			)}
			{barred && (
				<line
					x1={BRANCH_X - 16} y1={to - 3} x2={BRANCH_X + 16} y2={to - 3}
					stroke="var(--warn-border)" strokeWidth={3.4} strokeLinecap="round"
				/>
			)}
		</>
	)
}

/** 工具结果回灌进上下文——竖直回到上下文那一站，不去挤主轨道。 */
function Feedback(): JSX.Element {
	const cx = RAIL_X.context
	return (
		<>
			<path
				d={`M${BRANCH_X - SIDE_BOX.w} ${LANE.tools} H ${cx + 16} Q ${cx} ${LANE.tools} ${cx} ${LANE.tools - 16}`
					+ ` V ${LANE.rail + RAIL_BOX.h + 2}`}
				fill="none" stroke="var(--primary)" strokeWidth={1.6} markerEnd="url(#rig-arrow)"
			/>
			<text
				x={(BRANCH_X - SIDE_BOX.w + cx) / 2} y={LANE.tools - 8} textAnchor="middle"
				fontSize={9} fill="var(--muted-2)" fontFamily="ui-monospace, monospace"
			>
				result
			</text>
		</>
	)
}

function Stub({ x }: { x: number }): JSX.Element {
	return (
		<>
			<line
				x1={x} y1={LANE.bypass + SIDE_BOX.h} x2={x} y2={LANE.rail - RAIL_BOX.h - 8}
				stroke="var(--border-strong)" strokeWidth={1.3} strokeDasharray="3 4"
			/>
			<text
				x={x} y={LANE.rail - RAIL_BOX.h - 13} textAnchor="middle" fontSize={9}
				fill="var(--muted-2)" fontFamily="ui-monospace, monospace"
			>
				skipped
			</text>
		</>
	)
}

function SkillsLink({ live }: { live: boolean }): JSX.Element {
	return live ? (
		<line
			x1={SKILLS_X} y1={LANE.bypass + SIDE_BOX.h} x2={SKILLS_X} y2={LANE.rail - RAIL_BOX.h}
			stroke="var(--primary)" strokeWidth={1.8} markerEnd="url(#rig-arrow)"
		/>
	) : (
		<line
			x1={SKILLS_X} y1={LANE.bypass + SIDE_BOX.h} x2={SKILLS_X} y2={LANE.rail - RAIL_BOX.h - 10}
			stroke="var(--border-strong)" strokeWidth={1.3} strokeDasharray="3 4"
		/>
	)
}

function Terminal({ x, live, label }: { x: number; live: boolean; label: string }): JSX.Element {
	return (
		<>
			<circle
				cx={x} cy={LANE.rail} r={5.5}
				fill={live ? 'var(--primary)' : 'var(--surface)'}
				stroke={live ? 'var(--primary)' : 'var(--border-strong)'} strokeWidth={2}
			/>
			<text
				x={x} y={LANE.rail - 16} textAnchor="middle" fontSize={11} fontWeight={700}
				fill={live ? 'var(--foreground-2)' : 'var(--muted-2)'}
			>
				{label}
			</text>
		</>
	)
}

/** 模型没配 = 管道中断。这和上方的「skipped」是两回事，所以用拦杆 + 红字。 */
function Broken({ x }: { x: number }): JSX.Element {
	return (
		<>
			<line
				x1={x} y1={LANE.rail - 15} x2={x} y2={LANE.rail + 15}
				stroke="var(--danger-border)" strokeWidth={3.4} strokeLinecap="round"
			/>
			{/* 标签放拦杆下方，不放右边：右边是 Answer 端点，横着写会压住它。 */}
			<text
				x={x} y={LANE.rail + 30} textAnchor="middle" fontSize={10.5} fontWeight={700}
				fill="var(--danger-fg)"
			>
				pipeline broken
			</text>
		</>
	)
}
