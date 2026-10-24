---
title: "0228 — 浏览器伴侣可以丰富捕获，也可以被驱动"
description: "取代 ADR-0154 §1、§2、§11。扩展可以捕获可读 Markdown、字幕、多个标签页、截图、PDF 和图片；在后台汇报状态；并在 Owner 按浏览器授权后，成为第五个 BrowserEngine 后端：通过设备绑定的套接字，在用户自己的标签页中运行现有 overlay，不使用 chrome.debugger。"
---

# ADR 0228 — 浏览器伴侣可以丰富捕获，也可以被驱动

仓库归属（2026-10-23）：完整插件及 Chromium 测试迁入 [cognia-labs/cognia-browser-extension](https://github.com/cognia-labs/cognia-browser-extension)。Host 与固定版本消费者兼容性 CI 保留在主仓库。下文插件源码路径对应独立仓库。


**状态：** 已接受
**日期：** 2026-10-16
**取代：** ADR-0154 §1（只交接、不驱动）、§2（两项能力）、§11（仅在可见时轮询）
**修订：** ADR-0201（第五个引擎后端；其否决的 `chrome.debugger` 方案仍然否决）
**相关：** ADR-0055、ADR-0072、ADR-0125、ADR-0144、ADR-0198、ADR-0214

## 背景

ADR-0154 交付的侧边栏把一个页面以纯文本交给 Cognia。2026-10-16 与 ChatGPT 扩展
（1.26，2026-10-15）、Claude in Chrome（1.0.100）、Gemini in Chrome、Edge 中的
Copilot、Perplexity、Monica、Sider、MaxAI、Merlin，以及 Obsidian / Notion /
Readwise / Raindrop 剪藏工具对比后，发现侧边栏在四个方面落后：

1. **捕获内容。** 各产品发送的是可读正文而不是可见文本的平铺；剪藏工具保留
   Markdown 与元数据。ChatGPT、Gemini、Sider、Merlin 支持一次带多个标签页。
   Gemini、Claude、Monica、Sider、MaxAI 支持截图或框选。YouTube 字幕和 PDF 是基础能力。
2. **入口。** 链接/图片右键、快捷动作（总结、解释、翻译）、保存的提示词、更多快捷键、地址栏关键字。
3. **之后的体验。** 答案以 Markdown 渲染、任务运行时刷新、可以追问；面板关闭时用徽章和通知告知完成。
4. **执行。** ChatGPT、Claude、Gemini、Copilot、Comet 都能驱动用户自己已登录的标签页。

同一次审计还发现缺陷：伴侣路由的 64 KiB 公共请求体上限拒绝了任何超过它的
`browser_context_submit`，而契约承诺的是 192 KiB；`suggestedTitle` 从未发送；最近列表从不分页。

Cognia 已经可以通过 `user-chrome`（经 Chrome 的远程调试授权 `connectOverCDP`，ADR-0201）
驱动用户的 Chrome，但这需要在 `chrome://inspect` 打开开关并在桌面应用中绑定面板。ADR-0201
否决了 `chrome.debugger` 扩展，因为该权限不能设为可选，其安装警告（“读取和更改您在所有网站上的数据”）
会落到只想捕获页面的每个人身上。

## 决定

### 1. 捕获更丰富，发送前仍需审阅

提取器照旧在有布局的地方运行，并新增：

- **`article`** 捕获模式：对可见块做可读性评分得到正文，渲染为带标题、列表、链接、引用、代码和表格的 Markdown。`readable-page` 仍表示“所有可见内容”。
- **选区的 Markdown** 与其纯文本并存。
- **元数据**：作者、发布时间、站点名、语言、描述和规范 URL，来自 `<meta>`、Open Graph 和 JSON-LD。
- YouTube 观看页的**字幕**，来自页面已暴露的字幕轨，带时间戳；“没有字幕”是明确的结果，而不是静默的空字段。
- 右键菜单的**链接与图片上下文**。
- 发送前可以编辑标题、裁剪文本。

线上全部字段可选。Host 在 `capability.features` 与 `supportedCaptureModes` 中声明它理解什么；
面板只发送 Host 列出的内容，旧 Host 不会静默丢弃发给它的正文。`schemaVersion` 仍为 `1`。

### 2. 多个标签页可以是一次提交

`additionalContexts` 最多再带 `limits.maxPages − 1` 个页面，受总字节预算 `limits.totalContextBytes` 约束。
列出标签页需要可选权限 `tabs`，读取其他标签页需要该源的可选 host 权限；二者都在用户第一次添加标签页时，
在面板里的手势中申请。安装时警告不变。

Host 用 `wrapUntrusted` **逐页单独加围栏**：共享围栏里的“第 2/3 页”标签可以被页面文本伪造。
提交指纹覆盖有序 URL 列表。

伴侣路由为 `browser_context_submit` 设置单独的请求体上限，等于 `limits.requestBytes`——契约一直写的就是这个值。

### 3. 附件走 Host 自己的上传暂存

截图（可见区域、在面板中裁剪的区域、拼接的整页）、标签页正在显示的 PDF、右键选择的图片都成为附件。
扩展在 `browser.submit` 下用 `browser_attachment_upload_{init,chunk,commit,abort}` 按提交 id 上传；
Host 以自己的 `host:browser-companion` 调用方把字节暂存在现有会话附件存储中，提交落地时绑定到对话。
`message.enqueue` 仍只携带引用而非字节，单文件和单消息上限与输入框一致。`browser.submit` 仍是一个封闭效果：
附件只能属于本设备正在进行的提交。

### 4. 面板关闭时状态也能送达

当有提交尚未结束且面板不可见时，service worker 以 `chrome.alarms`（一分钟）轮询；设备套接字（§5）
连接时会推送变化提示。工具栏徽章显示运行中和等待输入的任务数。完成、失败、需要输入的系统通知需要用户开启：
`notifications` 是从设置开关申请的可选权限。

### 5. 浏览器设备有一个套接字，并可被允许驱动

`/ws/browser-companion` 是按 `ws_worker` 模式实现的设备绑定通道：一次性票据、十秒内 hello、
每秒重新校验授权、有界的发送队列，并在吊销或关闭 Browser Access 时关闭。它需要 `browser.read-own`，
向任何已配对浏览器推送状态提示。

仅凭策略关闭码不判定持续性拒绝。正在停止的 Host 在清除 Browser Access 标志之前先以 1001（going away）关闭所有套接字，
扩展按常规退避重连；1008 关闭（被替换、被吊销、被关闭）同样按常规退避重试，由票据交换来判定：它按名称拒绝
（`device_unavailable`、`browser_submissions_disabled` 等），只有这类持续性拒绝才等待长间隔。Browser Access
关闭期间，票据交换会拒绝此通道，因此不会出现套接字刚收到 welcome 一秒后就被关闭的情况。

信封版本保持 v1；驱动还要求扩展在 hello features 中声明 `agent-safe-v1`，且 Host 在
`welcome.agentProfile` 中选中同一配置。旧版或未知配置仅保留状态通道：Host 在入队前拒绝派发操作，
扩展也拒绝执行。不兼容的信封（包括协议错误关闭）会停止自动重试，直到显式重连。扩展使用浏览器客户端
允许的应用关闭码 4002。`packages/companion-client/src/browser-agent-protocol.json` 固定版本、配置、
操作集合与 overlay ABI，双方测试共用此契约；扩展在页面操作前核验实际注入的 overlay ABI。

重启后的 Host 用新密钥签发访问令牌，重启前缓存的令牌都会被以 `invalid_access_token` 拒绝。客户端会丢弃该令牌并重新认证一次
（该拒绝来自认证层，发生在任何命令执行之前，因此重发不会重复写入），而不是在旧令牌过期前让每个请求都失败。
无论从桌面端还是通过 host-admin RPC 修改 Browser Access，都经由同一个函数（`browser_access::save_and_apply`）立即生效，
因此被远程关闭的无界面 Host 无需重启即停止接受提交和套接字票据。

驱动是第三项类能力 **`browser.drive`**。它属于浏览器类（因此存储的类约束允许它），但**不会**在注册时授予：
由 Owner 在设置里按浏览器打开（无界面 Host 上用 `cognia-server devices grant --browser-drive`，见 §9）。Host 只在发送时向持有该能力的设备连接发送操作帧。

### 6. 扩展是第五个 `BrowserEngine` 后端

`ExtensionBrowserEngine`（`backend: "extension"`）通过该套接字发送操作帧来实现 `BrowserEngine`。
扩展用 `chrome.scripting` 和嵌入式引擎**同一份** `overlay.injected.js` 执行：快照、ref、动作、查找、
等待在隔离 world 中运行；只有必须观察页面自身全局对象的控制台 / 网络 / 对话框钩子在主 world 中运行。
因此 ref、generation、敏感值脱敏和 `browser_stale_ref` 的含义与其他引擎完全一致，43 个 `browser_*` 工具无需修改。

需要调试协议的能力以 `browser_feature_unsupported` 拒绝，并指出具备该能力的后端，与 `RemoteChromiumEngine`
一致：打印为 PDF、设备模拟、请求体、密码自动填充、列出扩展。输入事件是合成的；坚持可信输入的页面会明确失败，
`user-chrome` 仍是具备真实输入的后备方案。

引擎可以被显式选择（`browser_open` 使用 `backend: "extension"`），也可以由浏览器以 **`browser-agent`**
投递目标发起的对话选择：该对话绑定到这台设备和起始标签页，并通过 ADR-0198 能力授予为本次运行加上浏览器工具——
绝不修改已解析的发送选项。

### 7. 每个站点都由用户做主

驱动需要可选的 `<all_urls>` host 权限，在面板中启用代理模式时申请一次。在此之上，扩展保存自己的逐站决定——
允许一次、始终允许或从不——在操作第一次指向某个源时在面板中询问。面板关闭时待定的决定会点亮徽章，
并在允许时发出通知；超时后返回 `browser_site_permission_required`，而不是继续执行。代理打开的标签页放入
“Cognia”标签组，`finalizeTabs` 只关闭这些标签页。操作进行时页面内会显示 Cognia 正在操作的提示条，
带**停止**（取消该轮并暂停）和**接管**（暂停）。两者均取消待执行工作，并以 `browser_user_takeover`
拒绝后续操作；保留暂停提示条，直到用户点击**恢复**。释放会话、结束标签页以及认领新起始标签页也必须等待恢复，
避免清理擦除暂停状态或关闭用户接管的标签页。驱动撤权、断连和关闭代理模式也会取消待执行工作，
包括站点授权问题。取消检查覆盖异步浏览器调用前后；已经派发的 Chrome 调用无法撤回。密码与一次性验证码字段
仍需人工输入（`browser_human_input_required`），`browser_evaluate`、文件和下载工具保留逐次审批。

暂停状态不会因会话空闲清理而丢失。worker 统一负责会话与授权写入，面板决定经队列串行处理，页面内容不能授予权限。
可信的停止与接管立即阻止并取消工作，即使较早的控制操作仍在绘制提示条；控制状态持久化和清理仍按顺序完成。
已取消的状态变更不能擦除较新的暂停或授权问题。

Host 在实际发送套接字消息时重新核验授权。连接保存设备最近一次授权变更的唯一审计 ID，因此独立 CLI 进程
即使在同一秒撤权后又授权，也不能恢复旧工作。设备生命周期变化与 Browser Access 开关同样会使旧连接失效。
同步发送置于 SQLite IMMEDIATE 事务中，阻止其他进程的授权写入穿过发送边界；取得事务后再次检查截止时间与调用方取消。
授权变更以 1008 关闭旧连接，重连后重新协商。发送预算扣除队列等待时间，扩展在站点授权、存储和原生 API 各阶段执行该预算。

### 8. 草稿在关闭面板后保留，不在浏览器退出后保留

未发送的捕获及其指令保存在 `chrome.storage.session`：只在内存中，浏览器退出即清除，不写入配置文件。
公开的配对记录、外观、偏好、保存的提示词和站点决定存于 `chrome.storage.local`；捕获内容永不写入。

### 9. 无界面 Host 同样提供代理模式

`cognia-server` 提供同一个设备套接字，而该 Host 的对话在它的 brain 里运行，所以代理模式是 Host 的属性，而不是桌面端独有。
brain 通过自己服务器的服务平面访问套接字：`companion_browser_extension_status`、`_read`、`_call` 和 `_notify` 是
`target: service` 命令（`rpc/service_plane.rs`），任何已配对设备都无法借此驱动另一台设备的浏览器；每个操作仍检查
`browser.drive` 和 Browser Access 开关。操作按效果拆分（`READ_OPERATIONS`）：只读操作（快照、截图、等待、页面、控制台、网络、
Cookie 和存储读取）走 `_read`，Host 的持久幂等账本从不记录它；会产生动作的操作走 `_call`，账本保留其回执，重试的点击不会点两次。
全部走 `_call` 会让每次查看都把页面内容和 Cookie 值写进安全存储；全部当作读取则会让重试重复动作。两个命令都以
`browser_operation_wrong_command` 拒绝另一半操作。桌面端 IPC 没有账本，所有操作都走 `_call`。被拒绝的操作保留原错误码（`browser_drive_forbidden`、`browser_extension_offline` 等），
并附带说明责任方的状态码：请求本身（400）、Owner 的授权（403）、浏览器连接（503，可重试）、超时（504）或页面本身（422）。

负责重新绑定代理对话、提示浏览器的同一个 Host 运行时，在 brain 中以 `browser-companion-agent` 运行
（`lib/headless/runtimes/browser-companion-agent.ts`）。它和引擎都经由 `lib/browser-companion/host-transport.ts` 访问套接字：
桌面端走 Tauri IPC，即使窗口正在操作远程 Host 也总是询问本机服务器；brain 中走已安装的服务平面传输。代理上传到页面的文件在两者上都从
Host 自己的磁盘读取。已绑定浏览器的对话会先路由到扩展，再考虑 Host 配置，因为无界面配置原本会把浏览器工具交给远程浏览器。

无界面 Host 的运维者用 `cognia-server devices grant <browser-id> --browser-drive` 授予驱动权限（用 `revoke` 收回）；
存储仍拒绝把 `browser.drive` 授予浏览器以外的设备。列出已配对浏览器和修改授权仍是桌面端命令：在无界面 Host 上由
`cognia-server devices grants`、`GET /api/devices` 和 `PUT /api/devices/{id}/capabilities` 覆盖。

## 后果

扩展现在会申请更多权限，但只在用到时申请：`tabs`、源访问、`<all_urls>`、`notifications`、`downloads`、
`cookies` 都是可选的，并在需要它们的手势中申请；关闭智能体模式会交还 `<all_urls>`。安装提示除 `tabGroups` 与 `alarms`（二者无警告）外不变。
无痕模式仍为 `not_allowed`。

浏览器设备现在可以在网页上引发操作。该能力默认关闭，由 Owner 按设备授予，按帧重新校验，随设备吊销，
并被 Browser Access 总开关整体拒绝。

合成输入弱于 CDP 输入。我们接受这一点，而不是让每个用户都看到调试器警告；其余情况由 `user-chrome` 覆盖。

## 发布

与 ADR-0154 相同：内部、未公开列表、Browser Access 默认关闭。`browser.drive` 还按设备默认关闭。
