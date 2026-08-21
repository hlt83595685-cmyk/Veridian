# 存储落地与暂存区生命周期 — 设计文档

日期：2026-08-21
状态：已批准，待出实现计划
分支：`staging-lifecycle`（基于 `bulk-import-robustness`，两者改动同一批文件）

## 背景 / 问题

用户反馈：**用户选择的位置就是默认存储区域，不要在 C 盘展开动作。**

实测一个 83 篇论文的库（内容根 `C:\D\Veridian\Test`，实际库内容 535MB）：

```
%APPDATA%\Veridian 总占用            1.10 GB
  ├─ attachments\  104 个文件  560MB   ← 全部无人引用
  └─ conversions\ 3191 个文件  431MB   ← 全部无人引用
数据库中 291 条附件路径，指向这两个目录的：0 条
```

**C 盘上这约 1GB 没有任何一条数据库记录引用**，而库的真实内容全在用户选定的文件夹里。
等于用户每导入一篇论文，C 盘就永久多留一份 PDF 副本加一整包转换残渣——用户库有多大，
C 盘就白占约两倍。

## 根本原因（一个缺陷，两处发作）

**「搬迁」被实现成「复制 + 改指向」，从不删除源文件。**

- `WorkspaceFiles.exportItems` 用 `copyFileSync` / `cpSync` 把附件搬进内容根并
  `UPDATE attachments SET path = ?`，**原件永久留在 `userData/attachments/`**。
- 转换产物同理：写入暂存区并登记，被 export 复制进内容根后，**原包永久留在
  `userData/conversions/`**（其中 `*_origin.pdf`、`layout.json`、`*_model.json`、
  `*content_list*.json` 四类中间产物占 82%，即 431MB 中的 353MB）。

叠加第二个缺陷：**暂存区同时充当了正式存储。** `stagingDir(itemId)` 在每次转换开始时
`rmSync` 整个清空重建，语义上是临时工作区；但**没有内容根的库**（个人库，以及
`local_path` 为空的纯数据库型工作空间，`getActiveWorkspace().repoRoot == null`）永远
不会触发 export 搬迁，暂存区就成了那些产物唯一的、永久的家。于是既不敢清理，又暴露在
「换库转换同编号条目时 `rmSync` 误删他库数据」的风险下（暂存目录只按条目编号命名，
不区分工作空间）。

## 设计原则

1. **数据落在用户选定的位置**，C 盘只保留数据库、配置与缓存这类小文件。
2. **搬迁即移动**，不留源。
3. **临时区回归临时**：任何一次转换结束时，产物都必须已经有了永久的家。

## 方案

### P1. 搬迁改为「移动」

`exportItems` 把附件搬进内容根后删除源文件；转换产物同理。

- 同卷 → `renameSync`（原子、瞬时）。
- 跨卷 → `renameSync` 抛 `EXDEV` 时回退为「复制 + 删源」。
- 目录（`images/`）同样处理：同卷 rename，跨卷 `cpSync` + `rmSync`。
- **失败即保留源**：任何一步出错都不删源文件，仅记录警告——宁可多留一份，不可丢数据。
  这与 `exportItems` 现有的逐附件容错风格一致。

单这一条即可让**新导入**不再往 C 盘沉淀。

### P2. 工作区跟随库的位置

暂存目录不再写死在 `userData`：

- 库有内容根 → `<contentRoot>/.veridian-tmp/<itemId>/`
- 库无内容根（纯数据库型/个人库）→ 维持 `userData/conversions/<itemId>/`
  （这类库本来就没有用户选定的位置，`userData` 就是它的存储根；待「可配置存储根」
  单独立项后再改）

收益有二：**大文件全程不碰 C 盘**（对用户选了文件夹的库）；且暂存与目的地同卷，
P1 的搬迁退化为**同卷 rename**——用户那 535MB 的库不必再每次跨盘复制。

**github 工作空间**：内容根是 git 工作树，必须确保 `.veridian-tmp/` 不被提交——
激活时检查并在必要时向内容根的 `.gitignore` 追加一行 `.veridian-tmp/`。

