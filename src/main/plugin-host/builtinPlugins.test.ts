import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { discoverPlugins } from './discover'
import { allowedHosts } from '../../shared/plugin'

// The plugins we ship must be accepted by our own manifest parser, or they silently vanish at runtime.
const builtin = discoverPlugins([{ dir: join(__dirname, '../../../resources/plugins'), builtin: true }])

describe('built-in plugins', () => {
	it('ships the translate plugin with one selection action', () => {
		const p = builtin.find((x) => x.manifest.id === 'translate')
		expect(p).toBeDefined()
		expect(p!.manifest.contributes.selectionActions).toEqual([{ id: 'translate', title: '翻译' }])
	})

	it('translate declares its own API config, with the key stored as a secret', () => {
		const m = builtin.find((x) => x.manifest.id === 'translate')!.manifest
		expect(m.config.map((f) => [f.key, f.type, f.required ?? false])).toEqual([
			['baseURL', 'url', true],
			['apiKey', 'password', true],
			['model', 'text', true],
			['targetLang', 'text', false],
		])
	})

	it('translate may only reach the host the user configured, nothing else by default', () => {
		const m = builtin.find((x) => x.manifest.id === 'translate')!.manifest
		expect(m.network).toEqual([])
		expect([...allowedHosts(m, { baseURL: 'https://api.deepseek.com/v1' })]).toEqual(['api.deepseek.com'])
		expect(allowedHosts(m, { baseURL: '' }).size).toBe(0)
	})
})
