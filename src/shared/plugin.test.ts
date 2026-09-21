import { describe, it, expect } from 'vitest'
import {
	parseManifest, allowedHosts, checkFetchTarget,
	pluginConfigKey, pluginEnabledKey, isPluginSecretKey,
	type PluginManifest,
} from './plugin'

const minimal = { id: 'demo', name: 'Demo', version: '1.0.0', main: 'index.js' }

function manifest(extra: Partial<PluginManifest> = {}): PluginManifest {
	const r = parseManifest({ ...minimal })
	if (!r.ok) throw new Error(r.error)
	return { ...r.manifest, ...extra }
}

describe('parseManifest', () => {
	it('accepts a minimal manifest and fills empty defaults', () => {
		const r = parseManifest(minimal)
		expect(r.ok).toBe(true)
		if (r.ok) {
			expect(r.manifest.network).toEqual([])
			expect(r.manifest.contributes.selectionActions).toEqual([])
			expect(r.manifest.config).toEqual([])
		}
	})

	it('rejects a bad id', () => {
		expect(parseManifest({ ...minimal, id: 'Bad_ID' }).ok).toBe(false)
	})

	it('rejects a main that is not a plain .js filename', () => {
		expect(parseManifest({ ...minimal, main: '../x.js' }).ok).toBe(false)
		expect(parseManifest({ ...minimal, main: 'sub/x.js' }).ok).toBe(false)
	})

	it('rejects duplicate config keys', () => {
		const config = [
			{ key: 'a', label: 'A', type: 'text' },
			{ key: 'a', label: 'A2', type: 'text' },
		]
		expect(parseManifest({ ...minimal, config }).ok).toBe(false)
	})

	it('rejects a select field without options', () => {
		expect(parseManifest({ ...minimal, config: [{ key: 's', label: 'S', type: 'select' }] }).ok).toBe(false)
	})

	it('rejects a network entry that is not a bare hostname', () => {
		expect(parseManifest({ ...minimal, network: ['https://api.example.com/v1'] }).ok).toBe(false)
	})

	it('lowercases network hosts', () => {
		const r = parseManifest({ ...minimal, network: ['API.Example.com'] })
		expect(r.ok && r.manifest.network).toEqual(['api.example.com'])
	})

	// A manifest is written by the plugin author, not the user. Letting it name a local
	// address would let a plugin call any local service (e.g. Veridian's own connector on
	// localhost:23120); local addresses are only reachable via a url field the user fills in.
	it.each(['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0'])(
		'rejects the local address %s in network',
		(host) => {
			expect(parseManifest({ ...minimal, network: [host] }).ok).toBe(false)
		},
	)
})

describe('allowedHosts', () => {
	it('merges manifest hosts with the hosts of url-typed config values', () => {
		const m = manifest({
			network: ['fixed.example.com'],
			config: [
				{ key: 'baseURL', label: 'URL', type: 'url' },
				{ key: 'name', label: 'Name', type: 'text' },
			],
		})
		const hosts = allowedHosts(m, { baseURL: 'https://Api.Mine.com/v1', name: 'https://not-a-url-field.com' })
		expect([...hosts].sort()).toEqual(['api.mine.com', 'fixed.example.com'])
	})

	it('ignores an unparsable url value', () => {
		const m = manifest({ config: [{ key: 'baseURL', label: 'URL', type: 'url' }] })
		expect(allowedHosts(m, { baseURL: 'nonsense' }).size).toBe(0)
	})
})

describe('checkFetchTarget', () => {
	const allowed = new Set(['api.example.com', 'localhost', '127.0.0.1'])

	it('allows https to an allowed host', () => {
		const r = checkFetchTarget('https://api.example.com/v1/x', allowed)
		expect(r.ok).toBe(true)
	})

	it('rejects a host that is not allowed', () => {
		const r = checkFetchTarget('https://evil.com/', allowed)
		expect(r).toEqual({ ok: false, error: 'host not allowed: evil.com' })
	})

	it('rejects plain http to a non-loopback host', () => {
		const r = checkFetchTarget('http://api.example.com/', allowed)
		expect(r.ok).toBe(false)
	})

	it('allows plain http to an allowed loopback host', () => {
		expect(checkFetchTarget('http://localhost:11434/v1', allowed).ok).toBe(true)
		expect(checkFetchTarget('http://127.0.0.1:8080/', allowed).ok).toBe(true)
	})

	it('rejects other protocols and malformed URLs', () => {
		expect(checkFetchTarget('file:///etc/passwd', new Set(['']))).toMatchObject({ ok: false })
		expect(checkFetchTarget('not a url', allowed)).toEqual({ ok: false, error: 'invalid URL' })
	})
})

describe('config keys', () => {
	it('stores password fields under the secret namespace', () => {
		expect(pluginConfigKey('demo', { key: 'apiKey', type: 'password' })).toBe('plugin.demo.secret.apiKey')
		expect(pluginConfigKey('demo', { key: 'model', type: 'text' })).toBe('plugin.demo.config.model')
		expect(pluginEnabledKey('demo')).toBe('plugin.demo.enabled')
	})

	it('recognises only the secret namespace as secret', () => {
		expect(isPluginSecretKey('plugin.demo.secret.apiKey')).toBe(true)
		expect(isPluginSecretKey('plugin.demo.config.apiKey')).toBe(false)
		expect(isPluginSecretKey('knowledge.chat.apiKey')).toBe(false)
	})
})
