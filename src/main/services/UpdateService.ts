// Auto-update via electron-updater + GitHub Releases (public repo, no code
// signing -- the zero-cost path). Flow on every startup:
//   check -> if a newer version exists, download it silently in the background
//   -> once downloaded, ask the user -> quitAndInstall (quit, install, relaunch).
// Every failure (offline, GitHub unreachable, running unpackaged) is swallowed
// so update checking can never block or crash app startup.
import { dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateCheckResult } from '../../shared/types'

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

// Manual, on-demand check (About panel). Auto-update only runs once at startup,
// so a long-running app (kept alive by the tray) would otherwise never notice a
// new release. Resolves with the outcome; if a newer version exists it starts
// downloading (autoDownload) and the startup 'update-downloaded' handler will
// prompt to install. One-shot listeners + a 30s timeout so it always settles.
export async function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (is.dev) return { status: 'dev' }
  return new Promise<UpdateCheckResult>((resolve) => {
    let settled = false
    const finish = (r: UpdateCheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      autoUpdater.removeListener('update-available', onAvail)
      autoUpdater.removeListener('update-not-available', onNot)
      autoUpdater.removeListener('error', onErr)
      resolve(r)
    }
    const onAvail = (info: { version: string }): void => finish({ status: 'available', version: info.version })
    const onNot = (info: { version: string }): void => finish({ status: 'not-available', version: info.version })
    const onErr = (err: Error): void => finish({ status: 'error', message: err?.message ?? String(err) })
    const timer = setTimeout(() => finish({ status: 'error', message: 'timeout' }), 30_000)
    autoUpdater.on('update-available', onAvail)
    autoUpdater.on('update-not-available', onNot)
    autoUpdater.on('error', onErr)
    autoUpdater.checkForUpdates().catch((err: Error) =>
      finish({ status: 'error', message: err?.message ?? String(err) }))
  })
}
