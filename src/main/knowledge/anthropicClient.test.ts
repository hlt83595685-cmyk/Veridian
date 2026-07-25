import { describe, it, expect } from 'vitest'
import { toAnthropicMessages, toAnthropicTools } from './anthropicClient'
import type { ChatMessage, ToolDef } from './providers'

describe('toAnthropicMessages', () => {
	it('splits the system message out of the array', () => {
		const { system, messages } = toAnthropicMessages([
			{ role: 'system', content: 'You are helpful.' },
			{ role: 'user', content: 'hi' },
		])
		expect(system).toBe('You are helpful.')
		expect(messages).toEqual([{ role: 'user', content: 'hi' }])
	})

	it('converts assistant tool_calls into tool_use content blocks', () => {
		const { messages } = toAnthropicMessages([
			{
				role: 'assistant', content: 'looking it up',
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_library', arguments: '{"query":"x"}' } }],
			},
		])
		expect(messages).toEqual([{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'looking it up' },
				{ type: 'tool_use', id: 'call_1', name: 'search_library', input: { query: 'x' } },
			],
		}])
	})

	it('converts a tool result message into a user turn with tool_result block', () => {
		const { messages } = toAnthropicMessages([
			{ role: 'tool', content: 'the answer', tool_call_id: 'call_1' },
		])
		expect(messages).toEqual([{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'the answer' }],
		}])
	})

	it('merges consecutive tool results into one user turn (parallel tool calls)', () => {
		const { messages } = toAnthropicMessages([
			{ role: 'tool', content: 'result a', tool_call_id: 'call_1' },
			{ role: 'tool', content: 'result b', tool_call_id: 'call_2' },
		])
		expect(messages).toHaveLength(1)
		expect(messages[0].content).toEqual([
			{ type: 'tool_result', tool_use_id: 'call_1', content: 'result a' },
			{ type: 'tool_result', tool_use_id: 'call_2', content: 'result b' },
		])
	})

	it('handles malformed tool_call arguments without throwing', () => {
		const { messages } = toAnthropicMessages([
			{
				role: 'assistant', content: null,
				tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'not json' } }],
			},
		])
		expect(messages[0].content).toEqual([{ type: 'tool_use', id: 'c1', name: 'f', input: {} }])
	})
})

describe('toAnthropicTools', () => {
	it('renames parameters to input_schema', () => {
		const tools: ToolDef[] = [{
			type: 'function',
			function: { name: 'search_library', description: 'desc', parameters: { type: 'object', properties: {} } },
		}]
		expect(toAnthropicTools(tools)).toEqual([
			{ name: 'search_library', description: 'desc', input_schema: { type: 'object', properties: {} } },
		])
	})
})
