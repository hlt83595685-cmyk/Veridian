# 批量导入健壮性 — 设计文档

日期：2026-08-20
状态：已批准，待出实现计划

## 背景 / 问题

用户反馈（在其他用户使用中出现）：一次导入几十篇 PDF，处理完后
在库里只剩下少数几篇（约 8 篇），且伴随软件闪退；重启后再导入，新的文献
和附件也存不进去。进一步观察到关键现象：**批量转换过程中只要中途有一篇
出错，后面即使转换成功的 PDF 也进不了用户指定的文件夹，而是滞留在
`%APPDATA%/Veridian/conversions`（软件隐藏暂存区）。**

代码调查定位到**三个叠加的缺陷**（下称 Bug C / Bug B / 附带项）。三者共同
造成“批量导入时一篇出错就整批数据丢失”。

### 数据流回顾（现状）

工作空间分两类，都有一个“内容根”（github 仓库工作树，或本地文件夹型
workspace 的用户文件夹）；库同时存在两处：**索引 db**（app 的清单缓存）与
**内容根文件夹**（PDF / 转换出的 markdown 等真实文件，视为真相源）。

1. 导入 PDF → 在索引 db 建条目，PDF 落到附件区。
2. `autoConvertPdfToMd` 把 pdf2md 任务入队（`JobQueue`，串行 concurrency=1）。
3. 转换输出**总是先写到暂存区** `userData/conversions/<itemId>/`（刻意不写在
   内容根，避免把 MinerU 原始碎屑倒进仓库），然后注册为附件。
4. 全部转换空闲后触发一次 `workspace.sync`：`exportChanges` 把条目的
   附件从暂存区**搬迁**进内容根 `papers/<title>/files/`；github 库再 commit +
   pull，若有 pull 则 `importAll` 从文件树重建索引。
5. 工作空间**活化**（切库 / 重启进入）时：`exportMissingItems`（抢救本地
   孤儿条目）→ 可能 pull → `importAll`（以文件树为真相重建索引）。

## 三个根因

### Bug C（卡死，最直接）—— 转换空闲信号会永久卡住
`ConversionService` 用一个手工计数器 `pendingConversions` 判断“是否全部转完”，
只有它归零才会触发把整批搬进文件夹的 sync。但 `stagingDir(itemId)`（内部做
`rmSync` + `mkdirSync`，在 Windows 上遇到文件占用 / 杀毒锁会抛 `EBUSY`/`EPERM`）
被放在了任务处理器的 `try/finally` **之外**（`ConversionService.ts:88`）。一旦它
抛错，这一篇的 `finally { pendingConversions-- }` **永不执行**，计数器永远归不了
零，`hasPendingConversions()` 永远为真，那次“搬进文件夹”的 sync **永不触发**
——于是这一批后面转成功的文件全部滞留在暂存区，一篇都进不了内容根。
**这正是“中途一篇出错 → 后面成功的也跑去 Roaming”的直接原因。**

### Bug B（误删）—— importAll 把本地未导出的条目当作远端删除
`importAll`（`WorkspaceFiles.ts:303`）以文件树为真相全量重建，第 331–334 行把
“索引里有、文件树里没有”的条目一律 `DELETE`。而 `exportChanges`
（`WorkspaceSyncService.ts:43`）与 `exportMissingItems`（`WorkspaceFiles.ts:257`）
都带 `conversion_failed = 0` 过滤，**转换失败的条目从不被写进文件树**。两者
叠加：失败条目 → 不进文件树 → 下次 activation 的 `importAll` 判其“远端已删除”
→ 删掉。批量把 MinerU 打到限流 → 大批失败 → 重启后只剩限流前成功的几篇。

### 附带项 —— 转换失败的 PDF 不进用户文件夹
即便不被删，失败条目的 PDF 也只留在暂存区 / 附件区，不在用户指定的文件夹里
（用户明确选了文件夹作为库的存储位置，却看不到这些 PDF）。

## 修复方案

### 修复 1：转换空闲从 JobQueue 派生（消除 Bug C）
`JobQueue` 自身已经健壮地记账（`running` 每类活跃数、`queue` 每类待处理数），
且每个任务无论成功 / 抛错都在 `run()` 的 `try/catch` + `drain()` 的 `.finally`
里正确减计数。方案：

- `JobQueue.registerJobType` 的 opts 增加可选 `onIdle?: () => void`。
- 在 `drain()` 里某类任务完成、`running.get(type)===0 && pendingOf(type)===0`
  时，调用该类的 `onIdle`。
- 导出 `isBusy(type: string): boolean`（`(running.get(type)??0) > 0 ||
  pendingOf(type) > 0`）。
- `ConversionService`：**删除** `pendingConversions` 计数器及其
  `++`/`--`/`=== 0` 逻辑；注册 pdf2md 时传 `onIdle: () => onConversionsIdle?.()`；
  `hasPendingConversions()` 改为返回 `isBusy('pdf2md')`。`setOnConversionsIdle`
  接口保持不变（`WorkspaceSyncService` 无需改动其调用）。

