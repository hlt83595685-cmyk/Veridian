import { defineConfig } from 'eslint/config'
import tsPlugin from '@electron-toolkit/eslint-config-ts'

export default defineConfig([
  // scripts/ 是给 node/electron 直接跑的 CJS 小工具，不是应用源码——它必须
  // require() 打包产物，用 TS 的规则去要求它只会逼出无意义的注解。
  { ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', 'scripts/**'] },
  // The ts package's default export is a namespace ({ config, configs, parser,
  // plugin }), not a flat-config object -- spreading it in directly made every
  // `npm run lint` die on `Unexpected key "config"`, so nothing was ever linted.
  ...tsPlugin.configs.recommended,
  // Deliberately no prettier config: this codebase is tabs / single quotes /
  // CRLF, which the shared prettier preset disagrees with on ~20k lines. Lint
  // is here to catch defects, not to relitigate formatting.
])
