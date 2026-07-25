# 软件内邀请协作者（块 C）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 工作空间列表内发出 GitHub 协作邀请；工作空间切换器显示待处理邀请红点，下拉一键接受/拒绝；接受后复用现有"接入协作仓库"流程连接。

**Architecture:** `GitHubService.ts` 新增四个 API 封装（复用 `getGitHubToken`/`API_HEADERS`）；IPC 四层布线（contract/handler/preload/env.d.ts）；`WorkspaceList` 加行内邀请表单；`WorkspaceSwitcher` 加红点+下拉邀请区（组件本地 state，不新建 store）。

**Tech Stack:** Electron 主进程、GitHub REST API、React 18。

参考 spec：`docs/superpowers/specs/2026-07-25-collaborator-invitations-design.md`

---

## Task 1: GitHubService 新增邀请相关 API 封装

**Files:**
- Modify: `src/main/services/GitHubService.ts`

- [ ] **Step 1: 加类型与四个函数.** 在文件末尾（`testRepoAccess` 函数之后）追加：

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

/**
 * Invites a GitHub user as a collaborator with write access. 201 = invitation
 * sent; 204 = already a collaborator (treated as success, no invite needed).
 * 404 covers both "user doesn't exist" and "repo not accessible" -- GitHub
 * deliberately doesn't reveal which, matching testRepoAccess's convention.
 */
export async function inviteCollaborator(owner: string, repo: string, username: string): Promise<InviteResult> {
  const token = getGitHubToken()
  if (!token) return { ok: false, code: 'not_found' }
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/collaborators/${username}`, {
      method: 'PUT',
      headers: { ...API_HEADERS(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission: 'push' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status === 201) return { ok: true, alreadyCollaborator: false }
    if (res.status === 204) return { ok: true, alreadyCollaborator: true }
    if (res.status === 404) return { ok: false, code: 'not_found' }
    if (res.status === 403) return { ok: false, code: 'forbidden' }
    return { ok: false, code: 'http_error', detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, code: 'network', detail: (err as Error).message }
  }
}

/** Pending repository invitations for the current user (accept/decline elsewhere). */
export async function listInvitations(): Promise<Invitation[]> {
  const token = getGitHubToken()
  if (!token) return []
  const res = await fetch('https://api.github.com/user/repository_invitations', {
    headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return []
  const raw = (await res.json()) as Array<{
    id: number
    repository: { name: string; full_name: string; owner: { login: string } }
    inviter: { login: string } | null
  }>
  return raw.map((r) => ({
    id: r.id,
    repoOwner: r.repository.owner.login,
    repoName: r.repository.name,
    repoFullName: r.repository.full_name,
    inviterLogin: r.inviter?.login ?? 'unknown',
  }))
}

export async function acceptInvitation(id: number): Promise<void> {
  const token = getGitHubToken()
  if (!token) throw new Error('no_auth')
  const res = await fetch(`https://api.github.com/user/repository_invitations/${id}`, {
    method: 'PATCH', headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
}

