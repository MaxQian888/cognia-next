---
title: "0229 — 每个工作区独立的端口租约"
description: "执行 Host 为每个物理工作区根目录分配持久端口块，在进程启动时注入环境变量，并在设置中提供只读状态与显式释放操作。"
---

# ADR 0229 — 每个工作区独立的端口租约

**状态：** Accepted
**日期：** 2026-10-16
**修订：** ADR-0111（托管工作区生命周期与策略）
**相关：** ADR-0031、ADR-0059、ADR-0088、ADR-0144、ADR-0182

## 背景

工作区缺口 W4 指的是端口分配。目录与 Git worktree 隔离并不隔离主机网络：两个开发服务器仍可能同时尝试监听 3000 端口。托管工作区 registry 已经管理执行根目录与生命周期，但桌面会话目录和用户项目 checkout 同样会启动进程，也需要遵循同一套契约。

具有约束力的决策位于 `docs/plans/2026-10-16-workspace-port-allocation-design.md` 的 “Decisions (2026-10-16)” 一节。本 ADR 记录这些决策、已提交的分配器与执行集成，以及设置和只读 UI 的契约。决策被采纳不等于已经完成真实桌面、容器或远程 runtime 验收。

## 决策

### 1. 一个物理执行根目录拥有一个端口块

托管 registry 工作区、桌面会话目录和用户项目 checkout 都在覆盖范围内。同一 namespace 中，一个 canonical 物理根目录只有一份租约；指向该目录的多个别名或主体共享端口块。共享源仓库的不同 worktree 仍是不同的执行根目录。

台账保存在 `task-workspaces.sqlite`，包括 `workspace_port_leases`、`workspace_port_subjects` 和已记录的根目录别名。主体类型为 `registry`、`desktop-session` 和 `project-root`。Host 自动发现的 checkout 使用最后一种类型，key 为 `root:<canonical-path>`，与前端项目 ID 区分。移除一个主体引用不会删除仍被其他主体引用的端口块。

`WorkspaceLifecyclePolicy` 默认值为 `portRangeStart: 41000`、`portRangeEnd: 48999`、`portBlockSize: 10`，共 800 个端口块。Serde 默认值保证旧策略数据仍能读取。端口范围包含两个端点。校验要求所有值为整数，起点至少为 1024，终点至多为 65535，起点不大于终点，块大小为正且至少能在范围内容纳一块。容量计算为 `floor((end - start + 1) / blockSize)`。

修改策略只影响新分配。现有租约保留原端口，即使新范围已经不包含它们，也只报告诊断，不会悄悄为正在运行的服务器换号。

### 2. SQLite 串行化分配；探测不长期占有套接字

执行 Host 是分配权威。分配在 SQLite `BEGIN IMMEDIATE` 事务内完成，共用同一台账的不同进程因此串行决定分配结果，不能分配相互重叠的端口块。前端不实现第二套分配器。

每个候选端口都探测 IPv4、IPv6 的 loopback 和 wildcard 地址，并禁用 `SO_REUSEADDR`。不支持 IPv6 的情况有明确处理。只要块内有端口已绑定，就跳过该块。当分配即将因耗尽而失败，或闲置释放首次检测到占用时，允许以 20 ms 间隔重试、最多等待 500 ms，以处理被子进程短暂继承的探测套接字；正常成功分配不承担这段等待。

探测后关闭套接字。因此，租约是持久分配记录，不是操作系统级套接字占有。后来发现的占用只用于报告：监听者可能就是工作区自己的服务器。Cognia 不杀死进程，也不重新分配该块。耗尽时返回明确错误，指出 `portRangeStart`、`portRangeEnd` 和 `portBlockSize` 设置；不会回退到 3000。

### 3. Host 在明确边界内解析身份

显式 registry workspace ID 优先。否则，将 canonical cwd 与执行根目录按路径组件匹配，选最具体的匹配，再查已登记的外部主体。`source_root` 不能代替执行身份。

只有在执行边界，未匹配的 cwd 才能尝试发现 Git worktree 根目录。发现过程忽略 `GIT_*` 环境覆盖，不跨文件系统边界，不接受 bare repository。文件系统根目录、home 本身或包含 home 的祖先目录都不自动登记，必须显式注册。嵌套仓库与 linked worktree 保留各自的根目录。发现失败与边界拒绝作为诊断展示；没有登记主体的非 Git 目录可以不带租约执行。一旦根目录符合条件，分配或存储失败就中止执行，不能悄悄丢失端口环境变量。

只读解析不发现、不登记、不分配。因此，首次执行前列表可以如实显示“尚未分配”。

### 4. 生命周期保留号码，直到释放

