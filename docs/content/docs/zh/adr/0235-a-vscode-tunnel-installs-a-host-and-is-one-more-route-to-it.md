---
title: "0235 — VS Code 隧道用于安装 Host，并成为通往它的又一条路线"
description: "借助用户已有的 VS Code 隧道，在其自有机器上安装、配对、修复和卸载完整的 Cognia Host；Host 可把隧道发布为备用公网路线。隧道从不作为无管理的工作区 Provider，每一部分都复用现有的所有者。"
---

# ADR 0235 — VS Code 隧道用于安装 Host，并成为通往它的又一条路线

**状态：** 已接受。用户于 2026-10-18 在设计评审与随后的复用审计中逐项确认了全部决策。2026-10-19 开始实现第 1 阶段中不依赖 spike 的部分：ingress listener 与按 listener 区分来源的判定。计划中的 P0 spike 是其余后续阶段（从路由发布开始）的门禁；若 spike S1 未通过，决策 4 在第 1 阶段前重新评审。  
**日期：** 2026-10-18  
**范围：** 已在运行 `code tunnel` 的用户自有 Linux 与 macOS 机器。桌面端在其上安装 Cognia Host，完成配对、保持可达，并能将其移除。  
**不在范围内：** Windows 机器、微软账号隧道（S4 通过前）、经原始隧道编辑文件、经原始隧道执行 Agent。  
**修订：** [0170](./0170-cognia-relay-and-connectivity-center)（其非目标“无头 Host 上的隧道或 mDNS”不再覆盖本记录定义的隧道路线）；[0082](./0082-remote-development-remote-host)（推迟的 SSH provisioning 现归本记录）。  
**相关：** [0021](./0021-webrtc-datachannel-wan-transport)、[0059](./0059-cloud-deployment-headless-brain)、[0153](./0153-the-host-obtains-the-confirmation)、[0162](./0162-sftp-is-shell-equivalent)、[0172](./0172-remote-access-is-verified-not-assumed)、[0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version)、[0196](./0196-a-library-crate-links-tauri-only-when-asked)、[0224](./0224-an-always-on-host-is-a-peer-the-user-brings)。  
**计划：** `docs/plans/2026-10-18-vscode-tunnel-host-bootstrap.md`。  
**研究：** `docs/research/2026-10-18-vscode-remote-tunnels-feasibility.md` 与 `docs/research/2026-10-18-dev-tunnels-sdk.md`（SDK 审计与实机探针）。早先的方案 `docs/plans/2026-10-18-vscode-tunnel-workspace-provider.md` 已被本记录取代。

## 决策

VS Code 隧道是进入用户自有机器的一个**入口**。Cognia 只把这个入口用于两件事：

1. **引导。** 在该机器上安装、配对、修复和卸载完整的 Cognia Host。
2. **备用路线。** 已安装的 Host 可以把隧道转发的端口发布为它的公网隧道 URL，客户端已经认识这个槽位。

此后用户在该机器上做的一切（文件、终端、git、Agent 运行、机器人、调度）都走 Host 现有的契约。Cognia 不构建任何隧道专用的文件、命令或 Agent 语义。Relay（ADR-0170）仍是主数据路径。用这种方式安装的 Host，就是现有远程 Host 注册表中一个普通的已配对 Host。

下文每一部分都写明它扩展的是哪个现有所有者；只有审计找不到所有者的地方才写新代码。

## 背景

早先的方案把隧道当作无管理的工作区 Provider：一种新的远程 Host，带只读浏览器和只等待结果的命令。对照仓库核查后发现，这种形态与现有体系相冲突：

- 远程 Host 注册表围绕 Cognia 语义定义：`RemoteHost.config` 是 `CompanionConfig`，激活会安装全局 `CompanionTransport`，管理通道按 Companion `deviceId` 判断过期。
- ADR-0082 在 2026-08-13 的修订中写明“no parallel remote-development transport is authorized”（不批准任何平行的远程开发传输）。原始 VS Code CLI 协议（端口 31545 上的 MessagePack）就会成为这样一条传输。
- 原始 CLI 协议没有根目录限制、没有 compare-and-swap 写入、没有 PTY，也无法确认进程已终止。
- 方案中的 Node 模块路径 `sidecar/src/remote-host/` 不是已声明的 sidecar layer，会导致 `audit:sidecar-architecture` 失败。

