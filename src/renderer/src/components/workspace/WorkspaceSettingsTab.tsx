import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../../stores/workspaceStore'

// Settings → Workspace tab: connect to a self-hosted control plane
// (control-plane/) and sign in. Entirely optional -- the local personal
// library works unmodified if this is never touched.
export function WorkspaceSettingsTab(): JSX.Element {
  const { t } = useTranslation('common')
  const { status, loadStatus } = useWorkspaceStore()

  const [url, setUrl] = useState('')
  const [anonKey, setAnonKey] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadStatus()
    window.veridian.settings.get('controlPlane.url').then((v) => {
      if (typeof v === 'string') setUrl(v)
    })
  }, [loadStatus])

  const saveConnection = async (): Promise<void> => {
    if (!url.trim() || !anonKey.trim()) return
    setBusy(true)
    setError(null)
    try {
      await window.veridian.controlPlane.configure(url.trim(), anonKey.trim())
      await loadStatus()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const signIn = async (): Promise<void> => {
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.veridian.controlPlane.signIn(email.trim(), password)
      if (result.error) setError(result.error)
      else { setPassword(''); await loadStatus() }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.veridian.controlPlane.signOut()
      await loadStatus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section label={t('workspace.connect.title')}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {t('workspace.connect.desc')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('workspace.connect.urlPlaceholder')}
            style={inputStyle}
          />
          <input
            value={anonKey}
            onChange={(e) => setAnonKey(e.target.value)}
            placeholder={t('workspace.connect.anonKey')}
            type="password"
            style={inputStyle}
          />
          <button onClick={saveConnection} disabled={busy} style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }}>
            {t('workspace.connect.save')}
          </button>
        </div>

        <div style={{
          marginTop: 10, fontSize: 12, fontWeight: 600,
          color: status.configured ? 'var(--accent-green)' : 'var(--muted)',
        }}>
          {status.configured ? t('workspace.connect.connected') : t('workspace.connect.notConfigured')}
        </div>
      </Section>

      {status.configured && (
        <Section label={t('workspace.auth.email')}>
          {status.signedIn ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: 'var(--foreground)' }}>
                {t('workspace.auth.signedInAs', { email: status.email })}
              </span>
              <button onClick={signOut} disabled={busy} style={secondaryBtnStyle}>
                {t('workspace.auth.signOut')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('workspace.auth.email')}
                type="email"
                style={inputStyle}
              />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('workspace.auth.password')}
                type="password"
                style={inputStyle}
              />
              <button onClick={signIn} disabled={busy} style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }}>
                {t('workspace.auth.signIn')}
              </button>
            </div>
          )}
        </Section>
      )}

      {error && (
        <div style={{ fontSize: 12, color: 'var(--accent)', padding: '4px 2px' }}>
          {error}
        </div>
      )}
    </div>
  )
}

// ── Shared (mirrors SettingsDialog.tsx's local style conventions) ───────────

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

const inputStyle: React.CSSProperties = {
  height: 32, padding: '0 10px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)',
  fontSize: 12, color: 'var(--foreground)',
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
