# Agent 模式路由重构 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Veridian 聊天助手重构为"模式(mode)"驱动——代码级意图路由 + 每模式工具门控,使问答时结构上拿不到写工具/list_items,并落地 #8(综述/对比/找矛盾/分类)。

**Architecture:** 新增 `modes.ts`(模式表 + 路由)与 `toolRegistry.ts`(工具名→ToolDef + 按模式取工具);`runTurn` 按模式门控工具、拼接瘦身 base prompt + 模式 procedure;`ask/editResend/regenerate` 携带 `modeId`,存于 conversation 供 regenerate 复用;渲染器加预置按钮。

**Tech Stack:** TypeScript(strict, TABS in knowledge/), better-sqlite3, vitest, OpenAI 兼容 function-calling(`providers.ts`)。

**验证规则:** 不要 `npm rebuild better-sqlite3` / electron-rebuild(DB 测试在 Electron ABI 下 `describe.skip`,是正常态,见项目记忆)。每任务验证:`npx tsc -p tsconfig.node.json --noEmit`、`npx tsc -p tsconfig.web.json --noEmit`、`npx vitest run`(DB 测试跳过属正常)、必要时 `npm run build`(渲染器改动必跑)。

---

## 文件结构

| 文件 | 职责 | 新建/修改 |
|---|---|---|
| `src/main/knowledge/modes.ts` | ModeId / AgentMode / MODES(7 模式)/ routeMode / getMode | 新建 |
| `src/main/knowledge/toolRegistry.ts` | 基础读工具定义 + LOAD_SKILL_TOOL + TOOL_REGISTRY + buildTools | 新建 |
| `src/main/knowledge/agent.ts` | 瘦身 base prompt;runTurn 按模式门控 + 注入 procedure;ask/editResend/regenerate 携带 modeId;移除本地 BASE_TOOLS/LOAD_SKILL_TOOL 定义 | 修改 |
| `src/main/knowledge/db.ts` | conversations 增列 `mode_id`(幂等) | 修改 |
| `src/shared/ipc-contract.ts` | ask/editResend 增 modeId 参数 | 修改 |
| `src/main/ipc/handlers.ts` | 转发 modeId | 修改 |
| `src/preload/index.ts` | ask/editResend 增 modeId | 修改 |
| `src/renderer/src/env.d.ts` | 类型随之 | 修改 |
| `src/renderer/src/components/knowledge/KnowledgePage.tsx` | 预置按钮 + activeMode + 传 modeId | 修改 |
| 对应 `*.test.ts` | 单测 | 新建 |

依赖顺序:modes → toolRegistry → agent(门控+prompt+ask) → db 迁移 → IPC/preload/env → 渲染器。

---

## Task 1: modes.ts —— 模式表 + 路由

**Files:**
- Create: `src/main/knowledge/modes.ts`
- Test: `src/main/knowledge/modes.test.ts`

- [ ] **Step 1: 写失败测试** `src/main/knowledge/modes.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { routeMode, getMode, MODES } from './modes'

describe('routeMode', () => {
  it('defaults to qa when nothing matches', () => {
    expect(routeMode('这篇论文的主要结论是什么?').id).toBe('qa')
  })
  it('explicit modeId overrides keyword detection', () => {
    expect(routeMode('随便一句话', 'review').id).toBe('review')
  })
  it('falls back to qa for an unknown explicit modeId', () => {
    expect(routeMode('随便一句话', 'nonsense').id).toBe('qa')
  })
  it('auto-detects classify / tag / review / compare / contradict', () => {
    expect(routeMode('把这些论文分类归档').id).toBe('classify')
    expect(routeMode('给这些论文打标签').id).toBe('tag')
    expect(routeMode('写一篇综述').id).toBe('review')
    expect(routeMode('对比这几篇的方法').id).toBe('compare')
    expect(routeMode('找出它们之间的矛盾').id).toBe('contradict')
  })
  it('every mode exposes a non-empty tool list and qa has no write tools', () => {
    for (const m of MODES) expect(m.tools.length).toBeGreaterThan(0)
    const qa = getMode('qa')
    for (const w of ['add_tags', 'add_to_collection', 'create_note', 'link_items', 'update_metadata', 'set_star', 'list_items'])
      expect(qa.tools).not.toContain(w)
  })
})
```

