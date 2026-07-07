# Veridian — CLAUDE.md

## Project Overview

Veridian is a cross-platform desktop reference management application built with:
- **Electron 36** (Main Process: Node.js, Renderer: Chromium)
- **React 18** + TypeScript + Tailwind CSS v4
- **better-sqlite3** for local SQLite database
- **react-i18next** for Chinese/English i18n
- **electron-vite** as the build system

## Directory Structure

```
src/
  main/          -- Electron Main Process (Node.js, full access)
    db/          -- SQLite operations via better-sqlite3
    sync/        -- GitHub sync logic (Phase 4)
    server/      -- Local HTTP connector (localhost:23120)
    plugin-host/ -- Plugin sandbox manager (Phase 5)
    ipc.ts       -- IPC handler registration
    index.ts     -- App entry point
  renderer/      -- React UI (Chromium sandbox)
    index.html
    src/
      components/
        layout/       -- Toolbar, MainLayout (3-pane)
        item-tree/    -- CollectionPane, ItemListPane
        detail-panel/ -- DetailPane with tabs
        pdf-reader/   -- PDF.js viewer (Phase 2+)
      stores/         -- Zustand state stores
      i18n/           -- react-i18next config + locale JSON files
      citation/       -- citeproc-js wrapper (Phase 2)
      styles/         -- globals.css (Tailwind + CSS vars)
  preload/       -- contextBridge API surface (window.veridian)
  shared/        -- Types shared between main and renderer
extension/       -- Browser extension (MV3, Phase 3)
plugins/         -- Example plugins (Phase 5)
```

## Development Commands

```bash
npm install        # Install all dependencies
npm run dev        # Start Electron dev server (hot reload)
npm run build      # Build for production
npm run typecheck  # TypeScript type check
npm run lint       # ESLint
npm test           # Vitest unit tests
```

## Code Style

- TypeScript strict mode throughout
- Tabs for indentation
- No `any` types — use `unknown` when type is truly unknown
- IPC channels: `domain:action` format (e.g., `items:getAll`)
- All DB access in Main Process only — never import better-sqlite3 in renderer
- CSS: Tailwind utility classes + CSS custom properties for theming

## Architecture Rules

- Renderer never accesses Node.js APIs directly — only via `window.veridian.*`
- All privileged operations go through IPC handlers in `src/main/ipc.ts`
- State lives in Zustand stores; no prop drilling beyond 2 levels
- i18n keys live in `src/renderer/src/i18n/locales/{zh,en}/common.json`

## Current Phase

**Phase 0 complete** — scaffold, DB schema, 3-pane UI, IPC bridge, i18n

**Next: Phase 1** — full CRUD UI, collection management, import BibTeX
