# 条目列表内联图片带 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 每条文献行下方，滚动到可视区域附近时才加载并显示该条目转换出的图片（fig1, fig2…顺序），横向单行、超出可滚动，点击打开现有全页画廊。

**Architecture:** 一个零依赖 `IntersectionObserver` hook 门控每行图片带的挂载；触发后才查附件、列目录、渲染缩略图（`veridian-file://` 直连，复用 `ContributorAvatar` 已有的路径编码方式）；figN 文件名用数值排序的纯函数（可单测）。

**Tech Stack:** React 18、Electron `veridian-file://` 协议、vitest。

参考 spec：`docs/superpowers/specs/2026-07-25-item-image-strip-design.md`

---

## Task 1: figN 数值排序纯函数（TDD）

**Files:**
- Create: `src/renderer/src/components/item-tree/FigureStrip.utils.ts`
- Create: `src/renderer/src/components/item-tree/FigureStrip.utils.test.ts`

- [ ] **Step 1: 写失败测试.** `src/renderer/src/components/item-tree/FigureStrip.utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sortByFigNumber } from './FigureStrip.utils'

describe('sortByFigNumber', () => {
  it('sorts fig1..fig10 numerically, not lexicographically', () => {
    const paths = [
      'C:/repo/images/fig10.png',
      'C:/repo/images/fig2.png',
      'C:/repo/images/fig1.jpg',
    ]
    expect(sortByFigNumber(paths)).toEqual([
      'C:/repo/images/fig1.jpg',
      'C:/repo/images/fig2.png',
      'C:/repo/images/fig10.png',
    ])
  })

  it('handles forward and back slashes in paths', () => {
    const paths = ['a\\images\\fig2.png', 'a\\images\\fig1.png']
    expect(sortByFigNumber(paths)).toEqual(['a\\images\\fig1.png', 'a\\images\\fig2.png'])
  })

  it('puts non-figN-named files after numbered ones, preserving relative order', () => {
    const paths = ['x/cover.png', 'x/fig2.png', 'x/fig1.png', 'x/misc.jpg']
    expect(sortByFigNumber(paths)).toEqual(['x/fig1.png', 'x/fig2.png', 'x/cover.png', 'x/misc.jpg'])
  })

  it('does not mutate the input array', () => {
    const paths = ['a/fig2.png', 'a/fig1.png']
    const copy = [...paths]
    sortByFigNumber(paths)
    expect(paths).toEqual(copy)
  })

  it('returns an empty array for empty input', () => {
    expect(sortByFigNumber([])).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败.** Run: `npx vitest run src/renderer/src/components/item-tree/FigureStrip.utils.test.ts` — Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现.** `src/renderer/src/components/item-tree/FigureStrip.utils.ts`:

```ts
// Sorts image file paths by their figN numeric suffix (fig1, fig2, fig10...)
// so display order matches the markdown's actual figure order -- filename
// string sort would put fig10 before fig2. Files without a figN pattern sort
// after numbered ones, in their original relative order.
const FIG_RE = /fig(\d+)\.[^/\\]+$/i

function figNumber(path: string): number | null {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path
  const m = base.match(FIG_RE)
  return m ? parseInt(m[1], 10) : null
}

export function sortByFigNumber(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const na = figNumber(a)
    const nb = figNumber(b)
    if (na !== null && nb !== null) return na - nb
    if (na !== null) return -1
    if (nb !== null) return 1
    return 0   // preserve relative order of two non-numbered entries
  })
}
```

- [ ] **Step 4: 运行确认通过.** Run: `npx vitest run src/renderer/src/components/item-tree/FigureStrip.utils.test.ts` — Expected: PASS (5 cases)。

> 注：Array.prototype.sort 在现代 JS 引擎中是 stable sort，两个 `figNumber` 均为
> null 时返回 0 能保持原始相对顺序，测试用例 3 依赖这一点。

- [ ] **Step 5: typecheck + commit.**

```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'   # expect 2 (baseline)
git add src/renderer/src/components/item-tree/FigureStrip.utils.ts src/renderer/src/components/item-tree/FigureStrip.utils.test.ts
git commit -m "feat: numeric figN sort for image strip ordering"
```

---

## Task 2: useInView hook（可视区域触发）

**Files:**
- Create: `src/renderer/src/hooks/useInView.ts`

- [ ] **Step 1: 写 hook.** `src/renderer/src/hooks/useInView.ts`:

```ts
import { useEffect, useRef, useState } from 'react'

