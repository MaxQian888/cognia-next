# 沙箱虚拟电脑：行业组件与选型研究

研究日期：2026-10-03。范围：面向 AI agent 的代码、浏览器和完整桌面执行环境；仅查阅官方文档、官方仓库及论文作者原文。本次没有安装、部署、购买服务或连接真实账号，以下是文档核验，不是性能或可用性实测。在线 `main` 和无发布日期的文档是查询时快照，不应视为历史版本的可重现证据；落地前应固定版本、镜像 digest 和部署区域。

## 结论与边界

选型需要拆成四层：隔离运行时、环境生命周期、桌面操作协议、画面与人工接管。浏览器自动化库、VNC 客户端和 VM 管理器解决的层次不同，不能直接互换。

- 完整 Linux 云桌面：优先评估 E2B Desktop；Daytona 作为托管服务对照。
- 本地 Apple Silicon 的 macOS VM：优先评估 Cua/Lume，但区分 MIT 的运行时与 FSL 的 Spaces/streaming 组件。
- 自托管统一调度：对照 OpenSandbox 和 E2B Embed；若已有容器生命周期，不应因为要桌面画面而先重建调度层。
- 仅 Web 工作流：Browserbase 或 browser-use 配合隔离浏览器更直接，无需把整个桌面纳入产品承诺。
- 已有 Linux 桌面：noVNC 是基础显示接入方案；需要视频、音频和更顺滑人工接管时评估 Selkies。

以上是按能力边界作出的工程判断。与 Cognia 现有模块的具体复用位置应结合本地源码审计，本文不宣称已完成集成。

## 八个优先候选

| 候选        | 实际提供的层                                              | 隔离与状态                                                        | 对 Cognia 的价值和限制                                               |
| ----------- | --------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| E2B Desktop | Linux/Xfce 桌面、鼠标键盘、截图、命令文件、整屏或单窗口流 | E2B 官方说明每会话使用 Firecracker microVM；暂停可保留文件和内存  | 快速验证完整云电脑体验；不是 macOS 客体；SDK 已迁入 E2B monorepo     |
| Cua / Lume  | 本地 VM/容器 SDK、跨系统 Driver、桌面操作与 Spaces        | Lume 使用 Apple Virtualization.Framework；Linux 容器可能回退 runc | 本地 macOS 路线最直接；当前 SDK 的 snapshot 不可用，许可按子模块区分 |
| Daytona     | 托管 sandbox、命令/文件、Computer Use、VNC、录屏          | Container 与 VM 是不同 class；仅 VM 支持保留内存的暂停/恢复       | 适合托管服务备选；公开旧核心自 2026-06 起停止维护                    |
| OpenSandbox | 自托管 API、Docker/Kubernetes 生命周期、浏览器/桌面示例   | 默认 runc；可配置 gVisor/Kata；Firecracker 经 Kata、仅 Kubernetes | 适合统一自托管控制面；不能把默认部署等同于 microVM                   |
| Browserbase | 托管 Chromium、CDP、Live View、回放、Contexts             | 浏览器 profile 持久化；本次来源没有证明具体 hypervisor 边界       | Web-only 人工接管与登录持续性；不是完整 OS 桌面                      |
| browser-use | 浏览器 agent/自动化库，可搭配本地或云浏览器               | 库本身不能替代运行环境隔离                                        | 复用 agent 操作能力；避免误认为安装库就有安全沙箱                    |
| noVNC       | 浏览器内 VNC 客户端                                       | 依赖 VNC 服务端和 WebSocket；自身无 VM/容器生命周期               | 已有 VNC 环境的嵌入式桌面视图                                        |
| Selkies     | Linux 桌面视频、音频、输入、剪贴板传输                    | 显示与输入层，不负责运行时隔离                                    | 更丰富远程桌面体验；部署和许可证组成需要逐件核验                     |

### E2B Desktop 与 E2B Embed

