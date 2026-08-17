import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RetrievalStep } from '../../../../shared/types'
import { summarizeSteps } from './retrievalSummary'

// Inline line icons (Lucide-style) instead of emoji -- search_library uses a
// "library" (books) mark rather than a magnifying glass.
// Shared "action" glyph (pencil) for the write/read agent tools.
const ACTION_ICON = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z']
export const ICON_PATHS: Record<RetrievalStep['tool'], string[]> = {
	search_library: ['m16 6 4 14', 'M12 6v14', 'M8 8v12', 'M4 4v16'],
	read_context: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v5h5', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
	get_item_info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 16v-4', 'M12 8h.01'],
	load_skill: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
	create_note: ACTION_ICON,
	add_tags: ACTION_ICON,
	add_to_collection: ACTION_ICON,
	link_items: ACTION_ICON,
	update_metadata: ACTION_ICON,
	set_star: ACTION_ICON,
	list_collections: ACTION_ICON,
	list_items: ACTION_ICON,
	list_tags: ACTION_ICON,
	read_notes: ACTION_ICON,
	read_item: ACTION_ICON,
}

export function ToolIcon({ tool }: { tool: RetrievalStep['tool'] }): JSX.Element {
	return (
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
			strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
			style={{ flexShrink: 0 }} aria-hidden="true">
			{ICON_PATHS[tool].map((d, i) => <path key={i} d={d} />)}
		</svg>
	)
}

export function RetrievalTrace({ steps, streaming }: { steps: RetrievalStep[]; streaming?: boolean }): JSX.Element | null {
	const { t } = useTranslation('common')
	const [open, setOpen] = useState(false)
	if (!steps.length) return null
	const expanded = streaming || open
	const { searches, sources } = summarizeSteps(steps)

	return (
		<div style={{
			alignSelf: 'flex-start', maxWidth: '88%', marginBottom: 2,
			fontSize: 11.5, color: 'var(--muted)',
		}}>
			<button
				onClick={() => setOpen((v) => !v)}
				style={{
					display: 'inline-flex', alignItems: 'center', gap: 5,
					border: 'none', background: 'none', padding: 0, color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5,
				}}
			>
				<ToolIcon tool="search_library" />
				{t('knowledge.traceSummary', { searches, sources })} {streaming ? '' : (open ? '▾' : '▸')}
			</button>
			{expanded && (
				<div style={{ marginTop: 4, borderLeft: '2px solid var(--border)', paddingLeft: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
					{steps.map((s, i) => (
						<div key={i}>
							<div style={{ color: 'var(--foreground-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
								<ToolIcon tool={s.tool} />
								<span>{s.tool === 'search_library'
									? t('knowledge.traceSearch', { query: s.label, n: s.hits?.length ?? 0 })
									: `${s.tool} · ${s.label}`}</span>
							</div>
							{s.hits && s.hits.length > 0 && (
								<div style={{ paddingLeft: 19, color: 'var(--muted)' }}>
									{s.hits.map((h, j) => (
										<div key={j} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
											{h.title} · {t('knowledge.traceChars', { n: h.chars })}
										</div>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
