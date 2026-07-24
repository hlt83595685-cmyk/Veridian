# Veridian 开发日志

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
