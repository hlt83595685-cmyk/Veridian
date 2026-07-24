// Pure GitHub Device Flow logic -- no Electron deps, so it unit-tests under
// plain vitest. The Electron glue (clipboard, browser, token storage) lives
// in OAuthService and calls into here.
export type Fetcher = (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

async function postJson(fetch: Fetcher, url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

export async function requestDeviceCode(clientId: string, scope: string, fetch: Fetcher): Promise<DeviceCode> {
  const d = await postJson(fetch, DEVICE_CODE_URL, { client_id: clientId, scope })
  if (!d.device_code) throw new Error(d.error ?? 'device_code_request_failed')
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    interval: d.interval ?? 5,
    expiresIn: d.expires_in ?? 900,
  }
}

export interface PollDeps {
  sleep: (ms: number) => Promise<void>
  isCancelled?: () => boolean
}

export async function pollForToken(
  clientId: string, deviceCode: string, intervalSec: number,
  fetch: Fetcher, deps: PollDeps,
): Promise<string> {
  let interval = intervalSec
  for (;;) {
    if (deps.isCancelled?.()) throw new Error('cancelled')
    await deps.sleep(interval * 1000)
    if (deps.isCancelled?.()) throw new Error('cancelled')
    const d = await postJson(fetch, ACCESS_TOKEN_URL, {
      client_id: clientId, device_code: deviceCode, grant_type: GRANT_TYPE,
    })
    if (d.access_token) return d.access_token
    switch (d.error) {
      case 'authorization_pending': break
      case 'slow_down': interval = (d.interval ?? interval) + 1; break
      default: throw new Error(d.error ?? 'token_poll_failed')
    }
  }
}
