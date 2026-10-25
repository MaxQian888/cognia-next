# 浏览器提交信号实测（ADR-0239 第二期 WP10）

| 项目     | 内容                                                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日期     | 2026-10-25，Asia/Shanghai                                                                                                                                                                                                  |
| 目的     | 回答 [第二期计划](../plans/2026-10-25-adr-0239-phase-2.md) WP10：四种浏览器引擎上，agent 的动作造成的提交能否在发出前被看见并挂起，挂起靠什么机制，误判与漏判在哪里                                                        |
| 环境     | macOS 26（Darwin 25.5），Playwright 1.63.0，Chromium 153.0.8010.12（rev 1243），Playwright WebKit 26.6（rev 2359），cognia-browser-extension HEAD `0deecc0`                                                                |
| 实测脚本 | [`2026-10-25-browser-submit-signal/`](./2026-10-25-browser-submit-signal/)：`fixtures.mjs`（两个源的夹具服务器）、`run-playwright.mjs`、`run-extension.mjs`、`run-block.mjs`、`run-refuse.mjs`、`summarize.py`、`results/` |
| 结论     | 本地 Chromium、远程 Chromium **可靠**（`context.route` + `routeWebSocket`）；内嵌 webview **部分**；扩展引擎在现有权限下 **部分**，只有加 `debugger` 权限才对 HTTP 可靠。动作前判定在所有引擎上只能作提示                  |

## 1. 结论一览

| 引擎                      | 结论                                  | 机制                                                                                                                                                                | 主要漏判                                                                                              |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 本地 Chromium             | **可靠**                              | 在本地 context 上加 `context.route("**/*")` 挂起非 GET 请求，`context.routeWebSocket` 挂起 WebSocket 帧；拒绝用 `fulfill({ status: 204 })`                          | GET 携带数据（表单 GET、`location.href`、图片、fetch GET）                                            |
| 远程 Chromium             | **可靠**                              | 同上；已有 `context.route("**/*", authorizeRoute)`（`services/workspace-runtime/src/browser-service.mjs:707`），在其中加挂起分支，另加 `routeWebSocket`             | 同上                                                                                                  |
| 内嵌 webview              | **部分**                              | 注入脚本能看见并延后主文档里的 submit、`form.submit`、fetch、XHR、beacon、WebSocket 与 Navigation API 导航；但只装在主框架，页面可绕过，worker 与 `<a ping>` 看不见 | worker、`<a ping>`、图片 GET、跨源 iframe、同源子框架取来的 `fetch`                                   |
| 扩展引擎（现有权限）      | **部分**                              | 同内嵌 webview 的注入方式（MAIN world、`document_start`、`all_frames`），有 `request-mocks.ts` 先例；`webRequest` 只能观察，`declarativeNetRequest` 只能拦不能挂起  | 同内嵌 webview（`all_frames` 可补上框架）                                                             |
| 扩展引擎（加 `debugger`） | 对 HTTP **可靠**，对 WebSocket **无** | `chrome.debugger` + `Fetch.enable` 挂起全部非 GET HTTP（含 worker、ping）；跨源 iframe 需 `Target.setAutoAttach({ flatten: true })`                                 | WebSocket 帧；且要新权限、Chrome 会显示“正在调试此浏览器”提示条，ADR-0228 §6 拒绝依赖 debugger 的功能 |
| 动作前判定（任何引擎）    | **部分**，只作提示                    | 看目标元素与动作：提交控件、表单内的 Enter、`contenteditable` 的组合键                                                                                              | 所有由页面脚本发出的发送（SPA 按钮、XHR、beacon、WebSocket、延时 `form.submit`）                      |

## 2. 方法

夹具服务器起两个源：A = `http://127.0.0.1:4811`、B = `http://localhost:4812`（跨源用例是真跨源）。每个场景的请求都带 `s=<id>`，服务器日志就是“到底发出了什么”的标准答案，WebSocket 帧也记入日志。每个场景在新的 context 上分别测：

