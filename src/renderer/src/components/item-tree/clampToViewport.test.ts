import { describe, it, expect } from 'vitest'
import { clampToViewport } from './clampToViewport'

describe('clampToViewport', () => {
	it('leaves a position that already fits untouched', () => {
		expect(clampToViewport(100, 200, 800)).toBe(100)
	})

	it('pulls a menu back up when it would overflow the bottom edge', () => {
		// click at y=780 in an 800px window, 300px-tall menu -> bottom sits 8px above the edge
		expect(clampToViewport(780, 300, 800)).toBe(492)
	})

	it('keeps the margin when the menu ends exactly at the edge', () => {
		expect(clampToViewport(492, 300, 800)).toBe(492)
		expect(clampToViewport(493, 300, 800)).toBe(492)
	})

	it('never goes above the top margin when the menu is taller than the window', () => {
		expect(clampToViewport(50, 900, 800)).toBe(8)
	})

	it('honours a custom margin', () => {
		expect(clampToViewport(790, 100, 800, 0)).toBe(700)
	})
})
