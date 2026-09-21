// 关键性质：**每一帧都要是合法文档**，而且补齐只动末尾——动了前面，已经画出来
// 的内容会在流式过程中跳动。
import { describe, it, expect } from 'vitest'
import { closeOpenMarkdown } from './streamingMarkdown'

describe('围栏代码块', () => {
	it('未闭合的围栏补上收尾 —— 否则从这里到文末全被当成代码', () => {
		expect(closeOpenMarkdown('文字\n```json\n{')).toBe('文字\n```json\n{\n```')
	})

	it('已闭合的不动', () => {
		const src = '文字\n```js\nlet a = 1\n```\n后面'
		expect(closeOpenMarkdown(src)).toBe(src)
	})

	it('~~~ 也算围栏', () => {
		expect(closeOpenMarkdown('~~~py\nx = 1')).toBe('~~~py\nx = 1\n~~~')
	})

	it('长围栏不能被短的收尾（CommonMark 规矩），仍要补', () => {
		// ```` 开的，中间那行 ``` 不算收尾，末尾仍处于未闭合
		expect(closeOpenMarkdown('````\n```\n内层')).toBe('````\n```\n内层\n````')
	})

	it('收尾行带了别的内容就不算收尾', () => {
		expect(closeOpenMarkdown('```\na\n``` 还有字')).toContain('\n```')
	})

	it('已经以换行结尾时不多插一个空行', () => {
		expect(closeOpenMarkdown('```\na\n')).toBe('```\na\n```')
	})
})

describe('半截表格', () => {
	it('分隔行还没到时，丢掉那个裸表头行', () => {
		expect(closeOpenMarkdown('说明\n| key | 字段 |')).toBe('说明')
	})

	it('分隔行到了就正常留着', () => {
		const src = '说明\n| key | 字段 |\n| --- | --- |'
		expect(closeOpenMarkdown(src)).toBe(src)
	})

	it('表格已经在长了（前一行也是表格行）就不丢', () => {
		const src = '| a | b |\n| --- | --- |\n| 1 | 2 |'
		expect(closeOpenMarkdown(src)).toBe(src)
	})
})

describe('不该动的情况', () => {
	it.each([
		['空串', ''],
		['纯文字', '就是一段话'],
		['行内 code', '这里有 `fix_metadata` 一个词'],
		['列表', '- a\n- b'],
		['标题', '# 标题\n正文'],
	])('%s 原样返回', (_label, src) => {
		expect(closeOpenMarkdown(src)).toBe(src)
	})

	it('每一帧都合法：逐字符喂进去，围栏永远是偶数个', () => {
		const full = '开头\n```json\n{"a":1}\n```\n结尾'
		for (let i = 1; i <= full.length; i++) {
			const out = closeOpenMarkdown(full.slice(0, i))
			const fences = (out.match(/^ {0,3}```/gm) ?? []).length
			expect(fences % 2).toBe(0)
		}
	})
})
