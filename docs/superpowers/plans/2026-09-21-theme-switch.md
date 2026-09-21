# Theme Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings gets an "Appearance" tab: follow system / light / dark, applied instantly and persisted.

**Architecture:** Main process sets `nativeTheme.themeSource` from setting `ui.theme`; Chromium's `prefers-color-scheme` follows, so the existing dark variable block in `globals.css` needs no duplication. Hardcoded light-only colors that break in dark move to new CSS variables.

**Tech Stack:** Electron `nativeTheme`, React, vitest.

Spec: `docs/superpowers/specs/2026-09-21-theme-switch-design.md`

Deviations from the spec (both simplifications):
- `ui.theme` gets its own validated branch in `settings:set` instead of joining `RENDERER_WRITABLE_SETTINGS` (needs validation anyway).
- Switch-knob `#fff` in `ToolsDialog` / `Pdf2mdDialog` is left as is: a white knob reads fine on both themes.

Repo has many unrelated uncommitted changes. Commit steps stage **only the named files**.

---

### Task 1: `parseThemeMode` (pure, tested)

**Files:**
- Create: `src/shared/theme.ts`
- Test: `src/shared/theme.test.ts`

- [ ] **Step 1: Write the failing test** — `src/shared/theme.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseThemeMode } from './theme'

describe('parseThemeMode', () => {
	it.each(['system', 'light', 'dark'] as const)('returns %s unchanged', (mode) => {
		expect(parseThemeMode(mode)).toBe(mode)
	})

	it.each([null, undefined, '', 'Dark', 'auto', 1, {}])('falls back to system for %j', (v) => {
		expect(parseThemeMode(v)).toBe('system')
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/theme.test.ts`
Expected: FAIL — cannot resolve `./theme`.

- [ ] **Step 3: Implement** — `src/shared/theme.ts`

```ts
export type ThemeMode = 'system' | 'light' | 'dark'

export function parseThemeMode(v: unknown): ThemeMode {
	return v === 'light' || v === 'dark' ? v : 'system'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/shared/theme.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/theme.ts src/shared/theme.test.ts
git commit -m "feat(theme): add parseThemeMode"
```

---

### Task 2: Main process — read, apply at startup, apply on write

**Files:**
- Modify: `src/main/services/SettingsService.ts` (append after `getPdf2mdMode`, ~line 76)
- Modify: `src/main/index.ts:1,5,215`
- Modify: `src/main/ipc/handlers.ts:4,15,201`

- [ ] **Step 1: `SettingsService.ts`** — add import and accessor

Add below the existing `import { emit } ...` line:

```ts
import { parseThemeMode, type ThemeMode } from '../../shared/theme'
```

Add after `getPdf2mdMode()`:

```ts
export function getThemeMode(): ThemeMode {
  return parseThemeMode(load()['ui.theme'])
}
```

- [ ] **Step 2: `index.ts`** — apply before the window exists

Line 1: add `nativeTheme` to the electron import:
```ts
import { app, BrowserWindow, shell, ipcMain, protocol, net, Menu, Tray, nativeTheme } from 'electron'
```
Line 5:
```ts
import { getSetting, setSetting, getThemeMode } from './services/SettingsService'
```
Immediately before the `createWindow()` call at ~line 215 (after `Menu.setApplicationMenu(null)`):
```ts
  nativeTheme.themeSource = getThemeMode()
```

- [ ] **Step 3: `handlers.ts`** — validate, persist, apply

Line 4: add `nativeTheme` to the electron import:
```ts
import { app, dialog, shell, BrowserWindow, IpcMainInvokeEvent, nativeTheme } from 'electron'
```
Add near the other shared imports at the top:
```ts
import { parseThemeMode } from '../../shared/theme'
```
In `'settings:set'`, insert as the first statement of the handler body:
```ts
    if (key === 'ui.theme') {
      const mode = parseThemeMode(value)
      Settings.setSetting(key, mode)
      nativeTheme.themeSource = mode
      return
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors from these files (pre-existing errors elsewhere, if any, unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/SettingsService.ts src/main/index.ts src/main/ipc/handlers.ts
git commit -m "feat(theme): apply ui.theme to nativeTheme at startup and on change"
```

