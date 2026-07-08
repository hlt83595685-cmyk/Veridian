import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workspace, WorkspaceMember, WorkspaceInvite, MemberRole, SyncBackendType } from '../../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspaceStore'

interface Props {
  onClose: () => void
}

// Modal chrome mirrors SettingsDialog.tsx: overlay + rounded card + tab bar.
// Two views: browse/create workspaces, and (once one is picked) manage its
// members + pending invites.
export function WorkspaceDialog({ onClose }: Props): JSX.Element {
  const { t } = useTranslation('common')
  const { workspaces, loadWorkspaces } = useWorkspaceStore()
  const [selected, setSelected] = useState<Workspace | null>(null)

  useEffect(() => { loadWorkspaces() }, [loadWorkspaces])

  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

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
        width: 560, maxHeight: '80vh',
        borderRadius: 14, background: 'var(--surface)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--separator)',
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)' }}>
            {selected ? selected.name : t('workspace.title')}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {selected && (
              <button onClick={() => setSelected(null)} style={secondaryBtnStyle}>
                ← {t('workspace.title')}
              </button>
            )}
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
        </div>

        <div style={{ padding: 22, flex: 1, overflow: 'auto' }}>
          {selected
            ? <MembersView workspace={selected} />
            : <ListView workspaces={workspaces} onSelect={setSelected} onCreated={setSelected} />
          }
        </div>
      </div>
    </div>
  )
}

// ── Browse + create ───────────────────────────────────────────────────────────

function ListView({ workspaces, onSelect, onCreated }: {
  workspaces: Workspace[]
  onSelect: (w: Workspace) => void
  onCreated: (w: Workspace) => void
}): JSX.Element {
  const { t } = useTranslation('common')
  const { loadWorkspaces } = useWorkspaceStore()

  const [name, setName] = useState('')
  const [kind, setKind] = useState<'private' | 'shared'>('private')
  const [backend, setBackend] = useState<SyncBackendType>('git')
  const [repoUrl, setRepoUrl] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roleLabel = (role: MemberRole): string => t(`workspace.members.role${cap(role)}`)

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    const config = backend === 'git' ? { repoUrl: repoUrl.trim() } : { folderPath: folderPath.trim() }
    setBusy(true)
    setError(null)
    try {
      const ws = await window.veridian.workspaces.create(name.trim(), kind, backend, config)
      setName(''); setRepoUrl(''); setFolderPath('')
      await loadWorkspaces()
      onCreated(ws)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {workspaces.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {workspaces.map((w) => (
            <button
              key={w.id}
              onClick={() => onSelect(w)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', borderRadius: 10,
                border: '1px solid var(--border)', background: 'var(--surface-2)',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>{w.name}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {w.my_role ? roleLabel(w.my_role) : ''} · {w.sync_backend_type === 'git' ? 'GitHub' : t('workspace.create.backendCloudFolder')}
              </span>
            </button>
          ))}
        </div>
      )}
      {workspaces.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('workspace.empty')}</div>
      )}

      <div style={{
        padding: '14px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>
          {t('workspace.create.title')}
        </div>
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t('workspace.create.namePlaceholder')} style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'private' | 'shared')} style={{ ...inputStyle, flex: 1 }}>
            <option value="private">{t('workspace.create.kindPrivate')}</option>
            <option value="shared">{t('workspace.create.kindShared')}</option>
          </select>
          <select value={backend} onChange={(e) => setBackend(e.target.value as SyncBackendType)} style={{ ...inputStyle, flex: 1 }}>
            <option value="git">{t('workspace.create.backendGit')}</option>
            <option value="cloud_folder">{t('workspace.create.backendCloudFolder')}</option>
          </select>
        </div>
        {backend === 'git' ? (
          <input
            value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
            placeholder={t('workspace.create.repoUrlPlaceholder')} style={inputStyle}
          />
        ) : (
          <input
            value={folderPath} onChange={(e) => setFolderPath(e.target.value)}
            placeholder={t('workspace.create.folderPathPlaceholder')} style={inputStyle}
          />
        )}
        <button onClick={submit} disabled={busy} style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }}>
          {t('workspace.create.submit')}
        </button>
        {error && <div style={{ fontSize: 12, color: 'var(--accent)' }}>{error}</div>}
      </div>
    </div>
  )
}

