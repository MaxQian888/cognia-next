# Lume 当前能力与 Cognia 接入边界

核验日期：2026-10-23（Asia/Shanghai）。范围仅为官方文档、官方发布记录与当前 Cognia 源码；本次没有安装 Lume、下载镜像、启动 VM 或修改机器配置。

新增独立日期快照，保留 [2026-10-03 调研](sandbox-virtual-computer-industry-2026-10-03.md) 的历史口径，避免把后续文档和 nightly 能力回填成当时的稳定版事实。

## 判断

**工程判断：Lume 适合作为 Apple silicon 上的本地 macOS guest 运行层；Cognia 仍需实现生命周期适配、guest 桌面通道和显示通道。当前主机的可用磁盘不足以进行官方推荐的 macOS guest 试跑。** 依据见下文，尚无本次运行验收证据。

## 官方事实

### 定位与版本

- Lume 使用 Apple Virtualization.framework，在 Apple silicon Mac 上运行 macOS 和 Linux VM；提供 CLI、本地 HTTP API 和 MCP。它负责 VM 运行与管理。[Overview](https://cua.ai/docs/lume)
- 官方 HTTP API 文档当前标注 **0.6.1**。只读查询官方仓库最近 100 条 Releases，返回记录中最新 Lume stable 为 **0.6.1**，发布时间 `2026-10-04T18:47:46Z`，即北京时间 `2026-10-05T02:47:46+08:00`；发布说明列出 SSH event loop 等修复。[API reference](https://cua.ai/docs/lume/reference/http-api)、[0.6.1 release](https://github.com/trycua/cua/releases/tag/lume-v0.6.1)
- 同批记录中最新 Lume prerelease 为 **0.6.2-nightly.20261015.38683422335**；nightly 明确为主动选择、可能不稳定的通道。`lume cp` 出现在 2026-10-09 nightly 发布记录，不能仅凭当前 main 文档就承诺 stable 0.6.1 已具备。[10-15 nightly](https://github.com/trycua/cua/releases/tag/nightly-lume-v0.6.2-nightly.20261015.38683422335)、[10-09 nightly](https://github.com/trycua/cua/releases/tag/nightly-lume-v0.6.2-nightly.20261009.37886014796)

### 运行条件与 VM 准备

| 项目       | 官方要求 / 行为                                           |
| ---------- | --------------------------------------------------------- |
| Host       | Apple silicon，macOS 13 或更高                            |
| 内存       | 至少 8 GB 空闲；8 GB guest 对应 16 GB host 内存的建议口径 |
| 磁盘       | 每个 macOS guest 约 50 GB 可用空间，另计 restore image    |
| macOS 并发 | 最多同时运行两个 macOS guest                              |

来源：[Lume requirements](https://cua.ai/docs/lume)。这里的 macOS 13 是 Lume host 门槛；Cua Driver 当前另要求 macOS 14 或更高。[Driver platform requirements](https://cua.ai/docs/cua-driver)

- 可用 Apple IPSW 创建 vanilla guest：`lume create macos-tahoe --ipsw latest --unattended tahoe`。`latest` 指 Lume 当前支持的最新恢复镜像，也可传本地 IPSW。Tahoe preset 在安装后离线写入账户及设置，再启动验证 SSH；默认账户与密码均为 `lume`，启用 SSH、自动登录并关闭睡眠和屏幕锁。[Quickstart](https://cua.ai/docs/lume/quickstart)、[How Lume works](https://cua.ai/docs/lume/concepts/how-lume-works)
- Tahoe 是官方当前验证的 preset；Sequoia 首次显示启动仍可能出现 Accessibility Setup Assistant 步骤。无人值守安装完成不能等同于桌面驱动权限已经授予。[Lume README](https://raw.githubusercontent.com/trycua/cua/main/libs/lume/README.md)、[Driver VM guide](https://cua.ai/docs/cua-driver/guides/vms-and-remote)
- 也可从 OCI registry `pull` 镜像。Driver VM 指南当前示例为 `macos-tahoe-cua:26.5.2`，其虚拟磁盘为 150 GB sparse disk，SIP 关闭；文档仍要求在 guest 内安装/验证 Driver。SIP 关闭本身不授予 GUI 权限，Driver 也支持 SIP 开启。[CLI images](https://cua.ai/docs/lume/reference/cli#images)、[Driver VM guide](https://cua.ai/docs/cua-driver/guides/vms-and-remote)

### 生命周期、SSH 与 MCP

| 通道       | 已证实能力                                                                     | Cognia 应处理的边界（工程判断）                              |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| CLI / HTTP | create、list/get、run、stop、clone、delete、resize；HTTP 默认 `localhost:7777` | 持久化 VM identity；操作完成后检查实际 guest 状态            |
| HTTP run   | `POST /lume/vms/:name/run` 返回 202；超过 macOS guest 上限可返回 409           | 202 只是受理，需要继续等待 SSH 与桌面服务 ready              |
| Lume MCP   | `lume serve --mcp` 使用 stdio；包含 VM 管理工具、`lume_exec` 和更新检查        | 不能把这些工具声明为 screenshot/click/type GUI 工具          |
| Guest exec | `lume_exec` 通过 SSH 执行 guest shell command，要求 SSH 已开启                 | 绑定 guest 用户、凭据与 SSH 身份，保留退出码、输出和取消语义 |

来源：[HTTP API and MCP tools](https://cua.ai/docs/lume/reference/http-api)、[CLI reference](https://cua.ai/docs/lume/reference/cli)。该 MCP 工具清单没有桌面截图、点击或键盘输入工具。

- 安装器默认配置登录时运行的 `lume serve`；可使用 `--no-background-service` 改为手动启动。HTTP 仅监听 localhost，官方要求扩展网络暴露前先建立网络与认证边界。[Manage VMs](https://cua.ai/docs/lume/guides/manage-vms)
- 原生 viewer 与 VNC 是显示选项；`--display none` 仍可能启动 VNC，`--vnc disabled` 才关闭监听。共享目录可只读挂载；默认 VM 存储为 `~/.lume`。[Manage VMs](https://cua.ai/docs/lume/guides/manage-vms)
- clone 会一起复制 `disk.img` 与 `nvram.bin`；SIP/Recovery 状态依赖配对状态。磁盘只能扩容，macOS guest 需停止且关闭 FileVault；默认扩容流程具备备份与失败回滚。[How Lume works](https://cua.ai/docs/lume/concepts/how-lume-works)、[Manage VMs](https://cua.ai/docs/lume/guides/manage-vms)

### GUI 自动化的独立前提

官方路径仍是 **guest 图形会话内的 Cua Driver → SSH 携带 MCP stdio → host agent**。Driver 必须运行在它实际控制的机器内；SSH 侧代理到 guest 已登录会话的 daemon。[Driver VM guide](https://cua.ai/docs/cua-driver/guides/vms-and-remote)

首次需要在 VM 图形窗口完成：Accessibility、Screen Recording、System Events Automation，以及 Tahoe 的独立 direct screen capture 同意。然后验证 `list_apps` 与 `get_desktop_state` 不再弹窗，并检查 `permissions status --json` 的 app-owned daemon 归属。clone 复用授权依赖 Driver app 的发布签名保持一致。[Driver VM guide](https://cua.ai/docs/cua-driver/guides/vms-and-remote)

**工程判断：** Lume MCP 适合先接 VM 生命周期和 shell；完整虚拟电脑体验还需 guest Driver 连接与 Cognia 的工具协议适配。若要嵌入显示，还应独立验证 VNC/浏览器桥接和密码管理，不能把 `vncUrl` 的存在当成桌面自动化已就绪。

## 与 2026-10-03 调研相比

- 稳定版文档标注从当时的 0.6.0 变为 0.6.1；后续 nightly 修复包括停止 VM 不结束 server、SSH 参数转义、macOS guest 上限检查，以及 OCI 镜像组装。[0.6.1 release](https://github.com/trycua/cua/releases/tag/lume-v0.6.1)、[10-06 nightly](https://github.com/trycua/cua/releases/tag/nightly-lume-v0.6.2-nightly.20261006.37415690828)、[10-08 nightly](https://github.com/trycua/cua/releases/tag/nightly-lume-v0.6.2-nightly.20261008.37729631871)、[10-15 nightly](https://github.com/trycua/cua/releases/tag/nightly-lume-v0.6.2-nightly.20261015.38683422335)
- 当前文档清晰列出原生 Lume MCP 和离线 unattended setup，可减少接入探索成本；本次未逐项追溯它们首次发布的日期，不把“现在文档可见”写成“10-03 后新增”。[MCP reference](https://cua.ai/docs/lume/reference/http-api#mcp-tools)、[Unattended setup](https://cua.ai/docs/lume/concepts/how-lume-works#unattended-setup)
- 先前的核心边界仍成立：VM 管理、guest GUI 工具与显示通道分别需要验证。旧调研是历史背景，当前源码与官方文档是本次判断依据。[历史调研](sandbox-virtual-computer-industry-2026-10-03.md)

## 当前 Cognia 与主机状态

以下由本次主任务的本地只读检查提供；没有重复开展运行验证。

- `lib/sandbox/adapter-registry.ts` 只注册 `docker:computer-server` 与 `e2b:computer-server`，并明确注释 Lume adapter 缺失。[adapter registry](../../lib/sandbox/adapter-registry.ts)
- capability revision 为 4，Lume 使用 `caps({})`，生命周期、GUI 和 workspace 能力默认均未启用。[connection capabilities](../../lib/sandbox/connection-capabilities.ts)
- 创建 sandbox connection 的 hook 当前仍硬编码 Docker；相关注释不能作为 Lume 已接入的证据。[connection hook](../../hooks/automation/use-sandbox-connections.ts)
- `which lume` 退出码 1，只能证明当前 PATH 找不到 Lume；未证明磁盘其他位置不存在安装。Host 为 `arm64`，macOS `26.5.2`（build `25F84`）。
- `df -h .` 显示所在 Data volume 可用约 **5.8 GiB**、使用率 **99%**。与官方每个 guest 约 50 GB 加 IPSW 的要求比较，当前卷不满足推荐准备条件。[官方空间要求](https://cua.ai/docs/lume)

## 后续最小验证建议（尚未执行）

1. 准备足够空间，固定 stable 或明确的 nightly 版本，保存版本与镜像来源；优先使用 Tahoe。
2. 在独立 guest 验证 create/run/get/SSH/shutdown/clone/reconnect，再安装 Driver 并在图形会话完成授权。
3. 用真实 guest 验证截图、点击、输入、文件往返、应用重启后的恢复、停止/取消与凭据清理，再启用 Cognia capability。

上述顺序是工程建议，不代表已开始实施或已通过验收。本次仅新增这份研究笔记；没有产品代码、配置或 VM 状态变更。
