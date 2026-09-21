// Floating menus are placed at the cursor, so a click near the bottom/right
// edge would otherwise open them partly off-screen. Returns the position to
// use along one axis so that [pos, pos + size] stays inside [0, viewport],
// `margin` away from the edge (the top/left margin wins if the menu is larger
// than the viewport).
export function clampToViewport(pos: number, size: number, viewport: number, margin = 8): number {
	return Math.max(margin, Math.min(pos, viewport - size - margin))
}
