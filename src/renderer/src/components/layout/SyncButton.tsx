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
    return window.veridian.onDomainEvent(onEvent)
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
      {/* A text glyph's drawn ink is not guaranteed centered within its own
          font metrics (varies by font/renderer) -- no amount of box-centering
          fixes that, since rotate() spins the ink, not the box. While syncing,
          draw a plain CSS ring instead: its geometry is ours, so it's exactly
          symmetric and rotates cleanly around its true center. The glyph is
          only used at rest, where it never rotates and any ink offset is
          invisible. */}
      {syncing ? (
        <span style={{
          display: 'block', width: 14, height: 14, borderRadius: '50%',
          border: '2px solid var(--foreground-2)', borderTopColor: 'transparent',
          animation: 'spin 0.7s linear infinite',
        }} />
      ) : (
        <span style={{ lineHeight: 1 }}>⟳</span>
      )}
    </button>
  )
}
