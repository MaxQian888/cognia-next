---
title: "0090 — 统一 Agent 执行与 Gateway 兼容性"
description: "在不替换现有执行引擎的前提下，统一 Agent 运行时选择、Anthropic 兼容部署路由、无桌面宿主、异构委派与恢复。"
---

# ADR 0090 — 统一 Agent 执行与 Gateway 兼容性

- **状态：** Accepted
- **日期：** 2026-07-23
- **基于：** ADR-0022、ADR-0028、ADR-0043、ADR-0059、ADR-0062、ADR-0064 与 ADR-0082
- **研究记录：** `docs/research/agent-sdk-gateway-non-claude-models-2026-07-23.md`

## 背景

Cognia 当前实际存在三条 Agent 运行轨：

1. Node sidecar 内的 Claude Agent SDK 运行轨；
2. 同一 sidecar 内、提供商中立的 AI SDK 工具循环运行轨；
3. 由单个 `ExternalAgentManager` 管理的外部 Agent 运行轨，其下包含 ACP、Codex
   app-server、OpenCode 与 A2A 协议适配器。

Chat、插件、Workflow 和 Agent Team 是调用方或编排层。Gateway 与直连是路由选择。原生
subagent 与 Cognia 编排子 Agent 是委派方式。桌面、headless 和远程是执行宿主。这些维度
都不会形成新的运行轨。`executeAgent` 的 text channel 是无工具的 completion 降级路径，
不是第四条 Agent 运行轨。

当前实现没有清楚表达这个事实。sidecar 只有在 provider id 字面值为 `anthropic` 时才选择
Claude Agent SDK，否则选择 AI SDK。`claude-host.mjs` 同时承载两个引擎，却暴露
Claude 专属命令。Agent 执行策略散落在各调用方配置中。部分调用方在桌面 sidecar 不可用时
会静默降级为文本 completion。内置 Gateway 已提供 Anthropic `/v1/messages` 接口与跨协议
转换，但目前只由 Tauri 应用启动，依赖 renderer 生成路由快照，也没有完整实现持续演进的
Claude Code Gateway 契约。

许多提供商都提供 Anthropic wire 端点，GLM 和 Kimi 只是例子，不是需要特殊处理的名称。
协议相似不代表 Claude Agent SDK 兼容：流式细节、工具调用分片、错误结构、beta header、
session 行为、prompt caching、thinking block 与未来 Claude Code 字段都可能不同。
Anthropic 也明确不支持通过 Gateway 把 Claude Code 路由到非 Claude 模型。因此 Cognia
必须建立自己的版本化兼容契约，不能把第三方端点描述成官方支持的 Claude 部署。

Headless Cognia 已有 `HeadlessSidecarHost` 和外部进程控制面，但没有实例化内置 LLM
Gateway。Agent Team 已有持久化 Workflow 编排、权限级联、预算、恢复和委派控制。新方案
必须深化这些模块，不能再实现一套 headless Gateway、Team 引擎、权限总线、预算治理器或
session 格式。

## 决策

### 1. 一个逻辑执行服务，三类运行时适配器

Cognia 对外提供一个逻辑 `AgentExecutionService`。

```text
Chat / Plugin / Workflow / Team
                |
                v
      AgentExecutionService
                |
       resolveAgentExecutionSpec()
                |
     +----------+-----------+
     |                      |
 Agent Host          ExternalAgentManager
     |                      |
 +---+----+        ACP / Codex / OpenCode / A2A
 |        |
Claude   AI SDK
Agent SDK 工具循环
```

运行时适配器族保持为：

- `ClaudeAgentSdkRuntimeAdapter`；
- `AiSdkRuntimeAdapter`；
- 现有 `ExternalAgentManager` 下的外部协议适配器。

物理上保留两个服务，而不是强制合并成一个进程：

- 通用 Node `agent-host.mjs`，包含 Claude Agent SDK 与 AI SDK 适配器；
- 现有外部 Agent manager 及其进程/传输边界。

