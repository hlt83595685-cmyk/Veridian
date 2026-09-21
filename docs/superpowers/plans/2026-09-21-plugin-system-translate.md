# Plugin System v0 + Selection Translate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Markdown reader, selecting text shows a badge; clicking it streams a translation produced by a sandboxed plugin that uses its own API config.

**Architecture:** Plugins (`manifest.json` + `index.js`) run in a Blob Worker inside a hidden sandboxed iframe whose page is served by a `veridian-plugin://` protocol with a CSP header (`connect-src 'none'`), so the Worker cannot reach the network itself. All plugin network I/O is relayed by the main process, which only allows hosts declared by the manifest or typed by the user into the plugin's own `url` config fields. Message chain: main window ⇄ iframe ⇄ Worker.

**Tech Stack:** Electron 36, React 18, zod 4, vitest, Web Worker / CSP.

Spec: `docs/superpowers/specs/2026-09-21-plugin-system-translate-design.md`

**Conventions**
- New files: TABS, no `any`. Edits: match the file's own indentation. Files are CRLF (autocrlf); use the Edit tool and don't reformat untouched lines.
- The repo has many unrelated uncommitted changes. **Do not `git add` / `git commit`** anywhere in this plan; leave changes in the working tree.
- Renderer paths to shared: from `src/renderer/src/plugins/` use `../../../shared/…`; from `src/renderer/src/components/<dir>/` use `../../../../shared/…`.
- Node tests that need `node:vm` live under `src/main/plugin-host/` (node tsconfig only), never under `src/shared/`.
- `npm run lint` has ~51 pre-existing errors; only make sure files you touch add none.

## File map

| File | Responsibility |
|---|---|
| `scripts/verify-plugin-sandbox.cjs` | Electron spike: proves the CSP sandbox blocks all direct network |
| `src/shared/plugin.ts` | Manifest schema/parse, allowed hosts, fetch-target check, config keys, shared IPC types |
| `src/shared/pluginRuntimeSource.ts` | `HOST_HTML`, `HOST_SCRIPT` (iframe), `WORKER_PRELUDE` (Worker) as strings |
| `src/main/plugin-host/discover.ts` | Scan plugin dirs, read plugin source |
| `src/main/plugin-host/config.ts` | Per-plugin config + enabled flag on top of SettingsService |
| `src/main/plugin-host/relay.ts` | Host-side network relay with allow-list, timeout, size cap, abort |
| `src/main/plugin-host/pluginAssets.ts` | `host.html` / `host.js` responses with the CSP header |
| `src/main/plugin-host/index.ts` | Roots, cached discovery, `PluginInfo` listing |
| `src/renderer/src/plugins/PluginRuntime.ts` | iframe/Worker lifecycle, message routing, run/abort/timeout |
| `src/renderer/src/components/pdf-viewer/SelectionActions.tsx` | Badge + result bubble in the MD reader |
| `src/renderer/src/components/plugins/PluginsSettingsTab.tsx` | Settings tab |
| `resources/plugins/translate/` | Built-in translate plugin |

---

### Task 1: Spike — does the CSP sandbox really block a Worker's network?

**Files:**
- Create: `scripts/verify-plugin-sandbox.cjs`

This is the go/no-go for the whole design. If it fails, STOP and report to the user.

- [ ] **Step 1: Write the spike**

```js
// Spike: page -> sandboxed iframe (CSP header) -> blob Worker. Can the Worker reach the network?
// Run: npx electron scripts/verify-plugin-sandbox.cjs
const { app, BrowserWindow, protocol } = require('electron')
const http = require('http')

const CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'none'"

protocol.registerSchemesAsPrivileged([{ scheme: 'veridian-plugin', privileges: { standard: true, secure: true } }])

// Same logic as HOST_SCRIPT in src/shared/pluginRuntimeSource.ts (keep in sync if you change the mechanism).
const HOST_JS = `
(function () {
	var worker = null
	function toParent(m) { parent.postMessage(m, '*') }
	window.addEventListener('message', function (ev) {
		if (ev.source !== parent) return
		var m = ev.data
		if (!m || typeof m.t !== 'string') return
		if (m.t === 'init') {
			if (worker) return
			var url = URL.createObjectURL(new Blob([m.workerSource], { type: 'text/javascript' }))
			worker = new Worker(url)
			worker.onmessage = function (e) { toParent(e.data) }
			worker.onerror = function (e) { toParent({ t: 'load-error', message: e.message || 'plugin failed to load' }) }
			return
		}
		if (worker) worker.postMessage(m)
	})
	toParent({ t: 'ready' })
})();
`

async function workerMain(base) {
	const results = {}
	const probe = async (name, fn) => {
		try {
			await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))])
			results[name] = 'ALLOWED'
		} catch (e) {
			results[name] = 'blocked'
		}
	}
	const u = (name) => base + '/canary?probe=' + name
	await probe('fetch', () => fetch(u('fetch')).then((r) => r.text()))
	await probe('fetchNoCors', () => fetch(u('fetchNoCors'), { mode: 'no-cors' }))
	await probe('xhr', () => new Promise((res, rej) => {
		const x = new XMLHttpRequest(); x.open('GET', u('xhr')); x.onload = res; x.onerror = () => rej(new Error('xhr')); x.send()
	}))
	await probe('websocket', () => new Promise((res, rej) => {
		const w = new WebSocket(u('ws').replace('http', 'ws')); w.onopen = res; w.onerror = () => rej(new Error('ws')); w.onclose = () => rej(new Error('closed'))
	}))
	await probe('importScripts', () => { importScripts(u('importScripts')) })
	await probe('dynamicImport', () => import(u('import')))
	await probe('eventsource', () => new Promise((res, rej) => {
		const es = new EventSource(u('es')); es.onopen = res; es.onerror = () => rej(new Error('es'))
	}))
	await probe('nestedWorkerFetch', () => new Promise((res, rej) => {
		const src = 'fetch(' + JSON.stringify(u('nested')) + ').then(function(){postMessage("ok")}, function(){postMessage("blocked")})'
		const w = new Worker(URL.createObjectURL(new Blob([src])))
		w.onmessage = (e) => (e.data === 'ok' ? res() : rej(new Error('blocked')))
		w.onerror = () => rej(new Error('worker error'))
	}))
	postMessage({ t: 'probes', results })
}
const WORKER_SOURCE = '(' + workerMain.toString() + ')(' + JSON.stringify('__BASE__') + ')'

function parentHtml(hostName, base) {
	const src = JSON.stringify(WORKER_SOURCE.replace('__BASE__', base)).replace(/</g, '\\u003c')
	return `<!doctype html><body><iframe id="f" sandbox="allow-scripts" src="veridian-plugin://spike/${hostName}"></iframe>
<script>
const f = document.getElementById('f')
window.addEventListener('message', (e) => {
	if (e.source !== f.contentWindow) return
	const m = e.data
	if (m.t === 'ready') f.contentWindow.postMessage({ t: 'init', workerSource: ${src} }, '*')
	if (m.t === 'probes') window.__probes = m.results
	if (m.t === 'load-error') window.__probes = { loadError: m.message }
})
</script>`
}

const hits = []
let base = ''
const server = http.createServer((req, res) => {
	if (req.url.startsWith('/parent-')) {
		res.setHeader('Content-Type', 'text/html')
		res.end(parentHtml(req.url.includes('nocsp') ? 'nocsp.html' : 'host.html', base))
		return
	}
	hits.push(req.url)
	res.setHeader('Access-Control-Allow-Origin', '*') // so a block is never explained away by CORS
	res.setHeader('Content-Type', 'text/javascript')
	res.end('/*canary*/')
})
server.on('upgrade', (req, sock) => { hits.push(req.url); sock.destroy() })

function htmlFor(script) { return `<!doctype html><meta charset="utf-8"><script src="${script}"></script>` }

async function waitProbes(win) {
	for (let i = 0; i < 300; i++) {
		const r = await win.webContents.executeJavaScript('window.__probes || null')
		if (r) return r
		await new Promise((r2) => setTimeout(r2, 200))
	}
	throw new Error('timed out waiting for probe results')
}

async function runOne(win, page) {
	hits.length = 0
	await win.loadURL(`${base}/${page}`)
	const results = await waitProbes(win)
	return { results, leaked: hits.slice() }
}

app.whenReady().then(async () => {
	setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 90000)
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	base = `http://127.0.0.1:${server.address().port}`
	protocol.handle('veridian-plugin', (req) => {
		const { pathname } = new URL(req.url)
		const js = { 'Content-Type': 'text/javascript' }
		const html = { 'Content-Type': 'text/html' }
		if (pathname === '/host.html') return new Response(htmlFor('host.js'), { headers: { ...html, 'Content-Security-Policy': CSP } })
		if (pathname === '/host.js') return new Response(HOST_JS, { headers: { ...js, 'Content-Security-Policy': CSP } })
		if (pathname === '/nocsp.html') return new Response(htmlFor('nocsp.js'), { headers: html })
		if (pathname === '/nocsp.js') return new Response(HOST_JS, { headers: js })
		return new Response('not found', { status: 404 })
	})

	const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
	const control = await runOne(win, 'parent-nocsp.html')
	const test = await runOne(win, 'parent-csp.html')

	console.log('CONTROL (no CSP) probes:', JSON.stringify(control.results), 'server hits:', control.leaked.length)
	console.log('TEST    (with CSP) probes:', JSON.stringify(test.results), 'server hits:', test.leaked.length)

	const controlValid = control.leaked.some((u) => u.includes('probe=fetch'))
	const blocked = test.results && !test.results.loadError && Object.values(test.results).every((v) => v === 'blocked') && test.leaked.length === 0
	if (!controlValid) { console.error('FAIL: control run did not reach the probe server, the test is invalid'); process.exit(1) }
	if (!blocked) { console.error('FAIL: the CSP sandbox leaked. Server saw:', test.leaked); process.exit(1) }
	console.log('PASS: with the CSP header the Worker reached nothing; without it the probe server was hit.')
	process.exit(0)
})
```

- [ ] **Step 2: Run it**

Run: `npx electron scripts/verify-plugin-sandbox.cjs`
Expected: last line `PASS: …`, exit code 0; the CONTROL line shows `server hits` > 0 and the TEST line shows `server hits: 0` with every probe `blocked`.

- [ ] **Step 3: Decide**
  - PASS → continue with Task 2.
  - FAIL / TIMEOUT / control invalid → **stop the whole plan and report** the printed output to the user (fallback discussed in the spec: one hidden, Node-less BrowserWindow per plugin).

---

### Task 2: Shared plugin types, manifest parsing, allow-list, config keys (TDD)

**Files:**
- Create: `src/shared/plugin.ts`
- Test: `src/shared/plugin.test.ts`

- [ ] **Step 1: Write the failing test** — `src/shared/plugin.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import {
	parseManifest, allowedHosts, checkFetchTarget,
	pluginConfigKey, pluginEnabledKey, isPluginSecretKey,
	type PluginManifest,
} from './plugin'

