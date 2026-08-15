# 对话操作:复制 / 重新生成 / 编辑重问 — 设计文档

> 路线图 #7 的前三项(挑核心先做)。日期:2026-08-15。

## 目标

给 AI 对话补上三项常用操作,均**只作用于最后一轮**:
- **复制答案**:一键复制任意助手回答的 markdown 原文。
- **重新生成**:重答最后一条助手回答。
- **编辑重问**:改最后一条自己的提问并重发。

## 范围与决策(已拍板)

- 只作用于**最后一轮**(不改中间历史)。
- **scope(搜索范围)保留**:重新生成/编辑重问沿用该对话已存的 `scope_collection_id`。
- **@ 附件会丢**:原提问的 refs 未持久化,重新生成/编辑重问不带原 @ 附件(v1 不做 refs 持久化)。
- 复制纯前端;重新生成/编辑重问需后端删旧回合 + 重跑。

## 架构

### 后端(`agent.ts`)—— 抽取 `runTurn`,复用于三条路径

现把 `ask()` 里"取 cfg → 构造 messages → 跑工具循环 → 落库助手消息"的部分抽成内部函数:

```
function runTurn(convId, refs?, filter?): void
```
- `getChatConfig()`,null 则 emit error 并返回。
- `messages = [system, ...resolveRefs(refs), ...history(getMessages(convId))]`。
- 原有工具循环(流式 delta、step、落库 assistant 消息、abort 处理)原样搬入。

再抽 scope→filter 解析:
```
function scopeToFilter(scope: number | null): ScopeFilter | undefined   // 现 ask() 内联逻辑
function conversationFilter(convId): ScopeFilter | undefined            // 读会话 scope_collection_id → scopeToFilter
```

三个入口:
- `ask(question, convId, refs, scope)`:建/更新会话+scope → 插入 user 消息 → `runTurn(convId, refs, scopeToFilter(scope))`。(逻辑不变,只是尾部改调 runTurn)
- `regenerate(convId)`:取最后一条消息,若为 assistant 则删除 → `runTurn(convId, [], conversationFilter(convId))`。
- `editLastAndResend(convId, newQuestion)`:`lastUser = MAX(id) WHERE role='user'`;`DELETE FROM messages WHERE conversation_id=? AND id >= lastUser`(删掉最后 user + 其后 assistant)→ 插入新的 user 消息(newQuestion)→ `runTurn(convId, [], conversationFilter(convId))`。

三者都返回 convId,后台跑,走既有 `knowledge.chatDelta/step/chatState` 流式事件。

### IPC
- 契约:`knowledge:regenerate` = `z.tuple([id])`;`knowledge:editResend` = `z.tuple([id, z.string().min(1).max(4000)])`。
- handlers:`Agent.regenerate(convId)` / `Agent.editLastAndResend(convId, q)`。
- preload + env.d.ts:`regenerate(conversationId)` / `editResend(conversationId, question)`。

### 前端

**`ChatMessage.tsx`**:`ChatMessageView` 增加可选 props:`isLast?: boolean`、`onRegenerate?`、`onEditResend?(text)`。
- 助手气泡 hover 显示动作条:**复制**(总有,`navigator.clipboard.writeText(content)`)+ **重新生成**(仅 `role==='assistant' && isLast`)。
- 用户气泡:**编辑**(仅 `role==='user' && isLast`)→ 点击把气泡换成 textarea(预填 content)+ 确认/取消;确认调 `onEditResend(newText)`。
- 动作按钮用与活动流一致的内联 SVG 线性图标,低调、hover 显现。

**`KnowledgePage.tsx`**:
- 渲染 messages 时算出最后一条的 id,给对应 `ChatMessageView` 传 `isLast`。
- `onRegenerate`:本地移除最后一条助手消息、置 busy、调 `knowledge.regenerate(convId)`;流式事件重建回答,`done` 时 `refreshMessages`。
- `onEditResend(text)`:本地把最后一条用户消息内容改为 text、移除其后的助手消息、置 busy、调 `knowledge.editResend(convId, text)`。
- 复用现有 busy/streaming 事件机制,与 `send()` 一致。

## 错误处理
- 无聊天模型:`runTurn` emit `chatState:error, detail:'not_configured'`(与 ask 一致)。
- regenerate/editResend 传入不存在的会话或无历史:后端 guard(无 user 消息则直接返回,不跑)。
- 生成中(busy)时禁用这些按钮,避免并发。

## 测试
- 纯逻辑少;可为"最后一条消息角色判定/删除范围"抽一个小纯函数并单测(可选)。其余靠 typecheck + `npm run build` + 手动验证:复制得到原文;重新生成换新答案且保留 scope;编辑重问改问题后重答;三者流式与折叠/引用/活动流正常。

## 不做(YAGNI)
- 不做任意历史消息的重生成/编辑;不持久化 refs(@ 附件);不做导出/追问建议/切模型/token 统计(#7 其余项,以后)。
