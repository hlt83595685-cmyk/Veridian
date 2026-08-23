# Harness v2 · 第一条竖线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cordis 容器上打通一条最窄的完整链路——用户 @ 一篇论文并提问，新链路读全文并给出答案——全程不碰现有 `agent.ts`。

**Architecture:** 主进程新建 `src/main/harness/` 目录，与现有 Service/Notifier/JobQueue 并存。会话事件日志是唯一真相源，模型消息由 `deriveMessages()` 从日志投影而来。两道接缝 `ctx.llm` / `ctx.attachment` 复用现有 providers 与附件读取。回合流程发出**现有**渲染层事件，界面不改。设置开关 `knowledge.harnessV2` 决定 `knowledge:ask` 走哪条路。

**Tech Stack:** TypeScript strict、Electron 36、`@deepseek-ai/cordis@4.0.1`、better-sqlite3、vitest。

**Spec:** `docs/superpowers/specs/2026-08-23-harness-v2-vertical-slice.md`

---

## 全局约定（每个任务都适用）

- **缩进：新建的 `src/main/harness/**` 全部用 2 空格。** 这是新目录，不继承 `knowledge/`（tab）或其它历史约定；同一棵树内一致比匹配任一旧惯例更重要。
- TypeScript strict，**禁止 `any`**（用 `unknown`；错误对象用 `as Error`）。
- **绝对不要**运行 `npm rebuild` / `electron-rebuild`——会破坏用户正在运行的 Electron app。
- 本项目 better-sqlite3 按 Electron ABI 构建，普通 node 下不可用，**直接依赖它的测试会被 skip**。因此凡涉及持久化的逻辑，都要把存储放到一个可替换的小接口后面，纯逻辑用内存实现测试（见 Task 3）。
- 已实测的 Cordis API（可直接照用，不要另行摸索）：

```ts
// 事件类型声明合并
declare module '@deepseek-ai/cordis' {
  interface Events {
    'x/plain'(a: string): void                                   // emit
    'x/flow'(a: string, next: () => string): string              // waterfall：next 是最后一个参数
  }
}

// 服务提供者
class Foo extends Service {
  static [Service.provide] = 'foo'
  constructor(ctx: Context) { super(ctx, 'foo') }
}

// 消费者插件
const consumer = { inject: ['foo'], apply(ctx: Context) { /* ctx.foo 可用 */ } }

const root = new Context()
const fiber = root.plugin(Foo)        // fiber.dispose() 会回滚该插件的全部注册
root.plugin(consumer)
ctx.effect(() => () => { /* 卸载时执行 */ })
```

---

### Task 1: 依赖与打包验证（最高风险，必须先做）

cordis 是纯 ESM，本项目是 CommonJS 且主进程用 `externalizeDepsPlugin()` 把依赖排除在打包外。若不处理，运行时 `require()` 纯 ESM 会失败。本任务先把这条路走通，再谈其它。

**Files:**
- Modify: `package.json`
- Modify: `electron.vite.config.ts`
- Create: `src/main/harness/smoke.ts`（临时验证文件，Task 2 结束时删除）

- [ ] **Step 1: 安装依赖**

Run: `npm install @deepseek-ai/cordis@4.0.1`
Expected: 新增 3 个包（含 `@deepseek-ai/cosmokit`、`@standard-schema/spec`），约 457K。

- [ ] **Step 2: 排除出 externalize**

`electron.vite.config.ts` 的 `main` 段：

```ts
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit'] })],
```

- [ ] **Step 3: 写一个最小冒烟点**

创建 `src/main/harness/smoke.ts`：

```ts
// 临时文件：验证 cordis 能在主进程被打包并运行。Task 2 完成后删除。
import { Context } from '@deepseek-ai/cordis'

export function cordisSmoke(): string {
  const ctx = new Context()
  return typeof ctx.plugin === 'function' ? 'cordis-ok' : 'cordis-broken'
}
```

在 `src/main/index.ts` 的 `app.whenReady()` 里，紧接 `initDatabase()` 之后加一行临时日志：

```ts
  console.log('[harness]', (await import('./harness/smoke')).cordisSmoke())
```

- [ ] **Step 4: 构建并实际启动**

Run: `npm run build`
Expected: 构建成功，无 ESM/CJS 报错。

然后**实际启动应用**（`npm run dev` 或运行构建产物），在主进程控制台确认打印 `[harness] cordis-ok`。

**这一步不能用类型检查替代。** 本项目已有先例：typecheck 与测试全过、`npm run build` 才暴露打包层问题。若此处失败，停下来报告，不要绕过。

- [ ] **Step 5: 提交**

```bash
git add package.json package-lock.json electron.vite.config.ts src/main/harness/smoke.ts src/main/index.ts
git commit -m "build(harness): bundle cordis into the main process instead of externalizing it"
```

---

### Task 2: 根 context 与事件类型

**Files:**
- Create: `src/main/harness/events.ts`
- Create: `src/main/harness/boot.ts`
- Modify: `src/main/index.ts`
- Delete: `src/main/harness/smoke.ts`

- [ ] **Step 1: 声明事件类型**

创建 `src/main/harness/events.ts`：

```ts
// 所有 harness 事件在此声明类型与派发模式。
//
// 声明不是文档，是行为前提：未声明类型的事件，waterfall 的参数传递不符合预期
// （监听者收到的首个参数会是 next 而不是实参）。新增事件必须先在此登记。
import type { AttachmentRef, AttachmentResult } from './seams/attachment'

export interface TurnStart { turnId: string; sessionId: number }
export interface TurnEnd { turnId: string; reason: 'done' | 'aborted' | 'error' }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 回合开始。@mode emit */
    'turn/start'(e: TurnStart): void
    /** 回合结束。@mode emit */
    'turn/end'(e: TurnEnd): void
    /** 一次附件解析已完成。@mode emit */
    'attachment/resolved'(ref: AttachmentRef, result: AttachmentResult): void
  }
}
```

