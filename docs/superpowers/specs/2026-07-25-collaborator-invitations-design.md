# 设计：软件内邀请协作者（块 C）

> 日期：2026-07-25
> 状态：已确认，待实现
> 依赖：块 A（GitHub OAuth 身份，已完成）—— 提供 `getGitHubToken()`/`getStatus()`。
> 与块 D（误删恢复）、块 E（内存优化）独立。

## 目标

不分享任何密钥的前提下，在软件内完成协作邀请全流程：
1. 仓库 owner 在工作空间列表里，对某个 github 类型的工作空间点"邀请协作者"，
   填对方 GitHub 用户名即可发出邀请（用 owner 自己的令牌调 GitHub API）。
2. 被邀请人打开软件，工作空间切换器出现小红点；下拉菜单顶部列出待处理邀请，
   一键接受或拒绝（用被邀请人自己的令牌调 GitHub API）。
3. 接受后，该仓库出现在被邀请人已有的"接入协作仓库"列表里，走现成流程连接
   （选本地存储路径 → 建工作空间）——不重复造轮子。

## 背景 / 约束（已核对当前代码）

- **架构确认延续既定设计**：GitHub 原生仓库邀请系统当"信使"，全程各用各的
  令牌，不共享 PAT/OAuth token。这在块 A 完成后依然成立——`GitHubService.ts`
  已导出 `getGitHubToken()`，本块的新 API 调用复用同一令牌与 `API_HEADERS`。
- **复用现有"接入协作仓库"流程**：`WorkspaceDialog.tsx` 的 `ConnectRepoSection`
  已经实现"列出令牌可访问的仓库 → 选本地存储路径 → 建工作空间"。接受邀请后，
  该仓库自然出现在这个列表里（GitHub 侧已把用户加为 collaborator），**无需
  重新实现**选路径/建工作空间的逻辑。
- **无需新的全局 store**：邀请列表只有 `WorkspaceSwitcher` 一处消费，用组件
  本地 state 即可，不新增 zustand store。
- **不做持续轮询**：只在应用启动（`WorkspaceSwitcher` 挂载时，已登录状态下）
  查一次待处理邀请，避免额外的后台网络活动；用户也可通过重新打开下拉菜单
  手动感知（下拉菜单每次打开不重新查询，保持简单，见"非目标"）。

## GitHub API（新封装进 `GitHubService.ts`）

| 操作 | 端点 | 用途 |
|---|---|---|
| 发邀请 | `PUT /repos/{owner}/{repo}/collaborators/{username}` | owner 邀请协作者（body: `{permission: 'push'}`，写权限，不做等级选择器） |
| 查待处理邀请 | `GET /user/repository_invitations` | 被邀请人查自己的邀请列表 |
| 接受邀请 | `PATCH /user/repository_invitations/{id}` | 被邀请人接受 |
| 拒绝邀请 | `DELETE /user/repository_invitations/{id}` | 被邀请人拒绝（避免邀请一直挂着） |

**发邀请的响应语义**（GitHub 行为，需在 `inviteCollaborator` 里映射成用户可读结果）：
- `201`：邀请已发出
- `204`：对方已经是协作者，无需邀请（视为成功，提示"已是协作者"）
- `404`：仓库不可访问，或该用户名不存在——GitHub 故意不区分，我们也不区分
  （沿用 `testRepoAccess` 里 404 的既有处理惯例）
- `403`：当前令牌没有邀请权限（不是该仓库的 admin）

## 架构与组件

### 1. `GitHubService.ts`（改，新增四个函数）

```ts
export interface Invitation {
  id: number
  repoOwner: string
  repoName: string
  repoFullName: string
  inviterLogin: string
}

export type InviteResult =
  | { ok: true; alreadyCollaborator: boolean }
  | { ok: false; code: 'not_found' | 'forbidden' | 'http_error' | 'network'; detail?: string }

export async function inviteCollaborator(owner: string, repo: string, username: string): Promise<InviteResult>
export async function listInvitations(): Promise<Invitation[]>
export async function acceptInvitation(id: number): Promise<void>
export async function declineInvitation(id: number): Promise<void>
```
均用 `getGitHubToken()` + 现有 `API_HEADERS` 发请求，风格与 `listRepos`/
`testRepoAccess` 一致。

### 2. IPC（`ipc-contract.ts` + `handlers.ts` + `preload` + `env.d.ts`）

新增四个 GitHub 通道：`github:inviteCollaborator`、`github:listInvitations`、
`github:acceptInvitation`、`github:declineInvitation`，风格与现有
`github:testRepo`/`github:listRepos` 一致。

### 3. `WorkspaceList`（`WorkspaceDialog.tsx` 内，改）

