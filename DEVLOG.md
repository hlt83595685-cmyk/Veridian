# Veridian 开发日志

## 2026-09-30 — v0.2.2 发版：浏览器插件 PDF 抓取修复合集

自 v0.2.1 以来的累积，一次性发布，都是围绕浏览器插件"保存文献时抓不到 PDF"这条线
的调试成果（细节见下方追更一～五）：

- 页面没有 DOI/标题可查时（典型场景：标签页直接打开的是一个 PDF 网址），改成下载
  PDF 本身、用现成的 `pdfImporter.ts` 解析逻辑抠标题/DOI，而不是死磕网页 DOM。
- `/save` 命中查重（同一 DOI 已在库里）时，如果已有条目还没有 PDF，现在会补一次，
  不再永久放弃。
- 新增：插件在页面自己的登录态里下载 PDF（`content.js` 带 cookie fetch），转发给
  桌面应用挂载——修复了机构订阅/登录态网站（如需要 cookie 的出版商）下载失败的问题。
  桌面应用自己发起的下载请求不带浏览器的会话，遇到这类站点必然被拒。
- 新增 `POST /attach-pdf` 接口，走原始二进制请求体，接收插件已经下载好的 PDF 字节。
- 识别到"验证/反爬虫挑战页伪装成 200 响应"这种明确无解的情况时（比如爱思唯尔），
  插件会弹系统通知提示用户手动下载 + 拖拽导入，而不是静默失败。**这类反爬虫验证
  本身没有自动化方案**——不打算做，因为那等于专门写一个绕过出版商反爬虫机制的工具。
- 沿途加了不少日志（`[server]`/`[attachments]`/`[extension]` 前缀），保留在代码里，
  以后再出现"保存了但没 PDF"能直接从桌面应用终端一处日志看出卡在哪一步。

**验证**：`npm run typecheck` 干净、`npx vitest run` 417 项全过、`npm run build` 成功、
`npm run bootcheck` PASS。浏览器插件这一侧（`content.js`/`background.js` 的认证下载、
通知）**未经真实浏览器端到端验证**——用户在本地调试环境（`npm run dev` + 手动重载
插件）里确认过 PDF 抓取、查重补挂载这两条路径，反爬虫通知这一步用户尚未回传结果。

## 2026-09-30 — 追更五：爱思唯尔 PDF 是反爬虫验证，不是登录态问题；到此为止 + 加提示

上一条（追更四）加了"插件带浏览器登录态下载 PDF"的机制，日志显示插件确实带着 cookie
去请求了，但拿回来的还是不是真 PDF（`content-type=text/html`，内容里有
`robots: noindex, nofollow` 和一个 `/craft/challenge/pdf/trace/` 的追踪像素）。真相：
**这不是登录态问题，是爱思唯尔专门给 PDF 下载做的反爬虫/机器人检测**，要求请求方真的
在浏览器里把页面渲染出来、跑一遍它的 JS 验证才放行——任何纯 HTTP 请求（不管带不带
cookie）都做不到这一步，只有用户自己在浏览器里点击下载、让浏览器完整走一遍加载渲染
流程，才能拿到真 PDF。

**决定不再往这个方向做。** 继续想办法在程序里模拟一次"真实浏览器导航"去骗过这层验证，
本质上是在写一个专门绕过出版商反爬虫机制的东西，不管技术上是否可行，这个不做。

**用户已有的替代路径**（本来就存在，不用改代码）：手动在浏览器里下载 PDF，把文件直接
拖到 Veridian 的文献列表窗口，应用会自动识别、匹配已有条目或新建条目并挂载附件
（`ItemListPane.tsx` 的拖放导入，走 `pdfImporter.ts` 那条本地导入逻辑）。

**加了一个小提示**：插件识别到"拿到的是验证/挑战页而不是真 PDF"这种具体情况时（不是
所有失败都提示，比如单纯网络抖动就不提示，因为那种情况"去手动下载"不一定是对的建议），
用 Chrome 系统通知告诉用户去手动下载导入——这一步的失败原来发生在插件弹窗早就关闭之后
（保存本身是即时成功的，PDF 挂载是后台异步做的），弹窗里根本来不及显示，只能用系统
级通知。

- `content.js`：`fetchPdfBytes` 在磁数校验失败时新增 `reason: 'not_a_pdf'` 字段，让
  `background.js` 能精确识别"这具体是哪种失败"，不用去解析日志用的自由文本。
- `background.js`：新增 `notifyManualDownloadNeeded(title)`，读 `chrome.storage.local`
  里 `popup.js` 已经在用的同一个语言偏好键（`veridian_lang`），用对应语言弹系统通知；
  只在 `reason === 'not_a_pdf'` 时触发。
- `manifest.json`：新增 `notifications` 权限；版本号 0.3.7 → 0.3.8。

**验证**：`node --check` 两个改动的 JS 文件语法通过，`manifest.json` JSON 合法；
`npm run typecheck`/`npx vitest run`（417 项）不受影响（本轮未改 TS 代码）。**系统通知
本身没有实测**——需要用户重新加载扩展后，用同一篇爱思唯尔论文触发一次确认弹出、文案
正确。

至此，浏览器插件与 Elsevier/ScienceDirect 相关的调试收尾：能自动的（无反爬虫验证的
出版商，如 arXiv）已经修好；有反爬虫验证的，插件会提示用户走手动下载 + 拖拽导入这条
早已存在的路径。

## 2026-09-29 — 浏览器扩展 v0.3.1：直接打开的 PDF 页面抓不到 PDF

**现象**：用户反馈在一个"PDF 打开页"上点插件，识别不到 PDF。

**根因**：`content.js` 的 `extractPdfUrl()` 只认两种情况——`<meta name="citation_pdf_url">`
或者一个 `href` 以 `.pdf` 结尾的 `<a>` 标签。用户说的场景是**直接在地址栏打开了一个 .pdf
链接**，这时 Chrome 用内置查看器渲染，页面是一个空壳文档，压根没有 `<head>`、`<meta>`、
`<a>`，两条规则必然全部落空。这个空壳文档唯一可靠的信号是 `document.contentType ===
'application/pdf'`，但代码里完全没用它兜底成"当前网址本身就是 PDF"。

**修复**：`extractPdfUrl()` 先判断 `document.contentType`，命中就直接用 `location.href`；
另外把 `.pdf` 后带查询参数的链接（如 `xxx.pdf?download=1`）也纳入匹配，这是另一类常见漏检。
未验证的已知局限：PDF 若是内嵌在文章页某个 `<iframe>`/`<embed>` 里展示（而不是整页导航），
这次没有处理，因为 content script 默认只跑在顶层 frame。

**验证**：`node --check` 语法通过；没有连上浏览器环境做真实页面验证，需要用户重新加载
扩展后自行确认。

**追更（同日）：上面这版没解决问题。** 用户反馈重新加载后依旧不行，让在
`https://arxiv.org/pdf/2105.01601` 页面的控制台跑诊断，结果是
`{"contentType":"text/html","anchorCount":0,"bodyChildTags":["div","div","div","script",
"script","script","script","script","script"],"hasPdfEmbed":false,"hasPdfViewerEl":false}`。

**上一版判断的前提是错的**：`document.contentType` 实际是 `text/html`，不是
`application/pdf`，我加的那个分支从未生效；`<embed>`、`<pdf-viewer>` 也都查不到——Chrome
内置查看器现在应该是异步用 JS 生成、装在 Shadow DOM 里的（`querySelector` 穿不透
Shadow DOM），已经不是能稳定 sniff 的 DOM 标记了，而且这套实现很可能随 Chrome 版本变。
继续猜第三个 DOM 特征风险很高，所以换了策略：不再猜页面里"长得像不像 PDF"，改成在
`background.js` 里对页面自身网址发一次 `HEAD` 请求，直接读服务器返回的真实
`Content-Type`。`extractFromTab()` 里，只要 `content.js` 没抓到 `pdf_url`，就用这条兜底。
这个做法不依赖任何 DOM 结构，天然也覆盖了 arXiv 这种网址本身不带 `.pdf` 后缀
（`/pdf/<id>`）的情况——用后缀名匹配的老办法本来就抓不到这类链接。

`content.js` 里那条 `document.contentType === 'application/pdf'` 的判断保留未删：验证
下来它在这个场景里不生效，但作为一个免费的前置短路分支，留着无害，说不定在别的路径
（比如本地 `file:///foo.pdf`）里能用上。

版本号 0.3.1 → 0.3.2。**这次也还没有拿真实浏览器验证过**（同样是没连上自动化浏览器
环境），需要用户重新加载扩展后实测确认。

