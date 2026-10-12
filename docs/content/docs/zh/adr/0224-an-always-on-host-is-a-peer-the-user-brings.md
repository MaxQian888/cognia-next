---
title: "0224 — 常驻 host 是用户自带的对等设备"
description: "用户自带的机器（VPS、NAS、家里的 Mac mini）运行 headless cognia-server 与 brain，作为常驻 host。它是桌面端的对等设备，而不是让桌面变成客户端的服务器。bot、连接器与定时任务按条目归属，可以移交给它；手机与桌面经中继连接，无需公网域名；派发的工作默认在容器中运行；密钥经配对通道下发并在 host 上封存；无人值守的审批事先声明、在沙箱内放宽、需要人时挂起。阶段 A 交付手动归属的独立 host；阶段 B 把归属迁到 ADR-0215 执行租约并自动故障转移；阶段 C 增加团队执行节点。"
---

# ADR 0224 — 常驻 host 是用户自带的对等设备

**状态：** 已接受
**日期：** 2026-10-10
**相关：** [ADR-0059](./0059-cloud-deployment-headless-brain)（headless brain）、[ADR-0215](./0215-one-person-one-encrypted-sync-space-many-writable-hosts)（§8 执行租约）、[ADR-0136](./0136-cross-device-placement)（放置与计时权威）、[ADR-0061](./0061-cross-device-workflow-execution)（能力词汇；P5 brain 放置）、[ADR-0170](./0170-cognia-relay-and-connectivity-center)（中继配对）、[ADR-0175](./0175-the-rpc-face-has-one-grammar-one-error-and-one-version)（单一版本）、[ADR-0182](./0182-a-project-names-the-image-it-runs-in) / [ADR-0221](./0221-a-remote-sandbox-is-a-provider-behind-the-same-seam)（沙箱）、[ADR-0174](./0174-the-bot-control-plane)（bot）、[ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)（headless 权限）、[ADR-0113](./0113-agent-team-multi-host-remote-dispatch)（worker）
**计划：** `docs/plans/2026-10-10-always-on-host.md`

## 背景

用户的笔记本一休眠，bot、IM 自动回复、定时任务和从手机派发的工作就全部停止。常驻 host 需要的部件都已存在，但没有接起来：

- `cognia-server` 监管一个 headless Node brain，它已经运行调度器、bot 投递、连接器、工作流、agent team 和聊天（ADR-0059）。它的打包只有一个 Compose profile 和单副本的 Kubernetes StatefulSet，没有任何东西把它安装成系统服务；持久化默认是防抖的 JSON 快照。
- 手机和桌面通过直连 TLS、WebRTC 或端到端加密中继连接 host（ADR-0021、ADR-0170）。运行中的 server 签发带中继房间的 `cgnp4` 邀请，所以 NAT 后面的 host 无需域名即可配对。
- 桌面运行的一切都只归桌面所有。定时任务、bot 安装和连接器实例没有归属字段；计时权威是桌面 `localStorage` 里的一个全局值，brain 永远拿不到；ADR-0061 P5（「cron 与 webhook 落到 brain」）从未实现。桌面没有在路由的 host，其在线状态是过期的，所以 ADR-0136 的五分钟接管可能导致重复触发。
- 桌面激活远程 host 后就成为它的客户端：自己的连接器、bot、调度器、MCP 服务和本地 agent 全部停用。远程激活只有一个槽位。
- 无人值守的运行一旦遇到工具请求审批就直接拒绝，而不是挂起（`unattended-permission-responder`）。headless host 可以在封存存储里保存连接器凭据，但没有模型 provider 密钥的静态存储。只有交互式聊天控制器会请求沙箱放置；从手机派发的运行没有项目工作目录。
- ADR-0215 已经决定了长期模型：一个加密同步空间，数据到处复制，执行由账号对象授予的 30 秒租约控制，按顺位故障转移（headless server，然后是最近活跃的桌面），绑定本机的资源固定在创建它的设备上。其中租约（phase 4）和密钥类（phase 5）尚未实现。

## 决策

### host 是用户自己的机器，并且是对等设备

机器由用户自带：Linux VPS 或 NAS（Compose），或 Mac（原生服务，或桌面 App 的常驻模式）。Cognia 不负责开机器，也不为机器计费。host 运行与 ADR-0059 相同的 `cognia-server` 和 brain，服务一个账号。

