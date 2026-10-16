---
title: "0228 — 托管桌面验收已交付的提交"
description: "由 Host 持有的 E2B 桌面复用 computer-server 生命周期与独占控制租约，接收不可变的代码交付，并记录私有、受限且随任务删除的证据。"
---

# ADR 0228 — 托管桌面验收已交付的提交

第一阶段实现说明（2026-10-15）：首个 operator smoke harness 仅支持验证网络 `Off`；`On` / `Allowlist` 在类型、UI 和测试中均保持明确的未资格化状态。非空区域选择在 placement 能真正执行前会被拒绝。真实 provider smoke 尚未授权或运行。原生编译因磁盘不足中断，并按用户要求跳过。验证记录及剩余门槛位于 `docs/plans/2026-10-15-managed-cloud-desktop-phase1-verification.md`。

**状态：** 已接受——用户于 2026-10-15 批准 ADR-0228、第一至四阶段及可信来源前置依赖的实施。真实 provider smoke 仍须另行提供凭据并明确授权，通过资格验证前生产能力保持休眠。  
**日期：** 2026-10-15  
**范围：** Linux 浏览器与 Linux GUI 验收，使用用户自己的 E2B 账户，支持桌面及 headless 执行 Host 和已认证客户端。v1 不要求特定区域。  
**相关：** [0020](./0020-computer-use-completeness)、[0055](./0055-agent-browser-loop)、[0072](./0072-browser-action-recording)、[0153](./0153-the-host-obtains-the-confirmation)、[0182](./0182-a-project-names-the-image-it-runs-in)、[0183](./0183-the-agent-is-brought-to-the-image)、[0196](./0196-a-library-crate-links-tauri-only-when-asked)、[0213](./0213-conversation-history-has-a-manager-and-the-archive-freezes-place)、[0221](./0221-a-remote-sandbox-is-a-provider-behind-the-same-seam)。

## 决策

采用 **E2B 与按摘要固定的 Cognia computer-server 镜像**，由选定的 Host 在用户的 E2B 账户中准备。扩展 `SandboxProviderAdapter`、现有桌面租约和查看器，不暴露第二套 provider 专属 GUI 路径。只有经过明确授权的真实 provider 冒烟验证确认了镜像、认证和原生到期销毁行为，才能启用生产能力；此前保持禁用。

每个计费桌面都由人授权。子验收执行测试一个不可变的已交付提交，报告 agent 判定，并可另外记录人工批准。它绝不合并代码或完成来源任务。检查点与失败截图受限、仅所有者可见，并通过任务／对话的规范删除路径清除。

四个交付阶段依次为生命周期 adapter、已认证控制／查看器、任务交接和结果关联。阶段 3、4 要求独立的交付账本工作先合并。第一至四阶段及可信来源持久化实施已获授权；第四阶段在核实已提交的历史／删除基线后获准实施。

## 背景：扩展两条路径，同时保留各自的所有权

`crates/cognia-sandbox-pool/` 中的代码任务路径使用远程 E2B/Kubernetes provider、固定的运行时镜像和 agent bundle。GUI 路径使用 `lib/sandbox/lifecycle-contract.ts`；唯一的生产 adapter 是 `docker:computer-server`。`adapter-registry.ts` 中有意不注册 `cua-cloud` 和 `lume`。

当前桌面代码已经提供 15 秒可续期人工租约、agent／人工共用的变更互斥锁、帧校验，以及输入清理结果不确定后的隔离状态（`cua_sandbox/desktop_session.rs`）。`use-sandbox-desktop.ts` 和 `sandbox-desktop-viewer.tsx` 已有接管 UI。它们缺少云端所有者／设备授权和持久化的 provider 清理。原生客户端当前构造 `ws://host:port/ws`，并要求 Cognia 的认证协议。仅注册一个云 factory 无法补足这些保证。

以下证据于 2026-10-15 从共享工作树读取，其中包含其他会话尚未提交的工作；并非全部存在于本隔离文档工作树中：

| 复用边界 | 所属路径 | 所需扩展 |
| --- | --- | --- |
| 生命周期与类型化拒绝 | `lib/sandbox/{lifecycle-contract,adapter-registry,connection-lifecycle,connection-capabilities}.ts` | 小范围移除 factory／输出仅适用于 Docker 的假设；保留状态／能力检查及禁止本地回退 |
| GUI／工作区目标一致性 | `types/sandbox/index.ts`、`lib/sandbox/{binding,session-runtime}.ts` | 子验收使用同一个 GUI 与 shell／文件绑定；保留来源任务绑定 |
| 原生桌面控制 | `crates/cognia-automation/src/cua_sandbox/` | provider 无关的资源访问、受保护的云传输、绑定主体的租约 |
| Host 同意机制 | `crates/cognia-companion/src/host_consent.rs`、`crates/cognia-companion-security/src/admin_lease.rs` | 复用已认证的批准与撤销；绝不信任调用方的 `confirmed` 标记 |
| 代码交付，待集成 | `crates/cognia-sandbox-pool/src/{delivery.rs,docker/remote_prep.rs}` | 消费合并后的记录契约，不依赖并发编辑中的文件或可复用 agent ID |
| Git 与预览 | `crates/cognia-sandbox-pool/src/{git_proxy.rs,docker/ports.rs}`、`crates/cognia-companion/src/environment_ports.rs` | 明确的只读 Git 模式；实时预览继续休眠 |
| 历史清理 | `lib/chat/{session-archive-writes,session-deletion}.ts`、`lib/db/sessions.ts` | 在规范路由级联中加入持久化证据删除意图 |

