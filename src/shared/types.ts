export interface Item {
  id: number
  key: string
  type: string
  title: string | null
  abstract: string | null
  year: number | null
  doi: string | null
  url: string | null
  journal: string | null
  publisher: string | null
  volume: string | null
  issue: string | null
  pages: string | null
  isbn: string | null
  language: string | null
  extra: string | null
  deleted: number
  library_id: number
  created_at: number
  updated_at: number
  version: number
  tags?: string[]  // populated by getAllItemsWithTags
}

export type ItemType =
  | 'journalArticle'
  | 'book'
  | 'bookSection'
  | 'thesis'
  | 'conferencePaper'
  | 'report'
  | 'webpage'
  | 'preprint'

export const ITEM_TYPE_LABELS: Record<ItemType, { zh: string; en: string }> = {
  journalArticle: { zh: '期刊论文', en: 'Journal Article' },
  book:           { zh: '书籍',     en: 'Book' },
  bookSection:    { zh: '书章节',   en: 'Book Section' },
  thesis:         { zh: '学位论文', en: 'Thesis' },
  conferencePaper:{ zh: '会议论文', en: 'Conference Paper' },
  report:         { zh: '报告',     en: 'Report' },
  webpage:        { zh: '网页',     en: 'Webpage' },
  preprint:       { zh: '预印本',   en: 'Preprint' },
}

export interface Creator {
  id?: number
  first_name: string | null
  last_name: string
  orcid?: string | null
  role: 'author' | 'editor' | 'translator'
  position: number
}

export interface Collection {
  id: number
  library_id: number
  parent_id: number | null
  name: string
  key: string
}

export interface Tag {
  id: number
  name: string
}

export interface Attachment {
  id: number
  item_id: number
  type: 'pdf' | 'link' | 'other'
  filename: string | null
  path: string | null
  url: string | null
  mime_type: string | null
  size: number | null
}

export interface ImportResult {
  canceled: boolean
  imported: number
}
