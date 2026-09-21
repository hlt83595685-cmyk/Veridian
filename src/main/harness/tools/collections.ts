// 分类（collection）相关的读工具。
//
// 缺了这一组，模型就「看不见」文库的组织方式：用户说「把 X 分类里的条目改一下」，
// 它既不知道有哪些分类，也列不出某个分类下有什么，只能去全库检索碰运气。
//
// 名字解析是这组工具的核心。用户嘴里的分类是**名字**，模型手里也只有名字，而
// 底下的 API 要 id。解析不出来时必须把现有的名字列回去——模型才有机会改口，
// 而不是拿一个猜的 id 去动别人的数据。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { listAll } from '../../services/CollectionService'
import { listByCollection } from '../../services/ItemService'
import type { Collection, Item } from '../../../shared/types'

/** 一次最多列多少条目。分类可以很大，整包塞进上下文会挤掉别的东西。 */
const ITEM_LIMIT = 100

const text = {
	schema: { type: 'string' } as const,
	render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * 名字归一：大小写不敏感，忽略首尾空白与全角空格。
 *
 * 全角空格写成转义而不是字面量：它长得和普通空格一模一样，直接写进代码里
 * 谁也看不出来（lint 的 no-irregular-whitespace 就是为这个存在的）。中文分类名
 * 里混进全角空格是常事，不归一就会「明明看着一样却匹配不上」。
 */
function norm(s: string): string {
	return s.replace(/\u3000/g, ' ').trim().toLowerCase()
}

type Resolved = { ok: true; collection: Collection } | { ok: false; message: string }

/**
 * 按名字找分类。
 *
 * 找不到或者重名时，把现有的名字**列回去**。模型拿着一句「no such collection」
 * 只会重试同一个名字；拿着清单它才能改口。
 */
function resolve(name: string): Resolved {
	const all = listAll()
	if (all.length === 0) return { ok: false, message: 'the library has no collections yet' }

	const target = norm(name)
	const hits = all.filter((c) => norm(c.name) === target)
	if (hits.length === 1) return { ok: true, collection: hits[0] }

	const names = all.map((c) => c.name).join(', ')
	if (hits.length > 1) {
		return { ok: false, message: `"${name}" matches ${hits.length} collections; ask the user which one. all: ${names}` }
	}
	// 没有精确匹配时给一次包含匹配的提示——用户常常只说一半名字。
	const partial = all.filter((c) => norm(c.name).includes(target) || target.includes(norm(c.name)))
	return {
		ok: false,
		message: partial.length
			? `no collection named "${name}". did you mean: ${partial.map((c) => c.name).join(', ')}? all: ${names}`
			: `no collection named "${name}". existing collections: ${names}`,
	}
}

/** 供 search_library 复用：把分类名解析成 itemIds，失败时给出可读原因。 */
export function scopeByCollection(name: string): { ids: number[] } | { error: string } {
	const r = resolve(name)
	if (!r.ok) return { error: r.message }
	return { ids: listByCollection(r.collection.id).map((i) => i.id) }
}

function line(i: Item): string {
	const bits = [i.year, i.journal].filter(Boolean).join(', ')
	return `- ${i.key} | ${i.title ?? '(no title)'}${bits ? ` | ${bits}` : ''}`
}

export const listCollections = defineTool({
	name: 'list_collections',
	description:
		'列出文库里的所有分类，带条目数。用户提到某个分类时先用它确认名字——'
		+ '分类名要精确匹配才能用于后续操作。',
	parameters: {},
	output: text,
	async execute() {
		const all = listAll()
		if (all.length === 0) return 'the library has no collections'

		const byId = new Map(all.map((c) => [c.id, c]))
		return all
			.map((c) => {
				const count = listByCollection(c.id).length
				// 父分类写出来：同名的子分类在不同父下是常事，模型要能分辨。
				const parent = c.parent_id === null ? null : byId.get(c.parent_id)?.name
				return `- ${c.name}${parent ? ` (under ${parent})` : ''} — ${count} item(s)`
			})
			.join('\n')
	},
})

export const listCollectionItems = defineTool({
	name: 'list_collection_items',
	description:
		'列出某个分类下的文献，返回 key、标题、年份、期刊。'
		+ '拿到 key 之后可以用 get_item_info 看详情，或用写工具逐条修改。'
		+ '只列直接属于该分类的条目，不含子分类。',
	parameters: {
		collection: { type: 'string', required: true, description: '分类名，取自 list_collections' },
		limit: { type: 'number', description: `最多返回几条，默认也是上限 ${ITEM_LIMIT}` },
	},
	output: text,
	async execute(args) {
		const r = resolve(args.collection)
		if (!r.ok) return `error: ${r.message}`

		const items = listByCollection(r.collection.id)
		if (items.length === 0) return `"${r.collection.name}" is empty`

		const asked = Math.floor(Number(args.limit))
		const cap = Number.isFinite(asked) && asked > 0 ? Math.min(asked, ITEM_LIMIT) : ITEM_LIMIT
		const shown = items.slice(0, cap)

		// 子分类另说：不静默漏掉，也不擅自展开——模型可以自己决定要不要进去。
		const children = listAll().filter((c) => c.parent_id === r.collection.id)
		const notes = [
			shown.length < items.length
				? `[showing ${shown.length} of ${items.length}; ask for a higher limit or narrow down]`
				: '',
			children.length
				? `[has sub-collections not included here: ${children.map((c) => c.name).join(', ')}]`
				: '',
		].filter(Boolean)

		return [`"${r.collection.name}" — ${items.length} item(s)`, ...shown.map(line), ...notes].join('\n')
	},
})

export const COLLECTION_TOOLS = [listCollections, listCollectionItems]
