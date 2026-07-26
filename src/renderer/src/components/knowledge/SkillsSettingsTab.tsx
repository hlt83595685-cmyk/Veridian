import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DomainEvent } from '../../../../shared/events'

interface SkillInfo { name: string; description: string }

export function SkillsSettingsTab(): JSX.Element {
	const { t } = useTranslation('common')
	const [skills, setSkills] = useState<SkillInfo[]>([])
	const [githubUrl, setGithubUrl] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		void refresh()
		const onEvent = (e: DomainEvent): void => { if (e.type === 'skills.changed') void refresh() }
		return window.veridian.onDomainEvent(onEvent)
	}, [])

	async function refresh(): Promise<void> {
		setSkills(await window.veridian.skills.list())
	}

	async function installFromGithub(): Promise<void> {
		const url = githubUrl.trim()
		if (!url || busy) return
		setBusy(true)
		setError(null)
		try {
			await window.veridian.skills.installFromGithub(url)
			setGithubUrl('')
			await refresh()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	async function installFromZip(): Promise<void> {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			const info = await window.veridian.skills.installFromZip()
			if (info) await refresh()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}

	async function uninstall(name: string): Promise<void> {
		await window.veridian.skills.uninstall(name)
		await refresh()
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
			<Section label={t('settings.skills.installedTitle')}>
				{skills.length === 0 ? (
					<div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('settings.skills.noneInstalled')}</div>
				) : (
					<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
						{skills.map((s) => (
							<div key={s.name} style={{
								display: 'flex', flexDirection: 'column', gap: 4,
								padding: '10px 10px', borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)',
							}}>
								<div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
									<div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
										{s.name}
									</div>
									<button
										onClick={() => void uninstall(s.name)}
										title={t('settings.skills.uninstall')}
										style={{ border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 0, flexShrink: 0, lineHeight: 1 }}
									>
										✕
									</button>
								</div>
								<div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{s.description}</div>
							</div>
						))}
					</div>
				)}
			</Section>

			<div style={{ maxWidth: 480 }}>
			<Section label={t('settings.skills.installTitle')}>
				<div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>{t('settings.skills.installDesc')}</div>
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<div style={{ display: 'flex', gap: 8 }}>
						<input
							value={githubUrl}
							onChange={(e) => setGithubUrl(e.target.value)}
							onKeyDown={(e) => { if (e.key === 'Enter') void installFromGithub() }}
							placeholder="https://github.com/anthropics/skills/tree/main/pdf"
							style={inputStyle}
						/>
						<button onClick={() => void installFromGithub()} disabled={busy || !githubUrl.trim()} style={primaryBtnStyle}>
							{t('settings.skills.installFromGithub')}
						</button>
					</div>
					<button onClick={() => void installFromZip()} disabled={busy} style={{ ...secondaryBtnStyle, alignSelf: 'flex-start' }}>
						{t('settings.skills.installFromZip')}
					</button>
					{error && (
						<div style={{
							fontSize: 11.5, color: 'var(--danger, #dc2626)', lineHeight: 1.5,
							background: 'var(--muted-bg)', borderRadius: 8, padding: '8px 10px',
							wordBreak: 'break-word', overflowWrap: 'anywhere',
						}}>
							{error}
						</div>
					)}
				</div>
			</Section>
			</div>
		</div>
	)
}

function Section({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
			<div style={{
				fontSize: 11, fontWeight: 600, color: 'var(--muted)',
				textTransform: 'uppercase', letterSpacing: '0.06em',
			}}>
				{label}
			</div>
			<div style={{
				padding: '12px 14px', borderRadius: 10,
				background: 'var(--surface-2)', border: '1px solid var(--border)',
			}}>
				{children}
			</div>
		</div>
	)
}

const inputStyle: React.CSSProperties = {
	flex: 1, height: 30, padding: '0 10px', borderRadius: 8,
	border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground)', fontSize: 12,
}

const primaryBtnStyle: React.CSSProperties = {
	height: 32, padding: '0 16px', borderRadius: 8,
	border: 'none', background: 'var(--primary)',
	color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}

const secondaryBtnStyle: React.CSSProperties = {
	height: 32, padding: '0 16px', borderRadius: 8,
	border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground-2)', fontSize: 13, cursor: 'pointer',
}
