import { getSetting, setSetting } from '../services/SettingsService'
import { pluginConfigKey, pluginEnabledKey, type PluginManifest } from '../../shared/plugin'

/** Every declared field, falling back to the manifest default, then ''. */
export function getPluginConfig(m: PluginManifest): Record<string, string> {
	const out: Record<string, string> = {}
	for (const f of m.config) {
		const v = getSetting(pluginConfigKey(m.id, f))
		out[f.key] = typeof v === 'string' && v !== '' ? v : (f.default ?? '')
	}
	return out
}

export function setPluginConfig(m: PluginManifest, key: string, value: string): void {
	const f = m.config.find((x) => x.key === key)
	if (!f) throw new Error(`Unknown config key '${key}'`)
	if (f.type === 'select' && value !== '' && !f.options?.includes(value)) {
		throw new Error(`Invalid value for '${key}'`)
	}
	setSetting(pluginConfigKey(m.id, f), value)
}

/** Enabled unless the user switched it off. */
export function isPluginEnabled(id: string): boolean {
	return getSetting(pluginEnabledKey(id)) !== false
}

export function setPluginEnabled(id: string, enabled: boolean): void {
	setSetting(pluginEnabledKey(id), enabled)
}
