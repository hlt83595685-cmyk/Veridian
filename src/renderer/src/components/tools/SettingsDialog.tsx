import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { WorkspaceSettingsTab } from '../workspace/WorkspaceSettingsTab'

interface Props {
  initialTab?: string
  onClose: () => void
}

type Tab = 'storage' | 'language' | 'workspace'

export function SettingsDialog({ initialTab = 'storage', onClose }: Props): JSX.Element {
  const { t } = useTranslation('common')
  const [tab, setTab] = useState<Tab>(initialTab as Tab)

  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'storage',   label: t('settings.storage.title') },
    { id: 'language',  label: t('settings.language.title') },
    { id: 'workspace', label: t('workspace.title') },
  ]

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 500,
        borderRadius: 14,
        background: 'var(--surface)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* Title bar */}
        <div style={{
          padding: '18px 22px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)' }}>
            {t('settings.title')}
          </span>
          <button
            onClick={onClose}
            style={{
              width: 26, height: 26, borderRadius: '50%',
              border: 'none', background: 'var(--muted-bg)',
              color: 'var(--muted)', fontSize: 13, cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* Tab bar */}
        <div style={{
          display: 'flex', gap: 4, padding: '12px 22px 0',
          borderBottom: '1px solid var(--separator)',
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

        {/* Tab content */}
        <div style={{ padding: '20px 22px 22px', flex: 1, overflow: 'auto' }}>
          {tab === 'storage'   && <StorageTab />}
          {tab === 'language'  && <LanguageTab />}
          {tab === 'workspace' && <WorkspaceSettingsTab />}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 22px',
          borderTop: '1px solid var(--separator)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button onClick={onClose} style={secondaryBtnStyle}>{t('settings.close')}</button>
        </div>
      </div>
    </div>
  )
}

// ── Storage tab ───────────────────────────────────────────────────────────────

function StorageTab(): JSX.Element {
  const { t } = useTranslation('common')
  const [storagePath, setStoragePath] = useState<string>('')

  useEffect(() => {
    window.veridian.settings.get('storage.path').then((v) => {
      if (typeof v === 'string') setStoragePath(v)
    })
  }, [])

  const browse = async (): Promise<void> => {
    const picked = await window.veridian.settings.pickStoragePath()
    if (picked) setStoragePath(picked)
  }

  const clear = (): void => {
    setStoragePath('')
    window.veridian.settings.set('storage.path', '')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section label={t('settings.storage.label')}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {t('settings.storage.desc')}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{
            flex: 1, padding: '7px 10px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--muted-bg)',
            fontSize: 12, color: storagePath ? 'var(--foreground)' : 'var(--muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {storagePath || t('settings.storage.placeholder')}
          </div>
          <button onClick={browse} style={primaryBtnStyle}>
            {t('settings.storage.browse')}
          </button>
          {storagePath && (
            <button onClick={clear} style={secondaryBtnStyle} title="Reset to default">✕</button>
          )}
        </div>
        {storagePath && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
            {t('settings.storage.current')}: <code style={{ fontSize: 11 }}>{storagePath}</code>
          </div>
        )}
      </Section>
    </div>
  )
}

// ── Language tab ──────────────────────────────────────────────────────────────

function LanguageTab(): JSX.Element {
  const { t, i18n: i18nInst } = useTranslation('common')
  const currentLang = i18nInst.language

  const setLang = (lang: string): void => {
    i18n.changeLanguage(lang)
    window.veridian.settings.notifyLocale(lang)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section label={t('settings.language.label')}>
        <div style={{ display: 'flex', gap: 10 }}>
          {(['zh', 'en'] as const).map((lang) => (
            <button
              key={lang}
              onClick={() => setLang(lang)}
              style={{
                height: 36, padding: '0 20px', borderRadius: 10,
                border: currentLang === lang
                  ? '2px solid var(--primary)'
                  : '1px solid var(--border)',
                background: currentLang === lang ? 'rgba(0,122,255,0.08)' : 'var(--surface)',
                color: currentLang === lang ? 'var(--primary)' : 'var(--foreground-2)',
                fontSize: 13, fontWeight: currentLang === lang ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              {lang === 'zh' ? t('settings.language.zh') : t('settings.language.en')}
            </button>
          ))}
        </div>
      </Section>
    </div>
  )
}

// ── Shared ────────────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {label}
      </div>
      <div style={{
        padding: '12px 14px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
      }}>
        {children}
      </div>
    </div>
  )
}

const primaryBtnStyle: React.CSSProperties = {
  height: 32, padding: '0 16px', borderRadius: 8,
  border: 'none', background: 'var(--primary)',
  color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}

const secondaryBtnStyle: React.CSSProperties = {
  height: 32, padding: '0 16px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--foreground-2)', fontSize: 13, cursor: 'pointer',
}
