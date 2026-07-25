import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { WorkspaceDialog } from './WorkspaceDialog'

// Toolbar dropdown: pick between the personal library (default) and any
// local workspace (private, or bound to a GitHub repo). Purely a UI-state
// switch here -- which data the rest of the app reads from is wired up when
// the data-plane sync engine lands.
export function WorkspaceSwitcher(): JSX.Element {
  const { t } = useTranslation('common')
  const { workspaces, activeWorkspaceId, switching, switchError, load, setActiveWorkspace } = useWorkspaceStore()
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [identity, setIdentity] = useState<{ authed: boolean; login: string | null; avatarUrl: string | null }>(
    { authed: false, login: null, avatarUrl: null }
  )
  const [invitations, setInvitations] = useState<Array<{
    id: number; repoOwner: string; repoName: string; repoFullName: string; inviterLogin: string
  }>>([])
  const rootRef = useRef<HTMLDivElement>(null)

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)

  useEffect(() => {
    load()
    const refreshIdentity = (): void => {
      window.veridian.github.getStatus().then((s) =>
        setIdentity({ authed: s.authed, login: s.login, avatarUrl: s.avatarUrl }))
    }
    refreshIdentity()
    // workspace.changed events (create/remove from the dialog) refresh the list
    const onEvent = (e: { type: string }): void => {
      if (e.type === 'workspace.changed') load()
      if (e.type === 'github.authChanged') refreshIdentity()
    }
    window.veridian.onDomainEvent(onEvent)
    return () => window.veridian.offDomainEvent(onEvent)
  }, [load])

  // One-time fetch on mount -- no polling, matches the "check once at
  // startup" decision to avoid background network chatter.
  useEffect(() => {
    window.veridian.github.listInvitations().then(setInvitations).catch(() => {})
  }, [])

  const respondInvitation = async (id: number, accept: boolean): Promise<void> => {
    try {
      if (accept) await window.veridian.github.acceptInvitation(id)
      else await window.veridian.github.declineInvitation(id)
      setInvitations((prev) => prev.filter((i) => i.id !== id))
    } catch (err) {
      console.error('[WorkspaceSwitcher] invitation response failed:', err)
    }
  }

  useEffect(() => {
    if (!open) return
    // Close only on mousedown OUTSIDE -- see the identical pattern note in
    // ItemListPane's context menu.
    const close = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const activeLabel = activeWorkspaceId === null
    ? t('workspace.personalLibrary')
    : workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? t('workspace.personalLibrary')

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', gap: 6,
          height: 32, padding: '0 12px', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--foreground-2)', fontSize: 13, fontWeight: 500,
          boxShadow: 'var(--shadow-xs)', maxWidth: 180,
        }}
      >
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {switching ? t('workspace.switching') : activeLabel}
        </span>
        <span style={{ fontSize: 9, color: 'var(--muted)' }}>▾</span>
        {invitations.length > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            width: 8, height: 8, borderRadius: '50%',
            background: '#e5484d', border: '1px solid var(--surface)',
          }} />
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 38, left: 0, zIndex: 100, minWidth: 220,
          background: 'rgba(255,255,255,0.94)',
          backdropFilter: 'blur(20px) saturate(180%)',
          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)', padding: 4,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 12px', fontSize: 12, color: 'var(--muted)',
            borderBottom: '1px solid var(--separator)', marginBottom: 4,
          }}>
            {identity.authed && identity.avatarUrl ? (
              <>
                <img src={identity.avatarUrl} alt="" width={18} height={18} style={{ borderRadius: '50%' }} />
                <span style={{ color: 'var(--foreground)', fontWeight: 600 }}>{identity.login}</span>
              </>
            ) : (
              <span>{t('workspace.github.notConnected')}</span>
            )}
          </div>
          {invitations.length > 0 && (
            <div style={{ padding: '4px 8px 8px', borderBottom: '1px solid var(--separator)', marginBottom: 4 }}>
              {invitations.map((inv) => (
                <div key={inv.id} style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  padding: '6px 4px', fontSize: 12,
                }}>
                  <span style={{ color: 'var(--foreground)' }}>
                    {t('workspace.invite.receivedFrom', { login: inv.inviterLogin, repo: inv.repoFullName })}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => respondInvitation(inv.id, true)}
                      style={{ ...primaryBtnStyle, height: 24, padding: '0 10px', fontSize: 11 }}
                    >
                      {t('workspace.invite.accept')}
                    </button>
                    <button
                      onClick={() => respondInvitation(inv.id, false)}
                      style={{ ...secondaryBtnStyle, height: 24, padding: '0 10px', fontSize: 11 }}
                    >
                      {t('workspace.invite.decline')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Row
            label={t('workspace.personalLibrary')}
            active={activeWorkspaceId === null}
            onClick={() => { setActiveWorkspace(null); setOpen(false) }}
          />
          {workspaces.map((w) => (
            <Row
              key={w.id}
              label={w.kind === 'github' ? `${w.name} · ${w.repo_owner}/${w.repo_name}` : w.name}
              active={activeWorkspaceId === w.id}
              onClick={() => { setActiveWorkspace(w.id); setOpen(false) }}
            />
          ))}
          <div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />
          {activeWs?.kind === 'github' && (
            <Row
              label={t('workspace.syncNow')}
              onClick={() => { window.veridian.workspace.syncNow().catch(console.error); setOpen(false) }}
            />
          )}
          <Row label={t('workspace.manage')} onClick={() => { setDialogOpen(true); setOpen(false) }} />
          {switchError && (
            <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--accent)' }}>
              {switchError === 'no_pat' ? t('workspace.github.noPat') : switchError}
            </div>
          )}
        </div>
      )}

      {dialogOpen && <WorkspaceDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}

function Row({ label, active, onClick }: { label: string; active?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', width: '100%',
        padding: '7px 12px', borderRadius: 'var(--radius-md)', border: 'none',
        background: active ? 'var(--primary-light)' : 'transparent',
        color: active ? 'var(--primary)' : 'var(--foreground)',
        fontWeight: active ? 600 : 500,
        fontSize: 13, textAlign: 'left',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
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
  color: 'var(--foreground-2)', fontSize: 13, cursor: 'pointer', flexShrink: 0,
}
