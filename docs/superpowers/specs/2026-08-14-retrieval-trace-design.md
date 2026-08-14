# 检索过程可观测(harness 风格活动流)— 设计文档

> 路线图 #10 的"可观测"部分。日期:2026-08-14。

## 目标

在每条助手回答上方显示一个 **harness 风格的实时活动流**:agent 每调用一次工具(搜索/读上下文/查元数据/加载技能)就即时冒出一步;回答完**折叠成一行摘要**,可再展开。搜索步显示 query + 命中论文 + **每条摘录字数**(正好让用户验证 #6 的"结果数/摘录长度"是否生效)。**实时 + 持久化**(刷新/重开对话仍可展开)。

## 范围与决策(已拍板)

- 显示 agent 的**动作/检索过程**,不是模型内部 chain-of-thought(OpenAI 兼容接口只流式返回最终答案,不吐思考流)。
- **B 完整动作流程**:每一步工具调用都记(不只搜索)。
- **实时逐步 + 跑完折叠成一行、可再展开**。
- **持久化**:步骤存进 `messages` 表(幂等加列,和 #5 同法)。
- **不做**:不加 list_collections/compare_items 等新工具(#10 的工具扩展留后);不接 reasoning-token 流。

## 数据模型

新增共享类型(`src/shared/types.ts`):
```ts
export interface RetrievalStep {
	tool: 'search_library' | 'read_context' | 'get_item_info' | 'load_skill'
	label: string                                   // query / itemKey:seq / itemKey / skill name
	hits?: { title: string; chars: number }[]       // search_library only: hit papers + real excerpt length
}
```

新增事件(`src/shared/events.ts`):
```ts
| { type: 'knowledge.step'; conversationId: number; step: RetrievalStep }
```

## 数据流

```
ask() 工具循环:每个 toolCall
  └─ runTool 返回 { result, step }
        ├─ emit { knowledge.step, conversationId, step }   ← 实时推给 UI
        └─ steps.push(step)                                 ← 累积
回答收尾: INSERT messages(..., steps = JSON.stringify(steps))   ← 持久化
getMessages: SELECT * 带回 steps 字段
```

UI:
```
KnowledgePage: 监听 knowledge.step → 累积到"当前流式回答"的 steps 状态(send 时清空)
ChatMessageView: 收到 steps → 渲染 <RetrievalTrace>
  - streaming 中:展开、实时逐步
  - 完成后:折叠成一行摘要(🔍 检索 N 次 · M 篇来源 ▸),点击展开
刷新/重开: refreshMessages 解析持久化的 steps → 同样渲染(折叠态)
```

## 后端细节(`agent.ts`)

- `runTool(name, args, filter)` 改为返回 `{ result: string; step: RetrievalStep }`:
  - `search_library`:`step = { tool, label: q, hits }`,其中 `hits` 由命中构造 —— `title` 查 `items`(`SELECT key,title WHERE key IN(...)`),`chars = truncateAtBoundary(h.text, chars).length`(即真实喂给模型的摘录长度)。
  - `read_context`:`label = \`${key}:${seq}\``。
  - `get_item_info`:`label = key`。
  - `load_skill`:`label = name`。
- ask 循环:`const { result, step } = await runTool(...)`;`emit({ type:'knowledge.step', conversationId: convId!, step })`;`steps.push(step)`;`messages.push({ role:'tool', content: result, tool_call_id: tc.id })`。
- 收尾 INSERT 加 `steps` 列:`INSERT INTO messages (conversation_id, role, content, citations, steps) VALUES (?,?,?,?,?)`,值 `JSON.stringify(steps)`。
- `MessageRow` 加 `steps: string`;`getMessages` 的 `SELECT *` 自动带回。

## DB 迁移(`db.ts`)

- `messages` 的 `CREATE TABLE` 加 `steps TEXT NOT NULL DEFAULT '[]'`。
- 幂等加列:`PRAGMA table_info(messages)` 无 `steps` 则 `ALTER TABLE messages ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'`。

## IPC / 类型

- `getMessages`(preload/env)返回类型加 `steps: string`。
- 事件 `knowledge.step` 在 `shared/events.ts`,经既有 domain-event 通道到达渲染层(无需改 preload)。

## UI(`RetrievalTrace` 组件,harness 风格)

- 竖向时间线:左侧一条细连接线,每步一个图标 + 标签:
  - `🔍 搜索 "…" → N 条`(可展开命中列表:每行 `论文标题 · 1180 字`)
  - `📄 读取 [key:seq] 上下文`、`ℹ️ 查询 [key] 信息`、`📎 加载技能 name`
- streaming:整块展开、逐步追加,最后一步带"进行中"微光;`done` 后自动折叠成 `🔍 检索 N 次 · M 篇来源 ▸`,点击切换展开/折叠。
- 视觉低饱和、次要色,贴合现有聊天气泡风格;用 frontend-design skill 打磨"harness"观感。
- 挂在 `ChatMessageView` 助手气泡**上方**。

## 测试
- 纯逻辑单测有限;可为"折叠摘要文案"或"步骤→摘要"抽一个纯函数(如 `summarizeSteps(steps): {searches, sources}`)并单测。
- 其余(事件、DB、实时 UI)靠 typecheck + 手动验证:提问时活动流实时逐步出现;搜索步显示论文+摘录字数(与 #6 设置一致);刷新/重开对话面板仍在(折叠可展开)。

## 不做(YAGNI)
- 不加新 agent 工具;不接 reasoning 流;不做步骤耗时/token 统计(以后可加)。
- 不改检索/重排/翻译/范围/截断逻辑,只**观测**它们。
