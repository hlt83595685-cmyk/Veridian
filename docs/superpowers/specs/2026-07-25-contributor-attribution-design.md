# 设计：贡献者标注（块 B）

> 日期：2026-07-25
> 状态：已确认（头脑风暴阶段），待实现
> 依赖：块 A（GitHub OAuth 身份）已完成 —— 提供当前登录身份 `getStatus().login`。
> 与块 C（邀请）、块 D（误删恢复）、块 E（内存）独立。

## 目标

协作工作空间里，每条文献记录「是谁添加的」（GitHub 用户名），并在条目列表每行
显示该贡献者的 GitHub 头像（hover 显示用户名）。让协作者一眼看出每条是谁录入的。

## 背景 / 约束

- **身份来源**：块 A 的 GitHub 登录。当前用户 = `getStatus().login`。
- **只在 github 工作空间标注**：个人库 / 本地工作空间没有协作，`added_by` 为 null，
  列表不显示头像。
- **归属随数据走**：`added_by` 写进 `item.json`，协作者拉取后看到的是**原始添加者**，
  不是拉取者自己。导入时按 json 里的值恢复，绝不用导入者身份覆盖。
- **头像离线可用、避 CSP**：主进程抓一次 GitHub 头像缓存到本地，渲染层用
  `veridian-file://` 加载；失败回落到「文字首字母圆形头像」（纯前端，不依赖网络）。
- **层次干净**：`db/items.ts` 是底层仓库层，不能 import 服务层（避免循环依赖）。

## 架构与组件

### 1. `added_by` 字段贯通

- **DB 迁移 v6**（`db/index.ts`）：`items` 表加 `added_by TEXT`（nullable，ALTER TABLE，
  零风险，沿用现有 `if (current < N)` 迁移模式）。
- **类型**：`shared/types.ts` 的 `Item` 加 `added_by: string | null`；
  `WorkspaceFiles.ts` 的 `ItemJson` 加 `added_by: string | null`。

### 2. 归属捕获（避免层次循环的关键设计）

- **新增 `src/main/services/attribution.ts`**：一个**零 import** 的可变持有器：
  ```ts
  let current: string | null = null
  export function getAttribution(): string | null { return current }
  export function setAttribution(login: string | null): void { current = login }
  ```
  因为它不 import 任何东西，`db/items.ts` 可安全 import 它，无循环。
- **写入**：`db/items.ts` 的 `createItem` 读 `getAttribution()` 写进 `added_by`。
  （所有创建路径——ItemService / pdfImporter / 浏览器扩展 server——都经过这个
  底层 `createItem`，一处即全覆盖。）
- **设置时机**：`WorkspaceContextService.setActiveWorkspace` 在确定工作空间后：
  `setAttribution(active.kind === 'github' ? (await getStatus()).login : null)`。
  **顺序保证正确性**：github 工作空间的激活必须先通过 git 鉴权（`onAuth` 无 token
  会抛 `no_auth`），所以能进 github 空间时必已登录，`getStatus().login` 必有值。
- **导入不覆盖**：`WorkspaceFiles.importItem` 把 `added_by` 从 json 原样写入
  （不经 `createItem` 的 attribution 逻辑——importItem 用的是直接 SQL）。

### 3. 头像缓存 `AvatarService.ts`（主进程，新增）

- `getAvatarPath(login: string): Promise<string | null>`：
  1. 目标路径 `userData/avatars/<login>.png`；已存在直接返回（`grantAccess` 后）。
  2. 否则 `net.fetch('https://github.com/<login>.png?size=64')` → 写入 → grantAccess → 返回。
  3. 任何失败返回 null（渲染层回落首字母头像）。
- IPC `github:avatarPath`（`z.tuple([z.string().min(1).max(64)])`）→ 返回本地路径或 null。
- 缓存无过期（头像很少变；v1 不做刷新）。

### 4. UI（渲染层）

- **item 列表每行**（`ItemListPane.tsx` 的 `ItemRow`）：当 `item.added_by` 非空，
  在右侧信息列显示一个 16–18px 圆形头像，`title`（hover tooltip）= `added_by`。
- **头像组件**（可复用小组件 `ContributorAvatar`）：
  - 收到 login → 调 `github:avatarPath` → 有路径则 `<img src=veridian-file://...>`；
  - 无路径 → 渲染首字母圆形头像（login 首字母 + 由 login 派生的稳定背景色）。
  - blob/URL 无需 revoke（用 veridian-file:// 直连，非 createObjectURL）。

## 数据流

```
用户在 github 工作空间导入/新建条目
  → createItem 读 getAttribution()（= 当前登录 login）→ 写 items.added_by
  → 同步时 exportItems 把 added_by 写进 item.json
  → 协作者 sync 拉取 → importItem 从 json 读 added_by 原样入库
  → 列表渲染 ItemRow → ContributorAvatar(login)
      → github:avatarPath → 本地缓存头像 or 首字母回落
```

## 错误处理

- 头像抓取失败 / 离线 / 用户不存在 → `getAvatarPath` 返回 null → 首字母头像。
- `added_by` 为 null（个人/本地空间的条目，或旧数据）→ 不显示头像，无占位。
- attribution 未设置（理论上进不了 github 空间就不会创建协作条目）→ null，安全。

## 测试

- **单元**：
  - `attribution.ts`：set/get 往返。
  - `db/items.createItem`：设置 attribution 后创建，断言 `added_by` 写入；attribution
    为 null 时 `added_by` 为 null。（用现有 better-sqlite3 内存库或临时库）
- **端到端（手动 + 自动）**：
  - 自动：在 github 工作空间模拟 createItem → 断言 item.json 含 added_by → importItem
    往返保持不变（可用临时目录 + 直接调用 export/import）。
  - 手动：登录后在 github 工作空间导入一篇 → 列表行显示自己的头像；hover 显示用户名。

## 改造清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/main/db/index.ts` | 迁移 v6：`items` 加 `added_by TEXT` |
| `src/shared/types.ts` | `Item.added_by: string \| null` |
| `src/main/services/attribution.ts` | 新增：零 import 归属持有器 |
| `src/main/services/attribution.test.ts` | 新增：单测 |
| `src/main/db/items.ts` | `createItem` 写 `added_by`（读 attribution）；INSERT/SELECT 带该列 |
| `src/main/db/items.test.ts` | 新增：createItem attribution 单测 |
| `src/main/services/GitHubService.ts` | 无需改（getStatus 已返回 login） |
| `src/main/services/WorkspaceContextService.ts` | 激活后 `setAttribution(...)` |
| `src/main/services/WorkspaceFiles.ts` | export/import `added_by`（ItemJson + SQL） |
| `src/main/services/AvatarService.ts` | 新增：头像抓取+缓存 |
| `src/shared/ipc-contract.ts` | 新增 `github:avatarPath` |
| `src/main/ipc/handlers.ts` | `github:avatarPath` handler |
| `src/preload/index.ts` + `env.d.ts` | 暴露 `github.avatarPath` |
| `src/renderer/.../ItemListPane.tsx` | ContributorAvatar + 行内渲染 |
| i18n `index.ts` | 「由 X 添加」tooltip 文案（如需） |

## 非目标（明确不做）

- 头像刷新/过期（v1 抓一次永久缓存）
- 「谁修改的」编辑历史（只标「谁添加的」）
- 邀请协作者（块 C）
- 头像点击跳 GitHub 主页等交互（YAGNI）