- [ ] **Step 2: 建根 context**

创建 `src/main/harness/boot.ts`：

```ts
// harness 的根 context。与现有 Service 层、Notifier、JobQueue 并存，不替换它们。
// 插件在此挂载；每个插件的注册都是可逆效果，卸载即回滚。
import { Context } from '@deepseek-ai/cordis'
import './events'

let root: Context | null = null

export function bootHarness(): Context {
  if (root) return root
  root = new Context()
  return root
}

export function getHarness(): Context {
  if (!root) throw new Error('harness not booted')
  return root
}
```

- [ ] **Step 3: 启动时创建，并删掉冒烟文件**

`src/main/index.ts`：移除 Task 1 加的临时日志行，改为在 `initDatabase()` 之后：

```ts
  bootHarness()
```

顶部加 import；删除 `src/main/harness/smoke.ts`。

- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: 无错误。

Run: `npm run build`
Expected: 成功。

- [ ] **Step 5: 提交**

```bash
git add -A src/main/harness src/main/index.ts
git commit -m "feat(harness): root cordis context and typed event declarations"
```

---

### Task 3: 会话日志与投影

日志是整个架构的真相源。存储放在一个小接口后面：生产用 `knowledge.db`，测试用内存实现——否则测试会因 better-sqlite3 的 ABI 问题被 skip，等于没测。

**Files:**
- Create: `src/main/harness/session/types.ts`
- Create: `src/main/harness/session/memoryStore.ts`
- Create: `src/main/harness/session/sqliteStore.ts`
- Create: `src/main/harness/session/derive.ts`
- Test: `src/main/harness/session/derive.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/harness/session/derive.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { MemorySessionStore } from './memoryStore'
import { deriveMessages, assertProjectionMatches } from './derive'

function store(): MemorySessionStore {
  const s = new MemorySessionStore()
  s.append(1, { kind: 'turn-start', turnId: 't1' })
  return s
}

describe('deriveMessages', () => {
  it('projects a plain question into one user message', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: '什么是对比学习？', refs: [] })
    expect(deriveMessages(s.read(1))).toEqual([
      { role: 'user', content: '什么是对比学习？' },
    ])
  })

  it('appends resolved attachments after the question, not as system messages', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: '这篇讲了什么？', refs: [{ type: 'item', itemKey: 'K1' }] })
    s.append(1, { kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K1' },
      result: { ok: true, itemKey: 'K1', title: 'Paper A', text: 'BODY',
                totalBytes: 4, shownBytes: 4, truncated: false } })
    const msgs = deriveMessages(s.read(1))
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toContain('这篇讲了什么？')
    expect(msgs[0].content).toContain('<paper item_key="K1" title="Paper A" truncated="false">')
    expect(msgs[0].content).toContain('BODY')
  })

  it('states the real reason when an attachment could not be read', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: '看看这篇', refs: [{ type: 'item', itemKey: 'K2' }] })
    s.append(1, { kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K2' },
      result: { ok: false, title: 'Paper B', reason: 'not_converted', detail: 'no markdown attachment' } })
    const content = deriveMessages(s.read(1))[0].content
    expect(content).toContain('error="not_converted"')
    expect(content).not.toContain('no converted markdown text is available')
  })

  it('discloses truncation with real byte counts', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K3' }] })
    s.append(1, { kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K3' },
      result: { ok: true, itemKey: 'K3', title: 'P', text: 'HEAD',
                totalBytes: 62310, shownBytes: 4, truncated: true } })
    const content = deriveMessages(s.read(1))[0].content
    expect(content).toContain('truncated="true"')
    expect(content).toContain('62310')
    expect(content).toContain('4')
  })

  it('keeps a tool call and its result adjacent and in order', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [] })
    s.append(1, { kind: 'tool-call', id: 'c1', name: 'get_item_info', args: '{"item_key":"K1"}' })
    s.append(1, { kind: 'tool-result', id: 'c1', name: 'get_item_info', result: '{"title":"A"}' })
    s.append(1, { kind: 'assistant-message', text: '答案' })
    const msgs = deriveMessages(s.read(1))
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(msgs[1].tool_calls?.[0].id).toBe('c1')
    expect(msgs[2].tool_call_id).toBe('c1')
  })
})

describe('assertProjectionMatches', () => {
  it('passes when the sent messages equal the projection', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [] })
    const msgs = deriveMessages(s.read(1))
    expect(() => assertProjectionMatches(msgs, s.read(1))).not.toThrow()
  })

  it('throws when content was smuggled in outside the log', () => {
    const s = store()
    s.append(1, { kind: 'user-message', text: 'q', refs: [] })
    const smuggled = [...deriveMessages(s.read(1)), { role: 'system' as const, content: '偷偷加的' }]
    expect(() => assertProjectionMatches(smuggled, s.read(1))).toThrow(/not reconstructable/i)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/harness/session/derive.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现类型与内存存储**

创建 `src/main/harness/session/types.ts`：

```ts
import type { AttachmentRef, AttachmentResult } from '../seams/attachment'

export type SessionEvent =
  | { kind: 'turn-start'; turnId: string }
  | { kind: 'turn-end'; turnId: string; reason: 'done' | 'aborted' | 'error' }
  | { kind: 'user-message'; text: string; refs: AttachmentRef[] }
  | { kind: 'attachment-resolved'; ref: AttachmentRef; result: AttachmentResult }
  | { kind: 'assistant-message'; text: string }
  | { kind: 'tool-call'; id: string; name: string; args: string }
  | { kind: 'tool-result'; id: string; name: string; result: string }

/** 存储放在接口后面，纯逻辑才能脱离 better-sqlite3 测试。 */
export interface SessionStore {
  append(sessionId: number, event: SessionEvent): void
  read(sessionId: number): SessionEvent[]
}

