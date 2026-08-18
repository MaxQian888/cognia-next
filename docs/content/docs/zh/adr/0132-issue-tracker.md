---
title: ADR-0132 — 应用内 Issue 追踪器（项目、Issue、执行桥、IM）
description: 每个工作区一个本地 Issue 追踪器——项目、Issue、固定看板、人类/运行时状态机——只读联邦 agent-task 与 agent-team 行，通过 issue 侧的 `issueRuns` 表把 Issue 派发给执行引擎，并进入通知中心与可交互 IM 卡片。
---

# ADR-0132 — 应用内 Issue 追踪器（项目、Issue、执行桥、IM）

| 字段 | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态 | 已接受                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 日期 | 2026-08-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 基于 | ADR-0066 Agent Team 任务看板；ADR-0086 任务作用域资源工作区；ADR-0111 受管工作区 Registry；ADR-0113 工作区 / 项目作用域；ADR-0018 / ADR-0026 插件工作区后端；ADR-0009 / ADR-0025 平台连接器与 A2UI ⇄ IM 桥；ADR-0042 / ADR-0102 通知中心；ADR-0129 统一全局搜索；ADR-0090 统一 Agent 执行                                                                                                                                                                                                                                                                                                                                       |
| 范围 | `types/issues/`、`lib/db/{issues,issue-projects,issue-events,issue-counters,issue-runs,labels,github-issue-mirror}.ts`、`lib/issues/**`（`board-model`、`state-machine`、`views`、`sources/`、`run/`、`notify`、`im/`、`github-*`）、`components/issues/**`、`components/workspace/workspace-overview.tsx`、`app/{issues,projects,workspace}/`、`lib/global-search/providers/issues.ts`、`lib/skills/built-in/issues/`、`lib/connectors/bus.ts`（`issue_action` 分支）、`types/connectors/{interaction,audit}.ts`、`types/notifications/index.ts`、`packages/agent-config-types/src/work-submission.ts`、`crates/cognia-task-workspace/src/lifecycle.rs`、`src-tauri/src/task_workspace.rs`、`lib/git/commands.ts`、`stores/agent/agent-team-store/`（persist v7） |

## 背景

追踪器的切片 ①② （Dexie v170 / v171：项目、Issue、事件、计数器、标签、GitHub 镜像，`/issues` `/projects` `/workspace` 路由）上线时，**切片 ③ 的类型、i18n 键与 UI 占位已随之发出**——`canRun`、四种 `run_*` / `artifact_linked` 事件、`agent-team` / `agent-task` 源 id、「N 个 agent 在工作」磁贴、「我的 agent」视图——但没有任何生产者。这是本仓库反复出现的「建好但休眠」模式。以原始意图（Multica 计划、ADR-0066/0086/0111/0113/0018、已发 changeset 与消息包）为基线的审计列出了缺口：

- 「N 个 agent 在工作」写死为 `0`；「我的 agent」的 `agentKeys` 为空，永远匹配不到。
- 两个已声明的联邦源没有 adapter；`canRun` 没有消费者；`lib/issues/run/` 不存在。
- `/workspace` 链到设置页而不是打开唯一的工作区编辑器（`WorkspaceManageDialog`），也不显示信任状态与在跑 agent。
- 没有 ⌘K provider、没有 ADR（类型文件引用了一个不存在的 ADR）、没有受让人选择器，`WorkItemRefV1.kind` 没有 `"issue"`。
- 切片 ③ 整体——通知、IM 卡片、从聊天建单——未建。
- 相邻的工作区 / 团队缺口：`WorktreeCreate` / `WorktreeRemove` 四处声明零生产者；v86 之前创建的 Agent Team 没有 `projectId`，跨工作区泄漏；休眠的 `lib/terminal/collaboration` 分享模型（见 ADR-0133）；`project-store` 过期 docblock；e2b 工作区后端 shim 的 `else` 分支不可达且查找用了错误的 id 前缀。

