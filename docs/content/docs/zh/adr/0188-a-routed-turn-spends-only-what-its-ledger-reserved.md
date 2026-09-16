---
title: "0188 — 路由后的轮次只花账本预留过的钱"
description: "Router + Fusion 以可选开启的子系统形式，把 router_fusion 规格接入 cognia-next 的模型路由。动作路由器按轮次选择模式；调用账本在每次模型调用发出前预留，按上报用量结算；运行、调用尝试和资金放在按账户独立的数据库里，并通过 outbox 同步到主库。默认关闭，关闭时既有代码原样运行；基础设施故障时普通流量回退到原路径。B1 交付聊天作为 direct 运行，B2 交付工具类生成入账与网关 Run API，B3 交付 cascade、panel、cognia/* 模型与动作目录编辑器。"
---

# ADR 0188 — 路由后的轮次只花账本预留过的钱

**Status:** Accepted — B1（聊天作为 direct 运行）、B2（工具类生成、网关、任务驾驶舱）与 B3（cascade、panel、`cognia/*` 模型、动作目录）已实现，B2 中的 companion RPC 除外；B4–B7 规划中
**Date:** 2026-09-16
**Related:** [ADR-0043](./0043-llm-provider-execution)（本文所依托的 provider 路由引擎）、[ADR-0125](./0125-durable-work-submission)（持久化发送与重放）、[ADR-0169](./0169-one-runtime-one-review-one-control-machine)（运行控制与 `executionRuns` 投影）、[ADR-0059](./0059-cloud-deployment-headless-brain)（headless brain）

## 背景

每次发送都已经经过 `ProviderRoutingEngine.planRoute`（`packages/provider-routing`，由 `lib/claude/build-options.ts` 调用），Rust 网关也有自己的规划器。这个路由器只为一个轮次挑一个部署。router_fusion 规格（DESIGN.md、契约、79 条 P0 验收用例）要求更多：

- 每个轮次选择一种模式：`direct`、`cascade`、`panel` 或 `delegate`；
- 以整数 microusd 计的"先预留、后结算"预算账本；
- 调用尝试状态机与持久化的步骤重放；
- 每个运行都有符合规格的 `RouteDecision`。

现有若干行为违反规格的不变量：

- Claude Agent SDK 静默的 `fallbackModel`；
- 只提示不拦截的软成本上限；
- AI SDK 与 CLI 隐藏的传输重试；
- `lib/claude/routing-fallback.ts` 里的内容策略回退链；
- 不入账的网关候选遍历。

规格假设的是独立的多租户服务（Python、Postgres、Redis、LangGraph）。cognia-next 是桌面应用，有 TypeScript brain、Dexie 和 Node sidecar。这次改动还会碰到每个用户都要经过的发送路径，所以它必须不可能破坏正常工作。

## 决策

### 可选开启，关闭即不受影响（D36–D37）

`AppSettings.routerFusion` 有一个总开关，每个入口再各有一个开关：`chat`、`gatewayRuns`、`gatewayPassthroughLedger`、`agentsWorkflows`、`utilityLedger`、`companion`。所有开关默认都是 `false`。

- 共享模块只能通过 `lib/router-fusion/gate/*` 和零依赖叶子模块 `@cognia/router-fusion/settings/switches` 触及 Router + Fusion。其余模块都在 gate 返回 `on` 之后用动态 `import()` 加载。`scripts/gates/check-router-fusion-gate.mjs`（`pnpm audit:router-fusion-gate`）会让任何从共享文件静态导入引擎或宿主模块的代码失败。
- 开关关闭时，发送参数不带 `ledger` 标记。sidecar 的账本路径都以这个标记为准，所以 `fallbackModel`、默认重试、步数分块和旧的成本闸门都与原来完全一致。
- 旧版 Auto 的迁移（D31）只在第一次开启时执行。它把 Auto 阶梯变成一条已启用的 `economy_simple` 规则行（来源标记为 `migrated_legacy_auto`），把 `maxCostPerRequestCents` 变成 direct 运行上限，并保存原来的 `autoRouting`，设置页可以一键恢复。

### 故障隔离（D38）

基础设施故障包括：fusion 数据库出错、模块导入失败、渲染进程不响应预留请求、内部异常。

- **普通流量**（direct 聊天轮次）走原来的、不入账的路径完成。消息上显示"未入账"标记，发送参数带 `routerFusionBypass`。
- **熔断**：同一入口连续故障（默认 3 次）会熔断，一直走原路径，直到用户在设置里重新启用。熔断状态持久化到 `trippedSurfaces`，只通知一次。
- **显式选择的 fusion 工作**（cascade、panel、delegate、`/v1/runs`、`cognia/*` 模型，从 B2 起陆续接入）明确失败，绝不伪造。
- **拒绝不是故障**：预算、限额或截止时间的拒绝会照常拒绝并说明原因（`routerFusion.refusal.*`），绝不绕过。

