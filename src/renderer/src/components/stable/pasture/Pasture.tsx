import { useEffect, useRef, useState } from 'react'
import { context2d, paintPasture, rng, sceneSize } from './pixel'
import { useMotionStore } from '../../../stores/motionStore'
import type { LoadedSkin } from './skins'

// The pasture: horses wandering a field, click one to work on it.
//
// Canvas draws the pixels; the name tags are DOM on top. Text rendered *into*
// a 256x144 canvas and then blown up 3x would be unreadable blocks, so the two
// layers are deliberately split -- crisp art, crisp type.

export interface PastureHorse {
	id: string
	name: string
	skin: LoadedSkin
}

interface Agent {
	id: string
	x: number
	y: number
	facing: 1 | -1
	state: 'idle' | 'walk'
	/** Seconds left before choosing what to do next. */
	timer: number
	tx: number
	ty: number
	clock: number
}

/** Horses keep off the top strip, which reads as distance, and off the very
 *  bottom edge so hooves are never clipped. Computed from the live scene size,
 *  since the scene grows with its container. */
function field(w: number, h: number): { top: number; bottom: number; left: number; right: number } {
	return { top: h * 0.42, bottom: h - 6, left: 10, right: w - 10 }
}
const SPEED = 11 // logical px per second

interface Props {
	horses: PastureHorse[]
	selected: string | null
	onSelect: (id: string | null) => void
	onOpen: (id: string) => void
}

