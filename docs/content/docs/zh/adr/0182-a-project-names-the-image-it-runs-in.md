---
title: "0182 — 项目自己指定它运行的镜像"
description: "云端与容器执行不再是「一个部署只有一个 runner 镜像」。项目从两级镜像目录、经审批的仓库声明（.cognia/workspace.json 或 devcontainer.json）或部署默认值，解析出一份不可变的 EnvironmentSpec。桌面端按设备审批，共享 Host 在服务端审批。整个子系统默认关闭，关闭时原路径不变；基础设施故障时回退，除非隔离是强制要求。"
---

# ADR 0182 — 项目自己指定它运行的镜像

**Status:** Accepted — 第 ① 步已实现（桌面本地容器保持休眠）；第 ②–④ 步规划中
**Date:** 2026-09-15
**Related:** [ADR-0059](./0059-cloud-deployment-headless-brain)（本文替换其镜像选择方式的 T2/T3 执行面）、[ADR-0085](./0085-cloud-shared-browser)（持久 WorkspaceRuntime）、[ADR-0147](./0147-repository-declared-workspace)（本文扩展的仓库文件及其审批门）、[ADR-0149](./0149-a-person-is-not-a-device)（在共享 Host 上负责审批的角色）、[ADR-0183](./0183-the-agent-is-brought-to-the-image)（agent CLI 如何进入任意镜像）

## 背景

Cognia 里容器化的 agent，每个部署只能跑在一个镜像里。`COGNIA_RUNNER_IMAGE` 在启动时读取一次（`crates/cognia-external-agent/src/container_backend.rs`），执行后端本身也是每个进程根据 `COGNIA_EXEC_BACKEND` 选定一次。发布的 runner 是 `node:26-slim` 加 git 和十几个装在 `latest` 版本的 agent CLI，没有任何语言工具链。

于是同一个云 Host 上的 Python、Rust、Java 项目拿到的都是同一个 Node 镜像。唯一的办法是写 `setup` 脚本，在每个新沙箱里重新装一遍工具链。用户唯一能选镜像的地方，是 CUA 桌面的 Docker 沙箱连接（`types/sandbox` 的 `DockerSandboxConfig.image`），那是另一个功能。

生态里早就有让仓库声明运行环境的方式：`devcontainer.json`。Cognia 一点都没读。`.cognia/workspace.json`（[ADR-0147](./0147-repository-declared-workspace)）描述了 setup、变量和预置，但不描述镜像。

## 决策

### 默认关闭，分层开关

这是位于 spawn 路径上的大型子系统，所以必须按需开启，出问题时不能影响正常工作。

1. **部署级开关**：环境基线里的 `sandboxPool.enabled`（或 `COGNIA_SANDBOX_POOL_ENABLED`），默认关。
2. **项目选择**：部署开关打开后，项目只要没有选择「运行环境」或审批仓库声明，就照旧运行。
3. **桌面开关**：「在本机容器中运行」按项目设置，默认关。

任何一层关闭时，`spawn_external_agent`、工作区命令、网关、出网都走现有路径，行为不变。每个触及这些路径的切片都带一个「关闭路径」测试把它钉住。

部署开关关闭时，spawn 路径上根本没有路由器：`cognia_sandbox_pool::boot::wrap_exec_backend` 把 Host 传进来的那个执行后端原样还回去，测试断言的是同一个 `Arc`，而不是「行为看起来一样」。只有在运维确实设置了什么、却拿不到沙箱时才拒绝启动：基线文件解析不了、开关值读不懂、开关打开却没有目录、开关打开但二进制没编进驱动。一个新变量都没设的部署，不可能被这个子系统拒绝启动。

### 每次 spawn 各自选环境

选择环境的是一次 spawn，而不是一个进程。`ExternalAgentSpawnConfig.sandbox` 是可选的 `SandboxPlacement`；运行环境之前的所有调用方都不带它，不带时也不出现在协议里：

```
{ "kind": "container", "spec": <EnvironmentSpec>, "isolationMandatory": false }
```

规格以 JSON travel，因为它来自 Host 并不信任的客户端；容器存在之前，它会被重新对照本 Host 自己的基线、目录、审批与出网授权做一次准入。`isolationMandatory` 是下文故障规则里属于客户端的那一半：客户端只能用它把自己这次运行变得更严格。

