import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RetrievalStep } from '../../../../shared/types'
import { summarizeSteps } from './retrievalSummary'

const ICON: Record<RetrievalStep['tool'], string> = {
	search_library: '🔍', read_context: '📄', get_item_info: 'ℹ️', load_skill: '📎',
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
				style={{ border: 'none', background: 'none', padding: 0, color: 'var(--muted)', cursor: 'pointer', fontSize: 11.5 }}
			>
				{t('knowledge.traceSummary', { searches, sources })} {streaming ? '' : (open ? '▾' : '▸')}
			</button>
			{expanded && (
				<div style={{ marginTop: 4, borderLeft: '2px solid var(--border)', paddingLeft: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
					{steps.map((s, i) => (
						<div key={i}>
							<div style={{ color: 'var(--foreground-3)' }}>
								{ICON[s.tool]} {s.tool === 'search_library'
									? t('knowledge.traceSearch', { query: s.label, n: s.hits?.length ?? 0 })
									: `${s.tool} · ${s.label}`}
							</div>
							{s.hits && s.hits.length > 0 && (
								<div style={{ paddingLeft: 16, color: 'var(--muted)' }}>
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
