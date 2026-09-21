// 本期唯一的工具。存在的意义是验证「注册 → schema 进提示词 → 模型调用 → 执行
// → 结果回灌 → 再次请求」整条通路，而不是提供能力。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getDb } from '../../db'

export const getItemInfo = defineTool({
	name: 'get_item_info',
	description: '按 item_key 返回一篇文献的题录信息（标题、年份、期刊、DOI、作者）。',
	parameters: {
		item_key: { type: 'string', required: true, description: '文献的 key' },
	},
	// 声明成 string 而不是结构化对象：回灌给模型的就是这段 JSON 文本，
	// 让 output schema 和真正上下文里的东西保持一致。
	output: {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: value }],
	},
	async execute(args) {
		const item = getDb()
			.prepare('SELECT id, title, year, journal, doi FROM items WHERE key = ? AND deleted = 0')
			.get(args.item_key) as
			| { id: number; title: string | null; year: number | null; journal: string | null; doi: string | null }
			| undefined
		if (!item) return 'not found'
		const creators = getDb()
			.prepare(`
				SELECT c.last_name, c.first_name FROM creators c
				JOIN item_creators ic ON ic.creator_id = c.id
				WHERE ic.item_id = ? ORDER BY ic.position LIMIT 10
			`)
			.all(item.id) as Array<{ last_name: string; first_name: string | null }>
		return JSON.stringify({
			title: item.title,
			year: item.year,
			journal: item.journal,
			doi: item.doi,
			authors: creators.map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ')),
		})
	},
})
