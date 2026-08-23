# Harness v2 · 第一条竖线 — 设计文档

日期：2026-08-23
状态：待评审
对应计划：`C:\D\Veridian\AI助手重构计划.md` 第 14–30 条（骨架 + 第一条竖线）

---

## 背景

现有 AI 助手要按插件架构从零重写（计划第 1–6 条已定：用 `@deepseek-ai/cordis@4.0.1` 核心，
不引 loader/include/hmr，自建薄配置层）。

重写的最大风险是**横着建完所有层才发现设计错了**。因此第一步不铺开，而是**竖着打通一条最窄
的完整链路**：用户 @ 一篇论文并提问 → 新链路给出答案。跑通后它成为所有后续改动的回归基线。

同时这条竖线要**当场兑现一个真实痛点**，否则「重写了一大堆但什么都没变好」。选中的痛点是
用户最日常的抱怨：

> @ 一篇文献问内容，它说找不到，或者跑去检索全库。

根因已定位在 `agent.ts` 的 `resolveRefs`：8000 字符硬上限（论文 30–80KB，只覆盖约 15%）、
读取失败被 `catch` 吞掉后告诉模型「没有转换文本」、且基础提示禁止它回退检索。

## 目标

1. 建立可运行的插件容器与接缝规范，供后续所有能力挂载。
2. 打通一次完整回合，**全程不碰现有 `agent.ts`**，旧助手保持可用。
3. 让 @ 文献问答**当场变好**：读全文、失败说清原因。
4. 留下端到端回归基线。

## 范围

**在范围内**

- 引入 Cordis 核心，建主进程根 context 与插件生命周期
- 类型化事件总线（含派发模式声明）
- 会话事件日志（**内存态**）与 `deriveMessages()` 投影
- 「模型可见即已记录」不变量（开发期断言）
- 接缝规范，并落地两道：`ctx.llm`、`ctx.attachment`
- 最小上下文装配器（含 token 预算）
- 一个只读工具，验证工具注册与调用通路
- 回合流程与事件
- 开关切换，新旧链路并存
- 端到端测试 + 真实模型冒烟

**不在范围内**（各自留给后续条目）

- 会话日志**持久化**与历史数据迁移（第 95–98 条）
- 压缩、哈希缓存、PaperContextTracker（第 40–44 条）
- 检索接缝、embedding 分离（第 59–63 条）
- 写工具、审批、撤销（第 45–58 条）
- 产物导出（第 64–67 条）
- 新 UI 与装配台（第 68–87 条）——本期**复用现有 UI**
- 移除旧编排（第 91–94 条）

## 关键设计决策

### D1. 新链路渲染在旧 UI 上

新回合流程发出**现有的**渲染层事件（`knowledge.chatDelta` / `knowledge.chatState` /
`knowledge.step`），IPC 契约一个字不改。

理由：这样能在**不重写界面**的前提下验证 harness。若同时换掉 UI，出问题时无法判断是架构错了
还是界面错了。UI 重写是第 68–76 条，独立进行。

### D2. 开关切换，默认走旧路

新增设置项 `knowledge.harnessV2`（布尔，默认 `false`）。`knowledge:ask` 处理器据此路由。

0.1.12 已有用户在使用，重写期间旧助手必须照常工作。

### D3. 会话日志先做内存态，但投影必须是最终形态

`deriveMessages(log)` 的**投影语义**是架构的核心，必须一次做对；而持久化格式涉及历史数据迁移，
需要单独决策。因此本期建内存态日志 + 完整投影，持久化留到下一期。

不变量在本期即刻建立：**任何进入模型请求的内容，必须能从日志投影重建**，开发期以断言校验。

### D4. 附件读全文，且降级必须说出来

`ctx.attachment` 的提供者读取论文 Markdown **全文**，不设武断的字符上限。仅当装配器的预算
放不下时才截断，且截断必须写进给模型的内容里（原始多大、显示多少）。

失败**绝不静默**：把真实原因放回内容本该出现的位置，并分类。

## 接缝定义

接缝 = 接口定义 + 提供者 + 消费者，三者齐全才算一道（计划第 21 条）。

### `ctx.llm`

```ts
interface LlmSeam {
  stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmChunk>
}

interface LlmRequest {
  messages: ChatMessage[]
  tools: ToolSchema[]
}

type LlmChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'tool-call'; id: string; name: string; args: string }
  | { kind: 'done'; reason: 'stop' | 'tool-calls' | 'aborted' }
```

