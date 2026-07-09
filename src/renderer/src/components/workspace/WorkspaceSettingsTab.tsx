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
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

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

  const submitAuth = async (): Promise<void> => {
    if (!email.trim() || !password) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'signUp') {
        const result = await window.veridian.controlPlane.signUp(email.trim(), password)
        if (result.error) setError(result.error)
        else { setPassword(''); setMode('signIn'); setInfo(t('workspace.auth.signUpSuccess')) }
      } else {
        const result = await window.veridian.controlPlane.signIn(email.trim(), password)
        if (result.error) setError(result.error)
        else { setPassword(''); await loadStatus() }
      }
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={submitAuth} disabled={busy} style={primaryBtnStyle}>
                  {mode === 'signUp' ? t('workspace.auth.signUp') : t('workspace.auth.signIn')}
                </button>
                <button
                  onClick={() => { setMode(mode === 'signUp' ? 'signIn' : 'signUp'); setError(null); setInfo(null) }}
                  style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer' }}
                >
                  {mode === 'signUp' ? t('workspace.auth.toggleToSignIn') : t('workspace.auth.toggleToSignUp')}
                </button>
              </div>
            </div>
          )}
        </Section>
      )}

      <GitHubSection />

      {info && (
        <div style={{ fontSize: 12, color: 'var(--accent-green)', padding: '4px 2px' }}>
          {info}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: 'var(--accent)', padding: '4px 2px' }}>
          {error}
        </div>
      )}
    </div>
  )
}

// ── GitHub PAT (per-device data-plane credential) ─────────────────────────────

function GitHubSection(): JSX.Element {
  const { t } = useTranslation('common')
  const [ghStatus, setGhStatus] = useState<{ hasPat: boolean; login: string | null; error: string | null }>(
    { hasPat: false, login: null, error: null }
  )
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setGhStatus(await window.veridian.github.getStatus())
  }

  useEffect(() => { refresh() }, [])

  const save = async (): Promise<void> => {
    if (!pat.trim()) return
    setBusy(true)
    try {
      await window.veridian.github.setPat(pat.trim())
      setPat('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.veridian.github.setPat('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section label={t('workspace.github.title')}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
        {t('workspace.github.desc')}
      </div>

      {ghStatus.hasPat && ghStatus.login ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-green)' }}>
            {t('workspace.github.connectedAs', { login: ghStatus.login })}
          </span>
          <button onClick={clear} disabled={busy} style={secondaryBtnStyle}>
            {t('workspace.github.clear')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder={t('workspace.github.patPlaceholder')}
            type="password"
            style={inputStyle}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={save} disabled={busy} style={primaryBtnStyle}>
              {t('workspace.github.save')}
            </button>
            <button
              onClick={() => window.veridian.tools.openExternal('https://github.com/settings/personal-access-tokens/new')}
              style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer' }}
            >
              {t('workspace.github.openTokenPage')}
            </button>
          </div>
          {ghStatus.hasPat && ghStatus.error && (
            <div style={{ fontSize: 12, color: 'var(--accent)' }}>{ghStatus.error}</div>
          )}
        </div>
      )}
    </Section>
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
