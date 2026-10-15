---
title: "0221 — 远程沙箱是同一接缝后的一个 provider"
description: "Kubernetes 与 E2B 沙箱按需创建，作为桌面端和常驻 host 的派发目标。它们与本地 Docker 驱动一起成为同一 SandboxExecBackend 接缝后的 provider 集合成员，复用同一个驱动、准入、bundle 监督进程与桥接，完整遵守 EnvironmentSpec，从不持有模型或 provider 密钥，经 exec 通道回到 host 访问 git 与模型网关，并受每个 provider 的并发、寿命与空闲上限约束。"
---

# ADR 0221 — 远程沙箱是同一接缝后的一个 provider

**状态：** 已接受
**日期：** 2026-10-10
**相关：** [ADR-0182](./0182-a-project-names-the-image-it-runs-in)（spec、准入与故障规则）、[ADR-0183](./0183-the-agent-is-brought-to-the-image)（bundle 与 `cognia-sandboxd`）、[ADR-0059](./0059-cloud-deployment-headless-brain)（headless host）、[ADR-0176](./0176-every-clone-shares-one-object-cache)（host 侧仓库供给）
**设计记录：** `docs/superpowers/specs/2026-10-10-remote-sandbox-providers-design.md`

## 背景

带运行环境 placement 的 spawn 目前只能跑在一个地方：host 自己 Docker daemon 上的容器。`cognia-sandbox-pool` 的启动接缝把这个驱动写死了。

其他候选都没有落地：

- ADR-0182/0183 以 ADR-0184 之名引用的 Kubernetes 池从未写成。runner Pod 后端拒绝所有沙箱字段，且只能在集群内启动。
- E2B 插件的 workspace 后端与 microVM 适配器处于休眠，因为 webview 加载不了只能在 Node 中运行的 SDK。
- 桌面端从不安装沙箱池，它发出的每个 placement 都会回退。

有两类 host 需要的不止一台机器的 Docker：

- 没有 Docker（或 Docker 不够用）的桌面。
- 需要能扩展到集群或 microVM 的常驻 host。

两者都必须保留 ADR-0182 给本地沙箱的保证：

- 运行项目自己的镜像，并在 host 上重新准入；
- 把 agent bundle 带进镜像；
- 沿用故障规则；
- 沙箱内不放 provider 密钥。

## 决策

### 一个接缝，一组 provider

`SandboxRoutingBackend` 仍只有一个沙箱分支，这个分支是一个 **provider 集合**：一个按 provider id 索引成员的 `SandboxExecBackend`。

- 本地 Docker 驱动是成员 `local`，每个配置的远程 provider 是另一个成员。
- `SandboxPlacement::Container` 新增可选的 `provider` 字段，缺省即 `local`。
- 集合把 spawn 交给对应成员，之后的每次调用都按所属成员路由。
- 只有远程 provider、没有本地驱动的 host 也是合法的。

旧 host 会拒绝带 provider 的 placement（`deny_unknown_fields`）。因此新客户端的远程请求永远不会被误跑在本地。

### 驱动共享，provider 提供容器面

Docker 驱动只通过 `SandboxDockerApi` 访问 daemon。沙箱一旦存在，后续一切都跑在这个面上：基于 exec 的持久会话、网关与工具主机桥、端口隧道，以及基于标签的归属与回收。

远程 provider 实现同一个面：

- **Kubernetes**：Pod exec、Pod 标签、删除 Pod。
- **E2B**：envd 进程流、沙箱 metadata、kill，以及 pause/resume。

驱动只新增一个远程**准备**分支，因为远程 provider 没有命名卷，也没有 host 工作区挂载。这个分支依次做四件事：

1. 创建原生注入 bundle 的实例；
2. 经 exec 探测；
3. 经 host 克隆工作区；
4. 把每个 agent 作为实例中 `sandboxd serve` 的 `connect-agent` 会话启动。

这是持久模型，两种 lifecycle 都采用它；ephemeral 会话结束时的清理会销毁实例。