const minimal = { id: 'demo', name: 'Demo', version: '1.0.0', main: 'index.js' }

function manifest(extra: Partial<PluginManifest> = {}): PluginManifest {
	const r = parseManifest({ ...minimal })
	if (!r.ok) throw new Error(r.error)
	return { ...r.manifest, ...extra }
}

describe('parseManifest', () => {
	it('accepts a minimal manifest and fills empty defaults', () => {
		const r = parseManifest(minimal)
		expect(r.ok).toBe(true)
		if (r.ok) {
			expect(r.manifest.network).toEqual([])
			expect(r.manifest.contributes.selectionActions).toEqual([])
			expect(r.manifest.config).toEqual([])
		}
	})

	it('rejects a bad id', () => {
		expect(parseManifest({ ...minimal, id: 'Bad_ID' }).ok).toBe(false)
	})

	it('rejects a main that is not a plain .js filename', () => {
		expect(parseManifest({ ...minimal, main: '../x.js' }).ok).toBe(false)
		expect(parseManifest({ ...minimal, main: 'sub/x.js' }).ok).toBe(false)
	})

	it('rejects duplicate config keys', () => {
		const config = [
			{ key: 'a', label: 'A', type: 'text' },
			{ key: 'a', label: 'A2', type: 'text' },
		]
		expect(parseManifest({ ...minimal, config }).ok).toBe(false)
	})

	it('rejects a select field without options', () => {
		expect(parseManifest({ ...minimal, config: [{ key: 's', label: 'S', type: 'select' }] }).ok).toBe(false)
	})

	it('rejects a network entry that is not a bare hostname', () => {
		expect(parseManifest({ ...minimal, network: ['https://api.example.com/v1'] }).ok).toBe(false)
	})

	it('lowercases network hosts', () => {
		const r = parseManifest({ ...minimal, network: ['API.Example.com'] })
		expect(r.ok && r.manifest.network).toEqual(['api.example.com'])
	})
})

describe('allowedHosts', () => {
	it('merges manifest hosts with the hosts of url-typed config values', () => {
		const m = manifest({
			network: ['fixed.example.com'],
			config: [
				{ key: 'baseURL', label: 'URL', type: 'url' },
				{ key: 'name', label: 'Name', type: 'text' },
			],
		})
		const hosts = allowedHosts(m, { baseURL: 'https://Api.Mine.com/v1', name: 'https://not-a-url-field.com' })
		expect([...hosts].sort()).toEqual(['api.mine.com', 'fixed.example.com'])
	})

	it('ignores an unparsable url value', () => {
		const m = manifest({ config: [{ key: 'baseURL', label: 'URL', type: 'url' }] })
		expect(allowedHosts(m, { baseURL: 'nonsense' }).size).toBe(0)
	})
})

describe('checkFetchTarget', () => {
	const allowed = new Set(['api.example.com', 'localhost', '127.0.0.1'])

	it('allows https to an allowed host', () => {
		const r = checkFetchTarget('https://api.example.com/v1/x', allowed)
		expect(r.ok).toBe(true)
	})

	it('rejects a host that is not allowed', () => {
		const r = checkFetchTarget('https://evil.com/', allowed)
		expect(r).toEqual({ ok: false, error: 'host not allowed: evil.com' })
	})

	it('rejects plain http to a non-loopback host', () => {
		const r = checkFetchTarget('http://api.example.com/', allowed)
		expect(r.ok).toBe(false)
	})

	it('allows plain http to an allowed loopback host', () => {
		expect(checkFetchTarget('http://localhost:11434/v1', allowed).ok).toBe(true)
		expect(checkFetchTarget('http://127.0.0.1:8080/', allowed).ok).toBe(true)
	})

	it('rejects other protocols and malformed URLs', () => {
		expect(checkFetchTarget('file:///etc/passwd', new Set(['']))).toMatchObject({ ok: false })
		expect(checkFetchTarget('not a url', allowed)).toEqual({ ok: false, error: 'invalid URL' })
	})
})

