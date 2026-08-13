import { useEffect, useRef, useState } from 'react'
import { useItemStore } from '../../stores/itemStore'
import { citationPhrase, citationHeading, normalizeForMatch } from './citeLocate'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import 'katex/dist/katex.min.css'
import { dirname, join } from 'path-browserify'

// rehypeRaw renders raw HTML embedded in .md files -- and our .md files come
// from untrusted sources (MinerU cloud output, collaborator repos synced from
// GitHub). Sanitize between raw and katex: strips scripts/event handlers but
// keeps the math classes rehype-katex needs and language- classes on code.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // NOTE: sanitize uses only the FIRST spec per attribute name, so these
    // REPLACE the defaults (append would be silently ignored).
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    span: [['className', 'math', 'math-inline', 'math-display']],
    div: [['className', 'math', 'math-display']],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'veridian-file'],
  },
}

interface Props {
  filePath: string
}

// Find the rendered element holding the start of a cited chunk: match the
// chunk's body prose against the visible text; fall back to its section
// heading. Returns null when neither is found (reader stays put).
function locateCitation(container: HTMLElement, target: { text: string; headingPath: string }): HTMLElement | null {
  const phrase = citationPhrase(target)
  if (phrase.length >= 8) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const parts: { node: Text; start: number }[] = []
    let full = ''
    let n: Node | null
    while ((n = walker.nextNode())) {
      parts.push({ node: n as Text, start: full.length })
      full += normalizeForMatch((n as Text).data)
    }
    const idx = full.indexOf(phrase)
    if (idx !== -1) {
      let hit = parts[0]
      for (const p of parts) { if (p.start <= idx) hit = p; else break }
      if (hit?.node.parentElement) return hit.node.parentElement
    }
  }
  const head = citationHeading(target)
  if (head) {
    for (const h of Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
      const ht = normalizeForMatch(h.textContent ?? '').trim()
      if (ht && (ht === head || ht.includes(head) || head.includes(ht))) return h as HTMLElement
    }
  }
  return null
}

// path-browserify's isAbsolute is POSIX-only (checks leading /).
// Add Windows absolute path detection (C:/... D:/... etc.).
function isAbsolutePath(p: string): boolean {
  const n = p.replace(/\\/g, '/')
  return n.startsWith('/') || /^[A-Za-z]:\//.test(n)
}

// Convert any image src to a veridian-file:// URL.
// file:// is blocked in Electron renderer; veridian-file:// is a registered privileged scheme.
function resolveImageSrc(src: string, mdDir: string): string {
  if (
    src.startsWith('data:') ||
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('veridian-file://')
  ) return src

  const normalised = src.replace(/\\/g, '/')
  if (isAbsolutePath(normalised)) {
    return `veridian-file:///${normalised}`
  }
  // Relative — join with .md directory
  const abs = join(mdDir, src).replace(/\\/g, '/')
  return `veridian-file:///${abs}`
}

// Image component: resolve path → load via IPC as blob URL to guarantee delivery.
// Falls back to veridian-file:// URL if IPC fails.
function LocalImage({ src, alt, mdDir }: { src?: string; alt?: string; mdDir: string }): JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobRef = useRef<string | null>(null)

  useEffect(() => {
    if (!src) return
    const resolved = resolveImageSrc(src, mdDir)
    // Extract absolute file path from veridian-file:/// URL for IPC read
    let filePath = resolved
    if (filePath.startsWith('veridian-file:///')) {
      filePath = decodeURIComponent(filePath.slice('veridian-file:///'.length))
      // On Windows the path is already like C:/... — keep as-is
    }
    window.veridian.fs.readFile(filePath)
      .then((bytes) => {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'gif' ? 'image/gif'
          : ext === 'svg' ? 'image/svg+xml'
          : ext === 'webp' ? 'image/webp'
          : 'image/png'
        const blob = new Blob([new Uint8Array(bytes)], { type: mime })
        const url = URL.createObjectURL(blob)
        blobRef.current = url
        setBlobUrl(url)
      })
      .catch((err) => {
        console.error('[MarkdownViewer] readFile failed:', filePath, err)
        setBlobUrl('__error__')
      })
    return () => {
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null }
    }
  }, [src, mdDir])

  if (!blobUrl) return <span style={{ color: 'var(--muted)', fontSize: 11 }}>[…]</span>
  if (blobUrl === '__error__') {
    return (
      <span title={src ?? ''} style={{
        display: 'inline-block', padding: '2px 8px', borderRadius: 4,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        color: 'var(--muted)', fontSize: 11, fontFamily: 'monospace',
      }}>
        ⚠ {src?.split('/').pop() ?? 'image'}
      </span>
    )
  }
  return <img src={blobUrl} alt={alt ?? ''} style={{ maxWidth: '100%', borderRadius: 6, margin: '8px 0' }} />
}