### 一个引擎包，一个账本写入者

- **`packages/router-fusion`** 零 `@/` 依赖，全是纯函数。其中包括：
  - 内置规格契约，带 zod 镜像和一致性测试；
  - 由 `state_transitions.json` 生成的运行与调用尝试状态机；
  - microusd 金额计算，以及计费桶互斥的用量归一化；
  - 账本规划器；
  - 配置编译器与动作哈希；
  - 规则分类器和输出完整 `RouteDecision` 的动作路由器；
  - `direct` 工作流图（B2 起由运行 API 承载；B1 的聊天轮次是 direct 运行，但模型循环仍在 sidecar 里）、验收档位和确定性的 Fake Provider；
  - 验收登记表。
- **`lib/router-fusion/db/ledger-store.ts`** 是资金的唯一写入者。每次变更都在一个 IndexedDB 读写事务里执行一步规划，事务范围恰好覆盖它要写的表。因此并发创建运行（BUD-01）和并发调用准入（BUD-10）无需内存锁即可串行化。
- **账本规则**：
  - 没有预留就不能发出调用；
  - 每条账本记录都有确定性的去重键（BUD-03）；
  - 已发出但没有结果的调用变成 UNKNOWN，钱继续占用；
  - 超支全额记账并冻结运行（BUD-09）；
  - 结束和取消在事务内竞争，只有一个会赢（REC-04）；
  - 过期的 worker 被 fencing token 隔离（REC-02）。

### 聊天作为 direct 运行（B1）

- **封装路由**：`resolveSendOptions` 最后才封装路由，针对这次发送实际使用的 provider、模型和凭据。它写入 `SendOptions.ledger` 和 `routerFusion`，并删除 `fallbackModel`。只有聊天控制器会主动开启（`dispatch.routerFusionSurface === "chat"`，仅桌面端），远程会话和 host-state 的发送都不会带标记。
- **创建运行**：`prepareRouterFusionSend` 在派发前一刻创建运行，同时取得 fusion 会话锁和租户预留。租户预留从现有 `costBudget` 的剩余额度中扣（D22）。持久化重放或复用的发送，会在同一部署上重新封装为新的运行。
- **AI SDK 通道**：
  - `perLegCap = 1`，`maxRetries: 0`；
  - 每一段之前，sidecar 发出 `call_reserve_request`，等待渲染进程的 `claude_call_reserve_decision`（30 秒后视为绕过）；
  - 每一段之后，上报 `call_attempt_result`，带上 provider 原样上报的用量和该用量的口径。
- **Claude Agent SDK 通道（envelope 模式，D34）**：
  - `CLAUDE_CODE_MAX_RETRIES=0`，不设 SDK 回退模型；
  - 预先预留阶段信封额度；
  - 按每个 assistant `message.id` 结算；
  - `api_retry` 记为失败的调用尝试；
  - 每次工具调用都通过 PreToolUse hook 重新检查运行状态；
  - 卡片标注为"预估上限"。
- **结束运行**：运行在轮次的 `result` 时结束，而不是 `session_ended`，因为 goal、loop、steer 的续接会先开始下一个运行。没有产出 result 的轮次由 `session_ended` 结束，`sidecar_exited` 则结束所有已登记的轮次。AI SDK 通道即使最后一段失败也会发出成功的 `result`，所以最后一段失败时，运行会降为失败（`CALL_FAILED`）。
- **改路由（D5）**：跨 provider 的重试是一个新的、入账的运行，每个轮次最多 2 次（`MAX_LEDGERED_REROUTES`），而且只能在任何可见内容提交之前。入账轮次关闭内容策略回退链。
- **预算闸门（D35）**：带标记的发送跳过旧的 `enforceCostBudget`；如果发送最终走了绕过路径，会再检查一次。
- **金额只显示一次**：聊天的用量行以 assistant 消息为键，`costSource: "ledger"`，成本取运行结算后的 `spentMicrousd`。非聊天入口改由 outbox 投影用量行。
- **界面**：
  - `RouterFusionRunCard` 在 assistant 消息下渲染 `MessageRunMetadata.routerFusion`：动作、模式、规则、模型、通道、预算、上限、成本及其状态、调用次数、超支、冻结，以及 `schema_only` 验收标记。
  - 路由设置页新增可折叠的"Router + Fusion"卡片：
    - 总开关与各入口开关，未接入的入口显示"后续版本"；
    - 熔断状态与重新启用；
    - 预算模式、运行上限和未知价格预留；
    - 数据等级与受限授权；
    - 带来源标记的规则行；
    - 迁移提示与恢复。
