import { useEffect, useRef } from 'react'
import { context2d } from './pasture/pixel'
import type { LoadedSkin } from './pasture/skins'

// One frame of a horse's sprite, blown up by a whole number so it stays crisp.
//
// The equip screen needs to say *which* horse you are working on. The anatomy
// diagram beside it is shared by every horse -- it is a chart of where the
// slots are, not a portrait -- so identity has to come from the sprite the
// horse actually wears in the pasture.

interface Props {
	skin: LoadedSkin
	/** Whole-number magnification. Fractional scaling is what makes pixel art mush. */
	scale?: number
}

export function HorsePortrait({ skin, scale = 3 }: Props): JSX.Element {
	const ref = useRef<HTMLCanvasElement>(null)
	const { frameW, frameH, idle } = skin.spec

	useEffect(() => {
		const canvas = ref.current
		if (!canvas) return
		const ctx = context2d(canvas)
		ctx.clearRect(0, 0, frameW, frameH)
		ctx.drawImage(skin.sheet, 0, idle.row * frameH, frameW, frameH, 0, 0, frameW, frameH)
	}, [skin, frameW, frameH, idle.row])

	return (
		<canvas
			ref={ref}
			width={frameW}
			height={frameH}
			aria-hidden="true"
			style={{
				width: frameW * scale,
				height: frameH * scale,
				imageRendering: 'pixelated',
				display: 'block',
				flexShrink: 0,
			}}
		/>
	)
}