ADR-0055/0072 的浏览器录制是可选、明确指定的验收输入，不是可迁移的浏览器会话，也不是成功证明。DOM ref 随引擎 generation 失效；不复制 cookie 和密码值。ADR-0183 的 agent bundle 不是桌面镜像，不应成为 GUI 启动无关的前置条件。按照 ADR-0196，所有新增 Rust 行为放入 crate，而非应用外壳模块。

## 备选方案与当前 provider 证据

调研区分已公开能力与经过测试的集成。来源检索于 2026-10-15。本设计未使用凭据、创建资源或执行 provider 冒烟测试。

| Provider | 生命周期／控制 | 隔离与现有 server | 价格／TTL／区域 | 决定 |
| --- | --- | --- | --- | --- |
| E2B Desktop／自定义模板 | 创建／连接／检查／销毁；标准桌面 SDK 提供截图／输入和 VNC | Firecracker VM 边界；支持自定义 Linux 镜像，Cognia 镜像兼容性待冒烟验证 | 公开 CPU／RAM 计费；Hobby 1 小时、Pro 24 小时；宣传支持 US/EU/APAC，须核实账户实际可用区域 | 首个 provider，使用自定义 computer-server，而非新增原生 GUI driver [S1–S7] |
| Cua 托管 Fleet | 文档描述 claim、续期、释放、gateway 和默认 15 分钟 claim TTL；不支持云端挂起／重启 | gVisor 容器或 KubeVirt VM；当前镜像使用 cua-spacesd，而非 Cognia 的加固 server | 账户相关的小时费率；托管区域／可用性未确认。首页称 Cua 不托管／出租机器，与云文档矛盾 | 在核实可用性和协议前保持休眠 [S8–S10] |
| GCP VM + 桌面 | 实例生命周期；Linux 桌面服务或 Windows RDP，另需 agent 输入 API | 原则上 VM 可运行 Linux server／容器 | 按机型／区域、磁盘和网络计费；原生持续时长／截止时间可配 DELETE，30 秒至 120 天，发起终止最多延迟 30 秒 | 可行的自带云账户备选，但镜像／网络运维更多 [S11–S13] |
| AWS EC2 + VNC/xrdp/DCV | 运行／检查／启动／停止／终止；显示协议不同于 computer-server | 原则上 Linux VM／server 可行 | 区域／机型 + 磁盘／网络；EC2 包含 DCV 许可。已查阅的 RunInstances API 中未找到简单的销毁 TTL，需外部终止机制 | 运维范围更大，TTL 资格验证仍有缺口 [S14–S17] |

原生 E2B 截图／输入 driver 需要新增控制 driver，并重新证明租约／帧／隔离语义。保留 Cognia server 可复用既有协议。旁路运行原始 VNC/RDP 端点会允许绕过租约输入，因此不允许。不得借用现有 Cua 类型名表示 E2B。

## 1. 已认证的所有者与选定 Host 持有桌面

权威身份为 `(ownerPrincipalId, executionHostId, providerConfigId, desktopId, generation)`。验收记录另加来源对话／任务／运行及交付 ID。Host 从认证上下文推导所有者和设备／服务主体；浏览器参数不能选择别人的账户。Provider 计费身份与 Cognia 所有权分开。

在 `remote-sandboxes.json` 旁存放版本化 `managed-desktops.json`，包含所有者范围内的 provider、默认放置、限制、发布版本／模板绑定和启用证据。桌面与 headless Host 使用同一领域服务。复用凭据来源和证明概念，而非代码沙箱中围绕镜像／bundle 的 `RemoteProvisioner`。已有代码 provider 配置不隐式成为桌面配置。

桌面领域逻辑扩展 `cognia-automation/src/cua_sandbox/`；新增托管资源／journal 模块有充分理由，因为 Docker 内存 registry 既不提供云资源对账，也不提供证据存储。从当前私有的 `cognia-sandbox-pool/src/remote/e2b/api.rs` 提取可复用 E2B HTTP／构建基础能力，放入不依赖 Tauri 的小型 `cognia-e2b` crate，由两个 provider 共用。代码运行时准备与桌面策略仍分开；不要把整个 sandbox-pool driver 引入 automation。提取必须保留代码 provider 的行为及其定向契约测试。

Provider key 是只写 Host secret，通过 `managed-desktop:<owner-scope>:<provider-id>` 引用。服务器 env／文件来源需要管理员控制的所有者映射。Provider key、Git 凭据、模型 key 和 Cognia 设备 token 绝不进入 renderer、guest、交接 manifest 或日志。Computer-server 端点 secret 是独立的窄权限凭据：由 Host 生成，由可信 server 持有，从工作区子进程中剥离，绝不返回浏览器。必须作此区分，才能认证 server 而不授予 provider 账户权限。

凭据轮换和 provider 删除先禁用新工作。在确认资源不存在前，保留清理所拥有存活资源的权限；删除设置行不能遗忘计费资源。账户／Host 切换清空 renderer 投影并撤销控制。另一个 Host 持有相同 provider 凭据，不代表它有权接管本 Host 的桌面。

## 2. 向每个用户的 E2B 账户分发不可变发布版本

Cognia 发布以 OCI 摘要寻址的 Linux 镜像，并通过既有可信发布渠道分发 release manifest。Manifest 指明镜像摘要、架构、computer-server 版本／协议、构建配方 revision 和预期健康身份。运行时身份绝不使用 `latest`。

首次经用户明确授权的设置／使用时，Host 验证 registry manifest／内容摘要，再在选定用户的 E2B namespace 中构建固定配方。缓存返回的模板 ID 和**精确 build ID**，按账户绑定、镜像摘要、配方 revision、架构和资源规格索引。E2B 支持启动特定 build，而非可变 tag。复用必须匹配已登记的精确 build 与 Host 记录的来源；无关模板即使标签相同也不够。[S4, S18, S19]

