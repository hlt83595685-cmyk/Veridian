// 启动打包后的主进程，确认它能走完启动阶段。
//
// 为什么需要这个：单元测试跑在 vitest 下，那是**真 ESM**；出货的 out/main/index.js
// 是 CJS。两者对 `import X from 'esm-only-pkg'` 的处理不一样——electron-vite 会把
// 它编成裸 require()，不加 interop，于是 X 变成命名空间对象而不是 default 导出。
// typecheck、test、build 全都发现不了，只有真的启动才会炸。
//
//   [FATAL:unhandledRejection] Error: invalid plugin, expect function or object
//   with an "apply" method, received object
//
// 用法：npm run bootcheck（需要先 npm run build）
const { existsSync } = require('fs')
const { join } = require('path')

const MAIN = join(__dirname, '..', 'out', 'main', 'index.js')
const SETTLE_MS = 6000

if (!existsSync(MAIN)) {
	console.error(`bootcheck: 找不到 ${MAIN}——先跑 npm run build`)
	process.exit(1)
}

const { app } = require('electron')

let fatal = null
const capture = (e) => { fatal = fatal ?? e }
process.on('unhandledRejection', capture)
process.on('uncaughtException', capture)

// 产物会开窗口。我们只关心启动阶段有没有抛，静置一会儿就收工。
setTimeout(() => {
	if (fatal) {
		console.error('bootcheck FAIL:', fatal.stack || fatal.message || fatal)
		app.exit(1)
	} else {
		console.log('bootcheck PASS: 主进程启动完成，无未捕获异常')
		app.exit(0)
	}
}, SETTLE_MS)

require(MAIN)