export function Pasture({ horses, selected, onSelect, onOpen }: Props): JSX.Element {
	const boxRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const agentsRef = useRef<Map<string, Agent>>(new Map())
	const groundRef = useRef<HTMLCanvasElement | null>(null)
	const [view, setView] = useState({ scale: 2, w: 160, h: 90 })
	const motion = useMotionStore((m) => m.enabled)
	// Re-rendered every frame would thrash React; tags only need to follow the
	// horses, so they are positioned from a snapshot taken on each tick.
	const [tags, setTags] = useState<{ id: string; x: number; y: number }[]>([])

	// Keep one agent per horse, preserving position across re-renders.
	useEffect(() => {
		const rand = rng(7717)
		const F = field(view.w, view.h)
		const next = new Map<string, Agent>()
		horses.forEach((h, i) => {
			const existing = agentsRef.current.get(h.id)
			if (existing) {
				next.set(h.id, existing)
				return
			}
			const x = F.left + ((i + 0.5) / horses.length) * (F.right - F.left)
			const y = F.top + rand() * (F.bottom - F.top)
			next.set(h.id, {
				id: h.id, x, y, facing: 1, state: 'idle',
				timer: rand() * 2, tx: x, ty: y, clock: rand() * 3,
			})
		})
		agentsRef.current = next
	}, [horses, view.w, view.h])

	// Integer scaling: recompute whenever the container resizes.
	useEffect(() => {
		const box = boxRef.current
		if (!box) return
		const ro = new ResizeObserver(() => {
			const r = box.getBoundingClientRect()
			const next = sceneSize(r.width, r.height)
			setView((prev) =>
				prev.scale === next.scale && prev.w === next.w && prev.h === next.h ? prev : next,
			)
		})
		ro.observe(box)
		return () => ro.disconnect()
	}, [])

	// Repaint the ground whenever the scene resizes -- one canvas paint, and it
	// is the only thing that has to change when the window does.
	useEffect(() => {
		groundRef.current = paintPasture(view.w, view.h)
	}, [view.w, view.h])

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const ctx = context2d(canvas)
		const F = field(view.w, view.h)
		const rand = rng(4242)

		let raf = 0
		let last = performance.now()

		const tick = (now: number): void => {
			const dt = Math.min(0.05, (now - last) / 1000)
			last = now

			const agents = [...agentsRef.current.values()]
			if (motion) {
				for (const a of agents) {
					a.clock += dt
					a.timer -= dt
					if (a.state === 'walk') {
						const dx = a.tx - a.x
						const dy = a.ty - a.y
						const dist = Math.hypot(dx, dy)
						if (dist < 1.5 || a.timer <= 0) {
							a.state = 'idle'
							a.timer = 1.5 + rand() * 4
						} else {
							a.facing = dx >= 0 ? 1 : -1
							a.x += (dx / dist) * SPEED * dt
							a.y += (dy / dist) * SPEED * dt
						}
					} else if (a.timer <= 0) {
						a.state = 'walk'
						a.tx = F.left + rand() * (F.right - F.left)
						a.ty = F.top + rand() * (F.bottom - F.top)
						// A ceiling on the walk so a horse can never get stuck
						// creeping toward a target it will not reach.
						a.timer = 10
					}
				}
			}

			ctx.clearRect(0, 0, view.w, view.h)
			if (groundRef.current) ctx.drawImage(groundRef.current, 0, 0)

			// Painter's algorithm: lower on the screen is nearer, so it draws last
			// and overlaps the horses behind it.
			const order = agents.slice().sort((p, q) => p.y - q.y)
			for (const a of order) {
				const horse = horses.find((h) => h.id === a.id)
				if (!horse) continue
				const { spec, sheet } = horse.skin
				const clip = a.state === 'walk' ? spec.walk : spec.idle
				const frame = Math.floor(a.clock * clip.fps) % clip.frames
				const dx = Math.round(a.x - spec.frameW / 2)
				const dy = Math.round(a.y - spec.frameH + spec.baseline)

				// Contact shadow: without it a horse looks pasted on rather than
				// standing on the grass.
				ctx.globalAlpha = 0.22
				ctx.fillStyle = '#1d3a18'
				ctx.fillRect(dx + 4, Math.round(a.y) - 1, spec.frameW - 8, 2)
				ctx.globalAlpha = 1

				ctx.save()
				if (a.facing === -1) {
					ctx.translate(dx + spec.frameW, dy)
					ctx.scale(-1, 1)
				} else {
					ctx.translate(dx, dy)
				}
				ctx.drawImage(
					sheet,
					frame * spec.frameW, clip.row * spec.frameH, spec.frameW, spec.frameH,
					0, 0, spec.frameW, spec.frameH,
				)
				ctx.restore()

				if (a.id === selected) {
					ctx.strokeStyle = '#f2e37a'
					ctx.lineWidth = 1
					ctx.strokeRect(dx - 1.5, dy - 1.5, spec.frameW + 3, spec.frameH + 3)
				}
			}

			setTags(order.map((a) => ({ id: a.id, x: a.x, y: a.y })))
			raf = requestAnimationFrame(tick)
		}

		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [horses, selected, view.w, view.h, motion])

	/** Screen point -> scene point, then the nearest horse whose box contains it. */
	function hit(e: React.MouseEvent): string | null {
		const canvas = canvasRef.current
		if (!canvas) return null
		const r = canvas.getBoundingClientRect()
		const sx = (e.clientX - r.left) / view.scale
		const sy = (e.clientY - r.top) / view.scale
		// Front to back, so the horse drawn on top is the one you get.
		const agents = [...agentsRef.current.values()].sort((p, q) => q.y - p.y)
		for (const a of agents) {
			const horse = horses.find((h) => h.id === a.id)
			if (!horse) continue
			const { frameW, frameH, baseline } = horse.skin.spec
			const x0 = a.x - frameW / 2
			const y0 = a.y - frameH + baseline
			if (sx >= x0 && sx <= x0 + frameW && sy >= y0 && sy <= y0 + frameH) return a.id
		}
		return null
	}

	return (
		<div
			ref={boxRef}
			style={{
				position: 'relative',
				flex: 1,
				minWidth: 0,
				minHeight: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				borderRadius: 14,
				overflow: 'hidden',
				border: '1px solid var(--border)',
				background: '#2f6329',
			}}
		>
			<div style={{ position: 'relative', width: view.w * view.scale, height: view.h * view.scale }}>
				<canvas
					ref={canvasRef}
					width={view.w}
					height={view.h}
					onClick={(e) => onSelect(hit(e))}
					onDoubleClick={(e) => {
						const id = hit(e)
						if (id) onOpen(id)
					}}
					style={{
						width: view.w * view.scale,
						height: view.h * view.scale,
						// Both spellings: Chromium honours the first, the standard
						// keyword is the one that will outlive it.
						imageRendering: 'pixelated',
						display: 'block',
						cursor: 'pointer',
					}}
				/>
				{tags.map((tag) => {
					const horse = horses.find((h) => h.id === tag.id)
					if (!horse) return null
					const isSel = tag.id === selected
					return (
						<span
							key={tag.id}
							style={{
								position: 'absolute',
								left: tag.x * view.scale,
								top: (tag.y - horse.skin.spec.frameH - 3) * view.scale,
								transform: 'translate(-50%, -100%)',
								padding: '1px 6px',
								borderRadius: 6,
								fontSize: 11,
								fontWeight: 600,
								whiteSpace: 'nowrap',
								pointerEvents: 'none',
								color: isSel ? '#1d2b16' : '#eef3ea',
								background: isSel ? '#f2e37a' : 'rgba(20,32,16,.72)',
								border: '1px solid rgba(0,0,0,.25)',
							}}
						>
							{horse.name}
						</span>
					)
				})}
			</div>
		</div>
	)
}