`SandboxRoutingBackend` 位于 Host 原有执行路径（本地进程、旧 runner 容器，或 ADR-0085 的 workspace-runtime 路由）之前，逐次 spawn 做决定。agent 最终跑在哪里通过 `external-agent://placement` 发出，并在 `get_info` 里重复一遍，这样界面才能说出真正运行的是什么：镜像 digest、实际认证到的隔离档位、bundle 里的命令，以及用户——被重映射时连声明的 uid 一起给出。回退走同一个通道，形如 `{ "kind": "fallback", "code", "message" }`。

一个 placement 落到池关闭的 Host 上时不需要路由器介入：`spawn_with_events` 在隔离强制时拒绝（`sandbox_pool_disabled`），否则剥掉它并报告 `sandbox_fallback_pool_disabled`。多租户 Host 上不带 placement 的 spawn 以 `sandbox_placement_required` 拒绝。

### 一份解析好的、不可变的规格

每次获取沙箱时，brain 解析一次 `EnvironmentSpec`。类型定义在 `types/sandbox/environment-spec.ts`，Rust 侧由 `crates/cognia-environment` 镜像实现。规格包含：

- 镜像（registry、仓库、`sha256` digest）；
- agent bundle 的 digest（[ADR-0183](./0183-the-agent-is-brought-to-the-image)）；
- 最低隔离档位；
- 规格档位；
- 生命周期（持久或临时）；
- 声明的容器用户；
- 容器环境变量与生命周期命令；
- 转发端口；
- 出网档位；
- 来源。

digest 覆盖除「给人看的解析过程」之外的全部内容。Rust 在准入时重新校验，并持久化它接纳的那份规格。准入之后，该沙箱的规格不再改变；声明发生变化时，沙箱标记为「更新待审批」，重建时才生效。

### 优先级

1. **项目显式设置**，指定一个目录条目。条目不可用时以 `catalog_entry_unavailable` 失败关闭，绝不悄悄换成用户没选的镜像。
2. **已审批的仓库声明**。
   - 来源是 `.cognia/workspace.json` 新增的可选 `environment` 块（文件仍是 `version: 1`，不含该块的文件 digest 不变），或标准位置上的 `devcontainer.json`。
   - 两者都指定镜像时 `workspace.json` 优先，解析过程会写明。
   - 未审批时按入口区分：交互式入口带着可见的判定落到第 3 步；无人值守入口（调度、Issue 运行、批量）以 `environment_approval_pending` 拒绝，保证后台运行不会用仓库没声明的镜像。
3. **部署默认值**：租户默认，否则基线默认，否则 `no_environment_available`。

### 两级目录

- **全局基线**：有 Ops Controller 时由它负责，包含条目、registry 白名单、隔离下限、节点池→档位映射、出网预设与内网例外。在 `/servers` 编辑，Postgres 里做版本管理，以签名操作下发到各部署。
- **单机基线**：没有 Ops Controller 时，基线来自文件（`COGNIA_ENVIRONMENT_BASELINE_FILE`），否则由 `COGNIA_RUNNER_IMAGE` 派生一个只读的 `legacy-env` 条目。
- **租户目录**：租户 `cognia-server` 是运行时权威，存在独立的 SQLite 里。租户管理员可以追加条目，但永远不能放宽基线的 registry 白名单或降低隔离下限。准入时会重新检查这两点，绕过 UI 写入的条目同样会被拒绝。

条目按 digest 固定；添加时把 tag 解析成 digest。

### devcontainer 子集是封闭的

- **支持**：
  - `image`、`name`；
  - `containerEnv`，以及 `remoteEnv`（只允许静态值和 `${containerEnv:…}` / `${containerWorkspaceFolder}`）；
  - 五个生命周期命令：`onCreate`、`updateContent`、`postCreate` 在首次创建时执行，`postStart` 每次恢复时执行，`postAttach` 每次挂接时执行；
  - `forwardPorts` / `portsAttributes`、`remoteUser`、`containerUser`、`workspaceFolder`（必须在 `/workspace` 下）；
  - `hostRequirements` 作为规格档位提示（GPU 预留、暂不可用）。
- **拒绝，整份声明无效**：`privileged`、`capAdd`、`securityOpt`、`runArgs`、`mounts`、`workspaceMount`、`appPort`、`initializeCommand`（它在宿主机执行），以及基于 compose 的配置。
- **忽略并记录**：`customizations`、`init`、`shutdownAction`、`updateRemoteUserUID`、`otherPortsAttributes`。
- **其他任何键**：以 `devcontainer_field_unknown` 拒绝。
- **构建**：`build` 与 `features` 会被解析，但在构建服务上线前**保持休眠**（ADR-0186，规划中），以 `devcontainer_build_requires_build_service` 拒绝，并在类型、UI、测试三处标注。

