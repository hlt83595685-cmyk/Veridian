# 设计：条目列表内联图片带（Figure Strip）

> 日期：2026-07-25
> 状态：已确认，待实现
> 独立特性，构建在 v0.1.2 起的图片归一化（`fig1.ext, fig2.ext…`）之上。

## 目标

在 `ItemListPane` 每条文献行的**下方**（不是详情面板），当该条目有转换产生的图片
（imagedir 附件）时，展示一条横向缩略图带，按 `fig1, fig2…` 顺序排列。效果类似
期刊列表页——不用点进详情就能看到配图。单行、超出出现横向滚动条、不换行。
点击缩略图打开现有的全页画廊 `ImageGalleryPane`（含 Lightbox），不新建交互。

## 背景 / 约束

- **列表无虚拟滚动**：`ItemListPane.tsx:398` 用普通 `filtered.map()`，所有行同时
  挂载在 DOM 里。若每行挂载时就发起图片目录读取+加载，列表一长会同时触发大量
  IPC 调用和图片解码——正是要避免的内存/计算开销。
- **图片来源已就绪**：转换归一化（本次会话早前完成）已保证 imagedir 附件下的
  文件名为 `fig1.ext, fig2.ext…`，按文件名排序即为正确顺序，无需解析 markdown。
- **一致的图片加载方式**：项目里贡献者头像、markdown 内嵌图都用
  `veridian-file://` 直连协议（非 IPC+blob URL 拷贝），本特性延续同一模式。

## 核心设计：可视区域触发加载（内存对策）

用零依赖的浏览器原生 `IntersectionObserver`，让每一行的图片带组件**只有滚动到
视口附近时才做任何工作**：
- 不可见 / 未接近可见：不发 IPC、不读目录、不渲染 `<img>`，DOM 里只有一个空
  占位元素（几乎零成本）。
- 进入视口附近（`rootMargin` 留一点提前量）：才去查该条目是否有 imagedir 附件、
  列出目录、渲染缩略图。
- 额外双保险：每个 `<img>` 本身也带 `loading="lazy" decoding="async"`。
- 单条目最多显示前 **10** 张（避免图特别多的论文把一行撑爆），可横向滚动查看
  该条目全部图片时点任意缩略图进全页画廊（画廊本身已支持浏览全部图片）。

这样内存/计算开销只和**当前实际看到的这几屏**成正比，与列表总条数、图片总数
无关。

## 架构与组件

### 1. `useInView` hook（新增，通用）

```
src/renderer/src/hooks/useInView.ts
```
封装 `IntersectionObserver`：传入一个 ref，返回 `boolean`（是否已进入过视口附近，
一旦为 true 保持 true——图片带不需要在滚出视口后又销毁重建，避免重复请求）。
`rootMargin` 设置为提前 200px 触发，让用户滚动到时缩略图基本已经就绪。

### 2. `FigureStrip` 组件（新增）

```
src/renderer/src/components/item-tree/FigureStrip.tsx
```
- Props：`itemId: number`。
- 用 `useInView` 包一层外壳 div（始终渲染，占位用，高度在未触发时为 0 或很小）。
- 触发后：调 `window.veridian.attachments.getByItem(itemId)` 找 imagedir 附件
  （沿用 `AttachmentsTab` 已有的判断方式：`type === 'imagedir'`）；若没有，组件
  渲染 `null`（无高度，不留空白）。
- 有 imagedir：调 `window.veridian.fs.listDir(path)`（已有的 IPC，`AttachmentsTab`
  同款用法，返回图片文件路径数组），按文件名中的数字排序（`fig1 < fig2 < …
  < fig10`，需数值排序而非字符串排序），取前 10 张。
- 渲染：`overflow-x: auto; white-space: nowrap` 的横向容器，每张图用
  `veridian-file://` 直连 `<img>`（复用现有路径编码方式，参考
  `PdfViewer.tsx`/`ImageGalleryPane.tsx` 的 encode 方式），高度固定 52px，
  `object-fit: cover`，圆角小卡片。
- 点击任意缩略图：调 `useItemStore` 的 `openGallery(imagesDirPath, filename)`
  （`AttachmentsTab.tsx` 已有的同款调用），打开现有全页画廊。

### 3. `ItemListPane` 接入

在 `ItemRow` 组件的行内容下方（同一个 flex 容器内，标题/标签区之后）渲染
`<FigureStrip itemId={item.id} />`。不影响现有行高逻辑——组件自身无图时不占高度。

## 数据流

```
列表渲染 200 条 ItemRow（含 FigureStrip 占位，均不发起任何请求）
  用户滚动
    → 某几行的 FigureStrip 进入视口附近（IntersectionObserver 触发）
      → attachments.getByItem(itemId) 查有无 imagedir
        → 有：fs.listDir(path) 列图 → 排序取前10 → 渲染 veridian-file:// 缩略图
        → 无：渲染 null
  用户点击某张缩略图
    → openGallery(imagesDirPath, name) → 打开已有 ImageGalleryPane + Lightbox
```

## 错误处理

- `attachments.getByItem` 或 `fs.listDir` 失败 → 静默渲染 `null`（不影响该行
  其余内容显示，不报错弹窗——这是装饰性功能，失败不该打扰用户）。
- 图片加载失败（文件被移动/删除）→ 单张 `<img onError>` 隐藏该张，不影响其余。

## 测试

- **单元**：figN 文件名数值排序的纯函数（`fig1 < fig2 < fig10`，防止字符串
  排序把 fig10 排到 fig2 前面）单独抽出测试。
- **手动 E2E**：
  1. 一个有转换图片的条目 → 滚动到其可见 → 缩略图带按 fig 顺序出现，横向可滚动。
  2. 图片超过 10 张的条目 → 只显示前 10，可横向滚动查看这 10 张。
  3. 无图条目 → 不显示任何图片带，不占空间。
  4. 点击缩略图 → 正确打开全页画廊，且能看到该条目全部图片（非只前10张，
     画廊本身列全部）。
  5. 长列表（50+ 条）滚动时，用任务管理器/DevTools 观察：不在视口附近的行
     不应触发网络/IPC 活动（可用 DevTools Network/Performance 面板抽查）。

## 改造清单

| 文件 | 改动 |
|---|---|
| `src/renderer/src/hooks/useInView.ts` | 新增：IntersectionObserver hook |
| `src/renderer/src/components/item-tree/FigureStrip.tsx` | 新增：图片带组件 |
| `src/renderer/src/components/item-tree/FigureStrip.utils.ts` | 新增：figN 数值排序纯函数（+单测） |
| `src/renderer/src/components/item-tree/ItemListPane.tsx` | `ItemRow` 内接入 `FigureStrip` |

## 非目标（明确不做）

- 服务端/主进程生成真正的小尺寸缩略图文件（额外基础设施，CSS 缩放已够用）
- 图片带内的说明文字/图注
- 虚拟滚动改造整个列表（超出本次范围；可视触发已经解决了内存问题，不需要
  连列表本身也改造）
- 详情面板内的图片展示（用户已明确要的是列表内联，非详情面板）
