# AI 助手 — 下阶段任务路线图

> 基于对当前实现的通读(`src/main/knowledge/*` + `src/renderer/src/components/knowledge/*`)与 GitHub 同类项目(RAG-Assistant-for-Zotero、papersgpt-for-zotero、zotero-rag-assistant)及 2025–2026 RAG 实践的对照,归纳出的改进方向。按**影响力从大到小**排。
>
> 最后更新:2026-08-12

## 现状盘点(已具备)

- **混合检索**:FTS5 BM25 + 向量 KNN,用 RRF 融合(`search.ts`)
- **事件驱动增量索引**:FTS 先行(离线可用)+ 云端嵌入补齐(`indexer.ts`)
- **工具循环 Agent**:8 轮上限,3 个只读工具 + `load_skill`(`agent.ts`)
- **行内引用** `[^key:seq]` + 可点击跳转来源(`ChatMessage.tsx`)
- **@/‍/ 提及**:@ 条目/文件、/ 技能(`KnowledgePage.tsx`)
- **技能市场**:Anthropic Agent Skills 规范,zip/GitHub 安装(`skills.ts`)
- **公式渲染**:KaTeX,含 `\tag` 兜底改写(✅ 已完成,见下)

---

## ✅ 已完成

- **对话内 LaTeX 公式渲染**:聊天气泡接入 `remark-math` + `rehype-katex`;归一化 `\(...\)` / `\[...\]` 定界符;`\tag{X}` → `\quad (X)` 兜底(避免 "\tag works only in display equations");系统提示要求模型用 `$...$` / `$$...$$` 输出数学。

---

## 第一梯队 — 结构性短板(投入产出比最高)

### ~~1. PDF 原文兜底索引~~ ❌ 已放弃(2026-08-13)
- 原设想:给未转换的 PDF 建原文兜底索引,实现"导入即可问"。
- **放弃原因**:用户工作流是「导入 → 转 md(第一步)→ 再提问」,不会对未转换的 PDF 提问;且库中每篇 PDF 最终都会转 md,不存在"长期停留未转换"的条目。核心卖点不成立,砍掉。

### 2. 检索重排序(reranking)
- **问题**:`hybridSearch` 拿 RRF 融合后直接 `slice` top-8 给模型,无重排。
- **目标**:准确率 +10~40%。
- **做法**:`search.ts` 已 over-fetch 30 个候选(`CANDIDATES = 30`),插入点现成。轻量版用现有 chat 模型做 LLM 重排打分;进阶接 rerank API(Jina/Cohere,OpenAI 兼容)。
- **工作量**:小–中。

### 3. 引用跳转到 PDF 页码/位置
- **问题**:`resolveCitations` 只解析到 `itemKey → itemId + title`,`seq` 是 Full.md 的 chunk 序号,不映射 PDF 页码。点引用只能打开 Markdown,定位不到原文位置。
- **目标**:点引用直达论文对应页(可核查性分水岭)。
- **做法**:chunk 建索引时记录页码/字符偏移,点击 → 阅读器定位。
- **工作量**:中。

---

## 第二梯队 — 检索质量

### 4. 查询改写 / 多查询 / HyDE
- **问题**:召回完全依赖模型自己把 `search_library` 的 query 写好。
- **做法**:检索前做同义改写、中英互译查询、HyDE 假设文档。库天然跨语言,收益大。
- **工作量**:小–中。

### 5. 检索范围过滤 + "全库 vs 选定"控制
- **问题**:`hybridSearch` 永远搜整个 workspace,无年份/作者/分类过滤;唯一圈定手段是 @ 提及(把整篇原文截断 8000 字塞进 system message,论文一大就爆上下文)。
- **做法**:① `search_library` 工具加 `filter`(year/collection);② UI 加"搜索范围"开关(当前对话 / 全库 / 选定条目)。
- **工作量**:中。

### 6. chunk 命中截断优化
- **问题**:`runTool` 里 `h.text.slice(0, 700)`,关键数值/表格可能被切掉。
- **做法**:配合重排后给更少但更完整的 chunk;或按语义边界截断。
- **工作量**:小。

---

## 第三梯队 — 体验与工作流

### 7. 对话交互"标配"补齐
- **缺**:消息重新生成 / 编辑重问 / 重试、复制答案 / 导出对话、追问建议(follow-up)、每对话切换模型、token/耗时显示。
- **位置**:`KnowledgePage.tsx` + `ChatMessage.tsx`。
- **工作量**:小(逐项独立,可分批)。

### 8. 批量 / 文献综述工作流
- **缺**:多篇交叉综述、找矛盾证据、术语演变、批处理 N 篇(竞品核心卖点)。
- **做法**:预置"综述/对比"任务(本质是 Skill + 多篇 ref 组合,现有机制可支撑)。
- **工作量**:中。

### 9. 本地嵌入选项(隐私闭环)
- **问题**:`providers.ts` 嵌入必须走云端 `/embeddings`(要 key),但 README 主打"数据留本地"——索引这步实际上传了全文。
- **做法**:内置本地嵌入模型选项(transformers.js / 本地 gguf),无 key 也能建索引。
- **工作量**:中–大。

### 10. Agent 工具面扩展 + 可观测性
- **做法**:加 `list_collections`、`compare_items`、`get_tables_figures`;UI 加"检索过程/来源"展开面板(透明度=信任度)。
- **工作量**:小–中。

---

## 建议执行顺序

1. ~~#1 PDF 原文兜底索引~~ — 已放弃(见上,工作流不需要)
2. **#2 重排序** — 改动小、见效快、+10~40% 准确率 ← **当前优先**
3. **#3 引用跳转到 PDF 页** — 从"能引用"到"可核查"

均建立在现有架构上,无需重写。每项动工前走一遍 brainstorming → 方案设计。

## 参考

- [RAG-Assistant-for-Zotero](https://github.com/Quiet-Signals-Lab/RAG-Assistant-for-Zotero) — hybrid + cross-encoder rerank、页码级引用
- [papersgpt-for-zotero](https://github.com/papersgpt/papersgpt-for-zotero) — 跨文档综述、全库搜索、本地索引
- [zotero-rag-assistant](https://github.com/AesZenz/zotero-rag-assistant) — 本地嵌入 + 编号引用
- [Reranking for RAG (Ailog)](https://app.ailog.fr/en/blog/guides/reranking) — 重排 +10~40% 实证
