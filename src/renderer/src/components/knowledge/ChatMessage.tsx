import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { citeUrlTransform } from './citeUrl'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { useTranslation } from 'react-i18next'
import { useItemStore } from '../../stores/itemStore'
import { useUiStore } from '../../stores/uiStore'
import { RetrievalTrace } from './RetrievalTrace'
import { Chip, PaperclipIcon } from './Chip'
import type { RetrievalStep } from '../../../../shared/types'

export interface CitationInfo { itemKey: string; itemId: number | null; seq: number; title: string | null }

function ActBtn({ title, onClick, path }: { title: string; onClick: () => void; path: string[] }): JSX.Element {
	return (
		<button className="msg-actbtn" title={title} onClick={onClick}>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				{path.map((d, i) => <path key={i} d={d} />)}
			</svg>
		</button>
	)
}
const ICON_COPY = ['M8 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2']
const ICON_REGEN = ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M3 21v-5h5']
const ICON_EDIT = ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']

// remark-math only understands $...$ / $$...$$. Models frequently emit the
// other common LaTeX delimiters (\(...\) inline, \[...\] display), so
// normalize those first -- otherwise the formula shows up as raw backslash
// text instead of a rendered equation.
function normalizeMathDelimiters(text: string): string {
	return text
		.replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `$$${body}$$`)
		.replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body}$`)
		// \tag only compiles in top-level display math -- KaTeX rejects it in
		// inline math AND inside aligned/align/array environments, both of which
		// models emit often ("\tag works only in display equations"). Rewrite
		// \tag{X} / \tag*{X} to "\quad (X)", which renders in every mode and
		// environment while keeping the equation number.
		.replace(/\\tag\*?\s*\{([^{}]*)\}/g, (_m, label: string) => `\\quad (${label})`)
}

// The agent is prompted to emit [^KEY:seq] inline. Rewrite those into a
// markdown link with a private scheme so ReactMarkdown renders a clickable
// citation chip instead of literal bracket text, without a custom parser.
function toMarkdownLinks(text: string): string {
	return normalizeMathDelimiters(text).replace(/\[\^([A-Za-z0-9_-]+):(\d+)\]/g, (_m, key: string, seq: string) =>
		`[[${Number(seq) + 1}]](veridian-cite://${key}/${seq})`
	)
}

async function openCitation(
	c: CitationInfo | undefined,
	setPage: (p: 'library') => void,
	openMarkdown: (path: string, filename: string) => void,
	setScrollTarget: (t: { text: string; headingPath: string } | null) => void,
	scroll: boolean
): Promise<void> {
	if (!c || c.itemId === null) return
	const atts = await window.veridian.attachments.getByItem(c.itemId)
	const md = atts.find((a) => a.type === 'markdown')
	if (!md?.path) return
	// Inline [n] markers jump to the cited spot; the sources list just opens the
	// paper (scroll=false, and clear any stale target so it lands at the top).
	setScrollTarget(scroll ? await window.veridian.knowledge.getChunk(c.itemKey, c.seq) : null)
	setPage('library')
	openMarkdown(md.path, md.filename ?? 'Full.md')
}

