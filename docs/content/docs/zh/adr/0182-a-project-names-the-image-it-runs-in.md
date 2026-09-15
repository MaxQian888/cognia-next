---
title: "0182 — 项目自己指定它运行的镜像"
description: "云端与容器执行不再是「一个部署只有一个 runner 镜像」。项目从两级镜像目录、经审批的仓库声明（.cognia/workspace.json 或 devcontainer.json）或部署默认值，解析出一份不可变的 EnvironmentSpec。桌面端按设备审批，共享 Host 在服务端审批。整个子系统默认关闭，关闭时原路径不变；基础设施故障时回退，除非隔离是强制要求。"
---

# ADR 0182 — 项目自己指定它运行的镜像

**Status:** Accepted — 第 ① 步进行中
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
  - 准入时比对这些冻结值，所以 Rust 不需要 devcontainer 解析器。
- **digest**：两条路径都对解析并规范化后的形式求 digest，复用 ADR-0147 引入的同一个 `canonicalize`，现提取到 `lib/project-environment/canonical-json.ts`。

### 故障时回退，除非隔离是强制的

池、驱动、网关沙箱入口或出网代理不可用时：

- **隔离不是强制的**：项目没有把隔离标为强制（`ProjectEnvironmentPolicy.requireSandbox` 或显式最低档位），就走现有执行路径，UI 显示 `sandbox_fallback_*` 原因。
- **隔离是强制的**：项目标了强制，或处在基线强制沙箱的多租户 Host 上，就拒绝运行。在那种情况下回退，意味着在 server 容器里、挨着其他租户的数据跑不可信的仓库代码。

### Docker 与 Kubernetes 遵守规格，E2B 不遵守

解析与注入路径由 Docker 驱动（compose T2 与桌面开关）和 Kubernetes 池（ADR-0184，规划中）共用。E2B 工作区后端不遵守运行环境，这一点在它的类型、UI、测试三处标注。

### 桌面凭据是明确的例外

桌面端本机容器里的 agent 拿到的是用户自己的 key，和今天 `env-builder.ts` 的做法一样，因为桌面网关只监听回环。ADR-0185（规划中）的「沙箱永不持有原始模型 key」规则约束的是 compose T2 与 Kubernetes。这个例外在「运行环境」面板里标注。

## 影响

- **带来什么**：项目在自己声明的工具链里运行，桌面、compose、云端池都一样。已经带 `devcontainer.json` 的仓库不用写任何 Cognia 专用文件就能用。
- **代价**：
  - 两个新的 Rust 存储（现在的 `environment.sqlite`，第 ② 步的 `sandbox-pool.sqlite`）；
  - 一个新 crate `cognia-environment`；
  - `workspace.json` 新增一个可选块；
  - 一组 companion 命令（`environment.catalog.*`、`environment.approval.*`、`environment.spec.resolve_preview`、`environment.declaration.read`、`environment.egress_grant.*`、`environment.probe.get`、`sandbox.docker.status`）；
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
7. 按 spawn 路由；
8. companion RPC 与云端审批权限；
9. brain 接线、「运行环境」与「镜像目录」界面、compose 冒烟。
