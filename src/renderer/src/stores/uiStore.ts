import { create } from 'zustand'

// Which full-page view occupies the center area. 'library' is the normal
// item list / viewers; 'settings' and 'tools' replace it entirely (page
// switch, not modal) -- entered from the sidebar's bottom icon bar.
export type AppPage = 'library' | 'settings' | 'tools'

interface UiStore {
  page: AppPage
  setPage: (page: AppPage) => void
}

export const useUiStore = create<UiStore>((set) => ({
  page: 'library',
  setPage: (page) => set({ page }),
}))
