# 检索范围(用户手动 + 每对话记忆)— 设计文档

> 路线图 #5(缩窄为"用户手动范围",按分类)。日期:2026-08-13。

## 目标

在 AI 对话里给用户一个可选的"搜索范围"选择器,把 `search_library` 的检索限定到某个**分类**(collection)或全库。范围**按对话记忆**:切换/重开对话时恢复各自的范围。与现有 @ 提及**完全兼容、正交**。

## 范围与决策(已拍板)

- **用户手动范围**,不做 AI 自动过滤(路线图 B 留待以后)。
- **仅按分类**过滤(不含年份/作者),**不递归子分类**(只算所选分类的直接成员)。
- **可选**:默认 `null` = 全库;"不选"就是当前行为。
- **每对话记忆**:范围存在 `conversations.scope_collection_id`。
- **与 @ 提及兼容**:@ 提及走 `resolveRefs` 注入指定文献全文,**与范围无关、一字不改**;范围只加在"搜索库"这一步。即使 @ 的文献在范围之外,agent 仍能读到它。

## 跨库要点(关键)

分类成员表 `collection_items(collection_id, item_id)` 在**主库 DB**(`getDb()`);chunks 在**知识库 DB**(`getKnowledgeDb()`),两个独立 sqlite 文件,无法一条 SQL join。做法:

1. `ask()` 里用主库把 `collectionId → item_id[]` 解析出来(`SELECT item_id FROM collection_items WHERE collection_id = ?`)。
2. 把 `filter = { itemIds }` 透传给知识库侧的 `hybridSearch` → `ftsSearch`/`vectorSearch`,加 `chunk.item_id IN (...)`。

## 架构与数据流

```
KnowledgePage 选择器(全库/分类)
  └─ scope: collectionId | null  ──随 knowledge:ask 传──▶ handlers ─▶ Agent.ask(q, convId, refs, scopeCollectionId)
        ├─ 持久化: conversations.scope_collection_id = scopeCollectionId(建/更新)
        ├─ 解析: collectionId → itemIds (主库 collection_items)
        └─ 工具循环: runTool(name, args, {itemIds}) ─▶ search_library ─▶ hybridSearch(ws, q, topK, {itemIds})
                                                                          └─ ftsSearch/vectorSearch: AND item_id IN (itemIds)
切换对话: listConversations 返回 scope_collection_id ─▶ 选择器恢复该对话的范围
```

### 过滤语义
- `filter` 为 `undefined`(全库)→ 行为与现状一致。
- `filter.itemIds` 为空(分类为空 / 分类已删)→ `hybridSearch` 短路返回 `[]`,agent 收到 "no results"。
- `itemIds` 来自 DB 的可信整数,内联进 `IN (...)` 安全。

### 持久化 & 恢复
- `conversations` 加列 `scope_collection_id INTEGER`(null=全库)。schema 无版本迁移,用**幂等加列迁移**:`PRAGMA table_info(conversations)` 检查后 `ALTER TABLE ... ADD COLUMN`;同时把该列加进 `CREATE TABLE`(新库自带)。
- `ask()`:新对话 `INSERT ... scope_collection_id`;已有对话每次发消息 `UPDATE conversations SET scope_collection_id = ?`(选择器改了就跟着更新)。
- `listConversations()` 返回 `scope_collection_id`,UI 切换对话时据此恢复选择器;若该分类已被删除(不在 collections 列表里)→ UI 回落到"全库"。
- 新对话默认 `null`(全库)。

## 兼容性(显式)
- `resolveRefs`(@ 提及注入全文)**不改**。范围与 @ 正交、可叠加:范围选"深度学习" + @ 一篇范围外论文 → agent 同时拥有该论文全文 + "深度学习"内搜索结果。
- 未选范围(null)时,`hybridSearch(ws, q, topK)` 不传 filter,行为与今天完全一致。

## 涉及文件
- `src/main/knowledge/db.ts` — conversations 加列 + 幂等迁移。
- `src/main/knowledge/search.ts` — `hybridSearch`/`runQuery`/`ftsSearch`/`vectorSearch` 加可选 `filter`。
- `src/main/knowledge/agent.ts` — `ask()` 加 `scopeCollectionId`;解析 itemIds;`runTool` 透传;持久化 scope;`listConversations` 返回 scope。
- `src/shared/ipc-contract.ts` / `src/preload/index.ts` / `src/renderer/src/env.d.ts` — `knowledge:ask` 加 scope 参数;`listConversations` 返回类型加 `scope_collection_id`。
- `src/renderer/src/components/knowledge/KnowledgePage.tsx` — 范围选择器 + 载入分类 + 切换恢复 + 传 scope。

## 测试
- 纯逻辑单测有限。加一个 `filterClause` 小纯函数(给定 itemIds → SQL 片段或空)并单测其边界(空数组、正常),其余 DB/IPC/UI 靠手动在 app 内验证。
- 手动验证:选分类后搜索只命中该分类;选全库/不选=现状;@ 提及在范围内外都能被读到;切换对话范围能恢复。

## 不做(YAGNI)
- 不做年份/作者过滤、不做 AI 自动过滤、不做多选条目、不递归子分类。
- 不碰 chunker/indexer/重排/翻译/`resolveRefs`。