// ── Members + invites ─────────────────────────────────────────────────────────

function MembersView({ workspace }: { workspace: Workspace }): JSX.Element {
  const { t } = useTranslation('common')
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [invites, setInvites] = useState<WorkspaceInvite[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<MemberRole>('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canManage = workspace.my_role === 'owner' || workspace.my_role === 'admin'

  const reload = async (): Promise<void> => {
    const [m, i] = await Promise.all([
      window.veridian.workspaces.listMembers(workspace.id),
      canManage ? window.veridian.workspaces.listInvites(workspace.id) : Promise.resolve([]),
    ])
    setMembers(m); setInvites(i)
  }

  useEffect(() => { reload() }, [workspace.id])

  const invite = async (): Promise<void> => {
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await window.veridian.workspaces.invite(workspace.id, email.trim(), role)
      setEmail('')
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (userId: string, newRole: MemberRole): Promise<void> => {
    await window.veridian.workspaces.updateMemberRole(workspace.id, userId, newRole)
    await reload()
  }

  const remove = async (userId: string): Promise<void> => {
    await window.veridian.workspaces.removeMember(workspace.id, userId)
    await reload()
  }

  const revoke = async (inviteId: string): Promise<void> => {
    await window.veridian.workspaces.revokeInvite(inviteId)
    await reload()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {t('workspace.members.title')}
        </div>
        {members.map((m) => (
          <div key={m.user_id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)',
          }}>
            <span style={{ fontSize: 13, color: 'var(--foreground)' }}>{m.email ?? m.user_id}</span>
            {canManage && m.role !== 'owner' ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={m.role}
                  onChange={(e) => changeRole(m.user_id, e.target.value as MemberRole)}
                  style={{ ...inputStyle, height: 28, fontSize: 12 }}
                >
                  <option value="admin">{t('workspace.members.roleAdmin')}</option>
                  <option value="editor">{t('workspace.members.roleEditor')}</option>
                  <option value="viewer">{t('workspace.members.roleViewer')}</option>
                </select>
                <button onClick={() => remove(m.user_id)} style={{ ...secondaryBtnStyle, height: 28, color: 'var(--accent)' }}>
                  {t('workspace.members.remove')}
                </button>
              </div>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t(`workspace.members.role${cap(m.role)}`)}</span>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <>
          <div style={{
            padding: 14, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>
              {t('workspace.members.invite')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder={t('workspace.members.email')} type="email"
                style={{ ...inputStyle, flex: 1 }}
              />
              <select value={role} onChange={(e) => setRole(e.target.value as MemberRole)} style={inputStyle}>
                <option value="admin">{t('workspace.members.roleAdmin')}</option>
                <option value="editor">{t('workspace.members.roleEditor')}</option>
                <option value="viewer">{t('workspace.members.roleViewer')}</option>
              </select>
              <button onClick={invite} disabled={busy} style={primaryBtnStyle}>
                {t('workspace.members.invite')}
              </button>
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--accent)' }}>{error}</div>}
          </div>

          {invites.filter((i) => i.status === 'pending').length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {t('workspace.members.pendingInvites')}
              </div>
              {invites.filter((i) => i.status === 'pending').map((inv) => (
                <div key={inv.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)',
                }}>
                  <span style={{ fontSize: 13, color: 'var(--foreground)' }}>
                    {inv.email} <span style={{ color: 'var(--muted)' }}>· {t(`workspace.members.role${cap(inv.role)}`)}</span>
                  </span>
                  <button onClick={() => revoke(inv.id)} style={{ ...secondaryBtnStyle, height: 28, color: 'var(--accent)' }}>
                    {t('workspace.members.revoke')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
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
