---
title: "0136 — 跨设备放置层"
description: "对「这份工作在哪里跑」给出唯一答案：统一的活性判定、统一的放置解析器、显式的执行权威，以及持久化的宿主→目标派发队列。"
---

# ADR 0136 — 跨设备放置层

**状态：** 已接受
**日期：** 2026-08-21

## 背景

ADR-0097 的 `## Not done` 段自己写着：*"Nothing chooses where a run executes…
no desktop-liveness probe, no executor election and no handoff."* 2026-08-20 的
审计（`docs/research/cross-device-connection-and-dispatch-audit-2026-08-20.zh.md`）
从另一侧确认了同一件事：**连接面是完整的** —— 五种传输，认证、指纹固定、自动重连 ——
**派发面不是**。11 条跨设备派发路径里，只有 `mobileOutboundQueue`（客户端 → 宿主）
一条是持久、幂等、可恢复的。

每个子系统都自己回答了「在哪里跑」，而且互相看不见对方的答案：

- **AgentTeam** 有一个完整的解析器（`remote-worker-runtime.ts`），11 个类型化拒绝
  原因、确定性 tiebreak —— 但只服务一种候选。
- **`action.mobile.*`** 按 `lastSeenAt` 排序却**从不判活**，于是三天前见过的手机赢得
  排序、吸收派发、把运行阻塞 120 秒后失败 —— 且不会尝试下一个候选。
- **工作流能力预检**用同样的遗漏对配对设备取能力并集，于是预检通过、派发挂起。
- **调度器**在驱动没有 leader election 时无条件从 `isTimingAuthority()` 返回
  `true` —— 而生产里的每个驱动都没有。两台登录同一账号的桌面各自武装同一个 cron，
  各自触发一次。

同时存在四套「在线」定义，其中两套就是常量 `true`；而 `capabilitiesAt` /
`featureManifestAt` 写在六处、读在零处。

## 决策

### 1. 一套活性判定（`lib/placement/liveness.ts`）

`isPlaceable(liveness, now, policy)` 取代所有临时判断。关键区别不是信号**来自哪里**，
而是它是否证明**此刻**在场：socket 证明了，直接采信；时间戳只在 TTL 内证明，而这个
TTL 取 `90_000` ms，与 `ws_worker.rs` 的 `IDLE_TIMEOUT_SECS` 对齐 —— 两侧不能对
「谁在线」有不同答案。「从未见过」绝不读作「在场」；对方时钟跑快则容忍 —— 因为几秒
NTP 漂移就把整台机器判死，比接受它更糟。

### 2. 一套放置解析器（`lib/placement/`）

`evaluatePlacement` 与 `selectPlacement` 是从 AgentTeam 的解析器**泛化**出来的，
不是重写 —— 它本来就是全仓唯一完整回答了这个问题的实现。并发下真正要紧的两个性质
都保留了：**最小负载优先**，让机群均匀填充；**以 ref 字典序 tiebreak**，让两台宿主
在同一瞬间解析同一个放置时得到同一个答案。

`PlacementRequirement` 带 `dimension` 判别标签。`CapabilityId`（平台能力）与
`AgentCapabilityId`（执行能力）**不合并**：它们的取值空间和权威来源不同，合并会造出
一个谁都不拥有的第三套词汇表。因此平台的 `streaming` 无法满足 agent 的 `streaming`。

`selectPlacement` 接受 `evaluate` 覆盖，让词汇更丰富的调用方保留自己的判定。
`evaluateRemoteWorkerPlacement` 正是这样接入的：它的 11 个原因已持久化在
`AgentTeamChildRun.placementReason` 上，因此该联合是追加式的，永远不得压平或重命名。

`PlacementWaitingError` 把「稍后再来」与「这永远不成」分开。合并两者，会把一个瞬时
状态变成一次失败的运行。

### 3. 显式执行权威，未配置即自任

`lib/placement/authority.ts` 决定谁可以触发定时工作：

- **未配置 ⇒ 自任权威** —— 与今天逐字节一致，无宿主间协议，单机安装没有任何新风险；
- **已配置 ⇒ 该宿主拥有计时权**，其他宿主让位；
- **已配置但超过宽限期不可达 ⇒ 本地执行并留下可见记录。**

睡两分钟的笔记本不会触发接管；长期不亮的会，而且接管本身被记录 —— 否则团队的调度会
在那台机器关机的当天悄悄停摆，而任何地方都没有解释。

### 4. 确定性幂等，而不是选举

Cron 双触发的解法是让**工作本身可识别**，而不是选出一个所有者。
`deterministicTriggerIdempotencyKey` 从两台宿主都认同的东西派生键：workflow、trigger、
以及对齐到秒的计划触发时刻 —— 于是观察到同一次触发的两台宿主算出同一个键，既有的
invocation 账本吸收掉第二次。

账本本身一直是好的（确定性主键、单事务插入、重复 `add` 解析到已有行）；它只是被绕过了。
`dispatchTrigger` 根本不传键，于是查找被整段跳过；调度器传的是
`${taskId}:${executionId}`，而 execution 行是每台宿主各自铸的。

只有时间派生和外部标识的触发器拿得到键。两次手动点击就是两次运行。

### 5. 可见的降级（`lib/placement/degraded-audit.ts`）

一条 `placement.degraded` 同时进入通知中心**和**工作流运行事件日志 —— 复用这两个既有
权威，不新建审计存储。按「一次降级事件」而不是「每个 tick」合并。它绝不抛错：工作已经
降级过一次，再因为写不进审计而失败，就把一次可见的降级变成了一次故障。

### 6. 持久化宿主 → 目标派发（`hostDispatchQueue`，Dexie v175）

