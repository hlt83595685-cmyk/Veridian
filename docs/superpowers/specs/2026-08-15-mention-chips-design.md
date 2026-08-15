# @ 提及改为 chips 区(输入即成 chip + 气泡内 chip)— 设计文档

> 承接持久化 refs。日期:2026-08-15。

## 目标

- **输入区**:选中 @ 文献(或 / 技能)后,不再在 textarea 里留"@标题"文字,而是在输入框内以可删除的 **📎 标题 ×** chip 显示;textarea 只留自由文字。
- **气泡**:发送后 chip 显示在**气泡内部**(顶部),问题文字在下;**去掉气泡上方的独立 chip 模块**。
- 采用"chips 区 + textarea"标准做法,不上 contenteditable。

## 决策(已拍板)
- chips 区方案(不在句子文字流中内联)。
- @ 与 / 提及都变 chip(都走 pendingRefs)。
- chip 可点 × 移除;发送后清空。

## 架构(全前端)

### 可复用组件(新增,供本功能与后续复用)

新增 `src/renderer/src/components/knowledge/Chip.tsx`:
- `Chip({ label, icon?, onRemove?, onClick?, title?, size?, maxWidth? })`:统一的小药丸——`inline-flex`,`--muted-bg`/`--border`,可选前置 icon、末尾 × 删除按钮、整体点击;label 溢出省略。`onRemove` 存在则显示 ×;`onClick` 存在则整体可点。`size?: 'sm'|'md'` 控制字号/内距。
- `PaperclipIcon()`:统一的 📎 线性 SVG(currentColor)。
- 输入区 chip = `<Chip icon={<PaperclipIcon/>} label onRemove/>`;气泡 chip = `<Chip icon={<PaperclipIcon/>} label/>`(无 ×)。后续任何需要"标签/引用/过滤"小块的功能直接复用 `Chip`。

### `KnowledgePage.tsx`

- **`PendingRef`** 由 `{ ref, token }` 改为 `{ ref: KnowledgeRef; label: string }`(label 供 chip 显示)。
- **`applyMention(cand)`**:
  - 从输入删除正在输入的 `@query`/`/query`:`before = input.slice(0, mention.start)`;`after = input.slice(cursor)`;`setInput(before + after)`。
  - 加 chip:`setPendingRefs((prev) => 去重后 [...prev, { ref: cand.ref, label: cand.label }])`(按 ref 身份去重:item→itemKey、file→path、skill→name)。
  - `setMention(null)`,重新聚焦并把光标放到 `before.length`。
  - **不再插入 `@标题` 文字。**
- **`detectMention`**:保留检测 `@([^@\n]*)$`/`/(\S*)` 以弹下拉;**删掉"已提交 token"判断**(现在选中即从文字里删掉 @query,不会残留触发)。
- **`send()`**:`refs = pendingRefs.map((p) => p.ref)`;`content = input.trim()`;`sentRefs = pendingRefs.map((p) => ({ type: p.ref.type, label: p.label }))`;发完 `setInput('')` + `setPendingRefs([])`。(删除原"按 token 是否还在文字里过滤"的逻辑。)
- **chips 区 UI**:在输入列(scope select 与 textarea 之间)渲染 `pendingRefs` 的 chip 行(flex-wrap):每个 `📎 label ×`,点 × `setPendingRefs((prev) => prev.filter((_, i) => i !== idx))`。仅 `pendingRefs.length > 0` 时显示。

### `ChatMessage.tsx`(气泡)
- **删除**上一版加在气泡**上方**的 chips 行(`refs && refs.length > 0` 那个独立 `<div>`)。
- 在用户气泡 **bubble div 内部**顶部渲染 chip 行(refs 存在时),问题文字在其下。chip 用适配气泡底(surface-2)的样式:`background: var(--surface)`、`border: 1px var(--border)`、`color: var(--foreground-3)`、📎 SVG + label、可截断。

## 兼容 / 边界
- 输入无自由文字但有 chip:发送按钮仍要求 `input.trim()` 非空(保持需要问题文字)。
- 同一文献重复 @:去重,不加第二个 chip。
- 删除某 chip:仅从 pendingRefs 移除,不影响 textarea 文字。
- 后端不变:`ask(content, conv, refs, scope)` 照旧;refs 持久化/复用/重新生成逻辑不变。

## 测试
- 纯逻辑少;可为 pendingRefs 去重或 applyMention 的 `before+after` 文本删除抽小纯函数单测(可选)。其余靠 typecheck + `npm run build` + 手动:选 @ → 输入框出现 chip、textarea 无"@标题"文字;× 可删;发送后气泡**内**显示 chip、上方无独立模块;多词搜索、/ 技能同样成 chip。

## 不做(YAGNI)
- 不上 contenteditable(不在句子内联渲染 chip)。
- 不改后端 / 检索 / 引用逻辑。
