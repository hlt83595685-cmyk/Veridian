# 主题切换（跟随系统 / 浅色 / 深色）

方案：主进程设置 `nativeTheme.themeSource`，复用 `globals.css` 现有的 `prefers-color-scheme: dark` 变量块。

## 任务

1. `SettingsService.ts`：新增 `getThemeMode(): 'system' | 'light' | 'dark'`，读取 `ui.theme`，非法值回退 `system`。
2. `main/index.ts`：在 `createWindow()` 之前把 `nativeTheme.themeSource` 设为 `getThemeMode()`。
3. `handlers.ts`：`ui.theme` 加入 `RENDERER_WRITABLE_SETTINGS`；`settings:set` 写入 `ui.theme` 后立即更新 `nativeTheme.themeSource`。
4. `i18n/index.ts`：zh、en 各加 `settings.appearance.*` 文案（标题、跟随系统、浅色、深色）。
5. 新增 `AppearanceTab`（样式照搬 `LanguageTab`）：挂载时 `settings:get('ui.theme')`，点击时 `settings:set('ui.theme', mode)`。
6. `SettingsPage.tsx`：新增「外观」标签页，位于「语言」之后。
7. `globals.css`：`:root` 加 `color-scheme: light dark`；新增变量 `--glass`（浮层）、`--glass-bar`（状态栏/阅读器顶栏）、`--tag-fg` / `--tag-bg` / `--tag-border`（标签紫），并在深色块中给出深色值。
8. 组件替换硬编码为上述变量：
   - `ItemListPane`（3 处浮层 + 标签紫）、`CollectionPane`、`WorkspaceSwitcher`：`rgba(255,255,255,.9x)` → `var(--glass)`
   - `StatusBar`、`PdfReaderPane`、`MarkdownReaderPane`：`rgba(242,242,247,x)` → `var(--glass-bar)`
   - `ItemListPane`、`TagsTab`：`#660874` 系 → `--tag-*`
   - `StatusBar`、`ToolsDialog`、`Pdf2mdDialog`：开关旋钮 `#fff` 检查并按需改
   - 不动：主色按钮白字、图片查看器黑底、牌场绿色画布、弹窗遮罩 `rgba(0,0,0,.45)`
9. 单测：`getThemeMode()` 对 `system` / `light` / `dark` 原样返回，对 `null` 和非法值回退 `system`。
10. 验证：`npm run typecheck`、`npm run lint`、`npm test`；启动应用，三种模式下检查主界面、设置页、知识库页，确认切换即时生效、重启后保持。
