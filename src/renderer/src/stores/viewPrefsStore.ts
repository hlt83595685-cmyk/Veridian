import { create } from 'zustand'

// Item-list display preferences, persisted in SettingsService under the single
// key `ui.itemList` (survives restart). The store holds the live values; every
// update writes the whole object back through settings.set.
export interface ItemListPrefs {
  titleFontSize: number   // px, clamped 14..26
  showJournal: boolean
  showYear: boolean
  showTags: boolean
}

const SETTINGS_KEY = 'ui.itemList'
const DEFAULTS: ItemListPrefs = {
  titleFontSize: 18,
  showJournal: true,
  showYear: true,
  showTags: true,
}

export const FONT_MIN = 14
export const FONT_MAX = 26

function clampFont(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)))
}

interface ViewPrefsStore {
  prefs: ItemListPrefs
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<ItemListPrefs>) => void
}

export const useViewPrefsStore = create<ViewPrefsStore>((set, get) => ({
  prefs: DEFAULTS,
  loaded: false,

  // Read once at startup; merge over DEFAULTS so a preferences object saved by
  // an older version (missing newer keys) still fills in sane values.
  load: async () => {
    try {
      const raw = (await window.veridian.settings.get(SETTINGS_KEY)) as Partial<ItemListPrefs> | null
      const prefs: ItemListPrefs = {
        ...DEFAULTS,
        ...(raw ?? {}),
        titleFontSize: clampFont(raw?.titleFontSize ?? DEFAULTS.titleFontSize),
      }
      set({ prefs, loaded: true })
    } catch (err) {
      console.error('[viewPrefsStore] load failed:', err)
      set({ loaded: true })
    }
  },

  update: (patch) => {
    const next: ItemListPrefs = { ...get().prefs, ...patch }
    if (patch.titleFontSize !== undefined) next.titleFontSize = clampFont(patch.titleFontSize)
    set({ prefs: next })
    void window.veridian.settings.set(SETTINGS_KEY, next).catch((err) => {
      console.error('[viewPrefsStore] persist failed:', err)
    })
  },
}))
