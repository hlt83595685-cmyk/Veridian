import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginConfigField, PluginInfo } from '../../../../shared/plugin'
import { pluginRuntime } from '../../plugins/PluginRuntime'

const inputStyle: CSSProperties = {
	height: 32, padding: '0 10px', borderRadius: 8, width: '100%',
	border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground)', fontSize: 13,
}

export function PluginsSettingsTab(): JSX.Element {
	const { t } = useTranslation('common')
	const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
	const reload = useCallback((): void => { void window.veridian.plugins.list().then(setPlugins) }, [])
	useEffect(reload, [reload])

	const toggle = async (p: PluginInfo, on: boolean): Promise<void> => {
		await window.veridian.plugins.setEnabled(p.id, on)
		if (!on) pluginRuntime.dispose(p.id)
		reload()
	}

	if (!plugins) return <div />
	if (plugins.length === 0) {
		return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t('settings.plugins.empty')}</div>
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
			{plugins.map((p) => (
				<div key={p.id} style={{
					padding: '12px 14px', borderRadius: 10,
					background: 'var(--surface-2)', border: '1px solid var(--border)',
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{p.name}</span>
						<span style={{ fontSize: 11, color: 'var(--muted)' }}>
							v{p.version}{p.builtin ? ` · ${t('settings.plugins.builtin')}` : ''}
						</span>
						<div style={{ flex: 1 }} />
						<label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--foreground-2)', cursor: 'pointer' }}>
							<input type="checkbox" checked={p.enabled} onChange={(e) => void toggle(p, e.target.checked)} />
							{t('settings.plugins.enabled')}
						</label>
					</div>
					{p.config.length > 0 && (
						<div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
							{p.config.map((f) => <FieldRow key={f.key} plugin={p} field={f} onSaved={reload} />)}
						</div>
					)}
				</div>
			))}
		</div>
	)
}

function FieldRow({ plugin, field, onSaved }: {
	plugin: PluginInfo
	field: PluginConfigField
	onSaved: () => void
}): JSX.Element {
	const stored = plugin.values[field.key] ?? ''
	const [value, setValue] = useState(stored)
	const save = (v: string): void => {
		if (v === stored) return
		void window.veridian.plugins.setConfig(plugin.id, field.key, v).then(onSaved)
	}
	return (
		<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
			<span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground-2)' }}>
				{field.label}{field.required ? ' *' : ''}
			</span>
			{field.type === 'select' ? (
				<select
					value={value}
					style={inputStyle}
					onChange={(e) => { setValue(e.target.value); save(e.target.value) }}
				>
					{field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
				</select>
			) : (
				<input
					type={field.type === 'password' ? 'password' : 'text'}
					value={value}
					style={inputStyle}
					spellCheck={false}
					autoComplete="off"
					onChange={(e) => setValue(e.target.value)}
					onBlur={() => save(value)}
				/>
			)}
		</label>
	)
}
