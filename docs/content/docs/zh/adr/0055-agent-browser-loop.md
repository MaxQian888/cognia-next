---
title: ADR-0055 — 智能体浏览器闭环
description: "给产品代理一个快照→按引用→重新快照的浏览器循环，覆盖现有的嵌入式/浏览器网页视图（导航、带稳定参考的无障碍树快照、click/type/fill/select/hover、控制台+网络检查、截图），作为门控插件工具公开。第一阶段通过注入的 JS驱动应用内嵌入式网页视图，用于共享的人类+代理面板;第二阶段是基于指导的——URL信任层路由器将公有来源标记为不受信任，并将模型引导到单独连接的Playwright MCP工具（mcp__playwright__*），以实现强大的公共站点自动化，因为渲染插件无法透明调用外部MCP工具。"
---

# ADR-0055 — 智能体浏览器闭环

**状态**：已接受（2026-06-25）**作者**钱马克斯+Claude

> **2026-07-18 附录**：ADR-0085取代了旧的第二阶段结论，即公共自动化只能作为Playwright MCP的指导。Cognia现在拥有cloud/headless会话`BrowserEngine`合同背后的`RemoteChromiumEngine`。Playwright MCP仍是一个独立的可选工具;Tauri `EmbeddedEngine`仍然是桌面本地主机的默认。

## 背景

应用内浏览器（`/browser`）作为一个被动、面向人类的设计反馈工具发布：它预览了本地开发服务器，允许用户点击一个元素以获取CSS选择器/`outerHTML`/文本，写下评论，并发送到聊天中。每一个浏览器操作都UI-only——代理无法在页面上导航、阅读或操作。该模型唯一的网页功能是单独的HTTP-only轨道（`web_fetch`/`web_search`，无JS渲染）和基于坐标的 OS `computer-use`，无法看到嵌入的网页视图DOM。

代理浏览器（Playwright-MCP、chrome-devtools-MCP 以及 Codex 自家应用内浏览器）的技术趋于一种共同的面向模型的设计：模型的主要“视图”是**结构化的无障碍树快照，而非像素**;元素被快照中生成的**不透明句柄（`ref` / `uid`）锁定，默认从不使用原始坐标;循环是**快照→按引用→重新快照**;控制台 + 网络是一流的只读工具。

## 决策

为代理添加`snapshot → act-by-ref → re-snapshot`浏览器循环，**混合且分阶段**：

- **第一阶段（本ADR）——嵌入式引擎。** 通过注入JS驱动现有嵌入式网页视图。这保留了共享的、人类可见的共驱动窗格（差异化因素），发布时间为0 MB，并且能在三种桌面OSes上运行。公共站点自动化仅是尽力而为。
- **第二阶段——对Playwright MCP的指导。** 重用现有的 `playwright-mcp` 预设（`plugins/playwright-mcp` 预设已存在）用于强健的任意公共站点自动化。这是基于指导的，不是第二引擎：渲染插件只能调用其_own_注册工具（`invokePluginTool`强制执行`tool.pluginId === pluginId`）;外部MCP的`mcp__playwright__*`工具存在于sidecar中，只能通过模型自身的工具调用循环访问，因此透明的进程委托不可行。信任层路由器会`untrusted`标记公有源，`browser_navigate`结果`hint`和`browser-tools:availability`上下文都会引导模型在连接该服务器时直接调用`mcp__playwright__*`。对预设完全没有额外影响。

共享视图的保真度和全 CDP 能力在 macOS/Linux 上是互斥的：驱动我们自己的嵌入式网页视图限制了我们的能力injected-JS但让人类参与进化;另一台 Chromium 无头提供全CDP功能，但不可见。第一阶段走嵌入式路径;第二阶段将公共站点的工作交给有回报的Playwright MCP。

## 建筑

```
agent tool call ──► plugins/browser-tools (registerTool ×N)
                        │  validates args, builds the call
                        ▼
                 lib/browser/agent-engine.ts ── routeEngine(urlTrustTier)
                    └─ EmbeddedEngine → browserClient → src-tauri/src/browser  [injected JS]
                         │
       (public origin) ──┴─► untrusted flag + hint ──► model calls mcp__playwright__*
                                                       (sidecar MCP, Phase 2 guidance)
```

- **信任层**（`resolveTrustTier`）：`localhost` / `127.0.0.1` / `::1` = **受信任→嵌入式面板**;任何其他`http(s)` = **public**。嵌入式引擎是唯一的进程内后端;对于公开起源，它以尽力而为并带有显式`untrusted`标志，模型则通过导航`hint`+可用性上下文被引导到`mcp__playwright__*`工具。
- **规范快照模式**（`lib/browser/protocol.ts`：`BrowserSnapshot`、`SnapshotNode`、`BrowserActionResult`、`ConsoleEntry`、`NetworkEntry`）由嵌入式引擎输出;Playwright MCP保持自身的原生快照形状，因此这两种接口是模型按层选择的不同工具族。

