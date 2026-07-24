# 贡献者标注（块 B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 协作（github）工作空间里每条文献记录添加者的 GitHub 用户名，列表每行显示其头像。

**Architecture:** `added_by` 字段贯通 DB/类型/item.json；归属在条目创建时从当前登录身份捕获，经一个零 import 的持有器模块传给底层 `createItem`（避免服务层循环依赖）；头像由主进程抓取缓存、渲染层经 `veridian-file://` 加载，失败回落首字母头像。

**Tech Stack:** Electron 36 主进程、better-sqlite3、zod IPC、React 18、vitest。

参考 spec：`docs/superpowers/specs/2026-07-25-contributor-attribution-design.md`
前置：块 A 已完成（`GitHubService.getStatus()` 返回 `{ authed, login, avatarUrl, error }`）。

---

## Task 1: added_by 字段（迁移 + 类型）

**Files:**
- Modify: `src/main/db/index.ts`（迁移段尾部，`if (current < 5)` 块之后）
- Modify: `src/shared/types.ts`（`Item` 接口）
- Modify: `src/main/services/WorkspaceFiles.ts`（`ItemJson` 接口）

- [ ] **Step 1: DB 迁移 v6.** 在 `db/index.ts` 迁移函数里，最后一个 `if (current < 5) { ... }` 块之后，加：

```ts
  if (current < 6) {
    // Contributor attribution: who added each item (GitHub login). Nullable --
    // personal/local workspaces and pre-existing rows have none.
    const cols = (db.pragma('table_info(items)') as { name: string }[]).map((c) => c.name)
    if (!cols.includes('added_by')) {
      db.exec(`ALTER TABLE items ADD COLUMN added_by TEXT`)
    }
    db.exec(`INSERT INTO schema_version VALUES (6)`)
  }
```

- [ ] **Step 2: Item 类型.** 在 `src/shared/types.ts` 的 `Item` 接口里，`version: number` 之后加：

```ts
  added_by: string | null
```

- [ ] **Step 3: ItemJson 类型.** 在 `WorkspaceFiles.ts` 的 `ItemJson` 接口里，`version: number` 之后加：

```ts
  added_by: string | null
```

- [ ] **Step 4: typecheck.** Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'`
Expected: `4`（基线；本步只加字段，尚无使用）。也确认 web：`npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'` → `2`。

- [ ] **Step 5: Commit.**

```bash
cd 'C:\D\Veridian\Veridian 1.0'
git add src/main/db/index.ts src/shared/types.ts src/main/services/WorkspaceFiles.ts
git commit -m "feat: add_by column + types for contributor attribution"
```

---

## Task 2: attribution 持有器 + createItem 写入（TDD）

**Files:**
- Create: `src/main/services/attribution.ts`
- Create: `src/main/services/attribution.test.ts`
- Modify: `src/main/db/items.ts`（`createItem`）

- [ ] **Step 1: 写 attribution 单测.** `src/main/services/attribution.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getAttribution, setAttribution } from './attribution'

describe('attribution holder', () => {
  beforeEach(() => setAttribution(null))

  it('defaults to null', () => {
    expect(getAttribution()).toBeNull()
  })

  it('round-trips a login', () => {
    setAttribution('octocat')
    expect(getAttribution()).toBe('octocat')
  })

  it('can be cleared back to null', () => {
    setAttribution('octocat')
    setAttribution(null)
    expect(getAttribution()).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败.** Run: `npx vitest run src/main/services/attribution.test.ts` — Expected: FAIL (`Cannot find module './attribution'`).

- [ ] **Step 3: 写 attribution.ts.** `src/main/services/attribution.ts`:

```ts
// Zero-import mutable holder for "who is adding items right now" (a GitHub
// login, or null outside a collaborative workspace). Deliberately importless
// so the low-level db/items layer can read it WITHOUT creating a service-layer
// import cycle. Set by WorkspaceContextService on workspace activation.
let current: string | null = null

export function getAttribution(): string | null {
  return current
}

