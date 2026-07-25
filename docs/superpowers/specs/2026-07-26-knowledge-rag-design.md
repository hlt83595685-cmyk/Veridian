# Veridian 知识库 + AI Agent + RAG 设计方案

日期：2026-07-26
状态：待用户确认
范围（用户已确认）：**只做 RAG 问答**（不自动生成每篇笔记）；知识库**存放位置在设置中可配置**；所有 AI 产物**仅本地**，不随协作空间同步。

## 1. 总体架构

```
┌─ 渲染层 ────────────────────────────────────────┐
│  AI 助手面板（聊天 UI，流式输出，引用卡片可跳转） │
└──────────────┬──────────────────────────────────┘
               │ IPC (zod 校验，沿用现有 gateway)
┌─ 主进程 ─────┴──────────────────────────────────┐
│  KnowledgeService     索引管道 + 混合检索        │
│  AgentService         工具循环 + LLM Provider    │
│  EmbeddingWorker      worker 线程跑 bge-m3       │
└──────────────┬──────────────────────────────────┘
               │
     knowledge.db（独立 SQLite 文件，位置可配置）
     chunks 表 + vec0 虚拟表(sqlite-vec) + FTS5 虚拟表
```

设计原则（沿用本项目一贯约束）：
- **零服务器基础设施**：向量库用 sqlite-vec 扩展直接加载进 better-sqlite3，不引入新数据库进程。
- **embedding 本地免费跑**：transformers.js + BGE-M3（ONNX int8 量化，中英双语，8192 token 长文本）。检索永远可用、离线可用、零成本。只有对话部分才消耗 LLM 额度。
- **knowledge.db 与主库分离**：索引体积大且随时可重建，不污染主库备份；删掉即重置。

## 2. 知识库存放位置（设置项）

- 设置页新增「AI 知识库」区块，第一项就是**存放目录**（目录选择器）。
- 默认 `<userData>/knowledge/`；目录下放 `knowledge.db` 和 embedding 模型缓存（首次下载约 570MB）。
- 修改位置时把现有文件移动过去（fs.rename，跨盘则复制后删除）；正在索引时禁止修改。
- 路径存 SettingsService key `knowledge.storagePath`（明文，不是机密）。

## 3. 索引管道

**触发时机**：
1. `autoConvertPdfToMd` 成功产出 Full.md 后（挂现有 conversion 完成事件）；
2. 应用启动后台扫描：遍历当前工作空间全部 Full.md，对比内容 hash，补齐缺失/过期索引；
3. 设置页「重建索引」按钮（清空重来）。

**流程**：Full.md → 按 Markdown 标题层级切段，段内再按 ~500 token 滑窗（overlap 15%）→ EmbeddingWorker 批量嵌入 → 写入 knowledge.db。

**表结构**：
```sql
chunks(id, workspace_id, item_id, item_key, heading_path, seq, text, content_hash)
vec_chunks  -- vec0 虚拟表: chunk_id, embedding float[1024]
fts_chunks  -- FTS5 虚拟表: text, tokenize='unicode61'  (中文按 unigram 兜底)
```

**工作空间隔离**：所有表带 `workspace_id`，检索只查当前活跃工作空间——协作空间切换后问答范围自动跟着切。

**进度反馈**：走现有 `job.progress` 域事件 → 状态栏显示"索引中 x/y"，与转换任务同一套 UI。

## 4. 混合检索（RRF）

query → ①bge-m3 向量 KNN top-30 ②FTS5 BM25 top-30 → Reciprocal Rank Fusion 融合 → top-8 chunks 进 LLM 上下文。纯向量对精确术语（基因名/化合物/作者名）弱，纯 BM25 对同义改述弱，RRF 融合在基准上稳定优于单路。全流程单文件 SQLite 内完成。

## 5. LLM Provider（两层，逐期实现）

