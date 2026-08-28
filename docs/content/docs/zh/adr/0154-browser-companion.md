---
title: "0154 — 浏览器交出一个页面，而不是一次会话"
description: "一个 Chrome 侧边栏：以自己的最小权限设备类别与桌面宿主配对，只在显式手势之后捕获页面，并把它变成一个新的 Cognia 任务。它不是 Browser Use 的依赖，不是第二个聊天客户端，也不是自动化传输层。"
---

# ADR 0154 — 浏览器交出一个页面，而不是一次会话

**状态：** 已接受
**日期：** 2026-08-27
**相关：** [ADR-0055](./0055-agent-browser-loop)、[ADR-0085](./0085-cloud-shared-browser)、[ADR-0125](./0125-work-submission-contract)、[ADR-0136](./0136-cross-device-placement)、[ADR-0144](./0144-workspace-as-the-unit-of-work)、[ADR-0148](./0148-style-packs-and-surface-tiers)、[ADR-0149](./0149-a-person-is-not-a-device)

## 背景

没有办法把你正在读的页面交给 Cognia。人要么把标题、URL 和一段正文复制进桌面应用，要么放弃这段上下文。

两次调研界定了答案。浏览器 AI 产品的市场对比发现，"一个能回答当前页面问题的侧边栏"已经是入场券——
Gemini in Chrome、Edge Copilot、Comet、Dia、Brave、Firefox、Sider 都有——真正形成差异的在别处：
可见的上下文选择、分层权限、任务边界、接管，以及在本地、应用内和云端浏览器之间路由的能力。
Browser Use 的调研给出了更重要的否定结论：Browser Use **不需要** Cognia 的扩展。
它的传输层是 CDP。Cognia 已经有三条浏览器路径——`EmbeddedEngine`、`RemoteChromiumEngine`
和 `playwright-existing-browser` MCP 预设——扩展是第四个产品面，而不是其中任何一条缺失的前置条件。

所以问题从来不是"我们怎么自动化浏览器"，而是"一个页面怎么进到 Cognia 里"，而后者要小得多、也更值得做对。

## 决定

**1. 扩展交出页面，它从不驾驶页面。**

首版支持三种捕获模式——`metadata`、`selection`、`readable-page`——一律在显式手势之后
（工具栏、快捷键、右键菜单），绝不在切换标签时发生。没有 `chrome.debugger`，没有静态 content script，
没有 `<all_urls>`。安装时索取的全部权限只有 `activeTab` 加一个可选的 `http://127.0.0.1/*`。

页面操作、审批、续写已有会话、截图，以及任何 CDP 中继都在范围之外，且不得预先接线。
在需要自动化已登录标签页的场合，`playwright-existing-browser` 已经能做，而且把那条传输层
留给微软而不是我们维护。

**2. 浏览器是自己的设备类别，只有两个能力，没有别的。**

`browser.submit` 与 `browser.read-own` 加入 SecurityStore 词表，且没有任何 `GrantKind` 映射到它们——
它们只能通过在专用的 `browser_enrollments` 表里消费一枚令牌、经
`POST /api/auth/browser/register` 授予。这与 `agent.worker` 的形状逐字相同，理由也相同：
设备类别由"消费了哪张注册票"决定，而不是由客户端自报的标签决定。

因此浏览器设备没有 `agent.run`、没有 `workspace.*`、没有 `terminal.open`、没有 `process.spawn`、
没有 `host.observe`，也没有 Owner 权威。测试断言的是"没有"，因为"没有"才是重点。

**3. 扩展 origin 在注册时绑定，并在此后每个请求上重放。**

`WebOriginPolicy` 把不带 `Origin` 头的请求判为 `Native` 并放行——这对原生客户端是对的默认值，
对一个定义上就是浏览器的设备是错的，而且实际可达：MV3 service worker 的 `fetch` 可能不带该头。
注册时的 `chrome-extension://<id>` 随 `AuthorizationSnapshot` 一起返回，并在每个已认证请求上比对。
对其他所有设备它都是 `None`，所以没有别的东西改变行为。

