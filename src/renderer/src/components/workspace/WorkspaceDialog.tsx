import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LocalWorkspace, LocalWorkspaceKind, GitHubRepoInfo } from '../../../../shared/types'
import { useWorkspaceStore } from '../../stores/workspaceStore'

interface Props {
  onClose: () => void
}

// Workspace management, local-first model: a workspace is a local record,
// optionally bound to a GitHub repository. "Joining" a collaborator's
// workspace = connecting the same repo your PAT can access -- GitHub's own
// collaborator permissions ARE the membership system, so there are no
// invite codes and no accounts here. Modal chrome mirrors SettingsDialog.
export function WorkspaceDialog({ onClose }: Props): JSX.Element {
  const { t } = useTranslation('common')
  const { workspaces, load } = useWorkspaceStore()

  useEffect(() => { load() }, [load])

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
            {t('workspace.title')}
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

        <div style={{ padding: 22, flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <WorkspaceList workspaces={workspaces} />
          <ConnectRepoSection />
          <CreateSection />
        </div>
      </div>
    </div>
  )
}

// ── Existing workspaces ───────────────────────────────────────────────────────

function WorkspaceList({ workspaces }: { workspaces: LocalWorkspace[] }): JSX.Element {
  const { t } = useTranslation('common')
  const { load, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore()

  const remove = async (id: number): Promise<void> => {
    if (activeWorkspaceId === id) await setActiveWorkspace(null)
    await window.veridian.localWorkspaces.remove(id)
    await load()
  }

  if (workspaces.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('workspace.empty')}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {workspaces.map((w) => (
        <div key={w.id} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 12px', borderRadius: 10,
          border: '1px solid var(--border)', background: 'var(--surface-2)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>{w.name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {w.kind === 'github'
                ? `GitHub · ${w.repo_owner}/${w.repo_name}`
                : t('workspace.kindLocal')}
            </div>
          </div>
          <button onClick={() => remove(w.id)} style={{ ...secondaryBtnStyle, height: 28, color: 'var(--accent)' }}>
            {t('workspace.deleteWs')}
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Connect a collaborative repo (auto-creates a same-named workspace) ───────

function ConnectRepoSection(): JSX.Element {
  const { t } = useTranslation('common')
  const { load } = useWorkspaceStore()
  const [repos, setRepos] = useState<GitHubRepoInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const loadRepos = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setRepos(await window.veridian.github.listRepos())
    } catch (err) {
      const msg = (err as Error).message
      setError(msg === 'no_pat' ? t('workspace.connectRepo.needPat') : msg)
    } finally {
      setBusy(false)
    }
  }

  const connect = async (repo: GitHubRepoInfo): Promise<void> => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      // First-time setup: let the user choose where the local copy lives
      // (cancel = app default under userData)
      const localPath = await window.veridian.tools.pickDir()
      await window.veridian.localWorkspaces.create(repo.name, 'github', repo.owner, repo.name, localPath)
      await load()
      setInfo(t('workspace.connectRepo.connected', { name: repo.full_name }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={sectionBoxStyle}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>
        {t('workspace.connectRepo.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        {t('workspace.connectRepo.desc')}
      </div>

      {repos === null ? (
        <button onClick={loadRepos} disabled={busy} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>
          {busy ? t('workspace.connectRepo.loading') : t('workspace.connectRepo.load')}
        </button>
      ) : repos.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('workspace.connectRepo.emptyList')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
          {repos.map((r) => (
            <div key={r.full_name} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--surface)',
            }}>
              <span style={{
                fontSize: 12, color: 'var(--foreground)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
              }}>
                {r.full_name}
                <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 11 }}>
                  {r.private ? '🔒' : ''} {r.push ? t('workspace.connectRepo.canWrite') : t('workspace.connectRepo.readOnly')}
                </span>
              </span>
              <button onClick={() => connect(r)} disabled={busy}
                style={{ ...primaryBtnStyle, height: 26, padding: '0 12px', fontSize: 12 }}>
                {t('workspace.connectRepo.connect')}
              </button>
            </div>
          ))}
        </div>
      )}

      {info && <div style={{ fontSize: 12, color: 'var(--accent-green)' }}>{info}</div>}
      {error && <div style={{ fontSize: 12, color: 'var(--accent)' }}>{error}</div>}
    </div>
  )
}

