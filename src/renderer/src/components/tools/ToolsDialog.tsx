import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  initialTab?: string
  onClose: () => void
}

type Tab = 'pdf2md'
type TestPhase = 'idle' | 'running' | 'done' | 'error'

const DOCS_URL = 'https://mineru.net/apiManage/docs'

export function ToolsDialog({ initialTab = 'pdf2md', onClose }: Props): JSX.Element {
  const { t } = useTranslation('common')
  const [tab] = useState<Tab>(initialTab as Tab)

  useEffect(() => {
    const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'pdf2md', label: t('tools.pdf2md.title') },
  ]

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
        width: 500,
        borderRadius: 14,
        background: 'var(--surface)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* Title bar */}
        <div style={{
          padding: '18px 22px 0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)' }}>
            {t('tools.title')}
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

        {/* Tab bar */}
        <div style={{
          display: 'flex', gap: 4, padding: '12px 22px 0',
          borderBottom: '1px solid var(--separator)',
        }}>
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              style={{
                height: 32, padding: '0 14px', borderRadius: '8px 8px 0 0',
                border: 'none',
                background: tab === id ? 'var(--surface-2)' : 'transparent',
                color: tab === id ? 'var(--foreground)' : 'var(--muted)',
                fontSize: 13, fontWeight: tab === id ? 600 : 400,
                cursor: 'default',
                borderBottom: tab === id ? '2px solid var(--primary)' : '2px solid transparent',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ padding: '20px 22px 22px', flex: 1, overflow: 'auto' }}>
          {tab === 'pdf2md' && <Pdf2mdTab />}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 22px',
          borderTop: '1px solid var(--separator)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button onClick={onClose} style={secondaryBtnStyle}>{t('tools.close')}</button>
        </div>
      </div>
    </div>
  )
}

// ── pdf2md tab ────────────────────────────────────────────────────────────────

type Pdf2mdMode = 'agent' | 'precision'