### 审批跟着「谁共享这台 Host」走

- **桌面端**：仍按设备审批（[ADR-0147](./0147-repository-declared-workspace)）。信任行新增非索引字段 `approvedDevcontainerDigest` / `approvedDevcontainerAt`，不升级 Dexie 版本。
- **共享云 Host**：多人共用一台 Host 时，「按设备」的回答没有意义，审批是租户数据库里的服务端记录。
  - 记录内容：项目、规范化后的远端地址、路径、声明 digest、解析出的镜像、运行时字段 digest。
  - 只有该工作区的 Maintainer、组织 Owner/Admin（[ADR-0149](./0149-a-person-is-not-a-device)）或 Host 所有者可以创建；每次审批和撤销都写审计。
  - 这件事由协作面告诉 Host，而不是查本地表：`cognia-collab-server` 上的 `GET /internal/v1/orgs/{org}/workspaces/{workspace}/access/{user}` 用的是该服务里每条鉴权路由都在用的那个 `resolve_workspace_access`，门槛是 `Manage`。brain 那份 Dexie 镜像只是界面便利——`lib/db/identity.ts` 自己在函数上写明了这一点——而「带凭据的沙箱要运行的镜像」不是界面便利。
  - Host 以它自己的身份认证，因为它不是那个人：配对客户端请它去审批，而它并不持有那个人的 grant，也无法验证——grant 密钥从不离开协作服务器。它出示 `COGNIA_COLLAB_SERVICE_CREDENTIAL`，协作面只存其 SHA-256（`COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256`）。没有配置的协作面一律回 401，于是一台从未被授予这项权限的 Host 会拒绝审批，而不是凭本地猜测放行。
  - 也就是说，持有该凭据者能问出「某人是否在某工作区里」。所以它挂在 `/internal` 前缀下（租户入口不路由这个前缀），并且「没有权限」和「工作区不存在」都回 `null`，让它无法被用来枚举一个组织。
  - 准入时比对这些冻结值，所以 Rust 不需要 devcontainer 解析器。
- **digest**：两条路径都对解析并规范化后的形式求 digest，复用 ADR-0147 引入的同一个 `canonicalize`，现提取到 `lib/project-environment/canonical-json.ts`。

### 故障时回退，除非隔离是强制的

池、驱动、网关沙箱入口或出网代理不可用时：

- **隔离不是强制的**：项目没有把隔离标为强制（`ProjectEnvironmentPolicy.requireSandbox` 或显式最低档位），就走现有执行路径，UI 显示 `sandbox_fallback_*` 原因。
- **隔离是强制的**：项目标了强制，或处在基线强制沙箱的多租户 Host 上，就拒绝运行。在那种情况下回退，意味着在 server 容器里、挨着其他租户的数据跑不可信的仓库代码。

哪些失败才算「故障」是这条规则的另一半，判据是这次失败说明了什么：

| 拒绝——永不回退 | 故障——除非隔离强制，否则回退 |
| --- | --- |
| 规格没有通过准入（`catalog_entry_unavailable`、`approval_missing`、`approval_mismatch`、`isolation_below_floor`、`egress_open_requires_grant`、`size_class_not_offered`、`gpu_not_supported`、`isolation_tier_unavailable`……） | `sandbox_pool_disabled`、`bundle_unavailable`、`sandbox_store_unavailable` |
| 镜像撑不起 agent（`probe_libc_unsupported`、`probe_glibc_too_old`、`probe_no_shell`、`probe_user_missing`、`probe_workspace_not_writable`、`bundle_arch_mismatch`、`sandbox_probe_failed`、`sandbox_probe_timeout`、`sandbox_image_unavailable`） | `sandbox_daemon_unreachable`、`sandbox_volume_unavailable`、`sandbox_bundle_stage_failed`、`sandbox_container_start_failed` |
| bundle 里没有这个命令（`sandbox_command_unavailable`） | |
| spawn 本身不合规（`sandbox_placement_required`、`sandbox_workspace_required`、`sandbox_workspace_outside_root`） | |

回退时展示的原因码是故障码换掉 `sandbox_` 前缀后的形式：`bundle_unavailable` 变成 `sandbox_fallback_bundle_unavailable`。

