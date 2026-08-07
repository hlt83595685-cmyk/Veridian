import { create } from 'zustand'

// Item-list display preferences, persisted in SettingsService under the single
// key `ui.itemList` (survives restart). The store holds the live values; every
// update writes the whole object back through settings.set.
export interface ItemListPrefs {
  titleFontSize: number   // px, clamped 14..26
  thumbSize: number       // figure-strip thumbnail px, clamped 32..96
  showJournal: boolean
  showYear: boolean
  showTags: boolean
}

const SETTINGS_KEY = 'ui.itemList'
const DEFAULTS: ItemListPrefs = {
  titleFontSize: 18,
  thumbSize: 52,
  showJournal: true,
  showYear: true,
  showTags: true,
}

export const FONT_MIN = 14
export const FONT_MAX = 26
export const THUMB_MIN = 32
export const THUMB_MAX = 96

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)))
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
        titleFontSize: clamp(raw?.titleFontSize ?? DEFAULTS.titleFontSize, FONT_MIN, FONT_MAX),
        thumbSize: clamp(raw?.thumbSize ?? DEFAULTS.thumbSize, THUMB_MIN, THUMB_MAX),
      }
      set({ prefs, loaded: true })
    } catch (err) {
      console.error('[viewPrefsStore] load failed:', err)
      set({ loaded: true })
    }
  },

  update: (patch) => {
    const next: ItemListPrefs = { ...get().prefs, ...patch }
    if (patch.titleFontSize !== undefined) next.titleFontSize = clamp(patch.titleFontSize, FONT_MIN, FONT_MAX)
    if (patch.thumbSize !== undefined) next.thumbSize = clamp(patch.thumbSize, THUMB_MIN, THUMB_MAX)
    set({ prefs: next })
    void window.veridian.settings.set(SETTINGS_KEY, next).catch((err) => {
      console.error('[viewPrefsStore] persist failed:', err)
    })
  },
}))