**本期提供者**：包装现有 `providers.ts` 的 `chatStream`（复用，不重写）。Anthropic 适配器沿用
现有实现；它从未用真实令牌验证过（计划第 103 条），本期不解决，但在文档中标注。

### `ctx.attachment`

```ts
type AttachmentRef =
  | { type: 'item'; itemKey: string }
  | { type: 'file'; path: string }

type AttachmentResult =
  | { ok: true
      itemKey?: string
      title: string
      text: string
      totalBytes: number        // 源文件实际大小
      shownBytes: number        // 本次放入的大小
      truncated: boolean }
  | { ok: false
      title?: string
      reason: 'not_found' | 'not_converted' | 'permission_denied' | 'unreadable'
      detail: string }          // 真实错误文本，不加工

interface AttachmentSeam {
  resolve(ref: AttachmentRef): Promise<AttachmentResult>
}
```

**本期提供者**：论文 → 读其 `markdown` 附件全文；文件 → 直接读。

四类失败的判定：

| reason | 判定 | 给模型的话 |
|---|---|---|
| `not_found` | 条目不存在或已删除 | 找不到这个条目 |
| `not_converted` | 条目存在但无 markdown 附件 | 尚未转换为 Markdown，可先执行转换 |
| `permission_denied` | 路径白名单拒绝 | 文件在允许范围之外 |
| `unreadable` | 其它 IO 错误 | 原始错误文本 |

### 附件在提示词中的形态

附加在**用户消息之后**（不是独立 system 消息），用自描述标签携带元数据：

```
<paper item_key="AB12CD34" title="Deep Residual Learning" truncated="false">
…全文…
</paper>
```

截断时：

```
<paper item_key="AB12CD34" title="…" truncated="true" total_bytes="62310" shown_bytes="41000">
…前 41000 字节…

[内容因预算截断：原文 62310 字节，此处显示 41000 字节。需要其余部分可再次询问具体章节。]
</paper>
```

失败时（内容位置放真实原因，不谎称「没有文本」）：

```
<paper item_key="AB12CD34" title="…" error="not_converted">
这篇尚未转换为 Markdown，无法读取正文。可以先对它执行 PDF 转换。
</paper>
```

行内的 `@xxx` 在用户消息里改写成前向引用（「（正文见下）」），使模型知道自己手上有全文。

## 会话日志与投影

事件（本期最小集，全部按计划第 17a 条声明类型与派发模式）：

| 事件 | 载荷 |
|---|---|
| `session/turn-start` | `{ turnId }` |
| `session/user-message` | `{ text, refs }` |
| `session/attachment-resolved` | `{ ref, result }` |
| `session/assistant-message` | `{ text }` |
| `session/tool-call` | `{ id, name, args }` |
| `session/tool-result` | `{ id, name, result }` |
| `session/turn-end` | `{ turnId, reason }` |

`deriveMessages(log): ChatMessage[]` 是**唯一**构造模型消息的途径。装配器不得旁路它拼接内容。

**不变量**（开发期断言）：把最终发给模型的每条消息内容，与 `deriveMessages()` 的输出逐条比对，
不一致即抛错。这条断言是上下文检查器（计划第 69 条）的基础。

## 上下文装配

```ts
interface AssembleInput { log: SessionLog; tools: ToolSchema[]; budget: Budget }
interface Budget { contextWindow: number; reserveForOutput: number }
```

优先级（自高至低），超预算时从低优先级开始削减：

1. **系统提示 + 工具 schema** — 固定开销，**永不参与淘汰**
2. **本轮附件** — 放不下则截断最大的一个，并如实标注
3. **历史消息** — 从最旧开始丢弃

预算计算沿用 cline 的拆分法：先算固定开销，历史与附件竞争剩余额度。

本期 token 计数用**字符数近似**（`chars / 4`）；精确计数留到接入用量遥测时（计划第 77 条）。
近似值只用于取舍，不对用户展示。

## 工具通路

本期只注册一个只读工具 `get_item_info`（按 key 返回标题/年份/期刊/DOI/作者），目的是验证
「注册 → schema 进提示词 → 模型调用 → 执行 → 结果回灌 → 再次请求」整条通路，而不是提供能力。

工具接口预留 `kind` 字段（`read` | `write-library` | `write-fs` | `destructive`），本期只用
`read`；审批与门控是第 45–49 条。

## 回合流程