外部 Agent 会接入统一逻辑服务，但不会被强行塞进 Node sidecar。`agent_send` 与
`agent://message` 成为规范命令和事件名；迁移期间继续保留 `claude_*` 命令和
`claude://message` 兼容别名。

### 2. 每个 Agent session 都先解析并冻结

`AgentExecutionPolicy` 定义在 `@cognia/agent-config-types`，至少包括：

- `runtimePolicy`：`auto`、`claude-agent-sdk` 或 `ai-sdk`；
- `routePolicy`：`gateway-required`、`gateway-preferred` 或 `direct`；
- deployment/model binding、credential profile 引用与 credential-affinity 策略；
- 执行目标：`colocate`、`auto` 或 `pinned`；
- 必需能力与偏好能力；
- 显式 fallback policy；
- 适用时的 Team 委派和深度限制。

唯一的 `resolveAgentExecutionSpec()` 先求硬约束交集，再应用偏好，为一个 session 产出
不可变的 `ResolvedAgentExecutionSpec`。该 spec 固定运行时适配器、deployment、模型绑定、
路由、宿主、兼容证据、能力投影、credential lease 引用和 execution fingerprint。session
运行中不得静默切换路由或宿主。

桌面默认 `gateway-preferred`；headless 与受管部署默认 `gateway-required`，管理员可以锁定。
preferred 只允许在 Gateway 尚未联系 upstream 前发生基础设施故障时回退直连。策略拒绝、
配额拒绝、upstream 错误或已经产生任何响应字节，都禁止直连重放。

`auto` 只有在执行路径属于原生、厂商认证或 Cognia 验证时才选择 Claude Agent SDK。普通
兼容端点仍走 AI SDK。用户可以显式选择实验性 Claude Agent SDK 路径，但 UI 与 trace 必须
明确标识为 experimental。

### 3. 拆分 provider、deployment、transport 与 compatibility

版本化 Provider Profile Store 成为事实来源：

- `ProviderProfile` 表示厂商或账户；
- `DeploymentProfile` 表示端点、协议、区域、credential 引用和模型清单；
- `TransportProfile` 表示 wire 行为，包括协议、base URL、认证方式、允许的静态/语义
  header 和模型绑定；
- `AgentRuntimeCompatibility` 表示某一具体执行路径的兼容证据。

这会取代 `zhipu` 加 `glm-anthropic`、`moonshot` 加 `kimi-anthropic` 等重载 provider id
的表达方式。现有 id 在迁移期保留为 legacy deployment alias。任何运行时或 Gateway
分支都不得硬编码 GLM、Kimi、MiniMax、OpenRouter 或其他提供商名称。

Transport profile 采用数据驱动。支持 `x-api-key`、bearer 和白名单 custom header 等认证
形式。profile 不得提供保留 header、hop-by-hop header、浏览器转发 header 或内部
`x-cognia-*` header。secret 始终保存在平台 Secret Store 中，只通过 id 引用；不得进入
resolved spec、事件日志、导出或 trace。

桌面端通过现有 settings/Dexie 投影持久化非敏感 profile，通过 OS keyring 保存 secret。
Headless 通过现有 SQLite/AppStore 边界和加密 secret store 保存。CLI、admin/service RPC
和声明式导入负责管理 headless profile。环境变量、mounted secret 或 stdin 只用于 bootstrap，
不能成为长期事实来源。

### 4. 兼容性是矩阵，也是认证产物

`anthropic` 协议、`anthropic-native` 与 Claude Agent SDK 兼容性彼此正交。兼容证据必须
绑定以下完整路径：

```text
runtime + ingress protocol + route mode + translation mode + deployment + model
        + Agent SDK version + Claude Code version + Gateway version + suite version
```

