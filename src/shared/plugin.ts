import { z } from 'zod'

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export interface PluginConfigField {
	key: string
	label: string
	type: 'text' | 'password' | 'url' | 'select'
	required?: boolean
	default?: string
	options?: string[]
}

export interface PluginSelectionAction { id: string; title: string }

export interface PluginManifest {
	id: string
	name: string
	version: string
	main: string
	network: string[]
	contributes: { selectionActions: PluginSelectionAction[] }
	config: PluginConfigField[]
}

/** What the settings page and the reader need to know about one plugin. */
export interface PluginInfo {
	id: string
	name: string
	version: string
	builtin: boolean
	enabled: boolean
	selectionActions: PluginSelectionAction[]
	config: PluginConfigField[]
	values: Record<string, string>
}

/** A network request a plugin asks the host to make on its behalf. */
export interface PluginFetchRequest {
	id: string
	pluginId: string
	url: string
	method: string
	headers: Record<string, string>
	body?: string
}

export type PluginFetchEvent =
	| { id: string; type: 'head'; status: number; statusText: string; headers: Record<string, string> }
	| { id: string; type: 'chunk'; data: Uint8Array }
	| { id: string; type: 'end' }
	| { id: string; type: 'error'; message: string }

const configFieldSchema = z.object({
	key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
	label: z.string().min(1).max(64),
	type: z.enum(['text', 'password', 'url', 'select']),
	required: z.boolean().optional(),
	default: z.string().max(256).optional(),
	options: z.array(z.string().min(1).max(64)).max(32).optional(),
})

const actionSchema = z.object({
	id: z.string().regex(/^[a-z][a-zA-Z0-9-]{0,31}$/),
	title: z.string().min(1).max(32),
})

const manifestSchema = z.object({
	id: z.string().regex(PLUGIN_ID_RE),
	name: z.string().min(1).max(64),
	version: z.string().min(1).max(32),
	main: z.string().regex(/^[\w.-]+\.js$/),
	network: z.array(z.string().regex(/^[A-Za-z0-9.-]{1,253}$/)).max(32).optional(),
	contributes: z.object({ selectionActions: z.array(actionSchema).max(8).optional() }).optional(),
	config: z.array(configFieldSchema).max(16).optional(),
})

function isLocalName(host: string): boolean {
	const h = host.toLowerCase().replace(/\.+$/, '')
	return h === 'localhost' || h.endsWith('.localhost') || h.startsWith('127.') || h === '0.0.0.0'
}

export function parseManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
	const r = manifestSchema.safeParse(raw)
	if (!r.success) {
		const issue = r.error.issues[0]
		return { ok: false, error: `${issue.path.join('.') || 'manifest'}: ${issue.message}` }
	}
	const config = r.data.config ?? []
	const keys = new Set<string>()
	for (const f of config) {
		if (keys.has(f.key)) return { ok: false, error: `config: duplicate key '${f.key}'` }
		keys.add(f.key)
		if (f.type === 'select' && (!f.options || f.options.length === 0)) {
			return { ok: false, error: `config.${f.key}: select needs options` }
		}
	}
	// The manifest is the plugin author's word, so it may not grant access to local services;
	// those are reachable only through a url field the user fills in (see allowedHosts).
	const network = (r.data.network ?? []).map((h) => h.toLowerCase())
	const local = network.find(isLocalName)
	if (local) return { ok: false, error: `network: '${local}' is a local address; only the user may point a plugin at one` }
	return {
		ok: true,
		manifest: {
			id: r.data.id,
			name: r.data.name,
			version: r.data.version,
			main: r.data.main,
			network,
			contributes: { selectionActions: r.data.contributes?.selectionActions ?? [] },
			config,
		},
	}
}

/** Manifest-declared hosts plus the hosts of the user's own `url` config values. */
export function allowedHosts(manifest: PluginManifest, config: Record<string, string>): Set<string> {
	const hosts = new Set(manifest.network)
	for (const f of manifest.config) {
		if (f.type !== 'url') continue
		const v = config[f.key]
		if (!v) continue
		try { hosts.add(new URL(v).hostname.toLowerCase()) } catch { /* not a URL: contributes nothing */ }
	}
	return hosts
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function checkFetchTarget(raw: string, allowed: Set<string>): { ok: true; url: URL } | { ok: false; error: string } {
	let url: URL
	try { url = new URL(raw) } catch { return { ok: false, error: 'invalid URL' } }
	const host = url.hostname.toLowerCase()
	if (!allowed.has(host)) return { ok: false, error: `host not allowed: ${host}` }
	if (url.protocol === 'https:') return { ok: true, url }
	if (url.protocol === 'http:' && LOOPBACK.has(host)) return { ok: true, url }
	return { ok: false, error: `protocol not allowed: ${url.protocol}` }
}

/** Password fields go in a namespace SettingsService encrypts; see isPluginSecretKey. */
export function pluginConfigKey(id: string, field: { key: string; type: string }): string {
	return field.type === 'password' ? `plugin.${id}.secret.${field.key}` : `plugin.${id}.config.${field.key}`
}

export function pluginEnabledKey(id: string): string {
	return `plugin.${id}.enabled`
}

export function isPluginSecretKey(key: string): boolean {
	return /^plugin\.[a-z0-9-]+\.secret\./.test(key)
}
