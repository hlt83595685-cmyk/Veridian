import { context2d, drawGrid, makeCanvas } from './pixel'

// A horse's appearance. This is the contract every art asset has to satisfy:
// one PNG sprite sheet, fixed-size frames laid out in a grid, one row per
// animation, all frames facing RIGHT (the renderer mirrors for left).
//
// Keeping the sheet layout declarative rather than hard-coded means a new skin
// is a data entry, not a code change -- which is what makes an asset *library*
// possible rather than a fixed cast.

export interface Clip {
	/** Row index in the sheet, 0-based from the top. */
	row: number
	frames: number
	fps: number
}

export interface SkinSpec {
	id: string
	label: string
	/** Sprite sheet URL. Omitted by procedurally generated placeholders. */
	src?: string
	frameW: number
	frameH: number
	/** Pixels from the frame's bottom edge up to the hooves, so horses of
	 *  different frame heights still stand on the same ground line. */
	baseline: number
	idle: Clip
	walk: Clip
}

export interface LoadedSkin {
	spec: SkinSpec
	sheet: CanvasImageSource
}

// ── Asset discovery ─────────────────────────────────────────────────────────
// Every PNG in assets/horse-sprites is a skin. The frame layout is encoded in
// the filename because a PNG cannot describe its own grid -- a 192x64 sheet is
// equally 6 frames of 32x32 or 4 of 48x32, and guessing wrong slices horses in
// half. Putting the numbers in the name keeps them attached to the file, so
// adding a horse is dropping in a file and nothing else.
//
//   horse-<id>-<frameW>x<frameH>-idle<N>-walk<N>.png

const SHEET_NAME = /^horse-(.+?)-(\d+)x(\d+)-idle(\d+)-walk(\d+)\.png$/

/** Hoof line sits on row 29 of a 32px frame, so two rows of padding remain
 *  below it. Horses of other frame heights keep the same two-row convention,
 *  which is what lets them share one ground line. */
const BASELINE = 2

export function discoverSkins(): SkinSpec[] {
	const files = import.meta.glob('../../../assets/horse-sprites/*.png', {
		eager: true,
		query: '?url',
		import: 'default',
	}) as Record<string, string>

	const out: SkinSpec[] = []
	for (const [path, url] of Object.entries(files)) {
		const name = path.split('/').pop() ?? ''
		const m = SHEET_NAME.exec(name)
		if (!m) {
			// Loudly, not silently: a mis-named sheet that just fails to appear is
			// far harder to diagnose than one that says why.
			console.warn(`[stable] ignoring "${name}" -- expected horse-<id>-<W>x<H>-idle<N>-walk<N>.png`)
			continue
		}
		const [, id, fw, fh, idle, walk] = m
		out.push({
			id,
			label: id.replace(/-/g, ' ').replace(/(^|\s)\w/g, (c) => c.toUpperCase()),
			src: url,
			frameW: Number(fw),
			frameH: Number(fh),
			baseline: BASELINE,
			idle: { row: 0, frames: Number(idle), fps: 3 },
			walk: { row: 1, frames: Number(walk), fps: 8 },
		})
	}
	return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function loadSkin(spec: SkinSpec): Promise<LoadedSkin> {
	return new Promise((resolve, reject) => {
		if (!spec.src) {
			reject(new Error(`skin "${spec.id}" has no src`))
			return
		}
		const img = new Image()
		img.onload = () => resolve({ spec, sheet: img })
		img.onerror = () => reject(new Error(`skin "${spec.id}" failed to load: ${spec.src}`))
		img.src = spec.src
	})
}

// ── Placeholder art ─────────────────────────────────────────────────────────
// Deliberately crude, and deliberately generated in code rather than shipped as
// a file: it exists so the simulation can be built and watched before any real
// art exists, and so nobody mistakes it for the finished look. Replace by
// adding real SkinSpecs with `src` -- nothing else in the pasture changes.

const FRAME_W = 24
const FRAME_H = 16
const LEG_TOP = 11
const LEG_X = [6, 9, 15, 18]

/** Foot offsets per walk frame, one entry per leg. Diagonal pairs move
 *  together, which is what makes a four-legged walk read as a walk. */
const GAIT: number[][] = [
	[0, 1, 0, -1],
	[1, 0, -1, 0],
	[0, -1, 0, 1],
	[-1, 0, 1, 0],
]

const BODY = [
	'........................',
	'...................###..',
	'..................#####.',
	'.............mmm#####...',
	'..........mmmm######....',
	't.......mmmm#######.....',
	'ttt...#############.....',
	'tttt.##############.....',
	'.tt..##############.....',
	'.....##############.....',
	'.....##############.....',
]

export interface PlaceholderColors {
	coat: string
	mane: string
	hoof: string
}

function drawFrame(
	ctx: CanvasRenderingContext2D,
	ox: number,
	c: PlaceholderColors,
	feet: number[],
): void {
	drawGrid(ctx, BODY, { '#': c.coat, m: c.mane, t: c.mane }, ox, 0)
	for (let i = 0; i < LEG_X.length; i++) {
		const dx = feet[i]
		for (let y = LEG_TOP; y < FRAME_H; y++) {
			// Lean the leg progressively so the foot ends up `dx` from the hip
			// instead of the whole leg jumping sideways as a block.
			const t = (y - LEG_TOP) / (FRAME_H - 1 - LEG_TOP)
			const x = LEG_X[i] + Math.round(dx * t)
			ctx.fillStyle = y === FRAME_H - 1 ? c.hoof : c.coat
			ctx.fillRect(ox + x, y, 2, 1)
		}
	}
}

export function makePlaceholderSkin(id: string, label: string, c: PlaceholderColors): LoadedSkin {
	const idleFrames = 2
	const walkFrames = GAIT.length
	const cols = Math.max(idleFrames, walkFrames)
	const sheet = makeCanvas(cols * FRAME_W, 2 * FRAME_H)
	const ctx = context2d(sheet)

	// Row 0: idle -- the same stance twice, the second with a flicked tail, so
	// a resting horse still breathes a little.
	for (let f = 0; f < idleFrames; f++) {
		ctx.save()
		ctx.translate(0, 0)
		drawFrame(ctx, f * FRAME_W, c, [0, 0, 0, 0])
		if (f === 1) {
			ctx.fillStyle = c.mane
			ctx.fillRect(f * FRAME_W + 0, 6, 1, 1)
			ctx.clearRect(f * FRAME_W + 0, 5, 1, 1)
		}
		ctx.restore()
	}

	// Row 1: walk
	ctx.save()
	ctx.translate(0, FRAME_H)
	for (let f = 0; f < walkFrames; f++) drawFrame(ctx, f * FRAME_W, c, GAIT[f])
	ctx.restore()

	return {
		spec: {
			id,
			label,
			frameW: FRAME_W,
			frameH: FRAME_H,
			baseline: 0,
			idle: { row: 0, frames: idleFrames, fps: 2 },
			walk: { row: 1, frames: walkFrames, fps: 8 },
		},
		sheet,
	}
}

export const PLACEHOLDER_PALETTES: PlaceholderColors[] = [
	{ coat: '#d9a14a', mane: '#8a5a22', hoof: '#3a2a16' },
	{ coat: '#b8b3ad', mane: '#6d6862', hoof: '#2f2c28' },
	{ coat: '#8f5b3f', mane: '#3f2a1d', hoof: '#241813' },
	{ coat: '#e6dcc8', mane: '#b09a76', hoof: '#4a4034' },
]
