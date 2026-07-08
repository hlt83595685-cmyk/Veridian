// Thin wrapper around @supabase/supabase-js pointed at the self-hosted
// control plane (control-plane/docker-compose.yml -- Postgres + GoTrue +
// PostgREST behind a Caddy proxy, see readme/workspace-sync/control-plane-selfhost.tex).
// Session tokens persist via SettingsService (encrypted at rest through the
// same safeStorage path as the MinerU API token) rather than browser
// localStorage, which doesn't exist in the main process.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSetting, setSetting } from './SettingsService'
import { emit } from '../core/Notifier'

const SESSION_KEY = 'controlPlane.session'
const STORAGE_KEY = 'veridian-control-plane-auth'

// supabase-js's storage adapter contract: get/set/remove a single string blob
// under whatever `storageKey` the client is configured with. We fix
// storageKey to one constant, so the `key` argument is never actually
// variable in practice -- ignored in favor of the one settings slot.
const electronAuthStorage = {
  getItem: (_key: string): string | null => {
    const v = getSetting(SESSION_KEY)
    return typeof v === 'string' && v ? v : null
  },
  setItem: (_key: string, value: string): void => {
    setSetting(SESSION_KEY, value)
  },
  removeItem: (_key: string): void => {
    setSetting(SESSION_KEY, '')
  },
}

let _client: SupabaseClient | null = null
let _configuredUrl: string | null = null

export function isConfigured(): boolean {
  return typeof getSetting('controlPlane.url') === 'string' && !!getSetting('controlPlane.url')
}

export function getControlPlaneUrl(): string | null {
  const v = getSetting('controlPlane.url')
  return typeof v === 'string' && v ? v : null
}

export function configure(url: string, anonKey: string): void {
  setSetting('controlPlane.url', url)
  setSetting('controlPlane.anonKey', anonKey)
  _client = null   // force recreation with the new endpoint
  emit({ type: 'controlPlane.changed' })
}

/** Returns null when no control plane has been configured yet. */
export function getClient(): SupabaseClient | null {
  const url = getControlPlaneUrl()
  const anonKey = getSetting('controlPlane.anonKey')
  if (!url || typeof anonKey !== 'string' || !anonKey) return null

  if (_client && _configuredUrl === url) return _client

  _client = createClient(url, anonKey, {
    auth: {
      storage: electronAuthStorage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      // Electron main process, not a browser tab -- no URL bar to detect
      // OAuth redirects from.
      detectSessionInUrl: false,
    },
  })
  _configuredUrl = url
  return _client
}

export function requireClient(): SupabaseClient {
  const client = getClient()
  if (!client) throw new Error('Control plane is not configured (Settings → Workspace)')
  return client
}