非目标沿用切片 ①②：GitHub Projects v2 / 里程碑、双向字段同步、每项目自定义列、保存视图、移动端写入、自由标签重构、MCP 桥、IM `/issue` 斜杠命令、受管工作区页面（有意的技术债）、外部 agent 受让人。

## 决策

### 1. 术语与不变量

`Workspace = Project`（`types/plugin/_compat.ts`），拥有 `WorkspaceRoot[]`、`IssueProject[]`、`Issue[]` 与 `AgentTeam[]`。Issue 的**受让人**是 `IssueActor`：`human`、`agent`（= `Character` id）或 `team`（= `AgentTeam` id）；其他一律被选择器与 IM 处理器拒绝。看板六列固定。人类迁移走 `lib/issues/state-machine.ts`；**运行时拥有 `in_progress`**——人类永远不能把 Issue 移过去，只有 run 可以；run 结束把 Issue 停在 `in_review`，绝不 `done`；取消 run 退回 `todo`。`applyRuntimeIssueStatus`（`lib/db/issues.ts`）是运行时迁移的唯一写入者。

### 2. 执行桥——`issueRuns`（Dexie **v174**）与 `IssueRunAdapter`

`lib/db/issue-runs.ts` 新增 `issueRuns` 表（`&id, issueId, [issueId+status], projectId, [projectId+status], adapterId, kind, targetId, status, startedAt, updatedAt`）——「哪些 run 属于这个 Issue」以 **issue 侧为唯一真源**；执行引擎从不加 `issueId` 列，新引擎接入不需要 schema bump（`AgentTeamTask.metadata.issueId` 只是反向便利）。之所以认领 v174 而不是 v172，是因为两个并发分支持有 v172（ADR-0130）与 v173；Dexie 允许留空。

`lib/issues/run/registry.ts` 定义 `IssueRunAdapter { id, kind, canRun(issue, project) → verdict, start(issue, ctx) → IssueRun, cancel(runId) }` 与 `registerIssueRunAdapter` / `listIssueRunOptions` / `startIssueRun`（拒绝或派发；**派发失败必须抛出**，绝不吞掉）。三个 adapter：`agent-task`（`createAgentTask` → `runAgentTaskNow`，由 `agentTaskAttempts` 的 `liveQuery` 结算）、`agent-team`（`createTask({ metadata: { issueId } })` + `agentTeamManager.start`，在唯一汇点 `team-completion-linkage.ts` 结算，产物取自 delivery 节点 / 子运行工作区路径）、`github-loop`（仅当项目持有 `github-repo` 资源；在 `awaiting_approval` 闸门下执行 `executeIntegrationAction("runIssueLoop")`；仅桌面）。`running.ts` 暴露 `listRunningIssueIds()` 与 `viewerAgentKeys()`（所有 Character + AgentTeam 映射为 `agent:<id>` / `team:<id>`），这使得单人应用里「我的 agent」= 全部 agent/team 受让人。

### 3. 联邦源

`lib/issues/sources/{agent-task-source,agent-team-source}.ts` 以**只读**（`READ_ONLY_ISSUE_CAPABILITIES`）实现两个已声明的 `IssueSourceAdapter`，通过同一张表映射引擎状态（`agent-status-map.ts`：`pending→backlog`、`blocked/claimed→todo`、`in_progress/paused→in_progress`、`review→in_review`、`completed→done`、`failed/cancelled→canceled`）并深链回原生页面。联邦行默认入板、带源徽章、工具栏可按源过滤；带 `issueId`（metadata 或 `issueRuns.targetId`）的行标注「来自 KEY-1」。

### 4. UI

`issue-console.tsx` 读取实时 viewer（`viewerAgentKeys`）与运行集合；新的 `assignee-picker.tsx`（Character + AgentTeam + 我 + 未指派）接入创建与详情；`run-issue-dialog.tsx` 是 `canRun` 的消费者（模式 = 默认本地 AgentTask / AgentTeam / GitHub loop），详情面板显示运行记录、产物与取消。`/workspace` 直接挂载 `WorkspaceManageDialog`（一个编辑器，两个入口），按 root 显示信任状态（`lib/db/trusted-workspaces.ts`）与实时在跑 agent 磁贴。⌘K 新增 `lib/global-search/providers/issues.ts`（kind `issue`）；`WorkItemRefV1.kind` 新增 `"issue"`。

