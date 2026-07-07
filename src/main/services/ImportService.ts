// Import orchestration: dispatches picked files to the right importer and
// emits a single bulk item.created event when done. File dialogs stay in the
// IPC handler layer -- this service only deals in paths.
import { importBibTeX, importCSLJSON } from '../importer'
import { importPDF } from '../pdfImporter'
import { grantAccess } from '../security/pathGuard'
import { emit } from '../core/Notifier'

export async function importFiles(filePaths: string[], collectionId?: number): Promise<number> {
  let imported = 0
  for (const filePath of filePaths) {
    grantAccess(filePath)
    const lower = filePath.toLowerCase()
    try {
      if (lower.endsWith('.pdf')) imported += await importPDF(filePath, collectionId)
      else if (lower.endsWith('.bib')) imported += importBibTeX(filePath, collectionId)
      else if (lower.endsWith('.json')) imported += importCSLJSON(filePath, collectionId)
    } catch (err) {
      console.error(`[ImportService] import failed for ${filePath}:`, err)
    }
  }
  if (imported > 0) {
    // Bulk imports touch items, tags, creators and collections; empty id list
    // means "unspecified set changed" and invalidates list-level caches.
    emit({ type: 'item.created', ids: [] })
  }
  return imported
}
