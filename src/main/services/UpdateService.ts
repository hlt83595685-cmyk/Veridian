// Auto-update via electron-updater + GitHub Releases (public repo, no code
// signing -- the zero-cost path). Flow on every startup:
//   check -> if a newer version exists, download it silently in the background
//   -> once downloaded, ask the user -> quitAndInstall (quit, install, relaunch).
// Every failure (offline, GitHub unreachable, running unpackaged) is swallowed
// so update checking can never block or crash app startup.
import { dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'

let started = false

export function initAutoUpdater(): void {
  // Only packaged builds can update: dev has no latest.yml and app.getVersion()
  // is Electron's own version, so a check would always error. Guard against
  // double-init too (a second call would re-register listeners).
  if (is.dev || started) return
  started = true

  // Download as soon as we learn a newer version exists, but do NOT install on
  // quit -- the user's dialog choice is the only trigger for install/relaunch.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-downloaded', async (info) => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const opts = {
        type: 'info' as const,
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `Veridian ${info.version} 已就绪`,
        detail: '点击「立即更新」将退出并安装新版本，安装完成后自动重启。',
      }
      const { response } = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts)
      // isSilent=false: show the NSIS installer (our build is non-oneClick);
      // isForceRunAfter=true: relaunch Veridian once the install finishes.
      if (response === 0) autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      console.warn('[updater] prompt failed:', (err as Error)?.message ?? err)
    }
  })

  // Network errors, missing releases, rate limits -- all non-fatal. Log and
  // move on; the next startup will try again.
  autoUpdater.on('error', (err) => {
    console.warn('[updater] check/download failed:', err?.message ?? err)
  })

  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[updater] checkForUpdates threw:', err?.message ?? err)
  })
}