拒绝是对「所要求的东西」下的判断，把 agent 放到别处跑就会悄悄少做一些事；故障是基础设施挂了，它对这次请求本身什么也没说。所以镜像拉不下来是拒绝，而 daemon 连不上是故障。

### Docker 与 Kubernetes 遵守规格，E2B 不遵守

解析与注入路径由 Docker 驱动（compose T2 与桌面开关）和 Kubernetes 池（ADR-0184，规划中）共用。E2B 工作区后端不遵守运行环境，这一点在它的类型、UI、测试三处标注。

### 桌面凭据是明确的例外

桌面端本机容器里的 agent 拿到的是用户自己的 key，和今天 `env-builder.ts` 的做法一样，因为桌面网关只监听回环。ADR-0185（规划中）的「沙箱永不持有原始模型 key」规则约束的是 compose T2 与 Kubernetes。这个例外在「运行环境」面板里标注。

### 第 ① 步既不强制出网也不改写凭据，并且明说这一点

本文里有两条保证要靠第 ② 步的基础设施才成立。在那之前，第 ① 步的驱动是故意更弱的，这个缺口在类型、界面读到的 placement、以及测试三处标注：

- **出网**：`off` 会被真正执行——容器完全没有网络。`allowlist` 与 `on` 拿到的是旧 runner 那张网，没有任何东西在过滤，因为按租户的 L7 出网代理属于 ADR-0185。placement 里带 `egress.enforced: false`，下游任何地方都不能把一个没过滤的沙箱说成「已强制的白名单」。
- **凭据**：沙箱拿到的是和旧 runner 相同的、经 `SpawnPolicy` 过滤的环境变量，包含 provider key；网关那条只认票据的沙箱入口属于 ADR-0185 §②.7。placement 里带 `credentials.mode: "spawn-env"`。沙箱内的 supervisor 仍然会按驱动声明的变量名清单，剥掉那些来自镜像而非来自 Cognia 的环境凭据（[ADR-0183](./0183-the-agent-is-brought-to-the-image)）。

两者都不是悄悄降级：项目不可能在第 ① 步要求「强制白名单」，然后被告知它拿到了。

### companion 命令面

`src-tauri/src/companion_api/rpc/environment.rs` 里共十六个命令，全部受部署开关约束：池关闭时每个都返回 `sandbox_pool_disabled`，客户端应把它理解为「这个部署没有开启」，而不是出错。

| 命令 | 回答什么 |
| --- | --- |
| `environment_catalog_list` / `_get` | 合并后的目录，分页返回，并附上被合并拒绝的租户条目 |
| `environment_catalog_create` / `_update` / `_delete` | 租户条目。删除即撤销并保留记录，所以撤销过的 id 不能再用 |
| `environment_declaration_read` | 工作区根目录下的每一个声明文件，原始字节加 digest |
| `environment_spec_resolve_preview` | 准入的试运行：准入时给出会拿到的隔离级别和 bundle，拒绝时给出原因以及是否属于故障 |
| `environment_approval_list` / `_get` / `_approve` / `_revoke` | 服务端审批台账 |
| `environment_egress_grant_create` / `_delete` | 项目的出网授权 |
| `environment_probe_get` | 某个镜像与 bundle 组合的探测结论缓存 |
| `environment_driver_status` | 驱动本身、它能证明的隔离级别、守护进程是否可达、提供哪些 bundle |
| `environment_image_inspect` | 某个镜像引用在其 registry 上到底是什么 |

其中四条的形状由规则决定，而不是为了方便：

- **每一页目录都带部署事实。** 开关、是否多租户、隔离下限、默认条目、规格、出网预设和 bundle 供给，和 `rejected` 一样每页重复。解析需要它们与条目出自同一次合并；拆成第二个命令，客户端就可能拿两次不同时刻读到的数据去解析。
- **声明文件原样返回，也不替客户端选。** Host 返回找到的所有文件，不挑其中任何一个。唯一的 devcontainer/JSONC 解析器和唯一的优先级规则都在 brain（`lib/project-environment/`）里；Host 如果也解析或挑选，就成了同一个问题的第二个答案。
- **tag 只在一个地方变成 digest。** 目录条目和审批都通过 `environment_image_inspect` 固定。只会访问基线白名单里的 registry，协议取自匹配到的规则而不是引用本身，所以调用方没法让 Host 带着 registry 凭据去访问自己指定的主机。
- **探测缓存用写入方的类型来读。** Docker 驱动写入的和 `environment_probe_get` 解析的都是 `cognia_sandbox_pool::probe_cache::ProbeCacheEntry`，两边不可能对结构有分歧。返回的视图包含：探测时请求的用户、镜像实际解析出的用户、libc、架构、镜像能运行的 runtime，以及探测发现的每一个问题。本版本读不懂的条目报告为 `unreadable` 而不是「没有」：前者意味着要重新探测，后者意味着还没探测过。