// 复用现有类型，不重新声明——重复声明必然漂移。
// 注意 content 是 string | null：带 tool_calls 的 assistant 消息按 OpenAI 约定为 null。
export type { ChatMessage, ToolCall } from '../../knowledge/providers'
```

创建 `src/main/harness/session/memoryStore.ts`：

```ts
import type { SessionEvent, SessionStore } from './types'

export class MemorySessionStore implements SessionStore {
  private readonly rows = new Map<number, SessionEvent[]>()
  append(sessionId: number, event: SessionEvent): void {
    const list = this.rows.get(sessionId) ?? []
    list.push(event)
    this.rows.set(sessionId, list)
  }
  read(sessionId: number): SessionEvent[] {
    return [...(this.rows.get(sessionId) ?? [])]
  }
}
```

- [ ] **Step 4: 实现投影与不变量**

创建 `src/main/harness/session/derive.ts`：

```ts
// 模型消息只能由此投影产生。任何旁路拼接都会被 assertProjectionMatches 抓住。
//
// 「模型可见即已记录」：进入模型请求的每一段内容都必须能从日志重建。这条不变量
// 让「这轮到底发了什么」永远可回放，上下文检查器是它的免费副产品。
import type { AttachmentResult, AttachmentRef } from '../seams/attachment'
import type { ChatMessage, SessionEvent } from './types'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** 把一次附件解析渲染成自描述块。失败时把真实原因放在内容本该出现的位置。 */
export function renderAttachment(ref: AttachmentRef, r: AttachmentResult): string {
  const key = ref.type === 'item' ? ref.itemKey : ref.path
  if (!r.ok) {
    const hint = r.reason === 'not_converted'
      ? '这篇尚未转换为 Markdown，无法读取正文。可以先对它执行 PDF 转换。'
      : r.reason === 'permission_denied'
        ? '该文件不在允许访问的范围内。'
        : r.reason === 'not_found'
          ? '找不到这个条目。'
          : r.detail
    return `<paper item_key="${esc(key)}" title="${esc(r.title ?? key)}" error="${r.reason}">\n${hint}\n</paper>`
  }
  const head = `<paper item_key="${esc(key)}" title="${esc(r.title)}" truncated="${r.truncated}"` +
    (r.truncated ? ` total_bytes="${r.totalBytes}" shown_bytes="${r.shownBytes}"` : '') + '>'
  const tail = r.truncated
    ? `\n\n[内容因预算截断：原文 ${r.totalBytes} 字节，此处显示 ${r.shownBytes} 字节。需要其余部分可再次询问具体章节。]`
    : ''
  return `${head}\n${r.text}${tail}\n</paper>`
}