证据等级为 `native`、`vendor-certified`、`cognia-verified`、`experimental` 和
`unsupported`。能力等级为 `core`、`extended`、`full`，并通过明确字段描述 streaming、
普通/并行工具、分片 JSON、tool result/error、MCP、权限中断/恢复、多轮与 session resume、
prompt caching、thinking、context management、图片、beta、限流、upstream error 和
stream interruption。

有效能力集合是 model metadata、runtime、Gateway/transport、host/platform、兼容证据、
权限和可用资源的交集。硬要求未知即视为不支持。任务声明 `requires` 与 `prefers`；不满足
硬要求时必须在消耗模型 turn 前失败。可选但不支持的能力在请求前关闭，并记录到 trace。

Connectivity probe 只能证明端点可调用，不能升级兼容等级。显式、可能计费的 Agent Core
smoke test 可以生成本地证据。官方/CI certification 运行完整套件并产出签名 manifest。
跨协议 Claude Agent SDK 路径只有在包含 Gateway 转换的完整执行路径通过认证后，才允许被
`auto` 选择。

内置 `@anthropic-ai/claude-agent-sdk` 必须精确锁版本。Agent SDK、内嵌 Claude Code、
Gateway 或测试套件版本任一变化，匹配的兼容证据都变为 stale，并要求重新认证。上一份已
认证产物需要保留用于回滚。

### 5. Gateway 是首选的安全与路由边界

现有 `cognia-gateway` crate 被深化为 host-neutral 服务。`GatewayHost` 边界提供事件、设置、
secret 解析和持久化：

- Tauri 使用 Tauri event、settings 与 keyring；
- headless 使用 EventBus、SQLite/AppStore 与加密 secret store。

`GatewayState` 纳入 `HeadlessServices`，由 `cognia-server` 启动。桌面和 headless 使用同一份
provider-profile 投影与同一套 Gateway 实现。没有 renderer 时，Gateway 仍可使用最后一份
有效快照继续服务；路由事实来源不再依赖窗口保持打开。

Agent session 使用显式、短期有效的 `GatewayRouteTicket`。Agent Host 解析 execution spec 后，
请求 Gateway 签发 ticket；其 secret 作为本地 Gateway credential 提供给 Claude Code。
ticket 绑定：

- route pin id 与 execution fingerprint；
- 冻结且有序的 deployment/model candidate；
- 允许的模型 alias 与 role binding；
- session lineage、route policy 与过期时间；
- credential-affinity 与 failover 限制。

有 ticket 的请求不再经过实时 alias 重路由。Gateway 只能在 ticket 冻结的 candidate 列表中，
且只在产生响应字节前切换。原生 subagent 继承父 ticket；Cognia 编排的子 session 独立获得
ticket。ticket secret 不持久化；恢复时只能为同一冻结 spec 重新签发，否则暂停或失败。

模型角色 `primary`、`fast`、`powerful` 把 Claude 入站 selector（如 `sonnet`、`haiku`、
`opus`）映射到具体 deployment model。一个 deployment 可以把全部角色映射到同一模型。
绑定按 session 冻结，未映射 selector 必须失败。普通 Chat 与 AI SDK 流量仍可继续使用动态
全局 alias。

Agent credential affinity 默认 `sticky-with-failover`；completion 流量可以保持 per-request。
Agent session 持有一个 credential lease，仅在允许的瞬态故障时切换到另一个已预授权
credential，之后继续保持粘滞。401/403 后默认禁止账户 failover，除非 profile 明确允许。
管理员撤销凭证时，相关 ticket 和 lease 一并失效。

同协议流量下，Gateway 是“带安全中介的语义透明层”：在替换认证并剥离 hop-by-hop、浏览器
和内部 header 的同时，保留安全的 Anthropic version/beta/semantic header、兼容响应 header、
SSE 字节顺序、状态码与 upstream error body。跨协议流量经过规范 IR，并报告所有语义损失。
Gateway 自身生成的错误只用于 Gateway 拒绝、candidate 耗尽与转换失败。

### 6. Agent Host 通用化并隔离环境

