// Pixel-art plumbing for the pasture.
//
// Two rules make pixel art look like pixel art rather than a blurry photo of
// pixel art, and both are enforced here rather than left to callers:
//   1. Never scale by a fraction. The scene is drawn at a small logical size
//      and blown up by a whole number, so one source pixel is always an exact
//      square block of screen pixels.
//   2. Never let the browser interpolate. Every context this module hands out
//      has smoothing disabled.

/** Logical pixels per scene pixel is always a whole number, so the scene's
 *  logical size follows the container rather than being fixed -- a pasture
 *  should fill its field, not sit letterboxed inside one. */
export const MIN_SCALE = 2
export const MAX_SCALE = 5

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas')
	c.width = w
	c.height = h
	return c
}

export function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = c.getContext('2d')
	if (!ctx) throw new Error('2d context unavailable')
	ctx.imageSmoothingEnabled = false
	return ctx
}

/** Pick the zoom first, then let the scene take whatever logical size the box
 *  affords at that zoom. Bigger boxes therefore show *more pasture* rather than
 *  a bigger horse, which is what makes it feel like a place. */
export function sceneSize(boxW: number, boxH: number): { scale: number; w: number; h: number } {
	const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(Math.min(boxW, boxH) / 150)))
	return { scale, w: Math.max(64, Math.floor(boxW / scale)), h: Math.max(48, Math.floor(boxH / scale)) }
}

export function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 0x100000000
	}
}

/** Draw a sprite from a string grid. '.' is transparent; any other character
 *  indexes `palette`. Used for the placeholder horse and scenery. */
export function drawGrid(
	ctx: CanvasRenderingContext2D,
	grid: string[],
	palette: Record<string, string>,
	ox: number,
	oy: number,
): void {
	for (let y = 0; y < grid.length; y++) {
		const row = grid[y]
		for (let x = 0; x < row.length; x++) {
			const ch = row[x]
			if (ch === '.') continue
			const color = palette[ch]
			if (!color) continue
			ctx.fillStyle = color
			ctx.fillRect(ox + x, oy + y, 1, 1)
		}
	}
}

// Five greens, dark to light. Pixel art reads as a surface when colour moves
// in patches; per-pixel randomness reads as television static, which is what
// the first attempt at this looked like.
const GRASS = ['#3c7331', '#457f37', '#4e8b3d', '#589745', '#63a44e']
const TUFT = '#2f6329'
const FLOWER = ['#f2e37a', '#f4f0e4', '#e9a0c0', '#cfe0f0']

/** Value noise: a coarse lattice of random values, sampled smoothly. This is
 *  what turns randomness into patches. */
function noiseField(w: number, h: number, cell: number, rand: () => number) {
	const gw = Math.ceil(w / cell) + 2
	const gh = Math.ceil(h / cell) + 2
	const g = new Float32Array(gw * gh)
	for (let i = 0; i < g.length; i++) g[i] = rand()
	return (x: number, y: number): number => {
		const fx = x / cell
		const fy = y / cell
		const x0 = Math.floor(fx)
		const y0 = Math.floor(fy)
		const tx = fx - x0
		const ty = fy - y0
		// Smoothstep the interpolation weights, or the lattice shows as diamonds.
		const sx = tx * tx * (3 - 2 * tx)
		const sy = ty * ty * (3 - 2 * ty)
		const at = (gx: number, gy: number): number => g[gy * gw + gx] ?? 0.5
		const a = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx
		const b = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx
		return a * (1 - sy) + b * sy
	}
}

/** 4x4 ordered dither. Mixing two adjacent greens along a boundary hides the
 *  banding that quantising smooth noise into five shades would otherwise show. */
const BAYER = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
].map((r) => r.map((v) => v / 16))

/**
 * The ground. Painted once into an offscreen canvas and blitted each frame --
 * regenerating the texture 60 times a second would burn the frame budget on
 * something that never changes.
 */
export function paintPasture(w: number, h: number, seed = 20260826): HTMLCanvasElement {
	const c = makeCanvas(w, h)
	const ctx = context2d(c)
	const rand = rng(seed)
	const broad = noiseField(w, h, 26, rand)
	const fine = noiseField(w, h, 7, rand)

	const img = ctx.createImageData(w, h)
	for (let y = 0; y < h; y++) {
		// Up the frame is further away: shade down so the field recedes.
		const depth = 1 - y / h
		for (let x = 0; x < w; x++) {
			const v = broad(x, y) * 0.65 + fine(x, y) * 0.35 - depth * 0.22
			const dithered = v + (BAYER[y & 3][x & 3] - 0.5) * 0.16
			const idx = Math.max(0, Math.min(GRASS.length - 1, Math.floor(dithered * GRASS.length)))
			const hex = GRASS[idx]
			const o = (y * w + x) * 4
			img.data[o] = parseInt(hex.slice(1, 3), 16)
			img.data[o + 1] = parseInt(hex.slice(3, 5), 16)
			img.data[o + 2] = parseInt(hex.slice(5, 7), 16)
			img.data[o + 3] = 255
		}
	}
	ctx.putImageData(img, 0, 0)

	// Tufts: a three-pixel blade. Denser toward the bottom, so near ground reads
	// as more detailed than far ground.
	const tufts = Math.round((w * h) / 260)
	for (let i = 0; i < tufts; i++) {
		const x = Math.floor(rand() * w)
		const y = Math.floor(rand() * h)
		if (rand() > 0.2 + (y / h) * 0.8) continue
		ctx.fillStyle = TUFT
		ctx.fillRect(x, y, 1, 2)
		ctx.fillRect(x + 1, y - 1, 1, 2)
	}

	const flowers = Math.round((w * h) / 2600)
	for (let i = 0; i < flowers; i++) {
		const x = Math.floor(rand() * w)
		const y = Math.floor(h * 0.2 + rand() * h * 0.78)
		ctx.fillStyle = FLOWER[Math.floor(rand() * FLOWER.length)]
		ctx.fillRect(x, y, 1, 1)
	}

	return c
}
