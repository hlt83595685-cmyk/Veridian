import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStatusStore } from '../../stores/statusStore'

// JobQueue type -> short badge text. Falls back to the raw type string for
// any future job type that doesn't have a friendly label yet.
function jobTypeLabel(jobType: string, t: (key: string) => string): string {
  if (jobType === 'pdf2md') return 'pdf2md'
  if (jobType === 'workspace.sync') return t('toolbar.sync')
  return jobType
}

function useEllipsis(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) { setFrame(0); return }
    const id = setInterval(() => setFrame((f) => (f + 1) % 4), 480)
    return () => clearInterval(id)
  }, [active])
  return '.'.repeat(frame)
}

export function StatusBar(): JSX.Element | null {
  const { t } = useTranslation('common')
  const { pdf2md, clear } = useStatusStore()

  // hooks must all be called before any early return
  const isRunning = pdf2md?.state === 'running'
  const dots = useEllipsis(isRunning)

  if (!pdf2md) return null

  const { jobType, filename, state, message, chunk, pending, progress } = pdf2md
  const ledColor = state === 'done' ? '#34c759'
    : state === 'error' ? '#ff3b30'
    : '#007aff'
  const currentLabel = chunk ? `${filename} [${chunk}]` : filename
  const queueLabel = pending > 0 ? `${pending} pending` : null

  // done/error fill the track (green/red); running with a number shows that
  // fraction; running without a number falls back to the sliding band.
  const hasFraction = typeof progress === 'number'
  const fillPct = state === 'done' || state === 'error'
    ? 100
    : hasFraction ? Math.min(100, Math.max(0, progress! * 100)) : 0
  const indeterminate = isRunning && !hasFraction

  return (
    <div style={{
      height: 24,
      background: 'rgba(242,242,247,0.92)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderTop: '1px solid var(--separator)',
      display: 'flex', alignItems: 'center',
      padding: '0 10px',
      gap: 8,
      flexShrink: 0,
      userSelect: 'none',
    }}>

      <span style={{
        fontSize: 10, fontWeight: 700, color: 'var(--muted)',
        letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0,
      }}>
        {jobTypeLabel(jobType, t)}
      </span>

      <span style={{ color: 'var(--separator)', fontSize: 10 }}>|</span>

      <span style={{
        fontSize: 11, color: 'var(--foreground-2)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        flex: 1, minWidth: 0,
      }}>
        {isRunning
          ? <>{currentLabel} — {message}<span style={{ letterSpacing: '-1px' }}>{dots}</span></>
          : state === 'done'
            ? <span style={{ color: '#34c759' }}>{currentLabel} — done</span>
            : <span style={{ color: '#ff3b30' }}>{currentLabel} — {message}</span>
        }
      </span>

      {/* Inline progress pill with a flowing-light (流光) sweep. Determinate
          fill for known fractions; a sliding band for indeterminate phases. */}
      <div style={{
        width: 150, height: 8, flexShrink: 0,
        borderRadius: 5, overflow: 'hidden', position: 'relative',
        background: 'rgba(120,120,128,0.18)',
      }}>
        {indeterminate ? (
          <div style={{
            position: 'absolute', top: 0, bottom: 0, left: 0, width: '35%',
            borderRadius: 5,
            background: `linear-gradient(90deg, ${ledColor}00, ${ledColor}, ${ledColor}00)`,
            animation: 'pdf2md-indeterminate 1.15s ease-in-out infinite',
          }} />
        ) : (
          <div style={{
            position: 'absolute', top: 0, bottom: 0, left: 0,
            width: `${fillPct}%`, borderRadius: 5, overflow: 'hidden',
            background: ledColor,
            transition: 'width 0.35s ease',
          }}>
            {isRunning && (
              <div style={{
                position: 'absolute', top: 0, bottom: 0, left: 0, width: '40%',
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.85), transparent)',
                animation: 'pdf2md-flow 1.4s linear infinite',
              }} />
            )}
          </div>
        )}
      </div>

      <span
        title={state === 'error' ? message : undefined}
        style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: ledColor,
          boxShadow: `0 0 5px 2px ${ledColor}66`,
          animation: isRunning ? 'led-pulse 1.2s ease-in-out infinite' : 'none',
        }}
      />

      {queueLabel && (
        <span style={{ fontSize: 10, color: 'var(--muted)', flexShrink: 0 }}>
          {queueLabel}
        </span>
      )}

      {!isRunning && (
        <button
          onClick={clear}
          title="dismiss"
          style={{
            border: 'none', background: 'transparent',
            color: 'var(--muted)', fontSize: 10,
            cursor: 'pointer', padding: '0 2px', flexShrink: 0,
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
