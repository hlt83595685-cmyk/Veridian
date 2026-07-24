# 设计：同步/导出流程改进（三处）

> 日期：2026-07-25
> 状态：已确认，待实现
> 与块 A（OAuth）、块 B（贡献者标注）同批发布。独立于块 C/D/E。

## 目标（三处改动）

1. **一次性同步**：导入 PDF 后不再"先提交 PDF、转换完再提交一次"，而是等
   PDF→Markdown 转换及其附件全部就绪后**一次性**提交到 GitHub。
2. **转换失败不提交 + 标红**：pdf2md 转换失败的条目**不同步**（留在本地），并在
   列表该条前显示红色圆圈感叹号 ❗；手动重转成功后红标消失、恢复同步。
3. **仓库目录用标题命名**：`papers/<清洗后的标题>/`（而非 UUID），同名冲突追加
   `-N`；身份改由 item.json 的 `key` 承载。

## 背景 / 约束

- 现状同步：`WorkspaceSyncService` 订阅领域事件 → 3 秒 debounce → `workspace.sync`
  任务 → `exportAndCommit`（导出脏条目到工作树 + commit）→ `sync`（pull+push）。
  转换是后台 JobQueue 任务（MinerU 云 API，可能几十秒），完成后 `registerAttachment`
  再次触发同步。→ 两次提交。
- 现状身份：`papers/<item.key>/`，**目录名 === key(UUID)** 硬编码在 `importAll`
  （按目录名认 key）和 `reconcileDeletions`（`join(dir, key)`）里。
- 重复 PDF：v0.1.2 的查重（MD5 + DOI）已保证同一 PDF 再次导入**合并进已有条目、
  不新建条目**。故按 key 定位目录即可避免重复目录。

## 改动一：一次性同步（推迟到转换完成）

- `ConversionService` 加**进行中转换计数器** `pendingConversions`：
  - 真正 `enqueue` pdf2md 任务时 `+1`（`autoConvertPdfToMd` 的"md 已存在直接注册"
    早返回路径**不**入队、不计数）。
  - 任务结束（成功或失败）`finally` 里 `-1`；归零时触发 `onConversionsIdle` 回调。
  - 导出 `hasPendingConversions(): boolean`、`setOnConversionsIdle(fn)`（hook 模式，
    避免与 WorkspaceSyncService 的 import 环）。
- `WorkspaceSyncService`：
  - `scheduleSync`：`if (hasPendingConversions()) return`（推迟——脏条目已在
    `dirtyItems` 累积，不启动 debounce）。
  - init 里 `setOnConversionsIdle(() => scheduleSync())`：转换全部结束后再调度。

## 改动二：转换失败不提交 + 红标

- **DB 迁移 v7**：`items` 加 `conversion_failed INTEGER NOT NULL DEFAULT 0`。
  **本地状态，不进 item.json**（失败条目本就没同步，协作者看不到）。
- `Item` 类型加 `conversion_failed: number`（`getAllItemsWithTags` 的 `SELECT *`
  自动带出）。
- `db/items.ts` 加 `setConversionFailed(itemId: number, failed: boolean): void`。
- `ConversionService` 任务处理器：`try { ...convert...; registerAttachment; setConversionFailed(itemId, false) } catch (e) { setConversionFailed(itemId, true); throw e }`
  （rethrow 保持 JobQueue 的错误上报不变）。
- **导出过滤**：`WorkspaceSyncService.exportAndCommit` 与 `WorkspaceFiles.exportMissingItems`
  的导出 id 集合**排除 `conversion_failed = 1` 的条目**——唯一的"不提交"强制点。
- **UI 红标**：`ItemListPane.ItemRow` 当 `item.conversion_failed === 1` 时，标题前
  渲染红色圆圈白"!"徽标（纯 CSS，无依赖）。
- **恢复**：手动重转成功 → `setConversionFailed(false)` + `registerAttachment` 触发
  `attachment.changed` → 标记脏 → 下次同步导出（此时不再被过滤）。红标消失
  （列表随 `attachment.changed` 刷新）。

## 改动三：标题目录命名（身份解耦）

