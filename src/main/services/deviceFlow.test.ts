import { describe, it, expect, vi } from 'vitest'
import { requestDeviceCode, pollForToken, type Fetcher } from './deviceFlow'

const CLIENT_ID = 'test-client'

function jsonFetcher(map: Record<string, unknown>): Fetcher {
  return (async (url: string) => ({
    ok: true,
    json: async () => map[url],
  })) as unknown as Fetcher
}

describe('requestDeviceCode', () => {
  it('parses the device/code response', async () => {
    const fetch = jsonFetcher({
      'https://github.com/login/device/code': {
        device_code: 'dev123', user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        interval: 5, expires_in: 900,
      },
    })
    const r = await requestDeviceCode(CLIENT_ID, 'repo', fetch)
    expect(r.userCode).toBe('WDJB-MJHT')
    expect(r.deviceCode).toBe('dev123')
    expect(r.interval).toBe(5)
  })
})

describe('pollForToken', () => {
  it('returns the access token on success', async () => {
    const responses = [
      { error: 'authorization_pending' },
      { access_token: 'gho_abc', token_type: 'bearer', scope: 'repo' },
    ]
    let i = 0
    const fetch = (async () => ({ ok: true, json: async () => responses[i++] })) as unknown as Fetcher
    const token = await pollForToken(CLIENT_ID, 'dev123', 0, fetch, { sleep: async () => {} })
    expect(token).toBe('gho_abc')
  })

  it('throws on expired_token', async () => {
    const fetch = (async () => ({ ok: true, json: async () => ({ error: 'expired_token' }) })) as unknown as Fetcher
    await expect(pollForToken(CLIENT_ID, 'dev123', 0, fetch, { sleep: async () => {} }))
      .rejects.toThrow('expired_token')
  })

  it('throws on access_denied', async () => {
    const fetch = (async () => ({ ok: true, json: async () => ({ error: 'access_denied' }) })) as unknown as Fetcher
    await expect(pollForToken(CLIENT_ID, 'dev123', 0, fetch, { sleep: async () => {} }))
      .rejects.toThrow('access_denied')
  })

  it('honors slow_down by increasing interval then succeeding', async () => {
    const responses = [
      { error: 'slow_down', interval: 1 },
      { access_token: 'gho_xyz' },
    ]
    let i = 0
    const sleeps: number[] = []
    const fetch = (async () => ({ ok: true, json: async () => responses[i++] })) as unknown as Fetcher
    const token = await pollForToken(CLIENT_ID, 'dev123', 0, fetch, {
      sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(token).toBe('gho_xyz')
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
  })

  it('stops when the cancel signal is set', async () => {
    const cancelled = { value: false }
    const fetch = (async () => { cancelled.value = true; return { ok: true, json: async () => ({ error: 'authorization_pending' }) } }) as unknown as Fetcher
    await expect(pollForToken(CLIENT_ID, 'dev123', 0, fetch, {
      sleep: async () => {},
      isCancelled: () => cancelled.value,
    })).rejects.toThrow('cancelled')
  })
})
