# Veridian 开发日志

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
