# Veridian 开发日志

## 2026-08-20 — v0.1.11 发版：首类笔记 + 双链/反链 + AI 写笔记

自 v0.1.10 以来累积的知识库大版本，一次性发布。

**首类笔记 + Obsidian 式双链（P2-A）**：`notes` 表升为一等公民，`item_id`
可空——挂在文献上的是"文献笔记"，`item_id` 为空的是"独立概念笔记"。笔记
正文里写 `[[标题]]` 会被解析成 `relations` 边（`rel_type='wikilink'`），
在被指向的笔记/文献上以**反向链接**列出。悬空链接（指向尚不存在的标题）
保持悬空、不报错，等目标出现时自动接上。新增独立笔记页、侧栏笔记列表、
`[[` 自动补全的笔记编辑器、反链栏、文献详情的"笔记"标签页。

**AI 写笔记能力**：`saveNote` 增加 `origin`（user|ai），AI 写入的笔记
统一走 `saveNote`，所以 `[[链接]]` 会自动建反链边。agent 在 notes 模式下
获得 `create_note`（可建独立概念笔记，`item_key` 可选）、`update_note`
（按 id 定位、允许整体重写）、`list_notes` 工具；工具在模式路由层结构化
门控（notes 模式放行、qa 模式拒绝）。

**体验修复**：右侧详情面板切换文献条目时**记住当前所在的标签页**，不再
每次跳回第一个（元数据）标签。笔记 UI 的 emoji 图标（📝/📄）全部换成随
`currentColor` 走主题色的内联 SVG 线性图标。

**验证**：node + web 两套 tsc 干净、111 测试通过（40 个 DB 测试在 Electron
ABI 下按既有约定跳过）、`npm run build` 打包成功。发布沿用固定流程：
bump 0.1.11 → commit → push main → push tag v0.1.11 → electron-builder
`--publish always`。

## 2026-07-26 — 对话模型新增 Claude（订阅令牌）预设

