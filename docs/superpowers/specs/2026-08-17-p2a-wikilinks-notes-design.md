# P2-A · 笔记 + 双链(Wikilinks / Backlinks)—— 设计

日期:2026-08-17
状态:设计已对齐,待审阅 → writing-plans
范围:P2 的 **A 部分(双链)**。B(联网:Crossref/arXiv)明确延后,单独立项。

---

## 1. 目标

在 P1 的地基(`notes` 一等公民表、`relations` 边表)之上,做 Obsidian 式**双向链接的个人知识库**:
- 笔记既能挂在论文下,也能作为**独立笔记(概念页)**存在。
- 笔记正文里写 `[[标题]]` 形成活链接;`[[` 自动补全库内论文/笔记。
- 保存时把 `[[…]]` 解析成 `relations` 边 → 双链天然是图谱的边(P3 直接可画)。
- **反向链接**:任一论文/笔记可见"谁链接到了我"。
- 点链接跳转;未解析链接可一键新建同名笔记。

**成功标准**:能在独立笔记页与论文笔记里用 `[[]]` 互链、看反链、跳转;`[[]]` 边进入 `relations`,与 P1 的 AI 链接同表(P3 一起画);编辑器编辑/预览可切换;现有库浏览/查看器/AI 不回归。

**非目标(后续)**:`[[note#小标题]]` 锚点;联网(P2-B);图谱可视化(P3);笔记的 Git 同步细节(沿用现有 workspace 机制,不特殊处理)。

---

## 2. 现状(代码事实)

- `notes` 表(P1 迁移 9):`id, item_id(可空), title, content, origin, updated_by, created_at, updated_at`。仓储 `src/main/db/notes.ts`(createNote/getNote/listNotesByItem/updateNote/deleteNote/deleteNotesForItem)+ `NoteService`(发 `note.changed` 事件 + oplog)。**尚无独立笔记列表、按标题查找。**
- `relations` 表(P1 迁移 9):`src_kind/src_id/dst_kind/dst_id/rel_type/origin`,`UNIQUE(src_kind,src_id,dst_kind,dst_id,rel_type)`,多态 kind 支持 `'item'|'note'`。仓储 `src/main/db/relations.ts`(linkItems/unlink/listRelationsForItem/deleteRelationsForItem,`RELATION_TYPES` = extends/contradicts/related/cites/same_method)+ `RelationService`。**目前只做了 item↔item;note 作为端点、反链查询、按笔记对账均未做。**
- 详情页 `DetailPane.tsx` 有"笔记"标签,当前是空占位 `detail.notesPlaceholder`。
- 中间区域查看器切换:`itemStore` 的 `viewerPath/viewerType`('pdf'|'markdown'|'gallery'),`MainLayout` 据此切换 `<ItemListPane>` / 查看器。渲染 markdown 用 `react-markdown` + `remark-gfm/remark-math` + `rehype-*`。
- 左栏 `CollectionPane.tsx`(分类树)。

---

## 3. Wikilink 语法、解析、解析规则

- **语法(对齐 Obsidian)**:`[[标题]]`、`[[标题|别名]]`(`|` 后为显示文本)。`[[标题#锚点]]` v1 不解析(锚点忽略,按标题解析)。
- **渲染**(预览):在现有 react-markdown 管线挂 **`remark-wiki-link`**(Obsidian 风格),把 `[[…]]` 变成 `<a>`,带 `exists` → 已解析用正常链接样式,未解析用虚线/灰样式。点击走统一的 wikilink 点击处理(见 §7)。
- **提取**(建边,主进程 Node):用**正则** `/\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g` 抽出每个链接的 target(标题,去掉别名/锚点)。与渲染用的是同一语法,避免在主进程引入 remark 依赖。
- **解析(resolve)规则**:target 标题 **不区分大小写、去首尾空白** 匹配:
  1. 独立笔记标题(`notes.title WHERE item_id IS NULL`);
  2. 论文标题(`items.title`)。
  命中优先级:先笔记后论文(独立笔记是"概念页",优先);多命中取最近更新的一个,并可后续做消歧(v1 取一)。命中不到 = 未解析(不建边,渲染虚线)。

---

## 4. 数据模型

- **笔记**:沿用 `notes` 表。`item_id` 非空 = 论文笔记;`item_id` 为空 = 独立笔记(以 `title` 为身份)。独立笔记必须有非空 `title`。
- **双链边**:写进 `relations`,`rel_type = 'wikilink'`(**新值,独立于 AI 的 RELATION_TYPES**——wikilink 由对账逻辑直接插入,不经 `assertRelType`;AI 的 `link_items` 仍只用有类型集)。方向 = 笔记 → 目标:`src_kind='note', src_id=noteId`;`dst_kind='item'|'note', dst_id=目标id`;`origin='user'`。
- **反向链接** = `relations` 里 `dst_kind/dst_id = 本对象` 的所有边(wikilink + AI 有类型链接都算),按 `src` 回取标题/摘要展示。

