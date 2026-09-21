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
	// A throwing emit (e.g. the renderer went away) must not reject or leave the request open.
	const ctl = new AbortController()
	const send = (e: PluginFetchEvent): void => {
		try { emit(e) } catch { ctl.abort() }
	}
	const target = checkFetchTarget(req.url, allowed)
	if (!target.ok) { send({ id: req.id, type: 'error', message: target.error }); return }
	if (inflight.has(req.id)) { send({ id: req.id, type: 'error', message: 'duplicate request id' }); return }

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
		send({ id: req.id, type: 'head', status: res.status, statusText: res.statusText, headers: resHeaders })
		if (res.body) {
			const reader = res.body.getReader()
			let total = 0
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				total += value.byteLength
				if (total > maxBytes) { ctl.abort(); throw new Error('response too large') }
				send({ id: req.id, type: 'chunk', data: value })
			}
		}
		send({ id: req.id, type: 'end' })
	} catch (err) {
		send({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) })
	} finally {
		clearTimeout(timer)
		ctl.abort()
		inflight.delete(req.id)
	}
}