- **truth**：不拦截，只看服务器收到什么；同时在动作前跑一次判定函数（`CLASSIFY`，按目标元素与动作推断“会不会提交”）。
- **route**：`context.route("**/*")` 把非 GET 请求挂起 300 ms 再放行，`context.routeWebSocket` 把每一帧挂起 300 ms；记录看见了什么，服务器到达时间 ≥ 315 ms 即证明挂起生效。
- **inject-early**：拦截脚本经 `addInitScript` 在页面脚本之前装进每个框架。
- **inject-early-main**：同上但只装在主框架，模拟 Tauri `initialization_script`（`src-tauri/src/browser/embedded.rs:357-358`）。
- **inject-late**：页面加载后再经 `evaluate` 装进当时存在的框架，模拟按需注入（扩展的 `chrome.scripting`）。
- **inject-hold**：早装，并把看见的每次发送延后 300 ms（submit 用 `preventDefault` + `requestSubmit(submitter)` 重放，`form.submit` 延后调用，push 导航用 Navigation API 的 `preventDefault` 后重新导航）。
- **route-abort** 与 `run-refuse.mjs`：比较中止（`abort`）与空响应（`fulfill 204`）两种拒绝方式。

拦截脚本覆盖：捕获阶段的 `submit` 事件、`HTMLFormElement.prototype.submit` / `requestSubmit`、`fetch`、`XMLHttpRequest`、`navigator.sendBeacon`、`WebSocket.prototype.send`、Navigation API 的 `navigate` 事件。上报经 `exposeBinding`，提交造成的导航不会丢日志。

动作分两类：Playwright 的可信输入（本地与远程 Chromium 的 `act` 就是这样，`browser-service.mjs:1445-1494`），以及合成 DOM 事件（内嵌 webview 与扩展用 `lib/browser/overlay.injected.js` 的 `performAct`：`dispatchEvent(new MouseEvent("click"))`、合成 `KeyboardEvent`、`setValue` + `input`/`change`）。

扩展引擎由 `run-extension.mjs` 以 `--load-extension` 加载一个 MV3 测试扩展（`ext/`），在同一组场景上测 `chrome.debugger` 的 `Fetch.enable`（可选 `Target.setAutoAttach` flatten）与 `webRequest` 观察；`run-block.mjs` 加载声明 `webRequestBlocking` 的扩展（`ext-block/`）测能否取消请求。

复跑：

```bash
node docs/research/2026-10-25-browser-submit-signal/run-playwright.mjs chromium > docs/research/2026-10-25-browser-submit-signal/results/chromium.json
```

```bash
node docs/research/2026-10-25-browser-submit-signal/run-playwright.mjs webkit > docs/research/2026-10-25-browser-submit-signal/results/webkit.json
```

```bash
cd docs/research/2026-10-25-browser-submit-signal && python3 summarize.py chromium webkit
```

`ONLY_BYPASS_MAIN=1` 只跑绕过页的主框架注入（`results/bypass-main-*.json`）；`run-extension.mjs`、`run-block.mjs`、`run-refuse.mjs` 各自直接运行。

## 3. 场景与实测矩阵

表中 route 列：`H` = 被挂起（非 GET），`s` = 看见但按 GET 放行。注入列是拦截脚本看见的钩子；`—` 表示一个也没看见。挂起列是 inject-hold 下服务器的首次到达时间（ms）。Chromium 153 与 WebKit 26.6 的结果除注明处外一致。