**追更二（同日）：报错信息变了，说明流程往前走了一步。** 重新加载 0.3.2 后用户反馈的
不再是"识别不到 PDF"，而是弹窗的通用兜底文案"未能识别该页面的文献信息，支持含 DOI 的
学术页面"（`popup.js` 里 `!exResp?.ok || !exResp.data?.title` 触发的 `S.noMetadata`）。
这说明 PING 已经通过，`EXTRACT_AND_PREVIEW` 也跑完了，只是 `/preview` 没能给出一个
`title`——而这个页面本身确实没有任何可用的文献元数据：`extractDoi()` 无从下手（arXiv 的
`/pdf/<id>` 网址不含 DOI），`extractTitle()` 最终只能兜底到 `document.title`，而这个值
恒定是 Chrome 查看器给的占位字符串"PDF Document"，服务器拿着这种假标题去 CrossRef 查
自然查不出结果。这已经不是"抓不到 PDF"的问题了，是新的一层。

想确认 0.3.2 的 HEAD 兜底到底生不生效、以及 `/preview` 具体收到什么发回什么，让用户去
service worker 的开发者工具看 Network 面板里的 `/preview` 请求，结果反馈"Network 是空
的"——大概率是没接上正在跑的那个 worker 实例（MV3 后台进程会休眠重启，开发者工具经常
跟丢新实例），而不是真的什么请求都没发生。继续靠猜时序意义不大，改成在
`background.js` 里直接打 `console.log`：启动时打一行带版本号的日志（可以确认到底有没有
重新加载生效）、每条消息进来打一行、`raw` 提取结果打一行、`/preview` 的请求结果（含
失败信息）打一行。这样只要打开 Console 标签页就能看到全过程，不用再纠结 Network 面板
的时机。

版本号 0.3.2 → 0.3.3（纯加日志，没有改动任何行为逻辑）。仍未拿真实浏览器验证——需要
用户按操作说明重新加载并回传 Console 输出。

**追更三（同日）：日志揭晓了真正的根因，问题不在浏览器插件这边。** 用户回传的日志：

```
{doi: null, title: null, pdf_url: 'https://arxiv.org/pdf/2105.01601', authors: [], page_url: 'https://arxiv.org/pdf/2105.01601'}
{type: 'journalArticle', title: null, ... pdf_url: 'https://arxiv.org/pdf/2105.01601', ... }
```

两个好消息坏消息一起来：`pdf_url` 已经正确，**0.3.2 的 HEAD 兜底确认生效**，PDF 检测
这条线可以结案了。但 `title` 是 `null`，不是追更一里看到的"PDF Document"——两次结果不
一致，说明那是个时序问题：手动在控制台查询时页面早就渲染完了，但插件点击时立即注入
脚本抓取，Chrome 查看器自己那套异步 JS 这时候多半还没来得及设置标题。不过这条时序
问题不值得修：就算修好稳定拿到"PDF Document"，存进库里的也只是一条标题为占位字符串
的垃圾记录，比现在直接报错更糟——**这一类页面的 DOM 里本来就没有真正的论文标题，
无论什么时候抓都一样**。

真正对的做法：`pdf_url` 已经确认可靠，那就该像桌面应用导入本地 PDF 时（
`pdfImporter.ts` 的 `importPDF()`）已经在做的一样，直接从 PDF 文件本身解析标题/DOI，
而不是死磕网页 DOM。动手前先用这篇论文的真实网址（`https://arxiv.org/pdf/2105.01601`）
跑了一遍验证脚本：下载 PDF、用项目里已有的 `pdf-parse-new` 解析、拿现成的
`extractDoi()`/`parseLocalMeta()` 正则去跑，结果第一行文本正好是
`"MLP-Mixer: An all-MLP Architecture for Vision"`——这篇论文的真实标题，验证了思路。

**改动**（首次涉及浏览器插件以外的桌面应用代码）：
- `src/main/pdfImporter.ts`：把 `extractPdfText(filePath)` 拆成
  `extractPdfTextFromBuffer(buf)` + 一层薄封装，这样已经在内存里的下载结果不用先落地
  成临时文件才能复用同一套解析逻辑。
- `src/main/server/index.ts`：`enrich()`（`/preview`、`/save` 共用）新增兜底：CrossRef
  查询之后如果仍然没有 `title` 且有 `pdf_url`，下载这份 PDF（复用
  `db/attachments.ts` 里已经验证过的大小上限 50MB + `%PDF-` 魔数校验，但不落盘、不建
  DB 记录——这里只是读文本，真正的附件持久化仍由 `/save` 里原有的
  `addAttachmentFromUrl` 负责，等于会重复下载一次，接受这个代价，换取实现简单），跑
  `extractDoi()` 找 DOI 去查 CrossRef，查不到再退到 `parseLocalMeta()` 的启发式标题，
  启发式标题本身也会拿去试一次 CrossRef 按标题搜索。整条链路直接复用 `enrich()` 里
  原有的 `apply()` 合并逻辑，没有另起一套。
- `browser-extension/background.js`：`apiPost` 的超时从 15s 提到 25s，因为
  `/preview`/`/save` 现在可能要多花时间下载解析 PDF。

版本号：桌面应用没有单独发版（用户还在本地调试，等确认真的修好了再说）；浏览器扩展
0.3.3 → 0.3.4（只有 background.js 那行超时改动）。

**验证**：`npm run typecheck` 干净；`npx vitest run` 417 项全过；改动的两个 TS 文件
`eslint` 零新增报错（server/index.ts 报的 4 条都在我没碰过的原有代码行上）；用真实
arXiv PDF 独立跑通了下载 → 解析 → 标题提取这条链路，产出了正确的论文标题。**没有跑
通完整的插件到桌面应用的真实端到端流程**——桌面应用这部分改动需要重启（不是重新加载
插件，是重启 Veridian 本体，因为改的是主进程代码），需要用户重启后实测确认。

**追更四：arXiv 那篇好了，但爱思唯尔（ScienceDirect）的论文点保存后只建了条目，没有
PDF。** 用户确认"有权限以及pdf资源"（机构访问/登录态在浏览器里生效）。这一次先加日志、
不猜——`addAttachmentFromUrl` 的每条早退路径原来完全静默，`/save` 里那个 fire-and-forget
的 `.catch(() => {})` 也把异常吞了，"条目建了但没 PDF"这句话背后可能是完全不同的原因，
必须先看到具体是哪一种。

第一轮日志加上后，用户重试同一篇论文，**终端毫无输出**——这本身就是证据：说明加了日志
的那段代码压根没跑到。往回看 `/save` 有个查重逻辑：命中同一个 DOI 会直接复用已有条目
并提前返回，从不检查这个已有条目是不是缺 PDF，也完全不摸 `pdf_url`。这解释了"终端
毫无输出"，也解释了"条目建了但没 PDF"——这篇论文是**上一次**尝试建的，这次只是命中了
查重。先补上这个真实、确定无疑的 bug：查重命中时，如果已有条目还没有 PDF，也去补一次
（同 `pdfImporter.ts` 的 `mergeIntoExisting()` 早就在做的事）。

补上后用户用同一篇论文重试，这次终端终于跑到了下载那步，日志是
`[attachments] addAttachmentFromUrl: HTTP 403 for https://www.sciencedirect.com/.../pdfft?...`
——印证了最初的猜测：**下载 PDF 的请求是桌面应用自己的网络栈发出的（Electron 的
`net.fetch`），完全不带用户浏览器里的登录/机构代理会话**，爱思唯尔把这个请求当无权限
处理，返回 403；而用户在浏览器里，因为那个会话确实生效，能正常看到 PDF。

**真正的修复**（这次涉及浏览器插件 + 桌面应用两边，是本轮最大的一次改动）：
- 思路：既然只有浏览器（具体说是那个标签页）才有这份登录态，就该让**插件自己**用这个
  标签页的身份去下载 PDF，再把下载到的内容转发给桌面应用，而不是让桌面应用自己单独
  去请求。这对任何用 cookie/机构代理做权限校验的网站都通用，不是爱思唯尔专属的补丁。
- **中途纠正了一个没验证的设计**：一开始想让 `content.js`（跑在网页里）下载完 PDF 后
  直接 POST 给本地服务器（`127.0.0.1:23120`）。但 `content.js` 发出的请求 `Origin` 头
  到底是插件自己的来源，还是它所在网页的来源（比如 `https://www.sciencedirect.com`），
  这一点没有把握，而服务器的 CORS 校验只放行插件的来源——猜错的话就是又一轮排查。改成
  更稳妥的路径：`content.js` 只负责下载 PDF 字节（带 `credentials: 'include'` 拿到页面
  自己的 cookie）、校验 `%PDF-` 魔数，然后把字节通过 `chrome.runtime` 消息通道传回
  `background.js`；真正请求本地服务器的还是 `background.js`——这条路径和现有的
  `/save`、`/preview` 请求完全一样，来源肯定没问题，不用赌。