以下事实也塑造了这些决策。

**可达性与配对**

- 无头 Host 会自己连接 Cognia relay；配对后，桌面和手机无需任何入站端口即可访问它（ADR-0224）。
- CLI 的 `forward {port, public}` RPC 会给 dev tunnel 增加一个 TCP 端口，并返回其 URL：`https://<tunnelId>-<port>.<cluster>.devtunnels.ms`。这个转发保存在 `code tunnel` 进程内（`PortForwardingProcessor`）：客户端断开后仍然存在，`code tunnel` 重启后丢失。
- CLI 提供 `fs_mkdirp`、`fs_write`（流式写入，无权限位参数）和 `spawn`（argv、cwd、env、管道，不脱离父进程）。
- `cognia-server service install --scope user` 已经能写出 `systemd --user` 单元或 LaunchAgent，在缺少 master key 时创建它（`ensure_master_key_file`），并采纳一个安装根目录。但 `adopt` 不做逐文件哈希校验，只有 `InstallHome::stage_archive` 会做。
- `cognia-server pair` 会打印一个有效期五分钟的 bearer 所有者邀请（`cgnp4`）；不带 `--direct` 时，它会拒绝生成无 relay 的邀请。
- 面向机器读取的 CLI 只输出文本（`service status`、`pair`）。

**Linux 归档**

- 目前没有原生 Linux host 归档，连 macOS 归档也没有 CI 作业在构建；打包只是一个本地 `host:archive` 脚本。
- 如 `Dockerfile.cognia-server` 所述，Linux 上的 `cognia-server` 二进制链接整套 Tauri 桌面栈（GTK 和 WebKit 动态库）。no-tauri 无头构建是 ADR-0059 已登记的后续事项。
- 默认的 `ocr-paddle` feature 要求 glibc 2.38 或更高版本。

**Host 信任边界**

- `request_origin`（`crates/cognia-companion-security/src/request_origin.rs`）只把 Cloudflare 的请求头识别为隧道标记，也不读取 `server.rs` 已经附加的 `TransportPlane` listener 标签。dev tunnel 的转发同样来自 `127.0.0.1`，因此转发任何现有 listener 都会把 loopback 权限交给公网：operator 端点、service token、单用户 Owner 邀请和预认证限流豁免。转发明文的浏览器 listener 还会授予 `LoopbackPlaintext` 执行权限。

**客户端信任**

- `companion_endpoints` 已经上报一个 `tunnelBaseUrl`；客户端已经会合并它、在它消失时清除它，并把它作为候选尝试。无头 Host 目前不上报这个值。
- `pickTrustMode` 只给 `*.trycloudflare.com` 系统信任。只要已知 Host 的自签指纹，其他任何主机都会被 pin 到这个指纹，而在 Capacitor 上这会直接失败（fail closed）。命名的 Cloudflared 域名今天也受同样影响。

**现有 GitHub 凭据**

- `ghCliToken` 读取 `gh` CLI 的令牌。
- `integration-github-credentials` keyring 存储保存 PAT 和 App 账号。
- 两者都在 TypeScript 中实现，而渲染进程本来就为 Octokit 持有 GitHub 令牌。
- 目前没有 GitHub device flow；唯一的 device flow 实现属于 Codex 订阅。

**微软账号与平台状态**

- VS Code CLI 的微软路径使用 `/organizations` 租户，按定义只接受工作或学校账号。
- Dev Tunnels 仍是无 SLA 的公开预览。

## 1. 一个安装器 crate，位于远程 shell 接口之后

新 crate `crates/cognia-host-installer/` 位于 `scripts/gates/rust-architecture.json` 的 **service** 层，与已经使用相同 foundation crate 的 `cognia-deploy-agent` 并列。它的 Tauri 命令放在 `tauri-host` feature 之后（ADR-0196）。取这个名字是为了避开无关的 `cognia-bootstrap-agent`。

