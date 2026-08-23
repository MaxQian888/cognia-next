---
title: "ADR-0111：受管工作区注册中心与多根 Bundle"
description: 在复用现有 Task Workspace patch 引擎的前提下，统一 worktree 所有权、base ref 选择、跨根原子 apply、敏感资源授权与生命周期 hooks。
---

# ADR-0111：受管工作区注册中心与多根 Bundle

## 状态

提议、部分实现（2026-08-23）。修订 ADR-0086 与 ADR-0108。

ADR-0111 **尚未接受**。只有“验证”章节的端到端矩阵全部通过后才能接受，其中包括后台隔离、两种 handoff、archive/restore、imported discovery 与真实 Tauri smoke。

## Rollout 更正（2026-08-23）

2026-08-13 关于 Registry storage、bundle、scheduler isolation 与 AgentTeam lease 已实现的表述不准确。当前代码已经具备持久化 Registry/Bundle 行、带签名锁的原子 Git 创建、事务式多根申请（含非 Git shadow）、canonical session binding、仓库配置校验、生命周期策略持久化与容量门禁、archive/restore/delete、受保护的 permanent/imported 分类、启动导入与显式 Adopt、provider-neutral PR base resolution、Tauri/Companion 命令、scheduled chat 的 canonical bundle lease、new-chat/header 控件，以及统一的 Overview/Environments/Source Control 视图。手动 Worktree 面板也会读取 Registry 所有权，并拒绝移除受管或导入环境。

Rollout 仍未完成：尚未证明所有可写 agent 入口都经过 Registry Bundle；Agent Team 仍会构造 legacy allocator，持久化多根 Selective Apply 与 Continue Branch handoff 尚未完成，生成的 headless catalog 落后于 canonical protocol，定时 cleanup/history、grant UX、聚合交付与验收 E2E 矩阵仍是开放项。在这些 consumer 与测试闭环前，不得宣称 legacy allocator 或 live-tree fallback 已完成迁移。详见 `docs/research/workspace-worktree-implementation-audit-2026-08-23.md`。

## 背景

Cognia 已经拥有 Task Workspace 的快照与 patch、Git worktree 通道、Workspace Trust、`Project` 级多根，以及 Agent Team 的 Git 隔离。对照 Codex Worktrees、Claude Code Worktrees、VS Code Worktrees 与原生 `git-worktree`，真正缺失的不是新的 patch 原语，而是统一的所有权、版本化的执行上下文、跨根的组合、敏感资源授权与产品级可发现性。证据见 `docs/research/managed-workspace-registry-gap-analysis-2026-08-07.md`。

今天有三个所有者在互不协调地创建和移除 Git worktree（`crates/cognia-task-workspace::create_execution`、Agent Team dispatch 的三条并行通路、以及用户端 `worktree-panel.tsx`）。`SessionExecutionContext.baseRef` 只是一个提示，后端并不消费。scheduled 且 `location === "local"` 的运行会直接落在用户 live tree 上。多根只存在于单个 `Project` 内部。`.cognia/workspace.json` 不存在。`WorktreeCreate` / `WorktreeRemove` hook 事件已声明但 dormant。

## 决策

1. **Registry 落在 `cognia-task-workspace` 内部。** 不新建 crate。在与 `service.rs` / `store.rs` 同级新增 `registry.rs`（状态机、所有权、reconcile、retention）、`bundle.rs`（Bundle / RootLease、原子 apply）与 `sensitive.rs`（分类与审计）。`store.rs` 通过一次 up-migration 增加两张表：`workspace_registry`（owner_type、owner_ref、state、source_root、git_common_dir、base_kind、base_ref、head、branch、isolation_kind、execution_root、snapshot_task_id、size_bytes、last_used_at、locked_by、pin）与 `workspace_root_leases`（bundle_id、workspace_id、logical_root_id、role、alias_path）。

2. **状态机。** 每个受管工作区在 `provisioning → active → (archived | conflict) → (restorable | removing) → removed` 之间迁移。Registry 受控路径之外的任何迁移一律 fail closed。`active`、`pinned`、`permanent`、`locked`、`dirty`、`untracked`、`unpushed`、`unapplied`、`conflict` 都不参与自动 prune。目录回收与快照过期是两个独立的定时作业，各自写审计。

3. **签名所有权。** `ownerType ∈ {user, imported, session, team, scheduled}` 与 `owner_ref` 是身份；`cognia/task/**` 之类的分支前缀不再作为所有权凭据。启动 reconcile 只认领签名可验证的行；未认领的磁盘现存 worktree 标记为 `imported`，永不自动 prune。受管 worktree 携带 `git worktree lock --reason "cognia:<workspaceId>"`；只有 Registry 受控删除路径可以解锁。`components/source-control/worktree-panel.tsx` 拒绝对任何受管行执行 force remove。