export function MarkdownViewer({ filePath }: Props): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const mdScrollTarget = useItemStore((s) => s.mdScrollTarget)
  const setMdScrollTarget = useItemStore((s) => s.setMdScrollTarget)

  // Normalise to forward slashes BEFORE dirname — path-browserify uses POSIX rules
  // and returns '.' for paths that contain only backslashes (Windows default).
  const mdDir = dirname(filePath.replace(/\\/g, '/'))

  useEffect(() => {
    setContent(null)
    setError(null)
    window.veridian.fs.readTextFile(filePath)
      .then(setContent)
      .catch((e: unknown) => setError(String(e)))
  }, [filePath])

  // Once the markdown is rendered, scroll a clicked citation to its spot and
  // flash it. Delay a beat so the DOM has painted. One-shot: clear the target.
  useEffect(() => {
    if (content === null || !mdScrollTarget || !containerRef.current) return
    const container = containerRef.current
    const target = mdScrollTarget
    const timer = setTimeout(() => {
      const el = locateCitation(container, target)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('md-cite-flash')
        setTimeout(() => el.classList.remove('md-cite-flash'), 2400)
      }
      setMdScrollTarget(null)
    }, 120)
    return () => clearTimeout(timer)
  }, [content, mdScrollTarget, setMdScrollTarget])

  if (error) {
    return (
      <div style={{ padding: 32, color: 'var(--accent)', fontSize: 13 }}>
        读取失败：{error}
      </div>
    )
  }

  if (content === null) {
    return (
      <div style={{ padding: 32, color: 'var(--muted)', fontSize: 13 }}>
        加载中…
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{
      padding: '24px 32px',
      maxWidth: 860,
      margin: '0 auto',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 14,
      lineHeight: 1.75,
      color: 'var(--foreground)',
    }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
        components={{
          // Load local images via IPC → blob URL (bypasses all CSP/protocol issues)
          img({ src, alt }) {
            return <LocalImage src={src} alt={alt} mdDir={mdDir} />
          },
          // Open links externally
          a({ href, children, ...rest }) {
            return (
              <a
                {...rest}
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href) window.veridian.tools.openExternal(href)
                }}
                style={{ color: 'var(--primary)', textDecoration: 'underline', cursor: 'pointer' }}
              >
                {children}
              </a>
            )
          },
          // Code blocks
          code({ children, className, ...rest }) {
            const isBlock = className?.startsWith('language-')
            if (isBlock) {
              return (
                <pre style={{
                  background: 'var(--surface-2)', borderRadius: 8,
                  padding: '12px 16px', overflowX: 'auto',
                  fontSize: 12, lineHeight: 1.6,
                  border: '1px solid var(--border)',
                }}>
                  <code {...rest} className={className}>{children}</code>
                </pre>
              )
            }
            return (
              <code
                {...rest}
                style={{
                  background: 'var(--surface-2)', borderRadius: 4,
                  padding: '1px 5px', fontSize: '0.88em',
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                {children}
              </code>
            )
          },
          // Tables
          table({ children, ...rest }) {
            return (
              <div style={{ overflowX: 'auto', margin: '16px 0' }}>
                <table
                  {...rest}
                  style={{
                    borderCollapse: 'collapse', width: '100%',
                    fontSize: 13,
                  }}
                >
                  {children}
                </table>
              </div>
            )
          },
          th({ children, ...rest }) {
            return (
              <th
                {...rest}
                style={{
                  border: '1px solid var(--border)',
                  padding: '8px 12px',
                  background: 'var(--surface-2)',
                  fontWeight: 600, textAlign: 'left',
                }}
              >
                {children}
              </th>
            )
          },
          td({ children, ...rest }) {
            return (
              <td
                {...rest}
                style={{ border: '1px solid var(--border)', padding: '7px 12px' }}
              >
                {children}
              </td>
            )
          },
          // Headings
          h1({ children, ...rest }) {
            return <h1 {...rest} style={{ fontSize: 22, fontWeight: 700, margin: '28px 0 12px', borderBottom: '1px solid var(--separator)', paddingBottom: 8 }}>{children}</h1>
          },
          h2({ children, ...rest }) {
            return <h2 {...rest} style={{ fontSize: 18, fontWeight: 600, margin: '24px 0 10px' }}>{children}</h2>
          },
          h3({ children, ...rest }) {
            return <h3 {...rest} style={{ fontSize: 15, fontWeight: 600, margin: '20px 0 8px' }}>{children}</h3>
          },
          // Blockquote
          blockquote({ children, ...rest }) {
            return (
              <blockquote
                {...rest}
                style={{
                  borderLeft: '3px solid var(--primary)',
                  paddingLeft: 16, margin: '16px 0',
                  color: 'var(--muted)', fontStyle: 'italic',
                }}
              >
                {children}
              </blockquote>
            )
          },
          // Horizontal rule
          hr(rest) {
            return <hr {...rest} style={{ border: 'none', borderTop: '1px solid var(--separator)', margin: '24px 0' }} />
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