`claude-host.mjs` 演进为 `agent-host.mjs`，桌面和 headless 使用同一 host supervisor。两个
内置 runtime adapter 接受相同 resolved spec，并输出相同规范事件。

每次 query 的环境先从 subprocess 必需的白名单基础环境构建，再叠加当前 session 的解析结果。
在应用路由前，必须显式删除继承的 provider route 与认证变量。当前
`{ ...process.env, ...sendOptions.env }` 会造成凭证跨 session 泄漏，不能继续原样使用；但
也不能只传 `sendOptions.env`，因为 Agent SDK 0.3.183 会把它视为 Claude Code subprocess 的
完整环境。

Gateway 路由只注入本地 Gateway endpoint 和 ticket，upstream secret 留在 Gateway。直连路由
在 execution host 上临时解析 credential 引用。原生 subagent 继承父环境和 ticket；编排子
Agent 独立解析 session。

### 7. 区分原生 subagent 与异构 Team

Claude Agent SDK 原生 `AgentDefinition` 可以改变模型、工具和 prompt，但不能提供独立
provider、base URL、credential、route、runtime 或 host。因此：

- 相同 runtime、相同 Gateway ticket、仅变更模型角色时，优先使用原生 subagent；
- provider/deployment、credential、route、runtime、host 或硬能力不同时，Cognia 创建编排
  子 Agent session。

Team member 通过 `inherit`、固定 profile 或批准的 pool 选择执行目标。coordinator 只选择
candidate id，不能接触原始 URL、header 或 key。优先级依次为 member pinned/pool、Team run
policy、Team default、应用默认；只有显式 administrator force-all policy 可以覆盖。

嵌套 Team 复用现有 `delegation-orchestrator`。父子各自维护独立持久 board，只交换可序列化
`HandoffEnvelope`。`maxTeamDelegationDepth` 可配置，默认 2：root 深度 0、child 深度 1、
grandchild 深度 2，后者不得继续委派。该限制与原生 `subagentDepth` 分开。

Team lead 默认与 workspace owner 同宿主。Headless Cognia 本身是本地 execution host。原生
subagent 永远保持同宿主。编排子 Agent 只有在 handoff 可序列化、workspace/resource 使用稳定
引用、目标满足 runtime/tool/sandbox/credential policy，且 ADR-0082 允许时才能跨宿主。
credential 始终留在 host 本地。存在副作用的工作在恢复时不得静默迁移。

### 8. 复用现有权限、预算、重试与恢复权威

现有 permission cascade 保持权威。有效权限是 Team policy、parent ceiling、child request
与 runtime capability 的交集。未知权限 fail closed。Agent Host 是工具权限权威，Gateway
不是。Headless 没有交互审批人时，除非预声明 policy 已授权，否则必须拒绝。

现有 Team budget guard 被提取/复用为 Team/run 唯一 `RunBudgetGovernor`，统一限制 identity
层级中的总 execution、并发、fan-out 与花费。重复的 plugin budget 计数需要迁移或删除。
Gateway tenant/API-key quota 与 usage 继续作为 transport 层限制。所有失败 attempt 都计入
预算。

禁止 external Agent 静默回退到内置 runtime。Gateway 只负责单次请求内、响应前的 candidate
failover。runtime adapter 负责自身 handshake 与 transport 恢复。Workflow/Team 负责任务
retry 与 reassignment。副作用未知或不可逆时禁止自动 replay。

恢复复用现有 Workflow event log、checkpoint、lease 与 idempotency。Zustand 只是 UI 投影。
桌面 Dexie 与 headless persistence 实现同一 port。approval 不得在恢复时被推断为已批准。

