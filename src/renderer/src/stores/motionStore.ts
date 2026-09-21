import { create } from 'zustand'

// Whether decorative motion runs: the toolbar horse and the pasture.
//
// Windows turns `prefers-reduced-motion` on whenever "animation effects" is
// switched off, which plenty of people do for performance rather than because
// motion bothers them. Honouring it silently left both horses frozen with no
// hint why, so the OS value is the *default*, not the verdict -- an explicit
// choice always wins.

export type MotionPref = 'auto' | 'on' | 'off'

const KEY = 'ui.motion'

function osReduces(): boolean {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

interface MotionStore {
	pref: MotionPref
	osReduce: boolean
	/** What callers actually ask. */
	enabled: boolean
	setPref: (pref: MotionPref) => void
}

function resolve(pref: MotionPref, osReduce: boolean): boolean {
	return pref === 'on' ? true : pref === 'off' ? false : !osReduce
}

export const useMotionStore = create<MotionStore>((set, get) => ({
	pref: 'auto',
	osReduce: osReduces(),
	enabled: resolve('auto', osReduces()),
	setPref: (pref) => {
		set({ pref, enabled: resolve(pref, get().osReduce) })
		void window.veridian?.settings.set(KEY, pref)
	},
}))

/** Load the saved preference and keep following the OS while on 'auto'. */
export function initMotion(): void {
	const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
	mq?.addEventListener('change', (e) => {
		useMotionStore.setState((s) => ({
			osReduce: e.matches,
			enabled: resolve(s.pref, e.matches),
		}))
	})
	void window.veridian?.settings
		.get(KEY)
		.then((v) => {
			const pref: MotionPref = v === 'on' || v === 'off' ? v : 'auto'
			useMotionStore.setState((s) => ({ pref, enabled: resolve(pref, s.osReduce) }))
		})
		.catch(() => {})
}