当前代码 provider 的缩短摘要 alias 和任意 ready build 查找不足以完成此检查。其摘要验证针对 agent-bundle 下载，不是桌面来源保证。当前客户端也没有经过验证的账户／team 身份查询。模板绑定到 Host 的所有者／provider 凭据 generation 及明确选定的 namespace；API 支持时使用 provider 验证的稳定账户 ID。凭据变化会使此绑定失效，除非账户连续性已验证。绝不将能访问 alias 当作账户身份。

Host 在调用 provider 前记录构建意图；对结果不确定的构建进行对账，而非重复提交。限制每个绑定的并发构建；启动时不主动构建或预热桌面。模板准备及其可能产生的 provider 费用与桌面计算分开展示，要求明确用户授权，agent 建议或后台设置刷新不构成授权。

创建使用精确 build 引用。准入检查 release／image／recipe／protocol 和资源规格；GUI 访问前，健康检查验证预期 server 身份。摘要／版本不匹配、build 缺失、架构不支持或来源缺失，都给出可操作的拒绝原因。绝不静默复用旧模板。运行时身份与可信构建回执提供完整性检查，不构成针对 provider 或用户 provider 账户管理员的硬件证明。

明确授权的冒烟测试可通过受限管理探针置备待验证 build，此时生产创建仍禁用。该权限绑定到特定 owner／config／build／shape／deadline，使用相同 journal 与清理流程，不能成为 agent 旁路。按精确配置保存冒烟证据；镜像、配方、协议、入站、出站或区域变化会使相关证据失效，要求重新验证。旧模板不自动删除：保留现有清理所需映射，另行提供明确的模板清理操作。

## 3. 准入展示成本并拒绝无法满足的运行时长

v1 策略规定**每个 Host 上每个 owner/provider 最多 2 个并发桌面**、**3,600 秒硬性存活期**和 **600 秒空闲超时**。这些值同时是默认值和上限；配置可以收紧，不能提高。v1 不提供持久化、暂停／恢复或自动重启。Provider 套餐允许时长独立检查：Pro 的 24 小时额度不会延长 Cognia 的 60 分钟上限。请求超过任一限制时，明确拒绝并指出适用限制，绝不截短。

调研文档中，Hobby 最多允许 3,600 秒，Pro 最多 86,400 秒。创建前比较完整请求时长和账户允许时长。超限时返回请求值与允许值，绝不静默截短。未知／过期 entitlement 不能授权更高限制。Provider 的拒绝具有权威性，绝不能触发缩短时长后的重试。[S2, S3]

不假设存在账户 entitlement 或价格 API。阶段 1 必须核实可用只读 API。若无法查询 entitlement，则使用带日期、由操作人员确认的账户计划绑定提供预检上限；实际创建被拒时仍保持失败关闭。未知绑定阻止创建。检测到账户计划变化时使绑定失效。不得后台创建临时计费资源来推测计划限制。

在用户点击 Create 前，展示选定 CPU／RAM、区域、费率／币种／来源时间、请求存活期，以及该时长内桌面计算的最大估算成本。Host 验证绑定配置的短期 quote；重大变化要求重新确认。计算 `ratePerHour × lifetimeSecs / 3600`，展示时向上取整。按调研费率，公开示例中 2 vCPU、4 GiB 约为 **$0.1656/小时**，因此 **60 分钟约 $0.17**。计划订阅费、税、模板准备和其他 provider 费用单独说明，不隐藏在声称的账单上限中。价格未知时，配置带日期的估算前阻止普通创建。[S2]

这是基于 provider TTL 保证的计算费用估算，不是 provider 计费／TTL 失效时的绝对财务保证。从创建到销毁的全部运行时间都计入，包括就绪等待时间。确认的较短空闲存活期可降低实际费用。创建／删除结果不确定时仍占用容量。限制不跨 Host 协调：多个 Host 使用同一个 E2B 账户可能总共超过两个桌面，展示的单会话估算也不是账户总预算。v1 接受并明确标注这一限制。

## 4. 创建同意与控制租约是不同权限

Agent 可以建议验收并准备 manifest 草案，不能准备计费模板、创建桌面或为自己签发创建授权。用户操作取得 Host 记录的单次授权，绑定 owner、source、quote、provider 和 deadline。通过可信请求来源与主体权限区分人工控制界面和被委派的 agent／service 调用；布尔值 `userInitiated` 不是证明。重复请求返回同一个已记录操作，而非另建桌面。结果不确定时，在原授权下对账。

设置和提权管理复用 ADR-0153 的已记录同意／admin lease，包括 Owner／service-root 规则及成员不能自批的要求。这些豁免不赋予任务 agent 长期支出权限。Worker 只取得已授权验收执行的委派权限。敏感操作继续遵守现有 automation 策略／同意路径；headless Host 使用 Host 同意／事件服务，不能假定 Tauri ConsentBroker 可远程工作。

扩展现有输入租约，加入 owner、Host、device／agent 主体、acceptance ID、desktop generation 和 fencing epoch。保留 15 秒租约、5 秒续期。任何时刻只有一个控制者；获授权的观察不要求持有输入控制权。Host 对每次变更重新验证当前 fence 和帧，包括异步等待之后。

人工接管阻断新的 agent 操作，释放已按下按钮，并在共享互斥锁下等待确认静止。清理结果不确定时隔离桌面，拒绝新控制者。第二个人不能静默夺取控制。断线、账户切换、撤销、到期和 Host 重启使租约失效。重连不自动恢复 agent。显式释放／恢复取得新帧。截止时间／销毁优先于一切控制。

