import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

// electron-builder packs the `dependencies` chain and nothing else. It does NOT follow
// peerDependencies, but npm installs them into the dev node_modules, so a peer that is not also
// declared here works in development (and in `npm run bootcheck`, which runs inside the project)
// and then fails on a user's machine with ERR_MODULE_NOT_FOUND. That is exactly how v0.2.0
// shipped without @deepseek-ai/dsh-timeout. Guard: every required peer must be reachable through
// `dependencies`.

const root = join(__dirname, '../..')

interface Pkg {
	name: string
	version: string
	dependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Pkg

/** Resolve like Node does: look in node_modules on the way up from `from`. */
function resolvePkg(name: string, from: string): { dir: string; pkg: Pkg } | null {
	let dir = from
	for (;;) {
		const p = join(dir, 'node_modules', name, 'package.json')
		if (existsSync(p)) return { dir: dirname(p), pkg: JSON.parse(readFileSync(p, 'utf-8')) as Pkg }
		const up = dirname(dir)
		if (up === dir) return null
		dir = up
	}
}

/** All packages reachable from the app's `dependencies`; optionally following required peers too. */
function closure(followPeers: boolean): Set<string> {
	const seen = new Set<string>()
	const visit = (name: string, from: string): void => {
		const r = resolvePkg(name, from)
		if (!r) return
		const key = `${r.pkg.name}@${r.pkg.version}`
		if (seen.has(key)) return
		seen.add(key)
		for (const d of Object.keys(r.pkg.dependencies ?? {})) visit(d, r.dir)
		if (!followPeers) return
		for (const d of Object.keys(r.pkg.peerDependencies ?? {})) {
			if (r.pkg.peerDependenciesMeta?.[d]?.optional) continue
			if (d.startsWith('@types/')) continue   // type-only, never loaded at runtime
			visit(d, r.dir)
		}
	}
	for (const d of Object.keys(rootPkg.dependencies ?? {})) visit(d, root)
	return seen
}

describe('packaging', () => {
	it('every required peer dependency is also reachable through `dependencies`', () => {
		const packed = closure(false)
		const needed = closure(true)
		const missing = [...needed].filter((k) => !packed.has(k)).sort()
		expect(missing, 'declare these in package.json "dependencies" so electron-builder packs them').toEqual([])
	})
})