### P3. 无内容根的库：产物落入永久区

消除「临时区当永久存储」。

- 新增 `userData/converted/<itemId>/`，**按条目分目录**——markdown 以相对路径
  `images/figN.jpg` 引用插图，md 与 images 必须保持同级；现有 `userData/attachments`
  是扁平 uuid 文件，承载不了这种成组结构，故不复用。
- 仅对 `repoRoot == null` 的库生效：转换成功收尾时把 `full.md`（改名 `Full.md`）与
  `images/` 从暂存**移入**该目录，用新路径登记附件，随后清空该篇暂存目录。
- 重转按覆盖语义（先删该目录再移入），与 `exportItems` 对 `Full.md`/`images` 的既有
  覆盖语义一致。
- **迁移既有数据**：启动时对活跃且无内容根的工作空间，把仍指向 `conversions/` 的
  附件行移入 `converted/<itemId>/` 并更新 `attachments.path`。不迁移则这些用户继续
  暴露在上述 `rmSync` 误删风险下，P3 也就没有真正完成。

有了 P3，**跨库互删隐患自然消解**：暂存区只在一次转换任务期间短暂持有数据，而 app
同一时刻只有一个活跃工作空间、pdf2md 又是串行（`concurrency: 1`）。因此**不需要**
再做「暂存目录按工作空间隔离」的改造（YAGNI）。

### P4. 搬迁完成后清理该篇暂存目录

有内容根的库，在 `exportChanges` 把某篇搬进内容根之后，清掉该篇的暂存目录。

- `WorkspaceSyncService.exportChanges` 返回本次导出的 item id 列表（现返回 `void`）；
  两个调用点（sync 任务、切库前的 flush hook）据此逐个触发清理。
- **守卫**：先查该 item 是否还有附件路径位于其暂存目录之内；有则说明搬迁未完成
  （P1 明确规定失败保留源），**不清理**。
- **路径归属必须按分隔符收边界**：`conversions/1` 是 `conversions/10` 的字符串前缀，
  裸 `startsWith` 会把编号 10 的附件误判为属于编号 1，进而误删。沿用
  `bulk-import-robustness` 分支已确立的写法：`p === dir || p.startsWith(dir + sep)`。

### P5. 启动时引用扫描，回收存量

以**所有**工作空间的数据库为根集做一次垃圾回收。

- 根集 = 个人库 `userData/data/veridian.db` + 注册表（个人库 `workspaces` 表）中每个
  工作空间的 `userData/workspaces/<id>/index.db`。逐个**只读**打开，收集全部非空
  `attachments.path`（同时收集 PDF 行的 `md5`，供下方判重）。
- **安全阀：只要有任何一个数据库打不开或读取失败，整轮跳过、不删任何东西。**
  证明不了「无人引用」就不动手。
- **时机固定在启动**（`initDatabase` 之后、任何转换入队之前）：此时无进行中的转换，
  不会误删在途数据。**不做**定时或运行中触发。
- 两个目录按各自规则处置：

  **`conversions/`** —— 无引用的目录内按文件性质分类，**不是一刀切整目录删**：
  - **中间产物一律删除**：`*_origin.pdf`（MinerU 回传的原始 PDF 副本，用户本地已有）、
    `layout.json`、`*_model.json`、`*content_list*.json`。实测占 82%，且无法从中恢复出
    用户可用内容。
  - **成品予以保留**：`full.md` 与 `images/`。无引用的成品意味着其条目已被删除（附件行
    随 `ON DELETE CASCADE` 消失），这是**孤儿数据恢复**功能唯一的输入来源，删掉等于
    销毁那份仅存的转换成果。
  - 清空后若目录为空则删除空目录。
  - 被任一数据库引用的目录**整体保留**（该篇可能尚未搬迁完成）。

  **`attachments/`** —— 只删**可证明的重复**：某个无引用文件，其内容 md5 与根集中
  某条**仍被引用**的附件记录的 `md5` 相同，即证明它是搬迁遗留的副本，删除；否则保留
  （可能是该文件的唯一副本，例如浏览器扩展直接下载入库、原始 PDF 已不在用户手上）。

  这两条分界是刻意的：本次回收的是「可证明冗余或无论如何都没用的」，**不碰任何可能
  是唯一副本的用户内容**。

