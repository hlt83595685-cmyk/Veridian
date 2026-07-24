# 设计：GitHub OAuth 身份基座（块 A）

> 日期：2026-07-25
> 状态：已确认，待实现
> 这是「GitHub 原生协作」拆分中的第一块（地基）。后续块 B（贡献者标注）、
> 块 C（软件内邀请）都依赖本块交付的身份体系。块 D（误删恢复）、块 E（内存
> 优化）与本块独立。

## 目标

把现有「粘贴 PAT」的 GitHub 认证，替换成 **OAuth 设备流（Device Flow）**的
「用 GitHub 登录」体验。交付后：能用 GitHub 登录、界面显示当前身份（头像+用户
名）、git 同步照常工作。**不含** `added_by` 标注（块 B）和邀请（块 C）。

## 背景 / 约束

- **零成本、无自建服务器**：延续现有 local-first + GitHub 架构。
- **为什么是设备流而非授权码流**：授权码流换令牌需要 client_secret，而 GitHub
  OAuth App 不支持 PKCE。桌面软件分发给所有人，嵌入 client_secret = 密钥泄露
  （可被提取冒充 App）。设备流专为「不能安全保存密钥的设备」设计（`gh` CLI、
  VS Code 同款），只需公开的 client_id，无密钥风险。已与用户确认选设备流。
- **开发阶段，无老用户**：直接删除 PAT 相关代码，不保留双轨兼容。
- **令牌不过期**：GitHub OAuth App 令牌默认不过期，v1 不实现 refresh 逻辑；
  令牌失效（用户在 GitHub 撤销）时 API 返回 401，回落到「未登录」提示重登。

## 已注册的 OAuth App

- Client ID：`Ov23ctrnOpGpsZz3wUMF`（公开值，作为源码常量嵌入）
- 已勾选 "Enable Device Flow"
- scope 请求：`repo`（私有仓库 git 读写 + 后续块 C 的邀请 API 都需要）

## 核心洞察

git 操作里令牌只是当 HTTP basic-auth 的 password 用
（`GitWorkspaceService.onAuth` → `{ username: 'x-access-token', password: token }`）。
OAuth 令牌在此用法**完全一致**。所以 git 同步、GitHub API、作者身份这些**下游几乎
不改**，只把「令牌从哪来」这一处从 `getPat()` 换成统一的 `getGitHubToken()`。

## 架构与组件

### 1. `OAuthService.ts`（主进程，新增）

设备流实现：

- `startDeviceLogin()`：
  1. `POST https://github.com/login/device/code`（body: `client_id`, `scope=repo`）
     → 拿到 `device_code` / `user_code` / `verification_uri` / `interval` / `expires_in`
  2. 把 `user_code` 复制到系统剪贴板（`clipboard.writeText`）
  3. `shell.openExternal(verification_uri)`（`https://github.com/login/device`）
  4. 返回 `{ userCode, verificationUri }` 给渲染层显示
  5. 后台按 `interval` 轮询 `POST https://github.com/login/oauth/access_token`
     （body: `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`）
- 轮询结果分支（GitHub 返回的 `error` 字段）：
  - `authorization_pending` → 继续等
  - `slow_down` → 加大间隔后继续
  - 成功（返回 `access_token`）→ 存储令牌、发 domain-event 通知登录成功、停止轮询
  - `expired_token` / `access_denied` → 停止，报错给渲染层
- `cancelDeviceLogin()`：用户关闭对话框时停止轮询。
- 所有网络调用带超时；失败不抛进主进程致命路径（沿用现有 unhandledRejection 保护）。

### 2. 统一凭据入口（改造 `GitHubService.ts`）

- 新增 `getGitHubToken(): string`：返回当前 OAuth 令牌（存于 settings
  `github.oauthToken`，加入 `SECRET_KEYS`，safeStorage 加密，与原 PAT 同机制）。
- **删除** `getPat` / `setPat` / `github.pat` key。
- `getStatus()` 保留并扩展返回 `{ authed, login, avatarUrl, method: 'oauth' | null }`
  （`login` / `avatar_url` 来自 `GET /user`）。供 UI 显示身份。
- `listRepos` / `testRepoAccess` 改用 `getGitHubToken()`。

### 3. git 层（`GitWorkspaceService.ts`）

- `onAuth()`：`getPat()` → `getGitHubToken()`，其余不变。
- `author()`：已用 `getStatus().login`，无需改（登录后即拿到真实 login）。

### 4. IPC（`ipc-contract.ts` + `handlers.ts` + `preload`）