该 crate 负责一个小型 `RemoteShell` 接口：

- 探测操作系统、架构、init 系统、linger、glibc 和剩余磁盘；
- `stat` 与 `mkdirp`；
- 声明长度和 SHA-256 的流式上传；
- 一次性执行：argv、cwd、显式 env、等待预算和有界输出。

执行结果分为 `Completed`、`NotStarted` 和 `Unknown`。策略沿用两种现有形态：`IdempotencyDecision::Indeterminate`（从不重放），以及 `JobStatus` 中 `Failed` 与 `Interrupted` 的区分。错误沿用 `SandboxSpawnError` 的 refused 与 fault 之分。由适配器实现该接口：VS Code 隧道适配器先交付，之后是基于 `cognia-terminal` 的 `russh` 客户端和已保存 profile（ADR-0162）的 SSH 适配器。

安装器驱动现有的所有者，只给它们补上薄薄的入口：

- **版本选择与目录校验：** 用 `cognia_update_catalog`（`verify_signed_catalog`、不带当前版本调用 `select_host_release`、`HttpUpdateNetwork`、`TrustFile`）。桌面下载归档并核对目录中的摘要。
- **远端校验与暂存：** 上传后，远端先用系统校验工具复核归档摘要，再只解出 `bin/cognia-server`，由它通过一个新的薄 `cognia-server` 子命令暂存归档。该子命令包装现有的 `InstallHome::stage_archive`（摘要、清单、契约、逐文件哈希）和 `commit`。因此远端执行的校验与自更新完全相同，没有任何手工解包。
- **服务：** 用 `cognia-server service install|status|uninstall --scope user`。install 已经会创建 master key，且从不替换已有的 key，所以没有单独的 `init` 步骤。`service status` 增加 `--json`，安装器读取结构化状态而不是解析文本。
- **健康检查：** 经远程 shell 读取 `/healthz`（`server_id`）和 `/readyz`。
- **配对：** 用 `cognia-server pair`；只有在用户确认的仅隧道分支上才使用 `--direct --advertise-url`。

安装器从不自己写单元文件；凡是能补结构化输出的地方，都不解析自由文本；也从不把机器建模为 server-ops 的 `DeploymentTarget`。

## 2. 隧道客户端是按会话启动的 Node helper

TypeScript Dev Tunnels SDK（MIT，`@microsoft/dev-tunnels-*`）运行在 `services/` 下的一个 Node helper 包中，像 `services/workspace-runtime` 一样登记在 `pnpm-workspace.yaml`。暂存脚本复用 `scripts/build/stage-browser-runtime.mjs` 的摘要标记逻辑，挂到 `predev`/`prebuild`，产物加入 Tauri 资源。

**生命周期。** 安装器为一次会话（一次引导、一次修复或一次 ensure-route 调用）启动 helper，会话结束即停止。

- 它不自动重启：helper 崩溃会隔离（fence）该会话，任何进行中的执行都变为 `Unknown`。
- 它复用现有部件：
  - 用 `cognia_core::node_runtime::node_executable()` 获取内置 Node；
  - 用 `cognia_exec_sandbox::proc_group` 管理进程组；
  - 沿用 local-browser 的 stdin 密钥交接方式，令牌从不出现在 argv 或环境变量中；
  - 沿用 `cognia-plugin-runtime` 中 `PluginHost` 的 NDJSON 请求/响应形态。

**协议。** 封闭的操作集：discover、connect、stat、mkdirp、write、spawn、forward、unforward、close。它从不接受自由的 MessagePack 方法、任意端口或 `spawn_cli`。

- CLI 控制协议把已被间接锁定的 `msgpackr` 改为直接依赖，并做有界解码。
- 关闭转发端口的自动本地监听，保留 SDK 的主机密钥校验。
- 不改动 Agent sidecar 及其 feature-call 路径。

**暂不采用 Rust `tunnels` crate：** 它只能通过 Git pin 使用，没有重连和令牌刷新，还会引入 `russh` 0.37 与 OpenSSL。

## 3. 安装的 Host 是无头的、用户态的、经过校验且从不被覆盖