4. **默认 detached HEAD。** `service::create_execution` 使用 `git worktree add --detach <path> <base>`。仅当用户显式执行 `Create branch here` 时才创建分支，届时 Registry 根据 base kind 在 `-b <name>` 与 `git branch --track` 之间选择。彻底消除每次 dispatch 遗留 `cognia/task/**` 分支。

5. **真实的 `WorkspaceBaseSpec` 输入。** `SessionExecutionContext.baseRef` 改为强类型 `WorkspaceBaseSpec = "workingState" | "localHead" | "remoteDefault" | { gitRef } | { pullRequest }`，端到端穿过 Registry 进入 `create_execution`。交互式 worktree 默认 `workingState`（本地脏内容被带入隔离根）；后台与 scheduled 的 Git 任务默认 `remoteDefault` 并在触发时刷新 `origin/HEAD`。远端缺失、离线或 setup 失败时立刻 fail closed 并给出可操作错误，绝不回退到 live tree。旧的 `worktreePath` / `branch` / `baseRef` 镜像字段保留一个发布周期，作为 kill switch 下的只读回退。

6. **多根 Bundle 与原子 apply。** `WorkspaceBundle` 为每个逻辑根申请一个 `WorkspaceRootLease`。共享 Git common dir 的根复用一个物理 worktree；不同仓库的根各自建立 worktree；非 Git 根走 `IsolationKind::Shadow`，通过 `snapshot::capture` + `materialize` 实现。Apply 分三段：precheck → apply-with-inverse（直接复用 `service::apply_patch_set_with_options`）→ compensate。补偿成功则回到 apply 前状态；补偿失败则整个 bundle 进入 `state = conflict` 并精确保留部分 apply 视图，恢复入口沿用现有三态 `ConflictResolution`（`RetryMerge` / `ApplyTask` / `KeepCurrent`）。跨仓库发布按仓库分别建立 branch/PR，在 UI 上聚合为一个交付单元；不声称跨仓库的网络原子性。

7. **`.cognia/workspace.json` v1 作为可入版本控制的配置。** 该文件只保存可安全进入 VCS 的信息：逻辑 root ID、相对路径提示、role、默认执行与 base 策略、setup 与 actions、非敏感 env 变量、sparse paths、cache link 目标（相对路径）、include patterns、走 `WorktreeCreate` / `WorktreeRemove` 的生命周期 hooks，以及所需 secret 的**名称**。真实 root 绑定、Keyring secret ID、敏感路径授权、worktree 存储根与设备级容量上限都放在设备本地表。schema 种子为 `version: 1`。

8. **敏感资源基于显式授权。** Include pattern 仅接受相对路径，拒绝 `..`、绝对路径与逃逸 symlink。敏感路径默认拒绝。交互任务可对某路径持久授权（记录审计）。后台任务只能使用**已有授权**的路径；缺少授权即 fail closed，不做静默降级。跨边界复制必须先过 `packages/redact/src/index.ts::hasNoLeakingPii`。

9. **激活 `WorktreeCreate` / `WorktreeRemove` hook。** _（措辞由 ADR-0132 切片 ④ 修订，生产者随之落地。）_ 生产者有两个而非一个：Registry 状态机通过注入的 `WorktreeLifecycleSink`（`crates/cognia-task-workspace/src/lifecycle.rs`，由 `src-tauri/src/task_workspace.rs` 安装）在 `GitWorktree` 执行进入 `active` 以及被 discard / prune 时发出；渲染端 `lib/git/commands.ts` 在 `git_worktree_add` / `git_worktree_remove` 成功后发出同样的事件，覆盖 Registry 前面没有站着的另外两个所有者——Agent Team allocator 与源代码管理 worktree 面板。非 Git 根的 materialized shadow 不发事件。两个事件都是观察性的（绝不阻塞 git 操作），走普通的会话作用域 hook runner；它们**不**额外做 Workspace Trust 检查——信任门禁施加在打开 worktree 的位置，而不是 hook 触发的位置。

10. **保留策略。** 默认活跃受管目录上限 15；快照保留 30 天；blob 预算 1 GiB。三者均可在设置里调整。目录回收与快照过期分开执行，共同遵守决策 (2) 的"不可 prune"清单，各自写一条审计。

11. **交互产品入口。** 新建聊天提供显式的 `Local | Worktree` 选择器，附带 base 与 environment 选择；交互任务推荐默认 Worktree。Chat Header 持续显示 path · branch · base chip，popover 提供 Open in IDE、Open in Terminal、Handoff to Local、Handoff to Worktree、Review、Apply、Create branch here、Push、Create draft PR、Archive、Restore。统一的 Managed Workspaces 页展示所有 Registry 行的 owner、state、base、branch、path、WIP、ahead/behind、size、lock、last-used 与 PR 状态；受保护删除拒绝任何绕行。

12. **执行链路迁移。** `lib/scheduler/executors/index.ts` 强制所有 scheduled 触发经 Registry Bundle；原先落在 live tree 的 `location === "local"` 分支删除。`lib/ai/agent/agent-team-runtime.ts` 与 `lib/ai/agent/team/dispatch-teammate.ts` 每次 dispatch 通过 Registry Bundle 获取 lease；`lib/ai/agent/team/workspace/{allocator.ts, reconciler.ts}` 本次直接删除，如果没有其他消费者 `WorktreeGitOps` seam 一并清理。