### spec 要么被遵守，要么被拒绝

准入使用共享的 `SandboxAdmission`，按 provider 证明的隔离档运行：

- Kubernetes 恒证明 `container`，`gvisor`/`vm` 只在映射了 RuntimeClass 时证明；
- E2B 证明 `vm`。

**bundle 注入：**

- **Kubernetes**：用固定 digest 的 bundle 镜像做 init 容器，把 core 与两套 libc 安装到挂在 `/cognia` 的 `emptyDir`。
- **E2B**：按「用户镜像 digest × bundle digest × size class」构建 template。template 以 `fromImage` 引用用户镜像，把校验过的 bundle 根文件系统复制到 `/opt/cognia`，再执行同样的 `install` 阶段。

**E2B 上的私有镜像**：只有运维显式列为可委托的仓库，其凭据才会交给 E2B；其他私有镜像以 `sandbox_registry_not_delegated` 拒绝。

**出网：**

| 档位 | Kubernetes | E2B |
| --- | --- | --- |
| `off` | 全拒绝的 NetworkPolicy | 关闭出网 |
| `allowlist` | 仅在使用 Cilium FQDN 策略时强制执行 | 用 provider 的 allow/deny 列表强制执行 |
| `on` | 不加策略 | 默认 |

provider 无法强制执行的 allowlist：强制隔离时以 `sandbox_egress_unenforceable` 拒绝；非强制隔离时照常运行，placement 记录 `egress.enforced: false`。

### 沙箱里没有任何秘密

- **模型访问**：沿用现有的托管网关租约，经 exec 通道桥接进沙箱。原先只要带 placement 就拒绝网关任务的检查，现在在后端会路由沙箱时放行。
- **git**：走 host 侧 **git 代理**，每个任务一个，只绑定一个上游仓库，经同一条桥在沙箱内暴露为回环端口。凭据由 host 附加：优先用 brain 随 spawn 发来的凭据，否则用 host 自己对该上游执行的 `git credential fill`（禁用交互提示，带超时）。代理只转发 upload-pack/receive-pack，push 只能更新本任务自己的分支，且不能删除。
- **会话结束时**：驱动经代理提交并推送工作区，结果发在 `external-agent://workspace-publish` 上。
- **未推送的工作不会随实例一起销毁。** 驱动先把远端没有的所有提交导出为 git bundle，连同一份 JSON 清单写到 host 的 `<data_dir>/sandbox-recovery/`，报告在 `recovery.bundle` 中给出路径。导出也失败时实例进入 `held`：越过空闲上限保留，由清扫每分钟重试交付；保留到截止时间仍未交付，则报告 `discarded`。同一工作区的交付一次只跑一个；复用 held 持久工作区的会话会把先前的工作一并交付。held 状态只在内存中，host 重启后 held 的 ephemeral 实例会和其他孤儿一样被回收，所以 bundle 导出放在最前面。
- **provider 账户凭据**（E2B key、kubeconfig）：只在 host 上解析。

### 交付记录归 Host 所有

每次远程会话在 `<data_dir>/sandbox-deliveries/` 中保存一条持久化任务交付记录，与恢复 bundle 并列。原子替换文件并同步文件及目录后才发送发布事件。记录包含会话、agent、可选 gateway task、provider、实例、分支和 commit；发布状态（`running`、`pushed`、`savedBundle`、`held`、`discarded`、`nothingToPublish`、`failed`）与清理状态（`retained`、`pending`、`destroyRetrying`、`destroyed`）彼此独立。删除失败不会覆盖已保存工作的结果，持久实例也不会被误报为已销毁。

agent id 可以复用，因此只用于筛选，不能作为记录主键。每次会话保留独立记录、创建时间和递增 revision。交付重试更新原记录，实例清理更新关联的全部记录；启动协调记录孤儿清理和丢失工作，但历史记录不重建 git proxy 或恢复会话。记录不保存凭证、spawn 环境变量、仓库 URL 或原始 git stderr。

