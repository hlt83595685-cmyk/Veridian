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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