这样即使 `stagingDir` 或处理器任何一步抛错，JobQueue 仍会把该任务记为完成，
空闲信号正常触发，永不卡死。`stagingDir` 是否在 try 内已不再影响正确性（但
仍建议顺手挪进 try，让抛错走 `setConversionFailed` 而非静默）。

### 修复 2：失败条目也导出到文件夹（消除附带项，并从源头缓解 Bug B）

**范围限定：仅本地文件夹型工作空间（`kind !== 'github'`）。** 用户决定本次先
修好本地库，协作策略暂不处理，因此 github 工作空间保持现状（失败条目仍不导出、
不推给协作者）。判据用已有的 `getActiveWorkspace().kind`，github 库的行为与
本次改动前逐字节一致。

- `WorkspaceSyncService.exportChanges`：本地库导出所有脏（或全量）条目，含失败
  条目；github 库保留 `conversion_failed` 过滤。
- `WorkspaceFiles.exportMissingItems`：增加参数 `includeFailed: boolean`，本地库
  传 `true`（抢救所有本地孤儿条目，含失败条目），github 库传 `false`（保持
  `WHERE conversion_failed = 0`）。调用点在 `WorkspaceContextService` 的两个分支，
  各自按 kind 传值。
- `exportItems` 已能导出只有 PDF、没有 markdown 的条目，无需改动。
- 本地库的失败条目导出后在文件树中存在，`importAll` 不再视其为陈旧 → 不再被删。
  转换重试成功后，下次导出自然补上 `Full.md`。
- github 库的失败条目仍不进树，其数据安全**由修复 3 单独保障**（纯本地条目
  永不被删）——这正是修复 3 必须独立于修复 2 存在的原因。

保留失败状态：`item.json` 增加 `conversion_failed` 字段并在 `importItem` 回填，
使“红旗 / 待重试”状态经 export→import 往返后不丢失（缺省 0，向后兼容）。

### 修复 3：importAll 删除加保险（防御纵深，堵死 Bug B 残余）
即使修复 2 已让本地条目进树，导出仍可能因异常 / 离线未完成。给
`importAll` 的“删除陈旧条目”加一道保险：**只删除“至少有一个附件路径位于内容
根之内”的条目**（即确实被导出过的）；若一个条目的所有附件路径都在内容根之外
（纯本地、从未导出），则判定为本地条目，**绝不删除**。

已知取舍：无附件的纯元数据条目若被协作者真正远端删除，本地不会被清掉（少数
残留，**永不丢数据**，可接受）。判定用 `att.path.startsWith(repoRoot)`，与
`exportItems` 现有判断一致。

## 不在本次范围（记录，供后续）
- **闪退（OOM / 原生崩溃）**：无受影响用户日志，需单独复现 / 加日志定位；本次
  三项修复已能保证“即使发生崩溃，重启后 activation 的 exportMissingItems 会把
  暂存区里成功转换的条目补进文件夹、importAll 也不再误删”，从而不再造成永久
  数据丢失。
- **暂存区残渣清理**（431MB 孤儿产物不自动清理）：另开清理任务。
- **转换重试 / MinerU 限流节流**（`maxAttempts`、调用间隔）：降低失败概率的
  增强，非数据完整性必需。

## 测试计划
- `JobQueue.test.ts`（新增）：注册一个处理器对某 payload 抛错的任务类型，入队
  多个任务，断言全部结算后 `onIdle` 仍被触发恰好一次、`isBusy` 归假——直接覆盖
  Bug C（抛错任务不卡空闲信号）。
- `WorkspaceFiles.test.ts`（扩充，沿用现有 in-memory sqlite + `dbUsable` 守卫）：
  - `exportMissingItems(db, root, includeFailed: true)` 会导出 `conversion_failed=1`
    的条目（写出 `papers/<key>/item.json`）；`includeFailed: false` 时仍跳过它们
    （github 库行为不变）。
  - `importAll` 保留“所有附件在内容根之外”的本地条目（不删除）；仍删除确被
    远端移除、且曾导出过的条目。
  - `item.json` 往返保留 `conversion_failed`。
- 全绿门槛：`npx tsc -p tsconfig.web.json --noEmit` + `tsc -p tsconfig.node.json
  --noEmit`、`npm test`、`npm run build`。

## 变更文件清单（预计）
- `src/main/core/JobQueue.ts` — 增 `onIdle` per-type、`isBusy`。
- `src/main/services/ConversionService.ts` — 删手工计数器，改用 JobQueue 空闲信号；
  `stagingDir` 挪进 try。
- `src/main/services/WorkspaceSyncService.ts` — `exportChanges` 按 kind 决定是否
  过滤失败条目（本地库不过滤）。
- `src/main/services/WorkspaceFiles.ts` — `exportMissingItems` 增 `includeFailed`
  参数；`importAll` 删除加“附件在树内”保险；`item.json` 增 `conversion_failed` 往返。
- `src/main/services/WorkspaceContextService.ts` — 两个 activation 分支按 kind 传
  `includeFailed`。
- 对应新增 / 扩充测试文件。
