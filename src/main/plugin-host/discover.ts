import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { parseManifest, type PluginManifest } from '../../shared/plugin'

export interface DiscoveredPlugin {
	manifest: PluginManifest
	dir: string
	builtin: boolean
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/** Earlier roots win on duplicate ids, so list the built-in root first. */
export function discoverPlugins(roots: { dir: string; builtin: boolean }[]): DiscoveredPlugin[] {
	const found = new Map<string, DiscoveredPlugin>()
	for (const root of roots) {
		let names: string[]
		try { names = readdirSync(root.dir) } catch { continue }
		for (const name of names) {
			const dir = join(root.dir, name)
			try {
				if (!statSync(dir).isDirectory()) continue
				// Windows editors often save JSON with a BOM, which JSON.parse rejects.
				const raw = readFileSync(join(dir, 'manifest.json'), 'utf-8')
				const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
				const parsed = parseManifest(JSON.parse(text))
				if (!parsed.ok) { console.warn(`[plugins] ${name}: ${parsed.error}`); continue }
				const { manifest } = parsed
				if (manifest.id !== name) { console.warn(`[plugins] ${name}: id '${manifest.id}' must equal the folder name`); continue }
				if (found.has(manifest.id)) { console.warn(`[plugins] ${name}: duplicate id, ignored`); continue }
				found.set(manifest.id, { manifest, dir, builtin: root.builtin })
			} catch (err) {
				console.warn(`[plugins] ${name}: ${(err as Error).message}`)
			}
		}
	}
	return [...found.values()]
}

export function readPluginSource(p: DiscoveredPlugin): string {
	const file = join(p.dir, p.manifest.main)
	if (statSync(file).size > MAX_SOURCE_BYTES) throw new Error(`Plugin '${p.manifest.id}' is too large`)
	return readFileSync(file, 'utf-8')
}
