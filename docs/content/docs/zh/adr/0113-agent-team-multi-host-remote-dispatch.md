---
title: "ADR-0113：AgentTeam 多 Host 远程分发"
description: 在保留现有 task、run、review、workspace 与 delivery authority 的前提下，把 durable AgentTeam 子任务分发到已认证 Cognia worker。
---

# ADR-0113：AgentTeam 多 Host 远程分发

## 状态

已接受并进入 dark launch（2026-08-12）。远程分发默认仍关闭。

## 背景

AgentTeam durable-v2 已经拥有 child admission、attempt、checkpoint、evidence、decision、retrospective 与 Git delivery。`ExecutionRun` 负责跨 runtime 的 run journal 与 binding。`ExecutionBroker` 负责每台执行主机的准入。Task Workspace 管理隔离 Git workspace，SecurityStore 管理已认证 device 与 grant，Fleet 则是公开的运维投影。

真正缺失的能力是有限且明确的：headless brain 无法选择两台并发连接的执行主机，无法通过现有 Agent RPC v2 分发 child turn，也无法在不削弱现有 authority 的前提下恢复这些 turn。新建通用 task、queue、lease、review、lineage 或 fleet 子系统会重复已有实现，因此不采纳。

## 决策

1. **brain 继续是 authority。** `AgentTask`、AgentTeam durable-v2 行、`ExecutionRun`、action review receipt、decision/evidence 记录与 delivery graph 均保留在 brain。worker 只执行 turn 并返回协议事件；worker 不独立结算 team 状态或发布 delivery。

2. **Agent RPC v2 是唯一 runtime protocol。** `session/create` 以 additive 方式接受 `commandId` 与可选 `HandoffEnvelope`。envelope 在 `@cognia/agent` 中只有一份 canonical 定义；`@cognia/agent-config-types/handoff-envelope` 仅保留兼容 re-export。远程 handoff 拒绝调用方控制的 `cwd`，并要求 `worker-dispatch-v1` capability。

3. **已认证 worker identity 覆盖自报身份。** `cognia-agent worker enroll` 使用一次性 enrollment 换取 Companion device credential。`worker connect` 先用 DPoP 认证的 HTTP 请求换取短期、单次 socket ticket，再连接 `/ws/worker`。front door 从已认证 device 推导 `hostRef`，并要求窄权限 `agent.worker`。该 grant 不隐含 terminal、remote-control 或通用 agent-control 权限。

4. **bridge 保持 opaque。** Bridge protocol v3 增加版本化 worker attach、frame 与 detach envelope。它只 multiplex newline-delimited Agent RPC frame，并沿用已有 frame 与 backpressure 上限；不解析 prompt，也不持久化 task 状态。握手超时为 10 秒，heartbeat 为 25 秒，90 秒无活动即判定 worker 离线。

5. **worker 发布可解析 capability。** `AgentWorkerManifestV1` 报告 runtime、model 与 hard capability、`maxActiveTurns`、opaque credential profile ref、opaque workspace binding ref、Task Workspace readiness、sandbox capability 与 platform。任何必要 capability 缺失时，都必须在模型执行前失败。

6. **repository path 仅保留在 device 本机。** P0 每个 child 只支持一个预绑定 Git repository，且不自动 clone。`cognia-agent worker bind` 把本地 source 记录到 Task Workspace 现有 SQLite database。brain 只看到稳定的 `repository:<projectId>:<repositoryId>` ref。绑定与执行会验证 Workspace Trust、Git root identity、symlink containment、Registry ownership 与 Task Workspace 可用性。

7. **placement 是独立且冻结的 binding。** `TeammateExecutionBinding.executionTarget` 可取 `colocate`、`auto` 或 `pinned`。host identifier 不会编码进 deployment pool。`pinned` 只等待指定 host；`auto` 按 manifest compatibility 过滤，然后选择 active-turn load 最低者，并用已认证 `hostRef` 稳定打破并列。

