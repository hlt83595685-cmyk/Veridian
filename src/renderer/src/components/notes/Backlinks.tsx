import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Row = { kind: 'item' | 'note'; id: number; title: string; relType: string }

// Inline line icons matching the sidebar glyph style: a folded-corner document
// for a paper backlink, a lined card for a note backlink.
function RowIcon({ kind }: { kind: 'item' | 'note' }): JSX.Element {
	return (
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none"
			style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 5, flexShrink: 0 }} aria-hidden="true">
			{kind === 'item' ? (
				<>
					<path d="M4.5 2.5h4L11.5 5.5V13a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
					<path d="M8.5 2.5V5.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
					<line x1="6.3" y1="8.6" x2="9.7" y2="8.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
					<line x1="6.3" y1="10.6" x2="8.6" y2="10.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
				</>
			) : (
				<>
					<rect x="3.5" y="2.5" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
					<line x1="5.8" y1="5.6" x2="10.2" y2="5.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
					<line x1="5.8" y1="8" x2="10.2" y2="8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
					<line x1="5.8" y1="10.4" x2="8.4" y2="10.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
				</>
			)}
		</svg>
	)
}

export function Backlinks({ kind, id, refreshKey, onOpen }: {
	kind: 'item' | 'note'; id: number; refreshKey?: number
	onOpen: (kind: 'item' | 'note', id: number) => void
}): JSX.Element {
	const { t } = useTranslation('common')
	const [rows, setRows] = useState<Row[]>([])
	useEffect(() => { void window.veridian.notes.backlinks(kind, id).then(setRows) }, [kind, id, refreshKey])
	return (
		<div style={{ fontSize: 12.5 }}>
			<div style={{ textTransform: 'uppercase', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.5, marginBottom: 6 }}>
				↩ {t('notes.backlinks')} ({rows.length})
			</div>
			{rows.length === 0 && <div style={{ color: 'var(--muted)' }}>{t('notes.noBacklinks')}</div>}
			{rows.map((r) => (
				<div key={`${r.kind}-${r.id}-${r.relType}`} onClick={() => onOpen(r.kind, r.id)}
					style={{ padding: '4px 0', cursor: 'pointer', color: 'var(--foreground-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					<RowIcon kind={r.kind} />{r.title}
					<span style={{ color: 'var(--muted)', marginLeft: 6 }}>· {r.relType}</span>
				</div>
			))}
		</div>
	)
}
