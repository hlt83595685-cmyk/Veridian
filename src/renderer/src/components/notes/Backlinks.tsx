import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Row = { kind: 'item' | 'note'; id: number; title: string; relType: string }

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
					{r.kind === 'item' ? '📄 ' : '📝 '}{r.title}
					<span style={{ color: 'var(--muted)', marginLeft: 6 }}>· {r.relType}</span>
				</div>
			))}
		</div>
	)
}