### 5. 通知与 IM（切片 ③）

`lib/issues/notify.ts` 把 Issue 事件投影到通知中心（`NotificationSource` `issue`，命令 `issue.open`）：指派 / 改派、run 成功 / 失败、进入 `in_review` / `done` / `canceled`、以及非本人评论。带固定水位 + 已见集合的 `liveQuery` 监听器不会漏事件；当 Issue 来自 IM 会话（`Issue.origin = { kind: "im", conversationKey, messageId? }`）或会话绑定了该项目（`ConversationOverrideRow.issueProjectId`）时，同一事件经治理队列推回 IM，受会话主动推送开关与 `hasNoLeakingPii` 双重门禁。

IM 卡片（`lib/issues/im/card.ts`）是纯 A2UI 构建器：恰好是**合法的人类迁移**（绝无 `in_progress`）、引擎可接单时的 **Run** 按钮、以及 **打开** 链接；无按钮渠道使用编号镜像。按钮通过 `bindingHintFields`（Discord / Telegram / Slack / WeCom / Lark 映射器共用）携带 `bindingKind: "issue_action"` + payload，点击进入 `lib/issues/im/callback-handler.ts`（`ConnectorBus` 在 `tool_approve` 之前的短路分支）而不是模型轮次。移动 / 运行按钮可重复点击；只有建单确认卡 consume-once。从聊天建单是内置 skill `issue.create`（write 级，`hitlSurface`）：确认卡列出 ≤ 5 个项目、会话上次选择排在最前，**不点项目按钮就不落库**；`issue_list_projects` 解析项目名。Lark 与 Slack 入站现在携带 `replyTo`，引用建单在这两处与 Telegram / Discord 一致。新增审计类型：`issue.card_action`、`issue.card_action_denied`、`issue.im_pii_blocked`。

### 6. 同一改动中补齐的相邻工作区 / 团队缺口

- **Worktree hooks 触发**（ADR-0111 决策 9，措辞已在那里修订）：Registry 通过 `WorktreeLifecycleSink`（Rust）发出，`lib/git/commands.ts` 在 `git_worktree_add/remove` 之后发出（TS）——两个生产者，因为 Registry 前面没有站着 Agent Team allocator 与源代码管理面板。仅观察性。
- **v86 之前的 AgentTeam** 回填 `projectId = DEFAULT_PROJECT_ID`（persist v7 `backfillTeamProjectIds`，在 `migrate` 与 `activateAgentTeamAccountStorage` 中都应用）；`updateTeam` 补打；模式选择器删除 `!t.projectId` 逃逸。
- **e2b**：`resolveWorkspaceBackendByKind`（精确 id，再 `:<kind>` 后缀）取代永远匹配不到已注册 `cognia-e2b-sandbox:e2b` 的 `"e2b"` 查找；删除 `setE2BBackend/getE2BBackend` shim 与不可达的插件分支。修正 `project-store` docblock。

## 影响

- 追踪器表面不再有休眠项：每个已声明的源、事件类型、能力与视图都有生产者或消费者，运行时 / 人类边界只在一处强制。
- 引擎对 Issue 无感；新增引擎 = 一个 adapter + 一行状态映射。
- IM 成为 Issue 的一等参与者，既不需要新传输，也不需要每次点击都走模型摘要；PII 不过闸不出门。
- 同伴的两个 Dexie 认领（v172、v173）迫使本 ADR 跳到 v174——见 schema 块注释。

## 验证

各阶段的共置测试（adapter、源、通知监听器、卡片构建器、回调处理器、skill、worktree sink、persist 迁移）；`pnpm i18n:build && pnpm lint:i18n` 对齐；新模块的作用域覆盖率 ≥ 90%。完整的 `test:coverage:changed --strict` 与 `tauri-smoke` 在共享且磁盘吃紧的机器上未能跑完，记为待办。
