---
title: "0201 — 桌面浏览器在本地运行 Chromium"
description: "桌面浏览器在内嵌 webview 之外新增两个 Chromium 后端：由 Cognia 管理、在本地回环地址上运行的本地 Chromium（即工作区运行时浏览器服务），以及通过 Chrome 自带的、需用户同意的远程调试连接到用户自己的 Chrome。在此之上：多标签浏览、下载管理器、Chrome 扩展、覆盖各桌面操作系统主流浏览器的 Cookie 导入、纯 Rust 实现且支持自动填充的密码库、本地文件与开发服务器发现，以及面向内置与外部 agent 的统一会话感知浏览器工具面。"
---

# ADR 0201 — 桌面浏览器在本地运行 Chromium

**状态：** 已接受
**日期：** 2026-09-29
**相关：** [ADR-0055](./0055-agent-browser-loop)（agent 浏览器循环）、[ADR-0072](./0072-browser-action-recording)、[ADR-0073](./0073-chromium-cookie-import)（Cookie 导入，本 ADR 对其做了修订）、[ADR-0085](./0085-cloud-shared-browser)（工作区运行时浏览器服务，本 ADR 复用）、[ADR-0154](./0154-browser-companion)（不变：伴随端扩展仍然从不驱动页面）、[ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked)（crate 归属）

## 背景

桌面端的浏览器是单个 WKWebView / WebView2 / WebKitGTK 子 webview。它
无法承载 Chrome 扩展（WKWebView 没有扩展运行时）、没有标签页、
没有下载处理器、没有原生输入、没有对话框或文件选择器钩子，只有一个
只支持两个方法的 CDP shim。Cookie 导入仅支持 macOS + Chromium + 单一宿主。
也没有密码导入。外部 agent 只能通过通用的 `plugin_tool_invoke` 访问内嵌浏览器，
而这条路径会跳过按角色的门控、按工具的审批以及会话绑定。

一个完整的 Chromium 浏览器服务已经存在：`services/workspace-runtime`
（Node + `playwright-core`）为云端（ADR-0085）实现了页面、带不透明引用的
快照、原生动作、对话框、上传、隔离下载、屏幕投送和持久化配置文件。
桌面端也已经内置了经过验证的 Node 运行时（`src-tauri/src/node_runtime.rs`）。

OpenAI 在 2026 年发布的桌面浏览器收敛到了同样的产品形态：独立配置文件、
多标签、下载、登录/自动填充/密码管理、Chrome 扩展、localhost 与
`file://`，以及第二条连接到用户自己 Chrome 的通道。

## 决定

### 一个 `BrowserEngine` 之下的四个桌面后端

| 后端 | 引擎 | 拥有 | 默认用于 |
| --- | --- | --- | --- |
| `embedded` | 平台 webview（不变） | 单个页面、注入的 JS | 轻量级 localhost 预览 |
| `local-chromium` | 回环地址上的工作区运行时服务，Chromium 来自 Playwright 的 Chrome-for-Testing 构建 | 标签页、下载、扩展、原生输入、对话框、上传、与云端完全对齐的快照 | 安装后用于所有公开网站；用户可选 |
| `user-chrome` | 同一服务，通过 `connectOverCDP` 连接到用户正在运行的 Chrome/Edge/Brave | 用户的真实配置文件、登录态和扩展 | 用户显式选择 |
| `remote` | ADR-0085 中的云端运行时（不变） | 云端 / 移动端 / 无头场景 | 非桌面宿主 |

`BrowserBackend`（TS）变为 `"embedded" | "local-chromium" | "user-chrome" | "remote" | "web-fallback"`。

### 本地 Chromium：由桌面端运行的运行时

- `services/workspace-runtime/src/local-main.mjs` 是第二个入口点，
  **只**承载 `RemoteChromiumService`（不含 `AgentSupervisor`），绑定
  `127.0.0.1` 的一个临时端口，从 stdin 读取 32 字节以上的密钥（从不通过
  argv/env），在 stdout 打印 `{"type":"ready","address":…}`，并运行在
  **local 模式**下：`mode: "local"` 启用了云端会拒绝的 `session.create`
  字段（`kind`、`headless`、`extensionPaths`、`cdpEndpoint`、
  `downloadsDir`、`uploadRoots`、`allowFileUrls`）。
