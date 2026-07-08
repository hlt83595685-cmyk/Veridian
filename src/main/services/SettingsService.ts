// Key-value settings store (userData/veridian-settings.json).
// The MinerU API token is encrypted at rest via Electron safeStorage when the
// OS keychain is available; plaintext fallback keeps portable installs working.
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { app, safeStorage } from 'electron'
import { emit } from '../core/Notifier'

const SECRET_KEYS = new Set(['tool.pdf2md.apiToken', 'controlPlane.session'])
const ENC_PREFIX = 'enc:'

let _cache: Record<string, unknown> | null = null

function settingsPath(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'veridian-settings.json')
}

function load(): Record<string, unknown> {
  if (_cache) return _cache
  try { _cache = JSON.parse(readFileSync(settingsPath(), 'utf-8')) }
  catch { _cache = {} }
  return _cache!
}

function persist(): void {
  writeFileSync(settingsPath(), JSON.stringify(_cache, null, 2), 'utf-8')
}

function encrypt(value: string): string {
  if (value && safeStorage.isEncryptionAvailable()) {
    return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
  }
  return value
}

function decrypt(stored: string): string {
  if (stored.startsWith(ENC_PREFIX) && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      return ''
    }
  }
  return stored
}

export function getSetting(key: string): unknown {
  const raw = load()[key]
  if (SECRET_KEYS.has(key) && typeof raw === 'string') return decrypt(raw)
  return raw ?? null
}

export function setSetting(key: string, value: unknown): void {
  const current = load()
  _cache = {
    ...current,
    [key]: SECRET_KEYS.has(key) && typeof value === 'string' ? encrypt(value) : value,
  }
  persist()
  emit({ type: 'settings.changed', keys: [key] })
}

// ── Typed accessors used across the main process ─────────────────────────────

export function isPdf2mdEnabled(): boolean {
  return load()['tool.pdf2md.enabled'] !== false
}

export function getPdf2mdMode(): 'agent' | 'precision' {
  return load()['tool.pdf2md.mode'] === 'precision' ? 'precision' : 'agent'
}

export function getPdf2mdApiToken(): string {
  const v = getSetting('tool.pdf2md.apiToken')
  return typeof v === 'string' ? v : ''
}

export function getStoragePath(): string | null {
  const v = load()['storage.path']
  return typeof v === 'string' && v ? v : null
}

export function saveStoragePath(p: string): void {
  setSetting('storage.path', p)
}
