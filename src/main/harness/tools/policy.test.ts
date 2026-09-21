// 策略层跑在**真的** DSH 管线上，不用 stub。
//
// 理由是这一层的全部内容就是「挂对了没有」：guard 是不是单调的、pre-execute
// 拒绝时工具体到底有没有被执行、拒绝是变成 error result 还是抛出去。这些性质
// 都属于管线，自己搭个假管线来测就只是在测那个假货。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '@deepseek-ai/dsh-llm'

const approvals = vi.hoisted(() => ({ verdict: 'allow-once' as string, asked: [] as unknown[] }))
vi.mock('../approvals', () => ({
  requestApproval: async (ask: unknown) => {
    approvals.asked.push(ask)
    return approvals.verdict
  },
}))

import { declareKind, _resetKinds } from './kinds'
import { forgetCallOrigin, installPolicy, noteCallOrigin } from './policy'
import type { Horse, ToolKind } from '../../../shared/types'

/** 记录工具体是否真的跑过——「被拒绝」必须意味着没有发生，而不是发生了但报错。 */
const ran: string[] = []

/** ContentBlock 是联合类型（还能是图片），取文字要先收窄。 */
const textOf = (r: { content?: ReadonlyArray<{ type: string; text?: string }> }): string =>
  (r.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('')

/** 默认全都装上：这些用例要测的是 ceiling 和审批，不是装配。 */
const ALL = ['read_thing', 'edit_library', 'nuke']

function mkHorse(ceiling: ToolKind, tools: string[] = ALL): Horse {
  return {
    id: 'h1', name: 'Groom', skin: 'bay', ceiling, tools,
    isDefault: true, createdAt: 0,
  }
}

async function harness(ceiling: ToolKind, tools: string[] = ALL): Promise<Context> {
  const ctx = new Context()
  ctx.plugin(SystemPrompt, {})
  ctx.plugin(Tools, {})
  for (let i = 0; i < 100 && !ctx.tools; i++) await new Promise((r) => setTimeout(r, 10))

  for (const [name, kind] of [
    ['read_thing', 'read'],
    ['edit_library', 'write-library'],
    ['nuke', 'destructive'],
  ] as Array<[string, ToolKind]>) {
    declareKind(name, kind)
    ctx.tools.register(defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        ran.push(name)
        return 'done'
      },
    }))
  }

  installPolicy(ctx, { horse: () => mkHorse(ceiling, tools) })
  return ctx
}

async function call(
  ctx: Context,
  name: string,
  cid?: number,
): Promise<{ isError: boolean; content?: ReadonlyArray<{ type: string; text?: string }> }> {
  const id = `call-${name}-${Math.random().toString(36).slice(2)}`
  if (cid !== undefined) noteCallOrigin(id, cid)
  try {
    return await ctx.tools.execute({
      callId: CallId(id),
      name,
      arguments: {},
      signal: new AbortController().signal,
    })
  } finally {
    forgetCallOrigin(id)
  }
}

beforeEach(() => {
  ran.length = 0
  approvals.asked.length = 0
  approvals.verdict = 'allow-once'
  _resetKinds()
})

describe('ceiling 闸门', () => {
  it('放行 ceiling 之内的类别', async () => {
    const ctx = await harness('write-library')
    const r = await call(ctx, 'edit_library', 1)
    expect(r.isError).toBe(false)
    expect(ran).toEqual(['edit_library'])
  })

  it('拒绝超出 ceiling 的类别，且工具体一次都没跑', async () => {
    const ctx = await harness('read')
    const r = await call(ctx, 'edit_library', 1)
    expect(r.isError).toBe(true)
    expect(ran).toEqual([])
  })

  it('拒绝是 error result，不是抛出——模型要能读到并改正', async () => {
    const ctx = await harness('read')
    const r = await call(ctx, 'nuke', 1)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('capped at read')
  })

  it('被 ceiling 拒掉的调用不去打扰用户', async () => {
    const ctx = await harness('read')
    await call(ctx, 'nuke', 1)
    expect(approvals.asked).toEqual([])
  })
})

