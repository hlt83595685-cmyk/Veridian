# 转换暂存区生命周期 — 设计文档

日期：2026-08-21
状态：已批准，待出实现计划
分支：`staging-lifecycle`（基于 `bulk-import-robustness`，两者改动同一批文件）

## 背景 / 问题

用户发现 `%APPDATA%/Veridian/conversions` 里堆积了大量数据。实测一个 83 篇论文的
库：**431MB，3191 个文件**，其中 82% 是纯残渣（`*_origin.pdf` 212MB 是 MinerU 回传
的原始 PDF 副本，`layout.json` 109MB 是版面坐标，另有 `*_model.json`、
`*content_list*.json`），其余 78MB（`full.md` + `images/`）是**已经复制进用户库
文件夹的成品的重复副本**。整个目录可回收。

按每篇约 5MB 计，这个目录随使用无限增长，从不回收。

## 根本设计缺陷

`conversions/` 语义上是**转换用的临时工作区**——`stagingDir(itemId)` 在每次转换
开始时 `rmSync` 整个清空重建（`ConversionService.ts`）。转换产物写在这里，并通过
`registerAttachment` / `registerAttachmentDir` 登记，**附件记录直接指向暂存路径**；
只有后来的 workspace sync（`exportItems`）把文件搬进内容根后，记录才改指向新位置。

但**没有内容根的库**（个人库，以及 `local_path` 为空的纯数据库型工作空间，
`getActiveWorkspace().repoRoot == null`）**永远不会触发 sync 搬迁**。对这些库，
暂存区就是转换产物**唯一的、永久的家**。

一个缺陷派生出三个后果：

1. **无法安全自动清理。** 分不清哪些是残渣、哪些是唯一副本，于是谁也不敢删 →
   无限堆积。
2. **跨库互删风险（真实数据丢失）。** 暂存目录只按条目编号命名（`conversions/6`），
   不区分工作空间。在 B 库转换编号 6 时，`stagingDir` 那句 `rmSync` 会清掉 A 库
   编号 6 的目录；若 A 是无内容根的库，那就是直接删掉用户已有的转换结果。
3. **存量无法回收**，即上述 431MB。

## 设计原则

**让临时区回归临时：任何一次转换结束时，产物都必须已经有了永久的家。**

## 方案

### A. 搬迁完成后清理该篇暂存目录

内容根型工作空间在 `exportChanges` 把某篇的附件搬进内容根之后，清掉该篇的暂存目录。

- `WorkspaceSyncService.exportChanges` 返回本次导出的 item id 列表（当前返回 `void`）。
- 两个调用点（sync 任务、切库前的 flush hook）拿到 id 列表后，逐个调用
  `ConversionService.clearStagingIfRelocated(db, itemId)`。
- **守卫（防误删）：** 该函数先查该 item 是否还有任何附件路径位于其暂存目录之内；
  有则说明搬迁未完成（`exportItems` 对单个附件的复制失败是容错并保留原路径的），
  **不清理**。只有全部搬离才删。
- **路径前缀必须按分隔符收边界**：`conversions/1` 是 `conversions/10` 的字符串前缀，
  裸 `startsWith` 会把编号 10 的附件误判成属于编号 1，进而误删编号 1 的目录。沿用
  `bulk-import-robustness` 分支已确立的写法：`p === dir || p.startsWith(dir + sep)`。

### B. 无内容根的库：产物落入正式存放区，暂存区随即清空

消除「临时区当永久存储」这个根源。

- 新增正式存放区 `userData/converted/<itemId>/`，**按条目分目录**——因为 markdown
  以相对路径 `images/figN.jpg` 引用插图，md 与 images 必须保持同级关系。现有的
  `userData/attachments` 是扁平 uuid 文件（PDF 存放处），承载不了这种成组结构，
  故不复用。
- 转换处理器在成功收尾时判断 `getActiveWorkspace().repoRoot == null`：
  - 是 → 把 `full.md`（改名 `Full.md`）与 `images/` 从暂存移入
    `userData/converted/<itemId>/`，用移入后的路径登记附件，然后清空该篇暂存目录。
  - 否 → 维持现状（登记暂存路径，交由 A 在 export 后清理）。
- 重转同一篇时，`converted/<itemId>/` 按覆盖语义写入（先删该目录再移入），与
  `exportItems` 对 `Full.md`/`images` 的既有覆盖语义一致。
- **迁移既有数据：** 启动时对活跃且无内容根的工作空间做一次迁移——把仍指向
  `conversions/` 的附件行搬到 `converted/<itemId>/` 并更新 `attachments.path`。
  不迁移的话，这些用户会继续暴露在缺陷 2 之下，B 也就没有真正完成。

