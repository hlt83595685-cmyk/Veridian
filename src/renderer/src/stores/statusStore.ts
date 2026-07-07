import { create } from 'zustand'

export interface Pdf2mdStatus {
  filename: string
  state: 'running' | 'done' | 'error' | 'idle'
  message: string
  chunk?: string
  pending: number   // jobs still waiting (excluding current)
}

interface StatusStore {
  pdf2md: Pdf2mdStatus | null
  setStatus: (s: Pdf2mdStatus) => void
  clear: () => void
}

export const useStatusStore = create<StatusStore>((set) => ({
  pdf2md: null,
  setStatus: (s) => set({ pdf2md: s }),
  clear: () => set({ pdf2md: null }),
}))
