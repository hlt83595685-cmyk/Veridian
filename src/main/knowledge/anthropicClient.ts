// Anthropic Messages API client, used only when the chat provider preset is
// 'claude-subscription' -- the user pastes a personal OAuth token generated
// via `claude setup-token` (documented at
// https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
// This talks to Anthropic's own wire protocol (POST /v1/messages), which is
// NOT OpenAI-compatible, so it can't share providers.ts's chatStream/embedBatch.
//
// IMPORTANT CAVEAT: the `anthropic-beta: oauth-2025-04-20` header below is
// the header Claude Code's own client sends when authenticating with a
// setup-token-issued bearer token (reverse-engineered by community projects
// such as github.com/weidwonder/claude_agent_sdk_oauth_demo). This has not
// been exercised against a real token in this codebase -- verify with a real
// CLAUDE_CODE_OAUTH_TOKEN before relying on it.
import type { ChatMessage, ToolCall, ToolDef, ChatResult, ProviderConfig } from './providers'

const ANTHROPIC_VERSION = '2023-06-01'
const OAUTH_BETA = 'oauth-2025-04-20'
const MAX_TOKENS = 4096

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

interface AnthropicMessage {
	role: 'user' | 'assistant'
	content: string | AnthropicContentBlock[]
}

/** Convert our OpenAI-shaped ChatMessage[] into Anthropic's system + messages split. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
	let system = ''
	const out: AnthropicMessage[] = []

	for (const m of messages) {
		if (m.role === 'system') {
			system = system ? `${system}\n\n${m.content ?? ''}` : (m.content ?? '')
			continue
		}
		if (m.role === 'tool') {
			// Anthropic returns tool results as a 'user' turn with tool_result blocks.
			const last = out[out.length - 1]
			const block: AnthropicToolResultBlock = {
				type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '',
			}
			if (last && last.role === 'user' && Array.isArray(last.content)) {
				last.content.push(block)
			} else {
				out.push({ role: 'user', content: [block] })
			}
			continue
		}
		if (m.role === 'assistant' && m.tool_calls?.length) {
			const blocks: AnthropicContentBlock[] = []
			if (m.content) blocks.push({ type: 'text', text: m.content })
			for (const tc of m.tool_calls) {
				let input: unknown = {}
				try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* leave {} */ }
				blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
			}
			out.push({ role: 'assistant', content: blocks })
			continue
		}
		out.push({ role: m.role as 'user' | 'assistant', content: m.content ?? '' })
	}
	return { system, messages: out }
}

export function toAnthropicTools(tools: ToolDef[]): { name: string; description: string; input_schema: unknown }[] {
	return tools.map((t) => ({
		name: t.function.name,
		description: t.function.description,
		input_schema: t.function.parameters,
	}))
}

export async function anthropicChatStream(
	cfg: ProviderConfig,
	messages: ChatMessage[],
	tools: ToolDef[],
	onDelta: (text: string) => void,
	signal: AbortSignal
): Promise<ChatResult> {
	const { system, messages: anthropicMessages } = toAnthropicMessages(messages)

	const resp = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${cfg.apiKey}`,
			'anthropic-version': ANTHROPIC_VERSION,
			'anthropic-beta': OAUTH_BETA,
		},
		body: JSON.stringify({
			model: cfg.model,
			max_tokens: MAX_TOKENS,
			...(system ? { system } : {}),
			messages: anthropicMessages,
			...(tools.length ? { tools: toAnthropicTools(tools) } : {}),
			stream: true,
		}),
		signal,
	})
	if (!resp.ok || !resp.body) {
		throw new Error(`anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
	}

	let content = ''
	let finishReason = ''
	// Blocks arrive by index; text blocks accumulate a string, tool_use blocks
	// accumulate their JSON input as a string (input_json_delta fragments).
	const blocks = new Map<number, { type: 'text' | 'tool_use'; id?: string; name?: string; text: string }>()

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
			if (!payload) continue
			let evt: {
				type: string
				index?: number
				content_block?: { type: string; id?: string; name?: string }
				delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string }
			}
			try { evt = JSON.parse(payload) } catch { continue }

			if (evt.type === 'content_block_start' && evt.index !== undefined && evt.content_block) {
				const cb = evt.content_block
				blocks.set(evt.index, {
					type: cb.type === 'tool_use' ? 'tool_use' : 'text',
					id: cb.id, name: cb.name, text: '',
				})
			} else if (evt.type === 'content_block_delta' && evt.index !== undefined && evt.delta) {
				const b = blocks.get(evt.index)
				if (!b) continue
				if (evt.delta.type === 'text_delta' && evt.delta.text) {
					b.text += evt.delta.text
					content += evt.delta.text
					onDelta(evt.delta.text)
				} else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json) {
					b.text += evt.delta.partial_json
				}
			} else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
				finishReason = evt.delta.stop_reason
			}
		}
	}

	const toolCalls: ToolCall[] = [...blocks.values()]
		.filter((b) => b.type === 'tool_use')
		.map((b) => ({
			id: b.id ?? '', type: 'function' as const,
			function: { name: b.name ?? '', arguments: b.text || '{}' },
		}))

	return { content, toolCalls, finishReason }
}