Note: `handlers.ts`, `index.ts` already have unrelated uncommitted edits; if `git add` would sweep those in, use `git add -p` and take only the theme hunks.

---

### Task 3: i18n strings

**Files:**
- Modify: `src/renderer/src/i18n/index.ts` — insert after the `language: {...},` block in each locale (zh ~line 164, en ~line 524)

- [ ] **Step 1: zh block** (after the zh `language` block, before `knowledge: agentEn.knowledge`)

```ts
    appearance: {
      title: '外观',
      label: '主题',
      system: '跟随系统',
      light: '浅色',
      dark: '深色',
    },
```

- [ ] **Step 2: en block** (same position in the en locale)

```ts
    appearance: {
      title: 'Appearance',
      label: 'Theme',
      system: 'Follow system',
      light: 'Light',
      dark: 'Dark',
    },
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/i18n/index.ts
git commit -m "feat(theme): appearance strings"
```

---

### Task 4: `AppearanceTab` + Settings page tab

**Files:**
- Modify: `src/renderer/src/components/tools/SettingsDialog.tsx` (add after `LanguageTab`, before `// ── Shared`)
- Modify: `src/renderer/src/components/pages/SettingsPage.tsx:4,10,27-33,108-112`

- [ ] **Step 1: Add the component** to `SettingsDialog.tsx` (uses the file-local `Section`; `useState`/`useEffect` are already imported):

```tsx
// ── Appearance tab ────────────────────────────────────────────────────────────

type ThemeMode = 'system' | 'light' | 'dark'

export function AppearanceTab(): JSX.Element {
  const { t } = useTranslation('common')
  const [mode, setMode] = useState<ThemeMode>('system')

  useEffect(() => {
    window.veridian.settings.get('ui.theme').then((v) => {
      setMode(v === 'light' || v === 'dark' ? v : 'system')
    })
  }, [])

  const choose = (m: ThemeMode): void => {
    setMode(m)
    window.veridian.settings.set('ui.theme', m)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
      <Section label={t('settings.appearance.label')}>
        <div style={{ display: 'flex', gap: 10 }}>
          {(['system', 'light', 'dark'] as const).map((m) => (
            <button
              key={m}
              onClick={() => choose(m)}
              style={{
                height: 36, padding: '0 20px', borderRadius: 10,
                border: mode === m ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: mode === m ? 'var(--primary-light)' : 'var(--surface)',
                color: mode === m ? 'var(--primary)' : 'var(--foreground-2)',
                fontSize: 13, fontWeight: mode === m ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              {t(`settings.appearance.${m}`)}
            </button>
          ))}
        </div>
      </Section>
    </div>
  )
}
```

(The selected background uses `var(--primary-light)` instead of the hardcoded blue tint `LanguageTab` uses, so it looks right in dark. `LanguageTab` is left untouched.)

- [ ] **Step 2: `SettingsPage.tsx`**

Line 4:
```tsx
import { StorageTab, LanguageTab, AppearanceTab } from '../tools/SettingsDialog'
```
Line 10:
```tsx
type Tab = 'storage' | 'language' | 'appearance' | 'github' | 'knowledge' | 'skills'
```
In `tabs`, after the `language` entry:
```tsx
    { id: 'appearance', label: t('settings.appearance.title') },
```
In the content block, after the `language` line:
```tsx
        {tab === 'appearance' && <AppearanceTab />}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS for these files. (`window.veridian.settings.get` is typed in `env.d.ts`; if it returns `Promise<unknown>` the narrowing above already handles it.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/tools/SettingsDialog.tsx src/renderer/src/components/pages/SettingsPage.tsx
git commit -m "feat(theme): appearance settings tab"
```

---

### Task 5: CSS variables

**Files:**
- Modify: `src/renderer/src/styles/globals.css`

- [ ] **Step 1:** In the light `:root` block, add `color-scheme: light dark;` as the first declaration, and after the `--danger-border` line add:

```css
  /* Translucent chrome (floating menus, status/reader bars) and tag purple.
     Light-only literals used to be inlined in components. */
  --glass:          rgba(255, 255, 255, 0.93);
  --glass-bar:      rgba(242, 242, 247, 0.90);
  --tag-fg:         #660874;
  --tag-bg:         rgba(102, 8, 116, 0.07);
  --tag-border:     rgba(102, 8, 116, 0.20);
```