- **启动**：`RouterFusionInitializer` 恢复持久化的熔断状态。聊天开启期间，它会结束已关闭窗口遗留的、仍占着锁或预留的运行，并每天执行一次保留策略。

### 工具类生成、网关与任务驾驶舱（B2）

- **所有生成都入账（D27）。**
  - `gate/utility-ledger.ts` 包装 `LlmClient`，让每次后台调用都成为一个不绑定会话的运行，包括会话标题、记忆、`/goal` 评判和工作流 `ai.prompt` 节点。
  - 包装后的客户端强制 `maxRetries: 0`，重试会是一次新的、可见的预留，而不是隐藏的第二笔账单。
  - 工具类调用归 `utilityLedger`，工作流节点归 `agentsWorkflows`。
- **Run API 由网关提供，数据留在 brain（D9）。**
  - `crates/cognia-gateway/src/runs.rs` 提供 `/v1/runs`：创建返回 202 并支持 `Idempotency-Key`；另有查询、SSE 事件流（`id: seq`、15 秒保活、续传的运行已不存在时返回 410）、取消、恢复和反馈。
  - 每个请求都经过 `brain_bridge.rs`。桌面端在现有的 companion 写入桥之上实现它（`src-tauri/src/gateway_brain_bridge.rs`），不另开通道。
  - brain 用带标签的值作答，而不是抛异常，这样 Rust 能把 brain 自己的状态码返回给调用方。
  - 网关答完 202 后请求就没了，所以运行的输入消息在运行创建之前就先存为加密产物。
- **Key 即调用方（D8）。**
  - 网关 key 带 `scopes`：`runs:create/read/cancel/approve`、`artifacts:read`、`feedback:write`。
  - 没有 scope 的 key 只保留透传能力。
  - 别的 key 创建的运行，回答与不存在的运行完全一样。
  - Run API 的会话是普通聊天会话，标记为 `origin: gateway-api` 并带 key 名称（D24）。
- **`cognia/*` 模型给出明确答复（D13）。** `virtual_models.rs` 在模型解析之前拦下它们：
  - 入口关闭时返回 `403 ROUTER_FUSION_DISABLED`；
  - `delegate` 只在 Run API 提供，返回 `422`。
  - B2 交付时，`auto`、`direct`、`cascade`、`panel` 也返回 `422`；B3 起这四个模型正式提供服务（见下文）。
- **透传通道入账，但不会因账本而被拦下（D13、D38）。**
  - 打开 `gatewayPassthroughLedger` 后，每次上游尝试在发送前一刻预留，结算时使用网关本来就会读取的用量（流式响应在流结束时结算）。
  - 失败类别（`not_sent`、`rate_limited`、`server_error`、`auth`、`invalid_request`）随结算一起传递；卡住或无法解析的答复按 UNKNOWN 结算，钱继续占着。
  - 发生故障转移的请求是一个运行（`gwpt:<requestId>`），每次尝试是一个逻辑步骤。
  - 预算或策略拒绝返回 `402`，请求不发出。
  - brain 关闭、已熔断、不在线或超过 2 秒未答复时，请求照常发出，只是不入账。
  - 每个发起过尝试的响应都带 `x-cognia-ledger`（`ledgered` 或 `bypassed:<原因>`）、`x-cognia-attempts`，故障转移时带 `x-cognia-fallback`，以及 `x-cognia-run-id`。
  - gate 一侧是 `gate/passthrough-bridge.ts`，有意与 `gate/run-api-bridge.ts` 分开：两条通道对故障的处理正好相反。
  - 它的结果（包括拒绝和绕过）与 Run API 使用同一个 `{ ok: true, value }` 信封；桌面端 brain 桥会把其他形状当作契约错误拒绝。
  - 每次结算后立即应用 outbox，因为之后没有运行驱动器来把用量记录带过去。
- **网关从路由快照读取开关。** `RoutingSnapshot.routerFusion` 只携带两个网关开关，不含熔断状态。熔断由 brain 自己回答，调用方因此得到 `503` 或 `bypassed:breaker_tripped`，而不是误导性的"已关闭"。
- **非本机发起的运行也能看到（D39）。**
  - 如果 fusion 运行的来源本身没有执行运行（目前只有 `gateway`），会在创建、开始和结束时各写一个 `execution_run_projection` 效果。
  - 应用器创建一个新类型 `fusion` 的 `ExecutionRun`，带 `origin: "gateway-api"` 和 key 名称，再通过普通的运行日志推进状态。
  - 透传运行（`origin: "gatewayPassthrough"`）从不投影：一次代理转发只是一笔账，不是一项任务。
