# GitHub OAuth 身份基座（块 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 GitHub OAuth 设备流的「用 GitHub 登录」替换现有的 PAT 粘贴认证，登录后界面显示身份（头像+用户名），git 同步用新令牌照常工作。

**Architecture:** 设备流核心逻辑写成纯函数（注入 `fetch` + 回调，可脱离 Electron 单测）；`OAuthService` 主进程胶水层负责剪贴板/开浏览器/令牌存储；`getGitHubToken()` 成为唯一凭据入口，下游 git/API/身份全部改用它；PAT 相关代码整体删除（开发阶段，无老用户）。

**Tech Stack:** Electron 36 主进程、better-sqlite3、zod IPC 契约、React 18 渲染层、vitest（项目首批单测）、GitHub Device Flow API。

参考 spec：`docs/superpowers/specs/2026-07-25-github-oauth-identity-design.md`
Client ID（公开常量）：`Ov23ctrnOpGpsZz3wUMF`

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/main/services/deviceFlow.ts`（新） | 纯设备流逻辑：请求码 + 轮询状态机，注入 fetch/sleep，无 Electron 依赖 |
| `src/main/services/deviceFlow.test.ts`（新） | deviceFlow 单测（项目首个测试文件） |
| `src/main/services/OAuthService.ts`（新） | Electron 胶水：调 deviceFlow + 剪贴板 + 开浏览器 + 存令牌 + emit 事件 |
| `src/main/services/GitHubService.ts`（改） | `getGitHubToken` 统一入口；删 PAT；扩展 `getStatus` 返回 avatarUrl |
| `src/main/services/GitWorkspaceService.ts`（改） | `onAuth` 改用 `getGitHubToken` |
| `src/main/services/SettingsService.ts`（改） | SECRET_KEYS：`github.pat` → `github.oauthToken` |
| `src/shared/events.ts`（改） | 新增 `github.authChanged` 事件 |
| `src/shared/ipc-contract.ts`（改） | 新增 login 通道；删 `github:setPat` |
| `src/main/ipc/handlers.ts`（改） | login handler；删 setPat；改 blocked key |
| `src/preload/index.ts`（改） | 暴露 login API；删 setPat |
| `src/renderer/src/components/workspace/WorkspaceSettingsTab.tsx`（改） | 登录按钮 + 设备码对话框 |
| `src/renderer/src/components/workspace/WorkspaceSwitcher.tsx`（改） | 顶部身份行 |
| `src/renderer/src/i18n/locales/{zh,en}/common.json`（改） | 登录文案 |

---

## Task 1: 设备流纯逻辑 + 单测

**Files:**
- Create: `src/main/services/deviceFlow.ts`
- Test: `src/main/services/deviceFlow.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/services/deviceFlow.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { requestDeviceCode, pollForToken, type Fetcher } from './deviceFlow'

const CLIENT_ID = 'test-client'

function jsonFetcher(map: Record<string, unknown>): Fetcher {
  return (async (url: string) => ({
    ok: true,
    json: async () => map[url],
  })) as unknown as Fetcher
}

describe('requestDeviceCode', () => {
  it('parses the device/code response', async () => {
    const fetch = jsonFetcher({
      'https://github.com/login/device/code': {
        device_code: 'dev123', user_code: 'WDJB-MJHT',
        verification_uri: 'https://github.com/login/device',
        interval: 5, expires_in: 900,
      },
    })
    const r = await requestDeviceCode(CLIENT_ID, 'repo', fetch)
    expect(r.userCode).toBe('WDJB-MJHT')
    expect(r.deviceCode).toBe('dev123')
    expect(r.interval).toBe(5)
  })
})