### → Rust频道

预览页面是一个没有IPC桥接的远程上下文。密钥启用器是Tauri 2.11.1 的 **`Webview::eval_with_callback`**，它将JS结果序列化为 JSON，并在三个引擎（WKWebView / WebView2 / WebKitGTK）上传递给Rust回调。`eval_embed_with_result`通过带有10秒超时的oneshot通道桥接了该回调到异步命令——因此旧的`cognia.invalid/__cognia_select`哨兵导航技巧不再是唯一的页面→Rust路径（仅保留给人类点击选择的UX）。在Windows上`eval_with_callback`吞噬异常，因此每个注入函数都会包裹其主体`try/catch`并返回错误值。

### 组成部分（第一阶段）

- `lib/browser/overlay.injected.js` — `__cogniaSnapshot()`（具有稳定 `data-cognia-ref` 的 a11y 树）、`__cogniaAct(ref, action, args)`（通过 React 控制输入的原生值设置器进行click/type/fill/select/hover），以及 `console.*` / `fetch` hook 被 `__cogniaDrainConsole` / `__cogniaDrainNetwork` 耗尽。
- `src-tauri/src/browser/embedded.rs` — `browser_embed_{snapshot,act,drain_console, drain_network,back,forward,stop,get_url,get_title}`。
- `lib/browser/client.ts` + `protocol.ts` — 直通类型 + 规范类型。
- `lib/browser/agent-engine.ts`——`BrowserEngine`，`EmbeddedEngine`，`routeEngine`。
- `plugins/browser-tools` — `browser_navigate`（+ `browser_back / forward / reload / stop`）、`browser_snapshot`、`browser_click / type / fill_form / select / hover`、`browser_wait_for`（文本appear/disappear，由注入`__cogniaHasText`
  + `browser_embed_has_text` 命令和引擎的轮询循环），`browser_screenshot`（PNG vision 回退——通过`lib/browser/pane-rect`单例发布的已验证的基于区域的`browser_embed_capture`，`browser_get_page`），`browser_read_console / read_network`，，通过`lib/plugin/core/browser-builtin-registry.ts`发现。
- `lib/claude/build-options.ts` — `browserAllowedForChat` 门禁，每个角色（`Character.enableBrowserTools`）选择加入，绝不在IM-bound会话中。
- `components/browser/browser-agent-indicator.tsx` + `lib/browser/agent-activity.ts` ——一个“Agent驾驶/你正在驾驶”的徽章，由渲染器侧的活动总线供电。

## 纪律与安全

- `snapshot → act → re-snapshot`：每个变异工具都会返回一个新的内联快照;参考文献带有`generation` ID。
- 方案允许列表仅保留 http（s）;`public`层被标记为`untrusted`（即时注入警告）;代理从不自动填充秘密。
- `browser_evaluate`（原始JS，RCE-class）在第一阶段被故意**不注册**——它将作为一个单独封闭、默认关闭的工具，后续操作。
- `browser_screenshot`重用已测试过的基于区域的`browser_embed_capture`（即人工选择→聊天流已依赖的`compute_embed_capture_region`几何），而非重新推导捕获边界：面板将其保留区域矩阵发布到`lib/browser/pane-rect`单例，引擎捕获该矩阵。这是一个愿景回退——模型设计上基于结构快照工作。

## 诚实第一阶段限制（injected-JS上限）

1. 跨源i帧对快照/控制台/网络/行为来说是不可见的。
2. 合成事件`isTrusted:false` →剪贴板/文件选择器/一些反机器人流程会拒绝它们。
3. 网络响应**身体**不可用（仅限status/timing）。
4. 闭合阴影DOM无法触及;开放阴影DOM需要明确穿透。

这些限制对于主要本地主机用例来说足够强大，正是Playwright MCP修复的——这也是为什么公共起源会引导到这些。它们作为明确的限制性呈现给模型，而非无声的空白。

## 后果

- 该代理现在可以自我验证，并在与人类观看的同一窗格中驱动本地开发预览——弥补了之前浏览器功能中最大的空白。
- 公共站点自动化以零额外占用的重用现有Playwright MCP预设;模型通过信任层级切换工具族，而非主机透明地交换引擎（渲染插件无法做到）。
- 实时Webview评估桥接器（`eval_with_callback`）无法通过JEST或cargo单元测试覆盖;手动门禁 `pnpm tauri dev`一次快照→点击→快照循环的烟雾。

