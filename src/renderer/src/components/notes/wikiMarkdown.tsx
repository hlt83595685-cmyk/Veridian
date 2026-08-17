import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkWikiLink from 'remark-wiki-link'

// Render note markdown with clickable [[wikilinks]]. remark-wiki-link turns
// [[Title]] / [[Title|alias]] into <a> tags; we point their href at a private
// scheme and intercept clicks on the container so the app resolves + navigates.
// `known` = lower-cased+trimmed titles that resolve (existing vs unresolved).
export function WikiMarkdown({ content, known, onWiki }: {
	content: string
	known: Set<string>
	onWiki: (title: string) => void
}): JSX.Element {
	return (
		<div
			className="wiki-md"
			onClick={(e) => {
				const a = (e.target as HTMLElement).closest('a[href^="veridian-wiki://"]') as HTMLAnchorElement | null
				if (!a) return
				e.preventDefault()
				onWiki(decodeURIComponent(a.getAttribute('href')!.slice('veridian-wiki://'.length)))
			}}
		>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, [remarkWikiLink, {
					aliasDivider: '|',
					hrefTemplate: (permalink: string) => `veridian-wiki://${encodeURIComponent(permalink)}`,
					pageResolver: (name: string) => [name.trim().toLowerCase()],
					wikiLinkClassName: 'wiki-link',
					newClassName: 'wiki-link-new',
					permalinks: [...known],
				}]]}
			>
				{content}
			</ReactMarkdown>
		</div>
	)
}
