// 这次调用归哪匹马管。
//
// **只此一处**。ceiling、装配遮罩、以及回合装配 schema 时都读它——分散取会出现
// 「按 A 马的清单放行、按 B 马的上限拦截」这种谁也说不清的状态。
//
// 单独成一个模块而不是挂在 plugins.ts 上：turn.ts 也要用它，而回合驱动不该为了
// 一个取值去依赖插件装配模块（测试里那会连带把整个马厩和数据库拖进来）。
import { getKnowledgeDb } from '../knowledge/db'
import { getHorseStore } from './horses'
import type { Horse } from '../../shared/types'

/**
 * 对话绑定的那匹马。
 *
 * 三层退让，每一层都有理由：
 *   1. 对话上记着的那匹 —— 建对话时定下的，之后不随默认马变动。
 *   2. 那匹马被删了（或是加这个字段之前的老对话）→ 退回当前默认马。
 *      删一匹马不该让它跑过的对话彻底不能再回复。
 *   3. 一匹马都没有 → null。调用方（policy）会把这解释成「什么都不许跑」。
 */
export function horseFor(conversationId: number): Horse | null {
	const store = getHorseStore()
	const row = getKnowledgeDb()
		.prepare('SELECT horse_id FROM conversations WHERE id = ?')
		.get(conversationId) as { horse_id: string | null } | undefined
	if (row?.horse_id) {
		const bound = store.get(row.horse_id)
		if (bound) return bound
	}
	return store.getDefault()
}

/** 建新对话时钉下来的那匹。 */
export function horseForNewConversation(): Horse | null {
	return getHorseStore().getDefault()
}
