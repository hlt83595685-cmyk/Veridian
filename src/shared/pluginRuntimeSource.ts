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
			var res
			try {
				res = new Response(nullBody ? null : e.body, { status: m.status, statusText: m.statusText, headers: m.headers })
			} catch (x) {
				delete pending[m.rid]
				post({ t: 'fetch:abort', rid: m.rid })
				e.reject(new Error('unsupported response status ' + m.status))
				return
			}
			e.resolve(res)
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