- 新 crate `crates/cognia-local-browser`（层级为 `domain`，不依赖
  tauri，命令壳所需的 `tauri-host` feature 无需启用：壳层代码位于
  `src-tauri/src/browser/local.rs`）负责：进程监管（内置的 Node、
  带退避的重启、应用退出时终止）、回环 HTTP 客户端、Chromium 安装器
  （运行打包好的 `playwright-core` CLI，`PLAYWRIGHT_BROWSERS_PATH=<app_data>/browser/chromium`）、
  扩展商店，以及用户 Chrome 发现。
- 渲染进程永远看不到运行时的 URL 或密钥。每次调用都经过
  `browser_local_rpc(op, payload)`，其 op 白名单排除了携带敏感值的
  op（`browser.cookies.set`、`browser.credential.fill`）；只有 Rust
  会发出这些调用。
- 画面帧：Rust 轮询 `/v1/media/:session`，并通过 Tauri 的
  `Channel<Vec<u8>>` 推送既有的 24 字节帧头 JPEG，因此
  `decodeRemoteBrowserFrame` 和远程画布预览无需改动即可复用。
- 事件：Rust 追踪 `/v1/events` 并重新以 `browser-local://event` 的形式
  发出（`pages.changed`、`download.updated`、`dialog.opened`、
  `session.closed`）。
- 配置文件：一个持久化的 Cognia 配置文件位于
  `<app_data>/browser/profiles/default`（允许命名配置文件），与 Cognia
  自身 webview 的数据分离。
- 打包：`scripts/build/stage-browser-runtime.mjs` 在
  `predev`/`prebuild` 阶段把运行时源码、共享的注入覆盖层以及
  `playwright-core` 复制到 `src-tauri/resources/browser-runtime/`。

### 用户自己的 Chrome

Chrome 144+ 允许用户在 `chrome://inspect/#remote-debugging` 为正在运行的
浏览器开启远程调试；此后 Chrome 会把 `DevToolsActivePort` 写入用户数据
目录，并**要求用户为每次新连接单独放行**。
`cognia-local-browser::user_chrome::discover()` 会读取 Chrome、
Chrome Beta/Canary、Edge、Brave（各操作系统对应路径）的该文件，
运行时随后用 `connectOverCDP` 建立连接。Cognia 从不以调试参数启动
用户的浏览器，从不复制其配置文件，也从不持久化该端点。Agent 的标签页
在独立窗口中打开；`finalize` 会关闭 agent 创建的标签页，不动用户的
标签页。若该文件不存在，发现结果会带有
`reason: "remote_debugging_disabled"`，界面会引导用户前往对应的
Chrome 设置项。

### 下载

- 本地/用户 Chromium：每次下载都会被追踪进度
  （`download.updated` 事件：`in_progress → completed | cancelled | failed`），
  保存到用户的下载目录（可配置，可选“询问保存位置”），文件名做防
  冲突处理。相关 op：`browser.download.cancel`、
  `browser.download.delete`、`browser.download.save`（复制到指定路径）。
  云端沿用 ADR-0085 的隔离语义。
- 内嵌：`WebviewBuilder::on_download` 把下载路由到同一个下载目录，
  并发出 `browser://download`（`requested`、`finished`）。
- 渲染进程：Dexie 表 `browserDownloads`（历史记录，不存字节），一个
  下载面板（进度、取消、打开、在文件夹中显示、重试、从列表移除、
  清空），一个工具栏徽标，以及“附加到聊天”。`BrowserDownloadSummary`
  新增 `url`、`mimeType`、`totalBytes`、`receivedBytes`、`startedAt`、
  `finishedAt`、`savedPath`、`error`、`backend` 字段，以及状态
  `in_progress | completed | cancelled | failed | quarantined | saved | attached`。