| 场景 | 内容                                     | 实际发出              | 判定     | route                    | 早装（全部框架）      | 早装（仅主框架） | 晚装             | 挂起 ms |
| ---- | ---------------------------------------- | --------------------- | -------- | ------------------------ | --------------------- | ---------------- | ---------------- | ------- |
| s1   | 表单 POST，点提交按钮                    | POST /submit          | 是       | H document               | submit, navigate      | 同左             | 同左             | 358     |
| s2   | 表单 GET（搜索）                         | GET /search           | 是       | s document               | submit, navigate      | 同左             | 同左             | 657     |
| s3   | SPA：`type=button` + fetch POST          | POST /api             | 否       | H fetch                  | fetch                 | 同左             | 同左             | 340     |
| s4   | `div role=button` + XHR POST             | POST /api             | 否       | H xhr                    | xhr                   | 同左             | 同左             | 340     |
| s5   | 表单输入框按 Enter（可信）               | POST /submit          | 是       | H document               | submit, navigate      | 同左             | 同左             | 326     |
| s6   | 表单输入框按 Enter（合成）               | **无**                | 是 ✗     | 无                       | —                     | —                | —                | —       |
| s7   | 提交按钮，合成 `MouseEvent` click        | POST /submit          | 是       | H document               | submit, navigate      | 同左             | 同左             | 325     |
| s8   | 按钮 + `sendBeacon`                      | POST /beacon          | 否       | H ping（WebKit：beacon） | beacon                | 同左             | 同左             | 357     |
| s9   | 按钮 + WebSocket send                    | WS 帧                 | 否       | H WS 帧                  | ws.send               | 同左             | 同左             | 333     |
| s10  | 跨源 fetch POST                          | B POST /api           | 否       | H fetch                  | fetch                 | 同左             | 同左             | 338     |
| s11  | `contenteditable` Cmd/Ctrl+Enter（可信） | POST /api             | 可能     | H fetch                  | fetch                 | 同左             | 同左             | 324     |
| s11b | 同上（合成）                             | POST /api             | 可能     | H fetch                  | fetch                 | 同左             | 同左             | 336     |
| s12  | fetch GET 携带数据                       | GET /api?q=secret     | 否       | s fetch                  | fetch                 | 同左             | 同左             | 357     |
| s13  | 页内锚点链接 + 统计 beacon               | POST /beacon          | 否       | H ping                   | beacon, navigate      | 同左             | 同左             | 353     |
| s14  | 点击后 1.5 s 延时 `form.submit()`        | POST /submit          | 否       | H document               | form.submit, navigate | 同左             | 同左             | 1836    |
| s15  | 按钮 → dedicated worker fetch POST       | POST /api             | 否       | H fetch                  | —                     | —                | —                | 54 ✗    |
| s16  | 跨源 iframe 里的表单 POST                | B POST /submit        | （框架） | H document               | submit, navigate      | **—**            | submit, navigate | 359     |
| s17  | 图片像素 GET 携带数据                    | GET /pixel?d=secret   | 否       | s image                  | —                     | —                | —                | 36      |
| s18  | `location.href` 导航 GET 携带数据        | GET /search?q=secret  | 否       | s document               | navigate              | 同左             | 同左             | 338     |
| s19  | `<a ping>` 链接                          | POST /ping + GET 导航 | 否       | H ping，s document       | navigate（无 ping）   | 同左             | 同左             | 36 ✗    |
| s20  | `select` 改值自动提交表单                | POST /submit          | 否       | H document               | form.submit, navigate | 同左             | 同左             | 331     |
| s21  | 填写自动保存的输入框（input → fetch）    | POST /api             | 否       | H fetch                  | fetch                 | 同左             | 同左             | 331     |
| s22  | 无副作用的按钮                           | 无                    | 否       | 无                       | —                     | —                | —                | —       |
| s23  | 表单外的 `type=submit` 按钮              | 无                    | 否       | 无                       | —                     | —                | —                | —       |

要点：

- **合成事件的两面**：合成 Enter（s6）不触发隐式提交，但合成 click 落在提交按钮上（s7）照常提交，页面自己监听的合成组合键（s11b）照常发送。内嵌 webview 与扩展的 `press_key` 发出合成事件，所以“表单里按 Enter”在这两个引擎上本来就不会提交；判定函数对 s6 给出“是”属于误判。
- **route 挂起了每一个非 GET**：表单 POST（含可信 Enter、合成点击、`select` 自动提交、延时 1.8 s 的 `form.submit`）、fetch、XHR、`sendBeacon`（Chromium 资源类型为 `ping`，WebKit 为 `beacon`）、`<a ping>`、dedicated worker 的 fetch、跨源 iframe 的表单。`routeWebSocket` 挂起了 WebSocket 帧。两个引擎的 route 结果完全一致。WebKit 下 s15 另有一次 worker 脚本的 GET（blob），按 GET 放行。
- **GET 不被挂起**：s2、s12、s17、s18 的数据都在 URL 里发出。这是按方法挂起的固有漏判（见 §5）。
- **WebKit 26.6 有 Navigation API**：主框架注入能在两个引擎上看见表单与 push 导航的 `navigate` 事件，且这些导航可取消。

### 3.1 绕过页（只对注入有意义）

| 场景 | 内容                                                           | 早装（全部框架）      | 早装（仅主框架）   | 晚装                    |
| ---- | -------------------------------------------------------------- | --------------------- | ------------------ | ----------------------- |
| b1   | 从预先存在的空 iframe 取 `fetch` 再调用                        | fetch                 | **—**              | fetch                   |
| b2   | 用 iframe 的 `HTMLFormElement.prototype.submit` 提交主文档表单 | form.submit, navigate | navigate（仍看见） | form.submit, navigate   |
| b3   | 页面先存下 `window.fetch`，之后调用                            | fetch                 | fetch              | **—**                   |
| b4   | 页面在捕获阶段注册 `submit` 监听并 `stopImmediatePropagation`  | submit, navigate      | submit, navigate   | navigate（submit 丢失） |
| b5   | 点击时新建 iframe 并取它的 `fetch`                             | fetch                 | **—**              | **—**                   |

