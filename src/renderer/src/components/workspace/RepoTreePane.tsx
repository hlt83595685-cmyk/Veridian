import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RepoTreeNode } from '../../../../shared/types'
import { useItemStore } from '../../stores/itemStore'

// Sidebar tab showing the active github workspace's repository contents as a
// file tree (the local clone's working tree == what's on GitHub after sync).
// Clicking a file opens it with the matching in-app viewer.
export function RepoTreePane(): JSX.Element {
  const { t } = useTranslation('common')
  const [tree, setTree] = useState<RepoTreeNode[]>([])

  const load = (): void => {
    window.veridian.workspace.listRepoTree().then(setTree).catch(console.error)
  }

  useEffect(() => {
    load()
    const onEvent = (e: { type: string }): void => {
      if (e.type === 'workspace.dataRefreshed' || e.type === 'attachment.changed') load()
    }
    window.veridian.onDomainEvent(onEvent)
    return () => window.veridian.offDomainEvent(onEvent)
  }, [])

  if (tree.length === 0) {
    return (
      <p style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 12px', userSelect: 'none' }}>
        {t('sidebar.repoEmpty')}
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {tree.map((node) => <TreeNode key={node.absPath} node={node} depth={0} />)}
    </div>
  )
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

function TreeNode({ node, depth }: { node: RepoTreeNode; depth: number }): JSX.Element {
  const [open, setOpen] = useState(depth < 1)   // top level expanded by default
  const { openPdf, openMarkdown } = useItemStore()

  const openFile = (): void => {
    const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'pdf') openPdf(node.absPath, node.name)
    else if (ext === 'md') openMarkdown(node.absPath, node.name)
    else window.veridian.attachments.openPath(node.absPath).catch(console.error)
  }

  const ext = node.name.split('.').pop()?.toLowerCase() ?? ''
  const icon = node.isDir ? (open ? '📂' : '📁')
    : ext === 'pdf' ? '📄'
    : ext === 'md' ? '📝'
    : ext === 'json' ? '🧾'
    : IMAGE_EXTS.has(ext) ? '🖼' : '·'

  return (
    <>
      <div
        onClick={() => node.isDir ? setOpen((v) => !v) : openFile()}
        className="sidebar-row"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', paddingLeft: 10 + depth * 14,
          borderRadius: 'var(--radius-md)',
          color: 'var(--foreground-3)', fontSize: 12.5,
          cursor: 'pointer', userSelect: 'none', minHeight: 28,
        }}
      >
        <span style={{ fontSize: 12, flexShrink: 0, width: 16, textAlign: 'center' }}>{icon}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
      </div>
      {node.isDir && open && node.children?.map((child) => (
        <TreeNode key={child.absPath} node={child} depth={depth + 1} />
      ))}
    </>
  )
}