- **任务驾驶舱可按来源筛选。** `/agent-runs?origin=` 可筛出本机或网关发起的运行。
  - 只有出现非本机运行后才显示这个控件，所以 Run API 关闭时页头与之前完全一样。
  - `fusion` 行只提供"停止"。处理器通过 `gate/run-control.ts`，并有意跳过 Run API 的调用方校验：坐在这台机器前的人可以停止这台机器正在做的事。
- **投影在发生时就落地。** Run API 运行一开始就应用 outbox，这样驾驶舱里的行在运行中就能被停止；取消排队中的运行也会立即应用，因为已经没有 worker 来做这件事。
- **启动恢复与数据清理覆盖所有已接入入口，两种主机都有。**
  - `recoverStaleFusionRuns` 会封存所有租约已过期的运行，不只是聊天的；这里出的故障计入每个开启中的入口。B3 起，由编排器驱动的运行会被恢复执行而不是封存（见下文）。
  - 桌面窗口在任一已接入入口开启时运行恢复与清理；brain 在 `lib/headless/runtimes/router-fusion.ts` 中运行。
  - 熔断状态的持久化仍只在窗口里做，因为它通过设置 store 保存。
- **brain 从账户记录读取开关。** headless brain 从不加载设置 store（只有 `SettingsHydrator` 会加载），因此 brain 会处理的路径上，每次 gate 读取都通过 `gate/current-settings.ts`，包括 Run API、透传、运行控制和工作流提示词。
  - 该辅助函数在 store 已加载时用 store，否则读数据库中存储的记录。
  - 调用中途的重新检查使用 `calls/live-settings.ts`，拿不到时回退到本次请求自己的快照。

### cascade、panel 与虚拟模型（B3）

- **完整的 ActionRouter（D10、D11）。** `routing/run-route.ts` 为 Run API 请求、兼容接口调用或聊天中的 fusion 轮次，在其允许的所有模式间做路由。
  - 允许模式下每个已启用的动作都会被评估，每个角色别名都由应用自身的路由引擎解析（健康度、熔断、能力、数据策略）。
  - `deployment-filter.ts` 会在考虑成本之前复查引擎选出的部署，任何选择器都无法夹带不合格的部署（ROUTE-02）。
  - panel 拒绝两个成员使用同一模型版本。
  - 没有评估数据时，除非用户批准了规则行，Auto 仍只选基线动作。为了找到路由不会放宽任何条件：没有合适的动作就拒绝，并给出路由器的原因（ROUTE-08）。
- **编排器在 brain 中执行整个运行。** `runtime/orchestrator-host.ts` 获取运行租约，重放运行固定的配置快照，按账本执行该模式的工作流，并且只封存一次。
  - 角色调用经过 `calls/role-call-executor.ts`：一次 AI SDK 请求打到一个固定部署，关闭重试。
  - 每个持久化步骤都是一次逻辑调用（`workflows/durable-call.ts`）。每次传输尝试各自预留资金，发送前先提交为 DISPATCHED，只结算一次。没有答复的尝试记为 UNKNOWN，不会重试，也不会当作免费。
- **cascade（`workflows/cascade.ts`）。** 先由便宜阶段作答并验证。
  - 通过则直接结束，不调用强模型（CAS-01）。
  - 检查失败或无法判定，或一次格式修复后输出仍无效，就升级且只升级一次，日志中记录机器可读的原因（CAS-02）。
  - 强模型阶段拿到的是原始要求和客观的失败报告，而不是便宜模型的草稿。
  - `inconclusive` 永远不算通过（CAS-03），也绝不会为了绕开策略拒绝而升级（CAS-04）。
- **panel（`workflows/panel.ts`）。**
  - PREPARE 先证明所有回答会经过的上下文窗口都放得下（PAN-08），并以阶段预留的方式提前占住每个必需阶段的资金（BUD-02）。
  - 候选回答相互独立（PAN-01），各有一轮只读工具调用。
  - 无法解析、无权读取或内容已变化的引用，在裁判看到之前就被剔除（PAN-05）。
  - 裁判按运行固定的顺序审阅匿名候选。在 `evidence_review` 下，论断必须有自己的证据才算被支持；候选之间的一致不算证据（PAN-04）。
  - 最多一轮定向核验和一次重新评审（PAN-07）。
  - 汇总模型只能陈述已被支持的论断，最终检查会拒绝依赖其他内容的汇总（PAN-06）。
  - 只剩一个候选时为 `FUSION_INSUFFICIENT_CANDIDATES`；若请求允许，则返回明确标注为降级、不算 fusion 成功的结果（PAN-02、PAN-03）。