### Chrome 扩展（本地 Chromium）

- 存储：`<app_data>/browser/extensions/<id>/` 下的解包目录 +
  `registry.json`（id、名称、版本、是否启用、来源
  `webstore|crx|unpacked`、安装时间、权限、host 权限、图标、
  action 弹窗与选项页路径）。
- 安装方式：通过 id 或 URL 从 Chrome 网上应用店安装（从公开更新端点
  下载 CRX、校验声明 id 的 CRX3 头、带路径穿越防护的 zip 解压），
  从 `.crx` 文件安装，或从解包目录安装（会被复制，绝不原地引用）。
  更新检查复用同一端点。支持启用/禁用/删除。
- 启动：已启用的扩展会以 `--disable-extensions-except` /
  `--load-extension` 传入，服务会在变更时重启存活的会话
  （`browser.extensions.reload`）。headless-new 模式的 Chromium 可以
  运行 MV3 service worker 和 content script；action 弹窗和选项页以
  标签页形式打开（`browser.extension.open`）。
- 内嵌后端与 `user-chrome` 都不加载 Cognia 的扩展集：内嵌 webview
  做不到（类型化错误 `extensions_unsupported_backend`），而用户的
  Chrome 已经有自己的扩展。

### Cookie 导入（修订 ADR-0073）

| 来源 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Chrome、Edge、Brave、Chromium、Arc、Vivaldi、Opera | 钥匙串 Safe Storage，v10 AES-128-CBC | DPAPI 解包的 `os_crypt.encrypted_key`，v10/v11 AES-256-GCM；**v20 App-Bound 记录会被跳过并计数**（`app_bound_encryption`） | v10（`peanuts`）与 v11（通过 `secret-tool` 使用 Secret Service）AES-128-CBC |
| Firefox（所有配置文件） | 明文 `cookies.sqlite` | 相同 | 相同 |
| Safari | `Cookies.binarycookies`（需要完全磁盘访问权限；类型化错误 `full_disk_access_required`） | — | — |

范围：单个站点（同以前）、一组选定的可注册域名，或全部域名。
`browser_cookie_domains` 会列出某个配置文件的域名及数量，且不做解密。
写入目标：内嵌 webview（macOS 沿用 WKHTTPCookieStore；
Windows/Linux 通过 Tauri 的 `Webview::set_cookie`）以及本地 Chromium
（`browser.cookies.set`，仅由 Rust 到运行时）。值始终只留在 Rust 内，
与 ADR-0073 中一致。

### 密码库与自动填充

- 导入来源：同样一批 Chromium 浏览器（`Login Data`，各平台同样的密钥，
  v20 会被跳过并计数）、Firefox（`logins.json` + `key4.db`，
  NSS PBES2 / 3DES，未设置主密码时可用；若设置了主密码则返回
  `primary_password_set`），以及 CSV（Chrome/Edge/Brave、Safari、
  Firefox、1Password、Bitwarden、LastPass、通用
  `url,username,password` 格式）。
- 存储：每条密码都是 `cognia-secrets` 中的一条 `secret_store` 条目
  （`cognia.browser.passwords` / 凭据 id）；元数据（来源站点、realm、
  用户名、来源、时间戳、备注）是另一条 secret-store 条目。除元数据外，
  没有任何内容写入 Dexie、日志或 IPC。
- 查看 / 复制 / 导出需要操作系统层面的用户在场验证
  （`cognia_secrets::user_presence::verify`：macOS 使用
  LocalAuthentication，Windows 使用带凭据提示回退的 Hello
  `UserConsentVerifier`，Linux 使用 polkit 的 `pkcheck`）；验证失败或
  不可用时直接拒绝。
- 自动填充：该面板检测登录表单
  （`browser.forms.detect-login` / 内嵌覆盖层 `__cogniaDetectLogin`），
  按可注册域名匹配候选凭据，并由 Rust 填充
  （`browser.credential.fill` 或内嵌 eval），值从不到达渲染进程。
  在本地 Chromium 上，表单提交后会弹出保存/更新提示。
