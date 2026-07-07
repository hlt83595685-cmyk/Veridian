import { create } from 'zustand'
import type { Collection } from '../../../shared/types'

interface CollectionStore {
  collections: Collection[]
  load: () => Promise<void>
  create: (name: string) => Promise<void>
  rename: (id: number, name: string) => Promise<void>
  remove: (id: number) => Promise<void>
}

export const useCollectionStore = create<CollectionStore>((set, get) => ({
  collections: [],

  load: async () => {
    const collections = await window.veridian.collections.getAll()
    set({ collections })
  },

  create: async (name) => {
    await window.veridian.collections.create(name)
    await get().load()
  },

  rename: async (id, name) => {
    await window.veridian.collections.rename(id, name)
    await get().load()
  },

  remove: async (id) => {
    await window.veridian.collections.delete(id)
    await get().load()
  },
}))
