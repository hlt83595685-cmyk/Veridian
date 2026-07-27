<div align="center">

# Veridian

**A local-first reference manager with a built-in AI research assistant.**

![version](https://img.shields.io/badge/version-0.1.5-7c5cff)
![platform](https://img.shields.io/badge/platform-Windows-0078d4)
![stack](https://img.shields.io/badge/stack-Electron%20%7C%20React%20%7C%20TypeScript-3178c6)

**[English](#english)** ・ **[中文](#中文)**

</div>

---

<a id="english"></a>
## English

Veridian organizes your PDFs, metadata, tags, notes, and Markdown into a local-first, optionally GitHub-synced research library — then layers an AI assistant on top that can search, summarize, and answer questions **grounded in your own library**.

### Screenshots

<table>
<tr>
<td width="50%"><img src=".github/screenshots/library-view.png" alt="Library view"></td>
<td width="50%"><img src=".github/screenshots/ai-assistant.png" alt="AI assistant"></td>
</tr>
<tr>
<td align="center"><sub>Library view — collections, metadata panel, tags, thumbnails</sub></td>
<td align="center"><sub>AI assistant — <code>@</code>-reference a paper and ask questions with citations</sub></td>
</tr>
</table>

### Features

- **Reference management** — import PDFs, auto-fetch metadata from CrossRef, organize with collections/tags/notes, trash & restore, full-text search across your library.
- **AI research assistant** — a chat panel that indexes your library (hybrid keyword + vector search) and answers questions with inline citations back to the source paper.
  - Type `@` to attach a specific library item or a file from your workspace as context for the current question.
  - Type `/` to manually force the assistant to use one of your installed skills for that turn — otherwise it decides on its own when a skill applies.
  - **Skill marketplace** — install reusable, text-only "skills" (Anthropic Agent Skills format: `SKILL.md` frontmatter + Markdown body) from a GitHub folder URL or a local `.zip`, manage them from Settings → Skills. Skills only ever add instructions to the model's context — they never execute code.
- **Browser extension** — a one-click Chrome extension that saves the page you're reading straight into your Veridian library with metadata pre-filled.
- **GitHub-synced workspaces** — keep a reference library as a local folder or sync it against a GitHub repo (device-flow OAuth login, collaborator invites, background sync).
- **PDF → Markdown conversion** — turn a PDF into clean, searchable Markdown for the knowledge index.
- **Local-first** — your library lives in a local SQLite database; nothing leaves your machine unless you explicitly configure GitHub sync or an AI provider.
- **Bilingual UI** — switch the whole interface between 中文 and English from Settings.

### Tech stack

Electron 36 · React 18 + TypeScript · better-sqlite3 · isomorphic-git + Octokit (GitHub sync) · citeproc-js + KaTeX (citations & math) · react-i18next (i18n)

### Getting started

Download the latest installer from the [Releases](../../releases) page, or build from source:

```bash
npm install
npm run dev        # start in dev mode
npm run package     # build a Windows installer into dist/
```

The Chrome extension lives in [`browser-extension/`](browser-extension) — load it unpacked via `chrome://extensions` (Developer mode → "Load unpacked").

---

<a id="中文"></a>
## 中文

Veridian 是一个本地优先的文献管理平台，将 PDF、元数据、标签、笔记和 Markdown 整理进一个可选 GitHub 同步的研究文献库，并在此基础上内置了一个 **基于你自己文献库回答问题** 的 AI 研究助手。

### 界面截图

<table>
<tr>
<td width="50%"><img src=".github/screenshots/library-view.png" alt="文献库视图"></td>
<td width="50%"><img src=".github/screenshots/ai-assistant.png" alt="AI 助手"></td>
</tr>
<tr>
<td align="center"><sub>文献库视图 — 分类、元数据面板、标签、缩略图</sub></td>
<td align="center"><sub>AI 助手 — 用 <code>@</code> 引用一篇论文并获得带引用来源的回答</sub></td>
</tr>
</table>

### 主要功能

- **文献管理** — 导入 PDF、通过 CrossRef 自动抓取元数据、用分类/标签/笔记整理文献、支持回收站与恢复、支持全文检索。
- **AI 研究助手** — 对话面板会对文献库建立索引（关键词+向量混合检索），回答时会附带指向原文的引用来源。
  - 输入 `@` 可以把某篇具体文献或工作区中的某个文件作为本轮提问的上下文引用进来。
  - 输入 `/`（仅限消息开头）可以手动指定本轮强制使用某个已安装的 skill；不手动指定时，AI 会自动判断当前问题是否需要用到某个 skill。
  - **Skill 市场** — 支持安装可复用的纯文本"技能"（遵循 Anthropic Agent Skills 规范：`SKILL.md` YAML frontmatter + Markdown 正文），可以从 GitHub 文件夹链接或本地 `.zip` 安装，在设置 → Skill 标签页统一管理。Skill 只会向模型上下文中追加文字指令，不会执行任何代码。
- **浏览器扩展** — 一键 Chrome 扩展，浏览网页时可以直接把当前文献连同元数据保存进 Veridian 文献库。
- **GitHub 同步工作区** — 文献库既可以是本地文件夹，也可以与 GitHub 仓库同步（Device Flow OAuth 登录、协作者邀请、后台自动同步）。
- **PDF 转 Markdown** — 把 PDF 转换为结构清晰、可被检索的 Markdown，供知识库索引使用。
- **本地优先** — 文献库数据存放在本地 SQLite 数据库中，除非你主动配置 GitHub 同步或 AI 服务商，否则数据不会离开你的电脑。
- **中英双语界面** — 可在设置中随时切换整个应用界面的语言。

### 技术栈

Electron 36 · React 18 + TypeScript · better-sqlite3 · isomorphic-git + Octokit（GitHub 同步）· citeproc-js + KaTeX（引用与公式渲染）· react-i18next（多语言）

### 快速开始

从 [Releases](../../releases) 页面下载最新安装包，或从源码构建：

```bash
npm install
npm run dev        # 开发模式启动
npm run package     # 构建 Windows 安装包，产物在 dist/ 目录
```

浏览器扩展源码在 [`browser-extension/`](browser-extension) 目录，可以在 Chrome 的 `chrome://extensions` 页面开启"开发者模式"后选择"加载已解压的扩展程序"进行加载。