- [ ] **Step 2: 运行确认失败** `npx vitest run src/main/knowledge/modes.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/main/knowledge/modes.ts`:

```typescript
// The chat assistant runs in one "mode" per turn. A mode is a code-defined
// bundle of {keywords for auto-detection, the exact tools exposed (gating), a
// procedure appended to the slim base prompt}. Gating is what makes misbehaviour
// structurally impossible: e.g. the 'qa' mode never exposes write tools or
// list_items, so the model cannot misuse them to answer a question.
export type ModeId = 'qa' | 'classify' | 'tag' | 'review' | 'compare' | 'contradict' | 'notes'

export interface AgentMode {
	id: ModeId
	label: string          // i18n key for the preset button
	keywords: RegExp | null // auto-detection; null = never auto-matched (qa is the fallback)
	tools: string[]        // tool names exposed this mode (resolved via toolRegistry)
	procedure: string      // appended after the slim base prompt
	button: boolean        // show a preset button in the composer
}

const ANALYZE_TOOLS = ['list_items', 'read_item', 'search_library', 'get_item_info', 'create_note']

export const MODES: AgentMode[] = [
	{
		id: 'classify', label: 'knowledge.mode.classify', button: true,
		keywords: /分类|归档|归类|整理到|整理进|classif|categor|organi[sz]e/i,
		tools: ['list_items', 'read_item', 'search_library', 'list_collections', 'add_to_collection'],
		procedure: `MODE: Classifying papers into collections.
- Call list_items to see the papers in the current scope. Judge each paper's topic from its title, or use read_item / search_library when the title is not enough.
- Decide a small set of sensible collections; call list_collections to reuse existing ones. File each paper with add_to_collection (it creates the collection if missing). You may issue many add_to_collection calls in one turn.
- If there are many papers, do a bounded batch, then tell the user how many you filed and how many remain.
- End with a one-line summary of what you filed where.`,
	},
	{
		id: 'tag', label: 'knowledge.mode.tag', button: true,
		keywords: /打标签|加标签|贴标签|标注为|tag (these|them|all|it)/i,
		tools: ['list_items', 'read_item', 'list_tags', 'add_tags'],
		procedure: `MODE: Tagging papers.
- Call list_items for the papers in scope. For each, extract a few topical keyword tags (from the title, or read_item). Call list_tags first to reuse consistent tag names. Apply with add_tags (existing tags are kept).
- Batch large sets; report how many you tagged.
- End with a one-line summary.`,
	},
	{
		id: 'review', label: 'knowledge.mode.review', button: true,
		keywords: /综述|概述|文献综述|review|overview/i,
		tools: ANALYZE_TOOLS,
		procedure: `MODE: Literature review of multiple papers.
- Read the papers in scope (list_items to enumerate; read_item / search_library for content). Synthesise a structured review: themes, methods, key findings (with figures/numbers), agreements and gaps. Cite specifics with [^item_key:seq] when they come from search_library.
- If the user asks, save the review with create_note; otherwise present it and offer to save.`,
	},
	{
		id: 'compare', label: 'knowledge.mode.compare', button: true,
		keywords: /对比|比较|异同|compare|comparison/i,
		tools: ANALYZE_TOOLS,
		procedure: `MODE: Comparing papers.
- Read the papers in scope. Produce a comparison table across the salient dimensions (problem, method, data, key result, limitations). Cite specifics. Offer to save as a note with create_note if useful.`,
	},
	{
		id: 'contradict', label: 'knowledge.mode.contradict', button: true,
		keywords: /矛盾|冲突|不一致|contradic|conflict|disagree/i,
		tools: ANALYZE_TOOLS,
		procedure: `MODE: Finding contradictions.