Desktop 仓库保留模板与示例，SDK 位于 E2B monorepo 的 `packages/desktop-js`、`packages/desktop-python`。支持完整桌面和单窗口流、只读视图、流认证；同一桌面一次只能开启一条 stream。模板为 Linux/Xfce，仓库 Apache-2.0。[官方 Desktop 仓库](https://github.com/e2b-dev/desktop)

E2B 文档说明暂停默认保存文件系统和内存，也可选择 filesystem-only 并在恢复时重新启动。要把“文件还在”“进程还在”设计为不同状态；文档同时记录暂停拒绝和 auto-pause 内存保存降级的区域性 rollout，不能只根据 SDK 存在方法便承诺任何情况下恢复完整进程。[Persistence](https://docs.e2b.dev/sandbox/persistence)

E2B Embed 当前官方 README 提供单节点自托管、同 SDK/API、Apache-2.0，无需 E2B 账号或 license key。部署目标包括 Linux Compose、云 Terraform 和 Kubernetes。宿主需要硬件虚拟化；Mac 路径是在 Linux VM 内运行，注明 Apple Silicon M3+、macOS 15+。Embed 自身提供 HTTP，TLS 要由外层处理；多节点 private cloud 在该 README 中仍标为开发中。**不应把普通 Apple Silicon Mac 自动视为可直接运行 Firecracker。**[Embed README](https://github.com/e2b-dev/runtime/blob/main/embed/README.md)

其企业页说明每 session 的 Firecracker 内核边界、BYOC 以及网络控制；这些属于厂商架构说明，本次没有验证其生产隔离或性能。[E2B Enterprise](https://e2b.dev/enterprise)

### Cua：最相关的本地 macOS 候选，但必须看当前矩阵

Lume 在 Apple Silicon 上通过 Apple Virtualization.Framework 管理 macOS/Linux VM。当前仓库把 SDK、CLI、Driver、Lume 归为 MIT；Spaces 应用、`cua-spacesd`、Keyvault、Volume、流客户端和 codecs/viewers 是 FSL-1.1-MIT，不应根据仓库总览的 MIT 标签推断所有组件均 MIT。[Cua README 与许可分界](https://github.com/trycua/cua#licensing)

当前 runtime-support 文档明确：本地 Linux container 在有 `runsc` 时用 gVisor，否则 runc；Linux VM 用 QEMU；macOS 用本地 Lume，所述 cloud 路径拒绝 macOS；`Sandbox.snapshot()` 本地和 cloud 均未实现。页面标注 `cua-sandbox` 0.9.0 / `cua` 0.2.0，同时提醒矩阵是源码及离线 contract 证据，不是所有环境的真实启动验证。[Runtime support](https://cua.ai/docs/cua-sdk/reference/runtime-support)

工程建议：先单独评估 Lume + Driver；若使用 Spaces 的 daemon/streaming，实现前审核具体目录许可和产品分发模式。宿主 Driver 操作真实电脑，与隔离 VM 内的 Driver 是两种安全边界。

**Cognia 旧镜像的兼容性需要单独处理。**当前官方矩阵的 Linux image 是 `ghcr.io/trycua/linux:24.04`，computer interfaces 依赖端口 3211 的 `cua-spacesd`，cloud transport 为 gRPC-Web；这不足以证明它与已有 `computer-server` WebSocket 协议兼容。若本地仍使用 `ghcr.io/trycua/cua-xfce:latest`，应先固定已有可用镜像 digest，保留既有 runtime/会话管理并跑协议 contract，再独立评估新 daemon adapter。不能直接替换镜像名称即宣称升级完成。上述 snapshot 限制只针对该页描述的高层 Python `Sandbox.snapshot()`，不应推断为 Lume 或底层 hypervisor 不具备任何快照能力。[协议与运行时矩阵](https://cua.ai/docs/cua-sdk/reference/runtime-support)、[当前组件划分](https://github.com/trycua/cua)

### Daytona：能力完整，开源判断需要更新

Computer Use 官方文档提供鼠标、键盘、截图、显示器与窗口操作、录屏；Linux 启动栈列出 Xvfb、xfce4、x11vnc、noVNC，支持 Linux/Windows，macOS 指向另一服务。[Computer Use](https://www.daytona.io/docs/en/computer-use/)

当前隔离文档明确区分 container namespaces/resource limits 与具有独立内核的 VM。内存持久性文档也区分：container 不支持 pause，停止后必须重启进程；Linux VM/Windows 支持冻结并恢复内存，stop 会清除内存状态。[Isolation](https://www.daytona.io/docs/en/isolation/)、[Persistence](https://www.daytona.io/docs/en/persistence/)

**2026-06 的明确变化：**官方 `daytonaio/daytona` README 公告核心开发迁入私有仓库，公开仓库不再维护或发布更新。因此可评估其托管/BYOC 服务，但不能推荐旧仓库作为持续跟进最新能力的自托管底座。[官方停止维护公告](https://github.com/daytonaio/daytona)

### OpenSandbox：可复用的控制面，而不是自带唯一隔离机制

原 `alibaba/OpenSandbox` 已跳转到 `opensandbox-group/OpenSandbox`。当前项目为 Apache-2.0，提供统一 Docker/Kubernetes sandbox API、命令/代码/文件操作、浏览器与桌面示例、ingress/egress 控制；Fast Sandbox 路径加入 Firecracker 状态暂停恢复。[官方仓库](https://github.com/opensandbox-group/OpenSandbox)

安全 runtime 是管理员配置，默认仍 runc。gVisor 和 Kata 可接 Docker/Kubernetes，Kata-Firecracker 只接 Kubernetes。当前 guide 特别记录 gVisor 的 `nat` 表限制与 egress sidecar 不兼容：`gvisor + network_policy` 被拒绝，需要改用 Kata 或合适的 CNI 策略。文档标题泛称 hardware isolation，但 **gVisor 实际是用户态应用内核**，不能照抄为硬件 VM。[Secure container guide](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md)、[gVisor 官方架构](https://gvisor.dev/docs/)

该组织的 Fast Sandbox README 还区分非嵌套 KVM 与嵌套 KVM 的工程测量，说明 warm-pool latency 高度依赖宿主。本次不把其毫秒指标作为与其他厂商的排名依据。[Fast Sandbox](https://github.com/opensandbox-group/fast-sandbox)

### Browserbase 与 browser-use：浏览器专用路径

Browserbase Live View 可嵌入 iframe，并允许人工交互；Contexts 保存 cookies、localStorage、IndexedDB 等浏览器状态，默认新 session 不复用 profile。写回在 session 关闭时发生，需等待同步；官方建议同一 Context 避免并发使用。它解决登录状态复用，不等于冻结整台电脑的进程内存。[Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view)、[Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)

browser-use 的开源库是 MIT，模型推理与托管浏览器另行计费。它是可复用的浏览器 agent 层，应与生命周期、账户隔离、凭据边界分别设计。[browser-use 官方仓库](https://github.com/browser-use/browser-use)

### noVNC 与 Selkies：显示和人工接管层

noVNC 使用标准 VNC 协议，要求 WebSocket 支持；没有原生 WebSocket 的 VNC 服务端可通过 `websockify` 转接。适合已有 VNC 服务的前端嵌入，不能替代身份认证网关或沙箱管理。[noVNC 官方仓库](https://github.com/novnc/noVNC)

Selkies 当前设计已不是“只能 WebRTC”：默认 WebSocket + WebCodecs，WebRTC 为可选；X11 为默认，Wayland 有对应 capture backend。支持 GPU/CPU 编码、音频、输入和剪贴板；Mac/Windows **服务端**仍为计划项。适合 Linux 远程桌面的性能与体验评估。[设计说明](https://github.com/selkies-project/selkies/blob/main/docs/design.md)

Selkies 主项目 MPL-2.0，但默认发布组件可包含 x264/x265/FFmpeg 的 GPL 依赖，官方提供不含这些 GPL 组件的构建路径。不能仅记录主项目许可证而忽略实际分发镜像。[许可清单](https://docs.selkies.io/latest/licensing)

## 自建底层组件如何选择

| 组件            | 边界与部署要求                                                                         | 适用判断                                                                             |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Firecracker     | Linux KVM microVM、独立 guest kernel、最小设备模型；Apache-2.0                         | Linux 多租户执行和快照底座；不自带完整桌面、账号、调度或前端                         |
| gVisor / runsc  | 用户态应用内核、OCI 集成，隔离系统调用与宿主；存在兼容性及 syscall 开销                | 沿用 Docker/Kubernetes 的中间路线；必须验证浏览器、FUSE、网络与 GPU 所需功能         |
| Kata Containers | 轻量 VM 加 OCI/CRI/containerd 接口，支持 QEMU/Cloud Hypervisor/Firecracker；Apache-2.0 | 已有 Kubernetes 且希望独立 kernel 的路线；hypervisor 与 storage/network 配置影响结果 |

表中架构依据分别来自 [Firecracker 官方说明](https://firecracker-microvm.github.io/)、[gVisor 官方文档](https://gvisor.dev/docs/) 和 [Kata Containers 官方说明](https://katacontainers.io/)。工程建议是优先采用上层已维护的生命周期封装；直接自建 Firecracker 调度只有在宿主、镜像、网络、快照和回收能力都需深度控制时才划算。

## 有明确日期的最新进展及行业方向

1. **2026-09-26：CUA-Sandbox 论文。**作者提出共享初始化 runtime、每条轨迹保留独立可变状态，以降低 computer-use 强化学习 rollout 成本；报告最高 6.20 倍吞吐、9.2 倍单环境内存降低、504 倍增量存储降低。这是作者实验结果，本文未复现；面向训练环境的状态隔离不能直接当作恶意多租户执行的安全隔离证明。[论文 v1](https://arxiv.org/abs/2609.32750v1)
2. **2026-08-13：Browserbase 持续登录实践。**官方文章把完整 profile、观察与人工接管作为长期 agent workflow 的基础。技术上关键是 profile 生命周期与并发一致性，而不是仅导出 cookies。[官方文章](https://www.browserbase.com/blog/keep-browser-sessions-logged-in)
3. **2026-06：Daytona 核心转私有。**说明“知名开源项目”标签不能代替对最新源代码可用性和维护状态的核验。[官方公告](https://github.com/daytonaio/daytona)
4. **查询时现状、无独立发布日期：**E2B Embed 单节点自托管；OpenSandbox 的 Fast Sandbox/强隔离 runtime；Cua 的 runtime 与许可分层；Selkies 默认 WebSocket 与可选 WebRTC。这些方向共同表明：行业正在补齐暂停恢复、镜像/池化、网络控制和人工接管，而不只提供 screenshot/click API。该判断是对上述来源的归纳，不是独立基准结论。

## 建议的验证次序

先用固定场景对照：冷启动/暖启动；打开浏览器与办公文档；输入中文；上传/下载；断线重连；人工接管；暂停恢复；过期回收；两会话文件与登录隔离。记录 P50/P95 启动时间、首帧时间、输入到可见变化延迟、静止/操作带宽、宿主 RAM/CPU 和失败率。涉及保留内存时同时校验进程标识、未保存文档与外部网络连接恢复。

候选优先级：**现有 Linux container + 桌面显示补齐 → E2B Desktop 对照 → 本地 macOS Lume 单独验证 → 有私有部署需求时比较 OpenSandbox 与 E2B Embed**。browser-only 工作流可先独立走 Browserbase/browser-use，不必等待完整桌面能力。以上仅为研究建议，本次没有实施或运行这些验证。

## Sources

所有技术事实的直接官方链接已放在对应段落。版本、许可、地域可用性和性能需在采用时重新核验；没有通过搜索摘要推断未发布的版本，没有把厂商宣称、论文结果或源码 contract 当作本地部署验收。

## Provider 实施可行性补充：E2B Desktop 与本地 Lume

补充核验日期：2026-10-03。没有启动计费服务、安装 Lume、下载 VM 或读取任何真实账号凭据。当前根目录及 sidecar 的 manifest/lock 未发现 E2B Desktop/E2B/Cua SDK 依赖；缺少真实 E2B 凭据与 Lume guest 是运行验收条件缺失，不是可以用空实现替代的理由。

### E2B Desktop：可实现完整 provider，但需要 Node bridge 和恢复语义

官方 npm registry 的只读查询 `pnpm view @e2b/desktop version dependencies engines --json` 返回 **2.4.0**、依赖 **e2b ^2.48.0**、Node **>=20.18.1 <21 或 >=22**，与 Cognia Node 26 要求相容。官方 `main` 的 desktop manifest 同样是 2.4.0，base SDK manifest 是 2.52.0；独立执行 `pnpm view e2b version --json` 也返回 **2.52.0**。这证明查询时 npm 可用版本，不证明当前 Cognia 已安装；实施时必须锁住实际 npm 解析版本。Desktop SDK manifest 为 MIT，与独立 Desktop 模板仓库 Apache-2.0 是不同对象。[Desktop manifest](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/desktop-js/package.json)、[base SDK manifest](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/package.json)

| Cognia provider 职责 | 已核实的 E2B API / 实施边界                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| create / attach      | `Sandbox.create(template, opts)`，默认 `desktop`；继承 `Sandbox.connect(sandboxId, opts)`，后者会恢复 paused sandbox                                   |
| GUI                  | `screenshot()`、`moveMouse`、`leftClick`、`mousePress/mouseRelease`、`drag`、`scroll`、`write`、`press`、`getScreenSize`；需要参数验证、坐标与键名转换 |
| exec / read          | 继承 `commands.run` 与 `files.read`；记录 command exitCode/stdout/stderr，保留字节/文本与取消语义                                                      |
| stream               | `stream.start({requireAuth:true})`、`getAuthKey()`、`getUrl({authKey,viewOnly})`；是 noVNC URL，与 Cua computer-server API 不是同一协议                |
| suspend / delete     | `pause()`、`kill()`；连接 paused VM 是 resume，不能冒充 cold restart                                                                                   |
| 应用重启恢复         | 持久化 provider/resource ID 后重新 connect；重新建立和验证 stream，不依赖旧 SDK 对象                                                                   |

依据：[Desktop 实现](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/desktop-js/src/sandbox.ts)、[base Sandbox 实现](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/src/sandbox/index.ts)。

源码核验发现一个具体恢复陷阱：新建 SDK 对象的 VNC URL/password 是空的；但 `stream.start()` 在 x11vnc 已存在时会抛错。因此应用重启后不能直接 `connect → start → getUrl`。可采用显式停止旧 stream 并重新启动/轮换 stream password 的恢复流程，最后回写新的安全连接信息；全程不能清除 guest 工作文件。当前 click 实现还以 truthy 判断坐标，adapter 应先 `moveMouse(x,y)` 再 click，以覆盖 x=0/y=0。[Desktop VNC 与输入源码](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/desktop-js/src/sandbox.ts)

工程方案：复用现有 registry/lifecycle，新增 Node 侧 SDK bridge，由受信后端持有 API key；UI 仅获得当前会话画面/连接描述。SDK 的账户级 key 与 VNC session password 要分开，后者 URL 中包含密码时也不得进入日志。缺少 key 时应返回可配置的 unavailable 状态；不要在 UI 宣称已连接，也不要回退宿主执行。连接选项与凭据解析依据：[ConnectionConfig](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/src/connectionConfig.ts)。没有云资源，本次可以验证接口契约、路由、错误回收和恢复状态机，不能声称真实云桌面验收通过。

### Lume：管理 API + guest SSH/MCP + 独立显示通道

官方 HTTP API 文档标注 **Lume 0.6.0**，管理地址 `http://localhost:7777`。API 提供 `/lume/vms` 列举/创建、`/:name` 查询/删除、`/:name/run` 异步启动、`/:name/stop` 停止、clone 与 pull。启动返回 202，仅代表受理；必须继续检查 guest 运行状态和可达性。这组 API 是 VM 管理，不是 `/execute` 或桌面动作 HTTP API。[HTTP API](https://cua.ai/docs/lume/reference/http-api)

官方推荐的 GUI 自动化通路是：**guest 内运行 Cua Driver → SSH 携带 MCP stdio → host agent**。Driver 必须属于 guest 的已登录图形会话；首次 Accessibility、Screen Recording、Automation 与直接屏幕捕获同意需要在 VM 的图形窗口完成。当前官方示例使用 `macos-tahoe-cua:26.5.2`，但还需安装/验证 Driver；不能假定下载镜像就已具备完整授权。clone 的权限复用还依赖 app 的发布签名不变。[VM/SSH 指南](https://cua.ai/docs/cua-driver/guides/vms-and-remote)

exec 可通过 `lume ssh <name> <command>` 或受控 SSH session 完成，guest 必须开启 Remote Login。read 建议复用已有 SSH 文件读取/传输而非拼接 `cat` 字符串；保存 VM identity、guest 用户和 host-key 绑定，恢复时重新发现 guest IP。`lume restart` 是 guest SSH 请求的重启，应等待旧连接断开和新 guest/Driver ready。[Guest access](https://cua.ai/docs/lume/reference/cli/guest)、[VM 生命周期](https://cua.ai/docs/how-to-guides/lume/manage-vms)

显示层默认有 native viewer 与 VNC，`--display none` 不等于关闭 VNC，`--vnc disabled` 才关闭监听。VM detail 提供 `vncUrl`；嵌入 Cognia 的 noVNC 还需要受控 WebSocket-to-VNC 转接，不能把 `vnc://` 当 iframe URL。应单独处理 VNC 密码、SSH 身份与本地管理端口边界，不为未确认的管理 API 臆造 Bearer 鉴权。[Lume VM 参数](https://cua.ai/docs/lume/reference/cli/vms)、[noVNC 服务端要求](https://github.com/novnc/noVNC#server-requirements)

工程判断：Lume 生命周期 adapter 可以直接对接本地管理 API；完整 GUI/exec/read provider 还需要 guest Driver 的 MCP/SSH adapter 和显示桥。只有 Lume 管理 adapter、不安装或验证 guest Driver 的方案不构成完整实现。当前本机没有 Lume/已授权 guest，能够完成契约与诊断集成，但真实 macOS 虚拟电脑验收必须等运行条件具备后执行。先修复所有动作按 registry 的 sandbox identity 路由，再接这两个 provider，能够保留现有 runtime 管理和权限边界。

## Docker 实际部署阻塞补充：镜像地址、ARM64 与旧协议

查询日期仍为 2026-10-03。本段仅执行 registry metadata 查询，没有下载镜像。官方 issue #3254 在 2026-08-19 报告 `trycua/cua-xfce:latest` 的 ARM64 缺失与 amd64 仿真连接问题；其中 `trycua/xfce-cua` 是新 Driver 协议，不能直接代替旧 computer-server。这里 `trycua/...` 指 Docker Hub，不能机械改写为 `ghcr.io/trycua/...`。[官方 issue](https://github.com/trycua/cua/issues/3254)

不过，“所有旧 cua-xfce 镜像都没有 ARM64”也不准确。**实时 Docker Hub API** 查询 `0.1.15` 返回以下数据（更新时间 2026-03-18T18:11:40.898719Z）：

| 对象                                            | digest / 数据                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docker.io/trycua/cua-xfce:0.1.15` 多架构 index | `sha256:3bf8536d354d4212aa7a2ed6309f63b573f587da50abb42692fc37e230832d91`                               |
| linux/arm64，active                             | `sha256:4d02d262745ba202bd7a87ae37cf291ebbca6b13680b93c3313ea468904421ce`，压缩大小 1,387,728,019 bytes |
| linux/amd64，active                             | `sha256:14aee2e5f61080307d8662784272bfc350b606cd9fd81e61324e5571e5fe288b`                               |

来源：[Docker Hub tag metadata API](https://hub.docker.com/v2/repositories/trycua/cua-xfce/tags/0.1.15)。这证明有可固定的 ARM64 artifact，但没有证明旧镜像内 server 版本、安全配置或当前端到端兼容性；不能仅因 digest 存在就设为生产默认。另一次 `docker manifest inspect` 无结果后被停止，不算成功验证。

当前官方索引中的 computer-server 源码使用 **`/cmd` + `{command, params}`**、`/ws`、`/status`，支持 `/commands` 自描述。主要 native Linux contract 为：`screenshot → image_data`（base64），`get_screen_size → size.{width,height}`，`get_cursor_position → position.{x,y}`；动作是 `move_cursor(x,y)`、`left_click/right_click`、`type_text(text)`、`press_key(key)`、`hotkey(keys)`、`drag(path)`、`scroll(x,y)`，而非统一的 `/execute`。执行结果采用 `return_code`，timeout 单位秒。[server 主路由](https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/main.py)、[Linux handler](https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/handlers/linux.py)、[base handler](https://github.com/trycua/cua/blob/main/libs/python/computer-server/computer_server/handlers/base.py)

**证据限制：**搜索服务能返回上述官方文件的近期索引，但本次随后直接获取 `raw.githubusercontent.com/.../main/...` 得到 404，说明 mutable main 路径或服务内容已变动。因此最终 adapter 必须以实际下载的、固定版本 PyPI wheel 中路由和签名为准，不能仅依赖索引或 Mock。旧 native Linux accessibility handler 还返回模拟空树，不能把 HTTP success 当成真实 AX/app-session 支持。[官方 Computer Server README 索引](https://github.com/trycua/cua/blob/main/libs/python/computer-server/README.md)

可执行建议：为现有协议构建原生 ARM64 的小型真实验证环境，采用多架构 Linux/Python 基础镜像、Xvfb、Openbox、xterm、固定版本 `cua-computer-server` native backend，再按 package 实际依赖提供 X11/Pillow/pynput 所需库和 clipboard 工具。用真实 X11 terminal 验证截图、坐标点击、键盘输入、窗口变化、执行/读文件与会话隔离；不要只返回固定 PNG。需要画面接管时再接 x11vnc/noVNC。该方案避免 KiCad 大底图，同时测试的是原有 computer-server 协议；其来源证明可行方向，本段没有声称已经构建成功。默认镜像修正应落在可复现 managed image/build 上，并固定 package/image digest，不能把错误 GHCR 改成另一个未验收的 `latest` 就结束。