新托管工作区在 setup script 运行前取得端口块。现有工作区在首次执行时惰性补齐。归档保留租约，恢复复用租约；归档状态本身不能证明进程已停止。删除、prune 和 provisioning 回滚通过既有生命周期保护释放引用。桌面会话软删除保留引用以便恢复，永久删除会释放。项目归档保留引用，项目删除按台账中的精确记录释放，即使目录已经不存在。

启动协调修复 registry 关联，并报告根目录重复、区间重叠、超出范围、registry 关联歧义或不一致，以及根目录缺失。目录不存在或暂时离线，不代表可以自动回收端口块。设置中的显式释放是处理闲置归档 registry 租约，以及孤立或根目录缺失外部主体的恢复入口。

Registry 释放要求状态为 `Archived` 或 `Restorable`，且端口块空闲。`WorkspaceBusy` 和 `Occupied` 拒绝会保留租约，占用错误包含具体端口。主体释放可指定单个 `leaseId`，避免多根项目一次丢失所有引用。Host 派生的 `root:<path>` 主体使用已记录的根目录身份，释放时不要求对已经消失的目录再次做 canonicalize。

### 5. 在每个启动边界最后应用可信环境变量

Host 提供且仅提供以下键：

| 键 | 值 |
| --- | --- |
| `COGNIA_PORT` | 端口块的首个端口 |
| `COGNIA_PORT_COUNT` | 连续端口数量 |
| `PORT` | 与 `COGNIA_PORT` 相同 |

最后一个端口为 `COGNIA_PORT + COGNIA_PORT_COUNT - 1`。可信覆盖值在 request、profile、launch 与 sandbox 环境处理之后应用，模型或用户传入的环境值不能替换它。DSH、bot、gateway 和 sandbox 的白名单保留这三个精确键，不放开任意 `COGNIA_*` 输入。解析使用最终主机 cwd，并在将其转换为 runtime 内路径之前完成。不修改会被多个会话共享的进程全局环境。

`cognia-core/src/workspace_env.rs` 定义 provider 接口；桌面与 `cognia-server serve` 安装 `cognia-task-workspace-host/src/workspace_env.rs` 中的实现。持久桌面 PTY host 通过经过认证的 native bridge 接收可信环境变量，不另开一份台账。旧 terminal host 继续服务已有会话；需要该 bridge 的新启动会被拒绝，并提示重启。若旧 host 无法解析远程 profile 的环境，也拒绝相应启动。兼容处理不能悄悄产生缺失租约的 shell。

已提交的第三阶段覆盖以下启动位置：

| 进程类别 | 集成位置 |
| --- | --- |
| PTY、一次性命令与 headless terminal | `crates/cognia-terminal/src/{session,exec,headless,host_client,host_bridge}.rs` |
| External agent、ACP terminal、DSH 与 managed gateway | `crates/cognia-external-agent/src/{process,terminal,presets}.rs`；bot 过滤位于 `crates/cognia-exec-sandbox/src/bin/cognia-external-agent-launcher.rs` |
| Workspace-runtime、容器与 Kubernetes agent | `crates/cognia-external-agent/src/{workspace_runtime_backend,container_backend,kube_backend}.rs`；`services/workspace-runtime/src/supervisor.mjs` |
| OS sandbox 与项目 setup，包括其 sandbox 分支 | `crates/cognia-automation/src/sandbox.rs`；`crates/cognia-companion-rpc/src/project_environment.rs` |
| Docker boot、生命周期脚本、持久 runtime 与 task-shell exec | `crates/cognia-sandbox-pool/src/docker.rs`、`docker/{persistent,task_shell,remote_prep}.rs`；`crates/cognia-sandboxd/src/{env,init}.rs` |
| E2B 与 Kubernetes 远程准备 | `crates/cognia-sandbox-pool/src/remote/{e2b/mod,kubernetes}.rs` |
| Sidecar Bash 前台/后台、共享 exec/spawn、terminal REPL、advanced shell、process lifecycle、LSP 与搜索 | `sidecar/src/platform/process/exec.ts` 及其调用方；`crates/cognia-companion-rpc/src/sidecar_runtime.rs` 中的 `workspace.portEnv` |
| CLI external agent、ACP PTY 与 OS sandbox | `cli/src/runtime/workspace-port-env.ts`、`external/{node-backend,pty-terminals}.ts`、`sandbox/os-sandbox-exec.ts` |
| Host 后台任务 | `crates/cognia-jobs/src/supervisor.rs` |

Pro IDE 的桌面与 headless 子进程启动集成是 `crates/cognia-codeserver/src/{process,remote}.rs` 中的独立改动，由 ADR-0088 记录，不属于上述已提交第一至第三阶段的证据。其契约是让子终端与任务继承工作区环境，同时让 code-server 自身的基础设施监听端口独立于开发服务器端口块。

### 6. Runtime placement 复用号码，不自动转发主机端口

