# 命中片段截断优化(可配置 + 边界截断)— 设计文档

> 路线图 #6。日期:2026-08-13。

## 目标

`search_library` 交给模型的命中片段目前是 `8 条 × slice(0, 700)` 硬切,会把关键数值/表格拦腰切断。改为:**按语义边界截断**(不切碎句子/段落),并把"命中条数"与"每条摘录长度"做成**可在 AI 设置里调**的参数。默认值本身就改善(6 条 × 1200 字、边界截断)。

## 范围与决策(已拍板)

- 两个可配置参数,**仅此两个**(避免设置项泛滥):
  | 设置 key | 含义 | 默认 | 钳制范围 |
  |---|---|---|---|
  | `knowledge.search.resultCount` | 返回给模型的命中条数 | 6 | 1–12 |
  | `knowledge.search.excerptChars` | 每条摘录最大字数(按边界截断) | 1200 | 200–4000 |
- **边界截断**:在上限前的最后一个段落/句子边界处切;没有合适边界(会切掉超过一半)则硬切到上限。
- 默认即改善:不改设置也从 `8×700 硬切` 变为 `6×1200 边界截断`。

## 架构

### 纯函数 `truncateAtBoundary`(新文件 `src/main/knowledge/truncate.ts`)
```
export function truncateAtBoundary(text: string, max: number): string
```
- `text.length <= max` → 原样返回。
- 否则取 `slice(0, max)`,优先在最后一个 `\n\n` 处切;否则在最后一个句末标点(`。！？.!?` 或 `\n`)处切;两者都要求切点 ≥ `max * 0.5`(否则等于丢掉大半,不值),达不到就硬切到 `max`。`trimEnd()` 收尾。

### 设置读取(`agent.ts`)
- 新增 `tunedInt(key, def, min, max)`:读 `getSetting(key)`,转数字并钳制到 `[min,max]`,非法/缺省用 `def`。
- `runTool` 的 `search_library` 分支:
```
const count = tunedInt('knowledge.search.resultCount', 6, 1, 12)
const chars = tunedInt('knowledge.search.excerptChars', 1200, 200, 4000)
const hits = await hybridSearch(wsId(), q, count, filter)
... hits.map(h => `[${h.itemKey}:${h.seq}] (${h.headingPath||'text'})\n${truncateAtBoundary(h.text, chars)}`) ...
```
  即 `8`→`count`、`slice(0,700)`→`truncateAtBoundary(h.text, chars)`。

### 设置可写(`handlers.ts`)
- 把两个 key 加入 `RENDERER_WRITABLE_SETTINGS` 白名单(否则渲染层写入被拒)。

### 设置 UI(`KnowledgeSettingsTab.tsx`)
- 新增一个"检索"小节,两个数字输入(检索结果数 / 摘录长度)。
- `loadAll()` 里 `settings.get` 载入两值(缺省显示默认);`onChange` → setState + `saveField(key, Number(v))`。
- i18n 标签(`i18n/index.ts` 的 zh/en,`settings.knowledge` 段)。

## 影响面
- chunker/indexer/检索/重排/翻译/范围过滤全部不动;只改"命中片段如何格式化给模型"这一步。
- 值缺省时行为由默认值决定(6/1200),已装用户无需迁移(纯读取,键不存在即用默认)。

## 测试
- Vitest 单测 `truncateAtBoundary`:短文本原样、句末切、段落切、无边界硬切、CJK 句末切。
- `tunedInt` / UI / 设置读写靠 typecheck + 手动验证(设置改数值后搜索行为随之变化)。

## 不做(YAGNI)
- 不加第三个参数、不做总字数预算模式、不加"是否边界截断"开关(边界截断恒为默认行为)。
- 不碰检索/重排/翻译/范围逻辑。
