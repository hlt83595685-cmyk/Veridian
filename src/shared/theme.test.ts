import { describe, it, expect } from 'vitest'
import { parseThemeMode } from './theme'

describe('parseThemeMode', () => {
	it.each(['system', 'light', 'dark'] as const)('returns %s unchanged', (mode) => {
		expect(parseThemeMode(mode)).toBe(mode)
	})

	it.each([null, undefined, '', 'Dark', 'auto', 1, {}])('falls back to system for %j', (v) => {
		expect(parseThemeMode(v)).toBe('system')
	})
})