- **证据工具（D26）。** 每个工具请求都由 `tools/tool-runtime.ts` 决定，模型只能提出请求。
  - 两种策略：`panel-read-1`（网页、网络搜索，运行有工作区时还包括工作区文件）与 `panel-verify-1`（重读已存证据、重新抓取网页）。
  - 策略未列出的工具一律拒绝，无论周围文本怎么说（AUTH-05）。
  - 每次操作都记入 `fusionToolOperations`，键由步骤、策略、工具、规范化参数以及（读文件时）所读内容的哈希组成。文件变了就是一次新操作（CACHE-02）。
  - `workspace-read.ts` 拒绝 `..`、绝对路径和像凭据的文件名；Rust 侧的 `fs_read_workspace_file` 会规范化根目录和目标路径，符号链接逃逸在磁盘层面就被拒绝。
  - `web-evidence.ts` 手动跟随重定向并逐跳分类，重定向到元数据地址的公开网页会被拒绝（SAFE-01）。它从不继承用户的"允许私有主机"设置，也从不让共享工具生成未入账的网页摘要。
- **提示词与上下文。**
  - 规格中的角色提示词作为 `roles-1` 逐字节内嵌，并由校验和固定。修改提示词即为新的提示词版本，而它是每个动作哈希的一部分（ROUTE-05）。
  - 不可信文本（网页、工具结果、其他角色的回答）都作为数据加围栏。
  - 角色对话记录在达到窗口 75% 且没有待处理的工具调用时，被压缩为新的上下文纪元。摘要照常计费，硬性约束由代码重新注入；没有足够资金做摘要时为 `CONTEXT_BUDGET_EXHAUSTED`（F06）。
- **回答以 verified_buffered 方式交付（D7、SSE-02）。** `answer.delta` 与 `answer.completed` 在封存事务中、终态 `phase.changed` 之前提交，携带的是回答产物的字节区间，从不含文本。封存之前，日志里只有阶段、调用和计费事件。
- **恢复（REC-03）。** 由编排器驱动的运行（`driver: "orchestrator"`）可以恢复。
  - 接管过期租约的 worker 会先处理旧 worker 的尝试：PREPARED 改为 ABANDONED，DISPATCHED 改为 UNKNOWN（`settleOrphanedAttempts`）。
  - 某一步存在 UNKNOWN 或 RECONCILED 的尝试时，以 `STEP_OUTCOME_UNKNOWN` 拒绝，绝不重新发送。
  - 启动清理在对应入口开启时，把这类运行交给 `orchestratedRunResumer` 继续执行，而不是封存。
- **Run API 补全接口。** `GET /v1/sessions/{id}`、`GET /v1/artifacts/{id}`（带按请求 Host 构造的 60 秒 HMAC `read_url`）和 `GET /v1/artifacts/{id}/content?token=`（每次读取都重新鉴权，`no-store`、`nosniff`）。网关的所有错误都是契约中的 `ErrorResponse`：`code`、`message`、`retryable`（429 与 503）、`details` 和 `trace_id`。
- **`cognia/*` 模型正式提供服务（D13）。** `/v1/chat/completions` 上的 `cognia/auto`、`cognia/direct`、`cognia/cascade`、`cognia/panel` 都会变成运行。
  - brain 在 `api/chat-compat.ts` 中映射严格的兼容子集：未知参数、tools 和 `n > 1` 返回 `422`，从不忽略。完整的消息快照在新会话中成为运行输入，走与 `POST /v1/runs` 相同的 `acceptRun`。
  - 非流式调用方等待通过验证的回答。流式调用方在验证完成前只收到 SSE 注释心跳，之后收到标准增量和 `[DONE]`。
  - 超过运行截止时间再加 30 秒仍未完成时返回 `RUN_STILL_RUNNING`（`503`）；运行继续执行，`x-cognia-run-id` 给出其 ID。调用方断开不会取消运行（SSE-03）。
  - Run API 开启时，对可创建并读取运行、且模型白名单允许的 key，`GET /v1/models` 会列出这四个模型。