- Agent 可以调用 `browser_fill_credential`，该调用要求逐次审批，
  按凭据 id 或唯一匹配项填充，并只返回
  `{filled: true, username}`。快照和日志仍然对敏感字段做脱敏。

### 本地内容

- 本地文件：`browser_local_file_serve(path)` 会（仅一次）启动一个
  绑定在 `127.0.0.1:<临时端口>` 上的 Rust 回环静态服务器，在一个随机
  128 位路径前缀下提供选定目录的内容，使相对资源可以正常工作，并且
  内嵌信任级别（`localhost`）适用。地址栏接受绝对路径和 `file://`
  URL 并将其路由过去；本地 Chromium 也可以直接打开 `file://`
  （`allowFileUrls`）。
- 开发服务器：`browser_dev_servers_detect()` 列出回环 TCP 监听端口
  （lsof / netstat）、探测 HTTP，并返回
  `{url, port, pid, process, title}`；空状态展示这些结果，而不是
  三个写死的端口。
- `resolveTrustTier` 将 `127.0.0.0/8`、`::1`、`localhost` 和
  `*.localhost` 视为可信。

### Agent 工具面

`plugins/browser-tools` 中新增的工具：`browser_open`（显示面板 /
选择后端）、`browser_download`（列出 / 保存 / 取消 / 附加）、
`browser_pdf`、`browser_emulate`、`browser_cookies`（元数据列表、
清除；从不返回值）、`browser_storage`（localStorage/sessionStorage，
需可信级别或审批）、`browser_network_request`（请求头 + 截断后的
正文，鉴权头被脱敏）、`browser_fill_credential`、`browser_extensions`
（列出、打开弹窗/选项页）、`browser_tabs_finalize`（user-chrome）。
一并修复：导航会路由到目标 URL、授权是实时的（Dexie 订阅）、
一个已获授权的公开 URL 会回退到当前可用的最佳桌面引擎而不是抛错、
内嵌的 `close_page` 不再导航到 `about:blank`、内嵌引擎像远程引擎一样
拒绝敏感字段、`requiresApproval` 会传达到 sidecar 的 manifest 中。

### 外部 agent

External Bridge MCP 服务器新增了一等公民的 `browser_*` 工具，代理
相同的插件工具实现，并带有：新的 `browser:control` scope、在
“设置 → External Bridge”中按角色独立开关、每个 MCP 客户端绑定一个
聊天/浏览器会话、遵循按工具的审批标志，以及自动打开浏览器面板
（若没有可见窗口，则打开一个无头的本地 Chromium 会话）。
`plugin_tool_invoke` 拒绝 `cognia-browser-tools`，并指向这些专用工具。

## 后果

- 公开站点自动化、扩展、下载和标签页在桌面端无需云端运行时即可工作；
  内嵌 webview 仍是零安装的默认选项。
- 桌面端安装包因此多出约 2 MB（运行时 + playwright-core）；Chromium
  本体（约 170 MB）只有在用户安装时才会下载。
- Windows 的 App-Bound（v20）数据从不解密。使用当前版本 Chrome 的
  Windows 用户可通过 CSV 导入密码，或使用 `user-chrome` 获取已登录的
  会话。
- 密码值只存在于 Rust 内存、加密的 secret store、目标页面，以及一次
  显式的、经操作系统认证的查看或导出操作中。

## 被否决的方案

- 自研一个使用 `chrome.debugger` 的 MV3 扩展来驱动用户的 Chrome：
  这与 Chrome 自带的、需用户同意的远程调试功能重复，并且会违背
  ADR-0154 中伴随端的边界。
- 仅使用 WebView2 扩展：只支持 Windows，且需要隔离主 webview 的
  环境。
- 重写一个 Rust 版 CDP 引擎：Playwright 服务已经存在、已经过测试，
  并且能提供云端/桌面端一致的快照能力。
- 把密码存到 Dexie（即便在渲染进程中加密）：渲染进程一旦被攻陷，
  密码就会暴露。
