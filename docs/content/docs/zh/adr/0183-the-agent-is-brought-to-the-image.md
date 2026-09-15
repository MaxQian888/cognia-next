---
title: "0183 — 把 agent 带进镜像"
description: "agent CLI 不再预装在项目运行的镜像里。每个版本发布一个多架构 agent bundle，glibc 与 musl 两套目录共用一个 digest。启动时注入任意用户镜像，由探测决定该镜像能承载什么，再由静态监管进程 cognia-sandboxd 以声明的用户身份运行 agent。agent 版本随发布固定，不再用 `latest`。"
---

# ADR 0183 — 把 agent 带进镜像

**Status:** Accepted — 第 ① 步进行中
**Date:** 2026-09-15
**Related:** [ADR-0182](./0182-a-project-names-the-image-it-runs-in)（指定镜像与 bundle 的规格）、[ADR-0059](./0059-cloud-deployment-headless-brain)（容器执行后端与发布契约）、[ADR-0085](./0085-cloud-shared-browser)（本文在 agent 托管上替换掉的 WorkspaceRuntime 监管进程）

## 背景

[ADR-0182](./0182-a-project-names-the-image-it-runs-in) 让项目可以选择任意镜像，但 agent 仍然要在里面跑。今天 agent CLI 是 runner 容器里唯一的进程，通过 stdio 挂接（`crates/cognia-external-agent/src/kube_backend.rs`）。runner 镜像是唯一装了这些 CLI 的地方（`deploy/runner/install-agents.sh`，版本默认全是 `latest`）。

用户的 `python:3.12-slim` 或 Alpine 镜像里没有 Node、没有 Claude Code、没有 Codex，常常连 git 都没有。解决办法有三种：

- **要求镜像从 runner 派生**：把用户绑死在 Debian/Node 上，每次 agent 升级都要用户重建镜像。
- **把 agent 放在同一个 Pod 的第二个容器里**：CLI 的 shell 工具在自己的容器里执行，用户的工具链根本够不着。
- **启动时把 agent 注入用户镜像。**

现有的持久运行时监管进程担不起这件事。`services/workspace-runtime/src/supervisor.mjs` 转发的是原始 stdout 块，Rust 侧的泵把每块当作一行（`workspace_runtime_backend.rs`），所以一个 ACP 帧可能被拆开或粘在一起。事件还要经过一个 100 ms 轮询一次的 512 条环形缓冲区，负载一高就会丢帧。

## 决策

### 每个版本一个 bundle，一个 digest

`deploy/bundle/Dockerfile` 发布 amd64 与 arm64 的 `cognia-agent-bundle`。libc 不是 OCI 平台维度，所以用一个镜像装两套目录，而不是两个镜像、两个 digest：

```
/opt/cognia/bundle-manifest.json   版本标签、固定的 CLI 版本、按 libc 的可用性
/opt/cognia/bin/cognia-sandboxd    静态编译（musl）
/opt/cognia/common/{git,bin}       静态、可重定位的 git 与 rg，两种 libc 通用
/opt/cognia/certs/ca-bundle.pem    给没有 CA 证书库的镜像用
/opt/cognia/glibc/                 node、npm 安装的 CLI、glibc 版厂商 CLI
/opt/cognia/musl/                  自带加载器的 node、npm 安装的 CLI、musl 版厂商构建
```

- **固定版本**：版本来自 bundle 锁文件 `deploy/bundle/agent-versions.json`，取代 `latest`。
  - npm CLI 另外在 `deploy/bundle/npm/package-lock.json` 里固定，每个包都带 sha512 integrity。
  - 厂商下载物带厂商公布的 sha256；curl 不公布校验和，改用固定密钥指纹校验 PGP 签名。
  - `scripts/build/bundle-agent-versions.mjs check` 让锁文件与运行时目录保持一致：目录里每个运行时要么被打包，要么标为 `unavailable` 并写明原因（例如厂商不公布校验和）。
  - 锁文件不是认证：它从不修改 `certifiedVersions`，因为在桌面端，certified 版本可以免同意直接运行。
  - 没有 musl 构建的运行时标为仅 glibc，在 musl 镜像上会带着原因被拒绝；需要比 bundle 下限更新的 glibc 的厂商二进制，在清单里带各架构自己的 `minGlibc`。