describe('pollForToken', () => {
  it('returns the access token on success', async () => {
    const responses = [
      { error: 'authorization_pending' },
      { access_token: 'gho_abc', token_type: 'bearer', scope: 'repo' },
    ]
    let i = 0
    const fetch = (async () => ({ ok: true, json: async () => responses[i++] })) as unknown as Fetcher
    const token = await pollForToken(CLIENT_ID, 'dev123', 0, fetch, { sleep: async () => {} })
    expect(token).toBe('gho_abc')
  })

  it('throws on expired_token', async () => {
    const fetch = (async () => ({ ok: true, json: async () => ({ error: 'expired_token' }) })) as unknown as Fetcher
    await expect(pollForToken(CLIENT_ID, 'dev123', 0, fetch, { sleep: async () => {} }))
      .rejects.toThrow('expired_token')
  })

  it('throws on access_denied', async () => {
    const fetch = (async () => ({ ok: true, json: async () => ({ error: 'access_denied' }) })) as unknown as Fetcher
    await expect(pollForToken(CLIENT_ID, 'dev123', 0, fetch, { sleep: async () => {} }))
      .rejects.toThrow('access_denied')
  })

  it('honors slow_down by increasing interval then succeeding', async () => {
    const responses = [
      { error: 'slow_down', interval: 1 },
      { access_token: 'gho_xyz' },
    ]
    let i = 0
    const sleeps: number[] = []
    const fetch = (async () => ({ ok: true, json: async () => responses[i++] })) as unknown as Fetcher
    const token = await pollForToken(CLIENT_ID, 'dev123', 0, fetch, {
      sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(token).toBe('gho_xyz')
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
  })

  it('stops when the cancel signal is set', async () => {
    const cancelled = { value: false }
    const fetch = (async () => { cancelled.value = true; return { ok: true, json: async () => ({ error: 'authorization_pending' }) } }) as unknown as Fetcher
    await expect(pollForToken(CLIENT_ID, 'dev123', 0, fetch, {
      sleep: async () => {},
      isCancelled: () => cancelled.value,
    })).rejects.toThrow('cancelled')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/main/services/deviceFlow.test.ts`
Expected: FAIL（`Cannot find module './deviceFlow'`）

- [ ] **Step 3: 写最小实现**

`src/main/services/deviceFlow.ts`:

```ts
// Pure GitHub Device Flow logic -- no Electron deps, so it unit-tests under
// plain vitest. The Electron glue (clipboard, browser, token storage) lives
// in OAuthService and calls into here.
export type Fetcher = (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<any> }>

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

async function postJson(fetch: Fetcher, url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

export async function requestDeviceCode(clientId: string, scope: string, fetch: Fetcher): Promise<DeviceCode> {
  const d = await postJson(fetch, DEVICE_CODE_URL, { client_id: clientId, scope })
  if (!d.device_code) throw new Error(d.error ?? 'device_code_request_failed')
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    interval: d.interval ?? 5,
    expiresIn: d.expires_in ?? 900,
  }
}

export interface PollDeps {
  sleep: (ms: number) => Promise<void>
  isCancelled?: () => boolean
}

export async function pollForToken(
  clientId: string, deviceCode: string, intervalSec: number,
  fetch: Fetcher, deps: PollDeps,
): Promise<string> {
  let interval = intervalSec
  for (;;) {
    if (deps.isCancelled?.()) throw new Error('cancelled')
    await deps.sleep(interval * 1000)
    if (deps.isCancelled?.()) throw new Error('cancelled')
    const d = await postJson(fetch, ACCESS_TOKEN_URL, {
      client_id: clientId, device_code: deviceCode, grant_type: GRANT_TYPE,
    })
    if (d.access_token) return d.access_token
    switch (d.error) {
      case 'authorization_pending': break
      case 'slow_down': interval = (d.interval ?? interval) + 1; break
      default: throw new Error(d.error ?? 'token_poll_failed')
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/main/services/deviceFlow.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/main/services/deviceFlow.ts src/main/services/deviceFlow.test.ts
git commit -m "feat: GitHub device-flow core logic (pure, unit-tested)"
```

---

## Task 2: OAuthService（Electron 胶水）+ 统一凭据入口

**Files:**
- Create: `src/main/services/OAuthService.ts`
- Modify: `src/main/services/GitHubService.ts`
- Modify: `src/main/services/SettingsService.ts:9`

- [ ] **Step 1: 改 SECRET_KEYS**

`SettingsService.ts:9` 把 `github.pat` 换成 `github.oauthToken`:

```ts
const SECRET_KEYS = new Set(['tool.pdf2md.apiToken', 'controlPlane.session', 'github.oauthToken'])
```

- [ ] **Step 2: 重写 GitHubService 的凭据入口（删 PAT）**

`GitHubService.ts` 顶部与凭据部分改为：

```ts
import { getSetting, setSetting } from './SettingsService'
import { emit } from '../core/Notifier'

const TOKEN_KEY = 'github.oauthToken'

const API_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Veridian',
})

/** The single credential accessor. Everything downstream (git onAuth, API
 *  calls, commit author) reads the current token from here. */
export function getGitHubToken(): string {
  const v = getSetting(TOKEN_KEY)
  return typeof v === 'string' ? v : ''
}

export function setGitHubToken(token: string): void {
  setSetting(TOKEN_KEY, token)
  emit({ type: 'github.authChanged' })
}

export function clearGitHubToken(): void {
  setSetting(TOKEN_KEY, '')
  emit({ type: 'github.authChanged' })
}
```

删除 `PAT_KEY` / `getPat` / `setPat`。

- [ ] **Step 3: 扩展 getStatus 返回 avatarUrl**

`GitHubService.ts` 的 `GitHubStatus` 与 `getStatus` 改为：

```ts
export interface GitHubStatus {
  authed: boolean
  login: string | null
  avatarUrl: string | null
  error: string | null
}

export async function getStatus(): Promise<GitHubStatus> {
  const token = getGitHubToken()
  if (!token) return { authed: false, login: null, avatarUrl: null, error: null }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { authed: false, login: null, avatarUrl: null, error: `GitHub HTTP ${res.status}` }
    const user = (await res.json()) as { login?: string; avatar_url?: string }
    return { authed: true, login: user.login ?? null, avatarUrl: user.avatar_url ?? null, error: null }
  } catch (err) {
    return { authed: false, login: null, avatarUrl: null, error: (err as Error).message }
  }
}
```

在 `listRepos` / `testRepoAccess` 中把 `const pat = getPat()` 改为 `const token = getGitHubToken()`，`if (!pat)` → `if (!token)`，`API_HEADERS(pat)` → `API_HEADERS(token)`。

- [ ] **Step 4: 写 OAuthService**

`src/main/services/OAuthService.ts`:

```ts
// Electron glue over the pure deviceFlow logic: kicks off login, copies the
// user code to the clipboard, opens the browser, polls in the background, and
// stores the token. One login runs at a time.
import { clipboard, shell } from 'electron'
import { requestDeviceCode, pollForToken, type Fetcher } from './deviceFlow'
import { setGitHubToken } from './GitHubService'
import { emit } from '../core/Notifier'

const CLIENT_ID = 'Ov23ctrnOpGpsZz3wUMF'
const SCOPE = 'repo'

const nodeFetch: Fetcher = ((url: string, init?: unknown) =>
  fetch(url, init as RequestInit)) as unknown as Fetcher

let cancelFlag = false

export interface LoginStart {
  userCode: string
  verificationUri: string
}

/** Begin device login: returns the code to show, and polls in the background.
 *  On success stores the token and emits github.authChanged. */
export async function startDeviceLogin(): Promise<LoginStart> {
  cancelFlag = false
  const code = await requestDeviceCode(CLIENT_ID, SCOPE, nodeFetch)
  clipboard.writeText(code.userCode)
  shell.openExternal(code.verificationUri)

  // Background poll -- do NOT await; the renderer learns via github.authChanged.
  void pollForToken(CLIENT_ID, code.deviceCode, code.interval, nodeFetch, {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    isCancelled: () => cancelFlag,
  })
    .then((token) => setGitHubToken(token))
    .catch((err) => {
      if ((err as Error).message !== 'cancelled') {
        console.warn('[oauth] login failed:', (err as Error).message)
        emit({ type: 'github.authChanged' })   // renderer re-reads status (still unauthed)
      }
    })

  return { userCode: code.userCode, verificationUri: code.verificationUri }
}

export function cancelDeviceLogin(): void {
  cancelFlag = true
}
```

- [ ] **Step 5: typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E 'GitHubService|OAuthService|SettingsService|GitWorkspace'`
Expected: 无输出（这些文件无类型错误；GitWorkspaceService 在 Task 3 修）

> 注：此刻 `GitWorkspaceService.ts` 仍引用已删除的 `getPat`，会报错——Task 3 修复。本步只检查本任务改的文件。

- [ ] **Step 6: 提交**

```bash
git add src/main/services/OAuthService.ts src/main/services/GitHubService.ts src/main/services/SettingsService.ts
git commit -m "feat: OAuthService device-login glue + unified getGitHubToken (remove PAT)"
```

---

## Task 3: git 层改用统一令牌

**Files:**
- Modify: `src/main/services/GitWorkspaceService.ts:15,24-29`

- [ ] **Step 1: 改 import 与 onAuth**

`GitWorkspaceService.ts:15` 改为：

```ts
import { getGitHubToken, getStatus } from './GitHubService'
```

`onAuth`（24-29）改为：

```ts
function onAuth(): { username: string; password: string } {
  const token = getGitHubToken()
  if (!token) throw new Error('no_auth')
  // GitHub accepts a token over basic auth with this fixed username
  return { username: 'x-access-token', password: token }
}
```

（`author()` 用 `getStatus().login`，无需改。）

- [ ] **Step 2: 全量 typecheck（node）**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'`
Expected: `4`（与既有基线一致：gateway.ts、server/index.ts:177、GitWorkspaceService.ts:92、MetadataService.ts——这些是本次任务之前就存在的错误，不是本改动引入）

> 验证方法：确认输出里**没有** `getPat`、`no_pat`、`OAuthService`、`deviceFlow` 相关的新错误。

- [ ] **Step 3: 提交**

```bash
git add src/main/services/GitWorkspaceService.ts
git commit -m "refactor: git auth uses getGitHubToken"
```

---

## Task 4: IPC 契约 / 事件 / handlers / preload 布线

**Files:**
- Modify: `src/shared/events.ts:32`
- Modify: `src/shared/ipc-contract.ts:117-121`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: 新增 domain 事件**

`events.ts` 在 `DomainEvent` 联合类型里加一行（在 `controlPlane.changed` 附近）：

```ts
  | { type: 'github.authChanged' }
```

- [ ] **Step 2: 改 IPC 契约**

`ipc-contract.ts:117-121` 的 GitHub 段替换为：

```ts
  // GitHub OAuth (data-plane credential, strictly per-device -- never synced)
  'github:loginStart':  z.tuple([]),
  'github:loginCancel': z.tuple([]),
  'github:logout':      z.tuple([]),
  'github:getStatus':   z.tuple([]),
  'github:testRepo':    z.tuple([z.string().min(1).max(512)]),
  'github:listRepos':   z.tuple([]),
```

（删掉 `github:setPat`。）

- [ ] **Step 3: 改 handlers**

`handlers.ts`：顶部 import 增加 OAuthService，GitHub handler 段替换：

```ts
import { startDeviceLogin, cancelDeviceLogin } from '../services/OAuthService'
```

```ts
  // GitHub OAuth
  'github:loginStart':  () => startDeviceLogin(),
  'github:loginCancel': () => { cancelDeviceLogin() },
  'github:logout':      () => GitHub.clearGitHubToken(),
  'github:getStatus':   () => GitHub.getStatus(),
  'github:testRepo':    (_e, repoUrl: string) => GitHub.testRepoAccess(repoUrl),
  'github:listRepos':   () => GitHub.listRepos(),
```

（删掉 `'github:setPat'` handler。）

`handlers.ts:39` 的 blocked settings 里 `github.pat` 改为 `github.oauthToken`:

```ts
const RENDERER_BLOCKED_SETTINGS = new Set(['github.oauthToken', 'controlPlane.session'])
```

- [ ] **Step 4: 改 preload**

`preload/index.ts` 的 `github` 段替换为：

```ts
  github: {
    loginStart: () => call<{ userCode: string; verificationUri: string }>('github:loginStart'),
    loginCancel: () => call('github:loginCancel'),
    logout: () => call('github:logout'),
    getStatus: () => call('github:getStatus'),
    testRepo: (repoUrl: string) => call('github:testRepo', repoUrl),
    listRepos: () => call('github:listRepos'),
  },
```

（删掉 `setPat`。）

- [ ] **Step 5: typecheck 两端**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'; npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'`
Expected: node `4`，web `3`（web 多出的第 3 个是 `WorkspaceSettingsTab.tsx` 仍调用已删除的 `setPat`——Task 5 修复。基线本为 2，AttachmentsTab 的 2 个既有错误 + 此 1 个过渡错误）

> 验证：web 侧新错误只应出现在 `WorkspaceSettingsTab.tsx`（引用 `setPat`）。

- [ ] **Step 6: 提交**

```bash
git add src/shared/events.ts src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts
git commit -m "feat: wire github OAuth IPC (loginStart/cancel/logout), drop setPat"
```

---

## Task 5: 渲染层 UI（登录按钮 + 设备码对话框 + 身份行）

**Files:**
- Modify: `src/renderer/src/components/workspace/WorkspaceSettingsTab.tsx`
- Modify: `src/renderer/src/components/workspace/WorkspaceSwitcher.tsx`

- [ ] **Step 1: 重写 WorkspaceSettingsTab 的 GitHub 段**

把 `WorkspaceSettingsTab.tsx` 里 `pat`/`save`/`clear` 及 PAT 输入 UI 替换为登录流程。组件主体改为：

```tsx
export function WorkspaceSettingsTab(): JSX.Element {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<{ authed: boolean; login: string | null; avatarUrl: string | null; error: string | null }>(
    { authed: false, login: null, avatarUrl: null, error: null }
  )
  const [pending, setPending] = useState<{ userCode: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    setStatus(await window.veridian.github.getStatus())
  }

  useEffect(() => {
    refresh()
    // Background poll finishes -> main emits github.authChanged
    const onEvent = (e: { type: string }): void => {
      if (e.type === 'github.authChanged') { setPending(null); setBusy(false); refresh() }
    }
    window.veridian.onDomainEvent(onEvent)
    return () => window.veridian.offDomainEvent(onEvent)
  }, [])

  const login = async (): Promise<void> => {
    setBusy(true)
    try {
      const { userCode } = await window.veridian.github.loginStart()
      setPending({ userCode })
    } catch {
      setBusy(false)
    }
  }

  const cancelLogin = async (): Promise<void> => {
    await window.veridian.github.loginCancel()
    setPending(null); setBusy(false)
  }

  const logout = async (): Promise<void> => {
    await window.veridian.github.logout()
    await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section label={t('workspace.github.title')}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {t('workspace.github.desc')}
        </div>

        {status.authed && status.login ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {status.avatarUrl && (
                <img src={status.avatarUrl} alt="" width={22} height={22}
                  style={{ borderRadius: '50%' }} />
              )}
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-green)' }}>
                {t('workspace.github.connectedAs', { login: status.login })}
              </span>
            </span>
            <button onClick={logout} style={secondaryBtnStyle}>
              {t('workspace.github.logout')}
            </button>
          </div>
        ) : pending ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--foreground)' }}>
              {t('workspace.github.deviceHint')}
            </div>
            <div style={{
              fontSize: 22, fontWeight: 700, letterSpacing: '0.15em',
              fontFamily: 'ui-monospace, monospace', color: 'var(--primary)',
              padding: '8px 12px', background: 'var(--surface)', borderRadius: 8,
              textAlign: 'center', userSelect: 'all',
            }}>
              {pending.userCode}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('workspace.github.deviceWaiting')}
            </div>
            <button onClick={cancelLogin} style={secondaryBtnStyle}>
              {t('workspace.github.cancel')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={login} disabled={busy} style={primaryBtnStyle}>
              {t('workspace.github.loginButton')}
            </button>
            {status.error && (
              <div style={{ fontSize: 12, color: 'var(--accent)' }}>{status.error}</div>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}
```

（保留文件底部的 `Section` / `inputStyle` / `primaryBtnStyle` / `secondaryBtnStyle`；`inputStyle` 若变为未使用可删除该常量。）

- [ ] **Step 2: WorkspaceSwitcher 顶部身份行**

`WorkspaceSwitcher.tsx`：在组件内加身份状态与获取，并在下拉面板顶部渲染身份行。

在 `useState` 附近加：

```tsx
  const [identity, setIdentity] = useState<{ authed: boolean; login: string | null; avatarUrl: string | null }>(
    { authed: false, login: null, avatarUrl: null }
  )
```

在现有 `useEffect(load...)` 里的 `onEvent` 中，`workspace.changed` 分支旁增加：

```tsx
      if (e.type === 'github.authChanged') refreshIdentity()
```

并在该 effect 内定义并首调：

```tsx
    const refreshIdentity = (): void => {
      window.veridian.github.getStatus().then((s) =>
        setIdentity({ authed: s.authed, login: s.login, avatarUrl: s.avatarUrl }))
    }
    refreshIdentity()
```

在下拉面板 `{open && (...)}` 内最顶部（`personalLibrary` Row 之前）插入身份行：

```tsx
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 12px', fontSize: 12, color: 'var(--muted)',
            borderBottom: '1px solid var(--separator)', marginBottom: 4,
          }}>
            {identity.authed && identity.avatarUrl ? (
              <>
                <img src={identity.avatarUrl} alt="" width={18} height={18} style={{ borderRadius: '50%' }} />
                <span style={{ color: 'var(--foreground)', fontWeight: 600 }}>{identity.login}</span>
              </>
            ) : (
              <span>{t('workspace.github.notConnected')}</span>
            )}
          </div>
```

- [ ] **Step 3: typecheck web**

Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'`
Expected: `2`（回到基线：仅 AttachmentsTab 的 2 个既有错误；`setPat` 引用已消除）

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/components/workspace/WorkspaceSettingsTab.tsx src/renderer/src/components/workspace/WorkspaceSwitcher.tsx
git commit -m "feat: GitHub login UI (device dialog) + identity row in switcher"
```

---

## Task 6: i18n 文案 + 手动端到端验证

**Files:**
- Modify: `src/renderer/src/i18n/locales/zh/common.json`
- Modify: `src/renderer/src/i18n/locales/en/common.json`

- [ ] **Step 1: 加中文文案**

`zh/common.json` 的 `workspace.github` 对象里加（保留已有的 `title`/`desc`/`connectedAs`，删除已无引用的 `patPlaceholder`/`save`/`clear`/`openTokenPage`/`noPat` 若存在）：

```json
"github": {
  "title": "GitHub 账号",
  "desc": "登录后即可创建协作工作空间，并与 GitHub 仓库同步。",
  "loginButton": "用 GitHub 登录",
  "deviceHint": "浏览器已打开 GitHub 授权页，验证码已复制到剪贴板，请粘贴并授权：",
  "deviceWaiting": "等待授权中…完成后本页会自动更新。",
  "cancel": "取消",
  "logout": "退出登录",
  "connectedAs": "已登录：{{login}}",
  "notConnected": "未连接 GitHub · 点此登录"
}
```

- [ ] **Step 2: 加英文文案**

`en/common.json` 对应：

```json
"github": {
  "title": "GitHub Account",
  "desc": "Sign in to create collaborative workspaces and sync with GitHub repositories.",
  "loginButton": "Sign in with GitHub",
  "deviceHint": "The GitHub authorization page has opened and the code is copied to your clipboard. Paste it and authorize:",
  "deviceWaiting": "Waiting for authorization… this page updates automatically.",
  "cancel": "Cancel",
  "logout": "Sign out",
  "connectedAs": "Signed in as {{login}}",
  "notConnected": "Not connected to GitHub · click to sign in"
}
```

- [ ] **Step 3: 全量校验（typecheck + 测试 + 构建）**

```bash
npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'   # expect 4 (baseline)
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'    # expect 2 (baseline)
npx vitest run src/main/services/deviceFlow.test.ts               # expect PASS
npm run build                                                     # expect success
```

- [ ] **Step 4: 手动端到端验证（必须真实账号）**

设备流涉及真实浏览器授权，无法自动化。执行：

1. `npm run dev` 启动
2. 打开 设置 → GitHub → 点「用 GitHub 登录」
3. 确认：浏览器自动打开 device 页、验证码已在剪贴板（Ctrl+V 能粘出）
4. 在浏览器粘贴码 + Authorize
5. 切回软件，确认设置页自动变为「已登录：<你的用户名>」+ 头像显示
6. 确认工作空间切换器下拉顶部显示头像 + 用户名
7. （若有 github 工作空间）执行一次「立即同步」，确认 git 操作用新令牌成功（无 no_auth 报错）
8. 点「退出登录」，确认回到未登录态

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/i18n/locales/zh/common.json src/renderer/src/i18n/locales/en/common.json
git commit -m "feat: i18n strings for GitHub login; complete block A"
```

---

## 完成标准

- `deviceFlow.test.ts` 5 用例通过。
- 两端 typecheck 回到基线（node 4 / web 2），无 PAT/getPat 残留错误。
- `npm run build` 成功。
- 手动登录全流程验证通过（登录→显示身份→同步→退出）。
- PAT 相关代码（getPat/setPat/github.pat/patPlaceholder 等）全部移除。