## 各项分工

| | 作用范围 | 解决 |
|---|---|---|
| P1 | 全部库 | 新数据不再在 C 盘留副本 |
| P2 | 有内容根的库 | 大文件全程不碰 C 盘；搬迁变同卷 rename（提速） |
| P3 | 无内容根的库 | 根除「临时区当永久存储」，消解跨库互删 |
| P4 | 有内容根的库 | 暂存不再堆积 |
| P5 | 全部用户、全部历史 | 回收存量（本机约 913MB 可回收） |

## 不在本次范围

- **可配置存储根**（让个人库/纯数据库型库也能指定存放位置）——需新增设置项与整库迁移，
  单独立项。P2 已为其预留分支判断。
- **孤儿数据恢复**（条目已删、暂存文件失去归属，需重建条目才能取回）——独立功能。
  本设计**刻意为它让路**：P5 保留孤儿的 `full.md` 与 `images/`，两者不冲突，先后自由。
- **MinerU 残渣源头缩减**（转换时就不落 `*_origin.pdf` / `layout.json`）——需改
  MinerU 交互层，另议。

## 测试计划

纯逻辑部分必须真实跑过；触库部分沿用项目既有 `dbUsable` 守卫（本机 Electron ABI 下
skip），并在实现阶段用 Node 内置 `node:sqlite` 对真实代码补执行验证——该手法已在
`bulk-import-robustness` 分支验证有效。

- **路径归属判定**（纯函数，必跑）：`conversions/1` 与 `conversions/10` 互不归属；
  目录自身算归属；子路径算归属。
- **P1 移动语义**：同卷移动后源不存在、目的地内容一致；跨卷（模拟 `renameSync` 抛
  `EXDEV`）回退为复制加删源；复制失败时**源仍在**且不更新路径。
- **P2**：有内容根时暂存位于 `<contentRoot>/.veridian-tmp/<itemId>`；无内容根时仍在
  `userData/conversions/<itemId>`；github 内容根的 `.gitignore` 含 `.veridian-tmp/`。
- **P3**：无内容根时产物落入 `converted/<itemId>/` 且 `Full.md` 与 `images/` 同级
  （相对引用不破）；暂存被清空；有内容根时行为不变。迁移：指向 `conversions/` 的附件行
  被移入 `converted/` 且路径已更新。
- **P4**：附件全部搬离 → 清理；尚有一个附件留在暂存 → 不清理。
- **P5**：`conversions/` 无引用目录中间产物被删而 `full.md`/`images/` 保留；被引用的
  目录整体保留；`attachments/` 中 md5 与已引用附件相同的无引用文件被删，md5 不匹配的
  保留；任一数据库打不开时整轮不删。

## 变更文件清单（预计）

- `src/main/services/ConversionService.ts` — 暂存路径跟随内容根；无内容根时产物移入
  `converted/`；`clearStagingIfRelocated`。
- `src/main/services/StorageGC.ts`（新建）— P5 的引用扫描与回收，以及 P3 的启动迁移。
- `src/main/services/moveFile.ts`（新建）— P1 的移动语义（同卷 rename / 跨卷回退），
  文件与目录两种，供 `exportItems` 与转换收尾共用。
- `src/main/services/WorkspaceFiles.ts` — `exportItems` 改用移动语义。
- `src/main/services/WorkspaceSyncService.ts` — `exportChanges` 返回导出 id；两个调用点
  在导出后触发清理。
- `src/main/services/WorkspaceContextService.ts` — github 内容根的 `.gitignore` 保障。
- `src/main/index.ts` — 启动时调用一次 P5。
- 对应新增测试文件。
