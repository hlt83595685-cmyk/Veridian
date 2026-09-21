import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverPlugins, readPluginSource } from './discover'

let root: string
let other: string

function plugin(dir: string, name: string, manifest: object, source = 'void 0'): void {
	mkdirSync(join(dir, name), { recursive: true })
	writeFileSync(join(dir, name, 'manifest.json'), JSON.stringify(manifest))
	writeFileSync(join(dir, name, 'index.js'), source)
}

const m = (id: string): object => ({ id, name: id, version: '1.0.0', main: 'index.js' })

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'plugins-a-'))
	other = mkdtempSync(join(tmpdir(), 'plugins-b-'))
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
	rmSync(other, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe('discoverPlugins', () => {
	it('finds valid plugins and flags builtin roots', () => {
		plugin(root, 'alpha', m('alpha'))
		plugin(other, 'beta', m('beta'))
		const found = discoverPlugins([{ dir: root, builtin: true }, { dir: other, builtin: false }])
		expect(found.map((p) => [p.manifest.id, p.builtin])).toEqual([['alpha', true], ['beta', false]])
	})

	it('accepts a manifest saved with a UTF-8 BOM (Windows editors do this)', () => {
		mkdirSync(join(root, 'bom'), { recursive: true })
		writeFileSync(join(root, 'bom', 'manifest.json'), String.fromCharCode(0xFEFF) + JSON.stringify(m('bom')))
		writeFileSync(join(root, 'bom', 'index.js'), 'void 0')
		expect(discoverPlugins([{ dir: root, builtin: false }]).map((p) => p.manifest.id)).toEqual(['bom'])
	})

	it('skips a missing root without throwing', () => {
		expect(discoverPlugins([{ dir: join(root, 'nope'), builtin: false }])).toEqual([])
	})

	it('skips an invalid manifest and a folder whose name differs from the id', () => {
		plugin(root, 'bad', { id: 'BAD', name: 'x', version: '1', main: 'index.js' })
		plugin(root, 'folder', m('other-id'))
		expect(discoverPlugins([{ dir: root, builtin: false }])).toEqual([])
	})

	it('keeps the first plugin when two roots define the same id', () => {
		plugin(root, 'dup', m('dup'))
		plugin(other, 'dup', m('dup'))
		const found = discoverPlugins([{ dir: root, builtin: true }, { dir: other, builtin: false }])
		expect(found).toHaveLength(1)
		expect(found[0].builtin).toBe(true)
	})
})

describe('readPluginSource', () => {
	it('returns the main file text', () => {
		plugin(root, 'alpha', m('alpha'), 'console.log(1)')
		const [p] = discoverPlugins([{ dir: root, builtin: false }])
		expect(readPluginSource(p)).toBe('console.log(1)')
	})
})
