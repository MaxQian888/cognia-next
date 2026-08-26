---
title: "0152 — 连接器控件说清楚它在哪台宿主上"
description: "设置里每一个连接器控件都用 isTauri() 回答「我能不能在这里运行」，于是告诉云端伴侣它的适配器需要桌面应用 —— 而那些适配器正跑在配对的服务器上。本 ADR 用宿主解析器取代壳判断，把三个真正依赖桌面进程的控件单独分出来，并给插件贡献的连接器补上注册表早已假定存在的配置面。"
---

# ADR 0152 — 连接器控件说清楚它在哪台宿主上

**状态：** 已接受
**日期：** 2026-08-27
**相关：** [ADR-0009](./0009-platform-connectors)、[ADR-0025](./0025-unified-subscription)、[ADR-0059](./0059-server-ops-controller)、[ADR-0131](./0131-cross-shell-inbox-relay)

## 背景

`components/settings/connections/**` 下 18 个文件里的 20 个控件，都靠 `isTauri()`
决定自己能不能运行。答案为否时它们禁用自己，并渲染 11 句几乎一模一样的「需要桌面
运行时」。

**行为是对的**，本 ADR 不改它。42 条 `connectors_*` 命令全部声明为
`target: service` 且 `transports` 为空，所以配对的浏览器没有到它们任何一条的通路；
而 `setConnectorCommandInvoker` —— headless 大脑用来在同进程里跑同一批包装函数的那个
接缝 —— 也没有伴侣端实现。今天浏览器确实测不了令牌、探不了机器人身份，假装可以只会把
一句清楚的提示变成一个原始的传输错误。

**解释是错的**，而且在两种非桌面档位上错的方向正好相反：

- **云端或移动伴侣**被告知「适配器需要桌面应用 —— 已配置的会话在这里只读同步」。可它的
  适配器正跑在配对宿主上，而横幅旁边的收件箱正在通过中继回复消息、批准草稿、写会话覆盖
  （`lib/connectors/inbox-writes/route.ts`）。这句话的两半都是假的。
- **独立浏览器**在本机和任何配对宿主上都没有连接器运行时 —— 因为它根本没配对。在那里
  「打开桌面应用」才是对的答案，而且它是唯一被这句话描述准确的档位。

20 个里有 3 个根本不是运行时的问题：cloudflared 子进程、微信个人号扫码登录、Matrix
密码登录需要的是桌面进程本身。headless 宿主跑适配器毫无问题，却一个也做不了。

另外，`plugin-connector-registry.ts` 一直允许插件拥有一个 `PlatformKind` 并走完整的
supervisor 路径，还会以「能据此生成设置表单」为由校验它的 `configSchema` —— 而那个生成
器躺在 unreachable-components 基线里，选择器的种类清单是 11 个硬编码字面量。

## 决定

**1. 一个解析器，而不是壳判断。** `connectorControlReach(profile, requirement)`
返回 `available`，或三种阻断之一：`no-runtime`、`runs-on-host`、
`needs-desktop-shell`。20 个控件全部据此门禁。等 `connectors_*` 提升到设备面那天，
改一个文件就能让 20 个控件改变行为。

**2. 两种需求，因为是两个问题。** `connector-runtime` 覆盖一切与运行中的机器人通信的
控件；`desktop-shell` 覆盖那三个需要桌面进程的。`web-standalone` 对两者都回答
`no-runtime`：告诉一个人他的隧道需要桌面应用，会跳过「他连适配器都还没有」这一段。

**3. 原因与下一步始终是两句话。** 与能力词表（[ADR-0009](./0009-platform-connectors)
的能力投影，由 `CapabilityNotice` 渲染）同一条规则：没有补救办法的原因必须能在说明原因
后就结束。两套词表共用一个版式（`UnavailableNotice`），此外毫无共享 —— 一个回答平台
给了这个机器人什么，另一个回答这台宿主能不能驱动它，而一个能力齐全的 Telegram 机器人
在独立浏览器里照样无法配置。