- 新增：`github:loginStart`（→ `{ userCode, verificationUri }`）、
  `github:loginCancel`、`github:logout`、`github:getIdentity`（→ 身份对象）。
- 登录成功通过现有 domain-event 流推送（新增事件类型如
  `github.authChanged`），渲染层订阅后刷新身份显示。
- **删除**：`github:setPat`；`RENDERER_BLOCKED_SETTINGS` 里的 `github.pat`
  （改为 `github.oauthToken`，渲染层永不可读令牌明文）。

### 5. UI（渲染层）

- `WorkspaceSettingsTab.tsx`：PAT 输入框 → 「用 GitHub 登录」按钮。
  - 未登录：大按钮「用 GitHub 登录」。
  - 点击 → 弹**设备码对话框**：显示 `user_code`（已复制到剪贴板的提示）+
    「浏览器已打开，请粘贴此码并授权」+ 一个「我已授权 / 等待中…」状态。
  - 后台轮询到成功 → 对话框自动关闭 → 显示 `[头像] <login> · 已登录` +
    「退出登录」。
  - 失败/超时 → 提示 + 「重试」。
- **工作空间切换器**（`WorkspaceSwitcher.tsx`）下拉顶部加一行当前身份：
  `[头像] <login>`；未登录显示「未连接 GitHub · 点此登录」→ 跳设置。
- 头像加载：本块先直接用 `getStatus` 返回的 `avatar_url`（GitHub 头像 URL）。
  > 注：若 CSP 阻拦外部图片，回落到文字首字母圆形头像。头像的本地缓存机制
  > （主进程抓取 + `veridian-file://`）留到块 B 统一实现，因为块 B 要给列表里
  > 每条文献显示头像，届时缓存才有必要。

## 数据流

```
点「用 GitHub 登录」
  → IPC github:loginStart
  → OAuthService: POST device/code → 复制 user_code + 开浏览器
  → 返回 {userCode, verificationUri} → 对话框显示
  → OAuthService 后台轮询 access_token
  → 用户在浏览器粘贴码 + Authorize
  → 轮询拿到 access_token → 存 github.oauthToken → emit github.authChanged
  → 渲染层收到事件 → github:getIdentity → 显示头像+login → 关对话框
```

## 错误处理

- 网络失败 / GitHub 不可达：对话框显示错误 + 重试，不阻塞应用。
- `expired_token`：提示码已过期，重新发起。
- `access_denied`：提示用户拒绝了授权。
- 令牌失效（后续 API 401）：`getStatus` 返回 `authed: false`，UI 回落未登录态。
- 轮询期间用户关闭对话框：`github:loginCancel` 停止轮询，不留后台循环。

## 测试

- **单元**：`OAuthService` 用 mock 打两个 GitHub 端点，覆盖轮询四种结果
  （`authorization_pending` / 成功 / `expired_token` / `access_denied`）和
  `slow_down` 加速退避。`getGitHubToken` 的存取。
- **端到端（手动）**：涉及真实浏览器授权，无法全自动。用真实 GitHub 账号手动
  走一遍：点登录 → 浏览器粘贴授权 → 回到软件确认显示头像+用户名 → 在已连接的
  github 工作空间执行一次同步，确认 git 操作用新令牌正常。

## 改造清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/main/services/OAuthService.ts` | 新增：设备流 |
| `src/main/services/GitHubService.ts` | `getGitHubToken` 统一入口；删 PAT；扩展 `getStatus` |
| `src/main/services/GitWorkspaceService.ts` | `onAuth` 改用 `getGitHubToken` |
| `src/main/services/SettingsService.ts` | `SECRET_KEYS`：`github.pat` → `github.oauthToken` |
| `src/main/ipc/handlers.ts` | 新增 login 系列 handler；删 `github:setPat`；改 blocked key |
| `src/shared/ipc-contract.ts` | 新增 login 通道；删 `github:setPat` |
| `src/shared/events.ts` | 新增 `github.authChanged` 事件 |
| `src/preload/index.ts` | 暴露 login 系列 API；删 `setPat` |
| `src/renderer/.../WorkspaceSettingsTab.tsx` | PAT 输入 → 登录按钮 + 设备码对话框 |
| `src/renderer/.../WorkspaceSwitcher.tsx` | 顶部身份行 |
| i18n `zh/en common.json` | 新增登录相关文案 |

## 非目标（明确不做）

- `added_by` 贡献者标注（块 B）
- 头像本地缓存（块 B）
- 软件内邀请 / repository_invitations API（块 C）
- 令牌过期 / refresh 处理（GitHub OAuth App 令牌默认不过期）
- 授权码流 / client_secret（已确认走设备流）