每个 `kind === 'github'` 的工作空间行，右侧加一个"邀请协作者"按钮（次要按钮
样式，与现有"删除"按钮并列）。点击后该行展开一个内联小表单：一个用户名
输入框 + 确认按钮，提交调 `github:inviteCollaborator(repo_owner, repo_name, username)`，
按返回结果显示成功/已是协作者/失败文案，提交后收起表单。

### 4. `WorkspaceSwitcher`（改，红点 + 下拉邀请区）

- 组件挂载且已登录（复用现有 `identity.authed` 判断）时，调一次
  `github:listInvitations()`，存入本地 state。
- 有待处理邀请时，切换器触发按钮右上角加一个小红点徽标。
- 下拉面板：在现有"当前身份行"之后、"个人库"之前，新增一个邀请区块——每条
  显示"`<inviterLogin>` 邀请你加入 `<repoFullName>`" + 接受/拒绝两个小按钮。
  接受/拒绝调对应 IPC，成功后从本地列表移除该条（红点自动消失，若清空）。
- 接受成功后额外提示一行"已加入，前往「管理工作空间」→「接入协作仓库」连接"
  （不自动跳转、不自动建工作空间——按你的选择，复用现有入口）。

## 数据流

```
Owner：工作空间列表点"邀请协作者" → 填用户名 → github:inviteCollaborator
  → PUT /repos/{owner}/{repo}/collaborators/{username}（owner 令牌）
  → 201/204/404/403 → 映射为提示文案

被邀请人：打开软件 → WorkspaceSwitcher 挂载 → github:listInvitations（自己令牌）
  → 有邀请 → 红点 + 下拉列表
  → 点接受 → github:acceptInvitation → PATCH .../repository_invitations/{id}
  → 从本地列表移除该条
  → 用户手动打开"管理工作空间" → ConnectRepoSection.loadRepos()
    → 该仓库出现在列表（GitHub 侧已生效）→ 走现有"接入"流程
```

## 错误处理

- 发邀请失败（404/403/网络）：内联表单下方显示错误文案，不清空输入框，
  允许重试。
- 查邀请列表失败（未登录/网络问题）：静默失败，红点不显示，不报错弹窗
  （装饰性功能，失败不打扰主流程——与 `FigureStrip` 的错误处理哲学一致）。
- 接受/拒绝失败：该条邀请保留在列表里，行内显示一次性错误提示。

## 测试

- **手动 E2E**（需要两个真实 GitHub 账号，跨设备/跨登录会话验证）：
  1. 账号 A（owner）：工作空间列表对一个 github 工作空间点邀请，填账号 B
     的用户名 → 提示邀请已发出。
  2. 账号 B：打开软件（用账号 B 登录）→ 切换器出现红点 → 下拉看到来自 A
     的邀请 → 点接受 → 红点消失。
  3. 账号 B：打开"管理工作空间" → "接入协作仓库" → 加载列表 → 该仓库出现
     → 点接入 → 选本地路径 → 工作空间建好，能正常同步。
  4. 重复邀请已是协作者的账号 → 提示"已是协作者"，不报错。
  5. 邀请一个不存在的用户名 → 提示失败（404 路径）。
  6. 账号 B 对某条邀请点拒绝 → 从列表消失；账号 A 侧该邀请在 GitHub 上确实
     被撤销（可选，非阻塞验证）。
- 无法自动化（依赖真实 GitHub 账号间的网络交互），不强求单元测试覆盖 API
  封装本身——`GitHubService.ts` 里已有的 `listRepos`/`testRepoAccess` 同样
  没有单测先例，保持一致。

## 改造清单

| 文件 | 改动 |
|---|---|
| `src/main/services/GitHubService.ts` | 新增 `inviteCollaborator`/`listInvitations`/`acceptInvitation`/`declineInvitation` |
| `src/shared/ipc-contract.ts` | 新增四个 `github:*` 通道 |
| `src/main/ipc/handlers.ts` | 对应四个 handler |
| `src/preload/index.ts` | 暴露四个方法 |
| `src/renderer/src/env.d.ts` | 对应类型 |
| `src/renderer/src/components/workspace/WorkspaceDialog.tsx` | `WorkspaceList` 行内加邀请表单 |
| `src/renderer/src/components/workspace/WorkspaceSwitcher.tsx` | 红点 + 下拉邀请区 |
| i18n `index.ts` | 邀请相关文案（zh/en） |

## 非目标（明确不做）

- 邀请权限等级选择器（固定写权限 `push`）
- 持续轮询待处理邀请（只在切换器挂载时查一次）
- 接受邀请后自动建工作空间（复用现有"接入协作仓库"手动流程）
- 邀请列表的单元测试基础设施（纯 API 封装，与现有 `listRepos` 同类代码
  保持一致的测试策略——手动 E2E）
- 邀请通知的桌面系统通知/声音提醒（只在应用内 UI 呈现）
