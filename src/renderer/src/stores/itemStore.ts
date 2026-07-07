import { create } from 'zustand'
import type { Item } from '../../../shared/types'

type ViewerType = 'pdf' | 'markdown' | 'gallery'

interface ItemStore {
  items: Item[]
  selectedId: number | null
  activeCollection: string
  searchQuery: string
  yearSort: 'none' | 'desc'
  // Viewer state
  viewerPath: string | null
  viewerFilename: string | null
  viewerType: ViewerType
  loadItems: () => Promise<void>
  setSelectedId: (id: number | null) => void
  setActiveCollection: (id: string) => void
  setSearchQuery: (q: string) => void
  toggleYearSort: () => void
  openPdf: (path: string, filename: string) => void
  openMarkdown: (path: string, filename: string) => void
  openGallery: (dirPath: string, name: string) => void
  closePdf: () => void
}

export const useItemStore = create<ItemStore>((set) => ({
  items: [],
  selectedId: null,
  activeCollection: 'all',
  searchQuery: '',
  yearSort: 'none',
  viewerPath: null,
  viewerFilename: null,
  viewerType: 'pdf',

  loadItems: async () => {
    try {
      const { activeCollection } = useItemStore.getState()
      let items: Item[]
      if (activeCollection === 'trash') {
        items = await window.veridian.items.getTrashed()
      } else if (activeCollection.startsWith('col:')) {
        const colId = parseInt(activeCollection.slice(4), 10)
        items = await window.veridian.items.getByCollection(colId) as Item[]
      } else if (activeCollection === 'recent') {
        const all = await window.veridian.items.getAll()
        items = all.slice(0, 50)
      } else {
        items = await window.veridian.items.getAll()
      }
      set({ items: items ?? [] })
    } catch (err) {
      console.error('[itemStore] loadItems failed:', err)
    }
  },

  setSelectedId: (id) => set({ selectedId: id }),
  setActiveCollection: (id) => {
    set({ activeCollection: id, selectedId: null, viewerPath: null, yearSort: 'none' })
    setTimeout(() => useItemStore.getState().loadItems(), 0)
  },
  setSearchQuery: (q) => set({ searchQuery: q }),
  toggleYearSort: () => set((s) => ({ yearSort: s.yearSort === 'desc' ? 'none' : 'desc' })),
  openPdf: (path, filename) => set({ viewerPath: path, viewerFilename: filename, viewerType: 'pdf' }),
  openMarkdown: (path, filename) => set({ viewerPath: path, viewerFilename: filename, viewerType: 'markdown' }),
  openGallery: (dirPath, name) => set({ viewerPath: dirPath, viewerFilename: name, viewerType: 'gallery' }),
  closePdf: () => set({ viewerPath: null, viewerFilename: null }),
}))
