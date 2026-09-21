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
			const timer = setTimeout(() => stop(new Error('timeout')), RUN_TIMEOUT_MS)
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
				// `inited` is posted before the script has loaded, so a load failure arrives after
				// `ready` settled. Drop the dead runner so the next run starts a fresh one instead of
				// waiting on a Worker that is gone.
				this.dispose(runner.pluginId)
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