13. **发布路径继续走 `PullRequestProvider`。** Registry 的 Push / Create draft PR 按仓库调用 `types/review.ts::PullRequestProvider` 的 `.push` / `.create`。`lib/ai/agent/team/pr-feedback/*` 保持现状（仍直接依赖 Octokit），不在本次工作范围。

14. **Kill switch。** `developer.taskWorkspace` 在一个发布周期内保留为 rollback kill switch。关闭时 Registry 被绕过，旧路径读取决策 (5) 中保留的镜像字段运行；Registry 数据保留。下个发布周期同时移除 kill switch 与镜像字段。

## 影响

- 只有 Registry 一个所有者管理全部受管 worktree；不同调用方无法互相误删。
- 每个 scheduled 与后台运行都被隔离；scheduled 触发无法看到用户 live tree。
- Base ref 选择首次真正到达后端；每次 dispatch 的 stale 分支消失。
- 多根 apply 在 Bundle 内是原子的，失败会产生可检视的 `conflict` 状态，而不是部分成功。
- 敏感路径无法在无授权的情况下进入后台执行。
- Dormant 的 `WorktreeCreate` / `WorktreeRemove` hook 成为用户预期的扩展点。
- 产品入口（新建聊天选择器、Header chip、统一管理页）达到 Codex 与 Claude Code 的可发现性水位，但不视觉克隆二者。
- 保留策略层次清晰：目录压力与快照年龄是两根独立的杆。
- `pr-feedback` 与非 GitHub `PullRequestProvider` 适配器都是独立的后续工作。

## 验证

Rust 单元与集成测试（`cargo test`）：状态机迁移与非法迁移拒绝；启动 reconcile 仅认领签名行；lock reason 校验；默认 detached HEAD；`WorkspaceBaseSpec` 抵达 `create_execution`；Bundle apply 故障注入涵盖 precheck 拒绝、中途 apply 失败补偿成功、以及补偿失败进入 `conflict`；进程重启后 `conflict` 可恢复；retention 分离（目录回收 vs 快照过期）遵守不可 prune 列表；非 Git shadow 拒绝 `..`、绝对路径与逃逸 symlink；敏感路径授权持久化与后台 fail-closed。

前端 co-located 测试（`pnpm test:coverage:changed -- --strict`，改动文件 ≥ 90 %）：新建聊天选择器；Header chip 与 popover 的每个动作与错误分支；统一 Managed Workspaces 页的状态矩阵与受保护删除拒绝路径；多根 Source Control 聚合视图；`worktree-panel.tsx` 拒绝对受管项 force；敏感授权对话框。所有新用户文案在 `i18n/messages/en.json` 与 `zh-CN.json` 同时存在，`pnpm lint:i18n` 通过。

端到端（`pnpm test:e2e`）：脏本地 → 交互 Worktree → 精确 apply 回本地；scheduled 任务从 clean remote 执行并断言 live tree 未被修改；多仓库 Bundle 原子 apply 与补偿成功；Bundle 补偿失败进入 conflict 后手动恢复；Agent Team 与普通 Session 并发运行时不会互删 worktree（lock 生效）；archive 立即释放目录、30 天内 restore 成功、超过 blob 预算安全 prune；detached workspace `Create branch here` → push → 通过 `PullRequestProvider.create` 建 draft PR。

预检与 gate：`test-gap-auditor`、`i18n-reviewer`、`static-export-auditor`、`tauri-rust-reviewer`、`pii-gate-auditor`、`wiring-auditor` 按 diff 触发；`rtk tsc && rtk pnpm lint && rtk pnpm lint:i18n && pnpm i18n:sort:check`；`pnpm test:coverage`（仓库层分层地板）；`rtk cargo test --manifest-path src-tauri/Cargo.toml` 加 `cargo fmt --check` 与 ratcheted clippy；`rtk pnpm docs:build`；`pnpm audit:colocated-tests`；真实 `pnpm tauri dev` smoke 覆盖新建聊天 Worktree → apply → restore → archive。

## 参考

- 研究：`docs/research/managed-workspace-registry-gap-analysis-2026-08-07.md`
- Codex Worktrees：[developers.openai.com/codex/app/worktrees](https://developers.openai.com/codex/app/worktrees)
- Claude Code Worktrees：[code.claude.com/docs/en/worktrees](https://code.claude.com/docs/en/worktrees)
- VS Code Worktrees：[code.visualstudio.com/docs/sourcecontrol/branches-worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees)
- git-worktree：[git-scm.com/docs/git-worktree](https://git-scm.com/docs/git-worktree)
- 修订：`docs/content/docs/zh/adr/0086-task-scoped-resource-workspaces.md`、`docs/content/docs/zh/adr/0108-codex-inspired-desktop-workflows.md`
