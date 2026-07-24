import { app, BrowserWindow, shell, ipcMain, protocol, net, Menu } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from './db'
import { startLocalServer, stopLocalServer } from './server'
import { registerIpcGateway } from './ipc/gateway'
import { initConversionService } from './services/ConversionService'
import { initWorkspaceSyncService } from './services/WorkspaceSyncService'
import { initAutoUpdater } from './services/UpdateService'
import { assertReadable } from './security/pathGuard'

let mainWindow: BrowserWindow | null = null

// Last line of defense: an unhandled rejection in the main process is FATAL
// by default in modern Node/Electron -- any stray network error escaping a
// background job (git push, CrossRef, MinerU) would silently kill the whole
// app. Log to console + userData/crash.log and keep running instead.
function logCrash(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[FATAL:${kind}]`, detail)
  try {
    const { appendFileSync } = require('fs') as typeof import('fs')
    appendFileSync(
      join(app.getPath('userData'), 'crash.log'),
      `${new Date().toISOString()} ${kind}: ${detail}\n\n`
    )
  } catch { /* logging must never throw */ }
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err))
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))

// Dev runs from out/main, so resources/ sits two levels up; packaged Windows
// builds take the icon from the exe itself and ignore a missing path here.
const appIcon = join(__dirname, '../../resources/icon.ico')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's built-in PDF viewer (used by PdfViewer's iframe) -- native
      // scrolling/zoom performance, no JS-side page rendering
      plugins: true,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register veridian-file:// protocol so the renderer can load local files
// (file:// is blocked by Electron's CSP in sandboxed contexts)
protocol.registerSchemesAsPrivileged([
  { scheme: 'veridian-file', privileges: { secure: true, supportFetchAPI: true, stream: true } },
])

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.veridian.app')

  protocol.handle('veridian-file', (request) => {
    // URL format: veridian-file:///C:/path/to/file  (triple slash + drive letter on Windows)
    // Stripping the scheme leaves /C:/path — strip the leading / on Windows absolute paths.
    let filePath = decodeURIComponent(request.url.replace('veridian-file://', ''))
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
    try {
      return net.fetch(pathToFileURL(assertReadable(filePath)).toString())
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Init core services
  try {
    await initDatabase()
    console.log('[main] Database initialized')
  } catch (err) {
    console.error('[main] Database init failed:', err)
  }
  try {
    startLocalServer()
    console.log('[main] Local server started on port 23120')
  } catch (err) {
    console.error('[main] Local server failed:', err)
  }
  initConversionService()
  initWorkspaceSyncService()
  registerIpcGateway(ipcMain)

  // No native menu bar -- Tools/Settings live as in-app pages reached from
  // the sidebar's bottom icon bar.
  Menu.setApplicationMenu(null)

  createWindow()

  // Check GitHub Releases for a newer version and, if found, download + prompt.
  // No-op in dev; failures are swallowed so this never blocks startup.
  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopLocalServer()
  if (process.platform !== 'darwin') app.quit()
})
