import { app, BrowserWindow, shell, ipcMain, protocol, net, Menu } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from './db'
import { startLocalServer, stopLocalServer } from './server'
import { registerIpcGateway } from './ipc/gateway'
import { initConversionService } from './services/ConversionService'
import { assertReadable } from './security/pathGuard'

let mainWindow: BrowserWindow | null = null

const menuLabels: Record<string, Record<string, string>> = {
  zh: {
    tools:       '工具',
    pdf2md:      'pdf2md 设置...',
    settings:    '设置',
    storagePath: '文件存储路径...',
    language:    '语言',
    langZh:      '中文',
    langEn:      'English',
  },
  en: {
    tools:       'Tools',
    pdf2md:      'pdf2md Settings...',
    settings:    'Settings',
    storagePath: 'Storage Path...',
    language:    'Language',
    langZh:      '中文',
    langEn:      'English',
  },
}

function buildMenu(locale: string): void {
  const L = menuLabels[locale] ?? menuLabels['zh']
  const menu = Menu.buildFromTemplate([
    {
      label: L.tools,
      submenu: [
        {
          label: L.pdf2md,
          click: (): void => { mainWindow?.webContents.send('tools:open', 'pdf2md') },
        },
      ],
    },
    {
      label: L.settings,
      submenu: [
        {
          label: L.storagePath,
          click: (): void => { mainWindow?.webContents.send('settings:open', 'storage') },
        },
        { type: 'separator' },
        {
          label: L.language,
          submenu: [
            {
              label: L.langZh,
              type: 'radio',
              checked: locale === 'zh',
              click: (): void => {
                mainWindow?.webContents.send('settings:setLocale', 'zh')
                buildMenu('zh')
              },
            },
            {
              label: L.langEn,
              type: 'radio',
              checked: locale === 'en',
              click: (): void => {
                mainWindow?.webContents.send('settings:setLocale', 'en')
                buildMenu('en')
              },
            },
          ],
        },
      ],
    },
  ])
  Menu.setApplicationMenu(menu)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
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
  registerIpcGateway(ipcMain)

  buildMenu('zh')

  // Renderer can ask main to rebuild menu with a new locale
  ipcMain.on('menu:setLocale', (_e, locale: string) => buildMenu(locale))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopLocalServer()
  if (process.platform !== 'darwin') app.quit()
})