**4. 入站不等于可达。** Lark 的表单曾用一个布尔值同时问这两件事。入站地址从哪来 ——
cloudflared 还是公网域名 —— 决定新建行的传输默认值和隧道未开时的补救提示；它是这台机器
的属性，因此保留 `isTauri()`。控件能不能被驱动则归解析器。现在它们叫 `desktopShell`
和 `reach`。

**5. 贡献的连接器由它自己的 schema 来配置。** 选择器的种类清单在渲染时由
`listPluginConnectors()` 组装，任何不在内置 11 种之内的种类都打开
`PluginConnectorConfigDialog` —— 复活的 JSON-Schema 生成器，加上显示名、keyring 凭据
和触发策略底线这些不该由插件重新实现的部分。密钥字段用 JSON Schema 自己的说法声明
（`writeOnly`，或 `format: "password"`），而不是宿主私有的字段，并走与内置平台相同的
`CredentialInput`，因此落在操作系统 keyring 里，而不是备份会一并复制的 Dexie 行里。

**6. 四条 keyring 命令移到设备面，由租约把守。**
`connectors_keyring_{set,get,delete,list}` 原本是 `target: service` /
`capability: service.internal`，只有回环才能铸出的令牌才够得到 —— 这正是配对浏览器
根本配置不了机器人的原因，也是桌面端唯一能用只因为 Tauri `invoke` 完全绕开了这个协议面
的原因。它们现在是 `host-admin` / `host.admin` / `interactive` 加三种设备传输，形状与
`external_bridge_relay_enable` 完全一致。同时加入 `STEP_UP_COMMANDS`、移出
`SERVICE_ONLY_COMMANDS`，因此每次调用都必须出示有效的 admin 租约：`host.admin` 把多租户
下的 member 设备挡在外面，租约再补上时限与断连即撤 —— 这两件事光靠能力检查表达不了。

连接器面的其余命令仍是 service-only。操作者在设置里做的任何事都不需要手工开一个 websocket
或驱动 Matrix 加密，把整族放开等于拿一条真实边界换不来任何东西。

## 后果

- web 模式横幅不再声称伴侣端的收件箱是只读的。它在那里从来就不是只读的 —— 中继会写。
- 贡献插件已被停用的行现在可以打开，并说明实现已经不在了。它的设置会保留，且无法启动。
- 隧道面板不再向根本不跑隧道的部署推销隧道。
- OneBot 的「验证」与「探测」按钮改为渲染并禁用，而不是消失 —— 与能力面采纳的规则一致：
  渲染、禁用、写明原因。
- 这四条命令在**协议层面**已可从设备到达，但还不能真正从设备使用：
  `lib/connectors/tauri/commands.ts` 仍直连 Tauri `invoke` 而非走 `transport`，
  调用根本离不开浏览器；也还没有任何表单去申请这些命令现在要求的租约。这扇门从
  「不可能」变成了「需要一段你还拿不到的租约」—— 两种状态都是关着的，所以先落地是安全的。
  界面仍然显示 `runs-on-host`，屏幕上没有任何东西声称相反。把包装函数改走 transport 的代价
  是约 21 个 mock 了 `invoke` 的适配器套件会开始撞上 web stub 的拒绝；那是另一个工作单元。
- 生成物（`host-command-catalog.json`、OpenAPI 规格、headless 契约哈希）**没有**重新生成：
  `companion-api:gen` 在 `dev` 上以 1 退出，因为有 11 条 `git_stack_*` 命令没有规范派发臂。
  没有任何强制路径读取那些过期字段 —— Rust 通过 `include_str!` 直接读
  `protocol/companion-commands.json`，而 `cognia-headless-contract` 只读
  `name` / `inputSchema` / `outputSchema`，本次改动一个都没碰。

## 考虑过的替代方案

**现在就把门禁换成 `hasCapability("connector-runtime")`。** 该能力在伴侣端为真，于是
每个控件都会启用，然后以一个 Tauri 传输错误失败。一句准确的提示胜过一个点了没用的按钮。

**给 `PluginConnectorDef` 加一个 `secretFields` 数组。** 它是插件 SDK 的线格式，为一个
JSON Schema 已经用作者本来就会写的两种拼法回答过两次的问题去加字段，代价不值。
