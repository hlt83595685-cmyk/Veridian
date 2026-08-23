// 本期唯一的工具。存在的意义是验证「注册 → schema 进提示词 → 模型调用 → 执行
// → 结果回灌 → 再次请求」整条通路，而不是提供能力。
import { getDb } from '../../db'
import type { HarnessTool } from './registry'

export const getItemInfo: HarnessTool = {
  name: 'get_item_info',
  kind: 'read',
  description: '按 item_key 返回一篇文献的题录信息（标题、年份、期刊、DOI、作者）。',
  parameters: {
    type: 'object',
    properties: { item_key: { type: 'string', description: '文献的 key' } },
    required: ['item_key'],
  },
  async execute(args) {
    const key = String(args.item_key ?? '')
    const item = getDb()
      .prepare('SELECT id, title, year, journal, doi FROM items WHERE key = ? AND deleted = 0')
      .get(key) as
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
}
