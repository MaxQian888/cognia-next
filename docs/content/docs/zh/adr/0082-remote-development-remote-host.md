---
title: ADR-0082 — 远程开发 / 连接远程 Cognia 主机
description: 桌面外向传输路由、远程主机注册表,以及会话级"当前主机"模型——让本地桌面 UI 驱动一台远程 Cognia 服务器上的终端、文件与 git。
---

# ADR-0082 — 远程开发 / 连接远程 Cognia 主机

**状态**: 已接受 (2026-07-17)

## 当前能力修订（2026-08-13）

当前能力矩阵已经包含 code-server relay、Cloudflared transport 与 remote external-Agent execution，超过原始缺口描述。后续 remote LSP 只能在测试过的能力矩阵证明缺失时扩展现有 remote-host adapter；不授权第二套 remote-development transport。

## 背景

`cognia-server serve` 已经能在远程机器上立起一台完整的无头 Cognia:它绑
`0.0.0.0`、强制 master key、pin 自签 TLS 指纹,并对外提供与 Capacitor 移动端
同一套 companion 数据面(`/api/v1/_rpc/*`、`/ws/v1/terminal`、`/ws/v1/events`)。
客户端传输契约(ADR-0012)只有两个方法——`call` 与 `subscribe`——而每一个工作区
面(文件、git、一次性终端命令、chat、external-agent RPC)都经由单一进程级
`transport` 绑定、每次调用现读。

唯一的架构级缺口在桌面侧:`pickTransport()` 硬选本地 `TauriTransport`,没有任何
路径能把 `transport` 指向远程主机。于是桌面能"托管"一台 Cognia,却永远无法
"驱动"一台。本 ADR 记录桌面如何在**不重复实现**已有的传输 / 终端 / 事件 / 配对 /
WAN 机制的前提下,获得外向"连接远程 Cognia 主机"模式。

动工前必须先拍两个问题(来自实施计划的 OPEN 项):

- **OPEN-1** — 桌面只有一个全局 `transport`,如何同时驱动本机与远程主机?
- **OPEN-3** — 一个存远程凭据、pin 远程指纹的外向客户端是安全姿态的改变。v1
  是否值得?

## 决策

1. **以 `RoutingTransport` 做外向路由(拍定 OPEN-1,选 a)。** 桌面上
   `pickTransport()` 把本地 `TauriTransport` 包进 `RoutingTransport`。`Transport`
   契约只有 `call` + `subscribe`,故该包装是忠实代理:装有"当前远程"transport 时
   委派到远程,否则直接透传本地。没有激活任何远程主机时,它与旧行为逐字节一致——
   这就是零回归基线。切换当前主机只是模块级持有者上的一次指针替换;约 480 个
   `transport.call` 站点与 `subscribe` 事件流会自动跟随,因为它们都每次调用现读
   活绑定。被否的替代方案(全局保持本地、给每个远程感知功能塞第二个 transport
   实例)不采用:它会把 per-target transport 重新穿引到 terminal/fs/git/agent 各
   调用点,丢掉"调用点零改动"这个让本方案廉价的性质。

2. **一张远程主机注册表,独立于单服务器 companion 配置。** `companion-storage`
   只存一台已配对服务器(移动端模型)。要驱动**多台**远程 dev box 需要多条目
   注册表:每个 `RemoteHost` 是一个标签 + 一份完整 `CompanionConfig`(baseUrl、
   deviceJwt、指纹……)。主机**列表**落盘(localStorage,`cognia.remoteHosts.v1`);
   注册表原样复用既有配对客户端(`redeemPairCode` / `redeemPairJwt` /
   `decodePairPayload`)、配置形状与指纹 pin——不新造配对、加密或 WAN 代码。

3. **当前主机是会话级的,默认本地。** 注册表持久化"存在哪些主机",从不持久化
   "哪台被激活"。每次启动都从本地开始;用户显式激活某台主机才进入远程会话。这是
   安全默认——app 永不在启动时静默驱动一台远程机器——也省去了启动时重激活的接线。

4. **远程终端复用持久主机会话,以当前主机为门。** 无激活主机时
   `selectTerminalTransport()` 返回 `tauri-channel`(本地 PTY),有激活主机时返回
   `ws`(`RemoteTerminalSession`)——这是"桌面指向远程"唯一渗入终端栈的地方。此前
   生产从未接线的 companion 端点解析器被安装,用以解析当前主机的
   `{ baseUrl, deviceJwt }`。无新 session 子类。规范端点为 `/ws/terminal`,同时保留
   `/ws/v1/terminal` 兼容别名。device JWT 只用于换取短时、单次 socket ticket,
   不进入 WebSocket URL;断线重连 / 回放由持久终端主机进程负责。