- **改动清单**：
  - `src/main/db/attachments.ts`：把"给一段 Buffer，校验 + 落盘 + 建 DB 记录"这部分从
    `addAttachmentFromUrl` 里拆成 `saveAttachmentBuffer(itemId, buf, sourceUrl)`，供
    URL 下载和直接上传两条路径共用。
  - `src/main/services/AttachmentService.ts`：新增 `addAttachmentFromBuffer`，包一层
    跟 `addAttachmentFromUrl` 一样的 `grantAccess`/`appendOp`/`emit` 副作用（同步、
    权限白名单都要靠这些，不能漏）。
  - `src/main/server/index.ts`：新增 `POST /attach-pdf?itemId=`，走原始二进制请求体
    （原来的 `readBody()` 是给 JSON 用的，1MB 上限对 PDF 太小，另写了
    `readBinaryBody`，上限按 `MAX_PDF_BYTES` 走）；写入前检查这个条目是不是已经有
    PDF 了，避免跟服务器自己那条下载路径撞车重复写入。
  - `browser-extension/content.js`：新增 `FETCH_PDF_BYTES` 消息处理，`fetch(pdfUrl,
    {credentials:'include'})` 拿字节、校验大小和魔数，通过消息回传。
  - `browser-extension/background.js`：`/save` 成功后，新增 `attachPdfViaTab()`：
    向当前标签页要 PDF 字节，拿到后自己发 `POST /attach-pdf`，全程 fire-and-forget，
    失败只打日志，不影响弹窗已经显示的"已保存"。
- **没删的部分**：`/save` 里服务器自己发起下载那两处（新条目、查重合并）都保留不动
  ——对不需要登录态的 PDF（比如 arXiv）它更快、零额外开销，两条路径靠"是否已有 PDF"
  的检查天然不会重复写入。

版本号：浏览器扩展 0.3.4 → 0.3.5；桌面应用仍未单独发版。

**验证**：`npm run typecheck` 干净、`npx vitest run` 417 项全过、改动的三个 TS 文件
`eslint` 零新增报错、两个扩展文件 `node --check` 语法通过。**完整的端到端流程（爱思
唯尔页面 → 插件带 cookie 下载 → 转发给桌面应用 → PDF 挂载成功）还没有实测**——这次
改动面最大，需要用户重启桌面应用 + 重新加载插件后，用同一篇论文再测一次，把 3287d3c/
3d86672 两次加的所有日志（这次应该会多出 `[Veridian] FETCH_PDF_BYTES`/`/attach-pdf
response` 这类插件侧日志）一并发回来确认。

## 2026-09-21 — v0.2.1 紧急修复：v0.2.0 安装后主进程启动即崩

