import { useEffect, useState } from 'react'
import { useStatusStore } from '../../stores/statusStore'

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
  const { pdf2md, clear } = useStatusStore()

  // hooks must all be called before any early return
  const isRunning = pdf2md?.state === 'running'
  const dots = useEllipsis(isRunning)

  if (!pdf2md) return null

  const { filename, state, message, chunk, pending } = pdf2md
  const ledColor = state === 'done' ? '#34c759'
    : state === 'error' ? '#ff3b30'
    : '#007aff'
  const currentLabel = chunk ? `${filename} [${chunk}]` : filename
  const queueLabel = pending > 0 ? `${pending} pending` : null

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
        pdf2md
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
