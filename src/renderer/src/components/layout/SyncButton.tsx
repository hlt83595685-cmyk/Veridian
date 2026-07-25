import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { DomainEvent } from '../../../../shared/events'

// Manual "sync now" for the active GitHub workspace. Only renders when a
// github-kind workspace is active -- personal/local workspaces have nothing
// to sync. The spinning state tracks the REAL background job (syncNow()
// just enqueues and returns immediately; the actual pull+push runs async via
// JobQueue) through the same job.progress domain event the status bar uses,
// so the icon reflects when the sync genuinely finishes, not a guessed delay.
export function SyncButton(): JSX.Element | null {
  const { t } = useTranslation('common')
  const { workspaces, activeWorkspaceId } = useWorkspaceStore()
  const [syncing, setSyncing] = useState(false)

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId)
  const isGithub = activeWs?.kind === 'github'

  useEffect(() => {
    const onEvent = (e: DomainEvent): void => {
      if (e.type !== 'job.progress' || e.job.type !== 'workspace.sync') return
      setSyncing(e.job.state === 'running' || e.job.state === 'queued')
    }
    window.veridian.onDomainEvent(onEvent)
    return () => window.veridian.offDomainEvent(onEvent)
  }, [])

  if (!isGithub) return null

  const handleClick = (): void => {
    window.veridian.workspace.syncNow().catch((err) => {
      console.error('[SyncButton] syncNow failed:', err)
    })
  }

  return (
    <button
      onClick={handleClick}
      disabled={syncing}
      title={t('toolbar.sync')}
      style={{
        width: 38, height: 38, borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)', background: 'var(--surface)',
        color: 'var(--foreground-2)', fontSize: 16,
        boxShadow: 'var(--shadow-sm)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, opacity: syncing ? 0.6 : 1,
        cursor: syncing ? 'default' : 'pointer',
      }}
    >
      <span style={{
        display: 'inline-block',
        animation: syncing ? 'spin 1s linear infinite' : 'none',
      }}>
        ⟳
      </span>
    </button>
  )
}
