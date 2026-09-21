import { app } from 'electron'
import { join } from 'path'
import { discoverPlugins, type DiscoveredPlugin } from './discover'
import { getPluginConfig, isPluginEnabled } from './config'
import type { PluginInfo } from '../../shared/plugin'

// Built-in plugins ship in extraResources (see package.json build.extraResources);
// user plugins live in userData/plugins. Same dev/packaged split as the tray icon.
const builtinDir = app.isPackaged
	? join(process.resourcesPath, 'plugins')
	: join(__dirname, '../../resources/plugins')

let cache: DiscoveredPlugin[] | null = null

/** Scanned once per launch; there is no hot reload. */
export function listPlugins(): DiscoveredPlugin[] {
	cache ??= discoverPlugins([
		{ dir: builtinDir, builtin: true },
		{ dir: join(app.getPath('userData'), 'plugins'), builtin: false },
	])
	return cache
}

export function mustFind(id: string): DiscoveredPlugin {
	const p = listPlugins().find((x) => x.manifest.id === id)
	if (!p) throw new Error(`Unknown plugin '${id}'`)
	return p
}

export function listInfo(): PluginInfo[] {
	return listPlugins().map(({ manifest, builtin }) => ({
		id: manifest.id,
		name: manifest.name,
		version: manifest.version,
		builtin,
		enabled: isPluginEnabled(manifest.id),
		selectionActions: manifest.contributes.selectionActions,
		config: manifest.config,
		values: getPluginConfig(manifest),
	}))
}
