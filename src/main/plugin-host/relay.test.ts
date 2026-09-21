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
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok'))
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

	it('resolves and aborts the request when emit throws mid-stream', async () => {
		let signal!: AbortSignal
		const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
			signal = init!.signal!
			return new Response(streamOf('aa', 'bb', 'cc'))
		})
		const emit = (): void => { throw new Error('renderer gone') }
		await expect(runRelay(req({ id: 'p:5' }), allowed, emit, fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined()
		expect(signal.aborted).toBe(true)
	})

	it('resolves when emit throws on a refused target', async () => {
		const fetchImpl = vi.fn()
		const emit = (): void => { throw new Error('renderer gone') }
		await expect(runRelay(req({ url: 'https://evil.com/' }), allowed, emit, fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined()
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})
