// 写工具：助手真正动手改用户东西的那几件事。
//
// 全部是**包一层**现成的 Service——建笔记、打标签、补元数据、标星在 UI 上早就
// 能做，也各自有测试和 oplog。这里只是把它们接到模型手上；业务逻辑一行都不该
// 搬过来，搬了就会出现「UI 改一套、AI 改另一套」的两份真相。
//
// 每个都是 write-library：它们改的是文库里的数据，不碰磁盘、不删东西。真正的
// 删除（trash / emptyTrash）**故意没有**暴露给模型——那一档要等 destructive
// 真的有人需要时再单独审。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getDb } from '../../db'
import { saveNote } from '../../services/NoteService'
import { mergeTagsForItem } from '../../services/TagService'
import { updateItem, setStarred } from '../../services/ItemService'

/** 题录 key → 内部 id。模型只认 key（检索结果里给的就是 key）。 */
function itemIdOf(key: string): number | null {
	const row = getDb()
		.prepare('SELECT id FROM items WHERE key = ? AND deleted = 0')
		.get(key) as { id: number } | undefined
	return row?.id ?? null
}

const text = {
	schema: { type: 'string' } as const,
	render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const writeNote = defineTool({
	name: 'write_note',
	description:
		'新建一条笔记。可以挂在某篇文献下（给 item_key），也可以是独立的概念页（不给 item_key）。'
		+ '正文支持 [[双链]]，写进去会自动建立关联。',
	parameters: {
		title: { type: 'string', required: true, description: '笔记标题' },
		content: { type: 'string', required: true, description: 'Markdown 正文' },
		item_key: { type: 'string', description: '挂到这篇文献下；省略则建成独立概念页' },
	},
	output: text,
	async execute(args) {
		const title = args.title.trim()
		if (!title) return 'error: title must not be empty'

		let itemId: number | null = null
		if (args.item_key) {
			itemId = itemIdOf(args.item_key)
			// 认不出 key 就停下来问，别默默建成一条挂不上的孤儿笔记。
			if (itemId === null) return `error: no such item "${args.item_key}"`
		}

		// origin:'ai' 让笔记在界面上标得出来是谁写的——用户必须能分辨。
		const id = saveNote({ itemId, title, content: args.content, origin: 'ai' })
		return `created note #${id} "${title}"${itemId === null ? '' : ` on ${args.item_key}`}`
	},
})

export const addTags = defineTool({
	name: 'add_tags',
	description: '给一篇文献补标签。只增不删——已有的标签一个都不会动。',
	parameters: {
		item_key: { type: 'string', required: true, description: '文献的 key' },
		tags: { type: 'array', items: { type: 'string' }, required: true, description: '要补的标签' },
	},
	output: text,
	async execute(args) {
		const itemId = itemIdOf(args.item_key)
		if (itemId === null) return `error: no such item "${args.item_key}"`
		const names = args.tags.map((t) => t.trim()).filter(Boolean)
		if (!names.length) return 'error: no tags given'
		// merge 而不是 set：模型手里没有完整的现有标签，用 set 会把它不知道的
		// 那些全删掉。
		const { added, total } = mergeTagsForItem(itemId, names)
		return added === 0
			? `no new tags; ${args.item_key} already has all ${total}`
			: `added ${added} tag(s) to ${args.item_key}, now ${total}`
	},
})

/** 允许模型改的字段。白名单——不在这里的一律不动，哪怕模型传了。 */
const EDITABLE = ['title', 'year', 'journal', 'doi', 'publisher', 'volume', 'issue', 'pages'] as const

export const fixMetadata = defineTool({
	name: 'fix_metadata',
	description:
		'订正一篇文献的题录字段。只改你明确给出的字段，没给的保持原样。'
		+ '适合修正导入时抓错的标题、年份、期刊等。',
	parameters: {
		item_key: { type: 'string', required: true, description: '文献的 key' },
		title: { type: 'string' },
		year: { type: 'number' },
		journal: { type: 'string' },
		doi: { type: 'string' },
		publisher: { type: 'string' },
		volume: { type: 'string' },
		issue: { type: 'string' },
		pages: { type: 'string' },
	},
	output: text,
	async execute(args) {
		const itemId = itemIdOf(args.item_key)
		if (itemId === null) return `error: no such item "${args.item_key}"`

		const patch: Record<string, unknown> = {}
		for (const f of EDITABLE) {
			const v = (args as Record<string, unknown>)[f]
			if (v !== undefined) patch[f] = v
		}
		// 一个字段都没给就什么也不做。静默"成功"会让模型以为改过了。
		if (!Object.keys(patch).length) return 'error: no fields given to change'

		updateItem(itemId, patch)
		return `updated ${Object.keys(patch).join(', ')} on ${args.item_key}`
	},
})

export const starItem = defineTool({
	name: 'star_item',
	description: '把一篇文献标记为重要，或取消标记。',
	parameters: {
		item_key: { type: 'string', required: true, description: '文献的 key' },
		starred: { type: 'boolean', required: true, description: 'true 标记，false 取消' },
	},
	output: text,
	async execute(args) {
		const itemId = itemIdOf(args.item_key)
		if (itemId === null) return `error: no such item "${args.item_key}"`
		setStarred(itemId, args.starred)
		return `${args.starred ? 'starred' : 'unstarred'} ${args.item_key}`
	},
})

export const WRITE_TOOLS = [writeNote, addTags, fixMetadata, starItem]
