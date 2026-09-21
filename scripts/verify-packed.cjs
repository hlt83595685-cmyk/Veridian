// Checks a PACKAGED app.asar against what the app needs at runtime, without booting it.
//
// Why: `npm run bootcheck` and the dev server run inside the project, where node_modules holds
// everything npm installed, including peerDependencies. electron-builder packs only the
// `dependencies` chain, so a package that is a peer of a dependency but not declared works here
// and dies on a user's machine with ERR_MODULE_NOT_FOUND (v0.2.0 shipped without
// @deepseek-ai/dsh-timeout that way). Anything that resolves via the project's node_modules
// hides the gap, so this reads the asar's own file list instead.
//
// Usage: node scripts/verify-packed.cjs [path/to/app.asar]
//        (default: dist/win-unpacked/resources/app.asar; run it after `npm run package`
//        and BEFORE publishing)
const fs = require('fs')
const path = require('path')
const asar = require('@electron/asar')

const root = path.join(__dirname, '..')
const asarPath = path.resolve(process.argv[2] || path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'))

if (!fs.existsSync(asarPath)) {
	console.error(`verify-packed: ${asarPath} not found; run npm run package first`)
	process.exit(2)
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))

/** Resolve like Node does: node_modules on the way up from `from`. */
function resolvePkg(name, from) {
	let dir = from
	for (;;) {
		const p = path.join(dir, 'node_modules', name, 'package.json')
		if (fs.existsSync(p)) return { dir: path.dirname(p), pkg: JSON.parse(fs.readFileSync(p, 'utf-8')) }
		const up = path.dirname(dir)
		if (up === dir) return null
		dir = up
	}
}

// Everything the app can load at runtime: `dependencies` plus required (non-optional) peers.
// @types/* peers are type-only.
const needed = new Set()
const visit = (name, from) => {
	const r = resolvePkg(name, from)
	if (!r || needed.has(r.pkg.name)) return
	needed.add(r.pkg.name)
	for (const d of Object.keys(r.pkg.dependencies || {})) visit(d, r.dir)
	const meta = r.pkg.peerDependenciesMeta || {}
	for (const d of Object.keys(r.pkg.peerDependencies || {})) {
		if ((meta[d] && meta[d].optional) || d.startsWith('@types/')) continue
		visit(d, r.dir)
	}
}
for (const d of Object.keys(rootPkg.dependencies || {})) visit(d, root)

const inAsar = new Set(
	asar.listPackage(asarPath, { isPack: false }).map((p) => p.replace(/\\/g, '/').replace(/^\//, '')),
)
const missing = [...needed].filter((n) => !inAsar.has(`node_modules/${n}/package.json`)).sort()

if (missing.length > 0) {
	console.error(`verify-packed FAIL: ${missing.length} package(s) needed at runtime are not in ${asarPath}:`)
	for (const n of missing) console.error('  - ' + n)
	console.error('Declare them in package.json "dependencies" (electron-builder does not pack peerDependencies).')
	process.exit(1)
}
console.log(`verify-packed PASS: all ${needed.size} runtime packages are inside ${path.basename(asarPath)}`)
