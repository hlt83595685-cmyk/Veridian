# 持久化 @ 引用 + 气泡 chip + 用户气泡改中性 — 设计文档

> 承接 #7:补上 refs 持久化。日期:2026-08-15。

## 目标

1. **持久化 @ 文献/文件/技能引用**:随用户消息存库,重新生成/编辑重问时复用 → 带着原 @ 附件、直接读 md,不再多余 `search_library`。
2. **气泡内 chip**:用户提问上方以 📎 小 chip 显示所附文献标题(独立模块)。
3. **用户气泡改中性浅色**:不再紫底白字。

## 决策(已拍板)
- refs 持久化,重新生成/编辑复用同一批 refs(编辑改文字、附件保留)。
- chip **v1 只显示不可点**。
- 用户气泡:`--surface-2` 底 + `--foreground` 字 + `--border` 细边,保留圆角。

## 数据模型

`messages` 加列 `refs TEXT NOT NULL DEFAULT '[]'`(幂等加列迁移,与 `steps` 同法)。存**带标题的 refs**:
```
StoredRef = { type: 'item'|'file'|'skill'; itemKey?: string; path?: string; name?: string; label: string }
```
- `label`:item→标题(查 items),file→basename,skill→name。后端存时解析,前端 chip 直接用。
- `resolveRefs` 只读 `type` + id 字段,`label` 多余但无害;故 StoredRef[] 可直接当 `KnowledgeRef[]` 喂给 `runTurn`。

## 后端(`agent.ts`)

- 新增 `enrichRefs(refs?: KnowledgeRef[]): StoredRef[]`(解析 label)。
- `ask()` 插入用户消息改为带 refs 列:`INSERT ... (conversation_id, role, content, refs) VALUES (?,?,?,?)`,值 `JSON.stringify(enrichRefs(refs))`。本轮仍用原 `refs` 跑 `runTurn`。
- 新增 `lastUserRefs(convId): KnowledgeRef[]`:读最后一条 user 消息的 refs(JSON parse)。
- `regenerate(convId)`:删末尾 assistant 后 → `runTurn(convId, lastUserRefs(convId), conversationFilter(convId))`(不再传 `[]`)。
- `editLastAndResend(convId, newQuestion)`:**先读**旧 lastUser 的 refs → 删 `id >= lastUser.id` → 插入新 user 消息(content=newQuestion,**refs 沿用旧的**)→ `runTurn(convId, 旧refs, filter)`。
- `MessageRow` 加 `refs: string`;`getMessages`(`SELECT *`)自动带回。

## DB 迁移(`db.ts`)
- `messages` CREATE 加 `refs TEXT NOT NULL DEFAULT '[]'`;`PRAGMA table_info(messages)` 无 `refs` 则 `ALTER TABLE messages ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'`。

## IPC / 类型
- `getMessages`(preload/env)返回类型加 `refs: string`。

## 前端

- `DisplayMessage` 加 `refs?: { type: string; label: string }[]`。
- `refreshMessages`:`refs: JSON.parse(r.refs || '[]')`。
- `send()` 乐观用户消息带 refs:由已提交的 `pendingRefs`(其 `token` 形如 `@标题`)构造 `{ type: p.ref.type, label: p.token.replace(/^[@/]/, '') }`,即时显示 chip。
- `ChatMessageView`:props 加 `refs?`。用户气泡(非编辑态):
  - 提问文字**上方**渲染 chip 行:每个 ref 一个小 chip(📎 SVG + label),`--muted` 色、`--surface-2`/边框、圆角、可截断。
  - 气泡 div 底色改 `--surface-2`、字色 `--foreground`、加 `1px --border`。
- KnowledgePage 渲染处把 `refs={m.refs}` 传给 ChatMessageView。regenerate/editResend 不需传 refs(后端读库);editResend 的乐观更新保留该用户消息原有 refs。

## 错误处理 / 兼容
- 旧消息无 refs 列 → 迁移默认 `'[]'`,parse 得空数组,无 chip,行为不变。
- refs 为空的普通提问:不显示 chip,气泡照常(仅中性色)。
- item 已删除:`enrichRefs` 查不到标题 → label 回退为 itemKey(极少见)。

## 测试
- 纯逻辑少;可为 `enrichRefs` 的 label 回退或乐观 refs 构造抽小纯函数单测(可选)。其余靠 typecheck + `npm run build` + 手动:@ 一篇发问→气泡显示 chip;重新生成→活动流**无 search**、直接基于附件作答;编辑重问→附件保留;刷新对话 chip 仍在;用户气泡为中性浅色。

## 不做(YAGNI)
- chip 不可点(不打开论文);不做 @ 之外的富显示;不改检索/重排/翻译逻辑。
