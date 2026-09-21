export type ThemeMode = 'system' | 'light' | 'dark'

export function parseThemeMode(v: unknown): ThemeMode {
	return v === 'light' || v === 'dark' ? v : 'system'
}