常驻 host 是桌面的对等设备。两者都能执行；任何一方都不会因为拥有常驻工作而让另一方变成客户端。桌面通过**管理通道**管理常驻 host：用 `openRemoteHostTarget` 打开的一条独立连接，供 host 面板使用（状态、归属条目、审批、密钥、迁移、更新）。桌面自己的路由不变。和现在一样，仍然可以为某个会话把桌面路由切到该 host。

存在两种角色：

| 角色 | 运行什么 | 阶段 |
| --- | --- | --- |
| 常驻 host | `cognia-server` + brain：调度器、bot、连接器、工作流、聊天、派发的 agent | A |
| 执行节点 | `cognia-agent worker`（ADR-0113）：接受派发的轮次，不持有数据 | C（团队节点池） |

### 归属按条目

每个定时任务、bot 安装和连接器实例都带一个**归属者（owner）**：负责布防、触发和运行它的 host。运行时跳过不归自己的条目。这个归属字段就是 ADR-0215 §8 所说的固定（pin），所以阶段 B 把它变成租约偏好时无需改模型。

- **新条目的默认：** 已配对且可达的常驻 host 存在时，新的常驻工作创建在它上面。绑定本机的条目留在创建它的设备上。
- **绑定本机**由一个带原因的分类器统一判定：需要本地 shell 或文件系统的任务类型、桌面与桌宠事件触发、文件监听与终端触发、本地路径的项目根、OS 调度器提升项、stdio MCP 服务，以及目标上不存在的密钥链引用。
- **手动固定：** 任何可移交的条目都可以固定到指定 host。被固定的条目在其 host 离线时等待，不会自行转移。

### 移交是一次 handoff，不是复制

迁移按四步把条目移交给 host，参照 ADR-0103 的会话 handoff：

1. 在 host 上**预检**：协议匹配、host 能力、所需插件及其版本、凭据、项目范围、绑定本机的原因。列出每个阻断项，不静默跳过。
2. **传输**条目所需：缺失的插件在用户确认后以签名 cogpack 传输（ADR-0209）；密钥经配对通道下发；定义通过以迁移操作 id 为键的幂等创建写入。
3. **确认** host 已创建并布防。
4. **围栏**本地副本：保留为停用占位，owner 为该 host。本地运行时忽略它；UI 显示它在哪里运行，并提供「收回」。

配对后，引导流程列出所有可移交条目，标出绑定本机的条目及原因，并移交用户勾选的条目。阶段 A 不做自动故障转移：归属 host 离线时，占位会提示，用户可以收回。自动故障转移随阶段 B 的租约一起到来。

### 每个触发都有稳定的发生键

两个 owner 永远不会布防同一条目；此外每个触发都带一个由「发生」本身派生的键，而不是由 host 察觉它的时间派生：

- webhook、集成事件和连接器消息使用 provider 的投递 id 或平台消息 id。
- cron 和定时任务使用计划时间槽，而不是唤醒时间。
- bot 定时 tick 使用时间槽，而不是随机记录 id。

这修复了一个现存缺陷（同一秒内的两个事件被合并成一次运行，第二个负载丢失），并为阶段 B 的租约持有者提供一道跨交接仍有效的围栏。交接后错过的时间槽，按现有的分类型补跑表补跑一次。

### 连通：中继优先，无需域名

- 配对使用 `cgnp4` 中继邀请，CLI 会同时打印终端二维码。无法打开中继房间的 host 拒绝打印不带中继的邀请，除非运维明确要求直连邀请。
- IM 连接器优先使用由 host 主动外连的传输（飞书长连接、Telegram 长轮询、Discord gateway）。只支持 webhook 的平台需要用户自己提供域名或隧道。Cognia 不增加托管的入站缓冲；所有 host 都离线时，依靠平台自身的重试。
- headless host 的推送通过现有的 APNs/FCM/HMS 扇出到达手机锁屏。

### 打包与生命周期