/**
 * True once the returned ref's element has entered the viewport (with a
 * lookahead margin), and STAYS true afterward -- this gates one-time work
 * (fetch + render) per row, not visibility tracking. Used so off-screen list
 * rows do zero IPC/network/decode work until the user scrolls near them.
 */
export function useInView<T extends HTMLElement>(rootMargin = '200px'): {
  ref: React.RefObject<T>
  inView: boolean
} {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (inView) return   // already triggered -- no need to keep observing
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setInView(true)
      },
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [inView, rootMargin])

  return { ref, inView }
}
```

- [ ] **Step 2: typecheck.** Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'` — expect `2` (baseline).

- [ ] **Step 3: Commit.**

```bash
git add src/renderer/src/hooks/useInView.ts
git commit -m "feat: useInView hook (IntersectionObserver, one-shot trigger)"
```

---

## Task 3: FigureStrip 组件

**Files:**
- Create: `src/renderer/src/components/item-tree/FigureStrip.tsx`

参考风格：读 `ItemListPane.tsx` 中已有的 `ContributorAvatar` 组件（同款
`veridian-file:///` 路径编码方式：`path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')`），
保持一致。

- [ ] **Step 1: 组件完整实现（骨架 + 缩略图子组件）.** 创建
`src/renderer/src/components/item-tree/FigureStrip.tsx`，内容如下。State 直接
存 `{ dir, files }`（`dir` = imagedir 附件的目录路径，供点击缩略图时传给
`openGallery`；不从单张图片路径反推目录，避免受平台分隔符影响）：

```tsx
import { useEffect, useState } from 'react'
import { useInView } from '../../hooks/useInView'
import { useItemStore } from '../../stores/itemStore'
import { sortByFigNumber } from './FigureStrip.utils'
import type { Attachment } from '../../../../shared/types'

const MAX_THUMBS = 10
const THUMB_SIZE = 52

interface Loaded {
  dir: string
  label: string   // the imagedir attachment's own display name, for the gallery header
  files: string[]
}

export function FigureStrip({ itemId }: { itemId: number }): JSX.Element {
  const { ref, inView } = useInView<HTMLDivElement>()
  const [loaded, setLoaded] = useState<Loaded | null>(null)   // null = not fetched (or nothing to show) yet

  useEffect(() => {
    if (!inView) return
    let alive = true
    window.veridian.attachments.getByItem(itemId)
      .then((attachments: Attachment[]) => {
        const imgDir = attachments.find((a) => (a as Attachment & { type?: string }).type === 'imagedir')
        if (!imgDir?.path) return null
        const dir = imgDir.path
        const label = imgDir.filename ?? '图片文件夹'
        return window.veridian.fs.listDir(dir).then((files) => ({ dir, label, files }))
      })
      .then((result) => {
        if (!alive) return
        if (!result || result.files.length === 0) { setLoaded(null); return }
        setLoaded({ dir: result.dir, label: result.label, files: sortByFigNumber(result.files).slice(0, MAX_THUMBS) })
      })
      .catch(() => { if (alive) setLoaded(null) })
    return () => { alive = false }
  }, [inView, itemId])

  if (!loaded) return <div ref={ref} />   // placeholder: not-yet-visible, no images, or fetch failed -- zero visual footprint

  return (
    <div
      ref={ref}
      style={{
        display: 'flex', gap: 6, overflowX: 'auto', overflowY: 'hidden',
        padding: '6px 0 2px', marginTop: 4,
      }}
    >
      {loaded.files.map((path) => (
        <FigureThumb key={path} path={path} dir={loaded.dir} label={loaded.label} />
      ))}
    </div>
  )
}

function FigureThumb({ path, dir, label }: { path: string; dir: string; label: string }): JSX.Element | null {
  const { openGallery } = useItemStore()
  const [failed, setFailed] = useState(false)
  if (failed) return null

  const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')

  return (
    <img
      src={`veridian-file:///${encoded}`}
      alt=""
      loading="lazy"
      decoding="async"
      onClick={(e) => {
        e.stopPropagation()   // don't trigger the row's onClick (item selection)
        openGallery(dir, label)   // label = the folder's own name, not this single image
      }}
      onError={() => setFailed(true)}
      style={{
        width: THUMB_SIZE, height: THUMB_SIZE, objectFit: 'cover',
        borderRadius: 6, flexShrink: 0, cursor: 'pointer',
        border: '1px solid var(--border)',
      }}
    />
  )
}
```

- [ ] **Step 2: typecheck web.** Run: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'` — expect `2`（基线）。确认无 FigureStrip 相关新错误：
`npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -i 'FigureStrip'` — expect empty。