---

## 5. 后端(主进程)

**仓储扩展**
- `src/main/db/notes.ts` 增:`listStandaloneNotes()`(item_id IS NULL,按 updated_at DESC)、`findNoteByTitle(title)`(不区分大小写,item_id IS NULL,取最近)、`getNoteById` 已有。
- `src/main/db/relations.ts` 增:
  - `setWikilinksForNote(noteId, targets: {kind:'item'|'note'; id:number}[])`:事务内**删掉该 note 现有 `rel_type='wikilink'` 的出链**,再插入新一批(`INSERT OR IGNORE`)。这就是"保存时对账"。
  - `listBacklinks(kind:'item'|'note', id:number): {srcKind; srcId; relType}[]`:`WHERE dst_kind=? AND dst_id=?`。
  - `deleteRelationsForNote(noteId)`:删除该 note 作为 src 或 dst 的所有边(笔记删除时级联)。
- `src/main/db/items.ts` 增:`findItemByTitle(title)`(不区分大小写,deleted=0)。

**服务**
- `NoteService` 增:
  - `saveNote({id?, itemId, title, content})`:创建或更新笔记 → 然后**解析 content 的 `[[]]` → resolve 每个 target → `setWikilinksForNote`** → emit `note.changed` + `relation.changed`。
  - `resolveWikiTargets(content): {kind,id,title,resolved:boolean}[]`(内部用,正则 + findNoteByTitle/findItemByTitle)。
  - `deleteNote(id)`:`deleteRelationsForNote` + 删 note + emit。
  - `getBacklinks(kind,id)`:`listBacklinks` + 回取每个 src 的标题(item/note)与一小段上下文(可选:src note 内容里包含该 `[[…]]` 的那一行)。
- `RelationService` 复用(已发 relation.changed)。

**IPC(`ipc-contract.ts` + handlers + preload + env.d.ts)**,均 zod 校验:
- `notes:listByItem(itemId)` → Note[]
- `notes:listStandalone()` → Note[]
- `notes:get(id)` → Note
- `notes:save({id?, itemId, title, content})` → id
- `notes:delete(id)` → void
- `notes:backlinks(kind, id)` → {kind,id,title,snippet?}[]
- `notes:resolveTitle(title)` → {kind,id} | null(供 `[[]]` 点击跳转/未解析判断;渲染层也可用)

---

## 6. 渲染器(UI)

**共享组件 `NoteEditor`**(`components/notes/NoteEditor.tsx`)
- 输入:noteId? / itemId?(新建挂谁)。内部:标题输入 + 正文 `textarea` + **编辑/预览切换**按钮。
- 预览 = `react-markdown` + `remark-wiki-link`(链接可点、exists 样式)+ 现有 remark/rehype 插件。
- `[[` **自动补全**:textarea 里检测光标前的 `[[前缀`,弹浮层列出匹配的**独立笔记标题 + 论文标题**(经 `notes:listStandalone` + items 列表过滤,或一个 `notes:resolveTitle` 前缀接口);上下键选、回车/Tab 插入 `[[标题]]`。
- 自动保存(失焦/去抖)或显式"保存"→ `notes:save`。

**共享组件 `Backlinks`**(`components/notes/Backlinks.tsx`)
- 输入 kind/id → `notes:backlinks` → 列出"📄 论文 / 📝 笔记 · 标题 · 片段",点击跳转。

**独立笔记页 `NotePage`**(`components/notes/NotePage.tsx`)—— 中间区域一页
- 三栏内的中区:左=`NoteEditor`(标题+编辑/预览),右=**反链侧栏**(`Backlinks`)。复用查看器切换:`itemStore` 增 `noteViewerId: number | null` 与 `openNote(id)/closeNote()`;`MainLayout` 在 `noteViewerId != null` 时于中区渲染 `<NotePage>`(与 pdf/gallery 同级)。

**左栏"笔记"入口**(`CollectionPane.tsx` 增一节 或 新 `NotesPane` 片段)
- 分类树下方"📝 笔记"列出 `notes:listStandalone`,点击 `openNote(id)`;"+ 新建笔记"→ 建空标题笔记并打开。