export function setAttribution(login: string | null): void {
  current = login
}
```

- [ ] **Step 4: 运行测试确认通过.** Run: `npx vitest run src/main/services/attribution.test.ts` — Expected: PASS (3 cases).

- [ ] **Step 5: createItem 写 added_by.** 在 `src/main/db/items.ts`：

顶部加 import：
```ts
import { getAttribution } from '../services/attribution'
```

`createItem` 的 INSERT 语句加 `added_by` 列。把 INSERT 改为：
```ts
  db.prepare(`
    INSERT INTO items (
      key, type, title, abstract, year, doi, url,
      journal, publisher, volume, issue, pages, isbn, language, extra,
      library_id, created_at, updated_at, deleted, added_by
    ) VALUES (
      @key, @type, @title, @abstract, @year, @doi, @url,
      @journal, @publisher, @volume, @issue, @pages, @isbn, @language, @extra,
      @library_id, @created_at, @updated_at, 0, @added_by
    )
  `).run({
```
并在 `.run({ ... })` 的参数对象里，`updated_at: now,` 之后加：
```ts
    added_by: getAttribution(),
```

- [ ] **Step 6: 写 createItem attribution 单测.** `src/main/db/items.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { setAttribution } from '../services/attribution'

// createItem reads the live DB via getDb(); to unit-test the attribution
// wiring we point the db module at an in-memory database with the minimal
// items schema, then call the real createItem.
import * as dbIndex from './index'
import { createItem } from './items'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, type TEXT, title TEXT,
      abstract TEXT, year INTEGER, doi TEXT, url TEXT, journal TEXT,
      publisher TEXT, volume TEXT, issue TEXT, pages TEXT, isbn TEXT,
      language TEXT, extra TEXT, deleted INTEGER DEFAULT 0, library_id INTEGER DEFAULT 1,
      created_at INTEGER, updated_at INTEGER, version INTEGER DEFAULT 0, added_by TEXT
    );
  `)
  // @ts-expect-error -- override the module's getDb for the test
  vi.spyOn(dbIndex, 'getDb').mockReturnValue(db)
  setAttribution(null)
})

afterEach(() => { db.close(); vi.restoreAllMocks() })

import { vi } from 'vitest'

describe('createItem attribution', () => {
  it('writes added_by from the attribution holder', () => {
    setAttribution('octocat')
    const item = createItem({ title: 'Test' })
    expect(item.added_by).toBe('octocat')
  })

  it('writes null added_by when no attribution set', () => {
    const item = createItem({ title: 'Test' })
    expect(item.added_by).toBeNull()
  })
})
```

> NOTE：若 `getDb` 的 mock 方式因 ESM 导出不可 spy 而报错，改用 vitest 的
> `vi.mock('./index', () => ({ getDb: () => db }))` 顶层形式，并把 `db` 提到
> 模块级 `let`。实现者按实际可行的一种落地，只要两个断言成立即可。

- [ ] **Step 7: 运行 items 单测.** Run: `npx vitest run src/main/db/items.test.ts` — Expected: PASS (2 cases，added_by 正确读写)。

- [ ] **Step 8: typecheck + commit.**

```bash
npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'   # expect 4
git add src/main/services/attribution.ts src/main/services/attribution.test.ts src/main/db/items.ts src/main/db/items.test.ts
git commit -m "feat: capture contributor attribution on item creation"
```

---

## Task 3: 工作空间归属设置 + item.json 往返

**Files:**
- Modify: `src/main/services/WorkspaceContextService.ts`
- Modify: `src/main/services/WorkspaceFiles.ts`（export + import）

- [ ] **Step 1: 激活时设置归属.** 在 `WorkspaceContextService.ts`：

顶部 import 加：
```ts
import { getStatus } from './GitHubService'
import { setAttribution } from './attribution'
```

在 `setActiveWorkspace` 函数中，每个设置 `active = {...}` 之后、`emit(...)` 之前，统一在函数末尾（`emit({ type: 'workspace.dataRefreshed' })` 之前）加归属刷新。具体：把函数末尾附近改为——在 `active` 最终确定后、`return`/`emit` 前插入：
```ts
  // Attribution follows the active workspace: github -> current GitHub login,
  // anything else -> null. A github workspace can only be activated after auth
  // succeeds, so the login is always available here.
  if (active.kind === 'github') {
    const s = await getStatus().catch(() => null)
    setAttribution(s?.login ?? null)
  } else {
    setAttribution(null)
  }
```
放置位置：确保三条返回路径（`id === null` 个人库、github、local）最终都会执行到它。最简单做法：在 `id === null` 早返回分支里也调用 `setAttribution(null)`，并在函数主体末尾（github/local 之后、最后那个 `emit` 之前）加上上面的 if/else。请阅读该函数确认所有分支都被覆盖（个人库和 local → null；github → login）。

- [ ] **Step 2: 导出 added_by 到 item.json.** 在 `WorkspaceFiles.ts` 的 `exportItems`，构造 `json: ItemJson` 对象的地方，`version: item.version,` 之后加：
```ts
      added_by: item.added_by ?? null,
```
（`item` 来自 `SELECT * FROM items`，已含 `added_by` 列。若 TS 报 `item` 类型缺 `added_by`，把该查询结果的类型断言处一并更新——`exportItems` 里 `item` 目前断言为 `Omit<ItemJson, 'creators'|'tags'|'collections'|'attachments'> & { id: number }`，因 ItemJson 已含 added_by（Task 1），此断言自动覆盖，无需再改。）

- [ ] **Step 3: 导入 added_by（不覆盖）.** 在 `WorkspaceFiles.ts` 的 `importItem`，`fields` 对象里 `version: json.version ?? 0,` 之后加：
```ts
    added_by: json.added_by ?? null,
```
并在 UPDATE 和 INSERT 两条 SQL 里加入 `added_by`：
- UPDATE 的 SET 列表末尾加 `, added_by=@added_by`
- INSERT 的列清单加 `added_by`，VALUES 加 `@added_by`

具体：INSERT 语句改为列含 `..., version, added_by)` 且 `VALUES (..., @version, @added_by)`；UPDATE 语句 SET 末尾 `..., version=@version, added_by=@added_by`。

- [ ] **Step 4: typecheck.** Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'` — Expected: `4`（基线）。确认无 WorkspaceFiles/WorkspaceContext 新错误：
`npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -E 'WorkspaceFiles|WorkspaceContext'` — expected: empty.

- [ ] **Step 5: Commit.**

```bash
git add src/main/services/WorkspaceContextService.ts src/main/services/WorkspaceFiles.ts
git commit -m "feat: set attribution on workspace activation; persist added_by in item.json"
```

---

## Task 4: 头像缓存 AvatarService + IPC

**Files:**
- Create: `src/main/services/AvatarService.ts`
- Modify: `src/shared/ipc-contract.ts`（GitHub 段）
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`

- [ ] **Step 1: 写 AvatarService.** `src/main/services/AvatarService.ts`:

```ts
// Fetches a GitHub user's avatar once and caches it under userData/avatars,
// then serves the local path (renderer loads it via veridian-file://). This
// avoids per-render network calls and any renderer CSP restriction on remote
// images. No expiry -- avatars rarely change; v1 keeps the first copy.
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { app, net } from 'electron'
import { grantAccess } from '../security/pathGuard'

function avatarsDir(): string {
  const dir = join(app.getPath('userData'), 'avatars')
  mkdirSync(dir, { recursive: true })
  return dir
}

// GitHub logins are [A-Za-z0-9-]; reject anything else so the login can't
// escape the avatars dir via path characters.
function safeLogin(login: string): string | null {
  return /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null
}

export async function getAvatarPath(login: string): Promise<string | null> {
  const safe = safeLogin(login)
  if (!safe) return null
  const dest = join(avatarsDir(), `${safe}.png`)
  if (existsSync(dest)) { grantAccess(dest); return dest }
  try {
    const res = await net.fetch(`https://github.com/${safe}.png?size=64`)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    writeFileSync(dest, buf)
    grantAccess(dest)
    return dest
  } catch {
    return null
  }
}
```

- [ ] **Step 2: IPC 契约.** 在 `ipc-contract.ts` 的 GitHub 段（`'github:listRepos'` 附近）加：
```ts
  'github:avatarPath': z.tuple([z.string().min(1).max(64)]),
```

- [ ] **Step 3: handler.** 在 `handlers.ts`，import 加：
```ts
import { getAvatarPath } from '../services/AvatarService'
```
GitHub handler 段加：
```ts
  'github:avatarPath': (_e, login: string) => getAvatarPath(login),
```

- [ ] **Step 4: preload.** 在 `preload/index.ts` 的 `github` 对象里加：
```ts
    avatarPath: (login: string) => call<string | null>('github:avatarPath', login),
```

- [ ] **Step 5: env.d.ts.** 在 `src/renderer/src/env.d.ts` 的 `github: { ... }` 块里加：
```ts
    avatarPath: (login: string) => Promise<string | null>
```

- [ ] **Step 6: typecheck.** Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'` → `4`；`npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'` → `2`。

- [ ] **Step 7: Commit.**

```bash
git add src/main/services/AvatarService.ts src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts src/renderer/src/env.d.ts
git commit -m "feat: AvatarService with local cache + github:avatarPath IPC"
```

---

## Task 5: UI — 贡献者头像

**Files:**
- Modify: `src/renderer/src/components/item-tree/ItemListPane.tsx`

- [ ] **Step 1: 加 ContributorAvatar 组件.** 在 `ItemListPane.tsx` 顶部 import 之后、`ItemRow` 之前，加：

```tsx
// Small round GitHub avatar for the item's contributor. Loads the locally
// cached avatar via veridian-file://; falls back to a colored initial when
// there's no cached image (offline, unknown user, or no attribution).
function ContributorAvatar({ login, size = 18 }: { login: string; size?: number }): JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    window.veridian.github.avatarPath(login)
      .then((p) => { if (alive) p ? setPath(p) : setFailed(true) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [login])

  const dim = { width: size, height: size, borderRadius: '50%', flexShrink: 0 }

  if (path && !failed) {
    const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    return (
      <img
        src={`veridian-file:///${encoded}`}
        alt={login}
        title={login}
        style={{ ...dim, objectFit: 'cover' }}
        onError={() => setFailed(true)}
      />
    )
  }

  // Fallback: colored initial. Hue derived from the login so it's stable.
  let hash = 0
  for (let i = 0; i < login.length; i++) hash = (hash * 31 + login.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return (
    <span
      title={login}
      style={{
        ...dim, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `hsl(${hue}, 55%, 55%)`, color: '#fff',
        fontSize: size * 0.55, fontWeight: 700, textTransform: 'uppercase',
      }}
    >
      {login.charAt(0)}
    </span>
  )
}
```

- [ ] **Step 2: 行内渲染头像.** 在 `ItemRow` 里，把类型图标那行
```tsx
      <span style={{ fontSize: 18, marginTop: 1, flexShrink: 0 }}>{icon}</span>