export function deriveMessages(events: SessionEvent[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pendingUser: { text: string; blocks: string[] } | null = null

  const flush = (): void => {
    if (!pendingUser) return
    const content = [pendingUser.text, ...pendingUser.blocks].join('\n\n')
    out.push({ role: 'user', content })
    pendingUser = null
  }

  for (const e of events) {
    switch (e.kind) {
      case 'user-message':
        flush()
        pendingUser = { text: e.text, blocks: [] }
        break
      case 'attachment-resolved':
        if (pendingUser) pendingUser.blocks.push(renderAttachment(e.ref, e.result))
        break
      case 'tool-call':
        flush()
        out.push({ role: 'assistant', content: null,
          tool_calls: [{ id: e.id, type: 'function', function: { name: e.name, arguments: e.args } }] })
        break
      case 'tool-result':
        flush()
        out.push({ role: 'tool', content: e.result, tool_call_id: e.id })
        break
      case 'assistant-message':
        flush()
        out.push({ role: 'assistant', content: e.text })
        break
      default:
        break   // turn-start / turn-end 不进模型视图
    }
  }
  flush()
  return out
}

/** 开发期不变量：发出去的消息必须与投影逐条一致。 */
export function assertProjectionMatches(sent: ChatMessage[], events: SessionEvent[]): void {
  const projected = deriveMessages(events)
  const strip = (m: ChatMessage[]): string => JSON.stringify(m.filter((x) => x.role !== 'system'))
  if (strip(sent) !== strip(projected)) {
    throw new Error('harness invariant violated: sent messages are not reconstructable from the session log')
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/main/harness/session/derive.test.ts`
Expected: PASS，7 tests passed。**纯逻辑，必须真跑，不允许 skip。**

- [ ] **Step 6: 实现 SQLite 存储**

创建 `src/main/harness/session/sqliteStore.ts`：

```ts
// 生产存储：追加到 knowledge.db。表是只追加的，没有 UPDATE 路径。
import { getKnowledgeDb } from '../../knowledge/db'
import type { SessionEvent, SessionStore } from './types'

export function ensureSessionEventTable(): void {
  getKnowledgeDb().exec(`
    CREATE TABLE IF NOT EXISTS harness_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_harness_events_session ON harness_events(session_id, id);
  `)
}

export class SqliteSessionStore implements SessionStore {
  append(sessionId: number, event: SessionEvent): void {
    getKnowledgeDb()
      .prepare('INSERT INTO harness_events (session_id, payload) VALUES (?, ?)')
      .run(sessionId, JSON.stringify(event))
  }
  read(sessionId: number): SessionEvent[] {
    const rows = getKnowledgeDb()
      .prepare('SELECT payload FROM harness_events WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ payload: string }>
    return rows.map((r) => JSON.parse(r.payload) as SessionEvent)
  }
}
```

- [ ] **Step 7: 用 node:sqlite 验证真实存储**

better-sqlite3 在普通 node 下不可用，但 Node 24 自带 `node:sqlite`，可对真实建表与读写做一次执行验证。写一个临时测试文件，`vi.mock` 掉 `../../knowledge/db` 的 `getKnowledgeDb` 返回 node:sqlite 的 shim（`{ prepare, exec }`，用 `DatabaseSync`），断言：追加三条事件后按 id 顺序读回，内容与追加时一致。

**验证完删除该临时文件，并确认 `git status` 干净。**

- [ ] **Step 8: 提交**

```bash
git add src/main/harness/session
git commit -m "feat(harness): append-only session log with deriveMessages projection and invariant"
```

---

### Task 4: `ctx.llm` 接缝

**Files:**
- Create: `src/main/harness/seams/llm.ts`

- [ ] **Step 1: 定义接口与提供者**

创建 `src/main/harness/seams/llm.ts`：

```ts
// 模型接缝：定义 + 提供者。换模型只换提供者，回合流程不动。
import { Service, type Context } from '@deepseek-ai/cordis'
import { getChatConfig, chatStream } from '../../knowledge/providers'
import type { ChatMessage } from '../session/types'

export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmRequest { messages: ChatMessage[]; tools: ToolSchema[] }

export interface LlmResult {
  text: string
  toolCalls: Array<{ id: string; name: string; args: string }>
}

export class LlmService extends Service {
  static [Service.provide] = 'llm'
  constructor(ctx: Context) { super(ctx, 'llm') }

  /**
   * 回调式而非 AsyncIterable：底层 chatStream 就是「onDelta 回调 + await 结果」，
   * 包成迭代器要么丢流式（先收集再吐出），要么额外搭一层队列桥接。第一条竖线选诚实
   * 且简单的形状；真需要拉取式迭代再另说。
   */
  async stream(req: LlmRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<LlmResult> {
    const cfg = getChatConfig()
    if (!cfg) throw new Error('chat model is not configured')
    const r = await chatStream(cfg, req.messages, req.tools, onText, signal)
    return {
      text: r.content,
      toolCalls: r.toolCalls.map((t) => ({ id: t.id, name: t.function.name, args: t.function.arguments })),
    }
  }
}
```

已核实的现有签名（照用，不要改 `providers.ts`）：

```ts
chatStream(cfg, messages: ChatMessage[], tools: ToolDef[],
           onDelta: (text: string) => void, signal: AbortSignal): Promise<ChatResult>
```

- [ ] **Step 2: 验证**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add src/main/harness/seams/llm.ts
git commit -m "feat(harness): llm seam wrapping the existing provider layer"
```

---

### Task 5: `ctx.attachment` 接缝（本期兑现的痛点）

现状的三个坑一次修掉：8000 字符硬上限、失败被 `catch` 吞掉后谎称「没有转换文本」、失败无分类。

**Files:**
- Create: `src/main/harness/seams/attachment.ts`
- Test: `src/main/harness/seams/attachment.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/harness/seams/attachment.test.ts`，用注入的假依赖覆盖四类结果（**不碰数据库**）：

```ts
import { describe, it, expect } from 'vitest'
import { makeAttachmentResolver } from './attachment'

const deps = {
  findItem: (key: string) => key === 'K1' ? { id: 1, title: 'Paper A' }
    : key === 'K2' ? { id: 2, title: 'Paper B' } : null,
  findMarkdownPath: (itemId: number) => itemId === 1 ? 'C:/lib/Full.md' : null,
  assertReadable: (p: string) => { if (p.includes('outside')) throw new Error('Access denied'); return p },
  readText: (p: string) => p === 'C:/lib/Full.md' ? 'A'.repeat(50000) : (() => { throw new Error('EIO') })(),
}

describe('attachment resolver', () => {
  it('reads the whole markdown, no arbitrary cap', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'item', itemKey: 'K1' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text.length).toBe(50000)     // 旧实现会截到 8000
      expect(r.truncated).toBe(false)
      expect(r.totalBytes).toBe(50000)
    }
  })

  it('reports not_converted when the item has no markdown', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'item', itemKey: 'K2' })
    expect(r).toMatchObject({ ok: false, reason: 'not_converted', title: 'Paper B' })
  })

  it('reports not_found for an unknown item', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'item', itemKey: 'ZZ' })
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('reports permission_denied instead of pretending there is no text', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'file', path: 'C:/outside/x.md' })
    expect(r).toMatchObject({ ok: false, reason: 'permission_denied' })
    if (!r.ok) expect(r.detail).toContain('Access denied')
  })

  it('reports unreadable with the real error text', async () => {
    const r = await makeAttachmentResolver(deps).resolve({ type: 'file', path: 'C:/lib/broken.md' })
    expect(r).toMatchObject({ ok: false, reason: 'unreadable' })
    if (!r.ok) expect(r.detail).toContain('EIO')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/harness/seams/attachment.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

创建 `src/main/harness/seams/attachment.ts`：

```ts
// 附件接缝：把 @ 引用解析成内容。
//
// 三条规矩，全部来自旧实现的教训：
//   1. 读全文，不设武断上限（旧实现截到 8000 字符，论文 30–80KB，只覆盖约 15%）；
//      放不下由装配器按预算截断，并如实标注。
//   2. 失败绝不静默。旧实现把异常 catch 掉后告诉模型「没有转换文本」——那句谎正是
//      在训练模型放弃 @ 而去检索全库。
//   3. 失败必须分类，让模型能给出正确的下一步。
import { Service, type Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'fs'
import { getDb } from '../../db'
import { assertReadable } from '../../security/pathGuard'

export type AttachmentRef =
  | { type: 'item'; itemKey: string }
  | { type: 'file'; path: string }

export type AttachmentResult =
  | { ok: true; itemKey?: string; title: string; text: string
      totalBytes: number; shownBytes: number; truncated: boolean }
  | { ok: false; title?: string
      reason: 'not_found' | 'not_converted' | 'permission_denied' | 'unreadable'
      detail: string }

export interface AttachmentDeps {
  findItem(key: string): { id: number; title: string | null } | null
  findMarkdownPath(itemId: number): string | null
  assertReadable(p: string): string
  readText(p: string): string
}

export function makeAttachmentResolver(deps: AttachmentDeps) {
  return {
    async resolve(ref: AttachmentRef): Promise<AttachmentResult> {
      let path: string
      let title: string
      if (ref.type === 'item') {
        const item = deps.findItem(ref.itemKey)
        if (!item) return { ok: false, reason: 'not_found', detail: `no item with key ${ref.itemKey}` }
        title = item.title ?? ref.itemKey
        const md = deps.findMarkdownPath(item.id)
        if (!md) return { ok: false, title, reason: 'not_converted', detail: 'no markdown attachment' }
        path = md
      } else {
        path = ref.path
        title = path
      }

      let real: string
      try { real = deps.assertReadable(path) }
      catch (err) { return { ok: false, title, reason: 'permission_denied', detail: (err as Error).message } }

      try {
        const text = deps.readText(real)
        return { ok: true, itemKey: ref.type === 'item' ? ref.itemKey : undefined,
          title, text, totalBytes: text.length, shownBytes: text.length, truncated: false }
      } catch (err) {
        return { ok: false, title, reason: 'unreadable', detail: (err as Error).message }
      }
    },
  }
}

/** 生产依赖：读库与真实文件系统。 */
export const productionDeps: AttachmentDeps = {
  findItem: (key) => (getDb().prepare('SELECT id, title FROM items WHERE key = ? AND deleted = 0')
    .get(key) as { id: number; title: string | null } | undefined) ?? null,
  findMarkdownPath: (itemId) => (getDb().prepare(
    "SELECT path FROM attachments WHERE item_id = ? AND type = 'markdown' AND path IS NOT NULL LIMIT 1"
  ).get(itemId) as { path: string } | undefined)?.path ?? null,
  assertReadable,
  readText: (p) => readFileSync(p, 'utf-8'),
}

export class AttachmentService extends Service {
  static [Service.provide] = 'attachment'
  private readonly impl = makeAttachmentResolver(productionDeps)
  constructor(ctx: Context) { super(ctx, 'attachment') }
  resolve(ref: AttachmentRef): Promise<AttachmentResult> { return this.impl.resolve(ref) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/harness/seams/attachment.test.ts`
Expected: PASS，5 tests passed。**纯逻辑，必须真跑。**

- [ ] **Step 5: 提交**

```bash
git add src/main/harness/seams/attachment.ts src/main/harness/seams/attachment.test.ts
git commit -m "feat(harness): attachment seam reads full text and never lies about failures"
```

---

### Task 6: 上下文装配与预算

**Files:**
- Create: `src/main/harness/assemble.ts`
- Test: `src/main/harness/assemble.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/harness/assemble.test.ts`，覆盖三条优先级规则：

```ts
import { describe, it, expect } from 'vitest'
import { assemble } from './assemble'
import type { SessionEvent } from './session/types'

const SYS = 'SYSTEM'
const budget = { contextWindow: 1000, reserveForOutput: 100 }   // 近似单位：字符/4

function withHistory(n: number): SessionEvent[] {
  const out: SessionEvent[] = []
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'user-message', text: `Q${i} ${'x'.repeat(200)}`, refs: [] })
    out.push({ kind: 'assistant-message', text: `A${i}` })
  }
  return out
}

describe('assemble', () => {
  it('never evicts the system prompt or tool schemas', () => {
    const r = assemble({ events: withHistory(30), systemPrompt: SYS, tools: [], budget })
    expect(r.messages[0]).toEqual({ role: 'system', content: SYS })
  })

  it('drops the oldest history first', () => {
    const r = assemble({ events: withHistory(30), systemPrompt: SYS, tools: [], budget })
    const body = r.messages.map((m) => m.content).join('\n')
    expect(body).not.toContain('Q0 ')
    expect(body).toContain('Q29 ')
  })

  it('keeps the attachment even when history must go', () => {
    const events: SessionEvent[] = [
      ...withHistory(30),
      { kind: 'user-message', text: '这篇讲了什么？', refs: [{ type: 'item', itemKey: 'K1' }] },
      { kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K1' },
        result: { ok: true, itemKey: 'K1', title: 'P', text: 'IMPORTANT-BODY',
                  totalBytes: 14, shownBytes: 14, truncated: false } },
    ]
    const r = assemble({ events, systemPrompt: SYS, tools: [], budget })
    expect(r.messages.map((m) => m.content).join('\n')).toContain('IMPORTANT-BODY')
  })

  it('truncates an oversized attachment and says so with real numbers', () => {
    const big = 'B'.repeat(20000)
    const events: SessionEvent[] = [
      { kind: 'user-message', text: 'q', refs: [{ type: 'item', itemKey: 'K1' }] },
      { kind: 'attachment-resolved', ref: { type: 'item', itemKey: 'K1' },
        result: { ok: true, itemKey: 'K1', title: 'P', text: big,
                  totalBytes: big.length, shownBytes: big.length, truncated: false } },
    ]
    const r = assemble({ events, systemPrompt: SYS, tools: [], budget })
    const body = r.messages.map((m) => m.content).join('\n')
    expect(body).toContain('truncated="true"')
    expect(body).toContain(String(big.length))
    expect(body.length).toBeLessThan(big.length)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/harness/assemble.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

创建 `src/main/harness/assemble.ts`：

```ts
// 上下文装配：统一掌管 token 预算。
//
// 优先级（高→低），超预算时从低的开始削减：
//   1. 系统提示 + 工具 schema —— 固定开销，永不参与淘汰
//   2. 本轮附件 —— 放不下则截断最大的一个，并如实标注
//   3. 历史消息 —— 从最旧开始丢弃
//
// token 用字符数近似（chars/4）。近似值只用于取舍，不对用户展示；精确计数留到
// 接入用量遥测时。
import { deriveMessages } from './session/derive'
import type { ChatMessage, SessionEvent } from './session/types'
import type { ToolSchema } from './seams/llm'

export interface AssembleInput {
  events: SessionEvent[]
  systemPrompt: string
  tools: ToolSchema[]
  budget: { contextWindow: number; reserveForOutput: number }
}

export interface AssembleOutput {
  messages: ChatMessage[]
  /** 供上下文检查器与遥测使用；本期不展示。 */
  report: { fixedTokens: number; usedTokens: number; droppedTurns: number; truncatedAttachments: number }
}

const tok = (s: string | null): number => Math.ceil((s?.length ?? 0) / 4)

export function assemble(input: AssembleInput): AssembleOutput {
  const { events, systemPrompt, tools, budget } = input
  const fixed = tok(systemPrompt) + tok(JSON.stringify(tools))
  const room = budget.contextWindow - budget.reserveForOutput - fixed

  // 附件先按预算裁剪，改写事件流，再投影——这样截断标注自然进入最终文本。
  let truncatedAttachments = 0
  const attachmentBudget = Math.max(0, Math.floor(room * 0.7))
  let attachmentUsed = 0
  const adjusted: SessionEvent[] = events.map((e) => {
    if (e.kind !== 'attachment-resolved' || !e.result.ok) return e
    const allowChars = Math.max(0, (attachmentBudget - attachmentUsed) * 4)
    if (e.result.text.length <= allowChars) {
      attachmentUsed += tok(e.result.text)
      return e
    }
    truncatedAttachments++
    const cut = e.result.text.slice(0, allowChars)
    attachmentUsed += tok(cut)
    return { ...e, result: { ...e.result, text: cut, shownBytes: cut.length, truncated: true } }
  })

  const projected = deriveMessages(adjusted)

  // 历史从最旧丢弃，最后一条用户消息永远保留。
  let droppedTurns = 0
  const kept = [...projected]
  const used = (): number => kept.reduce((n, m) => n + tok(m.content), 0)
  while (kept.length > 1 && used() > room) {
    kept.shift()
    droppedTurns++
  }

  return {
    messages: [{ role: 'system', content: systemPrompt }, ...kept],
    report: { fixedTokens: fixed, usedTokens: fixed + used(), droppedTurns, truncatedAttachments },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/harness/assemble.test.ts`
Expected: PASS，4 tests passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/harness/assemble.ts src/main/harness/assemble.test.ts
git commit -m "feat(harness): context assembly with an explicit budget"
```

---

### Task 7: 工具通路

只注册一个只读工具，目的是验证「注册 → schema 进提示词 → 模型调用 → 执行 → 结果回灌」整条通路。

**Files:**
- Create: `src/main/harness/tools/registry.ts`
- Create: `src/main/harness/tools/getItemInfo.ts`
- Test: `src/main/harness/tools/registry.test.ts`

- [ ] **Step 1: 实现注册表**

创建 `src/main/harness/tools/registry.ts`：

```ts
// 工具注册表。kind 现在只用到 read；写工具的审批与门控是后续任务，
// 但字段现在就留出来，避免届时改动每一个工具的定义。
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '../seams/llm'

export type ToolKind = 'read' | 'write-library' | 'write-fs' | 'destructive'

export interface HarnessTool {
  name: string
  kind: ToolKind
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

export class ToolsService extends Service {
  static [Service.provide] = 'tools'
  private readonly reg = new Map<string, HarnessTool>()
  constructor(ctx: Context) { super(ctx, 'tools') }

  register(tool: HarnessTool): () => void {
    this.reg.set(tool.name, tool)
    return () => { this.reg.delete(tool.name) }
  }

  schemas(): ToolSchema[] {
    return [...this.reg.values()].map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  async run(name: string, argsJson: string): Promise<string> {
    const tool = this.reg.get(name)
    if (!tool) return `error: unknown tool "${name}"`
    let args: Record<string, unknown>
    try { args = JSON.parse(argsJson || '{}') as Record<string, unknown> }
    catch { return 'error: invalid arguments' }
    try { return await tool.execute(args) }
    catch (err) { return `error: ${(err as Error).message}` }
  }
}
```

- [ ] **Step 2: 实现唯一工具**

创建 `src/main/harness/tools/getItemInfo.ts`：

```ts
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
    const item = getDb().prepare(
      'SELECT id, title, year, journal, doi FROM items WHERE key = ? AND deleted = 0'
    ).get(key) as { id: number; title: string | null; year: number | null; journal: string | null; doi: string | null } | undefined
    if (!item) return 'not found'
    const creators = getDb().prepare(`
      SELECT c.last_name, c.first_name FROM creators c
      JOIN item_creators ic ON ic.creator_id = c.id
      WHERE ic.item_id = ? ORDER BY ic.position LIMIT 10
    `).all(item.id) as Array<{ last_name: string; first_name: string | null }>
    return JSON.stringify({
      title: item.title, year: item.year, journal: item.journal, doi: item.doi,
      authors: creators.map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ')),
    })
  },
}
```

- [ ] **Step 3: 写注册表测试**

创建 `src/main/harness/tools/registry.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService, type HarnessTool } from './registry'

const echo: HarnessTool = {
  name: 'echo', kind: 'read', description: '回显',
  parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
  execute: async (args) => `got:${String(args.v)}`,
}
const boom: HarnessTool = {
  name: 'boom', kind: 'read', description: '总是抛',
  parameters: { type: 'object', properties: {} },
  execute: async () => { throw new Error('kaboom') },
}

function svc(): ToolsService {
  const ctx = new Context()
  ctx.plugin(ToolsService)
  return ctx.tools as ToolsService
}

describe('ToolsService', () => {
  it('exposes a registered tool in the schema list', () => {
    const t = svc(); t.register(echo)
    expect(t.schemas().map((x) => x.function.name)).toEqual(['echo'])
  })

  it('runs a tool and returns its result', async () => {
    const t = svc(); t.register(echo)
    expect(await t.run('echo', '{"v":"hi"}')).toBe('got:hi')
  })

  it('returns an error string for an unknown tool instead of throwing', async () => {
    expect(await svc().run('nope', '{}')).toMatch(/unknown tool/)
  })

  it('returns an error string for malformed arguments instead of throwing', async () => {
    const t = svc(); t.register(echo)
    expect(await t.run('echo', 'not-json')).toMatch(/invalid arguments/)
  })

  it('turns a throwing tool into an error result, not an escaped exception', async () => {
    const t = svc(); t.register(boom)
    expect(await t.run('boom', '{}')).toContain('kaboom')
  })

  it('removes the tool when its registration is disposed', () => {
    const t = svc()
    const off = t.register(echo)
    off()
    expect(t.schemas()).toEqual([])
  })
})
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/main/harness/tools/registry.test.ts`
Expected: PASS，5 tests passed。

- [ ] **Step 5: 提交**

```bash
git add src/main/harness/tools
git commit -m "feat(harness): tool registry with a kind field and one read-only tool"
```

---

### Task 8: 回合驱动

**Files:**
- Create: `src/main/harness/turn.ts`
- Create: `src/main/harness/plugins.ts`
- Modify: `src/main/harness/boot.ts`

- [ ] **Step 1: 实现回合**

创建 `src/main/harness/turn.ts`，骨架如下：

```ts
import { randomUUID } from 'crypto'
import { emit } from '../core/Notifier'
import { assemble } from './assemble'
import { assertProjectionMatches } from './session/derive'
import type { SessionStore } from './session/types'
import type { AttachmentRef } from './seams/attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { RetrievalStep } from '../../shared/types'

const MAX_ROUNDS = 8

export async function runTurn(ctx: Context, store: SessionStore, opts: {
  conversationId: number; question: string; refs: AttachmentRef[]
  systemPrompt: string; signal: AbortSignal
}): Promise<void> {
  const cid = opts.conversationId
  const turnId = randomUUID()
  ctx.emit('turn/start', { turnId, sessionId: cid })
  store.append(cid, { kind: 'turn-start', turnId })
  store.append(cid, { kind: 'user-message', text: opts.question, refs: opts.refs })

  // 附件逐个解析并入日志——模型可见即已记录
  for (const ref of opts.refs) {
    const result = await ctx.attachment.resolve(ref)
    store.append(cid, { kind: 'attachment-resolved', ref, result })
    ctx.emit('attachment/resolved', ref, result)
  }

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      emit({ type: 'knowledge.chatState', conversationId: cid,
             state: round === 0 ? 'searching' : 'answering' })

      const events = store.read(cid)
      const tools = ctx.tools.schemas()
      const { messages } = assemble({ events, systemPrompt: opts.systemPrompt, tools, budget })
      assertProjectionMatches(messages.filter((m) => m.role !== 'system'), events)

      const r = await ctx.llm.stream({ messages, tools },
        (delta) => emit({ type: 'knowledge.chatDelta', conversationId: cid, delta }), opts.signal)

      if (!r.toolCalls.length) {
        store.append(cid, { kind: 'assistant-message', text: r.text })
        break
      }
      // 本轮只是在调工具，流出来的是思考片段，从答案气泡里清掉
      emit({ type: 'knowledge.chatReset', conversationId: cid })
      for (const tc of r.toolCalls) {
        store.append(cid, { kind: 'tool-call', id: tc.id, name: tc.name, args: tc.args })
        const out = await ctx.tools.run(tc.name, tc.args)
        store.append(cid, { kind: 'tool-result', id: tc.id, name: tc.name, result: out })
        const step: RetrievalStep = { tool: 'get_item_info', label: tc.name }
        emit({ type: 'knowledge.step', conversationId: cid, step })
      }
    }
    store.append(cid, { kind: 'turn-end', turnId, reason: 'done' })
    ctx.emit('turn/end', { turnId, reason: 'done' })
    emit({ type: 'knowledge.chatState', conversationId: cid, state: 'done' })
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    store.append(cid, { kind: 'turn-end', turnId, reason: aborted ? 'aborted' : 'error' })
    ctx.emit('turn/end', { turnId, reason: aborted ? 'aborted' : 'error' })
    emit({ type: 'knowledge.chatState', conversationId: cid,
           state: aborted ? 'done' : 'error', detail: (err as Error).message })
  }
}
```

`budget` 从设置读取模型上下文窗口（无配置时取保守默认，例如 `{ contextWindow: 128000, reserveForOutput: 4000 }`）。

**渲染层约束（本会话踩过的坑，务必遵守）**：`knowledge.step` 的 `step.tool` 是
`RetrievalStep['tool']` 联合类型，而渲染层 `RetrievalTrace.tsx` 的 `ICON_PATHS` 是
**穷举式** `Record<RetrievalStep['tool'], string[]>`。本期只使用**已在该联合类型里的**
名字（`get_item_info` 在）。若将来新增工具名，必须同时补 `ICON_PATHS` 与 i18n 的
`doing.*` 文案，否则 `tsc -p tsconfig.web.json` 失败且运行时崩溃。

其余要点：

- 追加 `user-message` 与逐个 `attachment-resolved` 到日志
- `assemble()` 得到消息与报告
- 调用 `assertProjectionMatches(messages.filter(role!=='system'), events)`——不变量
- 循环最多 8 轮：`ctx.llm.stream` → 文本增量发 `knowledge.chatDelta`；工具调用则 `ctx.tools.run` 并把 `tool-call`/`tool-result` 追加进日志后继续下一轮
- 无工具调用时追加 `assistant-message`，结束
- 发出**现有的**渲染层事件，保持界面不改：
  - 开始/工具中：`emit({ type: 'knowledge.chatState', conversationId, state: 'searching' | 'answering', detail })`
  - 文本增量：`emit({ type: 'knowledge.chatDelta', conversationId, delta })`
  - 每次工具调用后：`emit({ type: 'knowledge.step', conversationId, step })`
  - 结束：`state: 'done'`；异常：`state: 'error'`
- 中断沿用现有 `AbortController` 模式

**注意**：渲染层事件的类型定义在 `src/shared/events.ts`，**照用不改**。若某个字段对不上，按现有定义调整调用方，不要改共享类型。

- [ ] **Step 2: 组装插件树**

创建 `src/main/harness/plugins.ts`：把 `LlmService`、`AttachmentService`、`ToolsService` 挂到根 context，并注册 `getItemInfo`（用 `ctx.effect` 注册，保证卸载可回滚）。

修改 `boot.ts`，在建根 context 后挂载这些插件，并调用 `ensureSessionEventTable()`。

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 无错误。

Run: `npm run build`
Expected: 成功。

- [ ] **Step 4: 提交**

```bash
git add src/main/harness
git commit -m "feat(harness): turn driver emitting the existing renderer events"
```

---

### Task 9: 开关路由与端到端测试

**Files:**
- Modify: `src/main/ipc/handlers.ts`
- Modify: 设置项定义处（与 `knowledge.search.*` 同一处）
- Test: `src/main/harness/turn.e2e.test.ts`

- [ ] **Step 1: 加开关并路由**

新增设置项 `knowledge.harnessV2`（布尔，初始 `false`）。`knowledge:ask` 处理器读取它：为真走新回合，否则走现有 `agent.ask`。

**旧路径一行不改。**

- [ ] **Step 2: 写端到端测试**

创建 `src/main/harness/turn.e2e.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

const emitted: Array<Record<string, unknown>> = []
vi.mock('../core/Notifier', () => ({ emit: (e: Record<string, unknown>) => { emitted.push(e) } }))

import { runTurn } from './turn'
import { MemorySessionStore } from './session/memoryStore'
import { deriveMessages } from './session/derive'

/** 第一轮要求调工具，第二轮给出答案——覆盖完整的工具往返。 */
function fakeLlm() {
  let round = 0
  return {
    async stream(_req: unknown, onText: (d: string) => void) {
      round++
      if (round === 1) {
        onText('让我查一下…')
        return { text: '让我查一下…', toolCalls: [{ id: 'c1', name: 'get_item_info', args: '{"item_key":"K1"}' }] }
      }
      onText('答案是 42。')
      return { text: '答案是 42。', toolCalls: [] }
    },
  }
}

describe('runTurn 端到端', () => {
  it('走完一次带工具往返的回合，日志与投影一致', async () => {
    emitted.length = 0
    const ctx = new Context()
    const bag = ctx as unknown as Record<string, unknown>
    bag.llm = fakeLlm()
    bag.attachment = {
      resolve: async () => ({ ok: true, itemKey: 'K1', title: 'Paper A', text: 'FULL-BODY',
                              totalBytes: 9, shownBytes: 9, truncated: false }),
    }
    bag.tools = { schemas: () => [], run: async () => '{"title":"Paper A"}' }

    const store = new MemorySessionStore()
    await runTurn(ctx, store, {
      conversationId: 1, question: '这篇讲了什么？',
      refs: [{ type: 'item', itemKey: 'K1' }],
      systemPrompt: 'SYS', signal: new AbortController().signal,
    })

    const events = store.read(1)
    expect(events.map((e) => e.kind)).toEqual([
      'turn-start', 'user-message', 'attachment-resolved',
      'tool-call', 'tool-result', 'assistant-message', 'turn-end',
    ])

    // 附件进的是用户消息，不是 system 消息
    const msgs = deriveMessages(events)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toContain('FULL-BODY')
    expect(msgs.some((m) => m.role === 'system')).toBe(false)

    // 工具调用与结果成对且顺序正确
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(msgs[1].tool_calls?.[0].id).toBe('c1')
    expect(msgs[2].tool_call_id).toBe('c1')

    // 渲染层事件序列
    const types = emitted.map((e) => e.type)
    expect(types[0]).toBe('knowledge.chatState')
    expect(types).toContain('knowledge.chatDelta')
    expect(types).toContain('knowledge.step')
    expect(emitted[emitted.length - 1]).toMatchObject({ type: 'knowledge.chatState', state: 'done' })
  })
})
```

若 `runTurn` 的实际参数形状与此不符，**调整测试去匹配实现**，但上述六条断言的语义必须保留。

**这是第 29 条的回归基线**，后续所有改动都要保持它绿。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run src/main/harness/turn.e2e.test.ts`
Expected: PASS。

Run: `npm test`
Expected: 全部通过，既有测试无回归。

- [ ] **Step 4: 提交**

```bash
git add -A src/main/harness src/main/ipc/handlers.ts
git commit -m "feat(harness): route knowledge:ask through the flag and add the e2e baseline"
```

---

### Task 10: 真机冒烟

代码全绿不等于能用。本项目已有先例：typecheck 与测试全过、真实数据空转才照出三个丢数据的 bug。

- [ ] **Step 1: 构建并启动**

Run: `npm run build`，然后实际启动应用。

- [ ] **Step 2: 打开开关，逐条验收**

在设置里把 `knowledge.harnessV2` 打开，然后：

1. @ 一篇**已转换**的论文，问它**结论或讨论部分**的内容 → 应答得出来（旧实现只覆盖开头约 15%，答不出）。
2. @ 一篇**未转换**的论文 → 应明确说「尚未转换为 Markdown，可以先执行转换」，而非「找不到」。
3. @ 一个**库外**文件 → 应明确说不在允许范围内。
4. 关掉开关，问同样的问题 → 旧行为不变。

- [ ] **Step 3: 记录结果**

把四条的实际输出记进 `docs/superpowers/plans/` 同名文件的末尾，或在报告中给出。任何一条不符合预期都要停下来报告，不要自行放宽标准。

---

## 完成标准

- `npm run typecheck` 无错误；`npm test` 全绿；`npm run build` 成功。
- Task 3、5、6、7 的纯逻辑测试**真实跑过**，没有一个 skip。
- Task 9 的端到端基线通过。
- Task 10 的四条真机验收全部符合预期。
- 现有 `agent.ts` 与渲染层**未被修改**（`git diff` 可自证）。

## 不在本次范围

压缩、哈希缓存、PaperContextTracker、检索接缝、embedding 分离、写工具与审批、撤销、产物导出、新 UI 与装配台、移除旧编排。
