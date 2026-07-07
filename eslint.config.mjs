import { defineConfig } from 'eslint/config'
import tsPlugin from '@electron-toolkit/eslint-config-ts'
import prettierPlugin from '@electron-toolkit/eslint-config-prettier'

export default defineConfig([
  { ignores: ['**/node_modules/**', '**/out/**', '**/dist/**'] },
  tsPlugin,
  prettierPlugin,
])