- **两棵 libc 树，自给程度不同**：glibc 上 Node 用官方构建，依赖镜像自己的 glibc 和 `libstdc++`，因为自带更新的 C++ 运行时反而会要求比许多镜像更新的 glibc。musl 上 Node 被改为加载 bundle 自带的 musl 加载器和 C++ 运行时，所以在没有 `libstdc++` 的 Alpine 基础镜像上也能跑，与镜像的 musl 版本无关。
- **发布契约**：bundle digest 是发布契约里的第四个镜像，与 server、runner、workspace runtime 并列：`ImageConfig.agentBundle` 与 `AgentRelease.agent_bundle_image`。
  - 它是可选的，因为沙箱池默认关闭。没有它的目标或发布，序列化、签名和渲染结果都与原来的三镜像版本完全一致。
  - 设置了它时，生产认证要求按 digest 固定，deploy agent 也会拒绝可变 tag。
  - deploy agent 以 `COGNIA_AGENT_BUNDLE_IMAGE` 交给服务器：Compose 环境变量，或 ConfigMap 的 `agentBundleImage` 键。不带 bundle 的发布会清掉这个变量，不会沿用上一次发布的值。
- **项目锁定**：部署仍保留某个旧 bundle 时，项目可以锁定在它上面；锁定的 bundle 已被移除时，以 `bundle_pin_retired` 拒绝。
  - Ops Controller 在 `release_bundles` 里记录每个目标运行过的 bundle（每次成功的 deploy、upgrade、rollback 都会刷新，并裁剪到仍可能被保留的范围）。
  - 签发发布时，它把最近生效过的另外两个 bundle（按 digest 比较）写进 `AgentRelease.retained_agent_bundle_images`；客户端自带这个列表会被拒绝。
  - 服务器从 `COGNIA_AGENT_BUNDLE_RETAINED_IMAGES` 读到它们，最新的在前。回滚会恢复该发布当时携带的列表。
  - 独立部署可以手动设置这两个变量。

### `cognia-sandboxd`

`crates/cognia-sandboxd` 是静态、不依赖 Tauri 的二进制。

**第 ① 步的模式：**

- `install --stage core|libc`：把 bundle 目录拷进注入卷。
- `probe`：在用户镜像里运行并写出 `probe.json`。它检测：
  - libc：看 `/bin/sh` 链接的加载器（`PT_INTERP`），只有 shell 是静态编译时才退回看加载器文件。单看文件是否存在，会误判装了 `musl` 包的 Debian 和装了 `gcompat` 的 Alpine；
  - glibc 还要读 `libc.so.6` 里记录的版本（只读不执行），并检查 `libstdc++.so.6` 是否存在；
  - `/bin/sh`；
  - `/etc/passwd` 里的目标用户；
  - `HOME` 与工作区是否可写；
  - 是否有 CA 证书包。

  退出时带类型化退出码。驱动把 126（exec 格式错误）映射为 `bundle_arch_mismatch`。

  | 退出码 | 原因 |
  | --- | --- |
  | 64 | `probe_libc_unsupported` |
  | 65 | `probe_glibc_too_old`（Node 需要 glibc ≥ 2.28） |
  | 66 | `probe_no_shell` |
  | 67 | `probe_user_missing` |
  | 68 | `probe_workspace_not_writable` |

- `init-agent -- <argv>`：会回收子进程的 PID 1。设置用户、环境变量、`PATH` 与 CA 变量，以继承的 stdio 运行一个子进程，转发信号并透传退出码（子进程被信号 `n` 杀死时为 `128 + n`）。通过容器挂接跑 ACP 与以前完全一样。根本无法启动 agent 时（用户不存在、程序不存在、非 root 却要切换用户）退出码为 125。

  在容器内部，镜像的 `ENV` 与驱动设置的变量无法区分，所以驱动把自己设置的变量名列在 `COGNIA_SANDBOXD_PROVIDED_ENV` 里。不在该列表中的环境内模型凭据来自镜像，会被移除；`COGNIA_SANDBOXD_*` 永远不会传给 agent。镜像自己的 `PATH` 排在前面，项目命令用的是项目自己的工具链；agent 本身及其 shim 通过 `/cognia` 下的绝对路径调用。

