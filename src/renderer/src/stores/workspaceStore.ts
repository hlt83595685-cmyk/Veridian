import { create } from 'zustand'
import type { LocalWorkspace } from '../../../shared/types'

interface WorkspaceStore {
  workspaces: LocalWorkspace[]
  /** null = the default personal library (always available). */
  activeWorkspaceId: number | null
  /** True while the main process clones/imports during a switch. */
  switching: boolean
  switchError: string | null
  load: () => Promise<void>
  setActiveWorkspace: (id: number | null) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  switching: false,
  switchError: null,

  load: async () => {
    try {
      const workspaces = await window.veridian.localWorkspaces.list()
      set({ workspaces })
    } catch (err) {
      console.error('[workspaceStore] load failed:', err)
    }
  },

  // The switch is a main-process operation (close/open index db, clone the
  // repo on first activation, rebuild the index from files) -- the UI only
  // flips after it succeeds; on failure the previous workspace stays active.
  setActiveWorkspace: async (id) => {
    if (get().switching || id === get().activeWorkspaceId) return
    set({ switching: true, switchError: null })
    try {
      await window.veridian.workspace.setActive(id)
      set({ activeWorkspaceId: id })
    } catch (err) {
      const msg = (err as Error).message
      set({ switchError: msg === 'no_pat' ? 'no_pat' : msg })
      console.error('[workspaceStore] switch failed:', err)
    } finally {
      set({ switching: false })
    }
  },
}))