容器和远程 runtime 执行时，在目标网络 namespace 内接收主机根目录已有的 `host-loopback` 租约值。Placement 不分配第二块。台账保留 namespace 字段以支持显式 namespace 记录，但执行 provider 解析的是权威主机租约。主机探测不能证明远程 namespace 内端口可用；无法探测的 namespace 显示为未知，不能显示为空闲。

可信 `workspace_env` 同时传入 boot 生命周期命令及每次 agent、task-shell 执行。端口环境值不同的持久 runtime 不能复用。分配不会发布或转发端口，不修改已批准的 `forward_ports`，也不创建 preview URL。SSH 目标不在范围内。

### 7. 设置管理租约；工作区视图只读展示

数据 / 维护中的生命周期设置块编辑三个端口策略字段、展示容量、说明已有租约保持原号码，在保存前校验，并保留服务端错误原文。

租约管理块展示每个范围、端口数量、canonical 路径、所有主体、namespace、当前绑定端口以及协调或发现诊断。加载中、空列表、失败和不支持是不同状态。端口被绑定是观测结果，不证明存在外部冲突。释放受支持租约必须通过 `runWorkspaceUserAction` 作为显式用户操作，在确认弹窗中说明端口块可能重新分配。拒绝详情保持可见，操作后刷新列表。

工作区环境、工作区概览根目录和产物项目概览根目录复用一个小型只读 badge。环境列表读取可选 `portLease` 投影，根目录视图使用只读解析。占用未知与尚未分配保持区分。渲染或刷新这些视图绝不调用分配命令。英文与中文文案写入 next-intl 拆分源文件，再生成聚合产物。

没有桌面 Host，也未连接执行 Host 的独立 web 模式中，这些设置控件明确处于不可操作状态，说明需要桌面/host 应用。TypeScript 类型记录不支持的契约，并由测试固定，不把不支持伪装成空台账。

命令实现位于 `crates/cognia-task-workspace-host/src/host_surface.rs`，TypeScript 包装位于 `lib/task-workspace/client.ts`：

| `task_workspace_port_lease_` 后的命令后缀 | 契约 |
| --- | --- |
| `get` | 读取一个 registry 工作区租约 |
| `resolve` | 按显式 workspace ID 或 cwd 读取；不发现、不分配 |
| `subject_get` | 读取某个外部主体的全部已记录租约 |
| `list` | 读取租约、所有主体、占用和诊断；不修复、不分配 |
| `ensure` | 幂等分配或复用 registry 租约 |
| `resolve_ensure` | 执行时解析，包括符合边界的 checkout 发现与分配 |
| `subject_ensure` | 登记桌面会话或项目根目录，共享物理根目录租约 |
| `release` | 释放闲置且已归档或可恢复的 registry 引用 |
| `subject_release` | 释放外部主体引用，可通过 `leaseId` 限定范围 |

`task_workspace_policy_get` 和 `task_workspace_policy_set` 继续作为策略权威。协调属于 service 生命周期操作，不是读取接口中隐藏的写入。

## 后果与已知限制

- 号码跨重启和归档保持稳定，但保留的归档会持续占用逻辑容量，直到释放。缩小范围不会压缩或重排旧租约。
- 不同 Cognia 数据目录使用不同台账，只能通过瞬时探测互相避让。其他应用或其他台账仍可能在探测结束后抢先绑定端口。
- 长驻 shell 保留启动时获得的环境。改变 cwd 或策略不会改写运行中 shell 的环境变量。
- 应用必须实际读取 `PORT` 或显式端口块键。Cognia 自身的 `pnpm dev` 与 Tauri dev 配置仍使用 3000，本工作没有将它们接入租约。
- 租约分配不会停止进程、打开防火墙、转发端口，也不能保证容器或远程机器内部的端口可用。
- 根目录缺失与发现诊断用于支持显式恢复；自动删除会混淆暂时离线与已经废弃的工作区。

## 实现与验证边界

分配器与生命周期实现位于 `crates/cognia-task-workspace/src/ports.rs`、`service.rs`、`store.rs` 和 `types.rs`，测试在对应文件内。第一至第三阶段由 `98fe2cb4c`、`c6c419097` 和 `413967d5d` 三个提交记录。Host 命令测试、`lib/task-workspace/client.test.ts` 与 `execution-port-lease.test.ts` 固定读取/ensure 的区分及前端主体契约。启动集成测试固定最终环境，包括错误传播与最后覆盖优先级。

第四阶段的设置、hook 和视图共址测试必须覆盖校验与容量、Host 错误原文、所有主体类型、占用与诊断、确认释放及拒绝、web 不可操作状态、未分配 badge，以及读取不会调用分配命令。翻译生成、双语一致性与共址测试审计是独立检查。这些检查不能替代两个工作区分别启动真实监听服务、重启稳定性，或原生、容器、远程运行验收。