**论文笔记(详情页"笔记"标签)**
- `DetailPane` 的 `notes` 标签:列出该论文的笔记(`notes:listByItem`)+ `NoteEditor`(itemId=该论文)+ 底部/内嵌 `Backlinks`(kind='item', id=itemId)。可多条笔记(列表 + 选中编辑)或单条主笔记(v1 单条主笔记 + "新增"够用)。

**Wikilink 点击(统一处理)**
- 点已解析链接 → `notes:resolveTitle(title)`:命中 item → 选中该论文(`setSelectedId`,切回库视图);命中 note → `openNote(id)`。
- 点未解析链接 → 弹确认"新建笔记『X』?"→ `notes:save({title:X, content:''})` 并 `openNote(新id)`。

---

## 7. 依赖

- 新增 `remark-wiki-link`(渲染 `[[]]`,约几十 KB,纯 ESM,契合现有 remark 管线)。
- 主进程提取用**正则**,不加 Node 端 remark 依赖。
- **P3 预留**:图谱可视化用 `react-force-graph-2d`(力导向、Obsidian 风格),本 spec 不安装。

---

## 8. 失败与边缘

- **标题冲突/改名**:`[[标题]]` 按标题解析;标题改了会导致旧链接"未解析"。v1 接受(Obsidian 亦按名);后续可做"重命名时更新引用"。
- **多命中**:取最近更新的一个;记 TODO 消歧。
- **空标题独立笔记**:新建时给占位标题("未命名笔记"),保存前提示补标题(否则无法被 `[[]]` 命中)。
- **删除笔记/论文**:`deleteRelationsForNote` / 已有 `deleteRelationsForItem` 清边;指向它的反链变为"未解析"(不报错)。
- **循环/自链接**:`[[自己]]` 忽略(不建自环边)。
- **大正文**:笔记正文按现有笔记规模,无需分块。

---

## 9. 测试

- `relations.test.ts` 增:`setWikilinksForNote` 对账(增/删)、`listBacklinks`(双向)、`deleteRelationsForNote`。
- `notes.test.ts` 增:`listStandaloneNotes`、`findNoteByTitle`(大小写)。
- 新 `wikilinks.test.ts`:`resolveWikiTargets` 正则提取(别名/锚点/多个)、resolve 优先级(笔记>论文)、未解析。
- 渲染器:`remark-wiki-link` 渲染 `[[]]` 为链接 + exists 样式(小快照/单测);`[[` 补全前缀匹配纯函数单测。
- 手动冒烟:建独立笔记→写 `[[某论文]]`→保存→该论文详情页"笔记"标签看到反链;点链接跳转;未解析 `[[新概念]]`→一键建页。

---

## 10. 实现分期(单一 spec 内,顺序)

1. **后端数据层**:notes/relations/items 仓储扩展(listStandalone/findByTitle/setWikilinksForNote/listBacklinks/deleteRelationsForNote)+ `wikilinks` 提取解析 + 测试。
2. **NoteService.saveNote / getBacklinks / deleteNote** + IPC/preload/env 贯通。
3. **NoteEditor 组件**(编辑/预览切换 + remark-wiki-link 预览 + `[[` 补全)。
4. **论文笔记标签**:DetailPane "笔记" 标签接 NoteEditor + Backlinks(kind=item)。
5. **独立笔记页**:itemStore.noteViewer + MainLayout 接入 + NotePage(中区 NoteEditor + 右反链)+ 左栏"笔记"列表/新建。
6. **Wikilink 点击导航 + 未解析建页** + 全量验证/冒烟。

---

## 11. 已锁定决策

1. 笔记 = 论文笔记 + 独立笔记(概念页),独立笔记可成图谱节点(方案 B)。
2. 布局:独立笔记成"笔记页"(中区),编辑/预览**切换**,**反链在右侧栏**;论文笔记在详情页"笔记"标签。
3. Wikilink 语法对齐 Obsidian(`[[标题]]`/`[[标题|别名]]`,锚点延后);渲染用 `remark-wiki-link`,提取用正则。
4. 双链存进 P1 `relations`,`rel_type='wikilink'`(独立于 AI 有类型集),note/item 多态端点;反链 = relations 反查。
5. 未解析 `[[]]` 可一键建同名独立笔记;解析优先笔记>论文,不区分大小写。
6. P3 图谱库定为 `react-force-graph-2d`(本期不装)。

## 12. 待后续细化的开放项
- `[[]]` 自动补全的数据源接口(前缀查询)与性能(库大时)。
- 论文"笔记"标签:单条主笔记 vs 多条笔记列表(v1 倾向单主笔记 + 新增)。
- 标题重命名时更新引用、多命中消歧(v1 不做)。