## 附录（2026-06-27）——DOM工具覆盖轮

为弥补第一阶段工具接口的实际空白所做的外科手术性补充（所有这些都在同一个嵌入式引擎/信任层路由器之后）：

- **`browser_press_key`** — 命名调（Enter/Tab/Escape/Arrow*/Backspace/Delete/ Home/End/PageUp/PageDown/F1–F24）和和弦（`ctrl+a`、`shift+Tab`）通过JS和弦解析器映射Rust `keymap`词汇。可选`ref`目标;默认为焦点元素。文本输入仍使用`browser_type`。
- **`browser_click` 修饰键** — 修饰键点击的可选`modifiers: ["ctrl","shift",…]`。
- **`browser_scroll`** — 按`ref`（滚动视图）或页面`direction`（up/down/left/right/top/bottom）+ 可选`amount`。
- **`browser_evaluate`** — 评估一个JS*表达式*，返回一个JSON `{ok,value}`信封（新`browser_embed_evaluate` Tauri 命令包裹现有`eval_embed_with_result`，结果上限为200 KB）。**信任门槛**：在公共来源被拒绝（插件工具检查`resolveTrustTier`），引导到Playwright MCP。
- **`browser_wait_for`变体**——现在除了文本外，还会等待CSS `selector`（appear/disappear）或`networkIdle`（飞行中+完成计数器，由新的待定追踪器fetch/XHR输入）。
- **快照丰富度** — `buildSnapshot`现在下降开放影子DOM和同源i帧（帧起点节点携带`frame:true`），并`includeText` 接口显著非交互文本（headings/list项/...）选择加入。受深度+节点上限限制。

新的只读Tauri 命令：`browser_embed_has_selector`，`browser_embed_network_state`。仍然延迟（下一阶段）：multi-tab/popup编排、拖放、文件上传、cookie/storage/header访问，以及closed-shadow-DOM/跨源i帧限制（未变——Playwright MCP）。

## 附录（2026-06-27）——接口指导

计算机使用插件现在注册`computer-use:surface-guidance`上下文提供商，因此模型选择了合适的族群：`computer_use`/`click_text`用于原生应用和任意界面，`browser_*`用于本地主机预览，`mcp__playwright__*`用于公共网站，`web_fetch`/`web_search`用于只读内容。

## 附录（2026-07-08）——导航与信任硬化轮

针对现实世界公共网站浏览和自动化正确性的修复：

- **方案转义关闭。** `on_navigation`用于允许任何非 http（s） 方案继续（仅 sentinels 和 http（s） 被分类）。远程页面重定向至 `file://` / 自定义协议时将被 **block**;`about:`文档仍被允许。纯`classify_navigation`处置为单元测试。
- **原生navigate/reload。** `browser_embed_navigate`，`browser_embed_create`的重新导航路径，`browser_embed_reload`使用`Webview::navigate` / `Webview::reload`代替评估`location.assign`——即使当前页面的JS上下文破损、空白或阻塞，导航依然有效。
- **弹窗出现在视野中。** 覆盖层覆盖`window.open`（返回延迟弹窗模式的导航窗口存根），并将锚点点击（气泡阶段，尊重`defaultPrevented`）重`target="_blank"`写为相同视图导航——公共网站上的链接不再是死胡同。
- **SPA URL追踪。** pushState/replaceState/popstate/hashchange通过第二个哨兵（`/__cognia_nav`，去退票150毫秒）报告新URL，该哨兵Rust以`browser://navigated`重新发射——面板的地址栏和`paneId` 载荷在客户端路由应用中保持准确。
- **Live-URL信任门控。** `browser_evaluate`（以及`browser_navigate`上的`untrusted`标志）现在解析了页面的**live**URL（`getPage()`）中的信任层，而非模型最后请求的URL——localhost页面重定向到公共源节点时会立即失去`trusted`。当当前的节点无法读取时，默认拒绝到最后已知的URL。
- **加载稳定快照。**新`EmbeddedEngine.waitForLoad`（URL + `readyState`轮询，容忍中途评估失败）。`browser_navigate`等待目标文档;每个变异工具在其内联快照前都会稳定（3秒上限），因此点击触发导航返回所生成的页面;back/forward/reload增加250毫秒初始延迟，使旧文档的`complete`无法满足检查。
- **地址栏 https default。** `normalizePreviewUrl`默认裸公共主机`https://`（local/private主机——回环、RFC-1918、`.local`——保持`http://`），通过新的`isLocalHostname`助手。
