import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '../../../../shared/types'
import { useItemStore } from '../../stores/itemStore'
import { useAttachments } from '../../data/hooks'

export function AttachmentsTab({ itemId }: { itemId: number }): JSX.Element {
  const { t } = useTranslation('common')
  const { openPdf, openMarkdown, openGallery } = useItemStore()
  // Event-driven: attachment.changed events (including ones fired by
  // background conversion jobs) invalidate this query automatically.
  const { data: attachments } = useAttachments(itemId)
  const [loading, setLoading] = useState(false)

  const handleAdd = async (): Promise<void> => {
    setLoading(true)
    try {
      await window.veridian.attachments.add(itemId)
    } catch (err) {
      console.error('[AttachmentsTab] add failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleRemove = async (id: number): Promise<void> => {
    try {
      await window.veridian.attachments.remove(id)
    } catch (err) {
      console.error('[AttachmentsTab] remove failed:', err)
    }
  }

  const handleOpen = async (att: Attachment): Promise<void> => {
    const name = att.filename?.toLowerCase() ?? ''
    const isImgDir = (att as Attachment & { type?: string }).type === 'imagedir'
    const isPdf = att.mime_type === 'application/pdf' || name.endsWith('.pdf')
    const isMd  = att.mime_type === 'text/markdown' || name.endsWith('.md')

    const path = await window.veridian.attachments.getPath(att.id)
    if (!path) return

    if (isImgDir) {
      openGallery(path, att.filename ?? '图片文件夹')
    } else if (isMd) {
      openMarkdown(path, att.filename ?? 'document.md')
    } else if (isPdf) {
      openPdf(path, att.filename ?? 'document.pdf')
    } else {
      await window.veridian.attachments.openExternal(att.id)
    }
  }

  const getAttIcon = (att: Attachment): { icon: string; bg: string; color: string } => {
    const isImgDir = (att as Attachment & { type?: string }).type === 'imagedir'
    if (isImgDir) return { icon: '🖼', bg: 'rgba(255,149,0,0.12)', color: '#ff9500' }
    const isMd = att.mime_type === 'text/markdown' || att.filename?.toLowerCase().endsWith('.md')
    if (isMd) return { icon: 'M↓', bg: 'rgba(52,199,89,0.12)', color: '#34c759' }
    const isPdf = att.mime_type === 'application/pdf' || att.filename?.toLowerCase().endsWith('.pdf')
    if (isPdf) return { icon: 'PDF', bg: 'rgba(255,59,48,0.10)', color: '#ff3b30' }
    return { icon: '···', bg: 'rgba(142,142,147,0.12)', color: 'var(--muted)' }
  }

  const formatSize = (bytes: number | null): string => {
    if (!bytes) return ''
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {attachments.length > 0
            ? t('attachments.count', { count: attachments.length })
            : t('attachments.empty')}
        </span>
        <button
          onClick={handleAdd}
          disabled={loading}
          style={{
            height: 28, padding: '0 12px',
            borderRadius: 'var(--radius-md)', border: 'none',
            background: 'var(--primary)', color: '#fff',
            fontSize: 12, fontWeight: 600,
            opacity: loading ? 0.6 : 1,
            boxShadow: '0 2px 6px rgba(0,122,255,0.25)',
          }}
        >
          + {t('attachments.add')}
        </button>
      </div>

      {/* List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {attachments.map((att) => {
          const { icon, bg, color } = getAttIcon(att)
          return (
          <div
            key={att.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-xs)',
              cursor: 'pointer',
            }}
          >
            {/* Icon */}
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color, flexShrink: 0,
              letterSpacing: '-0.03em',
            }}>
              {icon}
            </div>

            {/* Info */}
            <div
              style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
              onClick={() => handleOpen(att)}
            >
              <p style={{
                fontSize: 13, fontWeight: 500, color: 'var(--foreground)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {att.filename ?? 'attachment'}
              </p>
              {att.size != null && (
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                  {formatSize(att.size)}
                </p>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                onClick={() => window.veridian.attachments.openExternal(att.id)}
                title={t('attachments.openExternal')}
                style={{
                  width: 28, height: 28, borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)', background: 'var(--surface-2)',
                  color: 'var(--muted)', fontSize: 13,
                }}
              >
                ↗
              </button>
              <button
                onClick={() => handleRemove(att.id)}
                title={t('attachments.remove')}
                style={{
                  width: 28, height: 28, borderRadius: 'var(--radius-sm)',
                  border: '1px solid rgba(255,59,48,0.20)', background: 'rgba(255,59,48,0.06)',
                  color: 'var(--accent)', fontSize: 13,
                }}
              >
                ✕
              </button>
            </div>
          </div>
          )
        })}
      </div>
    </div>
  )
}
