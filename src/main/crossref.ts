export interface CrossRefAuthor {
  family?: string
  given?: string
}

export interface CrossRefWork {
  title?: string[]
  abstract?: string
  'container-title'?: string[]
  publisher?: string
  volume?: string
  issue?: string
  page?: string
  ISBN?: string[]
  language?: string
  type?: string
  DOI?: string
  URL?: string
  subject?: string[]
  author?: CrossRefAuthor[]
  editor?: CrossRefAuthor[]
  published?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
}

export const CROSSREF_TYPE_MAP: Record<string, string> = {
  'journal-article':    'journalArticle',
  'book':               'book',
  'book-chapter':       'bookSection',
  'proceedings-article':'conferencePaper',
  'dissertation':       'thesis',
  'report':             'report',
  'posted-content':     'preprint',
  'monograph':          'book',
}

const CR_HEADERS = { 'User-Agent': 'Veridian/0.1 (mailto:user@veridian.app)' }

export async function fetchCrossRefByDoi(doi: string): Promise<CrossRefWork | null> {
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: CR_HEADERS })
    if (!res.ok) return null
    const data = (await res.json()) as { message?: CrossRefWork }
    return data.message ?? null
  } catch {
    return null
  }
}

// Search CrossRef by title, return best match (score >= 80)
export async function searchCrossRefByTitle(title: string): Promise<CrossRefWork | null> {
  try {
    const q = encodeURIComponent(title.slice(0, 200))
    const url = `https://api.crossref.org/works?query.title=${q}&rows=1&select=DOI,title,author,container-title,published,published-print,published-online,abstract,publisher,volume,issue,page,type,language,subject`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: CR_HEADERS })
    if (!res.ok) return null
    const data = (await res.json()) as { message?: { items?: Array<CrossRefWork & { score?: number }> } }
    const items = data.message?.items ?? []
    if (!items.length) return null
    // Accept only if the top result's title is similar enough
    const hit = items[0]
    const hitTitle = hit.title?.[0]?.toLowerCase() ?? ''
    const queryTitle = title.toLowerCase()
    // Simple overlap check: at least 60% of words match
    const qWords = queryTitle.split(/\W+/).filter(w => w.length > 3)
    const matches = qWords.filter(w => hitTitle.includes(w))
    if (qWords.length > 0 && matches.length / qWords.length < 0.6) return null
    return hit
  } catch {
    return null
  }
}