恢复输入可以来自 Cognia 规范日志、runtime artifact、checkpoint 和导入 session。Cognia
深化现有 session-import registry，通过规范 hub-and-spoke codec 转换，而不是实现 N×N
converter。转换保真度为 `native-exact`、`structured`、`contextual`、`summary-only` 或
`unsupported`，并附显式 loss report。runtime artifact 可以重建缺失/损坏的 canonical store；
当目标 runtime 支持时，canonical history 可以物化为新 runtime session。若 SDK 没有公开
导入 API，Cognia 不会伪造私有 Claude JSONL。

`RecoveryPlanner` 只有在某候选方案可证明严格占优时才自动执行。tool 或副作用冲突一律暂停，
禁止 last-modified-wins。Headless 按 policy 进入 `recovery_required` 或失败。

### 9. 统一 event envelope、handle 与 identity 层级

规范事件契约深化现有 `CaptureStreamEvent`，不创建平行事件流。每个事件 envelope 包含
event id、sequence、session、run、turn、attempt、parent、host、runtime 与 timestamp。
事件类型覆盖 lifecycle、message、thinking、tool、permission、subagent、usage、compact、
checkpoint、warning 与 failure。Claude Agent SDK、AI SDK 和 external adapter 都映射到该
事件。原始 runtime event 只作为诊断附件。

Workflow 以 at-least-once 方式持久化 envelope，consumer 必须幂等。`AgentExecutionHandle`
暴露 id、resolved spec、events、send、cancel、interrupt、`resolvePermission`，以及受能力
约束的 `steer`、`setModel`、`setPermissionMode` 与 checkpoint。command 带 idempotency id。
`setModel` 只能选择冻结 ticket 中的 binding；不支持的操作返回强类型 capability error。

Identity 层级为：

```text
session -> run -> turn -> attempt -> providerAttempt
```

Gateway 在响应前切换 candidate 只产生新的 `providerAttempt`。host resume 为同一 run/turn
创建新 attempt。Team reassignment 创建新 child run。原生 subagent 也是规范 child run，
其 SDK id 只保存为 `runtimeBinding`。

### 10. Completion fallback 必须显式配置

Agent 请求的硬能力无法满足时默认 fail closed。`toolsEnabled: false` 表示主动选择 completion。
只有显式 `fallbackPolicy: "completion"` 才允许降级，结果必须携带 `degradedReason`。
Headless 与受管环境默认禁止 completion fallback。

旧配置迁移规则如下：

| 旧状态 | 迁移后的含义 |
| --- | --- |
| `toolsEnabled: false` | `executionKind: "completion"` |
| `toolsEnabled: true`、`requireTools: true` | Agent 必须有工具，不允许 fallback |
| `toolsEnabled: true`、`requireTools` 缺失/false | 显式 completion fallback，并标记 `legacyMigrated: true` |
| 新 Agent 配置 | 除非显式选择，否则不允许 fallback |

受管 policy 可以覆盖 legacy 兼容行为。旧 `runtime: "claude"`、`proxyMode`、provider relay id
与 `claude_set_*` 只保留为读取/命令适配器；所有新写入使用新 schema。

## 首个交付切片

第一个 vertical slice 证明“任意自定义 Anthropic 协议 deployment，经内置 Gateway 进入
Claude Agent SDK”，并同时支持桌面与 headless：

- 显式 `runtimePolicy: "claude-agent-sdk"`；
- 显式 `routePolicy: "gateway-required"`；
- 认证通过前必须实验性 opt-in，通过后才允许 `auto`；
- 不硬编码 provider 名称；
- Gateway 不可用时明确失败，绝不直连 fallback。

验收覆盖真实 SSE、普通/并行工具、分片 tool JSON、tool result/error、MCP、权限中断/恢复、
多轮、原生 subagent model binding、credential sticky、重启/恢复和无 secret trace。CI 使用
确定性的 Anthropic conformance server；真实 provider certification 是可选且显式计费的
job。异构 Team 与跨协议自动选择只能在该切片稳定后继续。

## 结果

- Cognia 得到一套可理解的 Agent 执行契约，同时保留已有且可工作的引擎。
- Anthropic 兼容提供商在显式选择并验证后可以使用 Claude Agent SDK；AI SDK 仍是生产级
  provider-neutral 路径。
