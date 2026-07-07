import { useState, useEffect, useCallback } from 'react'

interface Props {
  onClose: () => void
}

type TestPhase = 'idle' | 'running' | 'done' | 'error'

const DOCS_URL = 'https://mineru.net/apiManage/docs'

export function Pdf2mdDialog({ onClose }: Props): JSX.Element {
  const [enabled, setEnabled] = useState(true)
  const [testPhase, setTestPhase] = useState<TestPhase>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [testOut, setTestOut] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    window.veridian.settings.get('tool.pdf2md.enabled').then((v) => {
      if (typeof v === 'boolean') setEnabled(v)
    })
  }, [])

  const toggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    window.veridian.settings.set('tool.pdf2md.enabled', next)
  }

  const openDocs = (): void => {
    window.veridian.tools.openExternal(DOCS_URL)
  }

  const runTest = useCallback(async () => {
    setTestPhase('running')
    setTestMsg('请选择一个 PDF 文件...')
    setTestError(null)
    setTestOut(null)

    window.veridian.tools.offPdf2mdProgress()
    window.veridian.tools.onPdf2mdProgress((p) => {
      setTestMsg(p.message ?? p.state)
    })

    try {
      const filePath = await window.veridian.tools.pickPdf()
      if (!filePath) { setTestPhase('idle'); setTestMsg(''); window.veridian.tools.offPdf2mdProgress(); return }

      setTestMsg('请选择输出目录...')
      const outputDir = await window.veridian.tools.pickDir()
      if (!outputDir) { setTestPhase('idle'); setTestMsg(''); window.veridian.tools.offPdf2mdProgress(); return }

      setTestMsg('上传文件...')
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
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const openOut = (): void => {
    if (testOut) window.veridian.attachments.openPath(testOut)
  }

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
        width: 460,
        borderRadius: 14,
        background: 'var(--surface)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        overflow: 'hidden',
      }}>

        {/* Title bar */}
        <div style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid var(--separator)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--foreground)' }}>
            工具设置 — pdf2md
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

        <div style={{ padding: '18px 22px 22px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Enable toggle */}
          <Section label="启用状态">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--foreground-2)' }}>
                启用 pdf2md 功能（通过 MinerU API 将 PDF 转为多模态 Markdown）
              </span>
              <Toggle on={enabled} onToggle={toggleEnabled} />
            </div>
            {!enabled && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                已禁用。菜单项仍可见，但点击测试时不会执行转换。
              </div>
            )}
          </Section>

          {/* Docs */}
          <Section label="文档">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--foreground-2)', flex: 1 }}>
                MinerU API 官方文档（Agent 免费模式：10 MB / 20 页）
              </span>
              <button onClick={openDocs} style={linkBtnStyle}>
                打开文档 ↗
              </button>
            </div>
          </Section>

          {/* Test */}
          <Section label="测试转换">
            <div style={{ fontSize: 13, color: 'var(--foreground-2)', marginBottom: 10 }}>
              选择一个本地 PDF 和输出目录，验证 MinerU API 连通性与转换效果。
            </div>

            {testPhase === 'idle' && (
              <button
                onClick={runTest}
                disabled={!enabled}
                style={{ ...primaryBtnStyle, opacity: enabled ? 1 : 0.4 }}
              >
                选择 PDF 并测试
              </button>
            )}

            {testPhase === 'running' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--foreground-2)' }}>
                <Spinner />
                <span>{testMsg || '处理中...'}</span>
              </div>
            )}

            {testPhase === 'done' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--accent-green)', fontWeight: 600 }}>
                  ✓ 转换成功
                </div>
                {testOut && (
                  <div
                    onClick={openOut}
                    title="点击打开文件"
                    style={{
                      padding: '7px 10px', borderRadius: 8,
                      background: 'var(--muted-bg)',
                      fontSize: 11, color: 'var(--primary)',
                      cursor: 'pointer', wordBreak: 'break-all',
                    }}
                  >
                    {testOut}
                  </div>
                )}
                <button onClick={runTest} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>
                  再测一次
                </button>
              </div>
            )}

            {testPhase === 'error' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600 }}>
                  转换失败
                </div>
                <div style={{
                  padding: '7px 10px', borderRadius: 8,
                  background: 'rgba(255,59,48,0.08)',
                  fontSize: 11, color: 'var(--foreground-2)', wordBreak: 'break-all',
                }}>
                  {testError}
                </div>
                <button onClick={runTest} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>
                  重试
                </button>
              </div>
            )}
          </Section>

        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 22px',
          borderTop: '1px solid var(--separator)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button onClick={onClose} style={secondaryBtnStyle}>关闭</button>
        </div>

      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{
        padding: '12px 14px', borderRadius: 10,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
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
  color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  alignSelf: 'flex-start',
}

const secondaryBtnStyle: React.CSSProperties = {
  height: 32, padding: '0 16px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--foreground-2)', fontSize: 13, cursor: 'pointer',
}

const linkBtnStyle: React.CSSProperties = {
  height: 28, padding: '0 12px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  flexShrink: 0,
}