- **支持的机器。** Linux x64 和 arm64，以及 macOS arm64 和 x64。Windows 直接拒绝并说明原因。
- **先做无头构建。** 只有在 `cognia-server` 的 no-tauri 无头构建就绪后，才发布 Linux 归档。即 `cognia-server` 成为独立、不依赖 Tauri 的包：ADR-0196 的 P8（RPC families 经 `RpcHost` 迁入 `cognia-companion-rpc`）与 P9，也就是 ADR-0059 的后续事项，同时让服务端镜像瘦身。在 `app_lib` 上加 cargo feature 做不到：Linux 上 `tauri` 无条件链接 GTK（`muda` 依赖 gtk3）。Linux 归档是否去掉 `ocr-paddle`，在该阶段根据它对 glibc 基线的影响决定；低于记录基线的机器会在探测时被拒绝。
- **归档打包。** `scripts/build/package-host-archive.mjs` 与 `scripts/release/update-catalog.mjs` 增加 `linux-x64` 和 `linux-arm64`，复用现有的清单、Node pin 和归档布局。Linux 的完整性由签名目录摘要加清单中的逐文件哈希保证；codesign 仍只用于 macOS。
- **CI。** 第一个为四个目标构建 host 归档的 CI 作业，复用 `publish-agent-hosts` 的矩阵形态和现有的 `ubuntu-24.04-arm` runner。此后自更新像覆盖 macOS 一样覆盖 Linux。
- **范围。** 只用用户态，不用 sudo。探测会检查 systemd linger；若未开启，会明确告知 Host 会在用户登出时停止，重启后要等用户登录才会运行。没有 systemd 或 launchd 的机器直接拒绝。
- **已有安装。** 安装器通过 `service status --json` 检测已有安装，提供全新安装、修复或重新配对。它从不替换已有的 master key 或数据目录。
- **生命周期。** “从机器上卸载”（`service uninstall` 加移除安装根目录）与“忘记 Host”是两个独立操作。删除数据目录需要第二次键入确认。升级是 Host 自更新，从不重跑安装器。

## 4. Host 经专用入口 listener 与现有隧道槽位发布隧道

**入口。** Host 新增一个绑定 `127.0.0.1` 的隧道入口 listener。它以 `spawn_browser_listener` 为模板，用一个新的 `TransportPlane` 变体标记，从不复用 `Plaintext`。

- `request_origin` 增加 listener 类型参数，所有调用点（fleet 路由，以及 operator、service token 和限流中间件，还有邀请）都要传入它。入口 listener 上的请求无论 peer 或请求头是什么，都不算直接 loopback。
- 只转发这个端口。
- dev tunnel 会设置哪个转发请求头，由 S1 实测。之后只在入口 listener 上从该请求头读取限流身份，就像对 Cloudflared 读取 `cf-connecting-ip` 一样。

**路线。** 转发以 `public: true` 创建。TLS 由微软终结，与 Cloudflare 今天的做法相同；Host 的设备认证保护每一次调用。Host 沿用现有的配置模式（`browser_access` 的 `save_and_apply`，在 `serve` 时重新应用）持久化这条路线。设置和清除它的 host-admin 命令按 `protocol/companion-verbs.json` 命名，加入 `protocol/companion-commands.json` 后重新生成。

`companion_endpoints` 通过现有的 `tunnelBaseUrl` 上报路线，优先级为：先是运行中的 Cloudflared 隧道，其次是命名 Cloudflared 域名，最后是已发布的 dev tunnel 路线。不新增 endpoint 字段、credential book 字段或响应 schema 结构。

**客户端。** 改动只有两处：

- `pickTrustMode` 对等于 Host 上报的 `tunnelBaseUrl` 的 URL 使用系统信任，其他 URL 仍然 pin。这取代硬编码的 `trycloudflare` 规则，也修复了命名 Cloudflared 域名被误 pin 的问题。
- `classifyWsHost` 已经把 `devtunnels.ms` 归入隧道层，保持不变。