第二阶段仅在取得独立 GUI 资格记录后启用人工控制，该记录绑定与生命周期资格相同的配置和精确模板。Agent 输入及生产验收委派在第三阶段继续休眠，直到第四阶段及资格验证完成。用户控制请求取得一个覆盖 acquire／renew／release／input 的 ADR-0153 admin lease；查看器复用该租约，不在后台弹出授权。管理租约到期即停止输入，须由用户显式重新请求。新的 15 秒控制租约不能延长管理权限。Headless 敏感操作同意复用现有 Host 同意提示和持久化 automation 策略；策略损坏时拒绝控制。

使用现有查看器／hook 和具备认证的 Host RPC。不得直接把当前 Client/Internal 命令暴露为远程命令。浏览器客户端取得 Host 授权的帧／输入通道，绝不取得 provider 账户 key、E2B traffic token 或可独立交互的 VNC 链接。受保护云传输使用 TLS、受限 URL／重定向策略及 server 身份验证。测试 guest 认证时，须保留 provider 入站认证而去掉 Cognia server token；只有 provider 403 不能证明 guest 会拒绝未授权调用。

第二阶段仅在单独的 GUI 资格记录通过后开放人工控制，该记录绑定生命周期资格对应的配置和精确模板。Agent 输入及验收委托在第三阶段前保持休眠。用户请求控制时取得一个覆盖 acquire/renew/release/input 的 ADR-0153 admin lease，查看器复用它且不在后台弹出授权请求。Admin lease 到期即停止输入，必须由用户重新请求；新的 15 秒控制租约不能延长 admin 权限。Headless 敏感动作通过现有 Host 同意提示及持久化 automation policy 执行，损坏的策略会拒绝控制。

## 5. 生命周期 journal 在 Host 或 provider 不可用时仍可恢复

复用 `SandboxProviderAdapter` 和公开生命周期状态。为资源事实增加持久化 Host journal，不建立平行 UI 生命周期系统。分别记录资源状态、控制租约、验收结果和清理状态。

| 转换 | 持久化行为与恢复 |
| --- | --- |
| 准入／创建 | 验证 owner、authorization、quote、template、entitlement、policy 和 capacity。Provider 调用前持久化创建身份及预留。请求有限 TTL，设置 `onTimeout=kill` 且禁用 auto-resume；验证有效设置 |
| 创建结果未知 | 保留预留；按所有权 metadata 和 operation/build 身份对账。不能盲目重提。若无法确认唯一性则阻止继续，并展示对账状态 |
| 连接／运行 | 验证精确拥有的 resource/generation、剩余硬截止时间、协议及完整解码截图。重连既不创建也不延长存活期 |
| 空闲 | 600 秒没有活跃验收工作或获授权交互活动则销毁。截图／健康轮询不算活动；停滞验收有有限进度超时，不能无限续期 |
| 到达截止时间 | 阻断输入和新工作，取消执行并停止证据捕获，再销毁。任何有界 flush 都必须在剩余时间内完成；宽限不得延长 provider TTL |
| 销毁重试 | 在确认不存在前保留资源、配额和清理权限。标记 `destroyRetrying` 并禁止复用；首次 15 秒后重试，指数退避上限 600 秒 |
| 重启 | 仅对本 owner 和 Host deployment 已记录／带标记的资源进行对账。恢复待销毁任务和截止时间；绝不恢复旧输入 token，也不自动重跑验收 |

Host 使用绝对截止时间，重连时传递剩余时长。原生 provider TTL 是 Host 失联的兜底，必须**销毁**，不能暂停、保留快照或在访问时自动恢复。时间流逝或状态请求失败不代表删除已确认。只有观察到 provider 资源不存在才能释放预留。所有权标签和 journal generation 防止某 Host 清扫另一个 Host 的资源。

状态更新带 revision，并在确认前原子持久化。关闭时保留取消与有界重试，不启动无人负责的 detached task。功能禁用时仍展示待清理状态。回滚只禁用新工作，不停清理。监控最老的待创建／删除操作、计费资源数、拒绝代码和证据积压；资源超过截止时间 60 秒、清理超过 10 分钟时告警。指标使用有限 provider／status 维度，不包含文件名／token。

## 6. 放置复用隔离证明，拒绝更弱执行环境

增加 provider `e2b`、driver `computer-server`；不改变 `cua-cloud` 的含义。明确选择的 provider 具有权威性。`auto` 表示本 Host 配置的合格托管桌面默认项，不是代码池溢出、更便宜账户或用户本地桌面。

Host 重新检查 owner、release、region、shape、剩余 quota、capabilities、最低 isolation 和 network policy。随验收证据保存请求／实际放置和执行状态。复用 ADR-0221 的 tier 词汇与出站证明；代码 E2B adapter 的证明不自动代表此镜像／产品／传输已经合格。

限制公网入站，阻止私网／链路本地／metadata 出站。域名策略必须说明 E2B 文档中的限制：80 端口 HTTP Host 和 443 端口 TLS SNI；其他端口需 CIDR，QUIC 不受域名过滤。拒绝无法实现的必需策略；绝不为了安装脚本、Git 或预览而静默放宽出站。Host 中转的 Git／文件传输只限获授权来源，不是通用 Host 网络隧道。[S5, S6]

### MMDS 工作负载隔离修订（2026-10-16 已接受）

E2B 托管桌面的隔离对象包括所有处理交付源码、运行桌面或应用的工作负载进程。
这些进程必须由内核强制阻断私网、链路本地和元数据地址，包括沙盒本地 MMDS。
首版 egress-Off 使用仅有 loopback 的独立网络命名空间，并限制进程、挂载和 IPC
可见性，使用非特权身份、no-new-privileges 并移除 capabilities。桌面、导入/Git、
验收启动的全部路径都必须在处理不可信内容之前进入隔离边界。无法建立边界或缺少
必需内核能力时，必须拒绝并清理，不能退回普通启动。