8. **不增加第二套 scheduler 或 lease authority。** `DurableTeamCoordinator.withChildAdmission` 继续负责 team admission。选中的 worker 通过本机 `ExecutionBroker` 执行。dispatch ownership 作为可选 compare-and-set 字段保存在现有 `AgentTeamChildRun` 上：lease 为 60 秒，每 20 秒续约。`commandId` 等于 `dispatchLeaseId`，重复创建 session 会返回原 receipt。

9. **事件投影进入既有 durable record。** 远程 `eventId` 事务性推进 `lastRemoteEventId`。被接受的事件进入 durable dispatch capture、trajectory、checkpoint、evidence、usage、`ExecutionRun` journal 与 delivery graph。重复 event 与 terminal outcome 不得重复结算 usage、evidence 或 delivery。

10. **恢复由 checkpoint 安全性决定。** 重启恢复会打开原 session，并从 `lastRemoteEventId` replay。safe checkpoint 可在原 host 重试；`auto` 也可以新 attempt 换到另一台 compatible host。unknown effect、non-idempotent intent 或等待人工输入会进入 `recovery_required`，绝不静默迁移。`retryChild` 只扩展现有 coordinator 与 manager。

11. **Fleet 继续是公开 operations surface。** `fleet_get_snapshot` 与 `fleet://update` 以可选字段增加 host 和 managed-session lineage，保持向后兼容。Fleet、Settings、AgentTeam 配置、durable operations、desktop island 与 mobile view 都消费这份投影。远程 UI 永远不能编辑 repository path。

12. **发布可逆。** `agentTeamRemoteDispatch` 默认关闭，并要求 resolver v2 与 Task Workspace 同时启用。关闭 flag 后不再开始新的 remote dispatch，但既有 session 仍可发送事件并接受控制。撤销 `agent.worker` 会立即断开 device，并让受影响 child 进入同一套 checkpoint 安全判断。所有 child 与 Fleet 字段均可选，因此回滚不需要 destructive migration。

## 影响

- 两台单 slot worker 可以并行执行两个已准入 child，且不改变 team concurrency 语义。
- pinned worker 断线会产生可检查的 queued child，不会回退到本地。
- credential 与绝对 repository path 始终留在实际解析它们的 worker。
- 恢复决策由 evidence 驱动，并对 operator 可见。
- 旧 client、旧 worker、旧 AgentTeam record 与旧 Fleet snapshot 仍可读取。
- P0 不增加多人 work item、自动 clone、multi-root child、PostgreSQL task authority，也不把 AgentTeam 工作塞进 deployment operation。

## 验证

contract test 覆盖新旧 client-host 兼容、capability error、`commandId` 去重、event replay 与 package consumer。Rust test 覆盖 enrollment replay、grant 隔离、跨 tenant 拒绝、ticket replay、revoke、frame limit、heartbeat expiry 与已认证 `hostRef`。Task Workspace test 覆盖 Git identity、trust、symlink escape、missing binding 与并发隔离。AgentTeam test 覆盖稳定 placement、容量等待、模型前失败、lease compare-and-set、重复 event/result、safe migration、unsafe recovery 与 control mapping。产品测试覆盖 desktop、web 与 mobile 的 host grouping 和 recovery control。release smoke 使用真实 Claude Code 与 Codex worker，但 CI 使用 deterministic fake runtime 和临时 Git repository。

## 运维

部署与回滚流程维护在 `docs/runbooks/agent-team-remote-dispatch.md`。

## 参考

- ADR-0022：`docs/content/docs/zh/adr/0022-agent-team-runtime-hardening.md`
- ADR-0059：`docs/content/docs/zh/adr/0059-cloud-deployment-headless-brain.md`
- ADR-0086：`docs/content/docs/zh/adr/0086-task-scoped-resource-workspaces.md`
- ADR-0090：`docs/content/docs/zh/adr/0090-unified-agent-execution-and-gateway-compatibility.md`
- ADR-0111：`docs/content/docs/zh/adr/0111-managed-workspace-registry-and-bundle.md`
