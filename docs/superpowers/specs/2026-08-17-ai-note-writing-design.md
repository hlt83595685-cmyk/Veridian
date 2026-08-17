# AI 笔记写作能力扩展 — 设计

> 状态:已确认,待写实现计划。日期:2026-08-17。
> 前置:P1(写工具地基 + `relations` 边表 + 一等公民 `notes`)、模式路由、P2-A(双链 `[[ ]]` + `NoteService.saveNote` 对账反链)均已并入 `main`。

## 目标

让 AI 助手成为笔记的一等作者:能建**独立概念笔记**、能创建/**整体重写**论文笔记,且**所有 AI 写入统一走 `NoteService.saveNote`**,使 AI 正文里的 `[[双链]]` 自动对账成反向链接边、融入(未来 P3 的)知识图谱。悬空链接保持悬空,不自动建空壳。

顺带修掉 P2-A 的一个遗留:AI 目前经旧 `createNote` 通道写笔记,其 `[[链接]]` 不建边;切到 `saveNote` 后自动建边。

## 决策记录(brainstorm 结论)

- 能力范围:A 建独立概念笔记 + B 更新已有笔记 + C 走 `saveNote` 自动建反链,**三者全做**。
- 悬空链接:**保持悬空**(未解析显示灰色虚线,不自动生成空壳笔记)。
- 更新语义:**允许整体重写**(非仅追加);工具描述软约束 AI「先读后写」。
- 工具形态:**显式按 id**——读工具回笔记 id,`update_note` 按 id 重写(多笔记无歧义)。

## 非目标(本轮不做)

- 导入后自动生成笔记/解读流水线(= P4)。
- 反向链接上下文摘要(单独议题,本轮未选)。
- 知识图谱可视化(= P3)。
- 追加(append)模式(用户选了整体重写)。
- 悬空 `[[链接]]` 自动建空壳笔记。

## 架构与改动

改动集中在主进程:`src/main/knowledge/agentTools.ts`(工具定义+执行)、`src/main/knowledge/toolRegistry.ts`(模式门控)、`src/main/knowledge/modes.ts`(模式工具集)、`src/main/services/NoteService.ts`(`saveNote` 加 origin 参数)。渲染层无改动。

### 1. Service 层:`NoteService.saveNote` 加 origin

现状:

```typescript
export function saveNote(input: { id?: number; itemId?: number | null; title?: string | null; content?: string | null }): number
```

create 分支把 `origin` 写死 `'user'`,update 分支 `updatedBy: 'user'`。

改为接受可选 origin(默认 `'user'`,保持现有调用行为不变):

```typescript
export function saveNote(input: {
  id?: number; itemId?: number | null;
  title?: string | null; content?: string | null;
  origin?: 'user' | 'ai'
}): number
```

- create 分支:`repoCreate({ ..., origin: input.origin ?? 'user' })`。
- update 分支:`repoUpdate(id, { ..., updatedBy: input.origin ?? 'user' })`。
- 链接对账(`resolveTargets` + `setWikilinksForNote`)与事件发射逻辑**不变**。

渲染层现有 `notes:save` IPC 不传 origin → 仍是 `'user'`,行为不变。AI 走的是主进程内部直接调用 `saveNote`(经 agentTools),传 `origin: 'ai'`。

### 2. 工具面:`agentTools.ts`

现状相关工具:`create_note`(强制绑定论文,走旧 `createNote`,`origin='ai'`)、`read_notes`(按论文列笔记,回标题+正文,**无 id**)。

改动:

**`create_note`(改)**
- 参数:`{ paper?: string; title?: string; content: string }`。
  - 给了 `paper`(论文 key,按标题/doi 解析,复用 `resolveItem`)→ 论文笔记(`itemId` = 该论文 id)。
  - 省略 `paper` → 独立概念笔记(`itemId` 为 null);此时 `title` **必填**(作为身份),缺失则报错返回提示。
- 执行:`saveNote({ itemId?, title, content, origin: 'ai' })`,返回 `note added ...`(含新笔记 id)。
- 描述更新:说明可建独立概念笔记;正文里可用 `[[标题]]` 关联其它笔记/论文。

**`update_note`(新增)**
- 参数:`{ note_id: number; title?: string; content?: string }`。
- 执行:先校验笔记存在(`getNote(note_id)`,不存在则报错);再 `saveNote({ id: note_id, title, content, origin: 'ai' })` 整体重写给定字段,重建链接边。
- 描述软约束:先用 `read_notes`/`list_notes` 读到当前内容再覆盖,避免误删用户手稿。

**`read_notes`(改)**
- 输出每篇笔记补上 **id**(如 `- [id 12] 标题: 正文…`),让 AI 拿到 id 去 `update_note`。

**`list_notes`(新增)**
- 无参(或可选标题过滤)。列出所有**独立概念笔记**(`item_id IS NULL`)的 id + 标题(复用 `NoteService.listStandaloneNotes`)。
- 让 AI 能找到某概念页去更新,或确认某标题是否已存在(避免重复建页)。

### 3. 模式路由:`modes.ts` / `toolRegistry.ts`

- `notes` 模式的工具集加入 `update_note`、`list_notes`(`create_note`、`read_notes` 已在)。
- 写工具仍不出现在 `qa` 等模式;`toolRegistry` 的 `buildTools` 按模式门控,`runTool` 结构性拒绝未广告工具(P1 已有,无需改)。
- 其它模式(classify/tag/review/compare/contradict)是否加这些笔记写工具:**不加**,保持各模式职责单一;仅 `notes` 模式承载笔记写作。

### 4. 溯源与安全

- AI 笔记 `origin='ai'`、`updated_by='ai'`;`saveNote` 内 `appendOp('note', …)` 已记 oplog。
- 允许整体重写(按用户选择),不硬性拦截;`update_note` 描述引导「先读后写」。

## 数据流(示例)

用户在 `notes` 模式问「给『对比学习』建一篇概念笔记,并关联到 SimCLR 那篇论文」:
1. AI 调 `list_notes` 确认无同名概念页 → 调 `create_note({ title: '对比学习', content: '… 见 [[SimCLR]] …' })`。
2. `create_note` → `saveNote({ title:'对比学习', content, origin:'ai' })`:建独立笔记(`item_id=null`)→ `resolveTargets` 解析 `[[SimCLR]]`(标题不敏感匹配到论文)→ `setWikilinksForNote` 建 `note→item` 边。
3. 打开 SimCLR 论文详情"笔记"标签 → 反向链接显示「📝 对比学习 · wikilink」。

## 测试

Service 单测(`NoteService` / `notes` / `relations`,DB 测按 Electron ABI 跳过、逻辑由现有同款测试覆盖):
- `saveNote({ origin:'ai' })` 建的笔记 `origin='ai'` 且仍正确对账 `[[链接]]` 边。
- `create_note` 无 `paper` → `item_id=null` 的独立笔记 + 建边;有 `paper` → 绑定论文。
- `update_note` 整体重写后:旧 wikilink 边被清、新边被建(复用 `setWikilinksForNote` 删+插语义)。
- `read_notes` 输出含 id;`list_notes` 只回独立笔记。

agentTools 单测(`agentTools.test.ts`,若其 mock 了 service):为 `create_note`(独立分支)、`update_note`、`list_notes` 加用例,断言分派到正确 service 调用与错误处理(缺 title、note 不存在)。

## 验证

`npx tsc -p tsconfig.node.json --noEmit`、`npx vitest run` 全绿;因改动在主进程逻辑层、无渲染打包面,`npm run build` 非必需但顺带跑一次无妨。