- Read the papers in scope and identify claims that conflict or disagree between papers. For each contradiction, state both sides with their sources. Be precise; do not invent conflicts. Offer to save the findings as a note.`,
	},
	{
		id: 'notes', label: 'knowledge.mode.notes', button: true,
		keywords: /建链|建立链接|关联起来|生成笔记|做笔记|link (these|them)/i,
		tools: ['search_library', 'read_item', 'list_items', 'create_note', 'link_items', 'read_notes'],
		procedure: `MODE: Notes & links.
- To summarise a paper, write a structured note with create_note (one-line summary, problem, method, key findings, contributions/limits, key concepts).
- To connect papers, find related items with search_library / list_items and create typed links with link_items (rel_type ∈ extends | contradicts | related | cites | same_method). Use read_notes to see existing notes.
- End with a one-line summary of the notes/links you created.`,
	},
	{
		id: 'qa', label: 'knowledge.mode.qa', button: false,
		keywords: null,
		tools: ['search_library', 'read_item', 'read_context', 'get_item_info'],
		procedure: `MODE: Answering questions.
- To get content, use search_library (relevant passages across the library; it honours the selected scope and gives [^item_key:seq] citations) or, for a small selected collection you want to analyse, read_item (one paper's full text). Use read_context to expand around a hit and get_item_info for metadata.
- If nothing relevant is found, say so plainly. You cannot modify the library in this mode.`,
	},
]

export function getMode(id: string): AgentMode {
	return MODES.find((m) => m.id === id) ?? MODES.find((m) => m.id === 'qa')!
}

/** Pick the mode: an explicit (button-chosen) modeId wins; else the first mode
 *  whose keywords match the message; else 'qa' (read-only, safe fallback). */
export function routeMode(message: string, explicitModeId?: string | null): AgentMode {
	if (explicitModeId) {
		const m = MODES.find((x) => x.id === explicitModeId)
		if (m) return m
	}
	for (const m of MODES) {
		if (m.keywords && m.keywords.test(message)) return m
	}
	return getMode('qa')
}
```

- [ ] **Step 4: 运行确认通过** `npx vitest run src/main/knowledge/modes.test.ts` → PASS。

- [ ] **Step 5: 提交**
```
git add src/main/knowledge/modes.ts src/main/knowledge/modes.test.ts
git commit -m "feat(knowledge): agent modes table + intent router"
```

---

## Task 2: toolRegistry.ts —— 工具注册表 + 门控

**Files:**
- Create: `src/main/knowledge/toolRegistry.ts`
- Test: `src/main/knowledge/toolRegistry.test.ts`

(本任务**不改 agent.ts**——toolRegistry 自带 base 工具定义;agent.ts 的旧 `BASE_TOOLS`/`LOAD_SKILL_TOOL` 由 Task 3 删除。Task 2→3 间两处定义短暂并存,可接受,保证每任务独立编译。)

- [ ] **Step 1: 写失败测试** `src/main/knowledge/toolRegistry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { TOOL_REGISTRY, buildTools } from './toolRegistry'
import { MODES, getMode } from './modes'

describe('toolRegistry', () => {
  it('resolves every tool name referenced by every mode', () => {
    for (const m of MODES)
      for (const name of m.tools)
        expect(TOOL_REGISTRY[name], `${m.id} → ${name}`).toBeDefined()
  })
  it('buildTools gates to the mode tools and appends load_skill only when skills exist', () => {
    const qa = getMode('qa')
    const names = buildTools(qa, false).map((t) => t.function.name)
    expect(names.sort()).toEqual(['get_item_info', 'read_context', 'read_item', 'search_library'].sort())
    expect(names).not.toContain('load_skill')
    expect(buildTools(qa, true).map((t) => t.function.name)).toContain('load_skill')
  })
})
```

- [ ] **Step 2: 运行确认失败** `npx vitest run src/main/knowledge/toolRegistry.test.ts` → FAIL(模块不存在)。

- [ ] **Step 3: 实现.** 先 READ `src/main/knowledge/agent.ts` 顶部的 `BASE_TOOLS`(3 个工具:search_library / get_item_info / read_context)与 `LOAD_SKILL_TOOL` 常量定义,**原样搬到** `src/main/knowledge/toolRegistry.ts`(定义是纯数据,执行逻辑仍在 agent.ts 的 runTool,按工具名分支,不受影响)。

`src/main/knowledge/toolRegistry.ts`:

```typescript
// Single source of truth for tool DEFINITIONS (name → ToolDef), and the per-mode
// gating that turns a mode's tool-name list into the actual ToolDef[] handed to
// the model. Executors live in agent.ts (runTool) / agentTools.ts and dispatch
// by name, so they are unaffected by where the defs live.
import type { ToolDef } from './providers'
import { AGENT_ACTION_TOOLS } from './agentTools'
import type { AgentMode } from './modes'

// --- moved verbatim from agent.ts ---
const SEARCH_LIBRARY_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'search_library',
		description:
			'Hybrid semantic + keyword search over the full text of every paper in the current library. ' +
			'Returns excerpts with their source (item_key + seq). Call multiple times with different ' +
			'phrasings if the first search misses. Queries can be Chinese or English.',
		parameters: { type: 'object', properties: { query: { type: 'string', description: 'search query' } }, required: ['query'] },
	},
}
const GET_ITEM_INFO_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'get_item_info',
		description: 'Bibliographic metadata (title, authors, year, journal, DOI) for one paper.',
		parameters: { type: 'object', properties: { item_key: { type: 'string', description: 'the item key from a search result' } }, required: ['item_key'] },
	},
}
const READ_CONTEXT_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'read_context',
		description: 'Read the chunks immediately before and after a given excerpt for more context.',
		parameters: { type: 'object', properties: { item_key: { type: 'string' }, seq: { type: 'number', description: 'the seq of the excerpt to expand around' } }, required: ['item_key', 'seq'] },
	},
}
export const LOAD_SKILL_TOOL: ToolDef = {
	type: 'function',
	function: {
		name: 'load_skill',
		description:
			'Load the full instructions for one of the installed skills listed at the end of this ' +
			'prompt. Call this before following a skill\'s procedure -- the catalog only gives you its ' +
			'name and a one-line description, not the actual steps.',
		parameters: { type: 'object', properties: { name: { type: 'string', description: 'the skill name from the catalog' } }, required: ['name'] },
	},
}

const BASE_READ_TOOLS: ToolDef[] = [SEARCH_LIBRARY_TOOL, GET_ITEM_INFO_TOOL, READ_CONTEXT_TOOL]

export const TOOL_REGISTRY: Record<string, ToolDef> = Object.fromEntries(
	[...BASE_READ_TOOLS, ...AGENT_ACTION_TOOLS].map((t) => [t.function.name, t]),
)

/** Resolve a mode's tool-name list to ToolDefs, appending load_skill only when
 *  the user has installed skills. Unknown names are dropped (guarded by test). */
export function buildTools(mode: AgentMode, hasSkills: boolean): ToolDef[] {
	const tools = mode.tools.map((n) => TOOL_REGISTRY[n]).filter((t): t is ToolDef => Boolean(t))
	if (hasSkills) tools.push(LOAD_SKILL_TOOL)
	return tools
}
```

Do NOT modify `agent.ts` in this task. toolRegistry.ts defines its own copies of the base tool defs (pure data), so it compiles standalone; agent.ts keeps its existing `BASE_TOOLS`/`LOAD_SKILL_TOOL` for now (Task 3 deletes them and switches runTurn to `buildTools`). The two definitions coexisting across Task 2→3 is intentional and harmless — it keeps each task independently compilable.

- [ ] **Step 4: 运行确认通过 + 类型检查** Run:
```
npx vitest run src/main/knowledge/toolRegistry.test.ts
npx tsc -p tsconfig.node.json --noEmit
```
Expected: 测试 PASS;typecheck clean(toolRegistry 只依赖既有的 agentTools + modes,agent.ts 未动仍编译)。

- [ ] **Step 5: 提交**
```
git add src/main/knowledge/toolRegistry.ts src/main/knowledge/toolRegistry.test.ts
git commit -m "feat(knowledge): tool registry + per-mode gating (buildTools)"
```

---

## Task 3: agent.ts —— 瘦身 prompt + runTurn 门控 + ask/regenerate 携带模式

**Files:**
- Modify: `src/main/knowledge/agent.ts`

READ the current `BASE_SYSTEM_PROMPT`, `buildSystemPrompt`, `runTurn`, `ask`, `editLastAndResend`, `regenerate` first.

- [ ] **Step 1: 瘦身 base prompt.** 用下面的 `SLIM_BASE_PROMPT` **替换整个** `BASE_SYSTEM_PROMPT` 常量(把 library-actions / list_items / classify 等模式相关内容删掉——它们已在 modes.ts 的各 procedure 中):

```typescript
const SLIM_BASE_PROMPT = `You are the research assistant inside Veridian, a reference manager. You help with the user's own paper library.

Core rules (always apply):
- If the user attached specific papers or files this turn (they appear as "[Attached paper: ...]" / "[Attached file: ...]" system messages), answer directly from that attached content; do NOT call search_library and add no [^...] markers for it.
- Otherwise answer ONLY from the library — never from general knowledge, and never from paper titles alone.
- Cite any claim drawn from a search_library result with the marker [^item_key:seq] taken from that result (e.g. [^AB12CD34:5]), inline right after the claim.
- Answer in the same language the user asked in. Be concise and factual; quote numbers and findings exactly.
- Write every mathematical variable/formula in LaTeX: inline $...$ and display $$...$$. Never write math as plain text.`
```

- [ ] **Step 2: buildSystemPrompt 接受 mode.** 把 `buildSystemPrompt()` 改为按模式拼接:

```typescript
function buildSystemPrompt(mode: import('./modes').AgentMode): string {
	const base = `${SLIM_BASE_PROMPT}\n\n${mode.procedure}`
	const skills = listInstalledSkills()
	if (!skills.length) return base
	const catalog = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
	return `${base}\n\nInstalled skills (call load_skill(name) to read one in full before using it):\n${catalog}`
}
```

- [ ] **Step 3: 顶部导入 + 删除旧常量.** 加导入:
```typescript
import { buildTools } from './toolRegistry'
import { routeMode, getMode, type AgentMode } from './modes'
```
并**删除** agent.ts 里现有的 `const BASE_TOOLS: ToolDef[] = [ ... ]` 整块与 `const LOAD_SKILL_TOOL: ToolDef = { ... }` 整块(它们已在 toolRegistry.ts;runTool 里按名分支的执行逻辑保持不动)。若 `ToolDef` 导入在删除后变为未使用,一并移除该导入。

- [ ] **Step 4: runTurn 门控 + prompt.** 把 `runTurn` 签名与内部两处改掉。签名加 `mode`:
```typescript
function runTurn(convId: number, refs: KnowledgeRef[] | undefined, filter: import('./search').ScopeFilter | undefined, mode: AgentMode): void {
```
把系统消息那行改为 `{ role: 'system', content: buildSystemPrompt(mode) }`;把 tools 那行(现为 `const tools = [...BASE_TOOLS, ...AGENT_ACTION_TOOLS, ...(...)]`)替换为:
```typescript
		const tools = buildTools(mode, listInstalledSkills().length > 0)
```

- [ ] **Step 5: ask 携带 modeId.** `ask` 加参数并路由 + 持久化:
```typescript
export async function ask(question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null, modeId?: string | null): Promise<number> {
	const kdb = getKnowledgeDb()
	const ws = wsId()
	const mode = routeMode(question, modeId)
	let convId = conversationId
	const scope = scopeCollectionId ?? null
	if (convId === null) {
		const info = kdb.prepare('INSERT INTO conversations (workspace_id, title, scope_collection_id, mode_id) VALUES (?, ?, ?, ?)')
			.run(ws, question.slice(0, 60), scope, mode.id)
		convId = Number(info.lastInsertRowid)
	} else {
		kdb.prepare('UPDATE conversations SET scope_collection_id = ?, mode_id = ? WHERE id = ?').run(scope, mode.id, convId)
	}
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(convId, 'user', question, JSON.stringify(enrichRefs(refs)))
	runTurn(convId, refs, scopeToFilter(scope), mode)
	return convId
}
```

- [ ] **Step 6: editLastAndResend 携带 modeId.** 加参数,路由后写 conversation 的 mode_id 并传 runTurn(mirror ask):
```typescript
export function editLastAndResend(conversationId: number, newQuestion: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null, modeId?: string | null): void {
	const kdb = getKnowledgeDb()
	const lastUser = kdb.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
		.get(conversationId) as { id: number } | undefined
	if (!lastUser) return
	const scope = scopeCollectionId ?? null
	const mode = routeMode(newQuestion, modeId)
	kdb.prepare('UPDATE conversations SET scope_collection_id = ?, mode_id = ? WHERE id = ?').run(scope, mode.id, conversationId)
	kdb.prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?').run(conversationId, lastUser.id)
	kdb.prepare('INSERT INTO messages (conversation_id, role, content, refs) VALUES (?, ?, ?, ?)')
		.run(conversationId, 'user', newQuestion, JSON.stringify(enrichRefs(refs)))
	runTurn(conversationId, refs, scopeToFilter(scope), mode)
}
```

- [ ] **Step 7: regenerate 复用存储的模式.** 加一个读取 conversation.mode_id 的辅助并在 regenerate 用它:
```typescript
function conversationMode(convId: number): AgentMode {
	const row = getKnowledgeDb().prepare('SELECT mode_id FROM conversations WHERE id = ?')
		.get(convId) as { mode_id: string | null } | undefined
	return getMode(row?.mode_id ?? 'qa')
}
```
在 `regenerate` 里把 `runTurn(conversationId, lastUserRefs(conversationId), conversationFilter(conversationId))` 改为:
```typescript
	runTurn(conversationId, lastUserRefs(conversationId), conversationFilter(conversationId), conversationMode(conversationId))
```

- [ ] **Step 8: 类型检查(须先做 Task 4 的迁移让 mode_id 列存在于运行期;编译期不依赖它).** Run:
```
npx tsc -p tsconfig.node.json --noEmit
```
Expected: clean。(若报 `mode_id` 相关只是 SQL 字符串,不影响 TS 编译。)

- [ ] **Step 9: 提交**
```
git add src/main/knowledge/agent.ts
git commit -m "feat(knowledge): slim base prompt + mode-gated runTurn + modeId in ask/editResend/regenerate"
```

---

## Task 4: knowledge db 迁移 —— conversations.mode_id

**Files:**
- Modify: `src/main/knowledge/db.ts`

- [ ] **Step 1: 加列(幂等).** READ `src/main/knowledge/db.ts`,找到 conversations 表加 `scope_collection_id` 列的既有幂等迁移(形如 `if (!cols.includes('scope_collection_id')) db.exec('ALTER TABLE conversations ADD COLUMN scope_collection_id ...')`)。**照它的模式**,在同处追加:

```typescript
if (!cols.includes('mode_id')) {
	db.exec("ALTER TABLE conversations ADD COLUMN mode_id TEXT")
}
```
(若该文件用的是集中式列检查数组,则把 `['mode_id', 'TEXT']` 加进去,遵循文件既有写法。旧会话该列为 NULL,`getMode(null)` 已回退 qa。)

- [ ] **Step 2: 验证** Run `npx tsc -p tsconfig.node.json --noEmit`(clean)。DB 层逻辑由 Task 3 的 SQL 使用;运行期迁移在 app 启动时执行。

- [ ] **Step 3: 提交**
```
git add src/main/knowledge/db.ts
git commit -m "feat(knowledge): conversations.mode_id column (idempotent)"
```

---

## Task 5: IPC / preload / env —— 贯通 modeId

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`

- [ ] **Step 1: ipc-contract.** 给 `knowledge:ask` 和 `knowledge:editResend` 的 tuple 末尾各加一个可选 modeId(字符串)。改为:
```typescript
  'knowledge:ask':                z.tuple([z.string().min(1).max(4000), id.nullable(), z.array(knowledgeRef).max(5).optional(), z.number().int().positive().nullable().optional(), z.string().max(40).nullable().optional()]),
  'knowledge:editResend':         z.tuple([id, z.string().min(1).max(4000), z.array(knowledgeRef).max(5).optional(), z.number().int().positive().nullable().optional(), z.string().max(40).nullable().optional()]),
```

- [ ] **Step 2: handlers.** READ `src/main/ipc/handlers.ts` 的 `'knowledge:ask'`/`'knowledge:editResend'` 两行,把 modeId 透传:
```typescript
  'knowledge:ask':                (_e, question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null, modeId?: string | null) =>
    Agent.ask(question, conversationId, refs, scopeCollectionId, modeId),
  'knowledge:editResend':         (_e, conversationId: number, question: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null, modeId?: string | null) =>
    Agent.editLastAndResend(conversationId, question, refs, scopeCollectionId, modeId),
```

- [ ] **Step 3: preload.** 在 `src/preload/index.ts` 把 ask/editResend 增参:
```typescript
    ask: (question: string, conversationId: number | null, refs?: KnowledgeRef[], scopeCollectionId?: number | null, modeId?: string | null) =>
      call<number>('knowledge:ask', question, conversationId, refs, scopeCollectionId, modeId),
    editResend: (conversationId: number, question: string, refs?: KnowledgeRef[], scopeCollectionId?: number | null, modeId?: string | null) =>
      call('knowledge:editResend', conversationId, question, refs, scopeCollectionId, modeId),
```

- [ ] **Step 4: env.d.ts.** READ `src/renderer/src/env.d.ts` 里 `knowledge.ask`/`editResend` 的类型声明,给两者末尾各加 `modeId?: string | null`,与 preload 完全一致。

- [ ] **Step 5: 验证** Run:
```
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
```
Expected: 两者 clean。

- [ ] **Step 6: 提交**
```
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat(ipc): thread modeId through knowledge ask/editResend"
```

---

## Task 6: 渲染器 —— 预置按钮 + 活动模式

**Files:**
- Modify: `src/renderer/src/components/knowledge/KnowledgePage.tsx`
- Modify: `src/renderer/src/i18n/index.ts`(模式标签的中英文案)

- [ ] **Step 1: i18n 文案.** READ `src/renderer/src/i18n/index.ts`(翻译在此文件,不在 locales/*.json)。在 zh 和 en 两处 knowledge 命名空间下加:
```
knowledge.mode.classify / tag / review / compare / contradict / notes / qa
```
zh:`分类 / 打标签 / 综述 / 对比 / 找矛盾 / 笔记 / 问答`;en:`Classify / Tag / Review / Compare / Contradict / Notes / Q&A`。再加 `knowledge.modeActive`(zh:`{{mode}} 模式`,en:`{{mode}} mode`)与 `knowledge.modeClear`(zh:`取消`,en:`Clear`)。

- [ ] **Step 2: 组件状态与按钮.** 在 `KnowledgePage.tsx`:
  - 顶部与 `scopeCollectionId` 相邻处加状态:`const [activeMode, setActiveMode] = useState<string | null>(null)`。
  - 定义按钮列表(仅 button:true 的模式,顺序如下):
    ```typescript
    const MODE_BUTTONS = ['classify', 'tag', 'review', 'compare', 'contradict', 'notes'] as const
    ```
  - 在 composer 的 scope 下拉附近(参考现有 line ~460 的 `<div style={{ display: 'flex', gap: 8 }}>` 区)加一排按钮:每个按钮点击 `setActiveMode(activeMode === id ? null : id)`(再点取消),active 的高亮。用现有 `Chip` 组件或简单 button,文案 `t('knowledge.mode.' + id)`。active 时在输入框旁显示 `t('knowledge.modeActive', { mode: t('knowledge.mode.' + activeMode) })` + 一个 `t('knowledge.modeClear')` 按钮 `onClick={() => setActiveMode(null)}`。
  - `startNewConversation()` 里重置:`setActiveMode(null)`。

- [ ] **Step 3: 发送时传 modeId.** 在 `send()` 里把 `activeMode` 传给两个调用(现有传 `scopeCollectionId` 的两处):
```typescript
			await window.veridian.knowledge.editResend(conversationId, q, refs.length ? refs : undefined, scopeCollectionId, activeMode)
```
```typescript
			const id = await window.veridian.knowledge.ask(q, conversationId, refs.length ? refs : undefined, scopeCollectionId, activeMode)
```
发送成功后不强制清空 activeMode(用户可连续用同一模式);仅"取消"按钮或新会话清空。

- [ ] **Step 4: 验证(渲染器改动必跑 build).** Run:
```
npx tsc -p tsconfig.web.json --noEmit
npm run build
```
Expected: typecheck clean;build 成功。

- [ ] **Step 5: 提交**
```
git add src/renderer/src/components/knowledge/KnowledgePage.tsx src/renderer/src/i18n/index.ts
git commit -m "feat(knowledge-ui): mode preset buttons + active-mode indicator"
```

---

## Task 7: 全量验证 + 手动冒烟

**Files:** 无(仅验证)

- [ ] **Step 1: 全量** Run:
```
npm run typecheck && npm run test && npm run build
```
Expected: 三者全绿(DB 测试在 Electron ABI 下 skip 属正常)。

- [ ] **Step 2: 手动冒烟**(需真实模型;复用用户已开的 app,勿另起 dev):
1. 纯提问 → 轨迹只有 search_library / read_item / read_context,**无任何写步骤**;有引用、有来源。
2. 点"分类"按钮 + 选某分类范围 → AI 走 classify:list_items(受 scope)→ add_to_collection;左栏出现归档结果;不做检索式问答。
3. 点"综述"→ 出结构化综述(读多篇 + 引用)。
4. 打字"帮这些论文打标签"(不点按钮)→ 自动进 tag 模式,出标签。
5. 打字一个普通问题里含"标签"一词(如"这些论文都有哪些标签")→ 因关键词保守应仍进 qa 或被 tag 误判;若误判,记录以便调关键词(可接受:管理模式误判不会造成破坏,用户可用按钮纠正)。

- [ ] **Step 3: 记录结果**,失败项回对应 Task 修复。

---

## 自检(spec 覆盖)

- 模式表 + 路由(routeMode):Task 1 ✅
- 工具门控(qa 无写工具/list_items):Task 2(buildTools)+ Task 1(qa.tools)✅
- base prompt 瘦身 + procedure 注入:Task 3 ✅
- 模式持久化 + regenerate 复用:Task 3(conversationMode)+ Task 4(mode_id 列)✅
- 混合触发:显式 modeId(按钮,Task 5/6)+ 关键词自动(routeMode,Task 1)✅
- 预置按钮 UX:Task 6 ✅
- scope 与模式正交:沿用 P1 的 filter 透传,runTurn 仍传 filter,门控工具里的 search_library/list_items 仍受 filter(P1 已实现)✅
- 用户 SKILL.md 市场不动 + 各模式仍可 load_skill:Task 2(hasSkills 时挂 LOAD_SKILL_TOOL)✅
- #8(review/compare/contradict):Task 1 模式 + Task 6 按钮 ✅
- 渲染器不回归:Task 6/7 build ✅