该 origin 的准入是一个**新谓词**，而不是放宽 `is_secure_or_loopback`：
`lark_entry` 共用那个函数来校验它的 `COGNIA_LARK_*` base URL，教会它扩展 scheme
就等于同时教会 Lark：扩展页面是可接受的 webhook base。

**4. 配对码指向明文 loopback 监听器，并在没有它时拒绝存在。**

标签页根本够不到 HTTPS companion 平面：证书是无 CA 的自签名，而浏览器只对系统根证书校验，
且没有 JS 逃生口。`http://127.0.0.1` 按 Secure Contexts 属于"潜在可信"，不需要任何证书链，
这让 `browser_access` 的监听器成为唯一的门。因此
`companion_create_browser_enrollment` 发出的正是那个 base URL，并在监听器未绑定时拒绝出码——
一个连不上的码只会把用户送到扩展里去发现一个成因其实在设置页的失败。

载荷有自己的头部（`cgnb1|`）而不是 `cgnp3|` 上的一个模式位，因为两者在任一方向都不可互换，
共用头部只会让每种码都能被粘贴到它注定失效的地方。

无头宿主没有设置页，所以同一份 enrollment 由 `cognia-server devices enroll-browser` 铸造、
由 `pnpm dev:headless browser-enroll` 编码。它保留了那道拒绝而不是继承它：另一个进程读不到
`state.browser_port()`，于是它直接问平面本身——请求公开的 `/healthz`，把回报的 `server_id`
与本数据目录签名密钥推导出的那个比对，这才把"监听器已绑定"和"27891 被别的进程占着"分开。
`cgnb1|` 编码器**没有**在 Rust 里再实现一遍：原生命令把 issue 以 JSON 打印，开发脚本用扩展
所打包的同一个包完成编码，一种格式因此不会裂成两种。

**5. 提交直接创建会话，再经 HostState 入队一条消息。**

把两半都交给 HostState 错了两次。`session.create` 映射到 `process.spawn`——即 Agent Control 授权——
而它的投影只写一行没有工作区、没有执行上下文、没有 `SESSION_CREATED` 事件的裸记录，
会话会存在却不属于任何地方。`startNewSession()` 才是让会话成为会话的那部分。

消息那一半确实走 HostState，因为它的 dispatcher 是从"消息存在"到"回合在跑"唯一的非 React 路径：
它写入 ADR-0125 的 WorkSubmission 账本、领取派发租约、解析发送选项，并调用 `sendPrompt`——
PII 闸就在那里。

`message.enqueue` 需要 `workspace.write`，浏览器并不持有，所以入队是以**宿主自身**的权威提交的。
这不是绕过，理由是结构性的而非承诺：动作由宿主为它刚刚创建的会话构造，意图种类固定，批次只有一个元素。
调用方提供的是一句指令和一个捕获的页面；它没有指定会话，也没有选择意图。
`browser.submit` 就是这一个封闭效果对应的能力。若将来需要第二种意图，
调用方就不再受约束，模型必须随之改变。

**6. 幂等来自命令清单，不是手写的。**

`browser_context_submit` 声明 `idempotency: "required"`，这把它放上持久化的操作账本：
重复的 `Idempotency-Key` 会重放原始回执而不是创建第二个会话，参数不同的重用键则冲突。
submission id **就是**幂等键，所以重试不可能为同一次用户操作换一把新钥匙；
消息 id 由它派生，因此崩溃后的重驱动解析到同一条转录记录。

**7. 读取以调用设备为界，且不透露别人的存在。**

`browser.read-own` 指的是这台设备自己提交的记录。属于别的设备的 submission 的答复，
与不存在的 submission 完全一致——区分两者会让一个浏览器能探测另一个的 id。

**8. 捕获的页面被围栏，指令不被围栏。**

`buildBrowserContextPrompt` 用 `<untrusted_content>`（ADR-0008 R7 的包装器）把页面围起来，
把用户的指令留在围栏之外。`lib/web/untrusted-content.ts` 的横幅式包装器表达不了这一点：
横幅之后的一切都读作不可信，指令会连同页面一起被隔离。

**9. 任务的落点是工作区，不是运行时目标。**

