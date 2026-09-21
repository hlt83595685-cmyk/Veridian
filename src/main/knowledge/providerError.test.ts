// 报错是给用户看的。把供应商的整个 JSON 甩进聊天窗口，真正有用的那句话会被
// 括号和引号埋掉——图里那条 400 就是这样，一眼看不出问题在哪。
import { describe, it, expect } from 'vitest'
import { providerError } from './providers'

describe('providerError', () => {
	it('取出 OpenAI 兼容格式里的那句人话', () => {
		expect(providerError(JSON.stringify({
			error: {
				message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
				type: 'invalid_request_error', param: null, code: 'invalid_request_error',
			},
		}))).toBe('The `reasoning_content` in the thinking mode must be passed back to the API.')
	})

	it('也认顶层的 message', () => {
		expect(providerError('{"message":"rate limited"}')).toBe('rate limited')
	})

	it('不是 JSON 就按原文，不要因为解析不了就丢掉信息', () => {
		expect(providerError('502 Bad Gateway')).toBe('502 Bad Gateway')
	})

	it('结构对不上时退回原文', () => {
		expect(providerError('{"detail":{"x":1}}')).toBe('{"detail":{"x":1}}')
	})

	it('message 是空串时不当成有效信息', () => {
		expect(providerError('{"error":{"message":"   "}}')).toBe('{"error":{"message":"   "}}')
	})

	it('超长的截断，别把整页 HTML 灌进聊天窗口', () => {
		expect(providerError('x'.repeat(1000))).toHaveLength(300)
	})
})