一张通用表 + `domain` 判别（`mobile-step` / `remote-step` / `schedule-handoff`），
而不是三张表：runner、退避、死信策略、恢复扫描完全相同，只有投递调用不同。语义照抄
`mobileOutboundQueue`，因为那套语义是对的；表分开，因为方向和寻址不同。

`idempotencyKey` 是**唯一**索引。先读后写的检查不是原子的 —— 同一份工作的两次并发入队
都看到「没有已有行」，于是都插入了。约束才让「只入队一次」从「大概率」变成「真的」。

### 7. 租约不再旅行，也不再比宿主活得久

`readWorkflowRunsDelta` 在同步时把 `lease` 与 `cancelRequestedAt` 投影掉。
`lease.expiresAt` 是**执行方**桌面时钟上的绝对时间戳，而接收端用自己的 `Date.now()`
判活 —— 于是一台手机可能纯粹因为时钟偏差就把租约判成有效或过期，而它的
`ownerId` 指向一个它根本够不到的进程。

桌面退出时释放自己持有的租约（`installExitLeaseRelease`）。不阻塞退出，也不等待接管
—— 可能根本没有人接管 —— 但留下一个有效租约，会让这次运行在整个 TTL 内不可认领，尽管
它的执行者明显已经不在了。

## 后果

- `action.mobile.*` 现在会在候选之间故障转移。设备侧的**拒绝或取消不会换一台重试** ——
  那是设备给出的答案，把它拿去问下一台，只会把同一个弹窗推给用户没碰过的手机。
- 工作流预检变严：以前会启动然后挂起的运行，现在会带原因在预检阶段失败。
- 被 pin 住的目标若已失活会立刻报告，而不是耗完步骤超时 —— pin 指定了唯一一台机器，
  没有可转移的余地。
- `PlacementReason` 与 `RemoteWorkerPlacementReason` 均为追加式联合。

## 落地之后

本 ADR 当初记在 `## 未完成` 里的三项，除刻意保留的那一项外都已补齐。已交付的内容，
以及与最初设想的偏差：

- **放置是整条工作流级的，不是节点级的。** 约束存放在 `WorkflowSettings.runOn`，
  由工作流编辑器 Run Policy 字段设置，`dispatchPlacedWorkflowTrigger` 负责解析。
  **节点级 `runOn` 不再属于本决策** —— 单个节点无法脱离它所属的运行被独立放置，否则
  一次运行的日志会被劈成两台宿主，而一次运行只有一份事件日志。它只作用于顶层**异步**
  入口（手动、调度、Webhook/事件、异步 HTTP）；Skill、MCP、agent-tool 与子工作流仍与
  调用方同址，并保持原有的同步返回契约。字段缺省严格等价于 `colocate`，因此此前写下的
  每条工作流行为不变。
- **`hostDispatchQueue` 的 runner 已存在**（`lib/placement/host-dispatch-runner.ts`，
  由 `installHostDispatchRuntime` 每宿主安装一次），并只驱动真正有生产者的两个域：
  `mobile-step` 与 `schedule-handoff`。领取是单个 Dexie 事务内的条件租约，过期租约可
  恢复；`expiresAt` 在入队时铸造一次，重试与重启都不会延长它。`remote-step` 保留域但
  不配 runner：一个无物可送的 runner 比一个诚实的缺口更糟。
- **终态派发现在是可见的。** `recordHostDispatchFailure` 把每一次死信与不可重试拒绝
  写入通知中心；当派发属于某次运行时，同时附到该运行自己的事件日志上。
  `schedule-handoff` 本地并没有运行，因此它只有通知 —— 这是诚实的投影，不是遗漏。
  只有耗尽预算的那一次尝试会被审计；在此之前的重试不值得叫醒任何人。
- **执行权可配置**，入口在 Scheduled Tasks 的宿主区域（`SchedulerAuthorityControl`）：
  本机或某台已配对的远端宿主，配 1 / 5 / 15 分钟的不可达宽限期，默认 5 分钟。交出执行权
  同时会解除本机已武装的任务（`reconcileTimingAuthority`），且 `handleTaskDue` 在触发前
  会重新校验执行权 —— 在交接之前武装的时槽不得在本机触发，也不得消费该次发生或推进
  `nextRunAt`，否则两侧调度会失步。
- **Headless 宿主可以发布宿主事件。** `host-event-publisher` 运行时在任何权威运行时
  发出事件之前注册桥接发布器，`ws_bridge.rs` 用封闭主题 allowlist 把关。Push 帧仍只带
  ID；完整审批与 step 参数只走认证 WS。
- **源端投影 handoff，而不镜像它。** `WorkflowHandoffPanel` 展示派发状态、目标宿主、
  目标铸造的运行以及失败原因，并提供切换到目标宿主的入口。取消以 admission 为界：
  在 `remoteRunId` 出现之前，这次发生归源端所有，可以取消；之后运行归目标所有，在源端
  取消只会让它变成孤儿。

## 未完成

- **宿主间权威协商。** 刻意不做 —— 权威是显式配置，而确定性幂等键才是让竞态无害的东西，
  不是选举。宽限期同样只是本机偏好：没有选举、没有租约协商、没有宿主配置同步。
- **`remote-step` 域的 runner。** 该域是预留的；目前没有任何生产者向它入队，为了填满它
  而臆造一套 worker step 协议，等于在还没有调用方之前就冻结契约。

## 修订

- **ADR-0128 决策 6**（"调度器宿主自有、永不移交"）被修订：宿主仍拥有自己的调度，但在
  武装之前会询问执行权威，并以**让位**而非转移状态的方式交接。见该 ADR 的修订说明。
- **ADR-0097** —— 其 `## Not done` 中放置那一半已被处理；executor election 刻意仍未做
  （见上）。
