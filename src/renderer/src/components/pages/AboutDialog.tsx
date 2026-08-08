import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateCheckResult } from '../../../../shared/types'

const REPO_URL = 'https://github.com/hlt83595685-cmyk/Veridian'

export function AboutDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation('common')
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  useEffect(() => {
    window.veridian.app.version().then(setVersion).catch(() => setVersion('?'))
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const check = async (): Promise<void> => {
    setChecking(true)
    setResult(null)
    try {
      setResult(await window.veridian.updates.check())
    } catch (err) {
      setResult({ status: 'error', message: (err as Error).message })
    } finally {
      setChecking(false)
    }
  }

  const status = (): { text: string; color: string } | null => {
    if (checking) return { text: t('about.checking'), color: 'var(--muted)' }
    if (!result) return null
    switch (result.status) {
      case 'dev':           return { text: t('about.devOnly'), color: 'var(--muted)' }
      case 'not-available': return { text: t('about.upToDate', { version: result.version }), color: 'var(--accent-green)' }
      case 'available':     return { text: t('about.available', { version: result.version }), color: 'var(--primary)' }
      case 'error':         return { text: t('about.checkFailed', { detail: result.message }), color: 'var(--accent)' }
    }
  }
  const st = status()

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
        width: 420, borderRadius: 14, background: 'var(--surface)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden',
      }}>
        <div style={{
          padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--separator)',
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)' }}>
            {t('about.title')}
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

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Version */}
          <Row label={t('about.version')}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>
              Veridian v{version || '…'}
            </span>
          </Row>

          {/* Repo */}
          <Row label={t('about.repo')}>
            <a
              href={REPO_URL}
              onClick={(e) => { e.preventDefault(); window.veridian.tools.openExternal(REPO_URL).catch(() => {}) }}
              style={{ fontSize: 13, color: 'var(--primary)', cursor: 'pointer', textDecoration: 'none' }}
            >
              hlt83595685-cmyk/Veridian ↗
            </a>
          </Row>

          {/* Update check */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              onClick={check}
              disabled={checking}
              style={{
                alignSelf: 'flex-start',
                height: 32, padding: '0 16px', borderRadius: 8, border: 'none',
                background: 'var(--primary)', color: '#fff',
                fontSize: 13, fontWeight: 600, cursor: checking ? 'default' : 'pointer',
                opacity: checking ? 0.6 : 1,
              }}
            >
              {checking ? t('about.checking') : t('about.checkBtn')}
            </button>
            {st && <div style={{ fontSize: 12, color: st.color, lineHeight: 1.5 }}>{st.text}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      {children}
    </div>
  )
}