**现象**：更新安装 v0.2.0 后弹出 `A JavaScript error occurred in the main process`：
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-timeout' imported
from …\app.asar\node_modules\@deepseek-ai\dsh-llm\lib\index.js`。崩在主进程模块加载阶段，
连自动更新模块都没跑起来，所以**已装 v0.2.0 的用户无法靠自动更新自救，需要手动重装**。

**根因**：`dsh-llm`、`dsh-tools` 等把一批 `@deepseek-ai/dsh-*` 声明成
**peerDependencies**。npm 会把它们自动装进开发环境的 `node_modules`，所以开发、
`npm run bootcheck`、`npm test` 全都正常；但 electron-builder **只沿 `dependencies`
链打包，不跟 peerDependencies**。安装包 `app.asar` 里只有 7 个 `@deepseek-ai` 包，
缺了 9 个（agent / attachment / brand / code-runtime / invariants / session /
timeout / typert-protocol / user-approval）。这是 harness v2 第一次被打包发布，
才第一次暴露。

**为什么发版前没发现**：`bootcheck` 是在项目目录里启动 `out/main/index.js`。Node 解析
模块时会一路向上找到项目根的开发 `node_modules`，把缺的包补上了——**任何在项目目录内
运行打包产物的检查都会被这个「后门」掩盖**（连把 `dist/` 里的 asar 拿来启动也一样）。
必须把 asar 拷到项目目录之外才能复现（复现出的报错与用户所见逐字一致）。

**修复**：把这 9 个包作为直接依赖写进 `package.json` 的 `dependencies`（版本与已有的
一致，固定 `0.1.0-rc.8`），lockfile 只多了这 9 项、去掉 9 个 `"peer": true`，无版本变动。

**防再犯（两道）**：
1. `src/main/packaging.test.ts`：检查「运行时需要的（含必需的 peer，跳过 `@types/*`）」
   是否都在 `dependencies` 链上。修复前它失败并列出恰好这 9 个包，修复后通过；每次
   `npm test` 都会跑。
2. `scripts/verify-packed.cjs`（`npm run verify:packed`）：直接读**打包产物 asar 的文件
   清单**，核对每个运行时包是否真的在里面，几秒完成、不用启动。已用坏掉的 v0.2.0 asar
   做过负面对照：准确报出那 9 个包。

**发版流程新增一步**（发布前）：`npm run package -- --publish never` →
`npm run verify:packed` → 再 `npm run package -- --publish always`。

## 2026-09-21 — v0.2.0 发版：插件系统 + 划词翻译、主题切换、harness v2

自 v0.1.12 以来的累积，一次性发布。**本版带上了 harness v2**（`harness-v2-slice`
分支的 13 个提交 + 当时工作区里未提交的马厩/审批/工具策略等改动）：旧的 AI 编排
已删除，应用只跑在 harness 上。

### 一、插件系统 v0 + 划词翻译

MD 阅读器里选中文字 → 选区旁出现浮标 → 点击后译文流式显示在气泡里。翻译由内置
插件 `translate` 提供，自带 API 配置（Base URL / Key / 模型 / 目标语言，兼容 OpenAI
接口），不共用知识库的模型配置。设置里新增「插件」标签页（启用开关 + 配置表单）。

**沙箱设计**：插件是 `manifest.json` + `index.js`，跑在 Worker 里，自己联网会被 CSP
拦住，所有请求由主进程转发。

- **踩坑**：`new Worker('veridian-plugin://…')` 会被浏览器拒绝——Worker 脚本必须与
  页面同源，自定义协议是另一个源，所以「靠响应头 CSP 限制 Worker」直接走不通。改成：
  隐藏的 `<iframe sandbox="allow-scripts">`，页面由 `veridian-plugin://` 提供并带
  CSP 头，iframe 里用 Blob 创建 Worker，Blob Worker **继承 iframe 文档的 CSP**。
- **联网白名单** = 清单 `network` 里的域名 ∪ 该插件 `url` 类配置值的主机名。清单是
  插件作者写的，所以 `network` **不允许写本机地址**（否则能调用本机任意服务，包括
  Veridian 自己的 `localhost:23120`）；本机服务（如 Ollama）只能由用户自己在配置里填。
- 转发层：只允许 https（用户自填的本机地址除外）、`redirect:'error'`（防重定向到
  白名单外）、60s 超时、10MB 上限、丢弃 cookie/host/origin/referer、可中止；
  接收方销毁时会中止请求，不再空读到超时。
- 插件密码存在 `plugin.<id>.secret.*` 命名空间，`SettingsService` 按命名加密。
- `scripts/verify-plugin-sandbox.cjs`：在真实 Electron 里让 Worker 尝试
  fetch / XHR / WebSocket / importScripts / 动态 import / EventSource / 嵌套 Worker，
  带 CSP 时 8 个探针全被拦、探针服务零命中；不带 CSP 的对照命中 8 次（证明测试有效）。
  以后升级 Electron 后应重跑一次。
- 审查中发现并修复：转发出错时连接泄漏、状态码超出 200–599 时请求永久挂起、插件
  加载失败后每次运行空等 90 秒、`emit` 抛异常时 `runRelay` 拒绝。

### 二、主题切换

设置新增「外观」：跟随系统 / 浅色 / 深色。主进程在创建窗口之前设置
`nativeTheme.themeSource`（不闪白），复用 `globals.css` 里现有的深色变量块；深色下会
出问题的硬编码色（白色半透明浮层、状态栏、标签紫色）改成主题变量。

### 三、小修复

- 文献列表右键菜单在最底部一条时被窗口裁掉：菜单（及「添加到分组」子菜单）现在会
  按实际尺寸收回窗口内（`clampToViewport`，有单测）。
- 缩略图大小上限 96px → 192px。

### 验证与已知缺口

node + web 两套 tsc 干净、416 测试通过（27 个 DB 测试按既有约定跳过）、
`npm run build` 成功、沙箱验证脚本 PASS。**插件在真实应用内的端到端手测（选字 →
浮标 → 流式译文 → 取消 → 停用，需要真实 API Key）发版前未做**；`plugin:list` 与
`settings:get` 能读到插件密钥明文（与现有知识库 Key 同样处理，插件代码本身够不到
这两个通道）。

## 2026-08-21 — v0.1.12 发版：批量导入不再丢数据 + 存储不再占满 C 盘

两批修复，都源自真实用户反馈，都属于数据完整性问题。

### 一、批量导入数据丢失

用户一次导入几十篇 PDF，处理完只剩约 8 篇，伴随闪退；重启后再导入依旧存不进。
进一步反馈：**中途只要一篇出错，后面即使转换成功的文件也进不了库文件夹，全部滞留
在 `%APPDATA%/Veridian/conversions`。**

三个叠加的根因：

1. **空闲信号卡死。** `ConversionService` 用手工计数器判断「是否全部转完」，只有归零
   才触发「把这批搬进库文件夹」的同步。但 `stagingDir()`（内部 `rmSync`+`mkdirSync`，
   Windows 上遇文件占用抛 `EBUSY`/`EPERM`）在 `try` **之外**，一旦抛错该篇永不减计数，
   计数器永远归不了零，搬迁永不触发。改为由 `JobQueue` 自身记账派生（它对每个任务
   无论成功抛错都结算恰好一次），并把 `stagingDir` 挪进 `try`。顺带发现 JobQueue 的
   重试退避期既不在运行也不在队列，需单独计入忙碌，否则换成另一种误判。
2. **静默删除未导出的条目。** `importAll` 以文件树为真相，把「索引里有、树里没有」
   一律当远端删除。但刚导入、转换未完成或崩溃前未导出的条目也符合这个描述。改为
   只删「确实导出过」的条目（至少一个附件路径位于内容根内），且前缀匹配按路径分隔符
   收边界——裸 `startsWith` 会让 `C:\Lib` 认领 `C:\Lib-backup`，方向恰好是危险的那侧。
3. **转换失败的条目从不导出。** 本地文件夹型库改为照常导出（PDF 与元数据是好的，
   重转成功自然补上 `Full.md`），并让 `conversion_failed` 经 `item.json` 往返保留；
   github 库按用户决定保持原样。

### 二、C 盘存储治理

用户要求：**用户选择的位置就是默认存储区域，不要在 C 盘展开动作。**实测一个 83 篇的
库：`%APPDATA%\Veridian` 占用 1.10GB，其中 `attachments\` 560MB 与 `conversions\`
431MB **全部无人引用**（数据库 291 条附件路径指向这两处的是 0 条），而库的真实内容
535MB 在用户自选文件夹里。

根因是一个缺陷两处发作：**「搬迁」被实现成「复制 + 改指向」，从不删除源文件。**

- 搬迁改为**移动**：抽出 `storagePaths.moveInto`，三阶段（暂存到目标旁 → 清目标 →
  同卷 rename 换入），保证任何失败路径下调用前存在的内容依然存在。这个函数在评审中
  连续修了四轮，其中三处都是真会丢数据的：先删目标再移动、源被锁时目标白丢、
  目标清不掉时把仅存的那份也删了（触发条件是用户正开着那个 PDF）。
- **工作区跟随库位置**：github → `<基目录>/tmp`（git 工作树之外），本地文件夹型 →
  `<内容根>/.veridian-tmp`。大文件全程不碰 C 盘，且搬迁退化为同卷瞬时 rename。
- **无内容根的库**（个人库/纯数据库型）产物落入 `converted/<库标识>/<编号>/`，终结
  「临时区当永久存储」。
- **启动引用扫描回收存量**：以所有库的数据库为根集，`conversions/` 只删中间产物
  （`*_origin.pdf`/`layout.json`/`*_model.json`/`*content_list*.json`，实测占 82%），
  **保留 `full.md` 与 `images/`**——无引用的成品意味着条目已被删除，那是未来「孤儿
  恢复」唯一的输入；`attachments/` 只删「同内容文件在另一被引用路径上确实存在」的。
  任一数据库读不出则整轮不删。

### 评审中发现的跨任务缺陷（值得记）

- **暂存区搬进内容根后，导出把它误判成「已就位」**，`Full.md` 永远进不了
  `papers/<标题>/files/`。判断范围从「整个内容根」收窄到「该条目自己的 files 目录」。
- **回收扫描漏读数据库**：它把 `local_path` 当成所有工作空间的基目录，但只有 github
  型如此，本地库的索引在 `userData/workspaces/<id>/index.db`。漏读意味着那些库引用的
  文件被当成无主——正是删除的依据。
- **判重依据会消失**：原本靠 `attachments.md5`，但 `importItem` 从文件树重建索引时
  不写该列，真实用户那里恒为空。改为按文件大小筛选 + 内容比对。
- **两处按条目编号命名的碰撞**：`converted/<编号>` 与无内容根库共用的暂存根。条目
  编号是每库各自自增，A 库与 B 库的编号 7 指向同一处——前者导致**静默的内容错乱**
  （A 的论文显示 B 的正文），后者导致**误删**。改为全部按库标识隔离。

后三条都是**拿真实数据做只读预演**才照出来的：代码、单测、两道评审全过。

### 验证

typecheck（web+node）干净、136 测试通过、构建成功。项目的 DB 测试因 better-sqlite3
为 Electron ABI 构建而在普通 node 下 skip，故关键路径改用 **Node 24 内置 `node:sqlite`
对真实代码做执行验证**（误删保险、路径边界、字段往返、暂存清理守卫、跨库迁移），
其中误删那条还在修复前的代码上复现了 bug 本身。回收逻辑对真实 1.1GB 安装做只读预演：
**可回收 908MB，保留 84MB**，耗时 1.7s。

### 未解决 / 后续

- **闪退本身**（疑似批量导入 OOM）未定位——无受影响用户的日志，需单独复现。本次修复
  已使其**后果**不再是永久丢数据。
- **孤儿数据恢复**（条目已删、暂存文件失去归属）未做，回收逻辑已刻意为其保留输入。
- MinerU 残渣的源头缩减、可配置存储根（个人库指定存放位置）均未做。

## 2026-08-20 — v0.1.11 发版：首类笔记 + 双链/反链 + AI 写笔记

自 v0.1.10 以来累积的知识库大版本，一次性发布。

**首类笔记 + Obsidian 式双链（P2-A）**：`notes` 表升为一等公民，`item_id`
可空——挂在文献上的是"文献笔记"，`item_id` 为空的是"独立概念笔记"。笔记
正文里写 `[[标题]]` 会被解析成 `relations` 边（`rel_type='wikilink'`），
在被指向的笔记/文献上以**反向链接**列出。悬空链接（指向尚不存在的标题）
保持悬空、不报错，等目标出现时自动接上。新增独立笔记页、侧栏笔记列表、
`[[` 自动补全的笔记编辑器、反链栏、文献详情的"笔记"标签页。

**AI 写笔记能力**：`saveNote` 增加 `origin`（user|ai），AI 写入的笔记
统一走 `saveNote`，所以 `[[链接]]` 会自动建反链边。agent 在 notes 模式下
获得 `create_note`（可建独立概念笔记，`item_key` 可选）、`update_note`
（按 id 定位、允许整体重写）、`list_notes` 工具；工具在模式路由层结构化
门控（notes 模式放行、qa 模式拒绝）。

**体验修复**：右侧详情面板切换文献条目时**记住当前所在的标签页**，不再
每次跳回第一个（元数据）标签。笔记 UI 的 emoji 图标（📝/📄）全部换成随
`currentColor` 走主题色的内联 SVG 线性图标。

**验证**：node + web 两套 tsc 干净、111 测试通过（40 个 DB 测试在 Electron
ABI 下按既有约定跳过）、`npm run build` 打包成功。发布沿用固定流程：
bump 0.1.11 → commit → push main → push tag v0.1.11 → electron-builder
`--publish always`。

## 2026-07-26 — 对话模型新增 Claude（订阅令牌）预设

用户问能否用 Claude 订阅账号额度。查证 Anthropic 开发者政策：第三方应用做
"一键登录 Claude / 共享额度"是明确禁止的（"does not allow third-party
developers to offer claude.ai login or share rate limits"），但官方文档
（[authentication#generate-a-long-lived-token]
(https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)）
本身写明 `claude setup-token` 生成的一年期 OAuth 令牌就是给"CI 流水线、
脚本或其他无法交互式浏览器登录的环境"用的，用户可以自己生成、贴到任何
想用的地方——这条路径是合规的，区别只在于"App 帮你登录"（禁止）vs
"你自己生成令牌，手动粘贴"（官方文档写明的用法）。所以选择了后者：不做
登录按钮，只做一个预设 + 令牌粘贴框。

**实现**：Anthropic 的 Messages API（`/v1/messages`）跟现有的 OpenAI 兼容
协议（`/v1/chat/completions`）线格式不同（system 是独立字段不是消息、工具
定义叫 `input_schema` 不是 `parameters`、SSE 事件类型也不同），新增
`src/main/knowledge/anthropicClient.ts` 单独实现，`providers.ts` 的
`chatStream` 按 `preset === 'claude-subscription'` 分流（动态 import，
避免两个文件间的运行时循环依赖）。请求头用
`Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`——
后者是 Claude Code 自己客户端认证 OAuth 令牌时用的头，参考了社区逆向项目
（如 `weidwonder/claude_agent_sdk_oauth_demo`）的实现，**没有真实令牌
测试过实际调用**，只保证协议转换层（消息格式、工具格式互转）用单测
验证正确（6 个用例：system 拆分、tool_calls→tool_use 块、tool 结果→
tool_result 块、并行工具调用合并进同一个 user turn、非法 JSON 参数不炸、
parameters→input_schema 改名）。

Anthropic 不提供 embedding 接口，所以这个预设只加在"对话模型"，不出现在
"Embedding 模型"的预设列表里。

**UI**：`KnowledgeSettingsTab` 对话模型预设新增"Claude（订阅令牌）"，选中后
API 地址自动锁定为 `https://api.anthropic.com`（只读，协议决定的不给改）、
模型名默认 `claude-sonnet-4-5`，API Key 栏位标签换成"订阅令牌"并显示
`claude setup-token` 使用引导。CDP 远程驱动真实 dev 实例验证：选中预设后
上述字段渲染符合预期。

**未验证**：真实令牌的端到端调用（用户目前没有生成令牌）——如果用了发现
`anthropic-beta` 头不对或事件解析有问题，需要用真实令牌抓包核对再修。

## 2026-07-26 — 知识库 + AI Agent + RAG（第一期：问答）

按此前提交的设计方案（`docs/superpowers/specs/2026-07-26-knowledge-rag-design.md`）
实现第一期：混合检索 + 工具循环 Agent 问答，不含自动生成每篇笔记（用户明确
只要问答）；embedding 和对话模型全部走云端 OpenAI 兼容 API（用户明确本地
推理先不考虑）；索引与对话记录仅本地，不随协作空间同步。

**新模块** `src/main/knowledge/`：
- `chunker.ts` —— Full.md 按标题层级切段 + 超长段落滑窗（15% overlap），
  纯函数，不含 I/O，8 个单测覆盖代码块内 `#` 不误判为标题等边界情况。
- `db.ts` —— 独立 `knowledge.db`（位置由 `knowledge.storagePath` 设置项
  决定，默认 `userData/knowledge/`），`sqlite-vec` 的 vec0 虚拟表懒建
  （首次 embedding 成功后才知道维度，写入 meta 表锁定模型+维度；换模型
  维度不匹配则拒绝写入，提示用户走"重建索引"）。
- `indexer.ts` —— 域事件驱动：`attachment.changed`（转换出 Full.md）/
  `workspace.dataRefreshed`（切换协作空间）/ 设置变更 三类事件防抖后
  触发扫描。两阶段：chunks+FTS5 先建（不需要联网，永远可用）→ embedding
  批量调用（32 条/批，失败的 chunk 标记待重试，不阻塞 FTS 检索）。
- `search.ts` —— 混合检索：FTS5 BM25 top-30 + 向量 KNN top-30，
  Reciprocal Rank Fusion 融合取 top-8（RRF 只看排名不看分数，绕开两路
  分数空间不兼容的问题）。`sqlite-vec` 不可用时自动降级为纯 JS 余弦
  相似度扫描 BLOB 向量。
- `providers.ts` —— OpenAI 兼容 HTTP 客户端，一份实现覆盖 DeepSeek/
  智谱/Kimi/OpenAI/自定义，对话和 embedding 分两组独立配置（同厂商可
  勾选复用 key）。`chatStream` 手写 SSE 逐行解析，支持流式 content +
  流式 tool_calls（按 index 累积分片参数）。
- `agent.ts` —— 工具循环（`search_library`/`get_item_info`/
  `read_context`，最多 8 轮），系统提示词要求内联 `[^item_key:seq]`
  引用标记；流式 delta 和状态通过新增域事件
  `knowledge.chatDelta`/`knowledge.chatState` 推给渲染层，IPC 调用本身
  只返回 conversation id（避免长连接阻塞 invoke）。

**新增域事件**：`knowledge.indexChanged`、`knowledge.chatDelta`、
`knowledge.chatState`（见 `shared/events.ts`）。

**IPC**：`knowledge:ask/stop/listConversations/getMessages/
deleteConversation/rebuildIndex/indexStatus/pickStoragePath/
testProvider` 九个通道，走既定的 contract → handlers → preload →
env.d.ts 四处同步模式。`knowledge:pickStoragePath` 迁移目录时先
`renameSync`，跨盘失败则退化为拷贝+删除。

**UI**：设置页新增"AI 知识库" tab（存储路径 + 对话/embedding 两组
Provider 配置 + 索引状态 + 重建按钮）；工具栏新增"AI 助手"按钮，走
`uiStore` 既有的整页切换模式（同 设置/工具 页一致，非弹窗）新开一个
`knowledge` page；聊天面板左侧会话历史、右侧消息流，引用标记渲染为
可点击 chip（复用 `openMarkdown` 跳转到原文，实现上是把
`[^KEY:seq]` 重写成 `[[n]](veridian-cite://KEY/seq)` 交给
`ReactMarkdown` 的 `a` 组件拦截渲染，没有另写解析器）。中英文 i18n
全覆盖。

**验证**：sqlite-vec 冒烟测试通过（Electron 环境内 `vec_version()`/
KNN 插入查询/FTS5 均正常）；51 个单测通过（新增 17 个：chunker 8 +
search/RRF 6 + citations 3）；typecheck 无新增错误（node 基线 4，
web 0）；`npm run build` 成功。**真实环境端到端验证**：用
`electron-vite dev --remote-debugging-port` 起真实 dev 实例，CDP 远程
驱动点击（而非本 session 之前用的 mock-HTML 截图法——那套在这次环境
下 `capturePage()`/`executeJavaScript()` 都不可靠，改用真实运行的
应用 + CDP + 页面自身 console/DOM 回读）：
- 状态栏 "AI index — done"，设置页显示"已索引 7 / 7 篇文献，399 个
  片段待生成向量"（未配置 embedding key 时的预期状态：FTS5 已建好，
  向量待补）；
- 直接查询真实 `knowledge.db`：399 个 chunk 来自用户库里 7 篇真实
  文献，标题层级正确保留；FTS5 关键词检索 "SAT" 正确命中对应论文；
- AI 助手面板正确显示"问答范围：Ref-dataset-test"（当前协作空间名）
  和"尚未配置对话模型"引导文案（未配置对话 key 时的预期降级状态）。
- 未验证：实际 LLM 问答往返（没有可用的 API key，用户后续自行配置）。

## 2026-07-25 — v0.1.4 发版

内容：工具栏手动同步按钮（含 CSS 环形 spinner）、会话恢复（工作空间 +
阅读器状态）、查看协作空间成员、浏览器扩展中英文切换 + 工作空间显示、
扩展新图标。

**发版新坑**：首次 `--publish always` 失败，GitHub 422 "Published releases
must have a valid tag"——`releaseType: "release"`（非 draft）要求 tag 必须
**先存在于远端**。此前几版恰好都是 tag 先推的，这次先跑了发布才建 tag。
流程固定为：bump version → commit → push main → **push tag** → publish。
失败的那次构建还留下了旧版 latest.yml（18:55 的 0.1.3 残留），但重跑
electron-builder 全量重新打包后自然覆盖，无需手工修复。

**验证**：本次无重复 Release；匿名 `/releases/latest` 返回 v0.1.4；
latest.yml 的 version/sha512/size 与实际上传的 exe 逐一核对一致。

## 2026-07-25 — 浏览器扩展中英文切换 + 工作空间显示

扩展弹窗（`popup.js`/`popup.html`）此前完全没有 i18n（硬编码中文）也不知道
当前活跃的是哪个工作空间。扩展没有构建流程（纯 `<script src="popup.js">`，
无打包器），所以 i18n 直接内联在 `popup.js` 里一份 `STRINGS = { en, zh }`
字典，不单独拆 i18n.js 模块。

**语言切换**：弹窗内手动切换按钮（不跟随 `chrome.i18n` 的浏览器语言），
偏好存 `chrome.storage.local`（弹窗每次关闭都会销毁 DOM/内存状态，必须持久化）。
默认语言英文——弹窗打开瞬间（"Step 0"）就用 `getLang()` 读到的语言直接渲染
初始文案，避免先闪一下硬编码中文再切换。`popup.html` 的初始文案节点改成空
字符串，全部交给 `popup.js` 填充。

**工作空间显示**：`/ping` 响应新增 `workspace: { kind, name }`
（`src/main/server/index.ts`），来自 `getActiveWorkspace()` +
`getWorkspace(id).name`——只吐原始 kind/name，本地化文案（"个人库" vs
真实工作空间名）由扩展自己按当前语言选择，主进程不替扩展做语言决定。弹窗
以只读方式展示"保存到：XXX"，不支持从扩展内切换工作空间（协作空间切换是
桌面应用的操作，扩展只是告知用户"即将存到哪"，避免用户没注意到桌面端已切换
库而存错地方）。

**验证**：`claude-in-chrome` 未连接扩展，改用 Electron 隐藏窗口加载模拟
`window.chrome` 的测试页 + `console-message` 事件回读渲染结果（截图法在此
沙箱环境下 `capturePage()`/`executeJavaScript()` 均返回陈旧或空白结果，判定
为环境限制而非代码问题，改走已验证可靠的页面 `console.log` 回读通道）。过程中
发现真实 bug：作者列表"等 N 人"后缀传的是作者总数而非剩余未展示数量
（7 位作者只显示 6 位时误显示"等 7 人"，应为"等 1 人"），已修复并重新验证
中英文两版渲染均正确。

`content.js` 无用户可见字符串（纯 DOM 提取），`background.js` 的 3 处内部
错误兜底文案（`'no tab'` 等）保持英文不译——同桌面端不翻译 `console.error`
调试信息的惯例一致，且用户几乎不会看到。

**验证结果**：typecheck（node 基线 4 / web 0，无新增）、34 测试通过、
`node --check` 语法检查通过。

## 2026-07-25 — 查看协作空间成员

`GitHubService` 新增 `listCollaborators(owner, repo)`，封装
`GET /repos/{owner}/{repo}/collaborators`，返回每个协作者的头像 URL、
用户名、角色（`role_name`：admin/maintain/write/triage/read）。GitHub 要求
调用方对该仓库至少有写权限，只读协作者的令牌会拿到 403——单独映射成
"没有权限查看"文案，不和"暂无协作者"混为一谈（避免误导只读用户以为
仓库没人协作）。

**UI**：`WorkspaceDialog` 的工作空间列表行，`inviteOpenId` 状态泛化成
`openPanel: { id, kind: 'invite' | 'members' } | null`（同一行同一时刻只
展开一个面板），新增"查看成员"按钮和 `MembersList` 组件——头像直接用
GitHub 返回的 `avatarUrl`（`WorkspaceSwitcher` 身份行已有先例直接这么用，
不需要再走本地缓存那套）。

**验证**：用 Electron 自身渲染器截图确认三按钮行（查看成员/邀请协作者/
删除）不拥挤；typecheck（node 基线 4 / web 0）、34 测试通过、build 成功。

上次关闭软件时的工作空间和阅读器打开状态，下次启动自动恢复。范围经用户
确认限定为这两项（不含选中条目/分类/搜索词/窗口大小——`viewerPath` 一旦
设置会让 `MainLayout` 整体切到阅读器视图、隐藏列表和详情面板，这两块状态
天然独立，互不依赖）。

**存储**：复用 `SettingsService`（明文 JSON，无需加密）两个独立 key：
- `session.workspaceId`：由**主进程自己**在 `WorkspaceContextService
  .setActiveWorkspace` 每次切换成功后直接写入（包括切回个人库写 null）——
  不经 IPC，因为主进程本来就是这个状态的权威来源。
- `session.viewer`：`{ type, path, filename } | null`，渲染层专属状态
  （zustand `itemStore`），新增专用 IPC `session:saveViewer` 写入——沿用
  安全加固时定下的原则，不擅自放宽通用 `settings:set` 白名单。

**恢复时机**：`App.tsx` 新增一个启动期一次性 effect：读
`session.workspaceId` → 有值调 `setActiveWorkspace`（复用现成的 clone/pull
容错逻辑）；读 `session.viewer` → 类型守卫校验后调对应的
`openPdf/openMarkdown/openGallery`。

**容错**：整个恢复过程包在 try/catch 里——存的工作空间被删了、文件被移走了，
都只是静默失败回落到默认状态（个人库、无阅读器），不影响应用正常启动。

**验证**：typecheck（node 基线 4 / web 0）、34 测试通过、build 成功、dev
模式冷启动无报错。**未做**：真实"退出→重启→确认状态还原"的完整回归测试
（需要真实的历史会话状态，留给用户下次重启时自然验证）。

新增 `SyncButton`（`src/renderer/src/components/layout/SyncButton.tsx`），
放在工具栏工作空间切换器右侧（左侧区域）。

- **显示条件**：仅当前激活的是 github 类型工作空间时渲染；个人库/本地工作
  空间下不显示（无东西可同步）。
- **状态反映真实同步进度**：`workspace.syncNow()` 只是把任务入队就立即返回，
  真正的 pull+push 是后台异步跑的。按钮监听与状态栏 pdf2md 进度共用的同一条
  `job.progress` 领域事件（按 `job.type === 'workspace.sync'` 过滤），据此
  切换旋转图标——同步中禁用点击、图标旋转（复用 globals.css 已有的 `spin`
  关键帧），真正完成/出错后自动恢复，而非猜一个固定延时假装在转。

**验证**：用 Electron 自身 Chromium 渲染静态 mock 截图确认位置/尺寸观感后
落地真代码；typecheck（node 4 基线 / web 0）、34 测试通过、build 成功。

合并 main：块 A（GitHub OAuth 登录）+ 块 B（贡献者标注）+ 同步流程三改（一次性
提交/失败标红/标题目录）+ 暂存目录修复 + 转换产物规范化（figN + Full 命名）+
图片带功能 + 响应式修复 + 块 C（软件内邀请协作者）+ 邀请控件布局调整。发布前
在合并后的 main 上重跑全量校验：node typecheck 基线 4、web typecheck **0**、
34 测试通过、build 成功。

**发布过程踩的新坑**：electron-builder 的重复 release 竞态这次表现不同以往——
两次并发创建请求中一次因"tag 已存在"报 422 直接失败，导致**打包进程提前退出**，
只上传了 blockmap 就中断，`exe` 和 `latest.yml` 都没传；更隐蔽的是，中断前
`dist/latest.yml` 还停留在**上一次（v0.1.2）打包的旧文件**（进程还没跑到重新
生成这一步就挂了）。若直接把这份 stale 文件传上去，`electron-updater` 客户端
会读到"最新版是 0.1.2"、sha512 对不上 0.1.3 的 exe，静默导致所有已装 0.1.2
的用户永远收不到 0.1.3 更新提示。

**处理**：核实 `dist/` 下 exe/blockmap 的文件时间戳确认是本次新构建（而不是
latest.yml 的旧时间戳）→ 补传 exe → 用 Node `crypto.createHash('sha512')`
对本地新 exe 重新计算摘要、手写正确的 `latest.yml`（version/sha512/size 与
真实文件一致）→ 删除误传的旧版本 asset → 重新上传 → 用**未认证请求**
（`GET /releases/latest`，与 electron-updater 客户端完全一致的调用方式）
确认最终解析结果版本号、sha512、文件名全部正确。

**教训沉淀**：`--publish always` 每次发布后必须核实两件事——① 该 tag 下只有
一个 release（无重复）；② `latest.yml` 的 `version` 字段与被打包的实际版本
一致（不能只看"文件存在"，内容也可能是上一版残留）。

---

## 2026-07-25 — 邀请协作者控件布局调整

用真实样式值渲染静态 HTML mock（Electron 自身 Chromium 截图，无需连 Chrome
扩展）比对现状与改进方案，用户确认后实施。

**WorkspaceDialog 的邀请表单**（`WorkspaceList`）：原先展开态是"用户名输入框 +
发送 + 取消 + 删除"四个控件挤在一行，"取消"和"删除"样式几乎相同（都是灰边框
白底）容易点错——一个是关闭表单、一个是删仓库，危险度完全不同。
`InviteRow` 拆分为触发按钮（留在收起态的按钮组里，和删除按钮并列）+
`InviteForm`（展开态时删除按钮让位、表单独占一整行，取消按钮改为无边框浅色，
和主要操作明确区分）。`open` 状态从组件内部提升到 `WorkspaceList`
（`inviteOpenId`），因为需要用它控制删除按钮的显隐。

**WorkspaceSwitcher 的邀请通知**：原先是纯文字行，和下方常规工作空间列表
没有视觉分层，仓库名不突出，多条邀请会挤在一起。改为每条邀请独立的浅色
卡片（`--primary-light` 背景+圆角），仓库名单独一行加粗高亮为主色调，
接受/拒绝按钮改为等宽撑满。相应把 i18n 的 `receivedFrom` 从含仓库名的整句
拆成"邀请你加入"前缀，仓库名单独渲染。

**验证**：typecheck 双端（node 4 基线 / web 0）、34 测试通过、build 成功。

用户反馈：新导入的 PDF 转换完成后不会自动出现图片带，要重启软件才有；协作
仓库同步拉取的更新也要切出工作空间再切回来才能看到。

**根因**：`FigureStrip` 用的是手写一次性 `useEffect` 拉取（滚入可视区域时拉一次
就不再更新），没有接入项目已有的响应式查询系统 `data/queryCache.ts`
（`useQuery` + 领域事件自动失效重拉——`AttachmentsTab` 的 `useAttachments`
等其余数据读取全部走这套机制，唯独 `FigureStrip` 是例外）。"重启/切换空间
才刷新"，本质是"整个组件被强制重新挂载"顶替了本该有的事件响应。

**修复**：
- `data/hooks.ts` 新增 `useItemImages(itemId)`，基于 `useQuery` 实现（查
  imagedir 附件 + 列图片目录，合并为一次查询）。
- `queryCache.ts` 的 `attachment.changed` 事件处理新增
  `invalidate(['item-images', id])`（此前只失效 `attachments`）——转换完成
  注册 imagedir 附件时会触发该事件，图片带因此自动重拉。
- `workspace.dataRefreshed` 已有的 `invalidateAll()` 天然覆盖新 key，同步/
  拉取后无需额外接线即可让已挂载的图片带自动刷新。
- `FigureStrip.tsx` 重构为外层用 `useInView` 做懒挂载门控（保持原有的"不滚
  到附近不做任何事"的内存策略不变），内层 `FigureStripContent` 用
  `useItemImages` 拉取——一旦挂载，此后转换完成、同步拉取都会自动更新，
  不需要用户任何操作。

**验证**：typecheck 双端清零/回基线；34 测试通过；build 成功。

**图片归一化**（`markdownImages.ts`，纯函数 11 单测）：转换成功后在暂存区内，
按 md 中图片引用的首次出现顺序把引用改写为 `images/figN.<ext>`（覆盖
`![]()` 与 `<img src>` 两种形式；跳过 http/data 外链；引用缺失的文件不动），
再按映射对 images 目录做**两阶段重命名**（先全部转临时名再落最终名，防止
源文件本身叫 fig1.png 之类的中途覆盖）。**md 中从未被引用到的图片**（封面
缩略图、MinerU 偶发的重复页截图等）直接删除，只保留文档实际用到的图。
归一化失败不影响转换结果（best-effort）。

**Full 统一命名**（`WorkspaceFiles.exportItems`）：目录名已承载标题，文件名
统一为 `Full.pdf` / `Full.md` / `images/`。三类均为覆盖式单例；条目的额外
非常规文件仍走 uniquePath。**已在仓库内的旧命名（<stem>.pdf/<stem>.md）会在
下次导出该条目时原地迁移到 Full.***。

**files/ 对账**：导出末尾清除 files/ 下不属于任何附件行的孤儿条目——旧命名
残留、历史 `_mineru` 污染目录等自动清理，仓库严格镜像附件行。

---

## 2026-07-25 — 重转换污染仓库修复（暂存目录方案）

用户实测发现：已同步的 PDF 重转 markdown 后，MinerU 的**整个 zip 解压目录**
（full.md、images、layout.json 等杂物）直接落进仓库的 `files/` 下成为嵌套新目录，
且旧 md/images 未被替换。

**根因**：`manualConvertPdfToMd` 复用已同步进仓库的 md 路径作输出目标 →
MinerU 解压目录（`<stem>_mineru/`）生成在仓库 `files/` 内 → 新 md 路径已在
repoRoot 内 → 导出搬运的"固定名覆盖"逻辑（v0.1.2）被 `startsWith(repoRoot)`
跳过，完全没执行。

**修复（比"先删后放"更根治）**：转换输出**永远写到仓库外的暂存目录**
`userData/conversions/<itemId>/`（每次转换前清空）。这样注册的 md/images
附件路径在仓库外 → 导出搬运必然触发 → md 固定名覆盖 `files/<stem>.md`、
images 先删 `files/images` 再整体拷入（旧图清除、结构不变）→ zip 杂物留在
暂存区**根本进不了仓库**。`manualConvertPdfToMd` 不再复用旧输出路径。

**注意**：此前测试中已被污染的仓库需**手动删除一次** `files/` 下的
`<stem>_mineru/` 嵌套目录（修复只防止再次发生，不清理历史污染）。

---

## 2026-07-24 — 重复文献检测合并 + 转换附件堆积修复（v0.1.2）

同步设计审查（见对话记录）发现的两个数据完整性问题，均在软件端修复后再同步——
GitHub 仓库只做存储，不承担业务逻辑。

### 重复文献检测（导入查重，之前完全没有）
两道闸，全部在创建条目**之前**拦截：
1. **文件 MD5 精确匹配**（`db/attachments.ts`）：PDF 入库时计算 MD5 存入 `md5` 列
   （schema v1 就有此列，此前从未使用，零迁移）。`importPDF` 入口先查
   `findItemIdByMd5`——同一文件第二次导入直接跳过（可选加入目标分类）。
2. **DOI 归一化匹配**（`db/items.ts` `normalizeDoi`/`findItemByDoi`）：剥离
   `https://doi.org/`、`doi:` 前缀并小写后比对。命中时**合并而非新建**：
   已有条目无 PDF 附件则把本次文件附上并触发转换（对应"扩展先存网页、
   后补 PDF"的常见流程）。浏览器扩展 `/save` 同样查重，重复保存返回
   `duplicated: true` + 原条目，不再产生第二个 `papers/<key>/` 目录。

### 转换附件堆积修复（重转 markdown 不再产生 foo-1.md / images-1）
根因链：workspace 同步把附件行 relocate 进 repo（copy 而非 move）→ 本地旧输出
文件仍在 → `autoConvertPdfToMd` 的"已转换"判断用路径相等而路径已变 → 注册出
第二条 markdown 行 → 导出时 `uniquePath` 避让出 `foo-1.md`。三处配合修复：
- `ConversionService.autoConvertPdfToMd`：改按**类型**判断已转换（存在 markdown
  附件即跳过），不再依赖路径相等。
- `AttachmentService.registerAttachment/registerAttachmentDir`：markdown/imagedir
  是每条目**单例**——已有同类型行时改指(repoint)该行到新路径，绝不插第二行。
- `WorkspaceFiles.exportItems`：转换类附件用**固定名覆盖**搬运（md 直接覆盖、
  imagedir 先删后拷防新旧图片合并残留）；`uniquePath` 只留给真正的用户文件（PDF 等）。

### 验证
- typecheck（node+web）相对基线零新增错误。
- 端到端实测（dev + 本地连接器）：同一 DOI 连续 `/save` 两次，第二次带
  `https://doi.org/` 前缀 + 全大写，返回 `duplicated: true` 且条目 id 不变。
- 测试数据已从 dev 库清理。

### 遗留
- BibTeX / CSL-JSON 批量导入路径暂未接 DOI 查重（入口在 `importer.ts`，
  后续版本补）。

### v0.1.2 发布记录
- 已发布至 GitHub Releases；客户端视角验证：`/releases/latest` → v0.1.2，
  `releases/download/v0.1.2/latest.yml` 内容正确（version/sha512/size）。
  装有 v0.1.1 的机器启动后应收到更新提示。
- **electron-builder 重复 release bug 复发**：`releaseType: "release"` 并没有
  根治——这是发布器对多产物并发上传的竞态（同 tag 建了两个 release，文件被
  拆散），v0.1.1、v0.1.2 连续两次复现。本次同样手动合并（补传 blockmap、删除
  只含 blockmap 的空壳）。**每次 `--publish always` 之后必须核查**：
  `GET /releases` 确认该 tag 只有一个 release 且 exe/latest.yml/blockmap 三件齐全。
  根治方向（后续）：`--publish never` 打包后用脚本自行创建 release + 上传三件套。

---

## 2026-07-24 — 安全与健壮性加固（代码审查后修复）

针对《Project Plan/代码问题清单与修复方案.md》列出的问题逐条修复，均为边界处收口，
不涉及架构变更。所有改动经端到端实测验证（非仅类型检查）。

### 安全类
- **本地连接器服务器加固**（`main/server/index.ts`）
  - 按 `Origin` 鉴别来源：浏览器扩展来源回显 CORS，普通网页来源一律 **403**，
    无 Origin 的原生请求放行。堵住"任意网页可注入条目 / 触发任意 URL 下载 /
    消耗 MinerU 配额"的漏洞（原先 `Access-Control-Allow-Origin: *` 且无鉴权）。
  - 请求体 **1MB 上限**，超限 `destroy` 并返回 413（防内存撑爆）。
- **PAT 不再对渲染层暴露**（`main/ipc/handlers.ts`）：`settings:get` 拒绝返回
  `github.pat` / `controlPlane.session`；UI 本就只依赖 `github:getStatus` 的 `hasPat`。
- **settings 写入白名单**（`main/ipc/handlers.ts`）：`settings:set` 仅允许 pdf2md 相关键；
  `storage.path` 只能清空，真实路径必须经原生对话框（`settings:pickStoragePath`），
  避免渲染层把文件白名单扩到任意目录。
- **Markdown XSS 收口**（`renderer/.../MarkdownViewer.tsx`）：`rehype-raw` 之后接入
  `rehype-sanitize`（顺序 raw → sanitize → katex）。.md 来源不可信（MinerU 输出、
  GitHub 协作仓库同步文件），sanitize 剥离 `<script>` / `onerror` / `javascript:` 等，
  同时保留 KaTeX 所需 class、代码块 `language-*`、`veridian-file://` 图片协议。
- **openExternal 协议校验**（`handlers.ts` + `main/index.ts`）：仅放行 http/https。

### 正确性 / 健壮性
- **连接器端口 23119 → 23120**（server + 扩展 manifest/background/popup + 文档）：
  23119 是 Zotero connector 端口，共存时会互相截流量；改独立端口，且被占用时
  经状态栏提示而非静默禁用。
- **FTS5 搜索转义**（`main/db/items.ts`）：用户输入按词包成 `"term"*` 短语前缀，
  含 `"` `(` `AND` 等特殊字符不再抛语法错误。
- **URL 下载附件校验**（`main/db/attachments.ts`）：校验 `%PDF-` 魔数 + 50MB 上限
  （含 content-length 预检），HTML 错误页不再被存成 .pdf。
- **CrossRef year 防 NaN**（`server/index.ts`）：非有限数值写入 null。

### 文档
- `CLAUDE.md`：修正 IPC 路径（`ipc/gateway.ts` + `handlers.ts`）、扩展目录名
  （`browser-extension/`）、端口号。

### 依赖
- 新增 `rehype-sanitize`。

---

## 2026-07-24 — 自动更新（零成本方案）

基于 `electron-updater` + GitHub Releases 实现在线更新，无需自建服务器、无需代码
签名证书，成本为零。

### 交互流程
1. 每次启动后台静默检查 GitHub Releases（`main` 进程，`initAutoUpdater()`）
2. 发现更高版本 → 后台差量下载（NSIS blockmap，只下变化的块）
3. 下载完成 → 弹原生对话框「发现新版本 vX.X.X，是否立即更新」
4. 用户点「立即更新」→ `quitAndInstall(false, true)`：退出 → 安装 → 自动重启
5. 用户点「稍后」/ 检查失败（离线、GitHub 不可达）→ 静默忽略，绝不阻塞启动
6. 开发环境（`is.dev`）跳过检查——dev 无 latest.yml，检查必然报错

### 改动
- 新增 `src/main/services/UpdateService.ts`：更新逻辑与对话框
- `src/main/index.ts`：`app.whenReady` 内 `createWindow()` 后调用 `initAutoUpdater()`
- `package.json`：`build.publish` 指向 GitHub 仓库；新增依赖 `electron-updater`

### 发布流程（开发者侧）
```
npm version patch                      # 递增版本号（0.1.0 -> 0.1.1），必须每次递增
set GH_TOKEN=<有 repo 权限的 PAT>       # electron-builder 上传 Release 用
npm run package -- --publish always     # 打包并自动上传到 GitHub Releases
```
仓库需为 **public**（客户端拉取 Release 无需 token）；否则客户端要内置 token，不安全。

### 前提 / 限制
- **未做代码签名**：Windows 首次安装/更新会有 SmartScreen「未知发布者」提示，
  点「仍要运行」即可，不影响更新功能。日后可用 SignPath.io 的 OSS 免费计划消除。
- **完整链路（检测→下载→安装→重启）无法在开发环境验证**，须打包发布真实 Release
  后、用已安装的旧版本实测。

### v0.1.1 首发记录 + 踩坑

首次实际发布验证：`v0.1.1` 已发布，`GET /repos/.../releases/latest`（未认证请求，等同
electron-updater 客户端的实际检查方式）确认返回 v0.1.1 且 `latest.yml` / 安装包 /
blockmap 三个文件齐全 —— 发布链路端到端验证通过。

遇到的问题及修复：
- **`v0.1.0` 早期 Release 冲突**：仓库里已有一个手动发布过的 `v0.1.0`
  （2026-07-10，Phase 0 时期），与本次构建版本号相同，导致 `--publish always`
  整体跳过。**每次发布前必须递增版本号**（`npm version patch`），不能是巧合，
  这条规则从一开始就是必须的。
- **重复草稿 bug**：electron-builder 默认对多产物分别触发发布钩子，实测在同一个
  tag（v0.1.1）下建了两个重复的 draft Release，文件被拆散到两边（一个只有
  blockmap，另一个只有 exe+latest.yml）。手动核对、删除空壳草稿、补传缺失文件、
  合并到一个完整 Release 后再发布。**已通过 `build.publish[0].releaseType: "release"`
  规避**：跳过 draft 中间态，直接创建正式 Release，后续发布不会再拆分。
- **默认行为调整**：`build.publish` 加了 `releaseType: "release"`——原本
  electron-builder 默认先建草稿等人工点发布，现在改为 `--publish always` 直接
  正式发布，不再需要每次手动确认（更贴合本项目"全自动检测→更新"的设计目标）。

---

## 2026-06-09 — Phase 0 完成：项目脚手架

### 完成内容

**运行环境**
- Node.js v24.11.0 / npm 11.13.0
- Electron 36 + electron-vite 3.x
- React 18.3 + TypeScript 5.8 strict 模式
- Tailwind CSS v4（@tailwindcss/vite 插件）

**主进程（src/main/）**
- `index.ts`：应用入口，BrowserWindow 创建，服务初始化
- `db/index.ts`：better-sqlite3 初始化 + 自动 Schema 迁移（版本化）
- `db/items.ts`：条目 CRUD + SQLite FTS5 全文检索
- `ipc.ts`：IPC 处理器注册（items:getAll / create / update / delete / search）
- `server/index.ts`：本地 HTTP 连接器，监听 localhost:23120，供浏览器扩展调用

**数据库 Schema（SQLite）**
- `libraries` / `collections` / `collection_items`
- `items`（含 version 乐观锁字段）
- `creators` / `item_creators`（多对多，支持 author/editor/translator 角色）
- `tags` / `item_tags`
- `attachments` / `notes`
- `sync_state`（预留 GitHub 同步状态）
- `items_fts`（FTS5 虚拟表，全文检索）

**preload（src/preload/）**
- `contextBridge` 暴露 `window.veridian` API
- 类型定义在 `src/renderer/src/env.d.ts`

**渲染层（src/renderer/）**
- 三栏布局：CollectionPane（左） / ItemListPane（中） / DetailPane（右）
- Toolbar：搜索框 + 添加条目 + 中/英语言切换
- DetailPane：元数据 / 附件 / 笔记三 Tab
- Zustand `itemStore`：items 列表、selectedId、searchQuery、activeCollection
- react-i18next 双语（zh/en），运行时切换，无需重启
- Tailwind CSS v4 + CSS 变量主题（支持亮/暗色切换预留）

**配置文件**
- `electron.vite.config.ts`：main / preload / renderer 三端构建
- `tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json`：分离配置
- `eslint.config.mjs`：ESLint 9 扁平配置
- `.gitignore`：排除 node_modules / out / *.db

**验证状态**
- `tsc --noEmit`（node + web 两个 tsconfig）：**零错误** ✅
- `npm install`：依赖安装成功 ✅
- git commit：`839af43` ✅

---

---

## 2026-06-09 — Phase 1 完成：完整 CRUD + 分类 + 导入

### 新增内容

**DB 层扩展（src/main/db/）**
- `creators.ts`：作者 CRUD，`setCreatorsForItem` 事务写入
- `tags.ts`：标签 CRUD，孤儿标签自动清理
- `collections.ts`：分类 CRUD，addItem / removeItem / getItems
- `items.ts` 重写：新增 journal/publisher/volume/issue/pages/isbn/language/extra/deleted 字段，软删除（trash/restore），全字段 updateItem

**BibTeX / CSL-JSON 导入（src/main/importer.ts）**
- 纯 Node.js 实现的 BibTeX 解析器（无外部依赖）
- CSL-JSON 批量导入
- 自动映射类型（article→journalArticle 等），解析作者字段
- Electron dialog 文件选择对话框

**IPC 扩展（src/main/ipc.ts）**
- 全部新 DB 操作注册为 IPC handler
- import:openDialog 触发文件选择

**preload 扩展（src/preload/index.ts）**
- `window.veridian.creators.*`
- `window.veridian.tags.*`
- `window.veridian.collections.*`
- `window.veridian.import.openDialog()`

**UI 层（src/renderer/src/）**
- `MetadataTab.tsx`：完整字段编辑器（作者增删、type select、期刊/卷期页/出版社/DOI/URL/摘要），脏标记 + 手动 Save 按钮
- `TagsTab.tsx`：标签气泡增删，Enter 快速添加
- `DetailPane.tsx`：重构为 4 Tab（元数据/标签/附件/笔记）
- `CollectionPane.tsx`：用户分类新建/重命名（双击）/删除（hover ×）
- `collectionStore.ts`：Zustand 分类状态
- `ItemListPane.tsx`：右键菜单 → 移至废纸篓
- `Toolbar.tsx`：导入按钮 + 快捷键绑定（Ctrl+N / Ctrl+F）
- `App.tsx`：全局 Delete 键删除选中条目
- i18n 补全所有新增字符串（zh/en）

**验证**
- `tsc --noEmit`（node + web）：**零错误** ✅

### 下一步：Phase 2（目标 第7-10周）

- [ ] CSL 引用引擎（citeproc-js 集成）
- [ ] 引用格式选择（APA / MLA / GB/T 7714 等）
- [ ] 引用复制到剪贴板
- [ ] BibTeX / RIS / CSL-JSON 导出
- [ ] 附件管理（PDF 拖入、文件关联）
- [ ] PDF 内嵌阅读器（PDF.js）

### Phase 路线图

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | 脚手架、DB Schema、三栏 UI、IPC、i18n | ✅ 完成 |
| 1 | 完整 CRUD、分类管理、BibTeX 导入 | ✅ 完成 |
| 2 | CSL 引用引擎、格式导出 | 🔲 待开始 |
| 3 | 浏览器扩展 MVP（arXiv / Google Scholar / CNKI） | 🔲 待开始 |
| 4 | GitHub 仓库同步、冲突处理 | 🔲 待开始 |
| 5 | 插件 API + 沙箱 + 示例插件 | 🔲 待开始 |
| 6 | 性能优化、打包发布 | 🔲 待开始 |
