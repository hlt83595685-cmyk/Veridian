import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { StorageTab, LanguageTab } from '../tools/SettingsDialog'
import { WorkspaceSettingsTab } from '../workspace/WorkspaceSettingsTab'

type Tab = 'storage' | 'language' | 'github'

// Full-page settings view (replaces the old native-menu-driven modal).
// Entered via the sidebar's bottom gear icon; Esc or the back button
// returns to the library.
export function SettingsPage(): JSX.Element {
  const { t } = useTranslation('common')
  const setPage = useUiStore((s) => s.setPage)
  const [tab, setTab] = useState<Tab>('storage')

  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') setPage('library') }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [setPage])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'storage',  label: t('settings.storage.title') },
    { id: 'language', label: t('settings.language.title') },
    { id: 'github',   label: 'GitHub' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Page header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 16px', height: 46, flexShrink: 0,
        borderBottom: '1px solid var(--separator)',
        background: 'var(--bg-elevated)',
      }}>
        <button
          onClick={() => setPage('library')}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            height: 30, padding: '0 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--foreground-2)',
            fontSize: 12, fontWeight: 500,
            boxShadow: 'var(--shadow-xs)',
            flexShrink: 0,
          }}
        >
          ← {t('page.back')}
        </button>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--foreground)' }}>
          {t('settings.title')}
        </span>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, padding: '12px 22px 0',
        borderBottom: '1px solid var(--separator)', flexShrink: 0,
      }}>
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              height: 32, padding: '0 14px', borderRadius: '8px 8px 0 0',
              border: 'none',
              background: tab === id ? 'var(--surface-2)' : 'transparent',
              color: tab === id ? 'var(--foreground)' : 'var(--muted)',
              fontSize: 13, fontWeight: tab === id ? 600 : 400,
              cursor: 'pointer',
              borderBottom: tab === id ? '2px solid var(--primary)' : '2px solid transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: '20px 22px 22px', flex: 1, overflow: 'auto', maxWidth: 620 }}>
        {tab === 'storage'  && <StorageTab />}
        {tab === 'language' && <LanguageTab />}
        {tab === 'github'   && <WorkspaceSettingsTab />}
      </div>
    </div>
  )
}