- 晚装能被“先存原生函数”（b3）与“临时新建框架”（b5）绕过；只装主框架能被任何同源子框架的原生函数绕过（b1、b5）。
- 主文档的导航（b2、b4）总能被主框架的 Navigation API 兜住；兜不住的是不导航的发送（fetch / XHR / beacon / WebSocket）。

### 3.2 扩展引擎

| 场景                                                                       | `chrome.debugger` + `Fetch.enable` | 加 `Target.setAutoAttach`（flatten） | `webRequest` 观察 |
| -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------ | ----------------- |
| 表单 POST / Enter / 合成点击 / `select` / 延时提交（s1、s5、s7、s14、s20） | 挂起                               | 挂起                                 | 看见              |
| fetch / XHR / 跨源 / 组合键 / 自动保存（s3、s4、s10、s11、s11b、s21）      | 挂起（资源类型 XHR）               | 挂起                                 | 看见              |
| beacon / `<a ping>`（s8、s13、s19）                                        | 挂起（Ping）                       | 挂起                                 | 看见              |
| worker fetch（s15）                                                        | 挂起                               | 挂起                                 | 看见              |
| 跨源 iframe 表单（s16）                                                    | **未挂起**（到达 68 ms）           | 挂起（子会话，381 ms）               | 看见              |
| WebSocket 帧（s9）                                                         | **看不见**                         | **看不见**                           | 只看见握手        |
| GET（s2、s12、s17、s18）                                                   | 暂停后放行                         | 同左                                 | 看见              |

- 声明 `webRequestBlocking` 的未打包 MV3 扩展（`run-block.mjs`）：监听器注册时不报错（结果记为 `accepted`），但返回 `{ cancel: true }` 无效，请求照常到达服务器。MV3 只有按策略安装的扩展才能阻塞 `webRequest`，对我们不可用。
- `declarativeNetRequest` 只有静态或动态的拦截 / 重定向规则，没有“暂停等待决定”的能力（文档结论，未实测）。它能在拒绝后封住一个源，但不能挂起一个请求等人批准。
- 现有扩展权限：sidePanel、storage、activeTab、scripting、contextMenus、alarms、tabGroups；没有 webRequest、debugger、declarativeNetRequest。动作经 `chrome.scripting` 注入 ISOLATED world（`executor.ts:317`），`page-hooks` 注入 MAIN world。`src/lib/inspect/request-mocks.ts` 已在 MAIN world、`document_start` 经 `registerContentScripts` 包裹 fetch / XHR / `sendBeacon`（含延时规则），是注入式挂起的现成先例。

## 4. 拒绝方式

| 用例                   | `abort`                                                    | `fulfill({ status: 204 })` |
| ---------------------- | ---------------------------------------------------------- | -------------------------- |
| s1 表单 POST，Chromium | 页面变成 `chrome-error://chromewebdata/`，agent 丢失原页面 | 留在原页面，表单仍在       |
| s1 表单 POST，WebKit   | 留在原页面                                                 | 留在原页面                 |
| s20 `select` 自动提交  | —                                                          | 两个引擎都留在原页面       |
| s3 fetch POST          | 两个引擎 fetch 以 `TypeError` 拒绝，页面不变               | —                          |

结论：拒绝导航类提交用 `fulfill 204`（HTTP 规定 204 不导航，页面保持原样，agent 可以继续读页面并收到拒绝原因）；拒绝 fetch / XHR / beacon 用 `abort`（页面脚本看到网络错误，与断网一致）。

## 5. 误判与漏判样例

**误判（把不是用户意图中的“提交”挂起或判为提交）**：

- s13：点页内锚点链接，页面顺带发统计 beacon，被当成一次 POST 挂起。
- s21：填写输入框触发自动保存 POST，被当成提交（对“发给第三方”而言它确实是发送，但用户心里通常不算“提交”）。
- 后台遥测：动作窗口里页面定时发的 POST（心跳、埋点）会落进窗口被挂起。WP12 只把动作窗口内的非 GET 算作该动作的提交，窗口外的照常放行并在影子报告里单列。
- CORS 预检 `OPTIONS`：不是提交。本次的跨源用例（s10，`text/plain` 请求体）是简单请求，不产生预检，所以未测到；WP12 应显式把 `OPTIONS` 排除，只规划随后的实际请求。
- 动作前判定：s6 判为“是”但实际没提交；s23 表单外的提交按钮正确判为“否”。

