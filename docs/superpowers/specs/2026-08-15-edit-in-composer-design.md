# 编辑消息改为"载回主输入框" — 设计文档

> 修正内联编辑的局限(编辑时无 @、chip 不可删)。日期:2026-08-15。

## 目标

点用户消息的"编辑" → 把该消息的**文字载回主输入框**、**附件载回输入框 chip**,进入编辑模式;用户在主 composer 里用**完整功能**(@ 加文献、× 删 chip、改文字)修改,发送即**替换原来那一轮**。去掉气泡内联小编辑框。

## 决策(已拍板)
- 编辑复用主 composer(不在气泡内编辑)。
- 未发送/取消前不删库;发送时后端删旧轮+插入新的+重跑。
- 发送用编辑后**当前**的文字与附件(可能增删了 @)。

## 数据

- `DisplayMessage.refs` 由 `{ type; label }[]` 扩为携带 id 字段的完整形:
  `Array<{ type: 'item'|'file'|'skill'; itemKey?: string; path?: string; name?: string; label: string }>`(即持久化的 StoredRef 形状)。chip 显示仍用 `label`;编辑时用 id 字段重建 `pendingRefs`。
- `send()` 乐观消息的 refs 改为 `pendingRefs.map((p) => ({ ...p.ref, label: p.label }))`(完整形)。

## 后端(`agent.ts` + IPC)

- `editLastAndResend(conversationId, newQuestion, refs?, scopeCollectionId?)`:
  - `lastUser = MAX(id) role='user'`;无则返回。
  - `UPDATE conversations SET scope_collection_id = ?`(= scopeCollectionId ?? null)。
  - `DELETE FROM messages WHERE conversation_id=? AND id >= lastUser.id`。
  - 插入新 user 消息:content=newQuestion,refs=`JSON.stringify(enrichRefs(refs))`。
  - `runTurn(conversationId, refs, scopeToFilter(scopeCollectionId ?? null))`。
  - (即"编辑版 ask":用**新** refs + scope,而非旧存的。)
- IPC `knowledge:editResend` 契约/handler/preload/env 增参:`(id, question, refs?, scope?)`,与 `knowledge:ask` 的 refs/scope 校验一致。

## 前端(`KnowledgePage.tsx`)

- 新增状态 `const [editing, setEditing] = useState<number | null>(null)`(正在编辑的消息 id)。
- `startEdit(msg)`:
  - `setInput(msg.content)`;`setPendingRefs(msg.refs 重建为 { ref, label })`(item→{type,itemKey}、file→{type,path}、skill→{type,name});`setEditing(msg.id)`。
  - 从**本地列表**移除该消息及其后(它的回答):`setMessages((prev) => prev.slice(0, idx))`(未删库)。
  - 聚焦 textarea。
- `cancelEdit()`:`setEditing(null)`;清空 input/pendingRefs;`refreshMessages(convId)` 恢复列表。
- `send()`:若 `editing !== null` 则走 `knowledge.editResend(convId, q, refs?, scope)`(不改 conversationId);否则原 `knowledge.ask(...)`。发送前照常清空 input/pendingRefs/editing 并乐观追加。
- composer:
  - 发送按钮:编辑态显示 `t('knowledge.update')`(更新),否则 `发送`。
  - 编辑态在输入区显示一个"取消编辑"小按钮 → `cancelEdit()`。
- 渲染:给最后一条用户消息的 `ChatMessageView` 传 `onEdit={() => startEdit(m)}`(取代旧 `onEditResend`)。

## 前端(`ChatMessage.tsx`)

- **删除**气泡内联编辑:去掉 `editing`/`draft` 状态、编辑态 `<textarea>` 分支、`onEditResend` prop。
- 用户气泡:只显示 chips(内部)+ 文字;最后一条用户消息 hover 显示"编辑"按钮 → 调 `onEdit?.()`。
- 新 prop:`onEdit?: () => void`(替换 `onEditResend`)。

## 错误处理 / 兼容
- 编辑态取消 → refreshMessages 完整恢复(未删库,安全)。
- 编辑态发送但 busy → 复用 busyRef 守卫。
- 旧消息 refs 为空 → pendingRefs 为空,编辑就是纯文本改。
- 后端 `regenerate` 不变(仍用存的 refs)。

## 测试
- 纯逻辑少;`msg.refs → pendingRefs` 重建、`{...ref,label}` 乐观形可抽小纯函数单测(可选)。其余靠 typecheck + `npm run build` + 手动:编辑 → 文字+chip 载入输入框;可 @ 加、× 删、改字;更新替换该轮、带新附件直接读 md;取消恢复原样;普通发送不受影响。

## 不做(YAGNI)
- 不做任意历史消息编辑(仍最后一轮)。
- 不改 regenerate/检索/引用逻辑。
