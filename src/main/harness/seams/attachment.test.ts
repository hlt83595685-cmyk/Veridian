import { describe, it, expect } from 'vitest'
import { makeAttachmentResolver, type AttachmentDeps } from './attachment'

const deps: AttachmentDeps = {
  findItem: (key) =>
    key === 'K1' ? { id: 1, title: 'Paper A' } : key === 'K2' ? { id: 2, title: 'Paper B' } : null,
  findMarkdownPath: (itemId) => (itemId === 1 ? 'C:/lib/Full.md' : null),
  assertReadable: (p) => {
    if (p.includes('outside')) throw new Error('Access denied: ' + p)
    return p
  },
  readText: (p) => {
    if (p === 'C:/lib/Full.md') return 'A'.repeat(50000)
    throw new Error('EIO: i/o error')
  },
}

describe('attachment resolver', () => {
  it('reads the whole markdown, no arbitrary cap', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'item', itemKey: 'K1' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 旧实现在这里截到 8000 字符，论文 30–80KB，只覆盖约 15%
      expect(r.text.length).toBe(50000)
      expect(r.truncated).toBe(false)
      expect(r.totalBytes).toBe(50000)
      expect(r.title).toBe('Paper A')
    }
  })

  it('reports not_converted when the item has no markdown', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'item', itemKey: 'K2' })
    expect(r).toMatchObject({ ok: false, reason: 'not_converted', title: 'Paper B' })
  })

  it('reports not_found for an unknown item', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'item', itemKey: 'ZZ' })
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('reports permission_denied instead of pretending there is no text', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'file', path: 'C:/outside/x.md' })
    expect(r).toMatchObject({ ok: false, reason: 'permission_denied' })
    if (!r.ok) expect(r.detail).toContain('Access denied')
  })

  it('reports unreadable with the real error text', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'file', path: 'C:/lib/broken.md' })
    expect(r).toMatchObject({ ok: false, reason: 'unreadable' })
    if (!r.ok) expect(r.detail).toContain('EIO')
  })
})