**漏判（真的发出了数据却没被挂起）**：

- 所有引擎：GET 携带数据（s2 表单 GET、s12 fetch GET、s17 图片像素、s18 `location.href`）。按方法挂起时这是固有漏判；把 GET 也挂起会让每次翻页都询问，不可行。ADR 已知缺口里写明。
- 扩展 `debugger`：WebSocket 帧（s9），跨源 iframe 不开 auto-attach 时（s16）。
- 注入（内嵌 webview、扩展现有权限）：worker（s15）、`<a ping>`（s19）、图片 GET（s17）；只装主框架时的跨源 iframe（s16）与同源子框架取来的原生函数（b1、b5）；晚装时的 b3、b5、b4 的 submit 事件。
- 动作前判定：所有页面脚本发出的发送（s3、s4、s8、s9、s10、s14、s15、s20、s21）。

## 6. 注意事项

- Playwright 的 WebKit 不是系统 WKWebView：内嵌 webview 在 macOS 上用 WKWebView，在 Windows 上用 WebView2。本次的注入结论（脚本能做什么、能被怎样绕过）与引擎无关，可以迁移；平台网络层的能力只按文档判断，未实测：WebView2 的 `WebResourceRequested` 支持延迟（deferral）决定，WKWebView 没有挂起子资源请求的 API，Tauri 的 `on_navigation`（`embedded.rs:359`）只能按 URL 取消顶层导航，看不到方法与表单体。
- Tauri 2.9 有 `initialization_script_for_all_frames`，可把注入扩展到子框架，补上 s16、b1、b5 中的跨框架部分，但仍补不上 worker 与 ping。
- 未测 service worker 发起的请求：Playwright 文档写明被 service worker 接管的请求不经 `context.route`，可用 `serviceWorkers: "block"` 关掉 service worker。WP12 实施时补一个 service worker 夹具，确认后再决定 agent 控制的 context 是否禁用 service worker。
- 挂起期间页面脚本仍在运行，延时 300 ms 未引起任何页面错误；长时间挂起（等人批准）时，页面的 fetch 超时由页面自己决定，最终表现为网络错误或页面重试。
- 扩展加 `debugger` 是产品决定（新权限、Chrome 的调试提示条、ADR-0228 §6），不在本计划内默认采用。

## 7. 对 WP11–WP12 的建议

1. **目标**：可靠引擎以被挂起请求的 URL origin 为 `siteTarget`；“可能提交”分支以动作时的页面 origin 为目标，由引擎取（本地 / 远程 `page.url()`，内嵌 `browser_embed_get_url`，扩展 `tab.url`），不信任 agent 输入。跨源 iframe 里的提交（s16）目标是 iframe 表单的 action origin，不是顶层页面。
2. **本地 Chromium**：在 `launchLocalContext`（`browser-service.mjs:813-869`）建好的 context 上加与远程相同的 route，以及 `routeWebSocket`；两条路径共用一个挂起函数。
3. **远程 Chromium**：在 `authorizeRoute`（`browser-service.mjs:1085-1093`）中加挂起分支，另加 `routeWebSocket`。
4. **挂起范围**：动作开始到动作结束后一段宽限期（实测延时提交在 1.8 s 到达，宽限期取 3 s）内、由该页面发出的非 GET、非 `OPTIONS` 请求与 WebSocket 帧，算作该动作的提交；窗口外的请求放行，影子模式下记作“后台”。同一动作窗口里同一 origin 只规划一次。
5. **拒绝**：导航类（资源类型 document）用 `fulfill 204`，其余用 `abort`；拒绝后把 origin 记进该请求的拒绝集合，告诉 agent 原因。
6. **内嵌 webview 与扩展（现有权限）**：执行模式下按“可能提交”处理：对未授权站点的 `browser_click`、`browser_type`、`browser_press_key`、`browser_fill_form`、`browser_select`、`browser_drag` 先规划再执行；不把注入脚本当作可靠信号。注入可以作为后续增强（减少询问次数），不在 WP12 范围。
7. **扩展 `debugger` 权限**：不采用，除非用户决定改变 ADR-0228 §6；WP12 开工前确认一次。
8. **界面与 ADR**：在 ADR 与设置卡片上标明哪些引擎是“挂起实际请求”，哪些是“按动作询问”，以及 GET 携带数据不在挂起范围内。