```
turn/start
  装配（系统提示 + 工具 schema + 附件 + 历史）
  step/start
    追加 user/message 与 attachment-resolved 到日志
    deriveMessages() 投影
    agent/request → llm/stream → 文本增量 / 工具调用
    有工具调用 → 执行 → tool/result 入日志 → 回到 step/start
    无工具调用 → assistant/message 入日志
  step/end
turn/end
```

上限 8 轮（沿用现有值）。中断沿用现有 `AbortController` 机制。

## 与现有系统的共存

- 根 context 在主进程启动时创建，**与现有 Service 层、Notifier、JobQueue 并存**，不替换。
- 本期不把现有服务接进 context；`ctx.llm` / `ctx.attachment` 的提供者直接调用现有模块。
- `knowledge:ask` 按开关路由；两条链路发出相同的渲染层事件。

## 集成风险：ESM / CJS

`@deepseek-ai/cordis` 是纯 ESM（`type: module`，无 CJS 构建），而本项目是 CommonJS，且主进程
用 `externalizeDepsPlugin()` 把依赖排除在打包之外，运行时以 `require()` 加载。

**处理方式**：在 `electron.vite.config.ts` 中把 cordis 及其依赖排除出 externalize，交给 Rollup
打进主进程产物：

```ts
externalizeDepsPlugin({ exclude: ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit'] })
```

这样绕开 CJS/ESM 互操作问题。Electron 36 带的 Node 22 虽然支持 `require(esm)`，但依赖该特性
更脆（一旦包内出现顶层 await 即失效）。

**必须实测**：本项目已有先例——`npm run typecheck` 与 `npm test` 都过、`npm run build` 才暴露
打包层问题。因此实现时以 `npm run build` 成功 + 实际启动应用为准，不以类型检查通过为准。

## 测试计划

**纯逻辑（必须真实跑过，不允许 skip）**

- 附件提供者：全文读取；预算内不截断；超预算截断且标注真实字节数；四类失败各自返回正确
  `reason` 与真实 `detail`。
- 装配器：固定开销永不淘汰；附件优先于历史；历史从最旧丢弃；截断标注进入最终文本。
- `deriveMessages()`：各类事件投影成正确的消息序列；工具调用与结果成对不被拆散。
- 不变量断言：人为构造旁路拼接的内容时必须抛错。

**端到端（第 29 条的回归基线）**

以假的 `ctx.llm` 与假的 `ctx.attachment` 驱动一次完整回合，断言：
消息序列、发出的渲染层事件、工具调用往返、日志内容与投影一致。

**真机冒烟（第 30 条）**

用真实论文与真实模型各跑一次，覆盖：读到全文并答出正文靠后位置的内容；未转换的条目给出正确
提示。以此确认不是只在测试里成立。

## 验收标准

对应计划第 7、8 条（其余各条属后续期）：

1. @ 一篇论文，问它**结论或讨论部分**的内容，答得出来。
2. @ 一篇未转换的论文，明确告知「尚未转换」并给出下一步，而非「找不到」。
3. @ 一个路径越界的文件，明确告知「不在允许范围内」。
4. 关掉开关，旧助手行为与本期改动前**逐字节一致**。
5. `npm run build` 成功且应用能实际启动（不止类型检查通过）。

## 变更文件清单（预计）

**新增**

- `src/main/harness/boot.ts` — 根 context 创建与插件挂载
- `src/main/harness/events.ts` — 事件类型声明与派发模式
- `src/main/harness/seams/llm.ts` — 接口 + 现有 providers 的提供者
- `src/main/harness/seams/attachment.ts` — 接口 + 论文/文件提供者
- `src/main/harness/session/log.ts` — 内存态会话日志
- `src/main/harness/session/derive.ts` — `deriveMessages()` 与不变量断言
- `src/main/harness/assemble.ts` — 上下文装配与预算
- `src/main/harness/tools/registry.ts` — 工具注册与 schema
- `src/main/harness/tools/getItemInfo.ts` — 本期唯一工具
- `src/main/harness/turn.ts` — 回合驱动
- 对应测试文件

**修改**

- `package.json` — 增加依赖
- `electron.vite.config.ts` — externalize 排除
- `src/main/index.ts` — 启动时创建根 context
- `src/main/ipc/handlers.ts` — `knowledge:ask` 按开关路由
- 设置项定义 — 新增 `knowledge.harnessV2`

**不改动**

- `src/main/knowledge/agent.ts` 及旧编排全部文件
- IPC 契约
- 渲染层