export function ChatMessageView({ role, content, citations, streaming, steps, isLast, onRegenerate, onEdit, refs }: {
	role: 'user' | 'assistant'
	content: string
	citations: CitationInfo[]
	streaming?: boolean
	steps?: RetrievalStep[]
	isLast?: boolean
	onRegenerate?: () => void
	onEdit?: () => void
	refs?: { type: string; label: string }[]
}): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const openMarkdown = useItemStore((s) => s.openMarkdown)
	const setMdScrollTarget = useItemStore((s) => s.setMdScrollTarget)
	const byKeySeq = new Map(citations.map((c) => [`${c.itemKey}:${c.seq}`, c]))
	// The sources list is per-paper, not per-excerpt -- citing the same paper
	// at several seqs shouldn't repeat its title several times in the list.
	const uniqueSources = [...new Map(citations.map((c) => [c.itemKey, c])).values()]

	if (role === 'user') {
		return (
			<div className="msg-row" style={{ alignSelf: 'flex-end', maxWidth: '80%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
				<div style={{ padding: '9px 13px', borderRadius: '14px 14px 4px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--foreground)', fontSize: 13.5, lineHeight: 1.55 }}>
					{refs && refs.length > 0 && (
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
							{refs.map((r, i) => (
								<Chip key={i} icon={<PaperclipIcon size={10} />} label={r.label} size="sm" maxWidth={240} />
							))}
						</div>
					)}
					<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</div>
				</div>
				{isLast && onEdit && (
					<div className="msg-actions">
						<ActBtn title={t('knowledge.edit')} path={ICON_EDIT} onClick={onEdit} />
					</div>
				)}
			</div>
		)
	}

	return (
		<div className="msg-row" style={{ alignSelf: 'flex-start', maxWidth: '88%', display: 'flex', flexDirection: 'column', gap: 8 }}>
			{role === 'assistant' && steps && steps.length > 0 && (
				<RetrievalTrace steps={steps} streaming={streaming} />
			)}
			<div style={{
				padding: '10px 14px', borderRadius: '14px 14px 14px 4px',
				background: 'var(--surface-2)', border: '1px solid var(--border)',
				color: 'var(--foreground)', fontSize: 13.5, lineHeight: 1.65,
			}}>
				<div className="chat-markdown">
					<ReactMarkdown
						remarkPlugins={[remarkGfm, remarkMath]}
						rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
						urlTransform={citeUrlTransform}
						components={{
							a: ({ href, children }) => {
								if (href?.startsWith('veridian-cite://')) {
									const [, rest] = href.split('veridian-cite://')
									const [key, seq] = rest.split('/')
									const c = byKeySeq.get(`${key}:${seq}`)
									return (
										<button
											onClick={() => void openCitation(c, setPage, openMarkdown, setMdScrollTarget, true)}
											title={c?.title ?? key}
											style={{
												border: 'none', background: 'none', padding: 0, margin: 0,
												color: 'var(--primary)', font: 'inherit', cursor: 'pointer',
											}}
										>
											{children}
										</button>
									)
								}
								return <a href={href} target="_blank" rel="noreferrer">{children}</a>
							},
						}}
					>
						{toMarkdownLinks(content)}
					</ReactMarkdown>
					{streaming && <span className="chat-cursor" />}
				</div>
			</div>

			{uniqueSources.length > 0 && !streaming && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 4px' }}>
					<div style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
						{t('knowledge.citationsLabel')}
					</div>
					{uniqueSources.map((c, i) => (
						<button
							key={`${c.itemKey}:${c.seq}`}
							onClick={() => void openCitation(c, setPage, openMarkdown, setMdScrollTarget, false)}
							style={{
								display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left',
								border: 'none', background: 'none', padding: '2px 0', cursor: 'pointer',
								fontSize: 11.5, color: 'var(--foreground-2)',
							}}
						>
							<span style={{
								display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
								minWidth: 14, height: 14, borderRadius: 4, background: 'var(--muted-bg)',
								fontSize: 9.5, fontWeight: 700, color: 'var(--muted)', flexShrink: 0,
							}}>
								{i + 1}
							</span>
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{c.title ?? c.itemKey}
							</span>
						</button>
					))}
				</div>
			)}

			{!streaming && (
				<div className="msg-actions" style={{ padding: '0 4px' }}>
					<ActBtn title={t('knowledge.copy')} path={ICON_COPY} onClick={() => void navigator.clipboard.writeText(content)} />
					{isLast && onRegenerate && <ActBtn title={t('knowledge.regenerate')} path={ICON_REGEN} onClick={onRegenerate} />}
				</div>
			)}
		</div>
	)
}