```
替换为图标 + 可选头像的组合：
```tsx
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 18, marginTop: 1 }}>{icon}</span>
        {item.added_by && <ContributorAvatar login={item.added_by} />}
      </span>
```

- [ ] **Step 3: 确认 import.** `ItemListPane.tsx` 顶部已 `import { useEffect, useRef, useState } from 'react'`（现有），`ContributorAvatar` 用到 `useEffect`/`useState`，无需新增 import。确认 `Item` 类型（含 `added_by`，Task 1 已加）已被 import。

- [ ] **Step 4: typecheck web + build.**
```bash
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'   # expect 2
npm run build   # expect success
```

- [ ] **Step 5: Commit.**

```bash
git add src/renderer/src/components/item-tree/ItemListPane.tsx
git commit -m "feat: contributor avatar in item list rows"
```

---

## Task 6: 全量校验 + 手动验证

- [ ] **Step 1: 全量自动校验.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'   # expect 4 (baseline)
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'    # expect 2 (baseline)
npx vitest run src/main/services/deviceFlow.test.ts src/main/services/attribution.test.ts src/main/db/items.test.ts   # expect all pass
npm run build   # expect success
```

- [ ] **Step 2: 手动验证（真实账号 + github 工作空间）.**
1. `npm run dev`，用块 A 登录 GitHub。
2. 切换到一个 github 协作工作空间（若无，先建一个连到某个你有权限的仓库）。
3. 导入或新建一篇文献。
4. 确认：条目列表该行左侧图标下方显示你的 GitHub 头像；hover 显示你的用户名。
5. （若有第二账号/协作者）让对方添加一篇并同步，确认拉取后那条显示的是**对方**的头像，不是你的。
6. 切回个人库，确认条目不显示头像（added_by 为 null）。

- [ ] **Step 3: 无需额外 commit**（各任务已提交）。若手动验证发现问题，回到对应任务修复。

---

## 完成标准

- 迁移 v6 生效，`items.added_by` 存在。
- `attribution.test.ts`（3）+ `items.test.ts`（2）通过；deviceFlow（块 A）仍绿。
- 两端 typecheck 回基线（node 4 / web 2）；`npm run build` 成功。
- github 工作空间新建条目 → item.json 含 added_by → 协作者拉取保持原始添加者。
- 列表行显示贡献者头像（缓存命中）或首字母回落；个人/本地库不显示。