用户问能否用 Claude 订阅账号额度。查证 Anthropic 开发者政策：第三方应用做
"一键登录 Claude / 共享额度"是明确禁止的（"does not allow third-party
developers to offer claude.ai login or share rate limits"），但官方文档
（[authentication#generate-a-long-lived-token]
(https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)）
本身写明 `claude setup-token` 生成的一年期 OAuth 令牌就是给"CI 流水线、
脚本或其他无法交互式浏览器登录的环境"用的，用户可以自己生成、贴到任何
想用的地方——这条路径是合规的，区别只在于"App 帮你登录"（禁止）vs
"你自己生成令牌，手动粘贴"（官方文档写明的用法）。所以选择了后者：不做
登录按钮，只做一个预设 + 令牌粘贴框。

**实现**：Anthropic 的 Messages API（`/v1/messages`）跟现有的 OpenAI 兼容
协议（`/v1/chat/completions`）线格式不同（system 是独立字段不是消息、工具
定义叫 `input_schema` 不是 `parameters`、SSE 事件类型也不同），新增
`src/main/knowledge/anthropicClient.ts` 单独实现，`providers.ts` 的
`chatStream` 按 `preset === 'claude-subscription'` 分流（动态 import，
避免两个文件间的运行时循环依赖）。请求头用
`Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`——
后者是 Claude Code 自己客户端认证 OAuth 令牌时用的头，参考了社区逆向项目
（如 `weidwonder/claude_agent_sdk_oauth_demo`）的实现，**没有真实令牌
测试过实际调用**，只保证协议转换层（消息格式、工具格式互转）用单测
验证正确（6 个用例：system 拆分、tool_calls→tool_use 块、tool 结果→
tool_result 块、并行工具调用合并进同一个 user turn、非法 JSON 参数不炸、
parameters→input_schema 改名）。

Anthropic 不提供 embedding 接口，所以这个预设只加在"对话模型"，不出现在
"Embedding 模型"的预设列表里。

**UI**：`KnowledgeSettingsTab` 对话模型预设新增"Claude（订阅令牌）"，选中后
API 地址自动锁定为 `https://api.anthropic.com`（只读，协议决定的不给改）、
模型名默认 `claude-sonnet-4-5`，API Key 栏位标签换成"订阅令牌"并显示
`claude setup-token` 使用引导。CDP 远程驱动真实 dev 实例验证：选中预设后
上述字段渲染符合预期。

**未验证**：真实令牌的端到端调用（用户目前没有生成令牌）——如果用了发现
`anthropic-beta` 头不对或事件解析有问题，需要用真实令牌抓包核对再修。

## 2026-07-26 — 知识库 + AI Agent + RAG（第一期：问答）

按此前提交的设计方案（`docs/superpowers/specs/2026-07-26-knowledge-rag-design.md`）
实现第一期：混合检索 + 工具循环 Agent 问答，不含自动生成每篇笔记（用户明确
只要问答）；embedding 和对话模型全部走云端 OpenAI 兼容 API（用户明确本地
推理先不考虑）；索引与对话记录仅本地，不随协作空间同步。

**新模块** `src/main/knowledge/`：
- `chunker.ts` —— Full.md 按标题层级切段 + 超长段落滑窗（15% overlap），
  纯函数，不含 I/O，8 个单测覆盖代码块内 `#` 不误判为标题等边界情况。
- `db.ts` —— 独立 `knowledge.db`（位置由 `knowledge.storagePath` 设置项
  决定，默认 `userData/knowledge/`），`sqlite-vec` 的 vec0 虚拟表懒建
  （首次 embedding 成功后才知道维度，写入 meta 表锁定模型+维度；换模型
  维度不匹配则拒绝写入，提示用户走"重建索引"）。
- `indexer.ts` —— 域事件驱动：`attachment.changed`（转换出 Full.md）/
  `workspace.dataRefreshed`（切换协作空间）/ 设置变更 三类事件防抖后
  触发扫描。两阶段：chunks+FTS5 先建（不需要联网，永远可用）→ embedding
  批量调用（32 条/批，失败的 chunk 标记待重试，不阻塞 FTS 检索）。
- `search.ts` —— 混合检索：FTS5 BM25 top-30 + 向量 KNN top-30，
  Reciprocal Rank Fusion 融合取 top-8（RRF 只看排名不看分数，绕开两路
  分数空间不兼容的问题）。`sqlite-vec` 不可用时自动降级为纯 JS 余弦
  相似度扫描 BLOB 向量。
- `providers.ts` —— OpenAI 兼容 HTTP 客户端，一份实现覆盖 DeepSeek/
  智谱/Kimi/OpenAI/自定义，对话和 embedding 分两组独立配置（同厂商可
  勾选复用 key）。`chatStream` 手写 SSE 逐行解析，支持流式 content +
  流式 tool_calls（按 index 累积分片参数）。
- `agent.ts` —— 工具循环（`search_library`/`get_item_info`/
  `read_context`，最多 8 轮），系统提示词要求内联 `[^item_key:seq]`
  引用标记；流式 delta 和状态通过新增域事件
  `knowledge.chatDelta`/`knowledge.chatState` 推给渲染层，IPC 调用本身
  只返回 conversation id（避免长连接阻塞 invoke）。

**新增域事件**：`knowledge.indexChanged`、`knowledge.chatDelta`、
`knowledge.chatState`（见 `shared/events.ts`）。

**IPC**：`knowledge:ask/stop/listConversations/getMessages/
deleteConversation/rebuildIndex/indexStatus/pickStoragePath/
testProvider` 九个通道，走既定的 contract → handlers → preload →
env.d.ts 四处同步模式。`knowledge:pickStoragePath` 迁移目录时先
`renameSync`，跨盘失败则退化为拷贝+删除。

**UI**：设置页新增"AI 知识库" tab（存储路径 + 对话/embedding 两组
Provider 配置 + 索引状态 + 重建按钮）；工具栏新增"AI 助手"按钮，走
`uiStore` 既有的整页切换模式（同 设置/工具 页一致，非弹窗）新开一个
`knowledge` page；聊天面板左侧会话历史、右侧消息流，引用标记渲染为
可点击 chip（复用 `openMarkdown` 跳转到原文，实现上是把
`[^KEY:seq]` 重写成 `[[n]](veridian-cite://KEY/seq)` 交给
`ReactMarkdown` 的 `a` 组件拦截渲染，没有另写解析器）。中英文 i18n
全覆盖。

**验证**：sqlite-vec 冒烟测试通过（Electron 环境内 `vec_version()`/
KNN 插入查询/FTS5 均正常）；51 个单测通过（新增 17 个：chunker 8 +
search/RRF 6 + citations 3）；typecheck 无新增错误（node 基线 4，
web 0）；`npm run build` 成功。**真实环境端到端验证**：用
`electron-vite dev --remote-debugging-port` 起真实 dev 实例，CDP 远程
驱动点击（而非本 session 之前用的 mock-HTML 截图法——那套在这次环境
下 `capturePage()`/`executeJavaScript()` 都不可靠，改用真实运行的
应用 + CDP + 页面自身 console/DOM 回读）：
- 状态栏 "AI index — done"，设置页显示"已索引 7 / 7 篇文献，399 个
  片段待生成向量"（未配置 embedding key 时的预期状态：FTS5 已建好，
  向量待补）；
- 直接查询真实 `knowledge.db`：399 个 chunk 来自用户库里 7 篇真实
  文献，标题层级正确保留；FTS5 关键词检索 "SAT" 正确命中对应论文；
- AI 助手面板正确显示"问答范围：Ref-dataset-test"（当前协作空间名）
  和"尚未配置对话模型"引导文案（未配置对话 key 时的预期降级状态）。
- 未验证：实际 LLM 问答往返（没有可用的 API key，用户后续自行配置）。

## 2026-07-25 — v0.1.4 发版

内容：工具栏手动同步按钮（含 CSS 环形 spinner）、会话恢复（工作空间 +
阅读器状态）、查看协作空间成员、浏览器扩展中英文切换 + 工作空间显示、
扩展新图标。

**发版新坑**：首次 `--publish always` 失败，GitHub 422 "Published releases
must have a valid tag"——`releaseType: "release"`（非 draft）要求 tag 必须
**先存在于远端**。此前几版恰好都是 tag 先推的，这次先跑了发布才建 tag。
流程固定为：bump version → commit → push main → **push tag** → publish。
失败的那次构建还留下了旧版 latest.yml（18:55 的 0.1.3 残留），但重跑
electron-builder 全量重新打包后自然覆盖，无需手工修复。

**验证**：本次无重复 Release；匿名 `/releases/latest` 返回 v0.1.4；
latest.yml 的 version/sha512/size 与实际上传的 exe 逐一核对一致。

## 2026-07-25 — 浏览器扩展中英文切换 + 工作空间显示

扩展弹窗（`popup.js`/`popup.html`）此前完全没有 i18n（硬编码中文）也不知道
当前活跃的是哪个工作空间。扩展没有构建流程（纯 `<script src="popup.js">`，
无打包器），所以 i18n 直接内联在 `popup.js` 里一份 `STRINGS = { en, zh }`
字典，不单独拆 i18n.js 模块。

**语言切换**：弹窗内手动切换按钮（不跟随 `chrome.i18n` 的浏览器语言），
偏好存 `chrome.storage.local`（弹窗每次关闭都会销毁 DOM/内存状态，必须持久化）。
默认语言英文——弹窗打开瞬间（"Step 0"）就用 `getLang()` 读到的语言直接渲染
初始文案，避免先闪一下硬编码中文再切换。`popup.html` 的初始文案节点改成空
字符串，全部交给 `popup.js` 填充。

**工作空间显示**：`/ping` 响应新增 `workspace: { kind, name }`
（`src/main/server/index.ts`），来自 `getActiveWorkspace()` +
`getWorkspace(id).name`——只吐原始 kind/name，本地化文案（"个人库" vs
真实工作空间名）由扩展自己按当前语言选择，主进程不替扩展做语言决定。弹窗
以只读方式展示"保存到：XXX"，不支持从扩展内切换工作空间（协作空间切换是
桌面应用的操作，扩展只是告知用户"即将存到哪"，避免用户没注意到桌面端已切换
库而存错地方）。

**验证**：`claude-in-chrome` 未连接扩展，改用 Electron 隐藏窗口加载模拟
`window.chrome` 的测试页 + `console-message` 事件回读渲染结果（截图法在此
沙箱环境下 `capturePage()`/`executeJavaScript()` 均返回陈旧或空白结果，判定
为环境限制而非代码问题，改走已验证可靠的页面 `console.log` 回读通道）。过程中
发现真实 bug：作者列表"等 N 人"后缀传的是作者总数而非剩余未展示数量
（7 位作者只显示 6 位时误显示"等 7 人"，应为"等 1 人"），已修复并重新验证
中英文两版渲染均正确。

`content.js` 无用户可见字符串（纯 DOM 提取），`background.js` 的 3 处内部
错误兜底文案（`'no tab'` 等）保持英文不译——同桌面端不翻译 `console.error`
调试信息的惯例一致，且用户几乎不会看到。

**验证结果**：typecheck（node 基线 4 / web 0，无新增）、34 测试通过、
`node --check` 语法检查通过。

## 2026-07-25 — 查看协作空间成员

`GitHubService` 新增 `listCollaborators(owner, repo)`，封装
`GET /repos/{owner}/{repo}/collaborators`，返回每个协作者的头像 URL、
用户名、角色（`role_name`：admin/maintain/write/triage/read）。GitHub 要求
调用方对该仓库至少有写权限，只读协作者的令牌会拿到 403——单独映射成
"没有权限查看"文案，不和"暂无协作者"混为一谈（避免误导只读用户以为
仓库没人协作）。

**UI**：`WorkspaceDialog` 的工作空间列表行，`inviteOpenId` 状态泛化成
`openPanel: { id, kind: 'invite' | 'members' } | null`（同一行同一时刻只
展开一个面板），新增"查看成员"按钮和 `MembersList` 组件——头像直接用
GitHub 返回的 `avatarUrl`（`WorkspaceSwitcher` 身份行已有先例直接这么用，
不需要再走本地缓存那套）。

**验证**：用 Electron 自身渲染器截图确认三按钮行（查看成员/邀请协作者/
删除）不拥挤；typecheck（node 基线 4 / web 0）、34 测试通过、build 成功。

上次关闭软件时的工作空间和阅读器打开状态，下次启动自动恢复。范围经用户
确认限定为这两项（不含选中条目/分类/搜索词/窗口大小——`viewerPath` 一旦
设置会让 `MainLayout` 整体切到阅读器视图、隐藏列表和详情面板，这两块状态
天然独立，互不依赖）。

**存储**：复用 `SettingsService`（明文 JSON，无需加密）两个独立 key：
- `session.workspaceId`：由**主进程自己**在 `WorkspaceContextService
  .setActiveWorkspace` 每次切换成功后直接写入（包括切回个人库写 null）——
  不经 IPC，因为主进程本来就是这个状态的权威来源。
- `session.viewer`：`{ type, path, filename } | null`，渲染层专属状态
  （zustand `itemStore`），新增专用 IPC `session:saveViewer` 写入——沿用
  安全加固时定下的原则，不擅自放宽通用 `settings:set` 白名单。

**恢复时机**：`App.tsx` 新增一个启动期一次性 effect：读
`session.workspaceId` → 有值调 `setActiveWorkspace`（复用现成的 clone/pull
容错逻辑）；读 `session.viewer` → 类型守卫校验后调对应的
`openPdf/openMarkdown/openGallery`。

**容错**：整个恢复过程包在 try/catch 里——存的工作空间被删了、文件被移走了，
都只是静默失败回落到默认状态（个人库、无阅读器），不影响应用正常启动。

**验证**：typecheck（node 基线 4 / web 0）、34 测试通过、build 成功、dev
模式冷启动无报错。**未做**：真实"退出→重启→确认状态还原"的完整回归测试
（需要真实的历史会话状态，留给用户下次重启时自然验证）。

新增 `SyncButton`（`src/renderer/src/components/layout/SyncButton.tsx`），
放在工具栏工作空间切换器右侧（左侧区域）。

- **显示条件**：仅当前激活的是 github 类型工作空间时渲染；个人库/本地工作
  空间下不显示（无东西可同步）。
- **状态反映真实同步进度**：`workspace.syncNow()` 只是把任务入队就立即返回，
  真正的 pull+push 是后台异步跑的。按钮监听与状态栏 pdf2md 进度共用的同一条
  `job.progress` 领域事件（按 `job.type === 'workspace.sync'` 过滤），据此
  切换旋转图标——同步中禁用点击、图标旋转（复用 globals.css 已有的 `spin`
  关键帧），真正完成/出错后自动恢复，而非猜一个固定延时假装在转。

**验证**：用 Electron 自身 Chromium 渲染静态 mock 截图确认位置/尺寸观感后
落地真代码；typecheck（node 4 基线 / web 0）、34 测试通过、build 成功。

合并 main：块 A（GitHub OAuth 登录）+ 块 B（贡献者标注）+ 同步流程三改（一次性
提交/失败标红/标题目录）+ 暂存目录修复 + 转换产物规范化（figN + Full 命名）+
图片带功能 + 响应式修复 + 块 C（软件内邀请协作者）+ 邀请控件布局调整。发布前
在合并后的 main 上重跑全量校验：node typecheck 基线 4、web typecheck **0**、
34 测试通过、build 成功。

**发布过程踩的新坑**：electron-builder 的重复 release 竞态这次表现不同以往——
两次并发创建请求中一次因"tag 已存在"报 422 直接失败，导致**打包进程提前退出**，
只上传了 blockmap 就中断，`exe` 和 `latest.yml` 都没传；更隐蔽的是，中断前
`dist/latest.yml` 还停留在**上一次（v0.1.2）打包的旧文件**（进程还没跑到重新
生成这一步就挂了）。若直接把这份 stale 文件传上去，`electron-updater` 客户端
会读到"最新版是 0.1.2"、sha512 对不上 0.1.3 的 exe，静默导致所有已装 0.1.2
的用户永远收不到 0.1.3 更新提示。

**处理**：核实 `dist/` 下 exe/blockmap 的文件时间戳确认是本次新构建（而不是
latest.yml 的旧时间戳）→ 补传 exe → 用 Node `crypto.createHash('sha512')`
对本地新 exe 重新计算摘要、手写正确的 `latest.yml`（version/sha512/size 与
真实文件一致）→ 删除误传的旧版本 asset → 重新上传 → 用**未认证请求**
（`GET /releases/latest`，与 electron-updater 客户端完全一致的调用方式）
确认最终解析结果版本号、sha512、文件名全部正确。

**教训沉淀**：`--publish always` 每次发布后必须核实两件事——① 该 tag 下只有
一个 release（无重复）；② `latest.yml` 的 `version` 字段与被打包的实际版本
一致（不能只看"文件存在"，内容也可能是上一版残留）。

---

## 2026-07-25 — 邀请协作者控件布局调整

用真实样式值渲染静态 HTML mock（Electron 自身 Chromium 截图，无需连 Chrome
扩展）比对现状与改进方案，用户确认后实施。

**WorkspaceDialog 的邀请表单**（`WorkspaceList`）：原先展开态是"用户名输入框 +
发送 + 取消 + 删除"四个控件挤在一行，"取消"和"删除"样式几乎相同（都是灰边框
白底）容易点错——一个是关闭表单、一个是删仓库，危险度完全不同。
`InviteRow` 拆分为触发按钮（留在收起态的按钮组里，和删除按钮并列）+
`InviteForm`（展开态时删除按钮让位、表单独占一整行，取消按钮改为无边框浅色，
和主要操作明确区分）。`open` 状态从组件内部提升到 `WorkspaceList`
（`inviteOpenId`），因为需要用它控制删除按钮的显隐。

**WorkspaceSwitcher 的邀请通知**：原先是纯文字行，和下方常规工作空间列表
没有视觉分层，仓库名不突出，多条邀请会挤在一起。改为每条邀请独立的浅色
卡片（`--primary-light` 背景+圆角），仓库名单独一行加粗高亮为主色调，
接受/拒绝按钮改为等宽撑满。相应把 i18n 的 `receivedFrom` 从含仓库名的整句
拆成"邀请你加入"前缀，仓库名单独渲染。

**验证**：typecheck 双端（node 4 基线 / web 0）、34 测试通过、build 成功。

用户反馈：新导入的 PDF 转换完成后不会自动出现图片带，要重启软件才有；协作
仓库同步拉取的更新也要切出工作空间再切回来才能看到。

**根因**：`FigureStrip` 用的是手写一次性 `useEffect` 拉取（滚入可视区域时拉一次
就不再更新），没有接入项目已有的响应式查询系统 `data/queryCache.ts`
（`useQuery` + 领域事件自动失效重拉——`AttachmentsTab` 的 `useAttachments`
等其余数据读取全部走这套机制，唯独 `FigureStrip` 是例外）。"重启/切换空间
才刷新"，本质是"整个组件被强制重新挂载"顶替了本该有的事件响应。

**修复**：
- `data/hooks.ts` 新增 `useItemImages(itemId)`，基于 `useQuery` 实现（查
  imagedir 附件 + 列图片目录，合并为一次查询）。
- `queryCache.ts` 的 `attachment.changed` 事件处理新增
  `invalidate(['item-images', id])`（此前只失效 `attachments`）——转换完成
  注册 imagedir 附件时会触发该事件，图片带因此自动重拉。
- `workspace.dataRefreshed` 已有的 `invalidateAll()` 天然覆盖新 key，同步/
  拉取后无需额外接线即可让已挂载的图片带自动刷新。
- `FigureStrip.tsx` 重构为外层用 `useInView` 做懒挂载门控（保持原有的"不滚
  到附近不做任何事"的内存策略不变），内层 `FigureStripContent` 用
  `useItemImages` 拉取——一旦挂载，此后转换完成、同步拉取都会自动更新，
  不需要用户任何操作。

**验证**：typecheck 双端清零/回基线；34 测试通过；build 成功。

**图片归一化**（`markdownImages.ts`，纯函数 11 单测）：转换成功后在暂存区内，
按 md 中图片引用的首次出现顺序把引用改写为 `images/figN.<ext>`（覆盖
`![]()` 与 `<img src>` 两种形式；跳过 http/data 外链；引用缺失的文件不动），
再按映射对 images 目录做**两阶段重命名**（先全部转临时名再落最终名，防止
源文件本身叫 fig1.png 之类的中途覆盖）。**md 中从未被引用到的图片**（封面
缩略图、MinerU 偶发的重复页截图等）直接删除，只保留文档实际用到的图。
归一化失败不影响转换结果（best-effort）。

**Full 统一命名**（`WorkspaceFiles.exportItems`）：目录名已承载标题，文件名
统一为 `Full.pdf` / `Full.md` / `images/`。三类均为覆盖式单例；条目的额外
非常规文件仍走 uniquePath。**已在仓库内的旧命名（<stem>.pdf/<stem>.md）会在
下次导出该条目时原地迁移到 Full.***。

**files/ 对账**：导出末尾清除 files/ 下不属于任何附件行的孤儿条目——旧命名
残留、历史 `_mineru` 污染目录等自动清理，仓库严格镜像附件行。

---

## 2026-07-25 — 重转换污染仓库修复（暂存目录方案）

用户实测发现：已同步的 PDF 重转 markdown 后，MinerU 的**整个 zip 解压目录**
（full.md、images、layout.json 等杂物）直接落进仓库的 `files/` 下成为嵌套新目录，
且旧 md/images 未被替换。

**根因**：`manualConvertPdfToMd` 复用已同步进仓库的 md 路径作输出目标 →
MinerU 解压目录（`<stem>_mineru/`）生成在仓库 `files/` 内 → 新 md 路径已在
repoRoot 内 → 导出搬运的"固定名覆盖"逻辑（v0.1.2）被 `startsWith(repoRoot)`
跳过，完全没执行。

**修复（比"先删后放"更根治）**：转换输出**永远写到仓库外的暂存目录**
`userData/conversions/<itemId>/`（每次转换前清空）。这样注册的 md/images
附件路径在仓库外 → 导出搬运必然触发 → md 固定名覆盖 `files/<stem>.md`、
images 先删 `files/images` 再整体拷入（旧图清除、结构不变）→ zip 杂物留在
暂存区**根本进不了仓库**。`manualConvertPdfToMd` 不再复用旧输出路径。

**注意**：此前测试中已被污染的仓库需**手动删除一次** `files/` 下的
`<stem>_mineru/` 嵌套目录（修复只防止再次发生，不清理历史污染）。

---

## 2026-07-24 — 重复文献检测合并 + 转换附件堆积修复（v0.1.2）

同步设计审查（见对话记录）发现的两个数据完整性问题，均在软件端修复后再同步——
GitHub 仓库只做存储，不承担业务逻辑。

### 重复文献检测（导入查重，之前完全没有）
两道闸，全部在创建条目**之前**拦截：
1. **文件 MD5 精确匹配**（`db/attachments.ts`）：PDF 入库时计算 MD5 存入 `md5` 列
   （schema v1 就有此列，此前从未使用，零迁移）。`importPDF` 入口先查
   `findItemIdByMd5`——同一文件第二次导入直接跳过（可选加入目标分类）。
2. **DOI 归一化匹配**（`db/items.ts` `normalizeDoi`/`findItemByDoi`）：剥离
   `https://doi.org/`、`doi:` 前缀并小写后比对。命中时**合并而非新建**：
   已有条目无 PDF 附件则把本次文件附上并触发转换（对应"扩展先存网页、
   后补 PDF"的常见流程）。浏览器扩展 `/save` 同样查重，重复保存返回
   `duplicated: true` + 原条目，不再产生第二个 `papers/<key>/` 目录。

### 转换附件堆积修复（重转 markdown 不再产生 foo-1.md / images-1）
根因链：workspace 同步把附件行 relocate 进 repo（copy 而非 move）→ 本地旧输出
文件仍在 → `autoConvertPdfToMd` 的"已转换"判断用路径相等而路径已变 → 注册出
第二条 markdown 行 → 导出时 `uniquePath` 避让出 `foo-1.md`。三处配合修复：
- `ConversionService.autoConvertPdfToMd`：改按**类型**判断已转换（存在 markdown
  附件即跳过），不再依赖路径相等。
- `AttachmentService.registerAttachment/registerAttachmentDir`：markdown/imagedir
  是每条目**单例**——已有同类型行时改指(repoint)该行到新路径，绝不插第二行。
- `WorkspaceFiles.exportItems`：转换类附件用**固定名覆盖**搬运（md 直接覆盖、
  imagedir 先删后拷防新旧图片合并残留）；`uniquePath` 只留给真正的用户文件（PDF 等）。

### 验证
- typecheck（node+web）相对基线零新增错误。
- 端到端实测（dev + 本地连接器）：同一 DOI 连续 `/save` 两次，第二次带
  `https://doi.org/` 前缀 + 全大写，返回 `duplicated: true` 且条目 id 不变。
- 测试数据已从 dev 库清理。

### 遗留
- BibTeX / CSL-JSON 批量导入路径暂未接 DOI 查重（入口在 `importer.ts`，
  后续版本补）。

### v0.1.2 发布记录
- 已发布至 GitHub Releases；客户端视角验证：`/releases/latest` → v0.1.2，
  `releases/download/v0.1.2/latest.yml` 内容正确（version/sha512/size）。
  装有 v0.1.1 的机器启动后应收到更新提示。
- **electron-builder 重复 release bug 复发**：`releaseType: "release"` 并没有
  根治——这是发布器对多产物并发上传的竞态（同 tag 建了两个 release，文件被
  拆散），v0.1.1、v0.1.2 连续两次复现。本次同样手动合并（补传 blockmap、删除
  只含 blockmap 的空壳）。**每次 `--publish always` 之后必须核查**：
  `GET /releases` 确认该 tag 只有一个 release 且 exe/latest.yml/blockmap 三件齐全。
  根治方向（后续）：`--publish never` 打包后用脚本自行创建 release + 上传三件套。

---

## 2026-07-24 — 安全与健壮性加固（代码审查后修复）

针对《Project Plan/代码问题清单与修复方案.md》列出的问题逐条修复，均为边界处收口，
不涉及架构变更。所有改动经端到端实测验证（非仅类型检查）。

### 安全类
- **本地连接器服务器加固**（`main/server/index.ts`）
  - 按 `Origin` 鉴别来源：浏览器扩展来源回显 CORS，普通网页来源一律 **403**，
    无 Origin 的原生请求放行。堵住"任意网页可注入条目 / 触发任意 URL 下载 /
    消耗 MinerU 配额"的漏洞（原先 `Access-Control-Allow-Origin: *` 且无鉴权）。
  - 请求体 **1MB 上限**，超限 `destroy` 并返回 413（防内存撑爆）。
- **PAT 不再对渲染层暴露**（`main/ipc/handlers.ts`）：`settings:get` 拒绝返回
  `github.pat` / `controlPlane.session`；UI 本就只依赖 `github:getStatus` 的 `hasPat`。
- **settings 写入白名单**（`main/ipc/handlers.ts`）：`settings:set` 仅允许 pdf2md 相关键；
  `storage.path` 只能清空，真实路径必须经原生对话框（`settings:pickStoragePath`），
  避免渲染层把文件白名单扩到任意目录。
- **Markdown XSS 收口**（`renderer/.../MarkdownViewer.tsx`）：`rehype-raw` 之后接入
  `rehype-sanitize`（顺序 raw → sanitize → katex）。.md 来源不可信（MinerU 输出、
  GitHub 协作仓库同步文件），sanitize 剥离 `<script>` / `onerror` / `javascript:` 等，
  同时保留 KaTeX 所需 class、代码块 `language-*`、`veridian-file://` 图片协议。
- **openExternal 协议校验**（`handlers.ts` + `main/index.ts`）：仅放行 http/https。

### 正确性 / 健壮性
- **连接器端口 23119 → 23120**（server + 扩展 manifest/background/popup + 文档）：
  23119 是 Zotero connector 端口，共存时会互相截流量；改独立端口，且被占用时
  经状态栏提示而非静默禁用。
- **FTS5 搜索转义**（`main/db/items.ts`）：用户输入按词包成 `"term"*` 短语前缀，
  含 `"` `(` `AND` 等特殊字符不再抛语法错误。
- **URL 下载附件校验**（`main/db/attachments.ts`）：校验 `%PDF-` 魔数 + 50MB 上限
  （含 content-length 预检），HTML 错误页不再被存成 .pdf。
- **CrossRef year 防 NaN**（`server/index.ts`）：非有限数值写入 null。

### 文档
- `CLAUDE.md`：修正 IPC 路径（`ipc/gateway.ts` + `handlers.ts`）、扩展目录名
  （`browser-extension/`）、端口号。

### 依赖
- 新增 `rehype-sanitize`。

---

## 2026-07-24 — 自动更新（零成本方案）

基于 `electron-updater` + GitHub Releases 实现在线更新，无需自建服务器、无需代码
签名证书，成本为零。

### 交互流程
1. 每次启动后台静默检查 GitHub Releases（`main` 进程，`initAutoUpdater()`）
2. 发现更高版本 → 后台差量下载（NSIS blockmap，只下变化的块）
3. 下载完成 → 弹原生对话框「发现新版本 vX.X.X，是否立即更新」
4. 用户点「立即更新」→ `quitAndInstall(false, true)`：退出 → 安装 → 自动重启
5. 用户点「稍后」/ 检查失败（离线、GitHub 不可达）→ 静默忽略，绝不阻塞启动
6. 开发环境（`is.dev`）跳过检查——dev 无 latest.yml，检查必然报错

### 改动
- 新增 `src/main/services/UpdateService.ts`：更新逻辑与对话框
- `src/main/index.ts`：`app.whenReady` 内 `createWindow()` 后调用 `initAutoUpdater()`
- `package.json`：`build.publish` 指向 GitHub 仓库；新增依赖 `electron-updater`

### 发布流程（开发者侧）
```
npm version patch                      # 递增版本号（0.1.0 -> 0.1.1），必须每次递增
set GH_TOKEN=<有 repo 权限的 PAT>       # electron-builder 上传 Release 用
npm run package -- --publish always     # 打包并自动上传到 GitHub Releases
```
仓库需为 **public**（客户端拉取 Release 无需 token）；否则客户端要内置 token，不安全。

### 前提 / 限制
- **未做代码签名**：Windows 首次安装/更新会有 SmartScreen「未知发布者」提示，
  点「仍要运行」即可，不影响更新功能。日后可用 SignPath.io 的 OSS 免费计划消除。
- **完整链路（检测→下载→安装→重启）无法在开发环境验证**，须打包发布真实 Release
  后、用已安装的旧版本实测。

### v0.1.1 首发记录 + 踩坑

首次实际发布验证：`v0.1.1` 已发布，`GET /repos/.../releases/latest`（未认证请求，等同
electron-updater 客户端的实际检查方式）确认返回 v0.1.1 且 `latest.yml` / 安装包 /
blockmap 三个文件齐全 —— 发布链路端到端验证通过。

遇到的问题及修复：
- **`v0.1.0` 早期 Release 冲突**：仓库里已有一个手动发布过的 `v0.1.0`
  （2026-07-10，Phase 0 时期），与本次构建版本号相同，导致 `--publish always`
  整体跳过。**每次发布前必须递增版本号**（`npm version patch`），不能是巧合，
  这条规则从一开始就是必须的。
- **重复草稿 bug**：electron-builder 默认对多产物分别触发发布钩子，实测在同一个
  tag（v0.1.1）下建了两个重复的 draft Release，文件被拆散到两边（一个只有
  blockmap，另一个只有 exe+latest.yml）。手动核对、删除空壳草稿、补传缺失文件、
  合并到一个完整 Release 后再发布。**已通过 `build.publish[0].releaseType: "release"`
  规避**：跳过 draft 中间态，直接创建正式 Release，后续发布不会再拆分。
- **默认行为调整**：`build.publish` 加了 `releaseType: "release"`——原本
  electron-builder 默认先建草稿等人工点发布，现在改为 `--publish always` 直接
  正式发布，不再需要每次手动确认（更贴合本项目"全自动检测→更新"的设计目标）。

---

## 2026-06-09 — Phase 0 完成：项目脚手架

### 完成内容

**运行环境**
- Node.js v24.11.0 / npm 11.13.0
- Electron 36 + electron-vite 3.x
- React 18.3 + TypeScript 5.8 strict 模式
- Tailwind CSS v4（@tailwindcss/vite 插件）

**主进程（src/main/）**
- `index.ts`：应用入口，BrowserWindow 创建，服务初始化
- `db/index.ts`：better-sqlite3 初始化 + 自动 Schema 迁移（版本化）
- `db/items.ts`：条目 CRUD + SQLite FTS5 全文检索
- `ipc.ts`：IPC 处理器注册（items:getAll / create / update / delete / search）
- `server/index.ts`：本地 HTTP 连接器，监听 localhost:23120，供浏览器扩展调用

**数据库 Schema（SQLite）**
- `libraries` / `collections` / `collection_items`
- `items`（含 version 乐观锁字段）
- `creators` / `item_creators`（多对多，支持 author/editor/translator 角色）
- `tags` / `item_tags`
- `attachments` / `notes`
- `sync_state`（预留 GitHub 同步状态）
- `items_fts`（FTS5 虚拟表，全文检索）

**preload（src/preload/）**
- `contextBridge` 暴露 `window.veridian` API
- 类型定义在 `src/renderer/src/env.d.ts`

**渲染层（src/renderer/）**
- 三栏布局：CollectionPane（左） / ItemListPane（中） / DetailPane（右）
- Toolbar：搜索框 + 添加条目 + 中/英语言切换
- DetailPane：元数据 / 附件 / 笔记三 Tab
- Zustand `itemStore`：items 列表、selectedId、searchQuery、activeCollection
- react-i18next 双语（zh/en），运行时切换，无需重启
- Tailwind CSS v4 + CSS 变量主题（支持亮/暗色切换预留）

**配置文件**
- `electron.vite.config.ts`：main / preload / renderer 三端构建
- `tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json`：分离配置
- `eslint.config.mjs`：ESLint 9 扁平配置
- `.gitignore`：排除 node_modules / out / *.db

**验证状态**
- `tsc --noEmit`（node + web 两个 tsconfig）：**零错误** ✅
- `npm install`：依赖安装成功 ✅
- git commit：`839af43` ✅

---

---

## 2026-06-09 — Phase 1 完成：完整 CRUD + 分类 + 导入

### 新增内容

**DB 层扩展（src/main/db/）**
- `creators.ts`：作者 CRUD，`setCreatorsForItem` 事务写入
- `tags.ts`：标签 CRUD，孤儿标签自动清理
- `collections.ts`：分类 CRUD，addItem / removeItem / getItems
- `items.ts` 重写：新增 journal/publisher/volume/issue/pages/isbn/language/extra/deleted 字段，软删除（trash/restore），全字段 updateItem

**BibTeX / CSL-JSON 导入（src/main/importer.ts）**
- 纯 Node.js 实现的 BibTeX 解析器（无外部依赖）
- CSL-JSON 批量导入
- 自动映射类型（article→journalArticle 等），解析作者字段
- Electron dialog 文件选择对话框

**IPC 扩展（src/main/ipc.ts）**
- 全部新 DB 操作注册为 IPC handler
- import:openDialog 触发文件选择

**preload 扩展（src/preload/index.ts）**
- `window.veridian.creators.*`
- `window.veridian.tags.*`
- `window.veridian.collections.*`
- `window.veridian.import.openDialog()`

**UI 层（src/renderer/src/）**
- `MetadataTab.tsx`：完整字段编辑器（作者增删、type select、期刊/卷期页/出版社/DOI/URL/摘要），脏标记 + 手动 Save 按钮
- `TagsTab.tsx`：标签气泡增删，Enter 快速添加
- `DetailPane.tsx`：重构为 4 Tab（元数据/标签/附件/笔记）
- `CollectionPane.tsx`：用户分类新建/重命名（双击）/删除（hover ×）
- `collectionStore.ts`：Zustand 分类状态
- `ItemListPane.tsx`：右键菜单 → 移至废纸篓
- `Toolbar.tsx`：导入按钮 + 快捷键绑定（Ctrl+N / Ctrl+F）
- `App.tsx`：全局 Delete 键删除选中条目
- i18n 补全所有新增字符串（zh/en）

**验证**
- `tsc --noEmit`（node + web）：**零错误** ✅

### 下一步：Phase 2（目标 第7-10周）

- [ ] CSL 引用引擎（citeproc-js 集成）
- [ ] 引用格式选择（APA / MLA / GB/T 7714 等）
- [ ] 引用复制到剪贴板
- [ ] BibTeX / RIS / CSL-JSON 导出
- [ ] 附件管理（PDF 拖入、文件关联）
- [ ] PDF 内嵌阅读器（PDF.js）

### Phase 路线图

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | 脚手架、DB Schema、三栏 UI、IPC、i18n | ✅ 完成 |
| 1 | 完整 CRUD、分类管理、BibTeX 导入 | ✅ 完成 |
| 2 | CSL 引用引擎、格式导出 | 🔲 待开始 |
| 3 | 浏览器扩展 MVP（arXiv / Google Scholar / CNKI） | 🔲 待开始 |
| 4 | GitHub 仓库同步、冲突处理 | 🔲 待开始 |
| 5 | 插件 API + 沙箱 + 示例插件 | 🔲 待开始 |
| 6 | 性能优化、打包发布 | 🔲 待开始 |