- **聊天可以运行 cascade 或 panel。**
  - 输入框新增按会话记忆的模式芯片（`stores/chat/fusion-mode-store.ts`）：自动、直接、级联、评审团。只有聊天入口开启、使用内置运行时、在桌面应用中时才显示。
  - `resolveSendOptions` 对明确选择的级联或评审团调用 `selectChatFusionRun`。自动模式下，只有用户批准了 `cascade_verifiable` 或 `panel_research`、且该轮次没有指定智能体工具时才会调用。
  - 选中 fusion 后会写入 `SendOptions.routerFusionRun`，并跳过 direct 路由和封存步骤。明确的 fusion 轮次若带图片，返回 `FUSION_TEXT_ONLY`。
  - 明确的模式遇到入口已暂停或基础设施故障时，抛出 `RouterFusionUnavailableError`，绝不改为 direct 轮次（D38）。
  - 控制器在 Squad 轮次分支的位置分出 fusion 分支。`hooks/chat/router-fusion-chat-turn.ts` 保存用户消息，通过 `gate/chat-fusion-run.ts`（`runExplicitFusion`）运行该轮次，并立即显示通过验证的回答。回答已由运行通过 outbox 持久写入（`writesSessionAnswer`，只写回答）。
  - 输入框上方的进度卡片每 700 毫秒刷新一次阶段、调用次数和相对上限的花费，并说明回答要等验证通过后才显示。
  - 不提供运行中的插话（D19）：运行期间输入的后续消息进入队列，成为下一轮。停止会取消运行并中止其调用。
  - 运行失败时以 `routerFusionRunFailed` 报告，附带运行自己的原因。
- **运行卡片展示整个运行。** 回答消息的 `metadata.run.routerFusion.fusion` 是从日志折叠出的摘要（`runTimelineOf`、`fusionRunSummaryOf`）：模式、角色、阶段时间线、候选、裁判计数、升级、降级结果、验证、质量、相对上限的花费以及结果未知的调用。其中不含任何模型输出。
- **动作目录可以编辑（D17）。** 设置 → 路由 → Router + Fusion 新增级联和评审团的运行上限，以及动作编辑器（`router-fusion-action-catalog.tsx`）。
  - 每个动作可以设置：启用、每个角色使用的别名、验证方式、自己的运行上限；评审团还可以设置人数和网络证据。
  - 用户可以添加自己的动作。
  - 每次修改都先经过引擎包的校验（`settings/action-catalog.ts`），被拒绝的修改会说明原因而不会保存；设置规范化会丢弃任何无法编译的已存内容。
  - 覆盖项只保留真实差异，每个动作都显示配置哈希，每次修改都会改变它。
- **第七个内置动作 `cascade_review`（D17 的补充）。** `cascade_schema` 需要 schema，`cascade_code` 需要验收命令，所以聊天中明确选择的级联没有可用的验证器，总是返回 `VERIFIER_UNAVAILABLE`。
  - `cascade_review`（`text_review`，低成本角色 → `fast`，强模型角色 → `powerful`）追加在目录末尾，因此带 schema 的请求仍优先选择 `cascade_schema`。
  - 预估会计入复核式级联的两次复核调用（每个阶段一次），预检不会少预留。
- **明确的路由不需要指定模型。** 即使会话没有指定模型，明确选择的级联或评审团也会进入路由流程，由各角色选择部署。
- **数据等级跟随项目。** 聊天 fusion 轮次会把会话所属项目传给 `routeRunRequest`（`workspaceId`），因此标记为受限的项目，其轮次不会落到不能接收受限数据的部署上。
- **PII 检查的位置。**
  - 聊天 fusion 轮次的对话记录在创建运行之前用 `hasNoLeakingPiiDeep` 检查，命中时返回 `PII_BLOCKED`。
  - 作为证据读取的工作区文件内容，读取后用 `hasNoLeakingPii` 检查，命中时返回 `CONTENT_SENSITIVE`，且不保存任何内容。
  - 执行器中不做一刀切的检查：网页证据经常包含邮箱等地址，普通聊天也不检查网页工具结果。
  - Run API 与兼容接口的输入不检查。调用方是自行决定发送内容的外部程序，与直通请求相同。
- **聊天运行出现在运行中心。** 由编排器驱动的聊天运行会投影为来源 `local`、类型 `fusion` 的 `ExecutionRun`，并像 direct 轮次一样写入用量记录（`projectedOriginOf`、`ledgerWritesUsageRows`）。
  - 在任务驾驶舱中停止时按投影的来源选择入口：`local` 通过聊天入口取消，其他来源通过 `gatewayRuns` 取消。
