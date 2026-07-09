import { create } from 'zustand'
import type { LocalWorkspace } from '../../../shared/types'

interface WorkspaceStore {
  workspaces: LocalWorkspace[]
  /** null = the default personal library (always available). */
  activeWorkspaceId: number | null
  load: () => Promise<void>
  setActiveWorkspace: (id: number | null) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,

  load: async () => {
    try {
      const workspaces = await window.veridian.localWorkspaces.list()
      set({ workspaces })
    } catch (err) {
      console.error('[workspaceStore] load failed:', err)
    }
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
}))