`environment_delivery_list` 通过现有 `host.observe` companion 授权和桌面 `environment_local_call` 提供按 `agentId`、`taskId` 筛选的分页读取。pool 关闭后仍可读取。badge 和 agent 检查器中的交付历史在刷新页面后读取 Host 账本，并在打开期间刷新。实时事件携带 revision，避免旧查询覆盖新事件；客户端投影按执行 Host 隔离，Dexie 不承担此数据的权威存储。

### 上限是结构性的

每个 provider 有三个上限：`maxConcurrent`、`maxLifetimeSecs`（默认 7200）、`idleTimeoutSecs`（默认 600）。

- 寿命同时写入 provider 自身的 TTL（E2B `timeout`、Pod `activeDeadlineSeconds`），host 崩溃也不会泄漏计费中的沙箱。
- provider 拒绝删除时，实例保持跟踪并继续占用名额（它可能仍在运行、仍在计费），清扫以 15 秒起、最长 10 分钟的退避重试删除；正在删除的实例不会被新的 spawn 复用。provider TTL 是最后的上限。
- 拿不到并发槽位属于 fault，由 ADR-0182 的故障规则决定是否回退，规则本身不变。
- 启动时回收本部署孤立的 ephemeral 实例，并按 runtime key 接管持久实例。

### 放置是确定的

项目的 runtime 选择新增 `target`：

- `local`：使用 host 的本地驱动；
- 指定 provider：使用该 provider；
- `auto`（默认）：本地驱动能证明所需隔离档时用本地驱动，否则用 host 的默认远程 provider。选择原因写入运行环境 trace。

远程目标需要项目的仓库 remote；只有本地 checkout 的项目以 `sandbox_workspace_remote_required` 拒绝。

### 两个派发源

- **常驻 host**：`cognia-server` 读取 `COGNIA_SANDBOX_PROVIDERS_FILE`。
- **桌面**：
  - 设置 → 远程沙箱编辑一份文档 `<app_data>/cognia/remote-sandboxes.json`：provider、默认 provider 与镜像仓库允许列表。凭据存入 secret store（`remote-sandbox:<id>`），之后不再读回。
  - 启动时用这份文档和合成的 baseline（`remote-sandboxes-baseline.json`）安装同一个池，不含本地驱动。保存的更改在下次启动时生效；页面会提示（`restartRequired`），并显示上次启动拒绝的原因（`installError`）。运行中的池不会在有活跃沙箱时被拆除。
  - bundle digest 由发行构建固定（`COGNIA_AGENT_BUNDLE_IMAGE`）。没有固定 bundle 的构建把远程沙箱标注为不可用（`bundle_unpinned`），不安装任何东西。
  - `environment_*` 命令经一个本地命令 `environment_local_call` 提供，它与 companion 调用分派到同一组处理函数。桌面的 `sandbox-pool` 能力是静态的；池是否开启在调用时以 `sandbox_pool_disabled` 回答，与服务器一致。
  - 只有带 placement 的 spawn 才经过路由器。路由器交回既有路径的每个 spawn 仍由桌面的 OS 沙箱包装器约束，回退绝不比以前更宽松。

## 影响

- 本地与远程沙箱共用一个驱动、一个准入、一个桥接协议和一个会话监督进程。远程 provider 大致是「一个 API 客户端 + 一个准备分支」，而不是第二个池。
- 远程工作区从远端仓库开始，本地未推送的改动不在其中，UI 会明确说明。
- 没有 Cilium 的 Kubernetes allowlist 出网不会被强制执行。这一点写在类型文档里、在 UI 中标注、并由测试固定，与 Step ① 的 Docker allowlist 一致。
- 用于 computer use 的云桌面、以及远程 VM 上的 Docker 不在本 ADR 范围内，需要各自的决策。
- ADR-0184 中的 Kubernetes 池在这里以 provider 形式交付。`sandboxd serve` 协议 v2 与按租户的 L7 出网代理仍属于 ADR-0184/0185。
