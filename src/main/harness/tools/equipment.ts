// 把「这匹马装了哪些工具」变成注册表认得的遮罩。
//
// 用 DSH 自己的 `restrict()` 而不是自己过滤 schemas()：它带交集语义（多层遮罩
// 叠加时取交集，而不是后者覆盖前者），dispose 时自动撤销，并且等将来真有 agent
// 了，同一段代码不用重写。
//
// 但它只管**可见性**：`schemas(key)` / `get(name, key)` 会应用遮罩，**派发不会**
// ——dispatch 是按 `exec.agent` 找 scope 的，而 agent 是 agent-loop 那一层的东西。
// 所以拦截靠 policy.ts 里的 guard，和 ceiling 走同一个钩子。两层各司其职：
// restrict 让模型压根看不见，guard 保证就算它硬点名也跑不了。
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Horse } from '../../../shared/types'

interface Entry {
	scope: Scope
	/** 查可见性时传给 schemas() / get() 的那把钥匙。 */
	key: object
	/** 撤销上一次 restrict。**必须**在下一次 restrict 之前调用。 */
	off: () => void
	/** 上次应用的清单，用来判断要不要重来一遍。 */
	applied: string
}

const entries = new Map<string, Entry>()

/**
 * 铸造 scope 的宿主 context。
 *
 * createScope 继承的是**铸造它的那个插件**的依赖 API，拿裸的根 context 会得到
 * 「cannot get property "tools" without inject」。所以由 plugins.ts 在自己的
 * inject:['tools'] 插件里把 ctx 交进来。
 */
let host: Context | null = null

export function setEquipmentHost(ctx: Context): () => void {
	host = ctx
	return () => {
		for (const id of [...entries.keys()]) release(id)
		host = null
	}
}

/**
 * 让这匹马的遮罩与它的装配清单一致，返回查可见性用的 scope key。
 *
 * 每次都先撤销上一次的 restrict 再重新应用：遮罩是**取交集**的，直接叠加会让
 * 可见集合只减不增——改了装配之后新勾的工具永远出不来。
 */
export function scopeFor(horse: Horse): object | null {
	if (!host) return null

	// **必须**先和现有注册表求交集：restrict() 遇到不认识的名字会直接抛
	//   tools.restrict() names unknown global tool "..."
	// 而「插件卸载后保留勾选」是界面上有意支持的行为（卸载常是临时的）。不过滤
	// 的话，一个残留的名字会让**每一个回合**都抛，助手直接不能用。
	const known = new Set(host.tools.schemas().map((s) => s.name))
	const allow = horse.tools.filter((n) => known.has(n))

	const applied = JSON.stringify(allow)
	const existing = entries.get(horse.id)
	if (existing) {
		if (existing.applied === applied) return existing.key
		existing.off()
		existing.off = existing.scope.ctx.tools.restrict({ allow })
		existing.applied = applied
		return existing.key
	}

	const key = { horse: horse.id }
	const scope = createScope(host, key)
	const off = scope.ctx.tools.restrict({ allow })
	entries.set(horse.id, { scope, key, off, applied })
	return key
}

/** 马被删掉时撤掉它的 scope。留着不会出错，只是白占着。 */
export function release(horseId: string): void {
	const e = entries.get(horseId)
	if (!e) return
	entries.delete(horseId)
	e.off()
	void e.scope.dispose()
}

/** 仅供测试。 */
export function _equipmentSize(): number {
	return entries.size
}
