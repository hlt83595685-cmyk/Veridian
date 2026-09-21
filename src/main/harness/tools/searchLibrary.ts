// 在用户的文献库里检索。
//
// `hybridSearch` 早就写好了（FTS + 向量 + RRF 融合 + rerank），只是 harness 重构
// 掉旧的 agent.ts 时，连着它的那条线被剪断了，全仓一个调用点都不剩。这个文件
// 就是把线接回来——不是新能力。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hybridSearch, type SearchHit } from '../../knowledge/search'
import { truncateAtBoundary } from '../../knowledge/truncate'
import { getActiveWorkspace } from '../../services/WorkspaceContextService'
import { scopeByCollection } from './collections'

const DEFAULT_K = 6
const MAX_K = 20

/** 单段原文的上限。chunker 的 MAX_CHARS 是 1500，这里只是防病态值的兜底，
 *  不做「省预算」式的截断——检索的价值就是把原文摆到模型面前，切一半等于白找。 */
const SNIPPET_MAX = 1200

function render(hits: SearchHit[]): string {
	return hits
		.map((h, i) => {
			const where = h.headingPath ? ` §${h.headingPath}` : ''
			return `[${i + 1}] key=${h.itemKey}${where}\n${truncateAtBoundary(h.text, SNIPPET_MAX)}`
		})
		.join('\n\n')
}

export const searchLibrary = defineTool({
	name: 'search_library',
	description:
		'在用户的文献库里做混合检索（关键词 + 语义），返回最相关的若干段原文。'
		+ '每段带 key，可以再用 get_item_info 查这篇的题录。'
		+ '想知道「库里有没有讲过某件事」时用它，而不是凭记忆回答。',
	parameters: {
		query: {
			type: 'string',
			required: true,
			description: '用自然语言描述你要找什么。写成完整的句子比堆关键词更准。',
		},
		top_k: { type: 'number', description: `返回几段，默认 ${DEFAULT_K}，最多 ${MAX_K}` },
		collection: {
			type: 'string',
			description: '只在这个分类里找。省略则搜全库。名字取自 list_collections。',
		},
	},
	output: {
		schema: { type: 'string' },
		render: (_args, value) => [{ type: 'text', text: value }],
	},
	async execute(args) {
		const q = args.query.trim()
		if (!q) return 'error: query must not be empty'

		// 未定义、NaN、负数、小数都要落到一个合法整数上——模型给的数字不可信。
		const asked = Math.floor(Number(args.top_k))
		const topK = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_K) : DEFAULT_K

		// 限定分类时先把名字解析成 itemIds。解析不了就**停下来报错**，不要
		// 悄悄退回全库——用户说「在这个分类里找」，翻遍全库给的答案是另一个问题
		// 的答案，而他不会知道范围被换过。
		let filter: { itemIds: number[] } | undefined
		if (args.collection) {
			const scope = scopeByCollection(args.collection)
			if ('error' in scope) return `error: ${scope.error}`
			if (scope.ids.length === 0) return `"${args.collection}" is empty, nothing to search`
			filter = { itemIds: scope.ids }
		}

		const hits = await hybridSearch(getActiveWorkspace().id ?? 0, q, topK, filter)
		// 空结果如实说，别让模型把「没找到」读成「工具坏了」而去重试。
		if (!hits.length) return `no results for "${q}"`
		return render(hits)
	},
})
