# Veridian AI 助手 · 模式路由重构(含 #8)—— 设计

日期:2026-08-17
状态:设计已对齐,待审阅 → writing-plans

---

## 1. 背景与目标

P1 给了 AI 写能力后,出现反复的**工具选择跑偏**:问答时误用 `list_items`/写工具、忽略检索范围、答案没来源。根因是**靠单一 base prompt 反复堆规则去引导模型选工具,不可靠**(一次会话改了 4 轮才勉强稳)。

本重构把助手行为按**模式(mode)**拆开,用**代码级路由 + 工具门控**从结构上杜绝跑偏,而不是靠提示劝;并顺带落地 **#8**(综述/对比/找矛盾/批量分类)。

**成功标准**
- `qa` 模式下模型**根本拿不到** write 工具与 `list_items` → "问答误写/用清单编答案"不可能发生。
- base prompt 瘦身、不再自相矛盾;每个模式的流程独立可调。
- 综述/对比/找矛盾/分类 可经预置按钮一键触发(#8)。
- 现有问答、@提及、scope、引用、停止/重生成/编辑重发全部不回归。

**非目标(后续阶段)**:自动检测升级为小模型分类;图谱可视化(P3);自动解读流水线(P4);用户 SKILL.md 市场保持现状不动。

---

## 2. 核心架构:模式路由器

每个模式是代码里的一条定义:

```ts
export interface AgentMode {
  id: ModeId            // 'qa' | 'classify' | 'tag' | 'review' | 'compare' | 'contradict' | 'notes'
  label: string         // 按钮/UI 文案(i18n key)
  keywords: RegExp | null   // 自动检测;null = 不参与自动检测(只能显式)
  tools: string[]       // 本模式暴露的工具名(门控)
  procedure: string     // 追加到瘦身 base prompt 之后的本模式流程说明
  button: boolean       // 是否在 composer 出预置按钮
}
```

**路由(混合)**:`routeMode(message, explicitModeId?)`
- `explicitModeId` 存在(用户点了按钮)→ 直接用该模式(100% 确定)。
- 否则按各模式 `keywords` 对 message 做**关键词匹配**;命中则用该模式,**匹配不到默认 `qa`**(只读、安全兜底)。
- 关键词自动检测即时、零成本;重任务走按钮=可靠。日后可把自动档升级为一次小模型分类调用(接口不变)。

**工具门控**:`runTurn` 用 `mode.tools` 从**工具注册表**取 ToolDef 组成本回合工具集。`qa` 的工具集里没有写工具、没有 `list_items`,模型无从调用。

---

## 3. 模式 / 工具门控表(v1)

| 模式 | 自动关键词(示例) | 按钮 | 暴露工具 | 流程要点 |
|---|---|---|---|---|
| **qa** 问答(默认) | (兜底,无需匹配) | — | search_library, read_item, read_context, get_item_info | 从正文作答 + `[^key:seq]` 引用,受 scope |
| **classify** 分类归档 | 分类/归档/整理到/classify/organize | ✓ | list_items, read_item, search_library, list_collections, add_to_collection | 列范围 → 判类 → 批量 add_to_collection → 汇总"处理 N/剩 M" |
| **tag** 打标签 | 打标签/标签/tag | ✓ | list_items, read_item, list_tags, add_tags | 列范围 → 抽主题词 → add_tags → 汇总 |
| **review** 综述 | 综述/概述/review/overview | ✓ | list_items, read_item, search_library, get_item_info, create_note | 读多篇 → 结构化综述 →(经确认)存为笔记 |
| **compare** 对比 | 对比/比较/compare | ✓ | 同 review | 读多篇 → 生成对比表 |
| **contradict** 找矛盾 | 矛盾/冲突/contradict | ✓ | 同 review | 读多篇 → 列冲突点(带出处) |
| **notes** 笔记/建链 | 笔记/建链/关联/note/link | ✓ | search_library, read_item, list_items, create_note, link_items, read_notes | 生成摘要笔记 / 在相关论文间建链 |

说明:
- `load_skill`(用户 SKILL.md 市场)在**所有模式**保留(仅当安装了用户 skill 时挂上),与内置模式并存互不干扰。
- review/compare/contradict 工具集相同 → 实现为"一个 analyze 家族、三套 `procedure`"。
- 所有模式的检索/枚举工具(search_library、list_items)**继续遵守 scope**(P1 已实现的 filter 透传)。

---

## 4. base prompt 瘦身

`BASE_SYSTEM_PROMPT` 只保留与模式无关的核心规则:
- 附件(@paper/@file)优先直接作答、不加引用标记;
- 回答只从库内**正文**(不得凭常识、不得只凭标题);search_library 命中用 `[^item_key:seq]` 引用;
- 用用户语言作答;数学一律 LaTeX;
- 简洁、数字照抄。

当前 base prompt 里的"Library actions / list_items / read_item / 分类流程"等**全部移出**,分散进各模式 `procedure`。这消除现有提示的臃肿与自相矛盾。

---

## 5. 接线

**主进程**
- 新增 `src/main/knowledge/modes.ts`:`MODES: AgentMode[]`、`ModeId`、`routeMode()`、`getMode(id)`。
- **工具注册表**:把现有 `BASE_TOOLS`(agent.ts)与 `AGENT_ACTION_TOOLS`(agentTools.ts)按名登记为 `TOOL_REGISTRY: Record<string, ToolDef>`(单一出处),`buildTools(mode)` = `mode.tools.map(name => TOOL_REGISTRY[name])` +(有用户 skill 时)`LOAD_SKILL_TOOL`。
- `agent.ts`:`runTurn(convId, refs, filter, mode)`:`tools = buildTools(mode)`;`system = SLIM_BASE_PROMPT + '\n\n' + mode.procedure`(+ 用户 skill 目录)。`ask/editLastAndResend/regenerate` 接受 `modeId`;`ask` 经 `routeMode` 解析后把 mode 存到 conversation。
- **持久化**:conversation 增列 `mode_id TEXT`(幂等迁移,像 `scope_collection_id`);`regenerate` 复用该列。

**IPC / 桥接**
- `src/shared/ipc-contract.ts`:`knowledge:ask` / `knowledge:editResend` 增可选 `modeId?: string`(zod 校验)。
- `handlers.ts`、`preload/index.ts`、`renderer/src/env.d.ts` 随之。

**渲染器**
- `KnowledgePage.tsx` composer 上方加一排预置按钮(带按钮的模式);点击设 `activeMode` 并传给 `ask/editResend`;显示活动模式 + 取消;发送后回自动。
- 复用现有 `Chip` 组件风格。

---

## 6. 失败与边缘

- 自动关键词**误判**:偏保守——只有明确管理动词才切管理模式,否则 `qa`(只读、无副作用);用户可用按钮纠正。
- 管理模式被路由但**该动作工具没暴露**不会发生(工具集由模式定义,自洽)。
- 模型在某模式里**调用未授权工具**:不可能——工具压根没进本回合 tools。
- `mode.tools` 里**写错工具名**:由单测(注册表校验)在构建期抓出。
- 旧会话无 `mode_id`:默认 `qa`。

---

## 7. 测试

- `modes.test.ts`:`routeMode` — 关键词命中各模式 / 显式 `modeId` 覆盖 / 无匹配默认 `qa`。
- 工具注册表:每个 `mode.tools` 名都能在 `TOOL_REGISTRY` 解析(无悬空名)。
- 现有 `agentTools.test.ts` / 其它 agent 测试保持绿。
- 手动冒烟:qa 提问(轨迹只有 search/read,无写)、点"分类"按钮跑分类、点"综述"出综述、打字"帮我把这些打标签"自动进 tag 模式。

---

## 8. 实现分期(单一 spec 内,顺序)

1. **模式基建**:`modes.ts` + `TOOL_REGISTRY` + `runTurn` 门控 + base prompt 瘦身 + `qa` 模式(达到"问答与今天等价、但结构上不跑偏")。
2. **接线**:conversation `mode_id` 迁移 + IPC/preload/env + `routeMode` 自动检测 + `ask/editResend/regenerate` 贯通。
3. **渲染器**:composer 预置按钮 + 活动模式指示。
4. **管理模式**:classify / tag / notes 的 `procedure` 与工具集。
5. **#8 分析模式**:review / compare / contradict + 按钮。

---

## 9. 已锁定决策

1. 代码级意图路由 + 工具门控(而非纯提示引导)。
2. 混合触发:默认关键词自动检测(兜底 qa)+ 重任务预置按钮。
3. v1 模式集:qa(默认)+ classify + tag + review + compare + contradict + notes。
4. 内置模式以**代码**定义(关键词 + 工具集 + procedure);用户 SKILL.md 市场保持不动、各模式仍可 `load_skill`。
5. base prompt 瘦身,模式专属流程移入各 `procedure`。
6. 模式存于 conversation(`mode_id`),regenerate 复用。

## 10. 待各期细化的开放项

- 各模式 `procedure` 的具体措辞(实现时定稿)。
- 关键词表的最终词汇与多语覆盖。
- 综述/对比结果是否默认存为笔记 vs 仅展示(倾向:展示 + 询问是否存)。
- 自动检测是否/何时升级为小模型分类(接口已预留)。