**第一期：OpenAI 兼容 HTTP 客户端**（一个实现覆盖所有）
- 设置项：预设下拉（DeepSeek / 智谱 / Kimi / OpenAI / Ollama / 自定义）+ baseURL + model + apiKey。
- apiKey 用 safeStorage 加密存储（沿用 `github.oauthToken` 先例）。
- Ollama 本身暴露 OpenAI 兼容端口（`http://localhost:11434/v1`），选 Ollama 预设即为本地免费模式。

**第二期：订阅账号桥接**（用户提出的 ChatGPT/Claude 订阅登录，查证结论）
- **Claude 订阅：可行且官方允许。** Anthropic 现行政策（2026-06 确认）允许第三方应用通过 Claude Agent SDK 使用用户自己的 Claude 订阅，用量计入订阅额度。实现：检测本机已登录的 Claude Code，经 `@anthropic-ai/claude-agent-sdk` 调用。前提是用户装了 Claude Code 并已登录。
- **ChatGPT 订阅：暂不承诺。**"Sign in with ChatGPT" 需向 OpenAI 申请接入（表单排队，未普遍开放）。Provider 接口留好扩展点，等开放了再加。

Provider 统一接口：`chat(messages, tools) → AsyncIterable<delta>`（流式 + function calling），Agent 层不感知具体后端。

## 6. AI Agent（自实现工具循环，不引 LangChain）

给 LLM 注册工具，多轮循环直到产出最终回答（上限 8 轮）：
- `search_library(query)` — 混合检索，返回 chunk 摘录+来源
- `get_item_info(item_key)` — 文献元数据（标题/作者/年份/期刊）
- `read_context(chunk_id)` — 读取某 chunk 前后相邻段落（扩展上下文）

比一次性检索的朴素 RAG 强的点：能自己改写查询、多次检索、对比多篇文献（"对比 A 和 B 的方法差异"这类问题）。

**引用**：提示词要求回答中以 `[^item_key:chunk_seq]` 标注来源；渲染层解析成可点击引用卡片，点击 → 打开对应文献的 Full.md 阅读器（复用现有 openMarkdown）。

## 7. UI

- 工具栏新增「AI 助手」按钮 → 打开聊天面板（复用阅读器所在主区域或右侧抽屉，实现时定）。
- 流式渲染回答（markdown），底部引用卡片列表。
- 会话历史存 knowledge.db（`conversations` / `messages` 表），仅本地。
- 顶部显示当前问答范围 = 当前工作空间名（与浏览器扩展的"保存到"同一逻辑）。
- 全部文案走 i18n（中英）。

## 8. 新增依赖

| 包 | 用途 | 备注 |
|---|---|---|
| `sqlite-vec` | 向量检索 | 预编译二进制，`load()` 进 better-sqlite3 实例 |
| `@huggingface/transformers` | 本地 embedding | 纯 JS/ONNX，主进程 worker 线程运行 |

模型 `Xenova/bge-m3`（int8 ONNX，~570MB）首次使用时下载到知识库目录，之后离线可用。

## 9. 分期

- **第一期（本方案）**：设置区块（存放位置 + OpenAI 兼容 Provider）、索引管道、混合检索、Agent 工具循环、聊天面板。
- **第二期（后续单独立项）**：Claude 订阅桥接（Agent SDK）；相关文献推荐；每篇自动笔记（若将来想要）。

## 10. 风险与对策

- **bge-m3 首次下载 570MB**：设置页明确提示 + 下载进度条；下载失败可重试；模型文件在可配置的知识库目录里，换机器可拷贝。
- **CPU 嵌入速度**：bge-m3 int8 在普通 CPU 上约 2-5 段/秒，一篇 50 段的文献 10-30 秒，放后台 worker + 队列，不阻塞 UI；与现有转换队列同样的异步模式。
- **sqlite-vec 原生扩展与 Electron ABI**：sqlite-vec 是 SQLite 运行时扩展（.dll），不链接 Node ABI，理论上不受 electron-rebuild 影响；实现第一步先做加载冒烟测试，失败则回退纯 JS 余弦相似度（文献量 <5000 篇时全量扫描依然 <100ms）。
