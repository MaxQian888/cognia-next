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

3. **已认证 worker identity 覆盖自报身份。** `cognia-agent worker enroll` 使用一次性 enrollment 换取 Companion device credential。`worker connect` 先用 DPoP 认证的 HTTP 请求换取短期、单次 socket ticket，再连接 `/ws/worker`。公网 PKI 使用标准 CA 校验；局域网自签名部署固定对端 X.509 SPKI 的 SHA-256 指纹，且不会全局关闭 TLS 校验。每次重连都会重新签发 ticket 并重建 socket/RPC stream。front door 从已认证 device 推导 `hostRef`，管理 DTO 直接返回同一派生 ref。

4. **bridge 保持 opaque。** Bridge protocol v3 增加版本化 worker attach、frame 与 detach envelope。它只 multiplex newline-delimited Agent RPC frame，并沿用已有 frame 与 backpressure 上限；不解析 prompt，也不持久化 task 状态。握手超时为 10 秒，heartbeat 为 25 秒，90 秒无活动即判定 worker 离线。

5. **worker 发布唯一 canonical execution profile。** `AgentWorkerManifestV1.executionProfile` 由 `resolveWorkerExecutionProfile()` 生成，包含 backend adapter、runtime adapter、model bindings、deployment refs 与 canonical capabilities。resolver 会将 runtime 理论能力与 CLI backend 实际能力求交集。新 worker 必须携带 profile；旧 manifest 仍可读取但不能参与 P0 placement。manifest type、schema 与 guard 共享一个 Valibot authority。

6. **repository path 仅保留在 device 本机。** P0 每个 child 只支持一个预绑定 Git repository，且不自动 clone。`cognia-agent worker bind` 把本地 source 记录到 Task Workspace 现有 SQLite database。brain 只看到稳定的 `repository:<projectId>:<repositoryId>` ref。绑定与执行会验证 Workspace Trust、Git root identity、symlink containment、Registry ownership 与 Task Workspace 可用性。

7. **placement 直接消费冻结 execution spec。** `TeammateExecutionBinding.executionTarget` 可取 `colocate`、`auto` 或 `pinned`。placement 统一校验 runtime、model、deployment、active credential ref、canonical capabilities、Task Workspace、repository binding、sandbox 与 capacity。`auto` 选中认证 host 后，只能通过 resolver-owned rebind helper 更新 `hostRef` 并重算 fingerprint。

8. **不增加第二套 scheduler 或 lease authority。** `DurableTeamCoordinator.withChildAdmission` 继续负责 team admission。选中的 worker 通过本机 `ExecutionBroker` 执行。dispatch ownership 作为可选 compare-and-set 字段保存在现有 `AgentTeamChildRun` 上：lease 为 60 秒，每 20 秒续约。`commandId` 等于 `dispatchLeaseId`，重复创建 session 会返回原 receipt。

9. **事件投影进入既有 durable record。** 远程 `eventId` 事务性推进 `lastRemoteEventId`。被接受的事件进入 durable dispatch capture、trajectory、checkpoint、evidence、usage、`ExecutionRun` journal 与 delivery graph。重复 event 与 terminal outcome 不得重复结算 usage、evidence 或 delivery。

10. **暂停与恢复都由 checkpoint 安全性决定。** Pause 阻止新 admission、继续消费事件、等待当前 turn 自然 idle，再写 brain-owned checkpoint；不会 abort，也不会要求 worker snapshot。不安全副作用进入 `needs_input`，终态 child 不会被迟到的 pause 覆盖。Resume 只重新调度非终态工作，不调用 `session.open()`；后者只用于断线/重启恢复，并从 `lastRemoteEventId` 继续 replay。Terminate 保持 abort、等待 idle、再 close。

11. **Fleet 继续是公开 operations surface。** `fleet_get_snapshot` 与 `fleet://update` 以可选字段增加 host placement readiness/reason 和 managed-session lineage，保持向后兼容。Fleet 与 Settings 使用现有设置组件展示 enrollment、身份、在线状态、capacity、profile 不兼容与前置条件。只有 resolver v2、remote dispatch、Task Workspace 和 placement-ready profile 全部就绪时远程选择器才可选；已保存的离线 pin 仍会显示。

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