function Pdf2mdTab(): JSX.Element {
  const { t } = useTranslation('common')
  const [enabled, setEnabled] = useState(true)
  const [mode, setMode] = useState<Pdf2mdMode>('agent')
  const [token, setToken] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [testPhase, setTestPhase] = useState<TestPhase>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [testOut, setTestOut] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    window.veridian.settings.get('tool.pdf2md.enabled').then((v) => {
      if (typeof v === 'boolean') setEnabled(v)
    })
    window.veridian.settings.get('tool.pdf2md.mode').then((v) => {
      if (v === 'precision') setMode('precision')
    })
    window.veridian.settings.get('tool.pdf2md.apiToken').then((v) => {
      if (typeof v === 'string') setToken(v)
    })
  }, [])

  const toggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    window.veridian.settings.set('tool.pdf2md.enabled', next)
  }

  const saveMode = (m: Pdf2mdMode): void => {
    setMode(m)
    window.veridian.settings.set('tool.pdf2md.mode', m)
  }

  const saveToken = (v: string): void => {
    setToken(v)
    window.veridian.settings.set('tool.pdf2md.apiToken', v)
  }

  const openDocs = (): void => { window.veridian.tools.openExternal(DOCS_URL) }

  const runTest = useCallback(async () => {
    setTestPhase('running')
    setTestMsg(t('tools.pdf2md.pickPdf'))
    setTestError(null)
    setTestOut(null)

    window.veridian.tools.offPdf2mdProgress()
    window.veridian.tools.onPdf2mdProgress((p) => { setTestMsg(p.message ?? p.state) })

    try {
      const filePath = await window.veridian.tools.pickPdf()
      if (!filePath) {
        setTestPhase('idle'); setTestMsg('')
        window.veridian.tools.offPdf2mdProgress(); return
      }

      setTestMsg(t('tools.pdf2md.pickDir'))
      const outputDir = await window.veridian.tools.pickDir()
      if (!outputDir) {
        setTestPhase('idle'); setTestMsg('')
        window.veridian.tools.offPdf2mdProgress(); return
      }

      setTestMsg(t('tools.pdf2md.uploading'))
      const result = await window.veridian.tools.pdf2md(filePath, outputDir)
      window.veridian.tools.offPdf2mdProgress()

      if (result.error) {
        setTestPhase('error')
        setTestError(result.error)
      } else {
        setTestPhase('done')
        setTestOut(result.outPath ?? null)
      }
    } catch (err) {
      window.veridian.tools.offPdf2mdProgress()
      setTestPhase('error')
      setTestError((err as Error).message)
    }
  }, [t])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Enable */}
      <Section label={t('tools.pdf2md.enableLabel')}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--foreground-2)', flex: 1, marginRight: 16 }}>
            {t('tools.pdf2md.enableDesc')}
          </span>
          <Toggle on={enabled} onToggle={toggleEnabled} />
        </div>
        {!enabled && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
            {t('tools.pdf2md.disabledNote')}
          </div>
        )}
      </Section>

      {/* Mode */}
      <Section label="解析模式">
        <div style={{ display: 'flex', gap: 8, marginBottom: mode === 'precision' ? 12 : 0 }}>
          {([
            { id: 'agent' as Pdf2mdMode,     label: '免费（Agent）',  desc: '无需 Token，IP 限速，≤20 页/次' },
            { id: 'precision' as Pdf2mdMode, label: '精准解析 API',  desc: '需要 Token，VLM 模型，输出含图片 Markdown' },
          ] as { id: Pdf2mdMode; label: string; desc: string }[]).map(({ id, label, desc }) => (
            <div
              key={id}
              onClick={() => saveMode(id)}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 9, cursor: 'pointer',
                border: mode === id ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: mode === id ? 'rgba(0,122,255,0.06)' : 'var(--surface)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: mode === id ? 'var(--primary)' : 'var(--foreground)', marginBottom: 3 }}>
                {mode === id ? '● ' : '○ '}{label}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>{desc}</div>
            </div>
          ))}
        </div>

        {mode === 'precision' && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              API Token
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={tokenVisible ? 'text' : 'password'}
                value={token}
                onChange={(e) => saveToken(e.target.value)}
                placeholder="请输入 MinerU API Token"
                style={{
                  flex: 1, height: 32, padding: '0 10px',
                  borderRadius: 7, border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--foreground)',
                  fontSize: 12, outline: 'none',
                }}
              />
              <button
                onClick={() => setTokenVisible((v) => !v)}
                style={{ ...secondaryBtnStyle, padding: '0 10px', minWidth: 34 }}
                title={tokenVisible ? '隐藏' : '显示'}
              >
                {tokenVisible ? '🙈' : '👁'}
              </button>
            </div>
            <div style={{ marginTop: 5, fontSize: 11, color: 'var(--muted)' }}>
              在{' '}
              <span
                onClick={() => window.veridian.tools.openExternal('https://mineru.net/apiManage/token')}
                style={{ color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}
              >
                MinerU 控制台
              </span>
              {' '}获取 Token
            </div>
          </div>
        )}
      </Section>

      {/* Docs */}
      <Section label={t('tools.pdf2md.docsTitle')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--foreground-2)', flex: 1 }}>
            {t('tools.pdf2md.docsDesc')}
          </span>
          <button onClick={openDocs} style={linkBtnStyle}>
            {t('tools.pdf2md.openDocs')}
          </button>
        </div>
      </Section>

      {/* Test */}
      <Section label={t('tools.pdf2md.testTitle')}>
        <div style={{ fontSize: 13, color: 'var(--foreground-2)', marginBottom: 10 }}>
          {t('tools.pdf2md.testDesc')}
        </div>

        {testPhase === 'idle' && (
          <button
            onClick={runTest}
            disabled={!enabled}
            style={{ ...primaryBtnStyle, opacity: enabled ? 1 : 0.4 }}
          >
            {t('tools.pdf2md.testBtn')}
          </button>
        )}

        {testPhase === 'running' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--foreground-2)' }}>
            <Spinner />
            <span>{testMsg || t('tools.pdf2md.testRunning')}</span>
          </div>
        )}

        {testPhase === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#34c759', fontWeight: 600 }}>
              ✓ {t('tools.pdf2md.success')}
            </div>
            {testOut && (
              <div
                onClick={() => window.veridian.attachments.openPath(testOut!)}
                title={t('tools.pdf2md.success')}
                style={{
                  padding: '7px 10px', borderRadius: 8, background: 'var(--muted-bg)',
                  fontSize: 11, color: 'var(--primary)', cursor: 'pointer', wordBreak: 'break-all',
                }}
              >
                {testOut}
              </div>
            )}
            <button onClick={runTest} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>
              {t('tools.pdf2md.retryAgain')}
            </button>
          </div>
        )}

        {testPhase === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#ff3b30', fontWeight: 600 }}>
              {testError}
            </div>
            <button onClick={runTest} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>
              {t('tools.pdf2md.retry')}
            </button>
          </div>
        )}
      </Section>
    </div>
  )
}

// ── Shared ────────────────────────────────────────────────────────────────────

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

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      onClick={onToggle}
      style={{
        width: 44, height: 26, borderRadius: 13,
        border: 'none', cursor: 'pointer', flexShrink: 0,
        background: on ? 'var(--primary)' : 'var(--border-strong)',
        transition: 'background 0.2s',
        position: 'relative',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 3, left: on ? 21 : 3,
        width: 20, height: 20, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        transition: 'left 0.2s',
      }} />
    </button>
  )
}

function Spinner(): JSX.Element {
  return (
    <div style={{
      width: 15, height: 15, borderRadius: '50%',
      border: '2px solid var(--border)',
      borderTopColor: 'var(--primary)',
      animation: 'spin 0.8s linear infinite',
      flexShrink: 0,
    }} />
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

const linkBtnStyle: React.CSSProperties = {
  height: 28, padding: '0 12px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer', flexShrink: 0,
}
