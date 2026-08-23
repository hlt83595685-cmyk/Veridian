import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // cordis ships ESM only, and this project is CommonJS -- externalizing it would
    // leave the main process doing require() on a pure ESM package at runtime.
    // Bundling it sidesteps the interop question entirely.
    plugins: [externalizeDepsPlugin({ exclude: ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
        // annotpdf requires 'fs' only for loadFile/save which we never call;
        // stub it out so Vite doesn't warn about Node built-in in renderer bundle
        'fs': resolve(__dirname, 'src/renderer/src/stubs/fs.ts'),
        'path': 'path-browserify',
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
})
