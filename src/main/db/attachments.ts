import { copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join, basename, extname } from 'path'
import { createHash, randomUUID } from 'crypto'
import { app, net } from 'electron'
import { getDb } from './index'

export interface Attachment {
  id: number
  item_id: number
  type: string
  filename: string | null
  path: string | null
  url: string | null
  mime_type: string | null
  size: number | null
  md5: string | null
}

/** Content hash for duplicate detection (schema has carried md5 since v1). */
export function fileMd5(filePath: string): string | null {
  try { return createHash('md5').update(readFileSync(filePath)).digest('hex') }
  catch { return null }
}

/**
 * Duplicate check: does any active item already hold a file with this hash?
 * Returns the owning item id, or null.
 */
export function findItemIdByMd5(md5: string): number | null {
  const row = getDb().prepare(`
    SELECT a.item_id FROM attachments a
    JOIN items i ON i.id = a.item_id
    WHERE a.md5 = ? AND i.deleted = 0
    LIMIT 1
  `).get(md5) as { item_id: number } | undefined
  return row?.item_id ?? null
}

function attachmentsDir(): string {
  const dir = join(app.getPath('userData'), 'attachments')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getAttachmentsByItem(itemId: number): Attachment[] {
  return getDb()
    .prepare('SELECT * FROM attachments WHERE item_id = ? ORDER BY id')
    .all(itemId) as Attachment[]
}

export function addAttachment(itemId: number, srcPath: string): Attachment {
  const db = getDb()
  const ext = extname(srcPath).toLowerCase()
  const filename = basename(srcPath)
  const destName = `${randomUUID()}${ext}`
  const destPath = join(attachmentsDir(), destName)

  copyFileSync(srcPath, destPath)

  let size: number | null = null
  try { size = statSync(destPath).size } catch { /* ignore */ }

  const mime = ext === '.pdf' ? 'application/pdf' : null
  const type = ext === '.pdf' ? 'pdf' : 'other'

  db.prepare(`
    INSERT INTO attachments (item_id, type, filename, path, mime_type, size, md5)
    VALUES (@item_id, @type, @filename, @path, @mime_type, @size, @md5)
  `).run({ item_id: itemId, type, filename, path: destPath, mime_type: mime, size, md5: fileMd5(destPath) })

  const id = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Attachment
}

/**
 * Register an existing file as an attachment without copying it.
 * Used for .md files that must live alongside their source PDF.
 */
export function registerAttachment(itemId: number, filePath: string): Attachment {
  const db = getDb()
  const ext = extname(filePath).toLowerCase()
  const filename = basename(filePath)

  let size: number | null = null
  try { size = statSync(filePath).size } catch { /* ignore */ }

  const mime = ext === '.pdf' ? 'application/pdf'
    : ext === '.md' ? 'text/markdown'
    : null
  const type = ext === '.pdf' ? 'pdf' : ext === '.md' ? 'markdown' : 'other'

  db.prepare(`
    INSERT INTO attachments (item_id, type, filename, path, mime_type, size)
    VALUES (@item_id, @type, @filename, @path, @mime_type, @size)
  `).run({ item_id: itemId, type, filename, path: filePath, mime_type: mime, size })

  const id = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Attachment
}

/**
 * Register a directory as an imagedir attachment (no file copy — records the dir path).
 */
export function registerAttachmentDir(itemId: number, dirPath: string, displayName: string): Attachment {
  const db = getDb()
  db.prepare(`
    INSERT INTO attachments (item_id, type, filename, path, mime_type, size)
    VALUES (@item_id, @type, @filename, @path, @mime_type, @size)
  `).run({ item_id: itemId, type: 'imagedir', filename: displayName, path: dirPath, mime_type: null, size: null })
  const id = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Attachment
}

export function removeAttachment(id: number): void {
  const db = getDb()
  const row = db.prepare('SELECT path, type FROM attachments WHERE id = ?').get(id) as { path: string | null; type: string } | undefined
  if (row?.path && row.type !== 'imagedir') {
    try { unlinkSync(row.path) } catch { /* file may already be gone */ }
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
}

export function getAttachmentPath(id: number): string | null {
  const row = getDb()
    .prepare('SELECT path FROM attachments WHERE id = ?')
    .get(id) as { path: string | null } | undefined
  return row?.path ?? null
}

const MAX_PDF_BYTES = 50 * 1024 * 1024

// Download a PDF from a URL and save as attachment for itemId
export async function addAttachmentFromUrl(itemId: number, url: string): Promise<Attachment | null> {
  try {
    const resp = await net.fetch(url)
    if (!resp.ok) return null
    // Reject oversized downloads before buffering when the server declares a
    // length; the post-buffer check below covers chunked responses.
    const declared = Number(resp.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length < 1024 || buf.length > MAX_PDF_BYTES) return null
    // Anything without the PDF magic bytes (e.g. an HTML error page served
    // with status 200) must not be stored as a .pdf attachment.
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return null

    const dir = attachmentsDir()
    const destName = `${randomUUID()}.pdf`
    const destPath = join(dir, destName)
    writeFileSync(destPath, buf)

    // guess filename from URL
    const urlFilename = url.split('/').pop()?.split('?')[0] ?? 'document.pdf'
    const filename = urlFilename.endsWith('.pdf') ? urlFilename : urlFilename + '.pdf'

    const db = getDb()
    db.prepare(`
      INSERT INTO attachments (item_id, type, filename, path, mime_type, size, md5)
      VALUES (@item_id, @type, @filename, @path, @mime_type, @size, @md5)
    `).run({
      item_id: itemId, type: 'pdf', filename, path: destPath,
      mime_type: 'application/pdf', size: buf.length,
      md5: createHash('md5').update(buf).digest('hex'),
    })

    const id = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id
    return db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Attachment
  } catch (err) {
    console.error('[attachments] addAttachmentFromUrl failed:', err)
    return null
  }
}