5. **文件与 git 免费即远程。** `workspace-fs` 与 `git/commands` 是纯
   `transport.call` 包装,故零新代码即跟随 `RoutingTransport`。
   `fs_read`/`git_status`/`git_diff`/`git_log` 是读档级,持 device JWT 即可达远程;
   `fs_write`/`git_commit`/`git_push` 是 CONTROL 级,还需远程在其 control-allow-list
   中授权本设备。该能力边界被诚实呈现,而非隐藏。

6. **安全姿态(拍定 OPEN-3)。** v1 的姿态变化极小且已有先例:桌面存一个远程
   **device** JWT 并 pin 一个远程 TLS 指纹——正是移动端今天所做。它不引入外向
   SSH、不改 sandbox env、不新增 keyring 条目。既有护栏——强制 master key、指纹
   pin、单次 pair JWT,以及服务端强制的 READ_ONLY / CONTROL / SERVICE_ONLY 能力
   门——限住爆炸半径。更重的姿态改变(外向 SSH、对 `0.0.0.0` 做 provisioning)
   属于 SSH 阶段,另立 ADR。

7. **范围与分期。** v1 交付远程**终端 + 文件 + git**(本 ADR)。以下各有具体原因
   被有意推迟,非疏漏:
   - **远程 external agent** —— `spawn/send/kill/get_external_agent_status` 臂是
     SERVICE_ONLY,device JWT 永不可达。启用它需要一套 service-token 凭据模型
     **以及**无头 external-agent initializer 抽取(ADR-0059)。两者落地前推迟。
   - **远程 code-server / LSP** —— `codeserver_*` 是 Tauri 命令,且不存在 `lsp_*`
     companion 臂;把它们提上来是 VS Code Remote-SSH 量级的活。推迟(v3)。
   - **SSH provisioning** —— 自动 provisioning 仍推迟(v3)。下述显式 SSH 终端
     profile 不属于 provisioning。*隐式*建隧道同样仍推迟;§9 中逐条显式启用的
     端口转发恰恰是"隐式"的反面,不构成对本条的推翻。

8. **SSH 终端安全补充决策（2026-07-31 接受）。** 显式 SSH 终端 profile 仅在以下
   fail-closed 边界内允许:
   - 原生终端主机拥有 `russh` 连接。renderer 与远程设备只能选择已同步的 profile
     id;密码与私钥口令由原生代码从 `cognia-ssh` OS keyring namespace 解析,绝不进入
     profile JSON 或终端 wire protocol。
   - 服务端 key 使用专用、仅 owner 可读写的 `known_hosts`。首次连接记录指纹(TOFU);
     后续必须匹配,变更即拒绝连接。UI 显示 key 是 learned 还是 verified 及其指纹。
   - 私钥路径是本地主机配置,不是远程调用参数。远程客户端只能启动主机已同步的
     profile,不能提交任意 SSH host、username、credential ref、key path 或 shell command。
   - SSH 仅在用户创建并选择 profile 后产生外向连接;它不新增 inbound 监听端口、
     不 provisioning 服务器、不削弱 TLS/device pairing,也不绕过 terminal grant、
     controller lease、replay 限额与单设备 session 配额。

9. **SSH 端口转发与跳板机补充决策（2026-08-16 接受）。** 跳板机与显式端口转发
   仅在以下边界内允许。本节修正 §8 中"不新增 inbound 监听端口"一句——该句写于
   尚无转发能力之时:`-L` 规则会在本机绑定端口,启用的 `-R` 规则会让远端服务器
   绑定端口。二者不是被放行,而是被收窄:
   - **两端一律绑定回环。** `127.0.0.1` 是 `crates/cognia-terminal/src/ssh_forward.rs`
     里的常量而非配置项,两个方向都如此。不存在任何一种 profile 形态能把它放宽
     ——即便服务器开启了 `GatewayPorts` 也不行,而那恰恰是用户最难察觉差异的场景。
   - **`-R` 逐条默认关闭,须显式启用。** 远程转发会在别人的机器上开一个指回本机
     的监听套接字,因此新建的规则是惰性的,UI 陈述的是这一后果而非机制。`-L` 默认
     开启:它只在本机监听。
   - **转发配置永不随同步 profile 下发。** `buildSynchronizedSshProfiles` 不输出
     跳板链与任何转发规则,因此手机或局域网客户端凭 profile id 只能拿到 shell,
     永远无法让桌面(或桌面可达的服务器)开监听端口。此不变量由测试钉死,而非
     依赖"恰好没有复制字段"。
   - **在运行中的会话上启停转发仅限本地身份**(`TerminalHost::set_forward_enabled`),
     理由与 §8 中重新信任变更的主机密钥相同。
   - **每一跳都是独立的服务器。** 跳板机以自己的账号、自己的 keyring 条目认证,
     并针对同一 `known_hosts` 做 TOFU 校验;任意一跳密钥变更都会让整条链 fail
     closed 并指明是哪一跳。链长上限 5 跳,成环在解析阶段即被拒绝,不会触及套接字。
   - **转发状态是拉取的,从不推送。** `SshForwardControl` / `SshForwardSnapshot`
     是一对请求/响应;主机从不主动发送,从而保持 ADR-0033 的不变量:旧客户端
     永远不会收到它无法解码的 frame kind。
   - **入站转发通道按端口鉴权。** 客户端拒绝任何端口不属于本会话已启用规则的
     `forwarded-tcpip`,并直接拒绝服务器发起的 `direct-tcpip`。

