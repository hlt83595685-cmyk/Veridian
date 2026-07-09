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
  const rootRef = useRef<HTMLDivElement>(null)

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)

  useEffect(() => {
    load()
    // workspace.changed events (create/remove from the dialog) refresh the list
    const onEvent = (e: { type: string }): void => {
      if (e.type === 'workspace.changed') load()
    }
    window.veridian.onDomainEvent(onEvent)
    return () => window.veridian.offDomainEvent(onEvent)
  }, [load])

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