- [ ] **Step 3: Commit.**

```bash
git add src/renderer/src/components/item-tree/FigureStrip.tsx
git commit -m "feat: FigureStrip component (lazy-mounted, click opens gallery)"
```

---

## Task 4: 接入 ItemListPane

**Files:**
- Modify: `src/renderer/src/components/item-tree/ItemListPane.tsx`

- [ ] **Step 1: import + 渲染位置.** 顶部加：
```tsx
import { FigureStrip } from './FigureStrip'
```
在 `ItemRow` 组件内，标题 + 标签区域（`item.tags && item.tags.length > 0 && (...)` 块）**之后**，同一个 flex-1 容器内追加：
```tsx
        <FigureStrip itemId={item.id} />
```
读该文件确认插入位置在标题/标签所在的 `<div style={{ flex: 1, minWidth: 0 }}>` 容器内部末尾（期刊列表页效果——图片带跟随标题/标签，在期刊列/年份列之前的主内容区域）。

- [ ] **Step 2: typecheck + build.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'   # expect 2
npm run build   # expect success
```

- [ ] **Step 3: Commit.**
```bash
git add src/renderer/src/components/item-tree/ItemListPane.tsx
git commit -m "feat: render FigureStrip under each item row"
```

---

## Task 5: 全量校验 + 手动验证

- [ ] **Step 1: 自动校验.**
```bash
cd 'C:\D\Veridian\Veridian 1.0'
npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -c 'error TS'   # expect 4
npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -c 'error TS'    # expect 2
npx vitest run   # expect all pass (adds FigureStrip.utils' 5 cases) + DB tests skipped
npm run build
```

- [ ] **Step 2: 手动验证.**
1. `npm run dev`，有转换出图片的条目滚动到可见 → 缩略图带按 fig 顺序出现，横向可滚动，不换行。
2. 图片超过 10 张的条目 → 只显示前 10。
3. 无图条目 → 不显示图片带，不占空间，不报错。
4. 点击任意缩略图 → 打开全页画廊，能看到该条目全部图片（非仅前 10）。
5. 长列表（滚动多屏，若数据量小可临时多导入几篇测试）→ 打开 DevTools Network/Performance 面板，确认远离视口的行没有触发 `fs:listDir`/`attachments:getByItem` 调用（可在 Console 里给这两个 IPC 加临时 log 观察，验证后移除，或直接用 Performance 录制观察 IPC 触发时机随滚动增量出现）。

- [ ] **Step 3: 无需额外 commit**（各任务已提交）。发现问题回到对应任务修复。

---

## 完成标准

- `FigureStrip.utils.test.ts`（5）通过；其余测试套件不变。
- 两端 typecheck 回基线（node 4 / web 2）；`npm run build` 成功。
- 图片带只在滚动到可视区域附近时才发起 IPC；按 fig 顺序显示、单行可横向滚动、
  最多 10 张；点击打开现有全页画廊；无图条目零占用。