`cognia-sandboxd` 同时是一个库。驱动读回的探测报告与 bundle 清单类型都在这里，所以它不能链接 `cognia-net` 或 `cognia-environment`：两者都会把网络栈带进静态二进制。

**第 ② 步的模式：** `serve`，持久沙箱的监管进程（ADR-0184，规划中）。它在一条认证连接上复用 agent、PTY、文件系统、exec、任务工作区和生命周期。每个 agent 的输出流带序号和基于额度的背压；额度用完时停止读取子进程 stdout，而不是丢帧。

### 注入

- **Kubernetes**：三个 init 容器共享挂在 `/cognia` 的 `emptyDir`：
  1. `bundle-stage`（bundle 镜像）执行 `install --stage core`；
  2. `probe`（用户镜像）执行 `/cognia/bin/cognia-sandboxd probe`；
  3. `bundle-libc`（bundle 镜像）只拷贝探测出的那套 libc 目录。

  用户镜像的 entrypoint 被替换为 `cognia-sandboxd`，和 devcontainer 的 `overrideCommand` 一样。只有在验证过的节点池上（例如 Kubernetes ≥ 1.35 且 containerd ≥ 2.1 的 ACK），才改为把 bundle 以只读镜像卷挂载，只剩探测一步。
- **Docker**：bundle 只暂存一次，放进命名卷 `cognia-bundle-<digest12>-<libc>`，引用计数、只读挂载。探测结果按（用户镜像 digest，bundle digest）缓存。

### agent 以哪个用户运行

- **有声明时**：`remoteUser` 优先，其次 `containerUser`，再其次镜像的 `USER`（添加目录条目时从 registry 读取）。
- **未声明时**：gVisor 与虚拟机级档位用 root，由隔离边界兜底，因为 agent 经常在任务中途装依赖；普通容器档位用 UID/GID 10001 并启用 `runAsNonRoot`。
- **记录并展示**：实际 UID 来自探测结果，记录在沙箱上，并在 UI 显示。

### 环境卫生

监管进程会：

- 按 `supervisor.mjs` 的先例，从每个子进程环境里移除自身的密钥；
- 按 `cli/src/x/agent-launcher.ts` 的方式剥掉继承来的模型厂商凭据；
- 复用 `gateway_task.rs`，给每个 agent 独立的 `HOME`/`XDG`/`CODEX_HOME`。

## 影响

- **带来什么**：任何 glibc ≥ 2.28 或 musl、amd64 或 arm64 的镜像，不用改 Dockerfile 就能承载受支持的 agent。agent 升级随 Cognia 发布一起下发，也能一起回滚。
- **代价**：
  - `cognia-sandboxd`、git、ripgrep 的静态 musl 构建；
  - 更大的 CI 矩阵；
  - 每次冷启动多一个 init 步骤（预热池和可用的镜像卷能缩短它）；
  - `cognia-external-agent` 新增默认特性 `tauri-host`，让监管进程可以不带 Tauri 链接它。
- **会拒绝什么，并明确说明**：
  - 没有 shell、glibc 太旧、架构不匹配、声明的用户不存在的镜像；
  - 探测出的 libc 上不可用的运行时。
- **对 ADR-0085 的影响**：`serve` 上线后，其 Node 监管进程不再托管 agent，浏览器服务以 sidecar 形式保留。

## 备选方案

- **`FROM cognia-runner` 镜像**：否决，锁死发行版，agent 升级变成用户重建。
- **agent 放第二个容器**：否决，agent 的 shell 工具会在错误的容器里执行。
- **启动时下载 agent**（Coder init 脚本的做法）：否决，镜像里要有 curl/wget，要在出网策略生效前联网，运行的版本还取决于沙箱启动的时间。
- **每种 libc 一个 bundle 镜像**：否决，一个版本两个 digest，发布契约会多出第五个镜像。
- **保留 Node 监管进程**：否决，它的分块与环形缓冲区缺陷会丢 ACP 帧。

## 实现

- **第 ① 步**：`crates/cognia-sandboxd`（install、probe、init-agent）、`deploy/bundle/`、CI 矩阵条目、版本生成器、第四个发布镜像、带探测缓存的 Docker bundle 暂存。
- **第 ② 步**：`serve` 与协议 v2。
- **后续**：池、凭据、构建、迁移分别是 ADR-0184 到 ADR-0187（规划中）。
