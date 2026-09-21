# 插件系统 v0 + 划词翻译插件

目标：MD 阅读器里选中文字 → 选区旁出现浮标 → 点击后流式显示译文。翻译由**插件**提供，插件自带 API 配置，运行在独立 Worker 线程里。

范围：插件宿主（发现、清单、沙箱、联网转发、配置存储）+ 一个扩展点（阅读器选区动作）+ 内置翻译插件 + 设置页「插件」标签页。

不做：插件安装/市场、PDF 阅读器划词、其他扩展点（条目右键菜单等）、热重载。

## 1. 插件形态

目录：`<id>/manifest.json` + `index.js`。内置插件在 `resources/plugins/`（extraResources 打包），用户插件在 `userData/plugins/`。只扫这两处。

`manifest.json`：

```json
{
  "id": "translate",
  "name": "划词翻译",
  "version": "0.1.0",
  "main": "index.js",
  "network": [],
  "contributes": { "selectionActions": [{ "id": "translate", "title": "翻译" }] },
  "config": [
    { "key": "baseURL", "label": "Base URL", "type": "url", "required": true },
    { "key": "apiKey", "label": "API Key", "type": "password", "required": true },
    { "key": "model", "label": "模型", "type": "text", "required": true },
    { "key": "targetLang", "label": "目标语言", "type": "text", "default": "中文" }
  ]
}
```

`config[].type` ∈ `text | password | url | select`。

联网白名单 = `network` 里写死的域名 ∪ 该插件所有 `url` 类配置值的主机名。清单是插件作者写的，所以 `network` 里**不允许写本机地址**（`localhost`、`127.*`、`0.0.0.0`），否则插件能调用本机任意服务（含 Veridian 自己的 `localhost:23120`）；本机服务（如 Ollama）只能由用户自己在 `url` 配置里填。

插件可用接口（Worker 内全局 `veridian`）：
- `veridian.onSelectionAction(actionId, async ({ text, config, signal, output }) => void)`：`output(text)` 向气泡追加文本（每次运行各有自己的 `output`，互不串）
- `veridian.fetch(url, init)`：宿主转发，返回可流式读取的 Response；请求体只支持字符串

## 2. 宿主

主进程 `src/main/plugin-host/`：
- `manifest.ts`：zod 校验清单；非法清单跳过并记日志。
- `discover.ts`：扫描两个目录，返回已校验的插件列表。
- `pluginAssets.ts` + `veridian-plugin://<id>/host.html|host.js` 协议：提供沙箱宿主页，响应头带 `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'none'`。
  - 为什么不直接从该协议加载 Worker：Worker 脚本必须与创建它的页面同源，自定义协议是另一个源，`new Worker('veridian-plugin://…')` 会被拒绝。
  - 做法：渲染进程放一个隐藏的 `<iframe sandbox="allow-scripts" src="veridian-plugin://<id>/host.html">`；iframe 里的 `host.js` 收到插件源码后用 Blob 创建 Worker。Blob Worker 继承 iframe 文档的 CSP，于是 `fetch` / XHR / WebSocket / `importScripts` / 动态 `import()` 全被拦。
- `relay.ts`：`plugin:fetch` 转发。校验主机在白名单内、只允许 https（用户自己填的 loopback 地址除外）、超时 60s、响应体上限、支持流式回传与中止。
- `config.ts`：配置读写，键 `plugin.<id>.<key>`；`password` 类走 safeStorage 加密（扩展 `SettingsService` 的加密键判断，不再只认固定集合）；`plugin.<id>.enabled` 记录启用状态。
- IPC 通道：`plugin:list`、`plugin:getConfig`、`plugin:setConfig`、`plugin:setEnabled`、`plugin:fetch`（含流式事件与中止），在 `ipc-contract.ts` 用 zod 注册。

渲染进程 `src/renderer/src/plugins/`：
- `PluginRuntime.ts`：为每个启用的插件懒启动一个沙箱 iframe（内含 Worker），在 主窗口 ⇄ iframe ⇄ Worker 之间转发消息；维护请求 ID、流式回调、中止、90s 超时；停用时移除 iframe（Worker 随之终止）。
- Worker 引导脚本 `WORKER_PRELUDE` 与 iframe 脚本 `HOST_SCRIPT` 是 `src/shared/pluginRuntimeSource.ts` 里的字符串常量，Worker 里注入全局 `veridian`。
- `usePluginActions.ts`：返回当前所有启用插件贡献的选区动作。

## 3. 阅读器交互

`MarkdownViewer` 容器上监听 `mouseup`：选区非空且在容器内 → 在选区矩形旁显示 `SelectionBadge`，每个动作一个按钮。点击 → 在选区旁弹出 `ActionBubble`，调用 `PluginRuntime` 执行并流式显示。

气泡状态：加载中、输出中、出错、未配置（显示「去设置」，跳转到设置页插件标签页）。Esc 或点击外部取消并中止请求。选中文字上限 4000 字，超出时截断并在气泡提示。

浮标与气泡位置用已有的 `clampToViewport` 限制在窗口内。颜色全部用主题变量，深浅色都可用。

## 4. 设置页「插件」标签页

`SettingsPage` 新增 `plugins` 标签：列出插件（名称、版本、启用开关），配置表单由清单 `config` 自动生成，保存即写入 `plugin:setConfig`。i18n 文案加到 `i18n/index.ts` 的 zh 和 en。

## 5. 翻译插件

`resources/plugins/translate/`：OpenAI 兼容 `/chat/completions` 流式接口。系统提示词：翻译为目标语言，保留公式、代码和 Markdown 格式，只输出译文。解析 SSE，逐块 `veridian.output`。

## 6. 出错处理与测试

- 插件崩溃、超时、返回错误 → 气泡显示错误，阅读器不受影响。
- 纯逻辑单测：清单校验、白名单计算、转发校验（域名、协议、loopback）、配置键与加密判定。
- **首个任务是验证性 spike**（`scripts/verify-plugin-sandbox.cjs`，用 Electron 直接跑）：在「主页面 → 带 CSP 的沙箱 iframe → Blob Worker」这条链上，让 Worker 故意 `fetch` / XHR / WebSocket / `importScripts` / 动态 `import()` / EventSource / 嵌套 Worker 去访问本机的探针服务，确认全部被拦且探针零命中；同时跑一组**不带 CSP 的对照**，确认探针在没有 CSP 时确实能被命中（否则测试本身无效）。若拦不住，停下来重新商量沙箱方案，不继续往下做；备选是每个插件一个隐藏的、无 Node 的 BrowserWindow（独立进程）。
- 最后在真实应用里手动验证：配置 → 选字 → 浮标 → 流式译文 → 取消 → 停用插件。

## 任务顺序

1. Spike：CSP 拦截 Worker 直连。
2. 清单 schema 与校验 + 单测。
3. 发现与配置存储（含密码加密）+ 单测。
4. `veridian-plugin://` 协议。
5. 联网转发 `plugin:fetch`（含流式）+ 单测。
6. IPC 通道注册与 preload / `env.d.ts` 类型。
7. `PluginRuntime` 与 Worker 引导脚本。
8. 阅读器浮标与气泡。
9. 设置页「插件」标签页与 i18n。
10. 翻译插件。
11. 类型检查、lint（仅确认无新增）、全部测试；真实应用手动验证。