- 桌面和 headless 共用相同 Agent Host 与 Gateway 语义。
- 使用 Cognia 编排时，Team member 可以使用不同模型、deployment、runtime、credential 和
  host；原生 subagent 刻意不支持这些差异。
- session 的 route、host、model binding、兼容证据与 credential affinity 都可检查且稳定。
- 方案会增加 TypeScript、Node 和 Rust 的契约与迁移工作；SDK 和 Gateway 版本演进时必须
  持续维护认证。

## 被否决的替代方案

- **所有模型都通过 Claude Agent SDK。** 这会把私有且持续演进的 Claude Code 契约变成
  provider-neutral runtime，也违反 Anthropic 的支持边界。
- **把每个 Anthropic wire 端点都视为兼容。** 协议标签不能证明 Agent 语义。
- **单独实现 headless Gateway。** 会重复安全、路由、转换和 quota 逻辑。
- **把 external Agent 搬进 Node sidecar。** 其进程与协议边界已有共享 manager 和 headless
  transport。
- **用 Agent SDK 原生 subagent 实现异构 Team。** 原生 definition 无法携带独立 provider、
  route、credential、runtime 或 host。
- **允许静默文本 completion 或 runtime fallback。** 会隐藏工具丢失，并可能用不同语义重放
  副作用。
- **成对转换恢复格式。** N×N 转换不可维护，也会掩盖数据损失。
- **Agent session 内让 Gateway 使用实时全局 alias。** 会破坏可复现性、credential affinity
  与恢复。

## 安全与运维要求

- upstream secret、ticket secret 与原始 credential 均不得持久化或进入事件。
- profile custom header 必须经过白名单；保留和内部 header 必须拒绝。
- 每次 route、capability、credential lease、fallback 与 recovery 决策都可审计。
- Gateway ticket 必须限定范围、短期有效、可撤销，并绑定冻结 execution spec。
- 权限决策保持 fail closed，approval 不得被继承为隐式授权。
- compatibility 与 certification 记录包含精确 runtime 和 Gateway 版本。

## 附录（2026-07-24）— 实施记录

Phase 0–8 已在 `dev` 落地（契约 → 档案 → gateway → agent host → conformance
→ 认证 → 调用方迁移 → 团队 → 恢复）。本附录记录计划要求写明的运维事实。

### Conformance 套件位置

`tests/conformance/`（顶层,纯 `node:test`）:确定性 Anthropic 协议服务器
（`anthropic-server/`）、场景矩阵、harness（真 `cognia-server` 二进制 + 真
sidecar）与用例。先 `pnpm conformance:prepare` 再 `pnpm test:conformance`。
认证 bundle 由同一套件产出（`--emit-manifest`）;回滚用
`scripts/certify/rollback-bundle.mjs`,恢复上一 bundle 指针并报告需一并
移动的已安装工件版本漂移。上下文物化路径有独立端到端用例
（`cases/session-materialize.test.mjs`,经共享 fixture 与 codec 重放 prompt
字节级互钉）;崩溃的 agent run 在启动时经恢复 planner 对账
（`lib/ai/agent/recovery/reconcile-crashed-runs.ts`——停靠或
`recovery_required`,绝不重放）。

### R1 spike 结论（冻结）

`sidecar/dispatch/session-materialize.spike.live.test.mjs` 对真 SDK 运行:
不存在公开的"从外部消息创建会话"API;外来 id resume 绝不以该 id 静默成功;
绝不伪造私有 JSONL。因此 claude-code codec 的 `materialize` 保真度为
**contextual**（重放 prompt）。spike 是 SDK 升级绊线——若 materialize API
出现,其 surface 断言失败,结论必须复议。

### 退役时点表（Phase 9）