- **纯函数（可单测）**：
  - `sanitizeTitle(title: string | null): string`：移除 Windows 非法字符
    `\ / : * ? " < > |`、控制字符、首尾空格与点；折叠空白；截断 100 字符；
    Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）加下划线前缀；空 → `untitled`。
  - `uniqueDirName(base: string, taken: Set<string>): string`：`base` 未占用则返回；
    否则 `base-2`/`base-3`… 直到不冲突。
- **身份改为 item.json 的 `key`**：`importAll` 按 `json.key` 认身份（删除
  "目录名 === key" 的 `if (json.key !== entry) json.key = entry`）；`treeKeys`
  收集 `json.key`；tombstone 跳过判断改为"该目录 item.json 的 key 被 tombstone"。
- **key→目录 扫描**：`scanKeyToDir(repoRoot): Map<string, string>`——遍历
  `papers/*/item.json`，建 `key → 目录名` 映射。
- **导出**（`exportItems`）：对每个 item，先查 `scanKeyToDir`：
  - key 已有目录 → **复用该目录名**（标题变了也不改名，保持稳定、避免跨机 -N 分歧）。
  - key 无目录（新条目）→ `uniqueDirName(sanitizeTitle(item.title), 已占用目录名集合)`
    建新目录。
- **删除**（`reconcileDeletions`）：用 `scanKeyToDir` 按 tombstone 的 key 定位目录后 rm。
- `exportMissingItems`：用 `scanKeyToDir` 判断"该 key 是否已有目录"，无则导出。

## 数据流（PDF 导入，github 工作空间）

```
导入 PDF → createItem + addAttachment(pdf) → autoConvertPdfToMd 入队(pending=1)
  → 脏事件触发 scheduleSync → 因 pending>0 推迟
  → 转换任务运行:
      成功 → registerAttachment(md/images) + setConversionFailed(false)
             → finally pending=0 → onIdle → scheduleSync
             → exportAndCommit(排除 failed) → 目录=uniqueDirName(sanitize(title))
             → commit + push  ✅ 一次提交 PDF+md+图片
      失败 → setConversionFailed(true) → finally pending=0 → onIdle → scheduleSync
             → exportAndCommit 排除该 failed 条目 → 不提交它 ❗ 列表标红
```

## 测试

- **单元（纯函数，可跑）**：
  - `sanitizeTitle`：非法字符/保留名/空标题/超长/首尾点空格。
  - `uniqueDirName`：无冲突返回原名；冲突追加 -2/-3。
- **DB/集成**：better-sqlite3 ABI 限制下跳过（沿用块 B 的 `describe.skip` 守卫）；
  以手动 E2E 覆盖。
- **手动 E2E（github 工作空间）**：
  1. 导入一篇 PDF（转换开启）→ 观察只发生**一次** commit（含 pdf+md+images），
     仓库目录名是清洗后的标题。
  2. 制造一次转换失败（如无效 token/断网）→ 该条目**不出现在仓库**，列表该条
     前有红色❗；手动重转成功后红标消失、条目出现在仓库。
  3. 同名标题两篇 → 第二篇目录 `-2`。
  4. 重复导入同一 PDF → 合并进原条目、**不新建目录**（v0.1.2 查重）。

## 改造清单

| 文件 | 改动 |
|---|---|
| `src/main/db/index.ts` | 迁移 v7：`conversion_failed` 列 |
| `src/shared/types.ts` | `Item.conversion_failed: number` |
| `src/main/db/items.ts` | `Item` 本地接口加字段；`setConversionFailed` |
| `src/main/services/ConversionService.ts` | pending 计数 + idle hook + 失败/成功置标志 |
| `src/main/services/WorkspaceSyncService.ts` | scheduleSync 推迟；idle 回调；导出排除 failed |
| `src/main/services/WorkspaceFiles.ts` | sanitizeTitle/uniqueDirName/scanKeyToDir；export/import/delete 身份解耦；exportMissingItems 过滤 failed |
| `src/main/services/WorkspaceFiles.test.ts` | sanitizeTitle/uniqueDirName 单测 |
| `src/renderer/.../ItemListPane.tsx` | 红色❗徽标 |

## 非目标

- 标题变更时重命名目录（保持首次目录名）
- 跨机离线同名新增的 git 冲突自动消解（纯标题+-N 的固有代价，已知悉）
- 重启丢失 pending 转换任务的自动重排（降级为同步 PDF；可后续处理）