有了 B 之后**缺陷 2 自然消解**：暂存区只在一次转换任务期间短暂持有数据，而 app
同一时刻只有一个活跃工作空间、且 pdf2md 是串行（`concurrency: 1`）。因此**不需要**
再做「暂存目录按工作空间隔离」的改造（YAGNI）。

### C. 启动时引用扫描，回收存量

以**所有**工作空间的数据库为根集做一次垃圾回收，删除无人引用的暂存内容。

- 根集 = 个人库 `userData/data/veridian.db` + 注册表中每个工作空间的
  `userData/workspaces/<id>/index.db`（工作空间注册表在个人库的 `workspaces` 表）。
  逐个只读打开，收集全部非空 `attachments.path`。
- 扫描 `userData/conversions/*`：某个 `<itemId>` 目录内若**没有任何**文件被根集引用，
  按文件性质分两类处置——**不是一刀切整目录删除**：
  - **中间产物一律删除**：`*_origin.pdf`（MinerU 回传的原始 PDF 副本，用户本地已有）、
    `layout.json`、`*_model.json`、`*content_list*.json`。实测这四类占该目录 **82%**
    （431MB 中的 353MB），且无论如何都无法从中恢复出用户可用的内容。
  - **成品予以保留**：`full.md` 与 `images/`。无引用的成品意味着它的条目已被删除
    （附件行随 `ON DELETE CASCADE` 一并消失），这正是**孤儿数据恢复**功能唯一的
    输入来源。删掉它等于亲手销毁那份仅存的转换成果。
  - 目录内两类都清空后若变为空目录，删除空目录。

  **这条分界是刻意的：** 本次要回收的是「无论如何都没用的中间产物」，不是「暂时
  没人认领、但仍可恢复的用户成果」。82% 的回收率已达成主要目的，剩下 18% 留待
  恢复功能处置，避免本功能与恢复功能互相拆台。
- **安全阀：只要有任何一个数据库打不开或读取失败，整轮跳过、不删任何东西。**
  证明不了「无人引用」就不动手。
- **时机固定在启动**（`initDatabase` 之后、任何转换入队之前）：此时不存在进行中的
  转换任务，不会误删在途数据。**不做**定时或运行中触发。
- 引用判定同样按分隔符收边界（同 A）。

## 三者的分工

| | 作用范围 | 解决 |
|---|---|---|
| A | 有内容根的库 | 今后不再堆积 |
| B | 无内容根的库 | 根除「临时区当永久存储」，顺带消解跨库互删 |
| C | 全部用户、全部历史 | 回收存量残渣 |

## 不在本次范围

- **孤儿数据恢复**（条目已被删除、暂存文件失去归属，需要重建条目才能取回）——
  独立功能，另行评估。本设计**刻意为它让路**：C 保留孤儿的 `full.md` 与 `images/`，
  只回收中间产物，因此两者不冲突，先后顺序自由。
- MinerU 残渣的**源头缩减**（转换时就不落 `*_origin.pdf` / `layout.json`）——需要改
  MinerU 交互层，另议。
- `userData/attachments` 中 PDF 的去重与回收（另有 560MB，属不同问题）。

## 测试计划

纯逻辑部分用真实测试覆盖；触库部分沿用项目既有 `dbUsable` 守卫（本机 Electron ABI
下会 skip），并在实现阶段用 Node 内置 `node:sqlite` 对真实代码补一次执行验证——
该手法已在 `bulk-import-robustness` 分支验证有效。

- **路径归属判定**（纯函数，必跑）：`conversions/1` 与 `conversions/10` 不互相
  归属；目录自身路径算归属；子路径算归属。
- **A 的守卫**：附件全部搬离 → 清理；尚有一个附件留在暂存 → 不清理。
- **B**：无内容根时产物落入 `converted/<itemId>/`，`Full.md` 与 `images/` 保持同级
  （相对引用不破）；暂存目录被清空；有内容根时行为不变。
- **B 迁移**：指向 `conversions/` 的附件行被搬到 `converted/` 且路径已更新。
- **C**：无引用目录中的中间产物（`*_origin.pdf` / `layout.json` / `*_model.json` /
  `*content_list*.json`）被删，而 `full.md` 与 `images/` **被保留**；被任一数据库引用
  的目录整体保留（含中间产物，因为该篇可能尚未搬迁完成）；任一数据库打不开时整轮
  不删任何东西。

## 变更文件清单（预计）

- `src/main/services/ConversionService.ts` — 暂存路径工具与 `clearStagingIfRelocated`；
  无内容根时产物移入 `converted/`。
- `src/main/services/StagingGC.ts`（新建）— C 的引用扫描与清理，以及 B 的启动迁移。
- `src/main/services/WorkspaceSyncService.ts` — `exportChanges` 返回导出 id；两个
  调用点在导出后触发清理。
- `src/main/index.ts` — 启动时调用一次 C（在 `initDatabase` 之后、服务初始化之后、
  任何转换入队之前）。
- 对应新增测试文件。