Provider envd 初始化属于独立的可信控制面，可保留其必需的沙盒本地 MMDS 访问。
此例外不能向工作负载暴露网络通道、特权 socket、继承描述符或特权执行服务；也
不代表“整个 VM 内的所有进程均无法访问元数据”。Provider egress-Off 策略与 guest
内核隔离必须同时成立。GUI 入站仅经过固定目标的本地桥接，不增加通用出站代理。

Provider 侧观察和工作负载隔离证据分别记录。保留历史失败记录；新的资格版本必须
绑定准确镜像、隔离策略、模板、owner/config 和会话 generation。工作负载探测必须
包括元数据地址及所有实际启动路径；任一元数据响应或越界均判失败。不能用配置值、
guest 自报成功或缺失测试代替实测。镜像或隔离策略变化使旧资格失效，后端、API、UI
三个层面均保持 dormant，直到所需真实 smoke 通过。

监督进程和固定 relay 也属于工作负载网络命名空间之外的可信控制面；它们不能解析项目内容、接受任意目标地址或向工作负载暴露隔离外执行能力。源码导入采用非特权隔离身份；所有导入子进程退出后，文件晋升使用基于目录描述符的 no-follow 操作，并拒绝符号链接、硬链接和特殊文件。后续应用启动继承完整桌面隔离策略，而不只是网络命名空间。独立生命周期守卫必须在监督进程死亡后终止所有子进程并关闭入站，包括 Host 断连时。

Host 重启必须重新验证边界；缺少能力、generation 不明确或探测失败时拒绝并进入销毁／重试。全端口阻断通过无外部接口／路由／继承外部 socket 的不变量和代表性直接传输探测证明，而不是穷举端口扫描。现有生命周期和控制验收断言全部保留。

用户于 2026-10-16 批准本修订及实施。先在 E2B 内验证必需的内核隔离和固定 GUI 传输；失败时 provider 继续阻断。生产保持 dormant，dev 合并暂停，按用户要求跳过 Rust 测试。已接受的实施计划及证据门禁见 `docs/plans/2026-10-16-managed-desktop-mmds-isolation.md`。

