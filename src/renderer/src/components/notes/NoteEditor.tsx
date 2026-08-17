import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WikiMarkdown } from './wikiMarkdown'

interface NoteEditorProps {
	noteId?: number
	itemId?: number | null
	onWiki: (title: string) => void
	onSaved?: (id: number) => void
}

export function NoteEditor({ noteId, itemId, onWiki, onSaved }: NoteEditorProps): JSX.Element {
	const { t } = useTranslation('common')
	const [title, setTitle] = useState('')
	const [content, setContent] = useState('')
	const [mode, setMode] = useState<'edit' | 'preview'>('edit')
	const [titles, setTitles] = useState<string[]>([])
	const [ac, setAc] = useState<{ from: number; query: string } | null>(null)
	const taRef = useRef<HTMLTextAreaElement>(null)
	const idRef = useRef<number | undefined>(noteId)

	useEffect(() => {
		idRef.current = noteId
		void (async () => {
			if (noteId != null) {
				const n = await window.veridian.notes.get(noteId)
				setTitle(n?.title ?? ''); setContent(n?.content ?? '')
			} else { setTitle(''); setContent('') }
			const [notes, items] = await Promise.all([
				window.veridian.notes.listStandalone(),
				window.veridian.items.getAll(),
			])
			setTitles([...notes.map((n) => n.title ?? ''), ...items.map((i) => i.title ?? '')].filter(Boolean))
		})()
	}, [noteId])

	const known = useMemo(() => new Set(titles.map((s) => s.trim().toLowerCase())), [titles])

	const save = useMemo(() => {
		let timer: ReturnType<typeof setTimeout> | null = null
		return (nextTitle: string, nextContent: string) => {
			if (timer) clearTimeout(timer)
			timer = setTimeout(async () => {
				const savedId = await window.veridian.notes.save({ id: idRef.current, itemId, title: nextTitle, content: nextContent })
				idRef.current = savedId
				onSaved?.(savedId)
			}, 500)
		}
	}, [itemId, onSaved])

	function onContentChange(v: string, caret: number): void {
		setContent(v); save(title, v)
		const upto = v.slice(0, caret)
		const m = upto.match(/\[\[([^\]\n|#]*)$/)
		setAc(m ? { from: caret - m[1].length, query: m[1] } : null)
	}

	const suggestions = ac ? titles.filter((tt) => tt.toLowerCase().includes(ac.query.toLowerCase())).slice(0, 8) : []

	function insert(tt: string): void {
		if (!ac) return
		const before = content.slice(0, ac.from - 2)
		const after = content.slice(ac.from + ac.query.length)
		const next = `${before}[[${tt}]]${after}`
		setContent(next); save(title, next); setAc(null)
		requestAnimationFrame(() => taRef.current?.focus())
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
			<div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
				<input value={title} placeholder={t('notes.titlePlaceholder')}
					onChange={(e) => { setTitle(e.target.value); save(e.target.value, content) }}
					style={{ flex: 1, fontSize: 15, fontWeight: 700, border: 'none', outline: 'none', background: 'transparent', color: 'var(--foreground)' }} />
				<button onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
					style={{ border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 6, padding: '3px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--foreground-2)' }}>
					{mode === 'edit' ? t('notes.preview') : t('notes.edit')}
				</button>
			</div>
			<div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
				{mode === 'edit' ? (
					<textarea ref={taRef} value={content}
						onChange={(e) => onContentChange(e.target.value, e.target.selectionStart)}
						placeholder={t('notes.bodyPlaceholder')}
						style={{ width: '100%', height: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'var(--foreground)', fontSize: 13, lineHeight: 1.6, fontFamily: 'inherit' }} />
				) : (
					<div style={{ height: '100%', overflowY: 'auto' }}>
						<WikiMarkdown content={content} known={known} onWiki={onWiki} />
					</div>
				)}
				{ac && suggestions.length > 0 && (
					<div style={{ position: 'absolute', bottom: 8, left: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-sm)', maxWidth: 320, zIndex: 5 }}>
						{suggestions.map((s) => (
							<div key={s} onMouseDown={(e) => { e.preventDefault(); insert(s) }}
								style={{ padding: '6px 10px', fontSize: 12.5, cursor: 'pointer', color: 'var(--foreground-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								[[{s}]]
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	)
}
