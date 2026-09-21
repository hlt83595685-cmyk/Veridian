// 流式过程中把「半截的 Markdown」补成合法的再交给解析器。
//
// 问题：回答是一个 token 一个 token 到的，每来一段就整篇重新解析一次。中间那些
// 语法还没闭合的状态会被当真渲染——最刺眼的是围栏代码块：``` 开了还没收尾时，
// 后面的内容按 CommonMark 确实是代码块，于是每来一个换行就重排一次；而缩进四格
// 的续行会被当成缩进代码块，一行画一段灰底。看上去就是「一堆长短不一的灰条」。
//
// 思路和 DSH 的增量解析器一致：**追加的文本只会改写最后一个块，前面的已经定型**。
// 我们不做完整的冻结前沿（那是另一个工程），只做代价最低、收益最大的那一半——
// 把落在末尾的未闭合结构补齐，让每一帧都是合法文档。回合结束后拿到的是完整原文，
// 这个函数就不再参与。
//
// 只在**流式中**用。已经落库的消息是完整的，补齐反而会改变它的语义。

/** 围栏的定界符：``` 或 ~~~，允许更多个，允许最多三格缩进。 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * 数一遍围栏，判断末尾是否停在一个没收尾的代码块里。
 *
 * 收尾的围栏必须与开启的同字符、且不短于它——`````` 开的不能用 ``` 收。这一条
 * 照 CommonMark 来，不然模型输出里嵌套的围栏会被错判成已闭合。
 */
function unclosedFence(lines: string[]): string | null {
	let open: string | null = null
	for (const line of lines) {
		const m = FENCE.exec(line)
		if (!m) continue
		const mark = m[1]
		if (open === null) {
			open = mark
		} else if (mark[0] === open[0] && mark.length >= open.length) {
			// 收尾行除了定界符不能有别的内容；有的话它是另一个开启。
			if (line.trim() === mark) open = null
		}
	}
	return open
}

/**
 * 把流式中的半截 Markdown 补成合法文档。
 *
 * 只补末尾，不动前面——前面的内容已经定型，改它会让已经画出来的东西跳动。
 */
export function closeOpenMarkdown(src: string): string {
	if (!src) return src
	const lines = src.split('\n')

	const fence = unclosedFence(lines)
	// 补上收尾围栏：让它现在就是一个完整的代码块，而不是「从这里到文末都是代码」。
	if (fence) return `${src}${src.endsWith('\n') ? '' : '\n'}${fence}`

	// 表格：分隔行还没到的时候，remark-gfm 不认它是表格，那一行会以裸管道字符
	// 的样子留在段落里。丢掉这个还没成形的尾行，等它成形再显示——闪一下总比
	// 显示一行 `| a | b |` 好。
	const last = lines[lines.length - 1]
	if (last.startsWith('|') && lines.length >= 2 && !/^\s*\|?[\s:-]+\|/.test(lines[lines.length - 2] ?? '')) {
		const prev = lines[lines.length - 2] ?? ''
		if (!prev.startsWith('|')) return lines.slice(0, -1).join('\n')
	}

	return src
}