## 影响

- 无激活远程主机时桌面 transport 不变;远程路由在显式激活主机前是惰性的,故本地
  行为不会回归。
- 任何建立在 `transport.call` / `transport.subscribe` 上的功能,在有激活主机时
  自动获得远程能力——新面免费获得,且不得假设调用一定是本地。
- 会话中途激活主机不会重定向已打开的订阅(它们在订阅时绑定);应跟随当前主机的
  面在其变化时重新订阅。切换前后打开的终端各自指向 spawn 时激活的主机。
- CONTROL 级远程操作(写、commit、push)在远程授权本设备控制前会以清晰的能力
  错误失败——这是服务端 allow-list 决策,不是客户端 bug。
- 远程 agent、远程 LSP、SSH provisioning 各阶段继承本 ADR 的当前主机模型与
  注册表;它们增加的是能力,不是第二套连接机制。

## 2026-07 operation 级能力契约

上述粗粒度 placement capabilities 继续供 workflow 使用，但管理界面改用
`host_feature_manifest`。版本化 manifest 将 `hostBuildId`、具体 operations 与运行
限制绑定在一起；激活/重连时刷新，主机构建变化时丢弃缓存。缺失、未知或陈旧的
manifest 对写操作一律表示拒绝，客户端不再用乐观写调用探测能力。

设置页明确分成“远程主机执行”“控制端代理”“当前不可用”三类。未完成的功能不得
广告；当前会话 Skill 附加、Bridge 托管 relay 与 direct TLS 在完整传输和安全链路
落地前保持缺席。

远程 Claude 响应命令携带服务端盖章的执行上下文（`hostId`、原设备、session、
generation、request id、签发/过期时间）。传输层现在只把带上下文的事件交给
来源设备，并拒绝错误设备、陈旧 generation、重放、重复和过期响应 ID。在所有
响应都绑定真实 pending request、且具备 session 级工具授权前，
`claude.controller-tool-proxy` 不会被广告。原子 Skill 写入和主机托管 Bridge
生命周期也会保持未广告，直到 owner、过期、健康检查和迁移要求全部完成。

## 2026-08 Source Control 安全修订

远程 Git 不再通过转发 renderer 路径来“免费远程化”。当前账户的项目根目录会注册为不透明工作区；设备客户端仅使用 `workspaceId` 加经过校验的相对路径寻址。只有主机解析绝对路径，并重新授权规范化后的 worktree 与 Git 目录，阻止嵌套仓库或向上发现造成越界。响应会清除主机路径，身份读写仅允许 repository-local。

`source-control.git` 在 `host_feature_manifest` 中逐一广告所有现有 Git 操作。交互式变更必须使用 `host_admin_lease_issue` 签发的设备绑定、精确命令 lease，TTL 为 120 秒；客户端不会自动续期，也不会重试已过期或送达不确定的变更。Source Control 在 Tauri 与已配对客户端显示，在独立 Web 隐藏；远程界面仅在可见时每五秒轮询。

**Headless 工作区来源（2026-08-16）。** 桌面端的不透明工作区来自 renderer 通过 `fs_set_allowed_roots` 注册的根目录；headless brain 从不运行 renderer，因此该注册表始终为空，`source-control.git` 也一直未向 headless 主机公开（ADR-0059 host-parity Class E）。现在 headless 主机改由策略所有的 workspaces 根目录派生 Git 工作区：其下每个直接子目录都是一个工作区，`workspaceId` 即目录名，经 `SpawnPolicy::validate_workspace_root` 解析——与 `authorize_workspace_root` 对 `workspace.files` 施加的信任边界完全相同。两种主机公开完全一致的 `source-control.git` 操作集；桌面注册表与 headless 策略根目录互不认识对方的 id。
