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
