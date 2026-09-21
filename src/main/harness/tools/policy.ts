// 权限策略：把 ceiling 和用户审批挂到 DSH 的工具管线上。
//
// 管线固定跑五段：
//   tools/pre-execute → guard() → tools/execute → tools/post-execute → tools/result
// 我们占其中两段，分工是明确的：
//
//   guard()            同步、单调。装配面板上那个 ceiling —— 这匹马**根本不许**
//                      碰的东西。拒了就没有后续监听器能翻案，所以它是硬上限。
//   tools/pre-execute  异步 waterfall。用户审批 —— 允许，但要当面点头。回合就
//                      停在这个 await 上，直到用户点了按钮。
//
// 为什么审批不用 DSH 自己的 `{ kind: 'ask' }`：那条路要经过 ApprovalService，
// 而它要求 `exec.agent` 存在（见 dsh-tools 的 serviceAsk）。agent 是 agent-loop
// 那一层的东西，我们这一期没接，所以 ask 一定退化成 deny。自己在 pre-execute
// 里 await 完再返回 allow/deny，效果一样，而且审批 UI 仍然是我们的。
// 等接了 agent 层，这里换成返回 `{ kind: 'ask' }` 即可，审批逻辑不用动。
import type { Context } from '@deepseek-ai/cordis'
import { requestApproval } from '../approvals'
import { kindOf, withinCeiling } from './kinds'
import type { Horse } from '../../../shared/types'

/**
 * callId → conversationId。
 *
 * 管线本身不携带会话身份（DSH 里那是 `exec.agent` 的活儿），但审批卡片必须发到
 * 正确的那个对话窗口去。turn.ts 在 execute 之前登记，结束后注销。
 * 用表而不是「每回合装一个闭包监听器」：多个对话可以同时跑回合，按 callId 索引
 * 天然并发安全，装卸监听器则会互相看见对方的调用。
 */
const origin = new Map<string, number>()

export function noteCallOrigin(callId: string, conversationId: number): void {
	origin.set(callId, conversationId)
}

export function forgetCallOrigin(callId: string): void {
	origin.delete(callId)
}

export interface PolicyDeps {
	/**
	 * 这段对话归哪匹马跑。
	 *
	 * ceiling 和装配清单都从这里读同一个来源：分开取会出现「按 A 马的清单放行、
	 * 按 B 马的上限拦截」这种谁也说不清的状态。
	 */
	horse: (conversationId: number) => Horse | null
}

/**
 * 装上两道闸门。合成一个函数是有意的：它们必须读同一匹马，分开装就迟早会出现
 * 一个拦、另一个放的情况。
 */
export function installPolicy(ctx: Context, deps: PolicyDeps): () => void {
	/**
	 * 一次解析出「该不该拒」和「归谁管」。
	 *
	 * 合成一个函数是为了让 guard 和审批闸门用**同一次**判定：分开各查一遍，迟早
	 * 会出现 guard 按 A 对话放行、审批按 B 对话去问人的情况。
	 */
	type Verdict = { deny: string } | { conversationId: number; horse: Horse }
	const resolve = (name: string, callId: string): Verdict => {
		// 认不出来源就什么都不许跑。这不是保守，是「不知道按谁的规矩办」时唯一
		// 安全的答案——turn.ts 每次派发前都会登记，登记不上说明有人绕过了它。
		const conversationId = origin.get(callId)
		if (conversationId === undefined) return { deny: `"${name}" has no conversation to authorise it` }
		const horse = deps.horse(conversationId)
		if (!horse) return { deny: `"${name}" has no horse to authorise it` }

		// 装配清单：restrict() 已经让模型看不见没装的工具，但那只管可见性，
		// 派发不受它约束（dispatch 按 exec.agent 找 scope，我们没有 agent）。
		// 所以这里必须再拦一道——模型硬点名一个没装的工具是可能的。
		if (!horse.tools.includes(name)) {
			return { deny: `"${name}" is not equipped on ${horse.name}` }
		}

		const kind = kindOf(name)
		if (!withinCeiling(kind, horse.ceiling)) {
			return { deny: `"${name}" needs ${kind}, but this horse is capped at ${horse.ceiling}` }
		}
		return { conversationId, horse }
	}

	// 单调守卫：兜底。它跑在 pre-execute **之后**，且拒了就没人能翻案——
	// 所以哪怕将来有人往 pre-execute 里加了个乱放行的监听器，ceiling 依然成立。
	const offGuard = ctx.tools.guard((exec) => {
		const v = resolve(exec.name, exec.callId)
		return 'deny' in v ? v.deny : undefined
	})

	const offGate = ctx.on('tools/pre-execute', async (exec, next) => {
		const decision = await next()
		// 前面已经拒了就不要再问——问了也只是给用户一个没有意义的按钮。
		if (decision.kind !== 'allow') return decision

		// ceiling 在这里**再查一遍**，不是冗余：guard 跑在这之后，光靠它会先把
		// 审批框弹给用户、再把调用拒掉。用户被问了一个根本不会执行的问题，下次
		// 就更容易闭眼点同意。
		const v = resolve(exec.name, exec.callId)
		if ('deny' in v) return { kind: 'deny', reason: v.deny }

		const kind = kindOf(exec.name)
		if (kind === 'read') return decision

		const args = JSON.stringify(exec.arguments ?? {})
		const verdict = await requestApproval({
			conversationId: v.conversationId,
			tool: exec.name,
			kind,
			summary: exec.name,
			affected: 1,
			changes: [],
			args,
		})
		return verdict === 'deny'
			? { kind: 'deny', reason: `"${exec.name}" was declined by the user` }
			: { kind: 'allow' }
	})

	return () => {
		offGate()
		offGuard()
	}
}