- **虚拟模型遵守 key 自身的限制。** 配置了模型白名单的 key，只有白名单列出 `cognia/*` 模型时才能使用它们，`GET /v1/models` 也只列出这些模型。已返回回答的 token 会像直通请求一样扣减 key 的配额。
  - 规格中的写法 `router/*` 只在运行开启时才被接受；开关关闭时，它和其他模型名一样按原有方式解析（D37）。
  - 等待回答时，轮询间隔从 250 毫秒逐步退避到 2 秒；在等待预算内 brain 断开时会再次询问。
  - brain 的拒绝一律映射为错误状态码。不是 UUID 的运行 ID 不会写入响应头，不在 `[A-Za-z0-9._-]` 范围内的事件类型以 `message` 发送。
  - 产物内容以 `attachment` 方式返回，并带 `Content-Security-Policy: sandbox`。

### 独立数据库与 outbox（D39）

Router + Fusion 从不升级 `lib/db/schema.ts`。每个主数据库旁边有一个同级 IndexedDB `<主数据库名>-router-fusion-v1`，第一次使用时才创建。其中包含这些表：

- `fusionAccount`、`fusionRuns`；
- `fusionRunEvents`，键为 `[runId+seq]`；
- `fusionSessionLocks`、`fusionRouteDecisions`；
- `fusionReservations`、`fusionCallAttempts`、`fusionLedger`；
- `fusionArtifacts`，内容用账户内容密钥加密；
- `fusionConfigSnapshots`、`fusionOutbox`；
- `fusionIdempotency`、`fusionFeedback`，B2 新增（schema 版本 2，只增不改：B1 的每个表都保留原有索引）；
- `fusionApiSessions`（Run API 为会话分配的 ID）与 `fusionToolOperations`（工具调用回执），B3 新增（schema 版本 3，只增不改）。

对主数据库的影响通过 outbox 写入，效果 ID 幂等，在启动和恢复时重放。

- **治理**：
  - `lib/data-governance/router-fusion-catalog.ts` 给每张 fusion 表一条与核心表同样完整的策略记录，一致性测试保证它与 `FUSION_SCHEMA` 相同。
  - 备份为 device-local（账本记录的是这台设备的花费，不是可迁移的用户内容），不参与同步。
- **删除**：
  - 所有删除主数据库的路径都通过零依赖的 `gate/database-name.ts` 一并删除同级库：删除账户、移除运行目标、重置被拒绝的存储布局、"清除全部数据"。
  - 原本就会校验删除结果的路径，也会校验同级库。
  - 明文账户库或目标库在本版本里只作为迁移来源，从来没有同级库。
- **保留策略（`lib/router-fusion/db/retention.ts`）**：
  - 产物内容 7 天后过期，除非写入它的运行仍在进行。
  - 结束超过 30 天的终态运行，连同事件、调用尝试、预留、路由决策和 outbox 记录一起删除。只要它还占着钱（held 或 uncertain 的预留、未到终态的调用尝试）、持有锁或有待处理的效果，就保留。
  - 超过 30 天且没有保留中的运行引用的配置快照会删除。
  - 资金账本只追加，从不清理。
  - 幂等 key 按自己的时钟 7 天（`ROUTER_FUSION_IDEMPOTENCY_DAYS`）后过期，即使对应运行仍在进行；反馈随所属运行一起删除。
  - 保留任务只在有已接入入口开启时运行，失败只记日志，不计入熔断。

### 规格机制的对应实现

| 规格机制 | 本实现 |
|---|---|
| Postgres RLS | 按账户隔离的数据库，加上 key scope 与 actor 过滤（AUTH-03、CACHE-05，B2） |
| Redis pub/sub | 通知通道加轮询兜底（REC-07，B2） |
| `SELECT … SKIP LOCKED` | Dexie 租约加递增的 fencing token |
| 签名 URL | 60 秒 HMAC 读取令牌（B2） |
| Alembic 迁移 | 每个数据库一个单版本 Dexie schema，与主数据库做法相同 |
| LangGraph checkpoint | 按逻辑步骤的账本重放：已 SUCCEEDED 的 `logicalStepId` 直接返回已提交的输出（REC-01） |

### 规则 7：未接入部分的标注

已接入的入口是 `chat`、`gatewayRuns`、`gatewayPassthroughLedger`、`utilityLedger` 和 `agentsWorkflows`（`WIRED_ROUTER_FUSION_SURFACES`）。`companion` 在它的 companion RPC 落地前保持未接入。

已接入的规则行是 `economy_simple`、`cascade_verifiable` 和 `panel_research`（`WIRED_RULE_ROWS`），`delegate_multifile` 在 B4 之前保持未接入。聊天轮次不带 JSON 结构，因此在自动模式下 `cascade_verifiable` 永远不会匹配；它通过 Run API 和 `cognia/auto` 生效，规则说明中也写明了这一点。

