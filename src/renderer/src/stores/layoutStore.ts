import { create } from 'zustand'

// Draggable pane widths, persisted in SettingsService under `ui.layout`
// (survives restart). During a drag the setters update state live; persist()
// is called once on pointer-up so we don't hit IPC on every mouse move.
export interface LayoutPrefs {
  sidebarWidth: number
  detailWidth: number
}

const SETTINGS_KEY = 'ui.layout'
const DEFAULTS: LayoutPrefs = { sidebarWidth: 240, detailWidth: 320 }

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 400
export const DETAIL_MIN = 260
export const DETAIL_MAX = 560

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

interface LayoutStore {
  prefs: LayoutPrefs
  loaded: boolean
  load: () => Promise<void>
  setSidebarWidth: (n: number) => void
  setDetailWidth: (n: number) => void
  persist: () => void
}

export const useLayoutStore = create<LayoutStore>((set, get) => ({
  prefs: DEFAULTS,
  loaded: false,

  load: async () => {
    try {
      const raw = (await window.veridian.settings.get(SETTINGS_KEY)) as Partial<LayoutPrefs> | null
      set({
        prefs: {
          sidebarWidth: clamp(raw?.sidebarWidth ?? DEFAULTS.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX),
          detailWidth: clamp(raw?.detailWidth ?? DEFAULTS.detailWidth, DETAIL_MIN, DETAIL_MAX),
        },
        loaded: true,
      })
    } catch (err) {
      console.error('[layoutStore] load failed:', err)
      set({ loaded: true })
    }
  },

  setSidebarWidth: (n) =>
    set((s) => ({ prefs: { ...s.prefs, sidebarWidth: clamp(n, SIDEBAR_MIN, SIDEBAR_MAX) } })),
  setDetailWidth: (n) =>
    set((s) => ({ prefs: { ...s.prefs, detailWidth: clamp(n, DETAIL_MIN, DETAIL_MAX) } })),

  persist: () => {
    void window.veridian.settings.set(SETTINGS_KEY, get().prefs).catch((err) => {
      console.error('[layoutStore] persist failed:', err)
    })
  },
}))
