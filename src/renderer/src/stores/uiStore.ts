import { create } from 'zustand'

// Which full-page view occupies the center area. 'library' is the normal
// item list / viewers; 'settings' and 'tools' replace it entirely (page
// switch, not modal) -- entered from the sidebar's bottom icon bar.
export type AppPage = 'library' | 'settings' | 'tools' | 'knowledge' | 'stable'

interface UiStore {
  page: AppPage
  setPage: (page: AppPage) => void
  // Which settings tab to open next (consumed once by SettingsPage), e.g. from the
  // reader's "go to plugin settings" link.
  settingsTab: string | null
  setSettingsTab: (tab: string | null) => void
}

export const useUiStore = create<UiStore>((set) => ({
  page: 'library',
  setPage: (page) => set({ page }),
  settingsTab: null,
  setSettingsTab: (settingsTab) => set({ settingsTab }),
}))
