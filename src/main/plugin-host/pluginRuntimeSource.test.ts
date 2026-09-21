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

	it('aborts and rejects when the host reports a status a Response cannot carry', async () => {
		const { posted, veridian, send } = boot()
		veridian.onSelectionAction('f', async () => { await veridian.fetch('https://api.example.com/') })
		run(send, 'f')
		await tick()
		const req = posted.find((m) => m.t === 'fetch')!
		send({ t: 'fetch:head', rid: req.rid, status: 999, statusText: '', headers: {} })
		await tick()
		expect(posted).toContainEqual({ t: 'fetch:abort', rid: req.rid })
		expect(posted[posted.length - 1]).toEqual({ t: 'error', runId: 'r1', message: 'unsupported response status 999' })
	})
})
