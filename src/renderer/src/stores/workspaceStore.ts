import { create } from 'zustand'
import type { Workspace, ControlPlaneStatus } from '../../../shared/types'

interface WorkspaceStore {
  status: ControlPlaneStatus
  workspaces: Workspace[]
  /** null = the local personal library (default, always available). */
  activeWorkspaceId: string | null
  loadStatus: () => Promise<void>
  loadWorkspaces: () => Promise<void>
  setActiveWorkspace: (id: string | null) => void
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  status: { configured: false, signedIn: false, email: null },
  workspaces: [],
  activeWorkspaceId: null,

  loadStatus: async () => {
    const status = await window.veridian.controlPlane.getStatus()
    set({ status })
    if (status.signedIn) await get().loadWorkspaces()
    else set({ workspaces: [], activeWorkspaceId: null })
  },

  loadWorkspaces: async () => {
    try {
      const workspaces = await window.veridian.workspaces.list()
      set({ workspaces })
    } catch (err) {
      console.error('[workspaceStore] loadWorkspaces failed:', err)
    }
  },

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
}))