依据：[固定版本 E2B MMDS 初始化](https://github.com/e2b-dev/runtime/blob/a1899fb840e1eb1ef2c0ffc751c639959ed6a144/packages/envd/internal/host/mmds.go)、[固定版本 MMDS 路由](https://github.com/e2b-dev/runtime/blob/a1899fb840e1eb1ef2c0ffc751c639959ed6a144/packages/envd/internal/host/mmds_route_linux.go)、[Linux 网络命名空间语义](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)，核查日期 2026-10-16。源码行为不代表托管运行环境已通过资格验证。

## 整体审查边界（2026-10-16）

生命周期请求在排队操作完成后、以及实际付费请求之前，重新核验当前账户、admin lease、provider 配置和凭据 generation。资源已创建或删除请求已接受后，持久化清理权限不因调用方退出账户而失效。生命周期、交接和结果客户端要求 registered 或 paired Host 配置明确绑定当前解锁账户，缺少归属的旧配置会被拒绝。浏览器客户端在账户、锁定状态或 Host 配置变化时使进行中的操作失效，即使状态随后恢复原值。原始交付 Host 绑定在账户同步中保持设备本地属性。

验收写入采用 Host 领域幂等：通用安全存储只绑定请求键和载荷哈希，不保存结果、错误正文或操作回执。每次重试都重新经过当前权限和证据删除屏障。截图重试返回原先绑定的证据，不再拍摄新帧。切换来源后的旧结果以及过期的人工批准响应不能覆盖当前视图。

Git 导入命令运行于独立进程组，在成功、失败、取消或 future 释放时清理整个进程组。非 Unix Host 在具备等价进程树隔离前，于启动 Git 之前明确拒绝此导入；这是 Host 限制，与 Linux 客体范围分别记录。固定 commit、只读 Git 和 recovery bundle 校验保持有效。

整体审查和当前 `dev` 集成冲突记录于 `docs/plans/2026-10-16-managed-cloud-desktop-integrated-review.md`。Rust、实际 UI 和真实 provider 验证仍未完成，生产启用入口继续保持 dormant。

## 7. 交接是基于不可变来源的一次新验收执行

**依赖 D1：** delivery 提交 `ff3c51c617deb351caf07415d25d4b59467e6fe0` 已合入。用户随后授权先补齐可信来源，再实施第三阶段。原任务的认证准入现持久化 owner／Host／device、conversation／task、由 Host 生成的 coding-run ID、规范化仓库及仅 Host 可解析的凭据引用；delivery 绑定该 source ID。原对话的 run 引用只在准入时记录为 `originRunRef`，与 Host 的权威身份分开，不能成为后续浏览器声明的授权依据。缺少来源的旧记录拒绝交接。来源撤销标记跨重启保留；规范删除路径在丢失持久链接前，向所记录的来源 Host 撤销。实现位于独立第三阶段 worktree，尚未提交；Rust 测试已编写但按用户要求跳过。验证边界见 `docs/plans/2026-10-15-managed-cloud-desktop-phase3-verification.md`。第四阶段在相同休眠发布边界内实现最终历史投影与结果删除。

第三阶段诊断将 `parentRunId` 绑定到 Host coding run，另外保留 `originRunRef` 供后续历史投影；独立记录 child／source／delivery／desktop generation，并计算完整交接 manifest 与传输 manifest 的摘要。生产执行继续禁用。唯一可执行入口是原生 `handoff-smoke`，要求明确计费授权和逐次报价批准，始终请求销毁桌面。元数据准备不会计费。首版启动仅允许在固定仓库根目录明确执行 `npm run <script>`，不隐式安装依赖。镜像配方 3 增加 Git／nodejs／npm，旧配方资格不能复用。传输包含完整 Git 历史；选中文件的排除规则不等于净化仓库历史。

创建子验收执行；绝不重绑来源任务。版本化 manifest 包括 owner／Host、来源 conversation/task/run/delivery ID 和 delivery revision、精确 commit、branch label、transfer mode、acceptance-file hash、launch argv/cwd、测试标准、resource generation 和 deadline。阶段 3 支持同 Host 已发布提交重建及恢复 bundle 导入。跨 Host 传输和实时预览隧道保持休眠。

**已发布提交：** 验证交付授权，由 Host 解析仓库，通过明确的**只读 Git proxy** fetch，checkout 精确 SHA 并验证。分支名是定位信息，不是验收身份。现有 proxy 允许向任务分支 push；阶段 3 必须实现独立只读模式，在联系上游前拒绝 receive-pack discovery 和 POST 请求。不得改变现有代码任务的发布权限。测试直接／smart-HTTP push 变体、重定向和仓库替换，不只测试成功 clone。

**恢复 bundle：** 按获授权 delivery ID 解析 Host 文件，绝不接受浏览器给出的路径。当前导出是上限 512 MiB 的增量 Git 数据，不是完整文件系统快照；通过只读 proxy fetch 获批准的前置对象，验证 bundle/hash/commit，导入私有 staging 并 checkout 精确 SHA。缺少前置对象、来源不干净／不可恢复或 hash 不符都拒绝。实现有界分块传输，不把 bundle 强塞进现有 8 MiB 桌面上传接口。传输前预留磁盘，执行累计大小／hash 校验，取消时删除部分 staging。

验收文件使用明确 manifest，v1 限制为 **100 个文件、总计 32 MiB、每文件 8 MiB**，与 bundle 上限分开。拒绝路径穿越、symlink 逃逸、特殊文件和验收根目录之外的覆盖写入。保留 secret 占位符；不自动复制 `.env`、本地浏览器 profile、cookie 或 vault 数据。启动使用 argv，而非拼接 shell 文本。私有应用登录是独立的用户控制操作，不代表获准导出 provider／Git 凭据。

桌面从固定 checkout 启动自己的预览应用。来源任务的 `localhost` URL 不可迁移。提供的公开预览 URL 可作描述性上下文，但不得静默替代被测试来源。实时预览转发需要来源／桌面租约同时有效、精确端口授权，以及来源不可用结果；v1 明确不支持这些能力。

## 8. 证据有界、私有，并归属于原始历史

使用持久化 acceptance record，关联来源 owner／Host／conversation／task／run／delivery、精确被测 commit、desktop generation 和 manifest digest。与 `TaskDeliveryRecord.publish` 及尽力而为的 automation audit 分开。将引用投影到现有 task/run history 和 artifact 界面，不把截图字节存入消息或数据库列表行。

复用 `types/execution/run.ts` 的 verification artifact、计数和不透明 `detailsRef`，在验收 run 中发出 `artifact.created`。`parentRunId` 指向 coding run，保留 `sessionId`／`sourceId`。`lib/db/execution-runs.ts` 拒绝向终态 run 追加事件：不得重开或向已完成 coding run 追加。30 天 run-event 保留期移除旧事件后，权威结果仍可读取；证据遵循来源 task/conversation 保留规则，而非 event TTL。之后的人工批准是独立的 revisioned record，不是对终态 run 的非法追加。取消使用 run 的取消结果，不伪造 verification enum 值。

记录逐项标准结果，并区分 `passed`、`failed`、`inconclusive`、`cancelled`。Agent 判定与人工批准各自保留主体／时间来源；两者互不覆盖。置备失败、来源过期、缺少必需证据或标准未完整执行都不能通过。后续来源 commit 需要新验收 run。发布结果与清理状态独立：可以表达证据已保存但销毁待完成。

只捕获明确检查点和失败。v1 每次验收上限为 **100 张截图、总计 100 MiB、每张 8 MiB**，以先达到者为准。摄取时执行编码字节上限、支持格式和解码像素边界校验；失败／部分上传也计入有界 staging。不得删除早期证据来静默容纳更多截图。报告 `evidence_limit_reached`；必需截图无法保留时，对应标准标记未完成，结果为 inconclusive。不连续录像；除非明确请求，不在人工输入敏感值时截图。

证据文件遵循 Host 的 owner 范围 artifact 存储／访问规则，使用不透明 ID、content hash 和持久化 manifest。应用所属存储的加密策略和严格文件系统权限；UI 不得寻址任意路径。先 staging、hash 并原子发布文件，再标记结果完成。完成重试须幂等。截图读取和导出重新检查 owner/history 授权。默认不创建分享链接，不自动公网上传、跨账户去重或发送模型。现有模型／工具流程保留 PII gate；文本脱敏不声称可以清理任意截图像素。

以 `automation/record/assets.rs` 的 containment／opaque-ID 模式和已认证 session-media 访问为先例，不将 recording bundle 或浏览器 Dexie 变成第二所有者。证据读取使用 `Cache-Control: no-store`；删除及账户变化时撤销内存／object-URL 预览。不得复制现有 session-media 的一年 immutable 缓存头。不得将截图提升为 `library:`／kept 所有权，否则会违背要求的删除级联。任何系统都无法撤回用户主动导出或自行复制的截图。

禁止自动提交模型的要求适用于已存储的检查点／失败证据。Agent 实时感知仍使用既有、经明确授权的 computer-use 模型路径及其图像／隐私策略；存储 artifact 不授予任何额外的模型上传权限。

### 删除遵循 ADR-0213，包括离线与崩溃恢复

归档表示保留：保存结果，但不恢复验收 run。真正删除 conversation/task 时撤销查看／控制并移除其证据。入口仍为 `deleteSessionsRouted` → 所属 Host intent 或 `deleteSessionsWithTeardown` → 权威数据库级联，不新增独立查看器删除按钮。Task 删除必须调用同一 owned-evidence cleanup 契约，包括后代。

在该级联中扩展持久化删除 outbox，在**元数据引用丢失前**写入 owner、来源 identity、acceptance ID 和 opaque artifact ID。先执行 handoff lock 和其他规范删除 guard；拒绝删除时不得移除证据。可行时，数据库删除和 outbox 插入共享所属事务；Host-native 存储使用带确认的幂等 journal bridge，绝不声称存在跨数据库原子事务。Host replay 在释放字节前对账权威删除状态。

现有级联不包含 `executionRuns`、`executionRunEvents` 或 `runResultSummaries`；阶段 4 必须明确解析／移除所属 acceptance 投影和原生证据。不得把尽力而为的 sync tombstone API 当作清理队列。在 `lib/storage/retention.ts` 和所属 Host 启动服务注册保留／清理；renderer 的 retention initializer 不能提供 headless 清理。待清理任务须在普通 sync tombstone 到期后继续存在。

删除提交后，tombstone 立即拒绝访问，并阻断迟到的捕获／结果写入。后台 Host worker 取消存活验收、销毁桌面并删除文件／staging／manifest，在崩溃或文件系统失败后重试。远程删除已排队不代表物理删除已完成。在确认清理前，保留最小的不含内容 tombstone／outbox；展示待清理／清理失败。启动 sweep 对账有界 staging 和已 tombstone 文件。不得留下未追踪孤儿文件；离线 Host 显示待处理，而非谎报已删除。

删除所属来源 task/conversation 或 acceptance run，都会移除该验收的截图字节；其他仍存历史链接显示明确的证据已删除状态。v1 不隐式复制截图到导出／备份。用户请求的外部导出无法远程擦除，导出时必须说明。绝不因迟到的 provider event 重建已删除 task/result。

## 9. 休眠与兼容性是发布契约

| 休眠功能／状态 | 类型／契约轴 | UI 轴 | 测试轴 |
| --- | --- | --- | --- |
| E2B 待设置／冒烟验证 | `unqualified` 原因及 false runtime capabilities | 禁用 create，显示可操作的设置／冒烟原因 | 无授权／资格验证不得计费创建或回退 |
| 后续实现阶段 | 独立 lifecycle/control/handoff/results capability gate | 解释不可用操作，不提供看似可用的控件 | Registry + 实际 Host dispatch + UI 拒绝测试 |
| 项目自动验收 | 明确不支持的 trigger policy；agent 建议没有支出权限 | “自动验收不可用”；建议需要用户操作 | Agent／后台／重连不能构建模板或创建桌面 |
| 实时预览／跨 Host 交接 | 不支持的 transfer mode | 禁用并标注 | Host 拒绝伪造 mode；不回退到凭据／隧道旁路 |
| 持久化／暂停／恢复和 Cua/Lume | 现有／新增 capability 声明保持 false | 本地化不可用标签 | Adapter／capability 测试固定拒绝行为 |

Docker 行和行为保持兼容。只为已交付操作递增 capability revision；保留 handshake narrowing。旧客户端拒绝未知 provider，而不是强转 Docker。Host state 具有权威性；客户端缓存经净化，按 target/owner 隔离并带 revision。必要的 Dexie 投影迁移使用既有迁移协议，本 ADR 不预占 schema version。

阶段 1 可以在内部验证生命周期，不暴露未完成 GUI；阶段 2 可在明确创建授权下提供人工桌面使用。阶段 3 的交接保持开发禁用，直到阶段 4 的持久化证据／删除闭环启用。每个阶段仍须有可达测试／诊断入口，不能把无人引用的模块宣传为已完成。禁用标记保留状态／删除／对账能力。

## 验证与发布

详细计划为 `docs/plans/2026-10-15-managed-cloud-desktop.md`。每个阶段包括同目录 TS 测试／Rust 文件内测试、UI／拒绝文案的两种拆分 i18n locale、一个 `cognia-next` changeset 和 `wiring-auditor` 审查。只运行定向检查；不运行全量测试或 coverage。Cargo 编译前检查 `df -h`。新增 Rust 领域逻辑保留在 crate 中，Tauri 专属 wiring 放在适当 feature 之后。

真实 provider 冒烟要求用户凭据和明确 go-ahead，包括精确 account、shape、deadline 和估算支出。覆盖私有模板构建／来源与不匹配拒绝、授权／未授权传输、截图／输入、Host 重启／重连不延长存活期、删除重试，以及 **Host controller 停止期间短 provider TTL 到期**。重连／inspect 必须证明资源被销毁，而非暂停或自动恢复。Mock 测试不证明该保证。Hobby 超限请求必须说明原因并拒绝，不得静默变成一小时请求。

相关冒烟与契约检查通过后，按 owner/provider 启用。任何跨 owner 访问、租约旁路、凭据泄漏、错误来源判定或 TTL 失败都阻止启用并禁用新工作。回滚时保留清理和历史证据。D1 合并前阶段 3／4 不得开始；删除级联变更也须等待当前 history 工作合并，避免竞争编辑。

## 第四阶段实现边界（2026-10-15）

用户在可信来源工作后授权第四阶段。D2 使用已提交的历史／删除契约 `eca3bd038b56d378f35a87e03b8b503e4cb3c313`，已包含于独立 checkout 基线 `6f52d4f356d477f2786ad57c41442878417ffa35`；实施前确认共享 checkout 的对应路径没有未提交改动。未复制或修改其他会话的工作。

Host 现持有加密验收索引和有界加密检查点／失败截图。绑定保留 source／conversation／task／Host coding run／原始 run 引用、固定 delivery revision／commit、manifest digest 和 desktop generation。Agent 判定、诊断系统结果和带 revision 的人工批准分别记录。生产 agent 委托在资格验证前仍硬性禁用；计费诊断可以保存检查点与 **inconclusive 系统结果**，不能伪造 agent 判定。创建休眠时，历史读取与删除仍可用。

运行详情和来源对话概览查询所属 Host，将子验收 verification artifact 投影到现有运行历史，不修改已终止的父运行。截图由用户明确打开，通过 `Cache-Control: no-store` 返回，校验完整性后使用可撤销的内存 URL 展示。截图字节、本地路径和 bearer URL 不进入运行事件或浏览器持久化。原生备份复制器显式排除 `managed-desktop-evidence`；没有新增分享／导出路径。

ADR-0213 删除使用 v244 账户本地、无内容的 outbox，以及带确认的原生 prepared／committed／aborted journal。Prepared 冻结证据；被拒绝或回滚的事务执行 abort。Host 离线时保留持久化待清理记录，不谎称远端字节已消失。Committed 永久阻止迟到写入，移除验收投影并重试字节／桌面清理。对话、任务和单次验收删除汇入同一机制；归档保留证据。任务删除的重启重放通过规范 backend，并使用**原始持久化 device 约束**，不把本地 HOME 中不存在文件当作完成证明。多 Host 对话删除在来源撤销后向各所属 Host 获取任务 ID。待清理记录不随普通 sync tombstone 过期。

实现及定向验证记录见 `docs/plans/2026-10-15-managed-cloud-desktop-phase4-verification.md`。Rust 测试已编写，但按用户要求未运行。不声称浏览器／Tauri／provider 端到端资格已通过；所有计费 smoke 仍须用户提供凭据并明确授权。

## 审议记录

| 日期 | 范围 | 状态 |
| --- | --- | --- |
| 2026-10-15 | Linux、自带 provider 账户、不限制区域 | 用户已确认 |
| 2026-10-15 | E2B／固定 server；commit + bundle；2／60 分钟／10 分钟；用户触发；私有检查点／失败证据 | 用户已确认，包括模板、entitlement、成本、依赖和删除要求 |
| 2026-10-15 | 本 ADR 的具体契约和详细阶段计划 | 用户已接受；第一至四阶段及可信来源前置依赖已授权；真实 provider smoke 未授权 |

剩余外部证据是启用 gate，不是凭空假设的保证：支持的 E2B account identity／entitlement API、实际模板 provenance 字段、安全 WebSocket 行为、provider 原生到期行为与区域资格。阶段 1 负责人在启用前，使用已记录 API 和获授权冒烟解决这些问题。产品所有者已于 2026-10-15 接受本 ADR 并授权第一至四阶段及可信来源前置依赖的实施；尚未约定发布截止日期。

## 来源

检索于 2026-10-15；支出前重新核实账户 entitlement 和价格。上面的相关 ADR 和精确所属路径是仓库证据；并发的 delivery/history 增补明确属于待合并依赖。

- **S1：** [E2B computer use](https://docs.e2b.dev/use-cases/computer-use) — Linux 截图／输入和 VNC。
- **S2：** [E2B pricing](https://e2b.dev/pricing) — $0.000014/vCPU/s 和 $0.0000045/GiB/s；Pro 基础费 $150/月另加用量费；运行时计划限制。2-vCPU／4-GiB 示例是算术估算，不是经测量的必需规格。
- **S3：** [E2B lifecycle](https://docs.e2b.dev/sandbox) 和 [billing limits](https://docs.e2b.dev/billing) — timeout、kill、pause 和连续运行上限。
- **S4：** [E2B base images](https://docs.e2b.dev/template/base-image) — 支持的自定义 Linux 镜像。
- **S5：** [E2B ingress protection](https://docs.e2b.dev/network/restrict-public-access) — traffic-access token 与受保护公网 URL。
- **S6：** [E2B internet access](https://docs.e2b.dev/network/internet-access) — deny/allow 和域名过滤限制。
- **S7：** [E2B deployment regions](https://e2b.dev/) 和 [Firecracker isolation](https://e2b.dev/resources/introducing-e2b-embed)。
- **S8：** [Cua cloud guide](https://cua.ai/docs/cua-sdk/guides/cloud) — claim 生命周期和运行时。
- **S9：** [Cua Fleet images/rates](https://cua.ai/docs/cua-sdk/reference/fleet/images)。
- **S10：** [Cua homepage](https://cua.ai/) — 自带电脑定位；托管可用性尚未确定。
- **S11：** [GCP runtime limits](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime)。
- **S12：** [GCP RDP](https://docs.cloud.google.com/compute/docs/instances/connecting-to-windows)、[Linux desktop](https://docs.cloud.google.com/architecture/chrome-desktop-remote-on-compute-engine)。
- **S13：** [GCP machine shapes](https://docs.cloud.google.com/compute/docs/general-purpose-machines)、[regional pricing](https://cloud.google.com/products/compute/pricing/general-purpose?hl=id)。
- **S14：** [EC2 RunInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html)、[TerminateInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_TerminateInstances.html)。
- **S15：** [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/)。
- **S16：** [Amazon DCV administrator guide](https://docs.aws.amazon.com/pdfs/dcv/latest/adminguide/dcv-ag.pdf)。
- **S17：** [EC2 stop/start storage costs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html)。
- **S18：** [E2B exact-build references](https://docs.e2b.dev/template/tags) — build ID 固定与可变 tag。
- **S19：** [E2B template build](https://docs.e2b.dev/template/build) — 账户 key 构建及返回的 template/build ID。
