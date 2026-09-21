import { useEffect, useRef } from 'react'
import { useMotionStore } from '../../stores/motionStore'
// The svg-only, expression-free build: ~140KB smaller than the full player.
// Verified safe -- none of the three animations use expressions, effects, or
// text layers, which is all `lottie_light` drops.
import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light'
import runningUrl from '../../assets/horse/horse-running.json?url'
import idleUrl from '../../assets/horse/horse-idle.json?url'
import errorUrl from '../../assets/horse/horse-error.json?url'

export type HorseState = 'running' | 'idle' | 'error'

const SRC: Record<HorseState, string> = {
	running: runningUrl,
	idle: idleUrl,
	error: errorUrl,
}

// The art board is 256x256 but the horse only fills roughly 87% of the width
// and 36-54% of the height, so rendering into a square wastes half the icon on
// empty margin. This is the union of the tight content boxes across every
// frame of all three animations, measured rather than eyeballed -- one shared
// crop so the horse stays the same size when the state changes.
const VIEW_BOX = '14 60 228 144'
export const HORSE_ASPECT = 228 / 144

// 'error' is a one-shot narrative (gallop -> stumble -> sprawl); looping it
// would read as a horse falling over on repeat. The other two are cycles.
const LOOPS: Record<HorseState, boolean> = { running: true, idle: true, error: false }

// Frame to hold when motion is suppressed -- picked to be recognisable rather
// than mid-transition. 'error' rests on its final sprawled frame.
const STILL_FRAME: Record<HorseState, number> = { running: 0.25, idle: 0.1, error: 1 }

interface Props {
	state: HorseState
	/** Height in px; width follows the crop's aspect ratio. */
	height?: number
}

export function HorseIcon({ state, height = 20 }: Props): JSX.Element {
	const hostRef = useRef<HTMLDivElement>(null)
	const motion = useMotionStore((m) => m.enabled)

	useEffect(() => {
		const host = hostRef.current
		if (!host) return

		const anim: AnimationItem = lottie.loadAnimation({
			container: host,
			renderer: 'svg',
			loop: LOOPS[state],
			autoplay: motion,
			path: SRC[state],
			rendererSettings: { viewBoxSize: VIEW_BOX, preserveAspectRatio: 'xMidYMid meet' },
		})

		if (!motion) {
			anim.addEventListener('DOMLoaded', () => {
				anim.goToAndStop(Math.max(0, Math.round(anim.totalFrames * STILL_FRAME[state]) - 1), true)
			})
		}

		return () => anim.destroy()
	}, [state, motion])

	return (
		<div
			ref={hostRef}
			aria-hidden="true"
			style={{
				height,
				width: Math.round(height * HORSE_ASPECT),
				flexShrink: 0,
				display: 'block',
			}}
		/>
	)
}