- **Linux：** Compose 的 `server` profile。**macOS：** 独立安装包（cognia-server、brain 布局、sidecar、Node），用 `cognia-server service install` 安装为 LaunchDaemon，开机即启动、无需登录。桌面 App 另外提供常驻模式：关闭窗口留在托盘、登录时隐藏启动、持有系统防休眠断言，并报告自己正在作为 host 服务。
- 一个服务安装器同时服务 `cognia-server` 和 worker 守护进程。
- 常驻 host 默认使用 `sqlite-v5` 存储。已有的快照账号在切换前导入，绝不重新初始化。
- **更新：** host 跟随用户的发布通道，在空闲时自我更新，server 和 brain 一起替换，健康检查失败则回滚。自动更新默认开启，可以关闭。
  - **一个发布单元，由 host 自己校验。** 签名的更新目录把一次 host 发布列为一条 `host-server` 条目（macOS 归档的 sha256，或 Compose 镜像的 digest），与同版本的一条 `host-brain` 条目配对；两者都写明命令契约。host 只接受配对完整的发布，因此不会安装只发布了一半的版本，这与运行时拒绝「只更新了一半的 host」是同一条规则。host 自己校验目录（`crates/cognia-update-catalog`，即 `lib/updates/catalog-verify.ts` 的 Rust 版本，两者固定在同一份测试夹具上）。产物不另行签名：它们的 digest 写在已签名的 targets 文档里。
  - **Worker 只能扣住发布，不能推出发布。** host 还会询问更新 Worker 的 `/v1/rollout` 接口，该版本是否已对它所在的分桶放量，这让 `pause` 和 `abort` 成为紧急开关。只有当回答中的版本和 digest 与已校验的目录一致时才算数。
  - **签名在离线环境完成。** `scripts/release/update-catalog.mjs` 生成各角色密钥、签署目录，并拒绝签署 host 会拒绝的发布。密钥从不进入 CI 或 Worker。
  - **原生 host 通过切换符号链接更新。** `service install` 把归档复制到数据目录的安装区（`install/versions/<版本>`，经 `install/current` 运行），该目录归服务账号所有。更新时把新版本暂存在运行版本旁边，标记为待定，用一次重命名把 `current` 指过去并重启。新进程处于试运行：其大脑持续被接受后才确认，若大脑被拒、超过十分钟期限，或连续三次启动都没走到那一步，就把 `current` 退回（`cognia_host_service::install_home`、`cognia_companion::host_update`）。
  - **Compose host 从旁边替换。** 容器无法替换自己的镜像，因此由 `cognia-deploy-agent host-updates`（部署代理的独立主机模式，`compose.host-updates.yaml`）持有 Docker 套接字，并在一个只与服务器共享的套接字上监听。服务器只发送通道、分桶和期望的版本，从不发送镜像；代理运行同一套目录与发布节奏检查（`cognia_update_catalog::client`），拉取该摘要，把它作为 `COGNIA_SERVER_IMAGE` 固定在项目的 `.env` 中，用 Compose 记录在服务器容器上的文件只重建服务器，并以同样方式证明新版本（就绪 30 秒即确认；大脑被拒或超过十分钟则退回旧摘要）。被攻破的服务器最多只能请求目录已签名、且 Worker 正在推送的版本。
  - **空闲靠计数，而非假设。** 没有单一标志表示 host 是否忙碌，因此更新器汇总大脑在心跳中上报的运行数、运行中的作业、远程工作机轮次、进行中的写入和有效的管理租约，并在切换期间暂停写入。
  - **主人经管理通道控制。** `host_update_status`、`host_update_refresh`、`host_update_configure` 和 `host_update_install` 是仅限主人的主机管理命令。它们是契约拒绝的唯一例外（其余一切仍遵循 ADR-0175）：契约不一致时恰恰最需要让 host 更新，因此这些命令的形状被冻结。主人的桌面在配对新 host 以及通道变化时推送其更新中心通道，而不是每次启动都推送，因此在主机面板中设置的通道会保留。
- **版本保持完全一致（ADR-0175 不变）。** 不协商版本区间。不一致时以明确的「请更新 host / 请更新 App」状态呈现，并提供一键更新，而不是让调用被拒绝。

### 执行：默认每个任务一个容器

- 常驻 host 上被派发的工作（手机轮次、bot、定时 agent 任务、agent team）由 host 生成沙箱放置，而不只由交互式聊天控制器生成。默认使用沙箱池里的容器，镜像取项目的镜像或 devcontainer；项目可以选择改为在 host 进程中执行。
- host 只能经过一个 Cognia 自有、会检查请求体的 Docker API 代理访问 Docker：只允许带 Cognia 标签的容器、只挂载 workspaces 卷、禁止 privileged、禁止宿主机网络和 PID 命名空间、只对自己的容器开放 exec。推荐 rootless Docker。
- 远程和云端沙箱是 ADR-0221 的 provider，位于同一接缝之后。