// ── Create your own workspace ─────────────────────────────────────────────────

function CreateSection(): JSX.Element {
  const { t } = useTranslation('common')
  const { load } = useWorkspaceStore()

  const [name, setName] = useState('')
  const [kind, setKind] = useState<LocalWorkspaceKind>('local')
  const [repoUrl, setRepoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const parseOwnerRepo = (url: string): { owner: string; repo: string } | null => {
    const m = url.trim().match(
      /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i
    )
    return m ? { owner: m[1], repo: m[2] } : null
  }

  const testRepo = async (): Promise<void> => {
    if (!repoUrl.trim()) return
    setTestBusy(true)
    setTestResult(null)
    try {
      const res = await window.veridian.github.testRepo(repoUrl.trim())
      const known: Record<string, string> = {
        ok_write: t('workspace.github.okWrite'),
        ok_read: t('workspace.github.okRead'),
        no_pat: t('workspace.github.noPat'),
        invalid_url: t('workspace.github.invalidUrl'),
        not_found: t('workspace.github.notFound'),
      }
      setTestResult({ ok: res.ok, text: known[res.code] ?? res.detail ?? res.code })
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message })
    } finally {
      setTestBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      // First-time setup: user-chosen local storage root (cancel = default)
      const localPath = await window.veridian.tools.pickDir()
      if (kind === 'github') {
        const parsed = parseOwnerRepo(repoUrl)
        if (!parsed) { setError(t('workspace.github.invalidUrl')); return }
        await window.veridian.localWorkspaces.create(name.trim(), 'github', parsed.owner, parsed.repo, localPath)
      }
      else {
        await window.veridian.localWorkspaces.create(name.trim(), 'local', null, null, localPath)
      }
      setName(''); setRepoUrl(''); setTestResult(null)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={sectionBoxStyle}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--foreground)' }}>
        {t('workspace.create.title')}
      </div>
      <input
        value={name} onChange={(e) => setName(e.target.value)}
        placeholder={t('workspace.create.namePlaceholder')} style={inputStyle}
      />
      <select value={kind} onChange={(e) => setKind(e.target.value as LocalWorkspaceKind)} style={inputStyle}>
        <option value="local">{t('workspace.create.kindLocal')}</option>
        <option value="github">{t('workspace.create.kindGithub')}</option>
      </select>
      {kind === 'github' && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={repoUrl} onChange={(e) => { setRepoUrl(e.target.value); setTestResult(null) }}
              placeholder={t('workspace.create.repoUrlPlaceholder')} style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={testRepo} disabled={testBusy || !repoUrl.trim()} style={secondaryBtnStyle}>
              {testBusy ? t('workspace.github.testing') : t('workspace.github.test')}
            </button>
          </div>
          {testResult && (
            <div style={{ fontSize: 12, color: testResult.ok ? 'var(--accent-green)' : 'var(--accent)' }}>
              {testResult.text}
            </div>
          )}
        </>
      )}
      <button onClick={submit} disabled={busy} style={{ ...primaryBtnStyle, alignSelf: 'flex-start' }}>
        {t('workspace.create.submit')}
      </button>
      {error && <div style={{ fontSize: 12, color: 'var(--accent)' }}>{error}</div>}
    </div>
  )
}

// ── Shared styles (mirrors SettingsDialog conventions) ────────────────────────

const sectionBoxStyle: React.CSSProperties = {
  padding: 14, borderRadius: 10,
  border: '1px solid var(--border)', background: 'var(--surface-2)',
  display: 'flex', flexDirection: 'column', gap: 8,
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
  color: 'var(--foreground-2)', fontSize: 13, cursor: 'pointer', flexShrink: 0,
}
