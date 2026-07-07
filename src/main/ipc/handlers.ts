// Thin IPC handlers: parameter shapes are already validated by the gateway
// against shared/ipc-contract.ts, so each entry only forwards to a Service
// (or shows a native dialog). No business logic lives here.
import { dialog, shell, BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import * as Items from '../services/ItemService'
import * as Creators from '../services/CreatorService'
import type { ItemCreator } from '../db/creators'
import * as Tags from '../services/TagService'
import * as Collections from '../services/CollectionService'
import * as Attachments from '../services/AttachmentService'
import * as Keywords from '../services/KeywordService'
import * as Import from '../services/ImportService'
import * as Settings from '../services/SettingsService'
import { manualConvertPdfToMd } from '../services/ConversionService'
import { convertPdfToMarkdown } from '../mineruApi'
import { assertReadable, assertWritable, grantAccess } from '../security/pathGuard'
import type { IpcChannel } from '../../shared/ipc-contract'

type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

function collectImages(dir: string): string[] {
  const out: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        if (statSync(full).isDirectory()) out.push(...collectImages(full))
        else if (IMAGE_EXTS.has(extname(entry).toLowerCase())) out.push(full)
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir unreadable */ }
  return out
}

export const handlers: Record<IpcChannel, Handler> = {
  // Items
  'items:getAll':          (_e, libraryId?: number) => Items.listItems(libraryId),
  'items:getTrashed':      (_e, libraryId?: number) => Items.listTrashed(libraryId),
  'items:getByCollection': (_e, collectionId: number) => Items.listByCollection(collectionId),
  'items:getById':         (_e, id: number) => Items.getItem(id),
  'items:create':          (_e, data: object) => Items.createItem(data),
  'items:update':          (_e, id: number, data: object) => Items.updateItem(id, data),
  'items:trash':           (_e, id: number) => Items.trashItem(id),
  'items:restore':         (_e, id: number) => Items.restoreItem(id),
  'items:delete':          (_e, id: number) => Items.deleteItem(id),
  'items:emptyTrash':      (_e, libraryId?: number) => Items.emptyTrash(libraryId),
  'items:search':          (_e, query: string) => Items.search(query),
  'items:extractKeywords': (_e, itemId: number) => Keywords.extractKeywordsForItem(itemId),

  // Creators
  'creators:getByItem':  (_e, itemId: number) => Creators.listByItem(itemId),
  'creators:setForItem': (_e, itemId: number, creators: ItemCreator[]) =>
    Creators.setCreatorsForItem(itemId, creators),

  // Tags
  'tags:getByItem':  (_e, itemId: number) => Tags.listByItem(itemId),
  'tags:getAll':     () => Tags.listAll(),
  'tags:setForItem': (_e, itemId: number, names: string[]) => Tags.setTagsForItem(itemId, names),

  // Collections
  'collections:getAll':     (_e, libraryId?: number) => Collections.listAll(libraryId),
  'collections:create':     (_e, name: string, libraryId?: number, parentId?: number) =>
    Collections.createCollection(name, libraryId, parentId),
  'collections:rename':     (_e, id: number, name: string) => Collections.renameCollection(id, name),
  'collections:delete':     (_e, id: number) => Collections.deleteCollection(id),
  'collections:addItem':    (_e, cid: number, iid: number) => Collections.addItemToCollection(cid, iid),
  'collections:removeItem': (_e, cid: number, iid: number) => Collections.removeItemFromCollection(cid, iid),
  'collections:getItems':   (_e, cid: number) => Items.listByCollection(cid),

  // Attachments
  'attachments:getByItem': (_e, itemId: number) => Attachments.listByItem(itemId),
  'attachments:add': async (e, itemId: number) => {
    const result = await dialog.showOpenDialog(ownerWindow(e)!, {
      title: 'Add Attachment',
      filters: [
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return Attachments.addAttachment(itemId, result.filePaths[0])
  },
  'attachments:remove':  (_e, id: number) => Attachments.removeAttachment(id),
  'attachments:getPath': (_e, id: number) => {
    const p = Attachments.attachmentPath(id)
    if (p) grantAccess(p)   // attachment paths recorded in DB are trusted
    return p
  },
  'attachments:openExternal': (_e, id: number) => {
    const p = Attachments.attachmentPath(id)
    if (p) shell.openPath(p)
  },
  'attachments:openPath': (_e, filePath: string) => {
    shell.openPath(assertReadable(filePath))
  },

  // Import
  'import:openDialog': async (e, collectionId?: number) => {
    const result = await dialog.showOpenDialog(ownerWindow(e)!, {
      title: 'Import References',
      filters: [
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'BibTeX', extensions: ['bib'] },
        { name: 'CSL-JSON', extensions: ['json'] },
        { name: 'All Supported', extensions: ['pdf', 'bib', 'json'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return { canceled: true, imported: 0 }
    const imported = await Import.importFiles(result.filePaths, collectionId)
    return { canceled: false, imported }
  },

  // File system -- every path passes the whitelist; binary payloads are
  // Uint8Array (structured-clone zero-copy), never number[].
  'fs:readFile':     (_e, filePath: string) => new Uint8Array(readFileSync(assertReadable(filePath))),
  'fs:readTextFile': (_e, filePath: string) => readFileSync(assertReadable(filePath), 'utf-8'),
  'fs:writeFile':    (_e, filePath: string, data: Uint8Array) =>
    writeFileSync(assertWritable(filePath), Buffer.from(data)),
  'fs:listDir':      (_e, dirPath: string) => collectImages(assertReadable(dirPath)),
  'pdfjs:workerPath': () => require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'),

  // Settings
  'settings:get': (_e, key: string) => Settings.getSetting(key),
  'settings:set': (_e, key: string, value: unknown) => Settings.setSetting(key, value),
  'settings:pickStoragePath': async (e) => {
    const result = await dialog.showOpenDialog(ownerWindow(e)!, {
      title: '选择文件存储目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled) return null
    Settings.saveStoragePath(result.filePaths[0])
    return result.filePaths[0]
  },

  // Tools / conversion
  'shell:openExternal': (_e, url: string) => shell.openExternal(url),
  'tool:pick-pdf': async (e) => {
    const result = await dialog.showOpenDialog(ownerWindow(e)!, {
      title: '选择 PDF 文件',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    if (result.canceled) return null
    grantAccess(result.filePaths[0])
    return result.filePaths[0]
  },
  'tool:pick-dir': async (e) => {
    const result = await dialog.showOpenDialog(ownerWindow(e)!, {
      title: '选择输出目录',
      properties: ['openDirectory'],
    })
    if (result.canceled) return null
    grantAccess(result.filePaths[0])
    return result.filePaths[0]
  },
  'tool:pdf2md': async (e, filePath: string, outputDir: string) => {
    const sendProgress = (p: { state: string; message?: string }): void => {
      e.sender.send('tool:pdf2md:progress', p)
    }
    try {
      const outPath = await convertPdfToMarkdown(
        assertReadable(filePath), assertWritable(outputDir), {}, sendProgress)
      return { outPath }
    } catch (err) {
      return { error: (err as Error).message }
    }
  },
  'pdf2md:convertItem': (_e, itemId: number) => ({ error: manualConvertPdfToMd(itemId) }),
}