**自愈。** 持有隧道凭据的桌面会幂等地重建转发并重新登记 URL。这一步挂在现有的连接与存活路径上：`probeHostConnection` 和 liveness 成功分支，像 host 更新那样经 `withManagementChannel` 调用，不新增后台循环。隧道凭据从不交给远端机器。若 `code tunnel` 重启时没有桌面在线，手机会暂时失去备用路线，直到有桌面回来；relay 始终是主路线。

**仅隧道配对。** 若引导时远端连不上 relay，会告知用户：该 Host 只能经隧道路线访问。用户明确确认后，安装器以 `pair --direct --advertise-url`（值为隧道 URL）配对。这正是 ADR-0224 要求的操作者显式请求。

## 5. 凭据与配对复用现有的所有者

**GitHub 凭据只有一个归属。** 隧道访问使用现有的 TypeScript GitHub 账号层：

- `integration-github-credentials` 中的账号（PAT，以及隧道服务接受时的 App）；
- 经 `ghCliToken` 获取的 `gh` CLI 令牌，加上数字用户 ID 校验；
- 新增一个 Cognia 自有的 GitHub OAuth device flow provider，登记在同一个存储中。其客户端沿用 Codex device flow 的 request/poll/cancel 形态，UI 复用 Codex 添加账号对话框中的设备码展示。

隧道服务接受其中哪些，由 spike S3 验证。Cognia 从不读取 VS Code 的凭据存储，也从不冒用 VS Code 的 OAuth client id。

**令牌传递。** 每次操作由渲染进程解析令牌，经 IPC 交给安装器命令，再经 stdin 交给 helper。令牌只在内存中，从不记录日志、不重复持久化，也从不放进 argv。这与渲染进程今天为 Octokit 持有 GitHub 令牌的做法一致；另建一套 Rust 凭据层会重复现有的账号存储。

**微软账号。** 作为 spike S4 并行进行：验证工作或学校账号、个人账号，以及 Cognia 自有 Entra 应用能否申请 Dev Tunnels scope。只交付通过验证的部分，并且走同一个账号层。

**隧道绑定。** 经引导安装的 Host 的注册表记录增加一个可选的公开 `tunnelBinding`：provider、账号引用、数字账号 ID、cluster id、tunnel id、标签和入口端口。可选字段经过 store 的 `partialize` 和 `merge` 不会丢失，因此不需要提升持久化版本。该绑定从不改变 `CompanionConfig`、激活或路由。

**邀请处理。** 安装器在内存中把 `pair` 邀请交回现有的配对流程。

- 把 `PairStep.completePairing` 现有的预检（传输诊断、凭据存储就绪）抽成一个共享函数；`PairStep` 和安装器流程都调用它，之后调用 `registerPairPayload` 和 `persistPairing`。
- 邀请从不显示、记录或持久化。
- 兑现邀请使本桌面成为所有者，与粘贴邀请的效果相同。

## 6. 同意、进度与审计复用现有 UI

引导本质上是在用户机器上远程执行代码。上传任何内容之前，同意步骤按常驻 Host 的同意模式展示：目标机器、账号、步骤、磁盘、服务范围、linger 的后果，以及等同 shell 的访问（ADR-0162）。

UI 复用现有组件：

- **入口：** 现有 `AddHostForm` / `AddHostSheet` 中的第三种添加方式。
- **进度：** 沿用 server-ops 操作时间线和 creator 步骤栏的阶段状态词汇。
- **确认：** 第二次键入确认使用 `ConfirmActionDialog`。
- **修复：** 使用现有 `HostControls` 中的修复入口。
- **卸载：** 经 `lib/devices/section-plan.ts` 规划的一个新设备分区，与现有的 host 分区并列。

每个阶段都以不透明的操作 ID 记入现有的审计和诊断系统。邀请、令牌、归档内容和命令输出一律不记录。

## 阶段

计划为每个阶段列出了文件、测试和退出条件。

0. **Spike（门禁）：**
   - S1：公网转发、防钓鱼中间页、WebSocket 升级、转发请求头，以及转发的持久与丢失。
   - S2：归档大小的 `fs_write` 与安装程序 `spawn`。
   - S3：隧道服务接受哪些 GitHub 令牌。
   - S4：微软账号，并行进行，不阻塞。
