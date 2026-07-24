import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

// Settings → GitHub tab: the per-device GitHub PAT is the only credential in
// the local-first workspace model -- identity and permissions for shared
// workspaces are GitHub's own repo-collaborator system, so there is no
// account/sign-in here. (The old control-plane connect/sign-in UI was
// removed along with that model; the dormant main-process client remains
// for a possible future cloud-account mode.)
export function WorkspaceSettingsTab(): JSX.Element {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<{ authed: boolean; login: string | null; avatarUrl: string | null; error: string | null }>(
    { authed: false, login: null, avatarUrl: null, error: null }
  )
  const [pending, setPending] = useState<{ userCode: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setStatus(await window.veridian.github.getStatus())
  }

  useEffect(() => {
    refresh()
    const onEvent = (e: { type: string }): void => {
      if (e.type === 'github.authChanged') { setPending(null); setBusy(false); refresh() }
    }
    window.veridian.onDomainEvent(onEvent)
    return () => window.veridian.offDomainEvent(onEvent)
  }, [])

  const login = async (): Promise<void> => {
    setBusy(true)
    try {
      const { userCode } = await window.veridian.github.loginStart()
      setPending({ userCode })
    } catch {
      setBusy(false)
    }
  }

  const cancelLogin = async (): Promise<void> => {
    await window.veridian.github.loginCancel()
    setPending(null); setBusy(false)
  }

  const logout = async (): Promise<void> => {
    await window.veridian.github.logout()
    await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section label={t('workspace.github.title')}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {t('workspace.github.desc')}
        </div>

        {status.authed && status.login ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {status.avatarUrl && (
                <img src={status.avatarUrl} alt="" width={22} height={22}
                  style={{ borderRadius: '50%' }} />
              )}
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-green)' }}>
                {t('workspace.github.connectedAs', { login: status.login })}
              </span>
            </span>
            <button onClick={logout} style={secondaryBtnStyle}>
              {t('workspace.github.logout')}
            </button>
          </div>
        ) : pending ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--foreground)' }}>
              {t('workspace.github.deviceHint')}
            </div>
            <div style={{
              fontSize: 22, fontWeight: 700, letterSpacing: '0.15em',
              fontFamily: 'ui-monospace, monospace', color: 'var(--primary)',
              padding: '8px 12px', background: 'var(--surface)', borderRadius: 8,
              textAlign: 'center', userSelect: 'all',
            }}>
              {pending.userCode}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('workspace.github.deviceWaiting')}
            </div>
            <button onClick={cancelLogin} style={secondaryBtnStyle}>
              {t('workspace.github.cancel')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={login} disabled={busy} style={primaryBtnStyle}>
              {t('workspace.github.loginButton')}
            </button>
            {status.error && (
              <div style={{ fontSize: 12, color: 'var(--accent)' }}>{status.error}</div>
            )}
          </div>
        )}
      </Section>
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
