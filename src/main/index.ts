import { app, BrowserWindow, shell, ipcMain, protocol, net, Menu, Tray } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getSetting, setSetting } from './services/SettingsService'
import { initDatabase } from './db'
import { startLocalServer, stopLocalServer } from './server'
import { registerIpcGateway } from './ipc/gateway'
import { initConversionService } from './services/ConversionService'
import { initWorkspaceSyncService } from './services/WorkspaceSyncService'
import { initKnowledgeIndexer } from './knowledge/indexer'
import { migrateStagedPayloads } from './services/StorageGC'
import { initAutoUpdater } from './services/UpdateService'
import { assertReadable } from './security/pathGuard'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// Closing the window hides it to the tray instead of quitting; only an explicit
// quit (tray menu, auto-updater relaunch, app.quit) sets this to let the window
// actually close.
let isQuitting = false

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

// The tray needs a real image file at runtime (unlike the window icon, which the
// packaged exe supplies). resources/ is not inside the asar, so in production it
// comes from extraResources (see package.json build.extraResources).
const trayIconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.ico')
  : join(__dirname, '../../resources/icon.ico')

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

  // Closing the window keeps Veridian running in the tray (so the browser-
  // extension connector and background jobs stay alive) instead of quitting.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
    // First time only, tell the user where the app went so a vanished window
    // doesn't read as a crash. Persisted so we never nag on later closes.
    if (process.platform === 'win32' && getSetting('ui.trayHintShown') !== true) {
      setSetting('ui.trayHintShown', true)
      tray?.displayBalloon({
        iconType: 'info',
        title: 'Veridian 仍在后台运行',
        content: '点击托盘图标可随时回到 Veridian；如需彻底退出，右键托盘图标选择「退出」。',
      })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Bring the window back from the tray (creating it if it was fully quit before).
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// System-tray icon: left-click restores the window (Windows convention); the
// context menu offers an explicit quit that bypasses the close-to-tray guard.
function createTray(): void {
  tray = new Tray(trayIconPath)
  tray.setToolTip('Veridian')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Veridian', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ]))
  tray.on('click', showMainWindow)
}

// Single-instance lock (packaged builds only). Because closing the window only
// hides Veridian to the tray, it commonly keeps running in the background -- so
// a fresh launch (double-clicking the shortcut, opening a file) must re-focus
// the existing window, not spawn a second process. A duplicate can't bind port
// 23120 or share Chromium's cache directory -- exactly the "port in use" +
// cache-access-denied startup errors. The primary instance is notified via
// 'second-instance' and brings its window back from the tray.
// Gated to app.isPackaged so a `npm run dev` session can still run alongside an
// installed copy during development (electron-vite manages its own restarts).
const isPrimaryInstance = !app.isPackaged || app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else if (app.isPackaged) {
  app.on('second-instance', () => showMainWindow())
}

// Register veridian-file:// protocol so the renderer can load local files
// (file:// is blocked by Electron's CSP in sandboxed contexts)
protocol.registerSchemesAsPrivileged([
  { scheme: 'veridian-file', privileges: { secure: true, supportFetchAPI: true, stream: true } },
])

app.whenReady().then(async () => {
  // A secondary instance is on its way out (app.quit above); never create a
  // window, DB connection, or local server from it.
  if (!isPrimaryInstance) return
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
  initKnowledgeIndexer()
  try {
    const moved = migrateStagedPayloads()
    if (moved > 0) console.log(`[startup] moved ${moved} staged payload(s) into permanent storage`)
  } catch (err) {
    console.warn('[startup] staged-payload migration failed:', (err as Error).message)
  }
  registerIpcGateway(ipcMain)

  // No native menu bar -- Tools/Settings live as in-app pages reached from
  // the sidebar's bottom icon bar.
  Menu.setApplicationMenu(null)

  createWindow()
  createTray()

  // Check GitHub Releases for a newer version and, if found, download + prompt.
  // No-op in dev; failures are swallowed so this never blocks startup.
  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Any real quit path (tray menu, auto-updater relaunch, OS shutdown) flips the
// guard so the window's close handler stops hiding and lets it close for good.
app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
})

app.on('window-all-closed', () => {
  stopLocalServer()
  if (process.platform !== 'darwin') app.quit()
})