1. **Host 入口与隧道路线：** 入口 listener、感知 listener 的来源分类、路线持久化、host-admin 命令、`tunnelBaseUrl` 优先级与客户端信任。
2. **无头构建：** 不依赖 Tauri 的 `cognia-server` 包（ADR-0196 P8/P9）。RPC 文件有并发修改，因此在独立 worktree 中分批迁移；第 4 阶段的安装器不等它，先用 macOS 归档验证。
3. **Linux host 归档：** 打包、目录、CI 作业、自更新与文档。
4. **安装器：** 安装器 crate、`cognia-server` 的暂存子命令与 `--json` 入口、隧道 helper 与 GitHub device flow。
5. **Devices UI：** 经 VS Code 隧道安装、修复、修复路线、卸载与忘记，两种语言齐全。
6. **SSH 适配器：** 给 `cognia-terminal` 的 SSH 客户端增加一个公开的 exec 入口。
7. **微软账号适配器**，在 S4 通过后进行。

在第 5 阶段通过真实隧道的冒烟测试之前，该功能放在本地开关之后，默认关闭。

## 影响

- 远程 Host 注册表保持仅限 Cognia，不新增 provider 判别字段、伪造的 `CompanionConfig` 或平行传输。
- ADR-0059 的 no-tauri 无头构建成为必须交付的前置项，服务端镜像随之瘦身。
- Linux 获得原生 host 归档，常驻 Host 文档中的 Linux 安装路径随之成真；host 归档也第一次有了 CI 作业。
- Host 增加第二个 loopback listener。它的来源分类是结构性的，Cloudflared 之后也可以迁到同一个入口。
- `pickTrustMode` 不再 pin Host 上报的隧道 URL，也顺带修复了手机上的命名 Cloudflared 域名。
- ADR-0170 的非目标“无头 Host 上的隧道或 mDNS”范围收窄：无头 Host 可以发布 dev tunnel 路线，但仍不运行 Cloudflared，也不运行 mDNS。
- Cognia 发布第一个远程安装器，它依赖微软的预览服务。失败情形都是用户可见的状态，不会被静默降级：隧道不可达、缺少 systemd、glibc 不受支持、凭据被拒。

## 备选方案

- **把隧道作为无管理的工作区 Provider**（已被取代的方案）。否决：它在仅限 Cognia 的注册表里加入第二种 Host，而原始协议没有路径限制、compare-and-swap、PTY 或终止保证。
- **把机器作为 server-ops 的 `DeploymentTarget`。** 否决：部署目标是由控制器纳管、使用 mTLS agent 的 compose 或 Kubernetes 栈；用户的机器应作为 ADR-0224 对端完成配对。
- **用沙箱 Provider trait（`RemoteProvisioner`、envd）充当远程 shell。** 否决：它们创建的是容器实例，也没有向运行中目标传输文件的能力。
- **客户端 SDK 加原生 loopback relay**（F2）。私有且 TLS 端到端，但每个客户端都要常驻 SDK 会话，手机被排除在外。保留为 S1 失败时的备选。
- **新增 `publicRoutes` 列表。** 否决：需要改 credential book、封闭的 endpoint schema 及其 CLI 镜像；而引导出的 Host 都是无头的，现有 `tunnelBaseUrl` 槽位本就空闲。
- **识别 dev tunnel 代理请求头**，代替专用 listener。否决：请求头一旦缺失，就会静默授予 loopback 权限。
- **Rust 凭据代理。** 否决：会在现有账号存储之外形成第二套 GitHub 凭据层。
- **用当前二进制直接打 Linux 归档。** 否决：要么要求远端装 GTK 和 WebKit（需要 sudo），要么捆绑共享库，体积大且脆弱。
- **由 Host 持有密封的隧道凭据**来自行修复转发。暂时否决：为了桌面已能提供的便利，在远端机器上长期存放账号令牌。
- **由远端自行下载归档。** 否决：多出第二个信任锚，并要求远端能访问更新服务。
- **内嵌 `vscode.dev`。** 适合人工编辑，但不会给 Cognia 带来 Host，因此与本记录无关。
