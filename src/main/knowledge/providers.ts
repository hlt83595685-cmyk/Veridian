// OpenAI-compatible HTTP clients for chat (streaming + tools) and embeddings.
// One implementation covers every cloud vendor the settings UI offers
// (DeepSeek / Zhipu / Kimi / OpenAI / custom) -- they all speak this protocol.
import { getSetting } from '../services/SettingsService'

export interface ProviderConfig {
	baseURL: string   // e.g. https://api.deepseek.com/v1
	model: string
	apiKey: string
}

function str(v: unknown): string {
	return typeof v === 'string' ? v.trim() : ''
}

export function getChatConfig(): ProviderConfig | null {
	const cfg = {
		baseURL: str(getSetting('knowledge.chat.baseURL')).replace(/\/+$/, ''),
		model: str(getSetting('knowledge.chat.model')),
		apiKey: str(getSetting('knowledge.chat.apiKey')),
	}
	return cfg.baseURL && cfg.model && cfg.apiKey ? cfg : null
}

export function getEmbeddingConfig(): ProviderConfig | null {
	const reuse = getSetting('knowledge.embedding.reuseChatKey') === true
	const cfg = {
		baseURL: str(getSetting('knowledge.embedding.baseURL')).replace(/\/+$/, ''),
		model: str(getSetting('knowledge.embedding.model')),
		apiKey: reuse ? str(getSetting('knowledge.chat.apiKey')) : str(getSetting('knowledge.embedding.apiKey')),
	}
	return cfg.baseURL && cfg.model && cfg.apiKey ? cfg : null
}

// ── Embeddings ───────────────────────────────────────────────────────────────

/** Batch-embed texts. Throws on any failure; caller decides retry policy. */
export async function embedBatch(cfg: ProviderConfig, texts: string[]): Promise<number[][]> {
	const resp = await fetch(`${cfg.baseURL}/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
		body: JSON.stringify({ model: cfg.model, input: texts }),
	})
	if (!resp.ok) throw new Error(`embeddings ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
	const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] }
	// The API may reorder; restore input order via index.
	const out: number[][] = new Array(texts.length)
	for (const d of data.data) out[d.index] = d.embedding
	if (out.some((e) => !Array.isArray(e))) throw new Error('embeddings response missing entries')
	return out
}

// ── Chat (streaming, with tool calling) ──────────────────────────────────────

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | null
	tool_calls?: ToolCall[]
	tool_call_id?: string
}

export interface ToolCall {
	id: string
	type: 'function'
	function: { name: string; arguments: string }
}

export interface ToolDef {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

export interface ChatResult {
	content: string
	toolCalls: ToolCall[]
	finishReason: string
}

/**
 * Stream one chat completion. onDelta receives content fragments as they
 * arrive (tool-call argument fragments are accumulated silently). Returns the
 * fully assembled message.
 */
export async function chatStream(
	cfg: ProviderConfig,
	messages: ChatMessage[],
	tools: ToolDef[],
	onDelta: (text: string) => void,
	signal: AbortSignal
): Promise<ChatResult> {
	const resp = await fetch(`${cfg.baseURL}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
		body: JSON.stringify({
			model: cfg.model,
			messages,
			...(tools.length ? { tools } : {}),
			stream: true,
		}),
		signal,
	})
	if (!resp.ok || !resp.body) {
		throw new Error(`chat ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
	}

	let content = ''
	let finishReason = ''
	// tool_calls arrive as indexed fragments; assemble by index.
	const calls = new Map<number, { id: string; name: string; args: string }>()

	const reader = resp.body.getReader()
	const decoder = new TextDecoder()
	let buf = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		buf += decoder.decode(value, { stream: true })
		const lines = buf.split('\n')
		buf = lines.pop() ?? ''
		for (const line of lines) {
			const s = line.trim()
			if (!s.startsWith('data:')) continue
			const payload = s.slice(5).trim()
			if (payload === '[DONE]') continue
			let json: {
				choices?: {
					delta?: { content?: string | null; tool_calls?: {
						index: number; id?: string; function?: { name?: string; arguments?: string }
					}[] }
					finish_reason?: string | null
				}[]
			}
			try { json = JSON.parse(payload) } catch { continue }
			const choice = json.choices?.[0]
			if (!choice) continue
			if (choice.finish_reason) finishReason = choice.finish_reason
			const delta = choice.delta
			if (!delta) continue
			if (delta.content) {
				content += delta.content
				onDelta(delta.content)
			}
			for (const tc of delta.tool_calls ?? []) {
				const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
				if (tc.id) cur.id = tc.id
				if (tc.function?.name) cur.name += tc.function.name
				if (tc.function?.arguments) cur.args += tc.function.arguments
				calls.set(tc.index, cur)
			}
		}
	}

	const toolCalls: ToolCall[] = [...calls.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, c]) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args } }))

	return { content, toolCalls, finishReason }
}

/** Settings-page connectivity test. Returns null on success, error text otherwise. */
export async function testProvider(which: 'chat' | 'embedding'): Promise<string | null> {
	try {
		if (which === 'embedding') {
			const cfg = getEmbeddingConfig()
			if (!cfg) return 'not configured'
			const [v] = await embedBatch(cfg, ['ping'])
			return v.length > 0 ? null : 'empty embedding'
		}
		const cfg = getChatConfig()
		if (!cfg) return 'not configured'
		const r = await chatStream(cfg, [{ role: 'user', content: 'Say "ok".' }], [], () => {}, new AbortController().signal)
		return r.content ? null : 'empty response'
	} catch (err) {
		return (err as Error).message
	}
}