审批命令会自己规范化 remote，所以不管客户端发来什么形式，运行时都用同一种形式查审批。驱动命令最初设想叫 `sandbox.docker.status`，现在叫 `environment_driver_status`，因为每种驱动都自己回答。

客户端通过 `sandbox-pool` 能力（`lib/platform/capabilities.ts`）得知某台 Host 是否可能具备这些。它只在服务端承载的主机上列出。「设置 → 镜像目录」要求这个能力，所以租户目录在运行沙箱池的地方管理。项目的「运行环境」面板同样以它为门槛：在没有沙箱池的主机上，面板会说明原因，而不是提供一个每次运行都会被拒绝的选择。

### 一次运行如何到达它的环境

brain 先解析，再连接：

1. **聊天回合会带上项目。** 控制器把会话所属项目、环境定义、项目记录和执行根目录传给 `ensureExternalAgentReady`。没有项目的会话什么都不传，照旧连接。
2. **`prepareRunEnvironment` 负责解析**（`lib/sandbox/run-environment.ts`）。没有选择时不会读取任何其他东西。目录读不出来时：Host 明确说池已关闭，就按关闭处理；否则算故障——隔离强制时以 `environment_catalog_unreadable` 拒绝，不强制时回退并给出 `sandbox_fallback_catalog_unreadable`。审批来自 Host 的台账；设备审批（[ADR-0147](./0147-repository-declared-workspace)）只在非多租户 Host 上有效。
3. **被拒绝的运行在任何进程启动前就停下。** 就绪检查返回本地化的原因；管理器也拒绝连接运行被拒的 agent，这种拒绝不重试，对外表现为 `sandbox_unavailable`。
4. **placement 在注册表里等待 spawn**（`lib/sandbox/spawn-placement-registry.ts`），按 agent 存放。它保存的是 agent 的「当前」placement，而不是一次性的：管理器会在崩溃、重连或重试连接后重新拉起 agent，却不会重新解析；如果 placement 被第一次 spawn 消耗掉，之后每次重启都会在宿主机上启动，且没有任何提示。因此该 agent 的每一次 spawn 都会带上它，直到之后的解析替换或清除它。Host 会对每次 spawn 重新准入，所以撤销审批依然会拒绝下一次 spawn。
5. **会话进程继承所属 agent 的 placement。** Pi 每个会话一个进程，id 为 `<agentId>:<sessionId>`，它的能力探测也这样命名；spawn id 按已注册的最长 `<agentId>:` 前缀匹配。
6. **跑在错误位置的 agent 会被重启。** 注册表记录每个进程启动时用的规格 digest（宿主机上启动记为 `null`）。新的解析结果不同时，就绪检查会重连 agent，而不是让它继续按旧结论运行。

如果从未注册过任何 placement，`withSpawnPlacement` 直接返回调用方传入的参数对象，spawn 负载与这个子系统出现之前逐字节一致。

Host 在 `external-agent://placement` 上的答复按 agent 保存。agent 设置行会在沙箱状态旁边显示它：隔离级别与镜像 digest、运行用户及其重映射、bundle 版本与 libc，以及下文的两条第 ① 步标注。Host 答复之前只显示「请求了什么」，从不显示「得到了什么」。Host 的回退码会本地化，本版本不认识的码也会原样写出。

Host 的审计日志同样会记下这次请求。带 placement 的 spawn 会在它的 `external_agent_spawn` 记录里加上 `sandbox` 字段，允许和拒绝都一样：种类、声明的规格 digest、项目 id、镜像 digest 与目录条目，以及隔离是否强制。这条记录写在准入之前，所以这些值都是客户端的声明；agent 实际跑在哪里由 placement 事件说明。任何合法规格都不可能出现的值记为 `null`，日志因此无法夹带任意文本，规格里的 `containerEnv` 也不会写进去。不带 placement 的 spawn 写出的记录与以前完全相同。

### 桌面本地容器在第 ① 步保持休眠