每个 legacy 路径删除都受遥测门控,独立提交并带 flag 逃生。观察计数器:
sidecar `legacy_dispatch`（无 spec 发送）、Rust `DeprecatedCommandCounters`
/ `agent_command_telemetry`（`claude_*` 别名调用）、以及
`agent.execution.resolved` 事件量。

| 步骤 | 前置条件（观察窗） | 动作 |
| --- | --- | --- |
| 1 | `agentExecutionResolverV2` 默认开启满一个完整发布周期,且桌面+headless 的 `legacy_dispatch` 连续 14 天为 0 | 删除 `sidecar/dispatch/index.mjs` 的 provider-id 分支;无 spec 发送报 `LegacyDispatchRemovedError` |
| 2 | 步骤 1 后按发布节奏决定 | `claude-host.mjs` 缩为 ≤30 行名称适配 wrapper;tauri-smoke 验 bundle 资源（COPY 陷阱） |
| 3 | `claude_*` 别名计数连续 14 天为 0 | `claude_set_*` 三段退役:转发+计数 → dev 报错 → 删除（+ ACL/注册更新）,每段 tauri-smoke |
| 4 | 步骤 1 完成 | 清理重复 writer:executeAgent flag-off legacy 分支、relay provider 创建路径（reader 保留并注明 LTS）;renderer snapshot publisher 退为纯控制面（闭合 R3） |

在步骤 1 前置条件满足之前,flag-off legacy 路径就是生产主路径,必须保持
字节级一致行为（由 Phase 6 的逐调用方 parity 测试钉住）。

## 附录（2026-08-03）— Claude Agent SDK 0.3.220 完整能力

Anthropic runtime 现通过版本化嵌套选项契约、生成并审计的控制与会话函数清单、穷尽式规范事件映射、全部 Hook 事件、结构化输出、动态 MCP/插件/技能、检查点控制、后台任务、子进程遥测、租户隔离的 Rust `SessionStore` 和指纹隔离预热，覆盖完整公共 SDK 能力面。

桌面端、CLI、headless 与 companion 共用一份不含密钥的能力快照。桌面端额外提供受控的高级功能开关与原生 SDK 会话管理；`cognia-agent sdk` 提供类型化会话操作，不开放原始选项逃生口。发布由 `claudeSdkParityV1` 控制，并由 `claudeSdkSessionStore`、`claudeSdkCheckpoint` 与 `claudeSdkPrewarm` 分别控制高风险能力。会话存储与文件检查点以 fail-closed 方式互斥。

Conformance 套件版本 `2` 将认证扩展到完整的 40 项能力词表。SDK 版本、surface manifest、套件版本和 certification bundle 必须作为一个整体回滚。

### 长期门禁

`check:provider-name-branches`（grep 运行时代码的 provider 名特判）、
`check:runtime-versions`（stale 判定版本钉）、suite-manifest hash 钉、
colocated-test 审计,均在 `check:all` 中。

## 附录（2026-08-04）— Gateway 本地路由策略 V2

Gateway 快照现在携带版本化且不含密钥的路由策略。Rust Gateway 在本地按
`priority`、`weighted` 或 `round-robin` 分配显式 alias；虚拟模型 `auto`
使用已配置的内置策略。Chat、Responses、embedding 与上游探测不再等待
renderer 的 `gateway://decide` 往返。旧快照继续按优先级顺序读取；无效 V2
快照整体拒绝，并继续服务上一份有效策略。

部署选择先于现有的 provider 凭据轮换。轮询 cursor 仅在进程内保存，以候选
集合为作用域，从第一个成员开始，并在策略变化时安全重置。若凭据池全部处于
冷却状态则快速失败；可重试故障使用有上限的指数退避，并可遵循上游恢复时间。
会话亲和与 route ticket 的冻结候选仍优先于逐请求分配，且响应字节提交后绝不
执行 fallback。

可执行协议边界仍限于 OpenAI-compatible 与 Anthropic；其他 provider 协议不会
被静默视为兼容协议。
