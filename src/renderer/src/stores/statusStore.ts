import { create } from 'zustand'

export interface Pdf2mdStatus {
  jobType: string   // JobQueue type, e.g. 'pdf2md' | 'workspace.sync' -- the bar's left badge
  filename: string
  state: 'running' | 'done' | 'error' | 'idle'
  message: string
  chunk?: string
  pending: number   // jobs still waiting (excluding current)
  progress?: number // 0..1 completion of the current job; absent = indeterminate
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
