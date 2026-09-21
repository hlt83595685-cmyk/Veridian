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