- [ ] **Step 2:** In the `@media (prefers-color-scheme: dark)` block, after `--danger-border: ...` add:

```css
    --glass:          rgba(32, 33, 39, 0.93);
    --glass-bar:      rgba(27, 28, 34, 0.90);
    --tag-fg:         #d9a6ea;
    --tag-bg:         rgba(190, 120, 220, 0.14);
    --tag-border:     rgba(190, 120, 220, 0.32);
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/styles/globals.css
git commit -m "feat(theme): glass and tag variables with dark values"
```

---

### Task 6: Replace hardcoded colors

**Files (exact edits):**

- [ ] **Step 1: `item-tree/ItemListPane.tsx`**
  - ~line 167-169 (tag chip): `background: 'rgba(102,8,116,0.07)'` → `'var(--tag-bg)'`; `color: '#660874'` → `'var(--tag-fg)'`; `border: '1px solid rgba(102,8,116,0.20)'` → `'1px solid var(--tag-border)'`
  - ~line 178 (`+N` label): `color: '#660874'` → `color: 'var(--tag-fg)'`
  - ~lines 558, 645, 807: `background: 'rgba(255,255,255,0.92)'` / `0.92` / `0.95` → `background: 'var(--glass)'`

- [ ] **Step 2: `item-tree/CollectionPane.tsx:519`** — `background: 'rgba(255,255,255,0.94)'` → `'var(--glass)'`

- [ ] **Step 3: `workspace/WorkspaceSwitcher.tsx:102`** — `background: 'rgba(255,255,255,0.94)'` → `'var(--glass)'`

- [ ] **Step 4: `layout/StatusBar.tsx:51`** — `background: 'rgba(242,242,247,0.92)'` → `'var(--glass-bar)'`

- [ ] **Step 5: `pdf-viewer/PdfReaderPane.tsx:17` and `pdf-viewer/MarkdownReaderPane.tsx:15`** — `background: 'rgba(242,242,247,0.85)'` → `'var(--glass-bar)'`

- [ ] **Step 6: `detail-panel/TagsTab.tsx:90-92`** — `background: 'rgba(102,8,116,0.07)'` → `'var(--tag-bg)'`; `border: '1px solid rgba(102,8,116,0.22)'` → `'1px solid var(--tag-border)'`; `color: '#660874'` → `'var(--tag-fg)'`

- [ ] **Step 7: Verify no stragglers**

Run: `grep -rnE "rgba\(255,255,255,0\.9[0-9]?\)|rgba\(242,242,247|#660874|rgba\(102,8,116" src/renderer/src`
Expected: no output.

- [ ] **Step 8: Typecheck + lint + tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass (report any pre-existing failures separately; do not fix unrelated ones).

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/item-tree/ItemListPane.tsx src/renderer/src/components/item-tree/CollectionPane.tsx src/renderer/src/components/workspace/WorkspaceSwitcher.tsx src/renderer/src/components/layout/StatusBar.tsx src/renderer/src/components/pdf-viewer/PdfReaderPane.tsx src/renderer/src/components/pdf-viewer/MarkdownReaderPane.tsx src/renderer/src/components/detail-panel/TagsTab.tsx
git commit -m "feat(theme): use theme variables for glass surfaces and tags"
```

---

### Task 7: Manual verification (real app)

- [ ] **Step 1:** `npm run dev`. Settings → 外观.
- [ ] **Step 2:** Click 深色: whole UI (incl. scrollbars, inputs) goes dark immediately. Check library list + right-click menus, a tag chip, status bar during a task, PDF/Markdown reader top bar, workspace dropdown, knowledge page, settings page.
- [ ] **Step 3:** Click 浅色: everything back to light. Click 跟随系统: matches the OS theme; flip the OS theme and confirm the app follows.
- [ ] **Step 4:** Choose 深色, fully quit (tray → quit) and relaunch: starts dark with no light flash; the 外观 tab shows 深色 selected.
- [ ] **Step 5:** Report any dark-mode defect found that is outside the listed sites; do not fix silently.