以下三项在 B4 之前同样未接入：

- `delegate` 模式的动作；
- `code_fixture` 验证方式，因为还没有运行时验证器，所以路由器不会选择 `cascade_code`；
- `delegate` 模式的自定义动作。

- **类型**：每份清单都在类型处注明（`WIRED_RULE_ROWS`、`EDITABLE_ACTION_MODES`、`EDITABLE_PROFILES_BY_MODE`）。
- **界面**：
  - 设置页把未接入的入口、规则行和委派动作显示为禁用，标注"后续版本"。
  - `cascade_code` 显示"暂不会被选中"。
  - 添加表单中的 `delegate` 为禁用状态。
  - 聊天入口关闭时，输入框的模式芯片不渲染。
- **测试**：`switches.test.ts`、`settings.test.ts`、`action-catalog.test.ts` 和编辑器的测试固定这些清单；`switches.test.ts` 还会在任何源码为未接入入口调用 gate 时失败。

## 影响

- **关闭路径由测试保护，而不是靠小心**：
  - OFF-01 到 OFF-04 固定：所有开关默认关闭；开关关闭时 `resolveSendOptions` 与 sidecar 派发和基线一致；不加载任何 Router + Fusion 模块，也从不打开 fusion 数据库。
  - ISO-01 到 ISO-05 固定故障隔离与 outbox 的幂等重放。
- **两个 Dexie 数据库之间可能只提交了一半**：outbox 让跨库效果幂等、可重放，两者之间的崩溃会在下次启动时修复。
- **入账入口的聊天轮次启动更慢**：AI SDK 每一段都要和渲染进程往返一次预留；Claude Agent SDK 通道每个轮次预留一次信封额度。
- **验收登记表就是完成的定义**：`packages/router-fusion/src/acceptance/registry.ts` 把 79 条规格用例和 Cognia 的 OFF/ISO 用例分配到各批次。某个已交付批次如果有用例在扫描范围内找不到 `[ACC:<ID>]` 测试，`registry.test.ts` 就会失败。
- **有些东西离线无法验证**：
  - `CLAUDE_CODE_MAX_RETRIES=0` 是否彻底关闭了 CLI 重试；
  - 真实 provider 的用量口径和请求 ID；
  - Tauri 桥接的时序。
  - 这些由 B5 中经授权的真实冒烟测试覆盖（总额 5 美元，由账本强制）。

## 备选方案

- **按规格假设做一个独立的 Python 服务**：否决。它给桌面应用加了第二套运行时和数据存储，而且每次发送都要跨一个今天并不存在的进程边界。
- **把表放进主 Dexie 数据库**：否决。每次主 schema 升级都会重写 `messages` 和 `workflowRuns`，功能关闭时也会把 Router + Fusion 放到每个用户的升级路径上。
- **保留软上限和隐藏重试，只加上报**：否决。有了它们，规格的预算不变量（不能有未预留的调用、不能静默换模型）无法成立。
- **对所有人默认开启，另设紧急关闭开关**：否决。用户要求可选开启，并且故障绝不能影响正常工作。

## 实现

| 批次 | 范围 | 状态 |
|---|---|---|
| B1 | 契约、状态机、金额、账本、规则路由、direct 工作流；聊天作为 direct 运行；gate、熔断、fusion 数据库、outbox、治理、保留策略；运行卡片与设置 | 已实现 |
| B2 | 工具类生成与工作流提示词入账；网关 `/v1/runs` + SSE + 带 scope 的 key；`cognia/*` 明确拒绝；透传入账与响应头；`fusion` 运行投影与驾驶舱来源筛选 | 已实现，companion RPC（`companion` 入口）除外，该入口保持未接入 |
| B3 | 完整的 ActionRouter；cascade 与 panel 工作流；证据工具；上下文压缩；verified_buffered 交付；编排运行的恢复；Run API 的会话与产物接口；正式提供服务的 `cognia/*` 模型；聊天中的级联与评审团轮次（模式选择、进度卡片、运行卡片）；动作目录编辑器 | 已实现 |
| B4 | 带沙箱验收与审批的 delegate | 规划中 |
| B5 | LLM 分类器、Agent/Squad/工作流的动作选择、真实冒烟测试 | 规划中 |
| B6 | 路由实验与学习型路由器 | 规划中 |
| B7 | 故障注入矩阵与完整的 `/agent-runs` 详情 | 规划中 |