桌面端不列出 `sandbox-pool`，所以在桌面自身的主机上，「运行环境」面板会说明这里无法运行。面板的「在本地容器中运行」开关仍保留在选择里，但打开它的运行会以 `local_container_unavailable` 被拒绝，而不是在沙箱外运行。类型、面板标注和测试都说明了这一点。

桌面端将来依据哪个基线和哪个 agent bundle 运行，仍是未决问题：它没有可供取用的 Ops Controller 发布。这个问题等开关真正上线时再定，同时决定优先级规则中只有这条路径会用到的设备审批部分。

### Compose

- `deploy/compose/docker-compose.runtime-environment.yml` 把基线文件挂载为 `COGNIA_ENVIRONMENT_BASELINE_FILE`。
- T2 覆盖文件为旧映射透传 `COGNIA_SANDBOX_POOL_ENABLED`，空值视为未设置，也就是关闭。
- `scripts/smoke/compose-runtime-environment.mjs` 可以为指定的 bundle 镜像生成冒烟基线，并在不需要模型凭据的情况下驱动整套服务：
  - 从目录选 `node:22-alpine`，从已审批的声明选 `python:3.12-slim`，各自解析到 digest；
  - 逐个准入，带强制 placement 启动，核对回报的 digest、隔离级别、libc 与用户，并让 bundle 里的 codex-acp 回应 ACP `initialize`；
  - 用 placement 核对探测缓存；
  - 验证以下情况会被拒绝：与 digest 不符的规格、未审批的声明、已撤销的审批、已撤销的条目。
- 加上 `--expect pool-off` 时，同一脚本针对没有该覆盖文件的服务检查关闭路径。

## 影响

- **带来什么**：项目在自己声明的工具链里运行，桌面、compose、云端池都一样。已经带 `devcontainer.json` 的仓库不用写任何 Cognia 专用文件就能用。
- **代价**：
  - 两个新的 Rust 存储（现在的 `environment.sqlite`，第 ② 步的 `sandbox-pool.sqlite`）；
  - 一个新 crate `cognia-environment`；
  - `workspace.json` 新增一个可选块；
  - 十六个 companion 命令（即上文的 `environment_*`）和 `sandbox-pool` 能力；
  - 两个设置界面：项目的「运行环境」面板和租户的「镜像目录」；
  - 不升级主 Dexie 版本。
- **旧部署不受影响**：没有开启池的部署保留 `COGNIA_RUNNER_IMAGE`、共享 workspaces 卷和 runner Pod。只有开启池时，才需要执行 ADR-0187（规划中）的一次性布局迁移。

## 备选方案

- **只做部署级镜像**：否决，同一 Host 上的项目需要不同工具链。
- **每次运行选镜像**：否决，同一工作区的多次运行会分叉，缓存、预热池和审计都失去依据。
- **要求镜像 `FROM cognia-runner`**：否决，改为注入（[ADR-0183](./0183-the-agent-is-brought-to-the-image)）。强制派生会把用户绑死在 Debian/Node 上，每次 agent 升级都要用户重建。
- **registry 在白名单内就自动生效的仓库声明**：否决，恶意 PR 就能改掉带凭据沙箱所用的镜像。
- **目录只放 Ops Controller**：否决，单机自托管为了选个镜像就得部署一个控制器。

## 实现

运行环境计划第 ① 步，按可独立提交的切片推进：

1. 本文与 ADR-0183，以及对 ADR-0147 的修订；
2. `cognia-external-agent` 可以不依赖 Tauri 构建（默认特性 `tauri-host`）；
3. `crates/cognia-environment`：规格、规范 digest、目录合并、策略、存储、基线加载；
4. TS 规格类型、devcontainer 子集解析、解析器、`workspace.json` 的 `environment` 块、桌面 devcontainer 审批；
5. `cognia-sandboxd` 的 install/probe/init 模式与 agent bundle 镜像（[ADR-0183](./0183-the-agent-is-brought-to-the-image)）；
6. 第四个发布镜像；
7. 按 spawn 路由：`ExternalAgentSpawnConfig.sandbox`、`SandboxRoutingBackend`、`external-agent://placement` 通道，以及包含准入、bundle 命令映射与 Docker 驱动的 `crates/cognia-sandbox-pool`；
8. companion RPC 与云端审批权限；
9. brain 接线：连接前先解析、当前 placement 注册表、解析变化时重启、placement 回报；
10. 「运行环境」面板、每次运行的 placement 徽标、「镜像目录」设置页；
11. compose 覆盖文件、冒烟脚本及其基线。
