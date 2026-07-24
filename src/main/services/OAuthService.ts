// Electron glue over the pure deviceFlow logic: kicks off login, copies the
// user code to the clipboard, opens the browser, polls in the background, and
// stores the token. One login runs at a time.
import { clipboard, shell } from 'electron'
import { requestDeviceCode, pollForToken, type Fetcher } from './deviceFlow'
import { setGitHubToken } from './GitHubService'
import { emit } from '../core/Notifier'

const CLIENT_ID = 'Ov23ctrnOpGpsZz3wUMF'
const SCOPE = 'repo'

const nodeFetch: Fetcher = ((url: string, init?: unknown) =>
  fetch(url, init as RequestInit)) as unknown as Fetcher

let cancelFlag = false

export interface LoginStart {
  userCode: string
  verificationUri: string
}

/** Begin device login: returns the code to show, and polls in the background.
 *  On success stores the token and emits github.authChanged. */
export async function startDeviceLogin(): Promise<LoginStart> {
  cancelFlag = false
  const code = await requestDeviceCode(CLIENT_ID, SCOPE, nodeFetch)
  clipboard.writeText(code.userCode)
  shell.openExternal(code.verificationUri)

  // Background poll -- do NOT await; the renderer learns via github.authChanged.
  void pollForToken(CLIENT_ID, code.deviceCode, code.interval, nodeFetch, {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isCancelled: () => cancelFlag,
  })
    .then((token) => setGitHubToken(token))
    .catch((err) => {
      if ((err as Error).message !== 'cancelled') {
        console.warn('[oauth] login failed:', (err as Error).message)
        emit({ type: 'github.authChanged' })
      }
    })

  return { userCode: code.userCode, verificationUri: code.verificationUri }
}

export function cancelDeviceLogin(): void {
  cancelFlag = true
}
