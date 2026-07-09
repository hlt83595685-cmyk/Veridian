import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useUiStore } from '../../stores/uiStore'
import { Pdf2mdTab } from '../tools/ToolsDialog'

// Full-page tools view (replaces the old native-menu-driven modal).
// Entered via the sidebar's bottom wrench icon; Esc or the back button
// returns to the library.
export function ToolsPage(): JSX.Element {
  const { t } = useTranslation('common')
  const setPage = useUiStore((s) => s.setPage)

  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') setPage('library') }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [setPage])

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
          {t('tools.pdf2md.title')}
        </span>
      </div>

      {/* Content */}
      <div style={{ padding: '20px 22px 22px', flex: 1, overflow: 'auto', maxWidth: 620 }}>
        <Pdf2mdTab />
      </div>
    </div>
  )
}
