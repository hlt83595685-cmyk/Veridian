import { useEffect } from 'react'
import { MainLayout } from './components/layout/MainLayout'
import { useItemStore } from './stores/itemStore'
import { useCollectionStore } from './stores/collectionStore'
import { useStatusStore } from './stores/statusStore'
import { useWorkspaceStore } from './stores/workspaceStore'
import { useViewPrefsStore } from './stores/viewPrefsStore'
import { wireDomainEvents } from './data/queryCache'
import './i18n'

interface SavedViewer {
  type: 'pdf' | 'markdown' | 'gallery'
  path: string
  filename: string
}

function isSavedViewer(v: unknown): v is SavedViewer {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (o.type === 'pdf' || o.type === 'markdown' || o.type === 'gallery')
    && typeof o.path === 'string' && typeof o.filename === 'string'
}

export default function App(): JSX.Element {
  const { loadItems, selectedId, setSelectedId } = useItemStore()
  const { setStatus } = useStatusStore()

  useEffect(() => {
    if (!window.veridian) {
      console.error('[App] window.veridian is not defined — preload may have failed')
      return
    }
    // Event-driven refresh: any item/tag/collection mutation anywhere in the
    // app (including background conversion jobs) reloads the list store; the
    // query cache handles per-item panels on its own.
    wireDomainEvents((e) => {
      if (e.type.startsWith('item.') || e.type === 'tag.changed' || e.type === 'collection.changed') {
        useItemStore.getState().loadItems()
      }
      if (e.type === 'collection.changed' || e.type === 'workspace.dataRefreshed') {
        useCollectionStore.getState().load()
      }
      if (e.type === 'workspace.dataRefreshed') {
        // Whole data context replaced (workspace switch / remote pull):
        // reset selection and reload everything
        useItemStore.getState().setSelectedId(null)
        useItemStore.getState().loadItems()
      }
    })
    loadItems()
  }, [loadItems])

  // Session restore: reopen the workspace and reader that were active when
  // the app last quit. Runs once at startup; any failure (workspace since
  // deleted, file since moved) is caught and swallowed -- the app just falls
  // back to the personal library with no reader open, same as a fresh install.
  useEffect(() => {
    if (!window.veridian) return
    // Item-list display preferences (title font size, visible columns).
    void useViewPrefsStore.getState().load()
    void (async () => {
      const workspaceId = await window.veridian.settings.get('session.workspaceId')
      if (typeof workspaceId === 'number') {
        await useWorkspaceStore.getState().setActiveWorkspace(workspaceId)
      }
      const viewer = await window.veridian.settings.get('session.viewer')
      if (isSavedViewer(viewer)) {
        if (viewer.type === 'pdf') useItemStore.getState().openPdf(viewer.path, viewer.filename)
        else if (viewer.type === 'markdown') useItemStore.getState().openMarkdown(viewer.path, viewer.filename)
        else useItemStore.getState().openGallery(viewer.path, viewer.filename)
      }
    })().catch((err) => console.error('[App] session restore failed:', err))
  }, [])

  // Global pdf2md status feed
  useEffect(() => {
    window.veridian.onPdf2mdStatus((e) => setStatus(e))
    return () => window.veridian.offPdf2mdStatus()
  }, [setStatus])

  // Safety net for drag-and-drop import: without a window-level preventDefault,
  // a file dropped ANYWHERE outside the list's drop zone makes Chromium
  // navigate to it (the PDF replaces the whole app). The ItemListPane handler
  // still does the actual import on its own zone; this only stops stray drops.
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  // Global Delete key — trash selected item
  useEffect(() => {
    const handler = async (e: KeyboardEvent): Promise<void> => {
      if (e.key !== 'Delete') return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (selectedId === null) return
      e.preventDefault()
      try {
        await window.veridian.items.trash(selectedId)
        setSelectedId(null)
        // no manual reload -- item.trashed event refreshes the list
      } catch (err) {
        console.error('[App] trash failed:', err)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedId, setSelectedId])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <MainLayout />
    </div>
  )
}