describe('审批闸门', () => {
  it('读工具从不请求审批', async () => {
    const ctx = await harness('destructive')
    const r = await call(ctx, 'read_thing', 1)
    expect(r.isError).toBe(false)
    expect(approvals.asked).toEqual([])
    expect(ran).toEqual(['read_thing'])
  })

  it('写工具要问过，同意后才执行', async () => {
    const ctx = await harness('destructive')
    approvals.verdict = 'allow-once'
    const r = await call(ctx, 'edit_library', 7)
    expect(r.isError).toBe(false)
    expect(ran).toEqual(['edit_library'])
    expect(approvals.asked).toHaveLength(1)
    expect(approvals.asked[0]).toMatchObject({
      conversationId: 7, tool: 'edit_library', kind: 'write-library',
    })
  })

  it('用户拒绝时工具体不跑', async () => {
    const ctx = await harness('destructive')
    approvals.verdict = 'deny'
    const r = await call(ctx, 'edit_library', 7)
    expect(r.isError).toBe(true)
    expect(ran).toEqual([])
  })

  it('认不出来源的写调用直接拒——不知道该问谁时正确答案是不做', async () => {
    const ctx = await harness('destructive')
    const r = await call(ctx, 'edit_library')
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('no conversation')
    expect(approvals.asked).toEqual([])
    expect(ran).toEqual([])
  })
})

describe('装配闸门', () => {
  it('没装的工具跑不了，哪怕 ceiling 允许', async () => {
    const ctx = await harness('destructive', ['read_thing'])
    const r = await call(ctx, 'nuke', 1)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('not equipped')
    expect(ran).toEqual([])
  })

  it('装了的照常跑', async () => {
    const ctx = await harness('destructive', ['read_thing'])
    expect((await call(ctx, 'read_thing', 1)).isError).toBe(false)
    expect(ran).toEqual(['read_thing'])
  })

  it('没装的写工具不去打扰用户——它压根不该被问', async () => {
    const ctx = await harness('destructive', ['read_thing'])
    await call(ctx, 'edit_library', 1)
    expect(approvals.asked).toEqual([])
  })

  it('装配和 ceiling 是两把锁，缺一不可', async () => {
    // 装了但超上限
    const capped = await harness('read', ['nuke'])
    expect(textOf(await call(capped, 'nuke', 1))).toContain('capped at read')
    ran.length = 0
    // 上限够但没装
    const bare = await harness('destructive', [])
    expect(textOf(await call(bare, 'nuke', 1))).toContain('not equipped')
    expect(ran).toEqual([])
  })

  it('认不出是哪匹马就什么都不许跑', async () => {
    const ctx = new Context()
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    for (let i = 0; i < 100 && !ctx.tools; i++) await new Promise((r) => setTimeout(r, 10))
    declareKind('read_thing', 'read')
    ctx.tools.register(defineTool({
      name: 'read_thing', description: 'read_thing', parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() { ran.push('read_thing'); return 'done' },
    }))
    installPolicy(ctx, { horse: () => null })

    const r = await call(ctx, 'read_thing', 1)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('no horse')
    expect(ran).toEqual([])
  })
})

describe('对话绑定到马', () => {
  /** 每段对话归不同的马：policy 必须按调用来源分别判定，不能一刀切。 */
  async function twoHorses(): Promise<Context> {
    const ctx = new Context()
    ctx.plugin(SystemPrompt, {})
    ctx.plugin(Tools, {})
    for (let i = 0; i < 100 && !ctx.tools; i++) await new Promise((r) => setTimeout(r, 10))
    for (const [name, kind] of [['read_thing', 'read'], ['nuke', 'destructive']] as Array<[string, ToolKind]>) {
      declareKind(name, kind)
      ctx.tools.register(defineTool({
        name, description: name, parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        async execute() { ran.push(name); return 'done' },
      }))
    }
    installPolicy(ctx, {
      horse: (cid) =>
        cid === 1 ? mkHorse('destructive', ['read_thing', 'nuke'])
        : cid === 2 ? { ...mkHorse('read', ['read_thing']), id: 'h2', name: 'Scout' }
        : null,
    })
    return ctx
  }

  it('同一个工具，在不同对话里按各自的马判定', async () => {
    const ctx = await twoHorses()
    expect((await call(ctx, 'nuke', 1)).isError).toBe(false)      // 对话 1 的马能删
    expect(ran).toEqual(['nuke'])
    ran.length = 0
    const r = await call(ctx, 'nuke', 2)                           // 对话 2 的马不能
    expect(r.isError).toBe(true)
    expect(ran).toEqual([])
  })

  it('拒绝理由指名道姓，说得出是哪匹马拦的', async () => {
    const ctx = await twoHorses()
    // 对话 2 的马既没装 nuke、上限也不够——先撞上的是装配那道
    expect(textOf(await call(ctx, 'nuke', 2))).toContain('Scout')
  })

  it('认不出对话就什么都不许跑（有人绕过了 turn.ts 的登记）', async () => {
    const ctx = await twoHorses()
    const r = await call(ctx, 'read_thing')  // 不登记来源
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('no conversation')
    expect(ran).toEqual([])
  })

  it('对话存在但查不到马 → 拒，不退回「随便找一匹」', async () => {
    const ctx = await twoHorses()
    const r = await call(ctx, 'read_thing', 99)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('no horse')
    expect(ran).toEqual([])
  })
})
