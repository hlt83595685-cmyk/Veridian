import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MainLayout } from './components/layout/MainLayout'
import { SettingsDialog } from './components/tools/SettingsDialog'
import { ToolsDialog } from './components/tools/ToolsDialog'
import { useItemStore } from './stores/itemStore'
import { useStatusStore } from './stores/statusStore'
import { wireDomainEvents } from './data/queryCache'
import './i18n'

export default function App(): JSX.Element {
  const { loadItems, selectedId, setSelectedId } = useItemStore()
  const { setStatus } = useStatusStore()
  const { i18n } = useTranslation('common')
  const [settingsTab, setSettingsTab] = useState<string | null>(null)
  const [toolsTab, setToolsTab] = useState<string | null>(null)

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
    })
    loadItems()
  }, [loadItems])

  // Menu → open tools dialog
  useEffect(() => {
    window.veridian.onToolsOpen((tab) => setToolsTab(tab))
    return () => window.veridian.offToolsOpen()
  }, [])

  // Menu → open settings dialog
  useEffect(() => {
    window.veridian.onSettingsOpen((tab) => setSettingsTab(tab))
    return () => window.veridian.offSettingsOpen()
  }, [])

  // Menu → language change (menu radio clicked)
  useEffect(() => {
    window.veridian.onSetLocale((locale) => { i18n.changeLanguage(locale) })
    return () => window.veridian.offSetLocale()
  }, [i18n])

  // Global pdf2md status feed
  useEffect(() => {
    window.veridian.onPdf2mdStatus((e) => setStatus(e))
    return () => window.veridian.offPdf2mdStatus()
  }, [setStatus])

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
      {toolsTab !== null && (
        <ToolsDialog
          initialTab={toolsTab}
          onClose={() => setToolsTab(null)}
        />
      )}
      {settingsTab !== null && (
        <SettingsDialog
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </div>
  )
}