describe('config keys', () => {
	it('stores password fields under the secret namespace', () => {
		expect(pluginConfigKey('demo', { key: 'apiKey', type: 'password' })).toBe('plugin.demo.secret.apiKey')
		expect(pluginConfigKey('demo', { key: 'model', type: 'text' })).toBe('plugin.demo.config.model')
		expect(pluginEnabledKey('demo')).toBe('plugin.demo.enabled')
	})

	it('recognises only the secret namespace as secret', () => {
		expect(isPluginSecretKey('plugin.demo.secret.apiKey')).toBe(true)
		expect(isPluginSecretKey('plugin.demo.config.apiKey')).toBe(false)
		expect(isPluginSecretKey('knowledge.chat.apiKey')).toBe(false)
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/plugin.test.ts`
Expected: FAIL — cannot resolve `./plugin`.

- [ ] **Step 3: Implement** — `src/shared/plugin.ts`

```ts
import { z } from 'zod'

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export interface PluginConfigField {
	key: string
	label: string
	type: 'text' | 'password' | 'url' | 'select'
	required?: boolean
	default?: string
	options?: string[]
}

export interface PluginSelectionAction { id: string; title: string }

export interface PluginManifest {
	id: string
	name: string
	version: string
	main: string
	network: string[]
	contributes: { selectionActions: PluginSelectionAction[] }
	config: PluginConfigField[]
}

/** What the settings page and the reader need to know about one plugin. */
export interface PluginInfo {
	id: string
	name: string
	version: string
	builtin: boolean
	enabled: boolean
	selectionActions: PluginSelectionAction[]
	config: PluginConfigField[]
	values: Record<string, string>
}

/** A network request a plugin asks the host to make on its behalf. */
export interface PluginFetchRequest {
	id: string
	pluginId: string
	url: string
	method: string
	headers: Record<string, string>
	body?: string
}

export type PluginFetchEvent =
	| { id: string; type: 'head'; status: number; statusText: string; headers: Record<string, string> }
	| { id: string; type: 'chunk'; data: Uint8Array }
	| { id: string; type: 'end' }
	| { id: string; type: 'error'; message: string }

const configFieldSchema = z.object({
	key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
	label: z.string().min(1).max(64),
	type: z.enum(['text', 'password', 'url', 'select']),
	required: z.boolean().optional(),
	default: z.string().max(256).optional(),
	options: z.array(z.string().min(1).max(64)).max(32).optional(),
})

const actionSchema = z.object({
	id: z.string().regex(/^[a-z][a-zA-Z0-9-]{0,31}$/),
	title: z.string().min(1).max(32),
})

const manifestSchema = z.object({
	id: z.string().regex(PLUGIN_ID_RE),
	name: z.string().min(1).max(64),
	version: z.string().min(1).max(32),
	main: z.string().regex(/^[\w.-]+\.js$/),
	network: z.array(z.string().regex(/^[A-Za-z0-9.-]{1,253}$/)).max(32).optional(),
	contributes: z.object({ selectionActions: z.array(actionSchema).max(8).optional() }).optional(),
	config: z.array(configFieldSchema).max(16).optional(),
})

export function parseManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
	const r = manifestSchema.safeParse(raw)
	if (!r.success) {
		const issue = r.error.issues[0]
		return { ok: false, error: `${issue.path.join('.') || 'manifest'}: ${issue.message}` }
	}
	const config = r.data.config ?? []
	const keys = new Set<string>()
	for (const f of config) {
		if (keys.has(f.key)) return { ok: false, error: `config: duplicate key '${f.key}'` }
		keys.add(f.key)
		if (f.type === 'select' && (!f.options || f.options.length === 0)) {
			return { ok: false, error: `config.${f.key}: select needs options` }
		}
	}
	return {
		ok: true,
		manifest: {
			id: r.data.id,
			name: r.data.name,
			version: r.data.version,
			main: r.data.main,
			network: (r.data.network ?? []).map((h) => h.toLowerCase()),
			contributes: { selectionActions: r.data.contributes?.selectionActions ?? [] },
			config,
		},
	}
}

/** Manifest-declared hosts plus the hosts of the user's own `url` config values. */
export function allowedHosts(manifest: PluginManifest, config: Record<string, string>): Set<string> {
	const hosts = new Set(manifest.network)
	for (const f of manifest.config) {
		if (f.type !== 'url') continue
		const v = config[f.key]
		if (!v) continue
		try { hosts.add(new URL(v).hostname.toLowerCase()) } catch { /* not a URL: contributes nothing */ }
	}
	return hosts
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function checkFetchTarget(raw: string, allowed: Set<string>): { ok: true; url: URL } | { ok: false; error: string } {
	let url: URL
	try { url = new URL(raw) } catch { return { ok: false, error: 'invalid URL' } }
	const host = url.hostname.toLowerCase()
	if (!allowed.has(host)) return { ok: false, error: `host not allowed: ${host}` }
	if (url.protocol === 'https:') return { ok: true, url }
	if (url.protocol === 'http:' && LOOPBACK.has(host)) return { ok: true, url }
	return { ok: false, error: `protocol not allowed: ${url.protocol}` }
}

/** Password fields go in a namespace SettingsService encrypts; see isPluginSecretKey. */
export function pluginConfigKey(id: string, field: { key: string; type: string }): string {
	return field.type === 'password' ? `plugin.${id}.secret.${field.key}` : `plugin.${id}.config.${field.key}`
}

export function pluginEnabledKey(id: string): string {
	return `plugin.${id}.enabled`
}

export function isPluginSecretKey(key: string): boolean {
	return /^plugin\.[a-z0-9-]+\.secret\./.test(key)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/shared/plugin.test.ts`
Expected: PASS (all tests).

---

### Task 3: Plugin discovery (TDD)

**Files:**
- Create: `src/main/plugin-host/discover.ts`
- Test: `src/main/plugin-host/discover.test.ts`

- [ ] **Step 1: Write the failing test** — `src/main/plugin-host/discover.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discoverPlugins, readPluginSource } from './discover'

let root: string
let other: string

function plugin(dir: string, name: string, manifest: object, source = 'void 0'): void {
	mkdirSync(join(dir, name), { recursive: true })
	writeFileSync(join(dir, name, 'manifest.json'), JSON.stringify(manifest))
	writeFileSync(join(dir, name, 'index.js'), source)
}

const m = (id: string): object => ({ id, name: id, version: '1.0.0', main: 'index.js' })

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'plugins-a-'))
	other = mkdtempSync(join(tmpdir(), 'plugins-b-'))
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
	rmSync(other, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe('discoverPlugins', () => {
	it('finds valid plugins and flags builtin roots', () => {
		plugin(root, 'alpha', m('alpha'))
		plugin(other, 'beta', m('beta'))
		const found = discoverPlugins([{ dir: root, builtin: true }, { dir: other, builtin: false }])
		expect(found.map((p) => [p.manifest.id, p.builtin])).toEqual([['alpha', true], ['beta', false]])
	})

	it('skips a missing root without throwing', () => {
		expect(discoverPlugins([{ dir: join(root, 'nope'), builtin: false }])).toEqual([])
	})

	it('skips an invalid manifest and a folder whose name differs from the id', () => {
		plugin(root, 'bad', { id: 'BAD', name: 'x', version: '1', main: 'index.js' })
		plugin(root, 'folder', m('other-id'))
		expect(discoverPlugins([{ dir: root, builtin: false }])).toEqual([])
	})

	it('keeps the first plugin when two roots define the same id', () => {
		plugin(root, 'dup', m('dup'))
		plugin(other, 'dup', m('dup'))
		const found = discoverPlugins([{ dir: root, builtin: true }, { dir: other, builtin: false }])
		expect(found).toHaveLength(1)
		expect(found[0].builtin).toBe(true)
	})
})

describe('readPluginSource', () => {
	it('returns the main file text', () => {
		plugin(root, 'alpha', m('alpha'), 'console.log(1)')
		const [p] = discoverPlugins([{ dir: root, builtin: false }])
		expect(readPluginSource(p)).toBe('console.log(1)')
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/plugin-host/discover.test.ts`
Expected: FAIL — cannot resolve `./discover`.

- [ ] **Step 3: Implement** — `src/main/plugin-host/discover.ts`

```ts
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { parseManifest, type PluginManifest } from '../../shared/plugin'

export interface DiscoveredPlugin {
	manifest: PluginManifest
	dir: string
	builtin: boolean
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

/** Earlier roots win on duplicate ids, so list the built-in root first. */
export function discoverPlugins(roots: { dir: string; builtin: boolean }[]): DiscoveredPlugin[] {
	const found = new Map<string, DiscoveredPlugin>()
	for (const root of roots) {
		let names: string[]
		try { names = readdirSync(root.dir) } catch { continue }
		for (const name of names) {
			const dir = join(root.dir, name)
			try {
				if (!statSync(dir).isDirectory()) continue
				const parsed = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')))
				if (!parsed.ok) { console.warn(`[plugins] ${name}: ${parsed.error}`); continue }
				const { manifest } = parsed
				if (manifest.id !== name) { console.warn(`[plugins] ${name}: id '${manifest.id}' must equal the folder name`); continue }
				if (found.has(manifest.id)) { console.warn(`[plugins] ${name}: duplicate id, ignored`); continue }
				found.set(manifest.id, { manifest, dir, builtin: root.builtin })
			} catch (err) {
				console.warn(`[plugins] ${name}: ${(err as Error).message}`)
			}
		}
	}
	return [...found.values()]
}

export function readPluginSource(p: DiscoveredPlugin): string {
	const file = join(p.dir, p.manifest.main)
	if (statSync(file).size > MAX_SOURCE_BYTES) throw new Error(`Plugin '${p.manifest.id}' is too large`)
	return readFileSync(file, 'utf-8')
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/plugin-host/discover.test.ts`
Expected: PASS (5 tests).

---

### Task 4: Encrypt plugin secrets + plugin config store

**Files:**
- Modify: `src/main/services/SettingsService.ts`
- Create: `src/main/plugin-host/config.ts`

(The key naming rule is already unit-tested in Task 2; these two files are thin glue over Electron-dependent code.)

- [ ] **Step 1: `SettingsService.ts`** — three edits

1. After `import { parseThemeMode, type ThemeMode } from '../../shared/theme'` add:
```ts
import { isPluginSecretKey } from '../../shared/plugin'
```
2. After the line `const ENC_PREFIX = 'enc:'` add:
```ts

// Plugin passwords live in a key namespace, not a fixed list, so they are
// decided by name.
function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key) || isPluginSecretKey(key)
}
```
3. Replace `if (SECRET_KEYS.has(key) && typeof raw === 'string') return decrypt(raw)` with `if (isSecretKey(key) && typeof raw === 'string') return decrypt(raw)`, and replace `[key]: SECRET_KEYS.has(key) && typeof value === 'string' ? encrypt(value) : value,` with `[key]: isSecretKey(key) && typeof value === 'string' ? encrypt(value) : value,`.

- [ ] **Step 2: Create `src/main/plugin-host/config.ts`**

```ts
import { getSetting, setSetting } from '../services/SettingsService'
import { pluginConfigKey, pluginEnabledKey, type PluginManifest } from '../../shared/plugin'

/** Every declared field, falling back to the manifest default, then ''. */
export function getPluginConfig(m: PluginManifest): Record<string, string> {
	const out: Record<string, string> = {}
	for (const f of m.config) {
		const v = getSetting(pluginConfigKey(m.id, f))
		out[f.key] = typeof v === 'string' && v !== '' ? v : (f.default ?? '')
	}
	return out
}

export function setPluginConfig(m: PluginManifest, key: string, value: string): void {
	const f = m.config.find((x) => x.key === key)
	if (!f) throw new Error(`Unknown config key '${key}'`)
	if (f.type === 'select' && value !== '' && !f.options?.includes(value)) {
		throw new Error(`Invalid value for '${key}'`)
	}
	setSetting(pluginConfigKey(m.id, f), value)
}

/** Enabled unless the user switched it off. */
export function isPluginEnabled(id: string): boolean {
	return getSetting(pluginEnabledKey(id)) !== false
}

export function setPluginEnabled(id: string, enabled: boolean): void {
	setSetting(pluginEnabledKey(id), enabled)
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

---

### Task 5: Network relay (TDD)

**Files:**
- Create: `src/main/plugin-host/relay.ts`
- Test: `src/main/plugin-host/relay.test.ts`

- [ ] **Step 1: Write the failing test** — `src/main/plugin-host/relay.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { runRelay, abortRelay } from './relay'
import type { PluginFetchEvent, PluginFetchRequest } from '../../shared/plugin'

const allowed = new Set(['api.example.com'])
const req = (over: Partial<PluginFetchRequest> = {}): PluginFetchRequest => ({
	id: 'p:1', pluginId: 'p', url: 'https://api.example.com/x', method: 'POST',
	headers: { 'Content-Type': 'application/json' }, body: '{}', ...over,
})

function collect(): { events: PluginFetchEvent[]; emit: (e: PluginFetchEvent) => void } {
	const events: PluginFetchEvent[] = []
	return { events, emit: (e) => events.push(e) }
}

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder()
	return new ReadableStream({
		start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close() },
	})
}

describe('runRelay', () => {
	it('refuses a host that is not allowed and never calls fetch', async () => {
		const fetchImpl = vi.fn()
		const { events, emit } = collect()
		await runRelay(req({ url: 'https://evil.com/' }), allowed, emit, fetchImpl as unknown as typeof fetch)
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(events).toEqual([{ id: 'p:1', type: 'error', message: 'host not allowed: evil.com' }])
	})

	it('emits head, chunks, end in order', async () => {
		const fetchImpl = vi.fn(async () => new Response(streamOf('he', 'llo'), { status: 200, headers: { 'x-a': 'b' } }))
		const { events, emit } = collect()
		await runRelay(req(), allowed, emit, fetchImpl as unknown as typeof fetch)
		expect(events.map((e) => e.type)).toEqual(['head', 'chunk', 'chunk', 'end'])
		expect(events[0]).toMatchObject({ status: 200, headers: { 'x-a': 'b' } })
		const text = events.filter((e) => e.type === 'chunk').map((e) => new TextDecoder().decode((e as { data: Uint8Array }).data)).join('')
		expect(text).toBe('hello')
	})

	it('drops cookie/host/origin/referer headers and refuses redirects', async () => {
		const fetchImpl = vi.fn(async (_u: unknown, _i?: RequestInit) => new Response('ok'))
		await runRelay(
			req({ headers: { Cookie: 'a=b', Host: 'x', Origin: 'y', Referer: 'z', 'X-Keep': '1' } }),
			allowed, () => {}, fetchImpl as unknown as typeof fetch,
		)
		const init = fetchImpl.mock.calls[0][1] as RequestInit
		expect(init.headers).toEqual({ 'X-Keep': '1' })
		expect(init.redirect).toBe('error')
	})

	it('reports a fetch failure as an error event', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('boom') })
		const { events, emit } = collect()
		await runRelay(req(), allowed, emit, fetchImpl as unknown as typeof fetch)
		expect(events).toEqual([{ id: 'p:1', type: 'error', message: 'boom' }])
	})

	it('aborts an in-flight request', async () => {
		const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
			init!.signal!.addEventListener('abort', () => rej(new Error('aborted')))
		}))
		const { events, emit } = collect()
		const done = runRelay(req({ id: 'p:2' }), allowed, emit, fetchImpl as unknown as typeof fetch)
		abortRelay('p:2')
		await done
		expect(events).toEqual([{ id: 'p:2', type: 'error', message: 'aborted' }])
	})

	it('stops when the response exceeds the size cap', async () => {
		const fetchImpl = vi.fn(async () => new Response(streamOf('aaaa', 'bbbb')))
		const { events, emit } = collect()
		await runRelay(req(), allowed, emit, fetchImpl as unknown as typeof fetch, { maxBytes: 5 })
		expect(events[events.length - 1]).toEqual({ id: 'p:1', type: 'error', message: 'response too large' })
	})

	it('times out a request that never answers', async () => {
		const fetchImpl = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
			init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason))
		}))
		const { events, emit } = collect()
		await runRelay(req({ id: 'p:3' }), allowed, emit, fetchImpl as unknown as typeof fetch, { timeoutMs: 20 })
		expect(events).toEqual([{ id: 'p:3', type: 'error', message: 'timeout' }])
	})

	it('rejects a duplicate in-flight id', async () => {
		let release!: () => void
		const gate = new Promise<void>((r) => { release = r })
		const fetchImpl = vi.fn(async () => { await gate; return new Response('ok') })
		const first = runRelay(req({ id: 'p:4' }), allowed, () => {}, fetchImpl as unknown as typeof fetch)
		const { events, emit } = collect()
		await runRelay(req({ id: 'p:4' }), allowed, emit, fetchImpl as unknown as typeof fetch)
		expect(events).toEqual([{ id: 'p:4', type: 'error', message: 'duplicate request id' }])
		release()
		await first
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/plugin-host/relay.test.ts`
Expected: FAIL — cannot resolve `./relay`.

- [ ] **Step 3: Implement** — `src/main/plugin-host/relay.ts`

```ts
import { checkFetchTarget, type PluginFetchEvent, type PluginFetchRequest } from '../../shared/plugin'

export const RELAY_TIMEOUT_MS = 60_000
export const RELAY_MAX_BYTES = 10 * 1024 * 1024

// A plugin speaks for itself, not as the browser: no ambient identity headers.
const DROPPED_HEADERS = new Set(['host', 'cookie', 'origin', 'referer'])

const inflight = new Map<string, AbortController>()

export function abortRelay(id: string): void {
	inflight.get(id)?.abort()
}

/**
 * Performs one plugin-requested fetch and reports it as head / chunk* / end|error events.
 * Never throws: every failure, including a refused target, becomes an `error` event.
 */
export async function runRelay(
	req: PluginFetchRequest,
	allowed: Set<string>,
	emit: (e: PluginFetchEvent) => void,
	fetchImpl: typeof fetch = fetch,
	opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<void> {
	const { maxBytes = RELAY_MAX_BYTES, timeoutMs = RELAY_TIMEOUT_MS } = opts
	const target = checkFetchTarget(req.url, allowed)
	if (!target.ok) { emit({ id: req.id, type: 'error', message: target.error }); return }
	if (inflight.has(req.id)) { emit({ id: req.id, type: 'error', message: 'duplicate request id' }); return }

	const ctl = new AbortController()
	inflight.set(req.id, ctl)
	const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs)
	try {
		const headers = Object.fromEntries(
			Object.entries(req.headers).filter(([k]) => !DROPPED_HEADERS.has(k.toLowerCase())),
		)
		// redirect:'error' -- a redirect could otherwise carry the request to a host that is not allowed.
		const res = await fetchImpl(target.url, {
			method: req.method, headers, body: req.body, signal: ctl.signal, redirect: 'error',
		})
		const resHeaders: Record<string, string> = {}
		res.headers.forEach((v, k) => { resHeaders[k] = v })
		emit({ id: req.id, type: 'head', status: res.status, statusText: res.statusText, headers: resHeaders })
		if (res.body) {
			const reader = res.body.getReader()
			let total = 0
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				total += value.byteLength
				if (total > maxBytes) { ctl.abort(); throw new Error('response too large') }
				emit({ id: req.id, type: 'chunk', data: value })
			}
		}
		emit({ id: req.id, type: 'end' })
	} catch (err) {
		emit({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) })
	} finally {
		clearTimeout(timer)
		inflight.delete(req.id)
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/plugin-host/relay.test.ts`
Expected: PASS (8 tests).

---

### Task 6: Sandbox page assets + Worker/iframe runtime scripts (TDD)

**Files:**
- Create: `src/shared/pluginRuntimeSource.ts`
- Create: `src/main/plugin-host/pluginAssets.ts`
- Test: `src/main/plugin-host/pluginRuntimeSource.test.ts`
- Test: `src/main/plugin-host/pluginAssets.test.ts`

Message protocol between main window (parent) and Worker (the iframe relays everything but `init`):
- parent → Worker: `run{runId,actionId,text,config}`, `abort{runId}`, `fetch:head{rid,status,statusText,headers}`, `fetch:chunk{rid,data}`, `fetch:end{rid}`, `fetch:error{rid,message}`
- Worker → parent: `output{runId,text}`, `done{runId}`, `error{runId,message}`, `fetch{rid,url,init}`, `fetch:abort{rid}`
- iframe ↔ parent: `ready`, `init{workerSource}`, `load-error{message}`

- [ ] **Step 1: Write the failing prelude test** — `src/main/plugin-host/pluginRuntimeSource.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { WORKER_PRELUDE } from '../../shared/pluginRuntimeSource'

type Msg = Record<string, unknown>
interface Ctx { text: string; config: Record<string, string>; signal: AbortSignal; output: (t: string) => void }
interface Veridian {
	fetch: (url: string, init?: Record<string, unknown>) => Promise<Response>
	onSelectionAction: (id: string, handler: (ctx: Ctx) => Promise<void> | void) => void
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function boot(): { posted: Msg[]; veridian: Veridian; send: (m: Msg) => void } {
	const posted: Msg[] = []
	const listeners: ((ev: { data: unknown }) => void)[] = []
	const self: Record<string, unknown> = {
		postMessage: (m: Msg) => { posted.push(m) },
		addEventListener: (_t: string, fn: (ev: { data: unknown }) => void) => { listeners.push(fn) },
	}
	const ctx = vm.createContext({ self, ReadableStream, Response, Headers, AbortController })
	new vm.Script(WORKER_PRELUDE).runInContext(ctx)
	return {
		posted,
		veridian: self.veridian as Veridian,
		send: (data) => listeners.forEach((fn) => fn({ data })),
	}
}

const run = (send: (m: Msg) => void, actionId: string, text = '', config: Record<string, string> = {}): void =>
	send({ t: 'run', runId: 'r1', actionId, text, config })

describe('WORKER_PRELUDE', () => {
	it('runs a registered action and reports its output then done', async () => {
		const { posted, veridian, send } = boot()
		veridian.onSelectionAction('echo', async ({ text, config, output }) => { output(text); output(config.suffix) })
		run(send, 'echo', 'hi', { suffix: '!' })
		await tick()
		expect(posted).toEqual([
			{ t: 'output', runId: 'r1', text: 'hi' },
			{ t: 'output', runId: 'r1', text: '!' },
			{ t: 'done', runId: 'r1' },
		])
	})

	it('reports an unknown action', async () => {
		const { posted, send } = boot()
		run(send, 'nope')
		await tick()
		expect(posted).toEqual([{ t: 'error', runId: 'r1', message: 'Unknown action: nope' }])
	})

	it('reports a thrown error', async () => {
		const { posted, veridian, send } = boot()
		veridian.onSelectionAction('bad', () => { throw new Error('boom') })
		run(send, 'bad')
		await tick()
		expect(posted).toEqual([{ t: 'error', runId: 'r1', message: 'boom' }])
	})

	it('relays fetch through the host and hands back a streaming Response', async () => {
		const { posted, veridian, send } = boot()
		veridian.onSelectionAction('f', async ({ output }) => {
			const res = await veridian.fetch('https://api.example.com/x', { method: 'POST', headers: { A: 'b' }, body: '{}' })
			output(res.status + ':' + (await res.text()))
		})
		run(send, 'f')
		await tick()
		const req = posted.find((m) => m.t === 'fetch')!
		expect(req).toMatchObject({ url: 'https://api.example.com/x', init: { method: 'POST', body: '{}' } })
		expect((req.init as { headers: Record<string, string> }).headers).toEqual({ a: 'b' })
		const enc = new TextEncoder()
		send({ t: 'fetch:head', rid: req.rid, status: 200, statusText: 'OK', headers: {} })
		send({ t: 'fetch:chunk', rid: req.rid, data: enc.encode('he') })
		send({ t: 'fetch:chunk', rid: req.rid, data: enc.encode('llo') })
		send({ t: 'fetch:end', rid: req.rid })
		await tick()
		expect(posted.filter((m) => m.t !== 'fetch')).toEqual([
			{ t: 'output', runId: 'r1', text: '200:hello' },
			{ t: 'done', runId: 'r1' },
		])
	})

	it('rejects a fetch the host refused', async () => {
		const { posted, veridian, send } = boot()
		veridian.onSelectionAction('f', async () => { await veridian.fetch('https://evil.com/') })
		run(send, 'f')
		await tick()
		const req = posted.find((m) => m.t === 'fetch')!
		send({ t: 'fetch:error', rid: req.rid, message: 'host not allowed: evil.com' })
		await tick()
		expect(posted[posted.length - 1]).toEqual({ t: 'error', runId: 'r1', message: 'host not allowed: evil.com' })
	})

	it('aborts the action signal and tells the host to abort the fetch', async () => {
		const { posted, veridian, send } = boot()
		let signal!: AbortSignal
		veridian.onSelectionAction('slow', async (ctx) => { signal = ctx.signal; await veridian.fetch('https://api.example.com/', { signal }) })
		run(send, 'slow')
		await tick()
		const req = posted.find((m) => m.t === 'fetch')!
		send({ t: 'abort', runId: 'r1' })
		await tick()
		expect(signal.aborted).toBe(true)
		expect(posted).toContainEqual({ t: 'fetch:abort', rid: req.rid })
		expect(posted[posted.length - 1]).toMatchObject({ t: 'error', runId: 'r1', message: 'aborted' })
	})

	it('rejects a non-string request body', async () => {
		const { posted, veridian, send } = boot()
		veridian.onSelectionAction('f', async () => { await veridian.fetch('https://api.example.com/', { body: new Uint8Array(1) }) })
		run(send, 'f')
		await tick()
		expect(posted).toEqual([{ t: 'error', runId: 'r1', message: 'veridian.fetch only supports string bodies' }])
	})
})
```

- [ ] **Step 2: Write the failing assets test** — `src/main/plugin-host/pluginAssets.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { pluginAssetResponse, PLUGIN_CSP } from './pluginAssets'

describe('pluginAssetResponse', () => {
	it('serves host.html with the network-blocking CSP', async () => {
		const res = pluginAssetResponse('/host.html')
		expect(res.status).toBe(200)
		expect(res.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
		expect(res.headers.get('content-type')).toContain('text/html')
		expect(await res.text()).toContain('src="host.js"')
	})

	it('serves host.js with the same CSP', async () => {
		const res = pluginAssetResponse('/host.js')
		expect(res.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
		expect(res.headers.get('content-type')).toContain('text/javascript')
		expect(await res.text()).toContain("t: 'ready'")
	})

	it('blocks every direct network path in the CSP', () => {
		expect(PLUGIN_CSP).toContain("connect-src 'none'")
		expect(PLUGIN_CSP).toContain("default-src 'none'")
		expect(PLUGIN_CSP).toContain('sandbox allow-scripts')
	})

	it('404s everything else, including plugin source', () => {
		expect(pluginAssetResponse('/index.js').status).toBe(404)
		expect(pluginAssetResponse('/').status).toBe(404)
	})
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run src/main/plugin-host/pluginRuntimeSource.test.ts src/main/plugin-host/pluginAssets.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement** — `src/shared/pluginRuntimeSource.ts`

(JS kept as strings because it runs in the sandbox, outside any bundle. Do not use backticks or `${` inside the raw strings.)

```ts
// Code that runs inside the plugin sandbox, kept as strings.
//  - HOST_SCRIPT runs in the sandboxed iframe: it turns the plugin source into a Blob Worker
//    (which inherits the iframe's CSP, so the Worker cannot touch the network) and relays messages.
//  - WORKER_PRELUDE is prepended to every plugin's own code inside its Worker and defines the
//    global `veridian`. Its fetch() never touches the network: it asks the host to do it.

export const HOST_HTML = '<!doctype html><meta charset="utf-8"><script src="host.js"></script>'

export const HOST_SCRIPT = String.raw`
(function () {
	var worker = null
	function toParent(m) { parent.postMessage(m, '*') }
	window.addEventListener('message', function (ev) {
		if (ev.source !== parent) return
		var m = ev.data
		if (!m || typeof m.t !== 'string') return
		if (m.t === 'init') {
			if (worker) return
			var url = URL.createObjectURL(new Blob([m.workerSource], { type: 'text/javascript' }))
			worker = new Worker(url)
			worker.onmessage = function (e) { toParent(e.data) }
			worker.onerror = function (e) { toParent({ t: 'load-error', message: e.message || 'plugin failed to load' }) }
			toParent({ t: 'inited' })
			return
		}
		if (worker) worker.postMessage(m)
	})
	toParent({ t: 'ready' })
})();
`

export const WORKER_PRELUDE = String.raw`
(function () {
	var post = function (m) { self.postMessage(m) }
	var actions = Object.create(null)
	var runs = Object.create(null)
	var pending = Object.create(null)
	var nextRid = 0

	function fetchViaHost(url, init) {
		init = init || {}
		return new Promise(function (resolve, reject) {
			var signal = init.signal
			if (signal && signal.aborted) { reject(new Error('aborted')); return }
			if (init.body != null && typeof init.body !== 'string') {
				reject(new TypeError('veridian.fetch only supports string bodies'))
				return
			}
			var headers = {}
			new Headers(init.headers || {}).forEach(function (v, k) { headers[k] = v })
			var rid = 'f' + (++nextRid)
			var entry = { resolve: resolve, reject: reject, controller: null, headed: false, body: null }
			entry.body = new ReadableStream({
				start: function (c) { entry.controller = c },
				cancel: function () { if (pending[rid]) { delete pending[rid]; post({ t: 'fetch:abort', rid: rid }) } }
			})
			pending[rid] = entry
			if (signal) signal.addEventListener('abort', function () {
				var e = pending[rid]
				if (!e) return
				delete pending[rid]
				post({ t: 'fetch:abort', rid: rid })
				var err = new Error('aborted')
				if (e.headed) { try { e.controller.error(err) } catch (x) {} } else { e.reject(err) }
			})
			post({ t: 'fetch', rid: rid, url: String(url), init: { method: init.method || 'GET', headers: headers, body: init.body == null ? undefined : init.body } })
		})
	}

	function onFetchMessage(m) {
		var e = pending[m.rid]
		if (!e) return
		if (m.t === 'fetch:head') {
			e.headed = true
			var nullBody = m.status === 204 || m.status === 205 || m.status === 304
			if (nullBody) { try { e.controller.close() } catch (x) {} }
			e.resolve(new Response(nullBody ? null : e.body, { status: m.status, statusText: m.statusText, headers: m.headers }))
		} else if (m.t === 'fetch:chunk') {
			try { e.controller.enqueue(m.data) } catch (x) {}
		} else if (m.t === 'fetch:end') {
			delete pending[m.rid]
			try { e.controller.close() } catch (x) {}
		} else if (m.t === 'fetch:error') {
			delete pending[m.rid]
			var err = new Error(m.message)
			if (e.headed) { try { e.controller.error(err) } catch (x) {} } else { e.reject(err) }
		}
	}

	function run(m) {
		var handler = actions[m.actionId]
		if (!handler) { post({ t: 'error', runId: m.runId, message: 'Unknown action: ' + m.actionId }); return }
		var ctl = new AbortController()
		runs[m.runId] = ctl
		Promise.resolve().then(function () {
			return handler({
				text: m.text,
				config: m.config,
				signal: ctl.signal,
				output: function (text) { post({ t: 'output', runId: m.runId, text: String(text) }) }
			})
		}).then(
			function () { post({ t: 'done', runId: m.runId }) },
			function (err) { post({ t: 'error', runId: m.runId, message: err && err.message ? err.message : String(err) }) }
		).then(function () { delete runs[m.runId] })
	}

	self.addEventListener('message', function (ev) {
		var m = ev.data
		if (!m || typeof m.t !== 'string') return
		if (m.t.indexOf('fetch:') === 0) { onFetchMessage(m); return }
		if (m.t === 'abort') { var c = runs[m.runId]; if (c) c.abort(); return }
		if (m.t === 'run') run(m)
	})

	self.veridian = Object.freeze({
		fetch: fetchViaHost,
		onSelectionAction: function (id, handler) { actions[String(id)] = handler }
	})
})();
`
```

- [ ] **Step 5: Implement** — `src/main/plugin-host/pluginAssets.ts`

```ts
import { HOST_HTML, HOST_SCRIPT } from '../../shared/pluginRuntimeSource'

// The sandbox page's policy. `connect-src 'none'` is what stops the Worker (a blob Worker inherits
// its creator's CSP) from making any request of its own; every network call goes through the host.
export const PLUGIN_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'none'"

export function pluginAssetResponse(pathname: string): Response {
	const base = { 'Content-Security-Policy': PLUGIN_CSP, 'Cache-Control': 'no-store' }
	if (pathname === '/host.html') {
		return new Response(HOST_HTML, { headers: { ...base, 'Content-Type': 'text/html; charset=utf-8' } })
	}
	if (pathname === '/host.js') {
		return new Response(HOST_SCRIPT, { headers: { ...base, 'Content-Type': 'text/javascript; charset=utf-8' } })
	}
	return new Response('Not found', { status: 404 })
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run src/main/plugin-host/pluginRuntimeSource.test.ts src/main/plugin-host/pluginAssets.test.ts`
Expected: PASS (7 + 4 tests). If a prelude test fails because of a cross-realm quirk in `vm`, fix the test harness (not the protocol) and say what you changed.

---

### Task 7: Host wiring — IPC contract, handlers, protocol, preload, types

**Files:**
- Create: `src/main/plugin-host/index.ts`
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`

- [ ] **Step 1: Create `src/main/plugin-host/index.ts`**

```ts
import { app } from 'electron'
import { join } from 'path'
import { discoverPlugins, type DiscoveredPlugin } from './discover'
import { getPluginConfig, isPluginEnabled } from './config'
import type { PluginInfo } from '../../shared/plugin'

// Built-in plugins ship in extraResources (see package.json build.extraResources);
// user plugins live in userData/plugins. Same dev/packaged split as the tray icon.
const builtinDir = app.isPackaged
	? join(process.resourcesPath, 'plugins')
	: join(__dirname, '../../resources/plugins')

let cache: DiscoveredPlugin[] | null = null

/** Scanned once per launch; there is no hot reload. */
export function listPlugins(): DiscoveredPlugin[] {
	cache ??= discoverPlugins([
		{ dir: builtinDir, builtin: true },
		{ dir: join(app.getPath('userData'), 'plugins'), builtin: false },
	])
	return cache
}

export function mustFind(id: string): DiscoveredPlugin {
	const p = listPlugins().find((x) => x.manifest.id === id)
	if (!p) throw new Error(`Unknown plugin '${id}'`)
	return p
}

export function listInfo(): PluginInfo[] {
	return listPlugins().map(({ manifest, builtin }) => ({
		id: manifest.id,
		name: manifest.name,
		version: manifest.version,
		builtin,
		enabled: isPluginEnabled(manifest.id),
		selectionActions: manifest.contributes.selectionActions,
		config: manifest.config,
		values: getPluginConfig(manifest),
	}))
}
```

- [ ] **Step 2: `ipc-contract.ts`** — add the import and channels

Add after `import { z } from 'zod'`:
```ts
import { PLUGIN_ID_RE } from './plugin'
```
Add after `const id = z.number().int().positive()`:
```ts
const pluginId = z.string().regex(PLUGIN_ID_RE)
```
Add directly after the line `'settings:pickStoragePath': z.tuple([]),`:
```ts

  // Plugins. Config/enable/source are per plugin id; fetch streams its result back
  // as 'plugin:fetch:event' pushes (see preload), so the invoke itself returns at once.
  'plugin:list':       z.tuple([]),
  'plugin:setConfig':  z.tuple([pluginId, z.string().min(1).max(32), z.string().max(4096)]),
  'plugin:setEnabled': z.tuple([pluginId, z.boolean()]),
  'plugin:source':     z.tuple([pluginId]),
  'plugin:fetch':      z.tuple([z.object({
    id: z.string().min(1).max(64),
    pluginId,
    url: z.string().max(4096),
    method: z.string().max(16),
    headers: z.record(z.string(), z.string()),
    body: z.string().max(1_000_000).optional(),
  })]),
  'plugin:fetchAbort': z.tuple([z.string().min(1).max(64)]),
```

- [ ] **Step 3: `handlers.ts`** — imports and handlers

Add near the other service imports at the top:
```ts
import { allowedHosts, type PluginFetchRequest } from '../../shared/plugin'
import * as PluginHost from '../plugin-host'
import { getPluginConfig, setPluginConfig, isPluginEnabled, setPluginEnabled } from '../plugin-host/config'
import { readPluginSource } from '../plugin-host/discover'
import { runRelay, abortRelay } from '../plugin-host/relay'
```
Insert immediately before the line `  'settings:pickStoragePath': async (e) => {`:
```ts
  // Plugins
  'plugin:list': () => PluginHost.listInfo(),
  'plugin:setConfig': (_e, id: string, key: string, value: string) => {
    setPluginConfig(PluginHost.mustFind(id).manifest, key, value)
  },
  'plugin:setEnabled': (_e, id: string, on: boolean) => {
    PluginHost.mustFind(id)
    setPluginEnabled(id, on)
  },
  'plugin:source': (_e, id: string) => {
    const p = PluginHost.mustFind(id)
    if (!isPluginEnabled(id)) throw new Error('Plugin is disabled')
    return readPluginSource(p)
  },
  // The allow-list is recomputed from the plugin's own manifest + config on every call,
  // so a plugin cannot widen it by what it sends.
  'plugin:fetch': (e, req: PluginFetchRequest) => {
    const p = PluginHost.mustFind(req.pluginId)
    if (!isPluginEnabled(p.manifest.id)) throw new Error('Plugin is disabled')
    const allowed = allowedHosts(p.manifest, getPluginConfig(p.manifest))
    const sender = e.sender
    void runRelay(req, allowed, (ev) => {
      if (!sender.isDestroyed()) sender.send('plugin:fetch:event', ev)
    })
  },
  'plugin:fetchAbort': (_e, id: string) => abortRelay(id),
```

- [ ] **Step 4: `src/main/index.ts`** — scheme, handler, import

Add to the imports (near `import { assertReadable } ...`):
```ts
import { pluginAssetResponse } from './plugin-host/pluginAssets'
```
Replace the scheme list
```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'veridian-file', privileges: { secure: true, supportFetchAPI: true, stream: true } },
])
```
with
```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'veridian-file', privileges: { secure: true, supportFetchAPI: true, stream: true } },
  // Plugin sandbox pages (see plugin-host/pluginAssets.ts). `standard` so the page's
  // relative script URL resolves and each plugin id gets its own origin.
  { scheme: 'veridian-plugin', privileges: { standard: true, secure: true } },
])
```
Insert immediately before the line `  app.on('browser-window-created', (_, window) => {`:
```ts
  protocol.handle('veridian-plugin', (request) => pluginAssetResponse(new URL(request.url).pathname))

```

- [ ] **Step 5: `src/preload/index.ts`**

Change the type import to also bring in the plugin types — add after `import type { KnowledgeRef } from '../shared/ipc-contract'`:
```ts
import type { PluginInfo, PluginFetchRequest, PluginFetchEvent } from '../shared/plugin'
```
Add after the line `ipcRenderer.on('tool:pdf2md:progress', (_ev, p) => { _pdf2mdProgressCb?.(p) })`:
```ts

// Plugin network relay: the main process pushes head/chunk/end|error events per request id.
const _pluginFetchCbs = new Map<string, (e: PluginFetchEvent) => void>()
ipcRenderer.on('plugin:fetch:event', (_ev, e: PluginFetchEvent) => {
  _pluginFetchCbs.get(e.id)?.(e)
  if (e.type === 'end' || e.type === 'error') _pluginFetchCbs.delete(e.id)
})
```
Add after the `settings: { … },` block (after the line `pickStoragePath: () => call('settings:pickStoragePath'),` and its closing `},`):
```ts
  plugins: {
    list: () => call<PluginInfo[]>('plugin:list'),
    setConfig: (id: string, key: string, value: string) => call('plugin:setConfig', id, key, value),
    setEnabled: (id: string, enabled: boolean) => call('plugin:setEnabled', id, enabled),
    source: (id: string) => call<string>('plugin:source', id),
    fetch: (req: PluginFetchRequest, onEvent: (e: PluginFetchEvent) => void) => {
      _pluginFetchCbs.set(req.id, onEvent)
      return call('plugin:fetch', req).catch((err: unknown) => {
        _pluginFetchCbs.delete(req.id)
        throw err
      })
    },
    fetchAbort: (id: string) => call('plugin:fetchAbort', id),
  },
```

- [ ] **Step 6: `src/renderer/src/env.d.ts`**

Add after the `import type { KnowledgeRef } …` line:
```ts
import type { PluginInfo, PluginFetchRequest, PluginFetchEvent } from '../../shared/plugin'
```
Add inside `interface VeridianAPI`, directly after the `settings: { … }` block:
```ts
  plugins: {
    list: () => Promise<PluginInfo[]>
    setConfig: (id: string, key: string, value: string) => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<void>
    source: (id: string) => Promise<string>
    fetch: (req: PluginFetchRequest, onEvent: (e: PluginFetchEvent) => void) => Promise<void>
    fetchAbort: (id: string) => Promise<void>
  }
```

- [ ] **Step 7: Typecheck + tests**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass.

---

### Task 8: `PluginRuntime` (renderer)

**Files:**
- Create: `src/renderer/src/plugins/PluginRuntime.ts`

(DOM/iframe glue, so it isn't unit-testable in the node test environment; the protocol it drives is covered by Task 6 and the whole chain by Task 12.)

- [ ] **Step 1: Create the file**

```ts
import { WORKER_PRELUDE } from '../../../shared/pluginRuntimeSource'
import type { PluginFetchEvent } from '../../../shared/plugin'

const RUN_TIMEOUT_MS = 90_000
const START_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_FETCHES = 8

export interface PluginAction { pluginId: string; actionId: string; title: string }

export class PluginNotConfiguredError extends Error {
	constructor(readonly missing: string[]) {
		super(`Not configured: ${missing.join(', ')}`)
		this.name = 'PluginNotConfiguredError'
	}
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

interface Run { onOutput: (text: string) => void; finish: (err?: Error) => void }

interface Runner {
	pluginId: string
	iframe: HTMLIFrameElement
	source: string
	runs: Map<string, Run>
	relayIds: Map<string, string>   // Worker's request id -> relay id in the main process
	ready: Promise<void>
	ok: () => void
	fail: (e: Error) => void
}

interface FetchMsg {
	rid: string
	url: string
	init?: { method?: string; headers?: Record<string, string>; body?: string }
}

/**
 * One hidden sandboxed iframe (containing the plugin's Worker) per plugin, started lazily.
 * Message chain: this window <-> iframe <-> Worker. Network requests the Worker asks for are
 * performed by the main process (plugin:fetch) and streamed back.
 */
class PluginRuntime {
	private runners = new Map<string, Runner>()
	private seq = 0

	constructor() {
		window.addEventListener('message', (e) => this.onMessage(e))
	}

	async listActions(): Promise<PluginAction[]> {
		const list = await window.veridian.plugins.list()
		return list
			.filter((p) => p.enabled)
			.flatMap((p) => p.selectionActions.map((a) => ({ pluginId: p.id, actionId: a.id, title: a.title })))
	}

	async runAction(
		pluginId: string,
		actionId: string,
		text: string,
		onOutput: (text: string) => void,
		signal: AbortSignal,
	): Promise<void> {
		const info = (await window.veridian.plugins.list()).find((p) => p.id === pluginId)
		if (!info || !info.enabled) throw new Error('Plugin is not enabled')
		const missing = info.config.filter((f) => f.required && !info.values[f.key]).map((f) => f.label)
		if (missing.length > 0) throw new PluginNotConfiguredError(missing)
		if (signal.aborted) throw abortError()
		const runner = await this.runnerFor(pluginId)
		if (signal.aborted) throw abortError()

		return new Promise<void>((resolve, reject) => {
			const runId = `r${++this.seq}`
			let timer: ReturnType<typeof setTimeout> | undefined
			const finish = (err?: Error): void => {
				clearTimeout(timer)
				signal.removeEventListener('abort', onAbort)
				runner.runs.delete(runId)
				if (err) reject(err)
				else resolve()
			}
			// Stopping a run also stops its network requests: the plugin may not have passed `signal`
			// to veridian.fetch. Only when this was the runner's last run, so runs never cancel each other's.
			const stop = (err: Error): void => {
				this.post(runner, { t: 'abort', runId })
				finish(err)
				if (runner.runs.size === 0) this.abortRelays(runner)
			}
			const onAbort = (): void => stop(abortError())
			timer = setTimeout(() => stop(new Error('timeout')), RUN_TIMEOUT_MS)
			signal.addEventListener('abort', onAbort)
			runner.runs.set(runId, { onOutput, finish })
			this.post(runner, { t: 'run', runId, actionId, text, config: info.values })
		})
	}

	/** Stop a plugin's sandbox (used when it is disabled). Pending runs fail. */
	dispose(pluginId: string): void {
		const r = this.runners.get(pluginId)
		if (!r) return
		this.runners.delete(pluginId)
		r.iframe.remove()
		r.fail(new Error('plugin stopped'))
		for (const run of [...r.runs.values()]) run.finish(new Error('plugin stopped'))
		this.abortRelays(r)
	}

	private abortRelays(runner: Runner): void {
		for (const relayId of runner.relayIds.values()) void window.veridian.plugins.fetchAbort(relayId)
	}

	private async runnerFor(pluginId: string): Promise<Runner> {
		const existing = this.runners.get(pluginId)
		if (existing) { await existing.ready; return existing }

		const source = await window.veridian.plugins.source(pluginId)
		const raced = this.runners.get(pluginId)   // another caller may have started it while we awaited
		if (raced) { await raced.ready; return raced }

		const iframe = document.createElement('iframe')
		iframe.setAttribute('sandbox', 'allow-scripts')
		iframe.style.display = 'none'
		let ok!: () => void
		let fail!: (e: Error) => void
		const ready = new Promise<void>((res, rej) => { ok = res; fail = rej })
		const runner: Runner = { pluginId, iframe, source, runs: new Map(), relayIds: new Map(), ready, ok, fail }
		this.runners.set(pluginId, runner)
		const startTimer = setTimeout(() => fail(new Error('plugin sandbox did not start')), START_TIMEOUT_MS)
		iframe.src = `veridian-plugin://${pluginId}/host.html`
		document.body.appendChild(iframe)
		try {
			await ready
		} catch (err) {
			this.dispose(pluginId)
			throw err
		} finally {
			clearTimeout(startTimer)
		}
		return runner
	}

	private post(runner: Runner, msg: Record<string, unknown>): void {
		runner.iframe.contentWindow?.postMessage(msg, '*')
	}

	private onMessage(e: MessageEvent): void {
		const runner = [...this.runners.values()].find((r) => r.iframe.contentWindow === e.source)
		if (!runner) return
		const m = e.data as Record<string, unknown> | null
		if (!m || typeof m.t !== 'string') return
		switch (m.t) {
			case 'ready':
				this.post(runner, { t: 'init', workerSource: WORKER_PRELUDE + '\n' + runner.source })
				break
			case 'inited':
				runner.ok()
				break
			case 'load-error': {
				const err = new Error(String(m.message))
				runner.fail(err)
				for (const run of [...runner.runs.values()]) run.finish(err)
				break
			}
			case 'output':
				runner.runs.get(String(m.runId))?.onOutput(String(m.text))
				break
			case 'done':
				runner.runs.get(String(m.runId))?.finish()
				break
			case 'error':
				runner.runs.get(String(m.runId))?.finish(new Error(String(m.message)))
				break
			case 'fetch':
				this.startFetch(runner, m as unknown as FetchMsg)
				break
			case 'fetch:abort': {
				const relayId = runner.relayIds.get(String(m.rid))
				if (relayId) void window.veridian.plugins.fetchAbort(relayId)
				break
			}
		}
	}

	private startFetch(runner: Runner, m: FetchMsg): void {
		if (runner.relayIds.size >= MAX_CONCURRENT_FETCHES) {
			this.post(runner, { t: 'fetch:error', rid: m.rid, message: 'too many concurrent requests' })
			return
		}
		// The relay id is namespaced by the pluginId of the iframe the message came from (never by
		// message content), so one plugin cannot register or abort another plugin's request.
		const relayId = `${runner.pluginId}:${++this.seq}`
		runner.relayIds.set(m.rid, relayId)
		const toWorker = (ev: PluginFetchEvent): void => {
			switch (ev.type) {
				case 'head':
					this.post(runner, { t: 'fetch:head', rid: m.rid, status: ev.status, statusText: ev.statusText, headers: ev.headers })
					break
				case 'chunk':
					this.post(runner, { t: 'fetch:chunk', rid: m.rid, data: ev.data })
					break
				case 'end':
					runner.relayIds.delete(m.rid)
					this.post(runner, { t: 'fetch:end', rid: m.rid })
					break
				case 'error':
					runner.relayIds.delete(m.rid)
					this.post(runner, { t: 'fetch:error', rid: m.rid, message: ev.message })
					break
			}
		}
		window.veridian.plugins
			.fetch({
				id: relayId,
				pluginId: runner.pluginId,
				url: m.url,
				method: m.init?.method ?? 'GET',
				headers: m.init?.headers ?? {},
				body: m.init?.body,
			}, toWorker)
			.catch((err: unknown) => toWorker({ id: relayId, type: 'error', message: err instanceof Error ? err.message : String(err) }))
	}
}

export const pluginRuntime = new PluginRuntime()
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

---

### Task 9: Selection badge + result bubble in the Markdown reader

**Files:**
- Create: `src/renderer/src/components/pdf-viewer/SelectionActions.tsx`
- Modify: `src/renderer/src/components/pdf-viewer/MarkdownViewer.tsx`
- Modify: `src/renderer/src/stores/uiStore.ts` (needed by the bubble's "go to settings" link; Task 10 uses it too)

- [ ] **Step 1: `uiStore.ts`** — remember a requested settings tab

Replace
```ts
  page: AppPage
  setPage: (page: AppPage) => void
}
```
with
```ts
  page: AppPage
  setPage: (page: AppPage) => void
  // Which settings tab to open next (consumed once by SettingsPage), e.g. from the
  // reader's "go to plugin settings" link.
  settingsTab: string | null
  setSettingsTab: (tab: string | null) => void
}
```
and replace
```ts
  page: 'library',
  setPage: (page) => set({ page }),
}))
```
with
```ts
  page: 'library',
  setPage: (page) => set({ page }),
  settingsTab: null,
  setSettingsTab: (settingsTab) => set({ settingsTab }),
}))
```

- [ ] **Step 2: Create `SelectionActions.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { pluginRuntime, PluginNotConfiguredError, type PluginAction } from '../../plugins/PluginRuntime'
import { clampToViewport } from '../item-tree/clampToViewport'
import { useUiStore } from '../../stores/uiStore'

const MAX_SELECTION = 4000
const BUBBLE_W = 420

interface Rect { left: number; top: number; right: number; bottom: number }
interface Pending { text: string; rect: Rect; actions: PluginAction[] }
interface Active { action: PluginAction; text: string; rect: Rect; truncated: boolean }

type BubbleState =
	| { status: 'loading' | 'streaming' | 'done'; output: string }
	| { status: 'error'; output: string; message: string }
	| { status: 'unconfigured'; missing: string[] }

/** Selecting text inside `containerRef` shows one badge per plugin action; clicking runs it. */
export function SelectionActions({ containerRef }: { containerRef: RefObject<HTMLElement | null> }): JSX.Element | null {
	const [pending, setPending] = useState<Pending | null>(null)
	const [active, setActive] = useState<Active | null>(null)
	const badgeRef = useRef<HTMLDivElement>(null)
	const bubbleRef = useRef<HTMLDivElement>(null)
	const generation = useRef(0)

	useEffect(() => {
		const inside = (target: EventTarget | null): boolean => {
			const n = target as Node | null
			return !!n && (!!badgeRef.current?.contains(n) || !!bubbleRef.current?.contains(n))
		}
		const onDown = (e: MouseEvent): void => {
			if (inside(e.target)) return
			generation.current++
			setPending(null)
			setActive(null)
		}
		const onUp = (e: MouseEvent): void => {
			if (inside(e.target)) return
			const mine = ++generation.current
			// Let the browser finish updating the selection before reading it.
			setTimeout(async () => {
				const s = window.getSelection()
				const container = containerRef.current
				const text = s?.toString().trim() ?? ''
				if (!s || s.rangeCount === 0 || !text || !container ||
					!container.contains(s.anchorNode) || !container.contains(s.focusNode)) return
				const r = s.getRangeAt(0).getBoundingClientRect()
				const actions = await pluginRuntime.listActions().catch(() => [])
				if (mine !== generation.current || actions.length === 0) return
				setPending({ text, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, actions })
			}, 0)
		}
		document.addEventListener('mousedown', onDown)
		document.addEventListener('mouseup', onUp)
		return () => {
			document.removeEventListener('mousedown', onDown)
			document.removeEventListener('mouseup', onUp)
		}
	}, [containerRef])

	if (active) {
		return <ActionBubble innerRef={bubbleRef} active={active} onClose={() => setActive(null)} />
	}
	if (!pending) return null

	const badgeW = pending.actions.length * 64 + 8
	return (
		<div
			ref={badgeRef}
			// keep the text selected while the badge is clicked
			onMouseDown={(e) => e.preventDefault()}
			style={{
				position: 'fixed', zIndex: 300, display: 'flex', gap: 4,
				left: clampToViewport(pending.rect.right - 8, badgeW, window.innerWidth),
				top: clampToViewport(pending.rect.bottom + 6, 28, window.innerHeight),
			}}
		>
			{pending.actions.map((a) => (
				<button
					key={a.pluginId + ':' + a.actionId}
					onClick={() => {
						setActive({
							action: a,
							text: pending.text.slice(0, MAX_SELECTION),
							rect: pending.rect,
							truncated: pending.text.length > MAX_SELECTION,
						})
						setPending(null)
					}}
					style={{
						height: 28, padding: '0 12px', borderRadius: 'var(--radius-md)',
						border: 'none', background: 'var(--primary)', color: '#fff',
						fontSize: 12, fontWeight: 600, boxShadow: 'var(--shadow-md)',
					}}
				>
					{a.title}
				</button>
			))}
		</div>
	)
}

function bubblePosition(rect: Rect): CSSProperties {
	const left = clampToViewport(rect.left, BUBBLE_W, window.innerWidth)
	const below = window.innerHeight - rect.bottom - 16
	const above = rect.top - 16
	if (below >= 140 || below >= above) return { left, top: rect.bottom + 8, maxHeight: Math.min(320, below) }
	return { left, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(320, above) }
}

const linkBtn: CSSProperties = {
	marginTop: 8, padding: 0, border: 'none', background: 'none',
	color: 'var(--primary)', fontSize: 12, textDecoration: 'underline',
}

function ActionBubble({ active, innerRef, onClose }: {
	active: Active
	innerRef: RefObject<HTMLDivElement>
	onClose: () => void
}): JSX.Element {
	const { t } = useTranslation('common')
	const setPage = useUiStore((s) => s.setPage)
	const setSettingsTab = useUiStore((s) => s.setSettingsTab)
	const [state, setState] = useState<BubbleState>({ status: 'loading', output: '' })

	useEffect(() => {
		const ctl = new AbortController()
		let acc = ''
		setState({ status: 'loading', output: '' })
		pluginRuntime
			.runAction(active.action.pluginId, active.action.actionId, active.text, (chunk) => {
				acc += chunk
				setState({ status: 'streaming', output: acc })
			}, ctl.signal)
			.then(() => setState({ status: 'done', output: acc }))
			.catch((err: unknown) => {
				if (ctl.signal.aborted) return
				if (err instanceof PluginNotConfiguredError) setState({ status: 'unconfigured', missing: err.missing })
				else setState({ status: 'error', output: acc, message: err instanceof Error ? err.message : String(err) })
			})
		return () => ctl.abort()
	}, [active])

	useEffect(() => {
		const h = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
		window.addEventListener('keydown', h)
		return () => window.removeEventListener('keydown', h)
	}, [onClose])

	const goSettings = (): void => {
		setSettingsTab('plugins')
		setPage('settings')
	}

	return (
		<div
			ref={innerRef}
			style={{
				position: 'fixed', zIndex: 300, width: BUBBLE_W, maxWidth: 'calc(100vw - 16px)', overflowY: 'auto',
				background: 'var(--bg-elevated)', color: 'var(--foreground)',
				border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
				boxShadow: 'var(--shadow-lg)', padding: '10px 14px',
				fontSize: 13, lineHeight: 1.65,
				...bubblePosition(active.rect),
			}}
		>
			{state.status === 'unconfigured' ? (
				<>
					<div>{t('settings.plugins.bubble.notConfigured', { fields: state.missing.join(', ') })}</div>
					<button onClick={goSettings} style={linkBtn}>{t('settings.plugins.bubble.goSettings')}</button>
				</>
			) : (
				<>
					{state.status === 'loading' && (
						<span style={{ color: 'var(--muted)' }}>{t('settings.plugins.bubble.loading')}</span>
					)}
					{state.output && (
						<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{state.output}</div>
					)}
					{state.status === 'error' && (
						<div style={{ color: 'var(--danger-fg)', marginTop: state.output ? 8 : 0 }}>
							{t('settings.plugins.bubble.failed', { message: state.message })}
						</div>
					)}
					{active.truncated && (
						<div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 8 }}>
							{t('settings.plugins.bubble.truncated', { max: MAX_SELECTION })}
						</div>
					)}
				</>
			)}
		</div>
	)
}
```

- [ ] **Step 3: `MarkdownViewer.tsx`** — mount it

Add after `import { citationPhrase, citationHeading, normalizeForMatch } from './citeLocate'`:
```ts
import { SelectionActions } from './SelectionActions'
```
Replace the line `      </ReactMarkdown>` with:
```tsx
      </ReactMarkdown>
      <SelectionActions containerRef={containerRef} />
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

---

### Task 10: Settings "Plugins" tab + i18n

**Files:**
- Create: `src/renderer/src/components/plugins/PluginsSettingsTab.tsx`
- Modify: `src/renderer/src/components/pages/SettingsPage.tsx`
- Modify: `src/renderer/src/i18n/index.ts`

- [ ] **Step 1: i18n** — add after each locale's `appearance` block

zh — replace
```ts
      dark: '深色',
    },
```
with
```ts
      dark: '深色',
    },
    plugins: {
      title: '插件',
      empty: '没有可用的插件',
      builtin: '内置',
      enabled: '启用',
      bubble: {
        loading: '处理中…',
        notConfigured: '尚未配置：{{fields}}',
        goSettings: '去插件设置',
        truncated: '选中文字过长，只处理前 {{max}} 个字符',
        failed: '失败：{{message}}',
      },
    },
```
en — replace
```ts
      dark: 'Dark',
    },
```
with
```ts
      dark: 'Dark',
    },
    plugins: {
      title: 'Plugins',
      empty: 'No plugins available',
      builtin: 'Built-in',
      enabled: 'Enabled',
      bubble: {
        loading: 'Working…',
        notConfigured: 'Not configured yet: {{fields}}',
        goSettings: 'Open plugin settings',
        truncated: 'Selection too long; only the first {{max}} characters are used',
        failed: 'Failed: {{message}}',
      },
    },
```
(If either anchor is not unique, anchor on the `appearance:` block of that locale instead.)

- [ ] **Step 2: Create `PluginsSettingsTab.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginConfigField, PluginInfo } from '../../../../shared/plugin'
import { pluginRuntime } from '../../plugins/PluginRuntime'

const inputStyle: CSSProperties = {
	height: 32, padding: '0 10px', borderRadius: 8, width: '100%',
	border: '1px solid var(--border)', background: 'var(--surface)',
	color: 'var(--foreground)', fontSize: 13,
}

export function PluginsSettingsTab(): JSX.Element {
	const { t } = useTranslation('common')
	const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
	const reload = useCallback((): void => { void window.veridian.plugins.list().then(setPlugins) }, [])
	useEffect(reload, [reload])

	const toggle = async (p: PluginInfo, on: boolean): Promise<void> => {
		await window.veridian.plugins.setEnabled(p.id, on)
		if (!on) pluginRuntime.dispose(p.id)
		reload()
	}

	if (!plugins) return <div />
	if (plugins.length === 0) {
		return <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t('settings.plugins.empty')}</div>
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
			{plugins.map((p) => (
				<div key={p.id} style={{
					padding: '12px 14px', borderRadius: 10,
					background: 'var(--surface-2)', border: '1px solid var(--border)',
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{p.name}</span>
						<span style={{ fontSize: 11, color: 'var(--muted)' }}>
							v{p.version}{p.builtin ? ` · ${t('settings.plugins.builtin')}` : ''}
						</span>
						<div style={{ flex: 1 }} />
						<label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--foreground-2)', cursor: 'pointer' }}>
							<input type="checkbox" checked={p.enabled} onChange={(e) => void toggle(p, e.target.checked)} />
							{t('settings.plugins.enabled')}
						</label>
					</div>
					{p.config.length > 0 && (
						<div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
							{p.config.map((f) => <FieldRow key={f.key} plugin={p} field={f} onSaved={reload} />)}
						</div>
					)}
				</div>
			))}
		</div>
	)
}

function FieldRow({ plugin, field, onSaved }: {
	plugin: PluginInfo
	field: PluginConfigField
	onSaved: () => void
}): JSX.Element {
	const stored = plugin.values[field.key] ?? ''
	const [value, setValue] = useState(stored)
	const save = (v: string): void => {
		if (v === stored) return
		void window.veridian.plugins.setConfig(plugin.id, field.key, v).then(onSaved)
	}
	return (
		<label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
			<span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground-2)' }}>
				{field.label}{field.required ? ' *' : ''}
			</span>
			{field.type === 'select' ? (
				<select
					value={value}
					style={inputStyle}
					onChange={(e) => { setValue(e.target.value); save(e.target.value) }}
				>
					{field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
				</select>
			) : (
				<input
					type={field.type === 'password' ? 'password' : 'text'}
					value={value}
					style={inputStyle}
					spellCheck={false}
					autoComplete="off"
					onChange={(e) => setValue(e.target.value)}
					onBlur={() => save(value)}
				/>
			)}
		</label>
	)
}
```

- [ ] **Step 3: `SettingsPage.tsx`** — five edits

1. Add after `import { SkillsSettingsTab } from '../knowledge/SkillsSettingsTab'`:
```tsx
import { PluginsSettingsTab } from '../plugins/PluginsSettingsTab'
```
2. Replace the line `type Tab = 'storage' | 'language' | 'appearance' | 'github' | 'knowledge' | 'skills'` with:
```tsx
const TAB_IDS = ['storage', 'language', 'appearance', 'github', 'knowledge', 'skills', 'plugins'] as const
type Tab = (typeof TAB_IDS)[number]
```
3. Replace the line `  const [tab, setTab] = useState<Tab>('storage')` with:
```tsx
  const settingsTab = useUiStore((s) => s.settingsTab)
  const setSettingsTab = useUiStore((s) => s.setSettingsTab)
  const [tab, setTab] = useState<Tab>(
    (TAB_IDS as readonly string[]).includes(settingsTab ?? '') ? (settingsTab as Tab) : 'storage',
  )
  // A tab requested from elsewhere (e.g. the reader's "open plugin settings" link) is consumed once.
  useEffect(() => { if (settingsTab) setSettingsTab(null) }, [settingsTab, setSettingsTab])
```
4. In the `tabs` array, after the `skills` entry add:
```tsx
    { id: 'plugins',    label: t('settings.plugins.title') },
```
5. In the content block, after the `{tab === 'skills'    && <SkillsSettingsTab />}` line add:
```tsx
        {tab === 'plugins'    && <PluginsSettingsTab />}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

---

### Task 11: The translate plugin (TDD)

**Files:**
- Create: `resources/plugins/translate/manifest.json`
- Create: `resources/plugins/translate/index.js`
- Test: `src/main/plugin-host/translatePlugin.test.ts`
- Modify: `package.json` (`build.extraResources`)

- [ ] **Step 1: Write the failing test** — `src/main/plugin-host/translatePlugin.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { readFileSync } from 'fs'
import { join } from 'path'

interface Ctx { text: string; config: Record<string, string>; signal: AbortSignal; output: (t: string) => void }
type Handler = (ctx: Ctx) => Promise<void>
type FetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

const source = readFileSync(join(__dirname, '../../../resources/plugins/translate/index.js'), 'utf-8')

function load(fetchImpl: FetchImpl): Handler {
	let handler: Handler | undefined
	const veridian = {
		fetch: fetchImpl,
		onSelectionAction: (id: string, h: Handler) => { if (id === 'translate') handler = h },
	}
	vm.runInNewContext(source, { veridian, TextDecoder })
	if (!handler) throw new Error('plugin did not register the translate action')
	return handler
}

const config = { baseURL: 'https://api.example.com/v1/', apiKey: 'sk-test', model: 'm1', targetLang: '中文' }
const delta = (s: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}`

function stream(...chunks: string[]): Response {
	const enc = new TextEncoder()
	return new Response(new ReadableStream({
		start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close() },
	}))
}

async function run(fetchImpl: FetchImpl, text = 'hello'): Promise<string[]> {
	const out: string[] = []
	await load(fetchImpl)({ text, config, signal: new AbortController().signal, output: (t) => out.push(t) })
	return out
}

describe('translate plugin', () => {
	it('sends an OpenAI-compatible streaming request', async () => {
		let seen: { url: string; init: Parameters<FetchImpl>[1] } | undefined
		await run(async (url, init) => { seen = { url, init }; return stream('data: [DONE]\n') }, 'good morning')
		expect(seen!.url).toBe('https://api.example.com/v1/chat/completions')
		expect(seen!.init.method).toBe('POST')
		expect(seen!.init.headers.Authorization).toBe('Bearer sk-test')
		const body = JSON.parse(seen!.init.body)
		expect(body).toMatchObject({ model: 'm1', stream: true })
		expect(body.messages[0]).toMatchObject({ role: 'system' })
		expect(body.messages[0].content).toContain('中文')
		expect(body.messages[1]).toEqual({ role: 'user', content: 'good morning' })
	})

	it('outputs deltas in order and ignores anything after [DONE]', async () => {
		const out = await run(async () => stream(delta('你') + '\n\n', delta('好') + '\n\n', 'data: [DONE]\n\n', delta('!') + '\n\n'))
		expect(out).toEqual(['你', '好'])
	})

	it('reassembles an event split across network chunks', async () => {
		const line = delta('世界')
		const out = await run(async () => stream(line.slice(0, 12), line.slice(12) + '\n\n', 'data: [DONE]\n'))
		expect(out).toEqual(['世界'])
	})

	it('skips comments, empty deltas and malformed JSON', async () => {
		const out = await run(async () => stream(': keep-alive\n\n', 'data: {oops\n\n', delta('') + '\n\n', delta('ok') + '\n\n'))
		expect(out).toEqual(['ok'])
	})

	it('throws with the status and a snippet of the body on a non-2xx answer', async () => {
		// The Error is created inside the vm context (another realm), so compare by message rather than instanceof.
		await expect(run(async () => new Response('bad key', { status: 401 }))).rejects.toMatchObject({ message: 'HTTP 401: bad key' })
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/plugin-host/translatePlugin.test.ts`
Expected: FAIL — cannot read `index.js` (ENOENT).

- [ ] **Step 3: Create `resources/plugins/translate/manifest.json`**

```json
{
  "id": "translate",
  "name": "划词翻译 / Selection Translate",
  "version": "0.1.0",
  "main": "index.js",
  "contributes": {
    "selectionActions": [{ "id": "translate", "title": "翻译" }]
  },
  "config": [
    { "key": "baseURL", "label": "API Base URL (OpenAI-compatible)", "type": "url", "required": true, "default": "https://api.openai.com/v1" },
    { "key": "apiKey", "label": "API Key", "type": "password", "required": true },
    { "key": "model", "label": "Model", "type": "text", "required": true },
    { "key": "targetLang", "label": "Target language", "type": "text", "default": "中文" }
  ]
}
```

- [ ] **Step 4: Create `resources/plugins/translate/index.js`**

```js
// Translates the selected text with an OpenAI-compatible chat API.
// Runs in the plugin sandbox: `veridian` is injected, and all network access goes through veridian.fetch.

const systemPrompt = (lang) =>
	'You are a translation engine. Translate the user\'s text into ' + lang + '. ' +
	'Keep Markdown, LaTeX formulas, code and numbers exactly as they are. ' +
	'Output only the translation, with no explanations.'

veridian.onSelectionAction('translate', async ({ text, config, signal, output }) => {
	const base = String(config.baseURL || '').replace(/\/+$/, '')
	const res = await veridian.fetch(base + '/chat/completions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
		body: JSON.stringify({
			model: config.model,
			stream: true,
			messages: [
				{ role: 'system', content: systemPrompt(config.targetLang || '中文') },
				{ role: 'user', content: text },
			],
		}),
		signal,
	})
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 300)
		throw new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''))
	}
	if (!res.body) throw new Error('empty response')

	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		buf += decoder.decode(value, { stream: true })
		let nl
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trim()
			buf = buf.slice(nl + 1)
			if (!line.startsWith('data:')) continue
			const data = line.slice(5).trim()
			if (data === '[DONE]') return
			let piece = ''
			try { piece = JSON.parse(data).choices[0].delta.content || '' } catch { continue }
			if (piece) output(piece)
		}
	}
})
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/plugin-host/translatePlugin.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: `package.json`** — ship the built-in plugins

Replace
```json
        "from": "resources/icon.ico",
        "to": "icon.ico"
      }
```
with
```json
        "from": "resources/icon.ico",
        "to": "icon.ico"
      },
      {
        "from": "resources/plugins",
        "to": "plugins"
      }
```

---

### Task 12: Full verification

- [ ] **Step 1: Automated checks**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass (the new suites: plugin, discover, relay, pluginRuntimeSource, pluginAssets, translatePlugin).

- [ ] **Step 2: Lint only what we touched**

Run: `npx eslint src/shared/plugin.ts src/shared/pluginRuntimeSource.ts src/main/plugin-host src/renderer/src/plugins src/renderer/src/components/plugins src/renderer/src/components/pdf-viewer/SelectionActions.tsx`
Expected: no errors in these files. (Report any that appear; do not touch the ~51 pre-existing errors elsewhere.)

- [ ] **Step 3: Production build compiles**

Run: `npm run build`
Expected: electron-vite finishes for main, preload and renderer without errors.

- [ ] **Step 4: Re-run the sandbox spike**

Run: `npx electron scripts/verify-plugin-sandbox.cjs`
Expected: `PASS` again (guards against Electron changes).

- [ ] **Step 5: Manual verification in the real app** (needs a real OpenAI-compatible API key; report honestly what could not be checked)

Run `npm run dev`, then:
1. Settings → 插件: the 划词翻译 plugin is listed, enabled, with 4 fields.
2. Without a key: open any `.md` attachment, select text, click 翻译 → bubble says not configured and shows a working "去插件设置" link that lands on the 插件 tab.
3. Fill Base URL / API Key / Model, go back, select text again → translation streams into the bubble; the badge and bubble stay inside the window near the bottom/right edges.
4. Press Esc mid-stream → bubble closes and the request stops (no further output).
5. Set a wrong API key → bubble shows `Failed: HTTP 401 …`, reader unaffected.
6. Disable the plugin in Settings → selecting text shows no badge; re-enable → it returns.
7. Dark and light theme both look right (badge, bubble, settings tab).
8. Restart the app: config persists; `veridian-settings.json` holds the API key as `enc:…` (not plaintext) when OS encryption is available.
9. In DevTools of the main window, confirm the hidden `veridian-plugin://translate/host.html` iframe exists and that its Worker made no requests of its own (Network panel shows only the app's own traffic).
