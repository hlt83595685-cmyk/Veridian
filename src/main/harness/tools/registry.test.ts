import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, type HarnessTool } from './registry'

const echo: HarnessTool = {
  name: 'echo',
  kind: 'read',
  description: '回显',
  parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
  execute: async (args) => `got:${String(args.v)}`,
}

const boom: HarnessTool = {
  name: 'boom',
  kind: 'read',
  description: '总是抛',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('kaboom')
  },
}

// 直接构造：这些用例考的是注册表自身的行为。走 ctx.plugin() 挂载是异步的，
// 等待它只会把无关的时序引进来。
function svc(): ToolsService {
  return new ToolsService(new Context())
}

describe('ToolsService', () => {
  it('exposes a registered tool in the schema list', () => {
    const t = svc()
    t.register(echo)
    expect(t.schemas().map((x) => x.function.name)).toEqual(['echo'])
  })

  it('runs a tool and returns its result', async () => {
    const t = svc()
    t.register(echo)
    expect(await t.run('echo', '{"v":"hi"}')).toBe('got:hi')
  })

  it('returns an error string for an unknown tool instead of throwing', async () => {
    expect(await svc().run('nope', '{}')).toMatch(/unknown tool/)
  })

  it('returns an error string for malformed arguments instead of throwing', async () => {
    const t = svc()
    t.register(echo)
    expect(await t.run('echo', 'not-json')).toMatch(/invalid arguments/)
  })

  it('turns a throwing tool into an error result, not an escaped exception', async () => {
    const t = svc()
    t.register(boom)
    expect(await t.run('boom', '{}')).toContain('kaboom')
  })

  it('removes the tool when its registration is disposed', () => {
    const t = svc()
    const off = t.register(echo)
    off()
    expect(t.schemas()).toEqual([])
  })
})