四个 `runtimeTargetId` 命名的是**客户端**的执行身份，而 `resolveRuntimeTarget()`
对 `tauri` 返回 `null`，恰恰因为那个 shell **就是**宿主。扩展不执行任何东西。
用户真正选择的是一个工作区（ADR-0144），这也正是请求里携带的东西。

**9a. 任务投到哪里，同样从宿主声明的清单里选。**

capability 响应携带 `deliveryTargets`，提交时回引其中一个 id。这没有削弱决定 5，
理由和 `workspaceId` 成立的理由是同一个：清单是**宿主的**。扩展从拿到的东西里挑一个标签；
宿主用这个 id 在**它刚刚构建的目录里做查表**来解析，而不是去解析这个字符串。
清单之外的 id 会被当作客户端的陈旧状态拒绝，和一个未被提供的工作区完全一样。
浏览器依然无法命名一个未被提供的会话，无法构造 action，也无法选择模型、工具集或权限模式。

首批两种 kind 是 `chat` —— 新建任务，也就是在此之前一次提交唯一可能的含义，
并且在没有指定目标时仍是默认值 —— 以及 `session`，追加到**本设备自己开出**的会话。
这个边界由 `browserSubmissions` 账本给出：目录是从本设备写下的行构建的，
所以一个浏览器永远不会被提供桌面端开出的会话，也不会被提供另一个已配对浏览器的会话。
`session` 目标还携带它所属的工作区，若提交里这一对不匹配则拒绝 ——
追加不会把会话在工作区之间搬家，把它提供在一个并不属于的工作区下就是在承诺它会。

`targetId` 在协议上是可选的，`schemaVersion` 保持为 `1`。
面板对这个版本做的是全等比较，抬高它会让所有已安装的扩展因为一个它们并不需要的新增字段
而判定宿主不兼容。

**10. 侧边栏的外观由宿主下发，而不是编译进扩展。**

capability 响应携带已解析的调色板——`theme-token-catalog.ts` 里的每一个自定义属性，
由绘制应用本身的同一个 `resolveAppPalette` 产生——外加 ADR-0148 的圆角基准、pill 圆角与密度。
复制一份调色板既是第二个真相源，**又**对这个用户是错的：预设、自定义主题、导入的 VSCode 主题、
插件主题和无障碍补丁都会解析进去，而这些在扩展构建时都无从得知。

**11. 状态在面板可见时轮询。这是有意的。**

`/ws/events` 存在，但它的 socket 通道要求 `host.observe`——整个宿主事件流，
远宽于这个设备应当看到的范围——而且 MV3 service worker 随时会被回收，后台长连接不可依赖。
面板在可见时轮询 `browser_context_list`，并在重新打开时对账。
专用的 `SocketChannel::BrowserSubmissions` 是合理的后续补充，在此记为**有意延期**，
而不是留白。

## 后果

Cognia 获得了一个浏览器入口，而没有同时获得一个浏览器自动化面，也没有随之而来的安装期权限警告。
这个扩展可以靠读它的 manifest 来审查。

代价是多了第四个与浏览器相邻、需要与已有三个保持一致的产品面，
以及一个新的设备类别——它的两个能力要与既有的十二个一同维护。

轮询是已知的折中。如果"最近任务"从"扫一眼"变成"盯着看"，§11 里的 socket 通道就是解法。

## 推出

仅内部使用。Browser Access 默认关闭，扩展通过未公开的商店条目分发。

kill switch 就是 Browser Access 这个开关本身，它对三件事的生效时刻并不相同。
关掉它会在**下一个请求**上就拒绝新的注册与新的提交 ——
`companion_browser_access_set` 会把保存后的开关值镜像进
`rpc/data_sync.rs` 读取的进程级全局量，两者都不必等重启。
明文监听器则会一直绑到服务器重启为止，这是有意的而不是缺口：
已配对面板的**读**仍然在它上面得到应答，所以一个已经发起过任务的浏览器
依然能看到状态、依然能在 Cognia 里打开它们 —— 这就是"既有会话仍可访问"的含义。

被这样拒绝的提交回的是 `browser_submissions_disabled` 而不是一个传输失败，
因为补救手段在这台宿主的设置里，调用方手上没有任何东西能改变这个结果。