export async function declineInvitation(id: number): Promise<void> {
  const token = getGitHubToken()
  if (!token) throw new Error('no_auth')
  const res = await fetch(`https://api.github.com/user/repository_invitations/${id}`, {
    method: 'DELETE', headers: API_HEADERS(token), signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
}
```

- [ ] **Step 2: typecheck.** Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'` — expect `4`（基线）。确认无 GitHubService 新错误：
`npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep GitHubService` — expect empty。

- [ ] **Step 3: Commit.**

```bash
cd 'C:\D\Veridian\Veridian 1.0'
git add src/main/services/GitHubService.ts
git commit -m "feat: GitHub collaborator invitation API (invite/list/accept/decline)"
```

---

## Task 2: IPC 布线（contract / handlers / preload / env.d.ts）

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`

- [ ] **Step 1: IPC 契约.** 在 `ipc-contract.ts` 的 GitHub 段（`'github:avatarPath'` 那一行之后）加：
```ts
  'github:inviteCollaborator': z.tuple([
    z.string().min(1).max(256), z.string().min(1).max(256), z.string().min(1).max(64),
  ]),
  'github:listInvitations':    z.tuple([]),
  'github:acceptInvitation':   z.tuple([z.number().int().positive()]),
  'github:declineInvitation':  z.tuple([z.number().int().positive()]),
```

- [ ] **Step 2: handlers.** 在 `handlers.ts`，找到从 `../services/GitHubService` 的 import（通常是 `import * as GitHub from '../services/GitHubService'` 或类似别名）——沿用同样的引用方式。在 GitHub handler 段（`'github:avatarPath'` 附近）加：
```ts
  'github:inviteCollaborator': (_e, owner: string, repo: string, username: string) =>
    GitHub.inviteCollaborator(owner, repo, username),
  'github:listInvitations':   () => GitHub.listInvitations(),
  'github:acceptInvitation':  (_e, id: number) => GitHub.acceptInvitation(id),
  'github:declineInvitation': (_e, id: number) => GitHub.declineInvitation(id),
```
（若该文件用的是具名 import 而非 `* as GitHub`，改用文件里实际的引用方式，函数名不变。）

- [ ] **Step 3: preload.** 在 `preload/index.ts` 的 `github` 对象里（`avatarPath` 之后）加：
```ts
    inviteCollaborator: (owner: string, repo: string, username: string) =>
      call<{ ok: boolean; alreadyCollaborator?: boolean; code?: string; detail?: string }>(
        'github:inviteCollaborator', owner, repo, username),
    listInvitations: () => call<Array<{
      id: number; repoOwner: string; repoName: string; repoFullName: string; inviterLogin: string
    }>>('github:listInvitations'),
    acceptInvitation: (id: number) => call('github:acceptInvitation', id),
    declineInvitation: (id: number) => call('github:declineInvitation', id),
```

- [ ] **Step 4: env.d.ts.** 在 `env.d.ts` 的 `github: { ... }` 块里（`avatarPath` 之后）加：
```ts
    inviteCollaborator: (owner: string, repo: string, username: string) => Promise<{
      ok: boolean; alreadyCollaborator?: boolean; code?: string; detail?: string
    }>
    listInvitations: () => Promise<Array<{
      id: number; repoOwner: string; repoName: string; repoFullName: string; inviterLogin: string
    }>>
    acceptInvitation: (id: number) => Promise<void>
    declineInvitation: (id: number) => Promise<void>
```

- [ ] **Step 5: typecheck 两端.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'   # expect 4
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'    # expect 0
```

- [ ] **Step 6: Commit.**
```bash
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: wire invitation IPC channels"
```

---

## Task 3: WorkspaceList 行内邀请表单

**Files:**
- Modify: `src/renderer/src/components/workspace/WorkspaceDialog.tsx`

- [ ] **Step 1: 邀请表单子组件.** 在 `WorkspaceDialog.tsx` 里，`WorkspaceList` 函数之前加一个新组件：
```tsx
function InviteRow({ owner, repo }: { owner: string; repo: string }): JSX.Element {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const submit = async (): Promise<void> => {
    if (!username.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.veridian.github.inviteCollaborator(owner, repo, username.trim())
      if (res.ok) {
        setMsg({ ok: true, text: res.alreadyCollaborator ? t('workspace.invite.alreadyCollaborator') : t('workspace.invite.sent') })
        setUsername('')
      } else {
        const known: Record<string, string> = {
          not_found: t('workspace.invite.notFound'),
          forbidden: t('workspace.invite.forbidden'),
        }
        setMsg({ ok: false, text: known[res.code ?? ''] ?? res.detail ?? res.code ?? 'error' })
      }
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ ...secondaryBtnStyle, height: 28 }}>
        {t('workspace.invite.button')}
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('workspace.invite.usernamePlaceholder')}
          style={{ ...inputStyle, flex: 1, height: 28 }}
        />
        <button onClick={submit} disabled={busy || !username.trim()} style={{ ...primaryBtnStyle, height: 28, padding: '0 10px', fontSize: 12 }}>
          {t('workspace.invite.send')}
        </button>
        <button onClick={() => { setOpen(false); setMsg(null) }} style={{ ...secondaryBtnStyle, height: 28, padding: '0 10px', fontSize: 12 }}>
          {t('workspace.invite.cancel')}
        </button>
      </div>
      {msg && (
        <div style={{ fontSize: 11, color: msg.ok ? 'var(--accent-green)' : 'var(--accent)' }}>
          {msg.text}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 接入 WorkspaceList.** 在 `WorkspaceList` 组件里，每个工作空间行的渲染中，找到 `w.kind === 'github'` 判断的地方（当前只用于文案显示）。在该行的按钮区域（现有"删除"按钮旁）为 github 类型的工作空间加上 `InviteRow`。具体：把行内 JSX 从
```tsx
          <button onClick={() => remove(w.id)} style={{ ...secondaryBtnStyle, height: 28, color: 'var(--accent)' }}>
            {t('workspace.deleteWs')}
          </button>
```
所在的 `<div>`（当前只放删除按钮的容器）改为同时容纳两个操作，例如把该容器包成一列：
```tsx
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {w.kind === 'github' && w.repo_owner && w.repo_name && (
              <InviteRow owner={w.repo_owner} repo={w.repo_name} />
            )}
            <button onClick={() => remove(w.id)} style={{ ...secondaryBtnStyle, height: 28, color: 'var(--accent)' }}>
              {t('workspace.deleteWs')}
            </button>
          </div>
        </div>
```
读该文件当前 `WorkspaceList` 的 JSX 结构，把原先直接放删除按钮的位置替换为上面这个容器（`InviteRow` 在展开时会在容器内往下长出表单，`alignItems: 'flex-end'` 让它保持右对齐）。`LocalWorkspace` 的字段确认为 `repo_owner: string | null` / `repo_name: string | null`（`shared/types.ts:99-100`），与上面代码一致。

- [ ] **Step 3: typecheck web + build.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'   # expect 0
npm run build
```

- [ ] **Step 4: Commit.**
```bash
git add src/renderer/src/components/workspace/WorkspaceDialog.tsx
git commit -m "feat: invite-collaborator inline form in workspace list"
```

---

## Task 4: WorkspaceSwitcher 红点 + 下拉邀请区

**Files:**
- Modify: `src/renderer/src/components/workspace/WorkspaceSwitcher.tsx`

- [ ] **Step 1: 读取现状.** 读 `WorkspaceSwitcher.tsx` 全文（尤其是身份 `identity` 相关的 `useState`/`useEffect`，以及下拉面板 `{open && (...)}` 的 JSX 结构——本任务在其中插入新内容，不改动已有的身份行/工作空间列表逻辑）。

- [ ] **Step 2: 邀请列表 state + 拉取.** 在组件内加：
```tsx
  const [invitations, setInvitations] = useState<Array<{
    id: number; repoOwner: string; repoName: string; repoFullName: string; inviterLogin: string
  }>>([])
```
在组件挂载时（可并入现有身份拉取的 `useEffect`，或新增一个独立 `useEffect`，二者皆可——保持与文件现有风格一致）加：
```tsx
  useEffect(() => {
    window.veridian.github.listInvitations().then(setInvitations).catch(() => {})
  }, [])
```
（只在挂载时查一次，不做轮询，符合 spec 的"非目标"约束。）

- [ ] **Step 3: 接受/拒绝处理函数.**
```tsx
  const respondInvitation = async (id: number, accept: boolean): Promise<void> => {
    try {
      if (accept) await window.veridian.github.acceptInvitation(id)
      else await window.veridian.github.declineInvitation(id)
      setInvitations((prev) => prev.filter((i) => i.id !== id))
    } catch (err) {
      console.error('[WorkspaceSwitcher] invitation response failed:', err)
    }
  }
```

- [ ] **Step 4: 触发按钮加红点.** 找到切换器的触发 `<button onClick={() => setOpen((v) => !v)} ...>`。在其内部（不改变原有内容结构）追加一个条件渲染的小红点，例如在按钮内的文字 `<span>` 之前或按钮本身用 `position: relative` 包一层，加：
```tsx
        {invitations.length > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            width: 8, height: 8, borderRadius: '50%',
            background: '#e5484d', border: '1px solid var(--surface)',
          }} />
        )}
```
若触发按钮当前样式不是 `position: relative`，需要加上（否则红点定位不准）；读实际 JSX 结构后按现有写法调整，保持行为等价（红点视觉上出现在按钮右上角）。

- [ ] **Step 5: 下拉面板加邀请区.** 在下拉 `{open && (...)}` 面板里，找到之前（块 A）加的"当前身份行"（`identity.authed && identity.avatarUrl ? (...)：(...)` 那一块）。在身份行**之后**、`personalLibrary` 的 `Row` **之前**，插入邀请列表区块：
```tsx
          {invitations.length > 0 && (
            <div style={{ padding: '4px 8px 8px', borderBottom: '1px solid var(--separator)', marginBottom: 4 }}>
              {invitations.map((inv) => (
                <div key={inv.id} style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  padding: '6px 4px', fontSize: 12,
                }}>
                  <span style={{ color: 'var(--foreground)' }}>
                    {t('workspace.invite.receivedFrom', { login: inv.inviterLogin, repo: inv.repoFullName })}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => respondInvitation(inv.id, true)}
                      style={{ ...primaryBtnStyle, height: 24, padding: '0 10px', fontSize: 11 }}
                    >
                      {t('workspace.invite.accept')}
                    </button>
                    <button
                      onClick={() => respondInvitation(inv.id, false)}
                      style={{ ...secondaryBtnStyle, height: 24, padding: '0 10px', fontSize: 11 }}
                    >
                      {t('workspace.invite.decline')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
```
（`primaryBtnStyle`/`secondaryBtnStyle` 若在本文件未定义，从 `WorkspaceDialog.tsx` 同款复制两个常量到本文件底部，风格保持一致——检查本文件当前是否已有类似按钮样式常量，若有则复用现有的，不要重复定义。）

- [ ] **Step 6: typecheck web + build.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'   # expect 0
npm run build
```

- [ ] **Step 7: Commit.**
```bash
git add src/renderer/src/components/workspace/WorkspaceSwitcher.tsx
git commit -m "feat: pending-invitation badge + accept/decline in workspace switcher"
```

---

## Task 5: i18n 文案 + 全量校验

**Files:**
- Modify: `src/renderer/src/i18n/index.ts`

- [ ] **Step 1: 中文文案.** 在 `zh.workspace` 对象里（`github: {...}` 同级）新增：
```ts
    invite: {
      button: '邀请协作者',
      usernamePlaceholder: 'GitHub 用户名',
      send: '发送',
      cancel: '取消',
      sent: '邀请已发送',
      alreadyCollaborator: '对方已是协作者',
      notFound: '找不到该用户，或无权限邀请',
      forbidden: '没有邀请权限（需要仓库管理权限）',
      receivedFrom: '{{login}} 邀请你加入 {{repo}}',
      accept: '接受',
      decline: '拒绝',
    },
```

- [ ] **Step 2: 英文文案.** 在 `en.workspace` 对象里同样位置加：
```ts
    invite: {
      button: 'Invite Collaborator',
      usernamePlaceholder: 'GitHub username',
      send: 'Send',
      cancel: 'Cancel',
      sent: 'Invitation sent',
      alreadyCollaborator: 'Already a collaborator',
      notFound: 'User not found, or you lack permission to invite',
      forbidden: 'No permission to invite (requires repo admin access)',
      receivedFrom: '{{login}} invited you to join {{repo}}',
      accept: 'Accept',
      decline: 'Decline',
    },
```

- [ ] **Step 3: 全量校验.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'   # expect 4
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'    # expect 0
npx vitest run   # expect all existing pass, no regressions
npm run build
```

- [ ] **Step 4: Commit.**
```bash
git add src/renderer/src/i18n/index.ts
git commit -m "feat: i18n strings for collaborator invitations; complete block C"
```

---

## Task 6: 手动验证

- [ ] **Step 1: 双账号 E2E**（需要两个真实 GitHub 账号）：
1. 账号 A：登录，在一个 github 工作空间行点"邀请协作者"，填账号 B 用户名 → 提示"邀请已发送"。
2. 账号 B：登录软件 → 切换器出现红点 → 下拉看到"A 邀请你加入 owner/repo" → 点接受 → 红点消失。
3. 账号 B：打开"管理工作空间" → "接入协作仓库" → 加载 → 该仓库出现在列表 → 点接入 → 选本地路径 → 工作空间建好、能同步。
4. 重复邀请已是协作者的账号 → 提示"对方已是协作者"。
5. 邀请不存在的用户名 → 提示"找不到该用户"。
6. 账号 B 对某邀请点拒绝 → 从列表消失。

- [ ] **Step 2: 无需额外 commit**（各任务已提交）。发现问题回到对应任务修复。

---

## 完成标准

- 两端 typecheck 回基线（node 4 / web 0）；`npm run build` 成功；既有测试无回归。
- 邀请发送、接受、拒绝三个操作在真实双账号场景下验证通过；接受后仓库出现
  在既有"接入协作仓库"列表，走现成流程可正常连接。