### 代码供给

- 项目增加其仓库 remote。host 用用户设备下发的凭据，经共享镜像缓存（ADR-0176）克隆。
- 项目不在设备之间同步。绑定到项目的工作迁移到 host 时，会连同一份只含名称、文件夹和仓库 remote 的项目副本一起过去。默认项目从不迁移。
- **快照移交**携带本地工作：基线 commit 加上未提交改动的二进制安全 diff（已跟踪、未跟踪、删除、权限位），非 git 项目则是有大小上限的归档。host 把它应用到一个全新的任务检出上，基线不符则拒绝。
  - 基线是 `HEAD` 与远程已有分支的 merge-base，因此未推送的提交也包含在 diff 里，无需先推送。diff 针对临时索引执行 `git add -A` 后得到的 tree，该 tree id 随包一起发送：host 用同样的方式重建 tree，结果不一致就拒绝。
  - 它是在 host 上继续对话的代码部分。对话通过现有的线程接力（ADR-0103）移交，接力票据用 host 签发的 id 指明检出；host 把续接的会话绑定到该检出，不会有路径跨越设备。一个管理租约覆盖所有步骤。
  - 从无 blob 镜像派生的检出在镜像为所需提交（带凭据）取回文件内容之前，没有可以检出的内容。镜像会在每次派生和每次接力基线之前先做这一步。
- 结果以推送的分支或补丁集返回，桌面一键应用到新的 worktree。

### 密钥经配对通道下发并在 host 上封存

- 阶段 A 的密钥经配对的 companion 通道下发。这条通道是端到端保护的：直连时 TLS 固定到 host 指纹，经中继时用 ECDH 会话密钥加 AES-GCM。host 用主密钥把密钥封存在加密存储中。
- host 新增模型 provider 密钥的静态存储，按 provider 划分，只能由 owner 设备在交互式管理租约下写入。连接器与 git 凭据使用同一存储。
- 主密钥可来自文件、`systemd-creds` 或 macOS 钥匙串。
- 目前没有审批门的 host 配置命令（推送凭据、bot 安装变更、触发器布防）改为交互类。
- 阶段 B 把密钥下发改为 ADR-0215 的密钥类。

### 无人值守的工作声明权限，需要人时挂起

- 每个 bot 安装和定时任务带一份**权限配置**，经现有只收窄的上限层层折叠。
- 在经过验证的容器沙箱内，workspace 范围内的文件与 shell 操作直接放行。
- 对外发送消息、使用密钥和修改 host 配置始终需要审批。
- 需要人的审批会**挂起**运行而不是结束它：运行发出中断，并发送推送和手机审批卡片；批准后恢复，超时则拒绝。bot 中断走同一条路径。

### 阶段

| 阶段 | 交付 |
| --- | --- |
| **A** | 独立可用的常驻 host：打包（A1）、中继配对（A2）、桌面常驻模式（A3）、设备台 host 状态（A4）、按条目归属与迁移（A5）、封存密钥（A6）、挂起式审批（A7）、默认容器执行（A8）、发生键（A9）、更新与严格版本提示（A10）、代码供给（A11）、桌面关机下的端到端验证（A12） |
| **B** | ADR-0215 phase 4 租约取代手动归属：按顺位自动故障转移，owner 字段成为 pin，密钥改走同步密钥类 |
| **C** | 团队执行节点：worker 通过协作服务的角色登记到团队，带配额 |

## 后果

- 存在常驻 host 时，桌面仍然是完整的 host。管理常驻 host 永远不会切换桌面的路由。
- 阶段 A 中一个条目只存在于一台 host 上。该 host 离线时，它的工作暂停，直到 host 恢复或用户收回。这是有意为之：不可靠的在线信号不能导致重复执行。
- 全局计时权威只保留给没有 owner 的条目。它的在线输入改为会探测未被路由的 host。
- bot 定义跟随其插件：移交 bot 可能在 host 上安装插件，始终需要确认并经过签名校验。
- 与 ADR-0059 一样，host 是单账号、单写入者。团队共享不会把它变成多租户 brain，而是增加执行节点（阶段 C）。
- 已记录的边界：OS 自动化、桌宠、系统剪贴板和本地采集留在桌面（ADR-0059 D7）。只支持 webhook 的 IM 平台需要用户提供域名或隧道。
