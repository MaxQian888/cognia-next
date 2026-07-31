# 统一 Agent 执行与 Gateway 兼容性 — 实施计划

**日期**: 2026-07-23

**状态**: 已冻结设计，待分阶段实施

**依据**: ADR-0090；`docs/research/agent-sdk-gateway-non-claude-models-2026-07-23.md`

**目标**: 在不重复实现既有 Agent、Team、Workflow、Gateway 与恢复模块的前提下，建立统一
Agent 执行契约；让任意经过验证的 Anthropic 协议 deployment 可以显式经内置 Gateway 使用
Claude Agent SDK，并在桌面与 headless 环境得到一致行为。

## 0. 使用方式与证据等级

本文是实施顺序与验收契约，不是第二份 ADR。执行者必须先读 ADR-0090，再按阶段推进。每个
阶段应独立提交；除明确依赖外，不做顺手重构。

| 标签             | 含义                             | 实施要求                             |
| ---------------- | -------------------------------- | ------------------------------------ |
| **[CONFIRMED]**  | 已在 2026-07-23 读取当前实现确认 | 按符号重新定位，行号可能漂移         |
| **[UNVERIFIED]** | 实现细节尚需 spike 或测试确认    | 先做最小验证，不得把推测写进生产契约 |
| **[OPEN]**       | 尚未冻结的产品/架构选择          | 本计划当前无阻塞性 OPEN 项           |

本文没有把“Anthropic 协议”推导为“Claude Agent SDK 兼容”。第三方模型路径属于 Cognia
兼容层，Anthropic 官方明确不支持通过 Gateway 把 Claude Code 路由到非 Claude 模型。

## 1. 当前拓扑与目标拓扑

### 1.1 当前事实

- **[CONFIRMED]** `sidecar/dispatch/index.mjs` 只在
  `sendOptions.provider === "anthropic"` 时调用 `dispatchAnthropic`，其他 provider 全部调用
  `dispatchAiSdk`。选择依据是 provider id，不是 protocol 或兼容证据。
- **[CONFIRMED]** `sidecar/claude-host.mjs` 已同时承载 Claude Agent SDK 与 AI SDK session，
  因此不需要再造一个 AI SDK sidecar。
- **[CONFIRMED]** `lib/ai/agent/external/manager.ts` 与
  `lib/ai/agent/external/protocol-adapter.ts` 已提供统一外部 Agent manager/adapter registry，
  并有 headless transport；不能迁入 sidecar 重做。
- **[CONFIRMED]** `lib/ai/agent/agent-executor.ts` 在 sidecar 不可用时可静默走无工具
  `streamText`；只有 `action.agent.turn` 的 `requireTools` 做了提前硬失败。
- **[CONFIRMED]** `crates/cognia-gateway` 已有 `/v1/messages`、同协议透传、跨协议 IR、
  candidate walk、key pool、cooldown、quota 与 SSE 转换。
- **[CONFIRMED]** Gateway `ProviderSnapshot` 只有 protocol/base URL/API key/models，Anthropic
  upstream header 固定为 `x-api-key` 与 `anthropic-version: 2023-06-01`，不能表达通用认证、
  semantic header forwarding 或 Agent session ticket。
- **[CONFIRMED]** Tauri `src-tauri/src/lib.rs` 管理并启动 `GatewayState`；
  `src-tauri/src/bin/cognia-server.rs` 只安装 `HeadlessSidecarHost`/`HeadlessServices`，没有内置
  LLM Gateway。
- **[CONFIRMED]** `lib/gateway/snapshot-publisher.ts` 由 renderer 生成 Gateway snapshot；
  headless 尚无同源投影。
- **[CONFIRMED]** `@anthropic-ai/claude-agent-sdk` 锁定为 0.3.183；其 `env` 是 Claude Code
  subprocess 的完整环境。当前 Anthropic dispatcher 显式 spread `process.env`，但未先清理
  继承的 route/auth 变量。
- **[CONFIRMED]** provider catalog 同时存在 `zhipu`/`glm-anthropic`、
  `moonshot`/`kimi-anthropic`、`minimax`/`minimax-anthropic` 等重复表达，并把 relay 广泛归为
  `anthropic-native`。
- **[CONFIRMED]** Team 已有 `delegation-orchestrator.ts`、`budget-guard.ts`、
  capability resolver、durable board、checkpoint 与 Workflow 合成；session import 已有
  Claude Code/Codex/OpenCode 等 adapter 以及 Claude subagent/DAG 支持。

### 1.2 运行轨计数

实施前后都只有三类运行轨：

| 运行轨                 | 现有实现                                   | 目标适配器                     |
| ---------------------- | ------------------------------------------ | ------------------------------ |
| Claude Agent SDK       | `sidecar/dispatch/anthropic.mjs`           | `ClaudeAgentSdkRuntimeAdapter` |
| AI SDK Agent/tool loop | `sidecar/dispatch/ai-sdk.mjs`              | `AiSdkRuntimeAdapter`          |
| 外部 Agent             | `ExternalAgentManager` + protocol adapters | 保持现有 adapter family        |

以下不是新运行轨：Chat、Plugin、Workflow、Team、Gateway/direct、native/orchestrated
subagent、desktop/headless/remote、text completion fallback。

### 1.3 目标物理拓扑

```text
                   AgentExecutionService
                          |
             resolveAgentExecutionSpec()
                          |
              +-----------+-----------+
              |                       |
      generic agent-host       ExternalAgentManager
              |                       |
       +------+-------+        existing adapters
       |              |
Claude Agent SDK    AI SDK
```

逻辑统一，不强行合并进程。外部 Agent 保持现有进程隔离和 companion/headless RPC 面。

## 2. 不重复实现清单

| 领域          | 必须复用/深化                                              | 禁止新增的平行实现                    |
| ------------- | ---------------------------------------------------------- | ------------------------------------- |
| Provider 解析 | `provider-consumption`、provider catalog、settings         | 第三套 Agent 专属 provider catalog    |
| Gateway       | `crates/cognia-gateway`                                    | headless-only Gateway crate/server    |
| Agent Host    | 当前 `claude-host.mjs` supervisor 与 dispatchers           | 第二个 AI SDK host                    |
| 外部 Agent    | `ExternalAgentManager`、`ProtocolAdapter`、agent transport | sidecar 内重写 ACP/A2A/Codex/OpenCode |
| 权限          | `permission-cascade`、现有 sidecar approval round-trip     | Agent Team 专属新审批总线             |
| Team 编排     | Workflow 合成、`delegation-orchestrator`、durable board    | Agent SDK native Team 替代品          |
| 预算          | Team `budget-guard`                                        | runtime/plugin 各自独立总预算         |
| 恢复          | Workflow event log/checkpoint/lease/idempotency            | 新 Agent 专用日志数据库               |
| session 转换  | `lib/session-import/registry.ts` 与 adapter                | 每对 runtime 的 N×N converter         |
| 远程宿主      | ADR-0082 host/resource/lease 模型                          | 新的 Agent 远程传输协议               |
| 规范事件      | `CaptureStreamEvent`                                       | Claude/AI SDK/External 三套上层事件   |

如果某工作项发现现有模块无法扩展，必须在 PR 描述中给出搜索范围、缺口和新文件必要性。

## 3. 核心契约

以下是形状约束，不要求一次性按此命名拆成大量文件。优先扩展现有 package/module。

### 3.1 执行策略与冻结 spec

`packages/agent-config-types/src/index.ts` 增加共享类型：

```ts
type AgentRuntimePolicy = "auto" | "claude-agent-sdk" | "ai-sdk"
type AgentRoutePolicy = "gateway-required" | "gateway-preferred" | "direct"
type AgentExecutionTarget =
  { mode: "colocate" } | { mode: "auto" } | { mode: "pinned"; hostRef: string }
type CredentialAffinity = "session-sticky" | "sticky-with-failover" | "per-request"

interface AgentExecutionPolicy {
  executionKind: "agent" | "completion"
  runtimePolicy: AgentRuntimePolicy
  routePolicy: AgentRoutePolicy
  deploymentRef?: string
  modelBindingRef?: string
  credentialProfileRef?: string
  credentialAffinity?: CredentialAffinity
  executionTarget?: AgentExecutionTarget
  requires?: AgentCapabilityId[]
  prefers?: AgentCapabilityId[]
  fallbackPolicy?: "none" | "completion"
}
```

`ResolvedAgentExecutionSpec` 必须可序列化但不含 secret，至少固定：

- session/run lineage 与 `executionFingerprint`；
- runtime adapter、deployment/model role binding；
- Gateway/direct route pin；
- host ref；
- compatibility evidence/version；
- effective capability set 与被关闭的 optional capability；
- credential lease/profile version；
- recovery/fallback constraints。

唯一 `resolveAgentExecutionSpec()` 负责解析。调用方不能各自重新选择 runtime、route 或 host。
resolver 的输入包含 app default、Team/member override、managed policy、host capability 与当前
profile snapshot；输出在 session 生命周期内不可变。

### 3.2 Provider/Deployment/Transport/Profile

优先扩展 `packages/provider-types` 与现有 settings 类型，形成：

```ts
interface ProviderProfile {
  id: string
  displayName: string
  deploymentRefs: string[]
}

interface DeploymentProfile {
  id: string
  providerRef: string
  endpoint: string
  region?: string
  transportProfileRef: string
  credentialProfileRef?: string
  models: DeploymentModel[]
}

interface TransportProfile {
  protocol: "anthropic" | "openai" | string
  auth: { scheme: "x-api-key" } | { scheme: "bearer" } | { scheme: "custom-header"; name: string }
  staticHeaders?: Record<string, string>
  forwardedSemanticHeaders?: string[]
}
```

约束：

- custom header name/value 必须经过 Gateway 与 direct adapter 共用的验证器；
- raw secret 不进入 profile store；
- 现有 provider ids 先映射为 legacy deployment aliases，不能一次破坏历史会话；
- `family: "anthropic-native"` 不再用作 Agent SDK compatibility 信号；
- GLM/Kimi 只作为 migration fixture，不出现 provider-specific runtime 分支。

### 3.3 兼容矩阵

Compatibility key 必须包含 runtime、ingress protocol、route/translation mode、deployment、
model、Agent SDK/Claude Code/Gateway/suite version。manifest 同时包含：

- evidence：`native | vendor-certified | cognia-verified | experimental | unsupported`；
- level：`core | extended | full`；
- 每项 capability 的 supported/unsupported/unknown；
- suite case 结果、时间、签名/issuer、expiry/stale reason；
- direct/Gateway parity 结果；
- 已知语义损失。

`ConnectivityProbe` 与 `AgentCoreSmoke` 是不同 API。前者不得写 certification。后者必须显式
提示可能计费，并可指定 sandbox credential/deployment。

### 3.4 Gateway route ticket

Gateway 新增 session-scoped ticket issuance/validation，不复用普通 API key 语义：

```text
GatewayRouteTicket
  ticketId / routePinId / executionFingerprint
  sessionId / parentSessionId
  ordered candidate deployments
  allowed model selector -> frozen concrete model binding
  credential-affinity/failover policy
  route policy / issuedAt / expiresAt / profile version
```

只持久化 ticket metadata/revocation，不持久化 bearer secret。ticket 进入 Claude Code 时充当
本地 `ANTHROPIC_API_KEY`，Gateway 保存 upstream credential authority。

普通 alias 继续服务 Chat/AI SDK；ticket 请求必须绕过 live alias resolver。发生响应字节后，
candidate 与 direct/Gateway 路由都不能切换。

### 3.5 事件、handle 与身份

深化 `CaptureStreamEvent`，形成 envelope：

```ts
interface AgentEventEnvelope {
  eventId: string
  sequence: number
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  providerAttemptId?: string
  parentRunId?: string
  hostRef: string
  runtime: string
  timestamp: string
  event: CanonicalAgentEvent
}
```

delivery 为 at-least-once，consumer 以 `eventId` 幂等。raw runtime payload 只允许在受控诊断
附件中出现。`AgentExecutionHandle` 的 command 必须带 idempotency key，capability 不支持时
返回 typed error，不能静默 no-op。

身份层级固定为 `session -> run -> turn -> attempt -> providerAttempt`，预算、trace、恢复与
Team parent/child 都按此聚合。

## 4. 分阶段实施

### Phase 0 — 契约、特性开关与 shadow resolver

**目标**: 在不改变现有执行结果的前提下，引入统一 vocabulary 与可观测解析。

**主要位置**

- `packages/agent-config-types/src/index.ts`
- `packages/provider-types/src/*`
- `lib/ai/agent/*` 中现有 executor/resolver 边界
- `types/claude/*`、`types/gateway/*` 的兼容 type

**工作**

1. 增加 policy/spec/capability/compatibility/identity 类型与 schema validation。
2. 新增唯一 resolver，先以 shadow mode 运行：记录“新 resolver 会选什么”，旧路径仍执行。
3. 定义 feature flags：
   - `agentExecutionResolverV2`
   - `genericAgentHostCommands`
   - `gatewayAgentRouteTickets`
   - `headlessLlmGateway`
   - `experimentalAnthropicDeploymentAgentSdk`
4. 生成 secret-free decision trace，比较旧/new runtime、provider/model、route 与 fallback。
5. 建立 legacy mapping 单元测试，覆盖现有 `runtime`、`proxyMode`、provider relay id 与
   `toolsEnabled/requireTools`。

**验收**

- shadow resolver 对当前合法配置给出稳定 spec；
- 同一输入重复解析得到相同 fingerprint；
- trace 不含 API key、ticket 或 custom auth value；
- 关闭 flags 时没有行为变化。

### Phase 1 — Provider Profile Store 与 deployment 迁移

**依赖**: Phase 0。

**主要位置**

- `packages/provider-types/src/built-in-provider-catalog.ts`
- `packages/provider-core/src/providers/*`
- `lib/db/settings.ts` 及对应 Dexie migration
- headless AppStore/secret-store 管理面
- provider settings UI 与双语 i18n

**工作**

1. 建立 versioned `ProviderProfile`、`DeploymentProfile`、`TransportProfile` 和 credential
   reference。
2. 写幂等迁移：provider id → provider/deployment；保留 legacy alias 与 round-trip export。
3. 将 `*-anthropic` relay 从 provider family 语义迁为 deployment transport；不删除旧 id。
4. 桌面与 headless 实现同一 store port；secret 写入 OS keyring/加密 store。
5. 增加 CLI/admin/service RPC 与 redacted export/import；移动/paired 普通客户端不能读写
   raw secret。
6. custom header validator 阻止 `authorization`、`x-api-key` 的非受控覆盖、hop-by-hop、
   browser forwarding、Host 与内部 `x-cognia-*`。

**验收**

- zhipu/GLM、moonshot/Kimi、MiniMax 与任意 custom Anthropic deployment 都用同一数据模型；
- 旧 settings/session 可以读，新写入不再生成新 relay provider id；
- desktop/headless profile projection 等价；
- export、logs、events、Dexie 非 secret table 均无 raw key；
- migration 可重复执行且 rollback reader 可理解新旧记录。

### Phase 2 — Host-neutral Gateway、transport profile 与 route ticket

**依赖**: Phase 1 的 profile projection；ticket schema 依赖 Phase 0。

**主要位置**

- `crates/cognia-gateway/src/lib.rs`
- `commands.rs`、`server.rs`、`snapshot.rs`、`execute.rs`
- `translate/*`、`api_keys.rs`、`session_key.rs`
- `lib/gateway/snapshot-publisher.ts`
- `src-tauri/src/headless/mod.rs`
- `src-tauri/src/bin/cognia-server.rs`
- `src-tauri/src/lib.rs`

**工作**

1. 从 Tauri-specific wiring 提取 `GatewayHost` port，不复制 Gateway server。
2. Tauri adapter 保持现有命令/事件/keyring 行为；Headless adapter 接入 EventBus、
   AppStore/SQLite 与 encrypted secret store。
3. `GatewayState` 加入 `HeadlessServices`，由 `cognia-server` 按配置启动、停止和报告 health。
4. 将 snapshot 改为 Provider Profile Store 的共享 projection；renderer 只做 UI/控制面，
   headless brain 能独立产出并刷新；无 renderer 时使用最后有效版本。
5. `ProviderSnapshot` 扩展为不含 raw secret 的 deployment/transport projection，执行时按
   credential reference/lease 解析。
6. 实现 route-ticket mint/validate/revoke/expire，ticket route 绕过 live alias。
7. 实现 session-sticky/sticky-with-failover/per-request；Agent 默认
   sticky-with-failover，401/403 默认不切账户。
8. 同协议 Anthropic 路径保留 semantic headers、status/error body、SSE order 与安全 response
   headers；剥离 auth、hop-by-hop、browser/internal headers。
9. 跨协议 IR 对每个丢失字段输出 structured loss，不允许静默 drop；中途 stream error 映射为
   Anthropic `event:error`。
10. candidate failover 仅限 ticket candidates 且在首个响应字节之前。

**验收**

- 同一个 Gateway crate 在 Tauri 与 `cognia-server` 启动；
- headless 无 renderer 也能服务最后有效 profile snapshot；
- ticket 之外的模型、deployment、过期/revoked ticket 均 fail closed；
- same-protocol error body 与 SSE fixture 字节/顺序一致；
- ticket 请求不会因全局 alias 更新改变 candidate；
- restart 后可为相同 frozen spec 重签 ticket，不能扩大权限；
- secret scan、Rust unit/integration tests 与 concurrency tests 通过。

### Phase 3 — 通用 Agent Host 与统一事件/handle

**依赖**: Phase 0；Gateway route 需要 Phase 2，但 direct adapter 可先完成。

**主要位置**

- `sidecar/claude-host.mjs`
- `sidecar/dispatch/index.mjs`
- `sidecar/dispatch/anthropic.mjs`
- `sidecar/dispatch/ai-sdk.mjs`
- `src-tauri/src/claude/host.rs`
- `src-tauri/src/claude/commands.rs`
- `lib/claude/run-and-capture.ts`
- `lib/ai/agent/external/*`

**工作**

1. 先在现有 host 内建立 `RuntimeAdapter` interface，再把文件/进程入口兼容迁为
   `agent-host.mjs`；不要先复制后删除。
2. dispatch 从 provider id 分支改为读取 frozen `runtimeAdapter`。
3. 新增 canonical `agent_*` command 与 `agent://message`；旧 `claude_*`/event 通过 adapter
   转发并加 deprecation telemetry。
4. Claude、AI SDK、External event 全部映射到 `AgentEventEnvelope`；捕获层保持单一上层流。
5. 实现 `AgentExecutionHandle` 与 idempotent command routing。
6. 创建 allowlisted subprocess base env；显式清除 Anthropic/OpenAI/provider route/auth/proxy
   冲突变量，再叠加当前 spec env。保留 PATH、HOME 等 subprocess 必需项，但不继承凭证。
7. Gateway route 只注入 local endpoint、ticket 和冻结 model bindings；direct route 临时解析
   credential ref。
8. native subagent 继承 parent env/ticket/host，SDK runtime id 只作为 runtime binding。

**验收**

- 相同 session 不受父进程残留 provider env 影响；
- 并发两个不同 credential/route 的 session 无交叉；
- old command/event consumer 与新 consumer 得到等价结果；
- Claude/AI SDK/External 的 lifecycle、tool、permission、usage、failure 都进入同一 envelope；
- unsupported steer/model/permission-mode 返回 typed capability error；
- desktop/headless 使用同一 host supervisor。

### Phase 4 — 首个 vertical slice

**依赖**: Phase 1、2、3。此阶段是进入下一阶段的硬门禁。

**范围**

```text
custom Anthropic deployment
  -> runtimePolicy: claude-agent-sdk
  -> routePolicy: gateway-required
  -> built-in Gateway
  -> Claude Agent SDK 0.3.183
  -> desktop + headless
```

**工作**

1. 建 deterministic Anthropic conformance server，不绑定任何厂商名称。
2. 用真实 sidecar/Agent SDK/embedded Claude Code 对 Gateway 跑：
   - text SSE 与 multi-turn；
   - normal/parallel tools；
   - fragmented JSON；
   - tool result/error；
   - MCP；
   - permission interruption/approve/deny/resume；
   - native subagent 与 primary/fast/powerful model bindings；
   - 429/5xx、upstream error、stream interruption；
   - sticky credential 与允许的 pre-byte failover；
   - host/Gateway restart、ticket 重签与 canonical recovery；
   - trace/event/DB secret scan。
3. UI/CLI 只允许显式 experimental opt-in，不写 `auto` 兼容记录。
4. Gateway 不可用、ticket 无效、selector 未映射时明确失败；禁止 direct fallback。

**验收门禁**

- desktop 与 headless 使用同一 fixture matrix；
- fixture 覆盖全部 Agent Core 项；
- 同协议 Gateway/direct parity 测试通过；
- 任一 hard capability 不支持时在首个模型 turn 前拒绝；
- 全链路不存在 GLM/Kimi/provider-name branch；
- restart 后 session/run/turn identity 保持，attempt 正确递增；
- side effect ambiguous fixture 进入 `recovery_required`，不自动 replay。

### Phase 5 — Certification 与 `auto`

**依赖**: Phase 4 全部通过。

**工作**

1. 把 conformance suite 版本化，生成签名 manifest 与 compatibility record。
2. CI 使用 deterministic server；真实 vendor test 作为显式、可计费、sandboxed job。
3. `auto` resolver 只接受 native/vendor-certified/cognia-verified 且未 stale 的完整 execution
   path；cross-protocol 必须认证 Gateway translation path。
4. SDK、Claude Code、Gateway、suite 或 deployment/model 版本变化触发 stale。
5. 失败按 capability 维度 circuit-break/down-rank，不把整个 provider 粗暴标成不可用。
6. 保留上一 certified sidecar/Gateway artifact 与 manifest，提供快速 rollback。

**验收**

- connectivity probe 无法使 experimental deployment 进入 `auto`；
- stale manifest 不被 resolver 采用；
- required optional extension 缺失时拒绝，preferred extension 缺失时关闭并 trace；
- rollback 可以恢复上一套 SDK/Gateway/manifest 组合。

### Phase 6 — 调用方迁移与 completion fallback 收口

**依赖**: Phase 3；生产默认切换依赖 Phase 4。

**主要位置**

- `lib/ai/agent/agent-executor.ts`
- `lib/workflow/nodes/actions/agent-turn.ts`
- Chat/session send-options resolver
- Plugin Agent SDK facade
- Team dispatch entrypoints

**工作**

1. Chat、Plugin、Workflow、Team 全部调用 `AgentExecutionService`，不直接选择 sidecar/text。
2. 按 ADR-0090 迁移 `toolsEnabled/requireTools`：
   - false → intentional completion；
   - true + requireTools → required tools/no fallback；
   - legacy true + missing/false → explicit completion fallback + `legacyMigrated`；
   - 新 Agent config 默认无 fallback。
3. managed/headless policy 可以禁用 legacy fallback。
4. result 始终返回 runtime、route、capabilities 与 `degradedReason`。
5. 删除 shadow resolver 与确认无消费方的旧 writer；保留 compatibility reader/command。

**验收**

- 无桌面环境只要 headless Agent Host 可用，就走真实 Agent，不再以 `isTauri()` 判断工具能力；
- hard capability 缺失不会消费 completion；
- legacy 行为有明确 migration test，新配置默认 fail closed；
- old and new command telemetry 能量化剩余迁移面。

### Phase 7 — 异构 subagent、Team 与跨宿主执行

**依赖**: Phase 5 的 capability/compatibility；Phase 6 的统一调用入口。

**主要位置**

- `lib/claude/agents/dispatch-*`
- `lib/ai/agent/team/delegation-orchestrator.ts`
- `dispatch-teammate.ts`、`teammate-pool.ts`、`capability-resolver.ts`
- ADR-0082 remote host/resource modules

**工作**

1. resolver 判断 native 与 orchestrated：
   - 同 runtime/ticket/host，仅模型 role 不同 → native；
   - provider/deployment/credential/route/runtime/host/hard capability 不同 → orchestrated。
2. Team member 支持 `inherit | pinned | pool`，coordinator 只选择 profile/deployment candidate id。
3. 固定 precedence：member → Team run → Team default → app default；managed force-all 显式覆盖。
4. 复用 `delegation-orchestrator` 与 durable board；父子只交换 `HandoffEnvelope`。
5. 增加 `maxTeamDelegationDepth`，默认 2，与 native `subagentDepth` 分开。
6. 以现有 Team `budget-guard` 为基础建立唯一 `RunBudgetGovernor`；合并/删除重复 plugin budget。
7. 跨宿主复用 ADR-0082：stable workspace/resource refs、capability/credential locality、lease 与
   host pin。副作用工作禁止静默迁移。

**验收**

- 同一 Team 的成员可分别使用 Claude Agent SDK、AI SDK 与 external Agent；
- native subagent 无法偷偷改变 route/provider/credential；
- 深度 0/1/2 可委派，深度 2 继续委派被拒；
- root budget 统计所有 child run、attempt 与失败；
- raw key/base URL 不进入 coordinator prompt；
- cross-host handoff 不可序列化或资源不稳定时在 dispatch 前失败。

### Phase 8 — 恢复、互转与冲突规划

**依赖**: Phase 3 identity/event；基础 restart recovery 在 Phase 4 已完成。

**主要位置**

- Workflow durable event/checkpoint/lease/idempotency modules
- `lib/session-import/registry.ts`
- `lib/session-import/adapters/*`
- `lib/claude/replay.ts`
- desktop Dexie/headless persistence adapter

**工作**

1. 定义 canonical session/run/turn/tool/permission/checkpoint schema。
2. 把现有 import adapters 扩为双向 codec 能力声明；不保证所有 runtime 都能 materialize。
3. 输出 fidelity/loss report：
   `native-exact | structured | contextual | summary-only | unsupported`。
4. canonical log 缺失/损坏时，可从可信 runtime artifact 重建；反向 materialize 只调用公开
   runtime API。禁止伪造 Claude 私有 JSONL。
5. `RecoveryPlanner` 比较 canonical/runtime/checkpoint/import candidates；仅严格占优时自动
   恢复。
6. tool、permission 或副作用冲突一律 `recovery_required`；禁止 last-modified-wins。
7. route/host/model binding 保持 pinned；ticket 只按相同 spec 重签。

**验收**

- Claude Code/Codex/OpenCode fixture 能导入 canonical 并给出 fidelity；
- 可支持的 canonical history 能物化为另一 runtime session；
- 不支持的 exact resume 返回 structured loss/unsupported，不伪装成功；
- approval 永不恢复成 allow；
- canonical/runtime 分叉且有 tool side effect 时始终暂停。

### Phase 9 — 收尾与兼容层退役

**依赖**: 全部调用方迁移完成，有遥测证明旧入口低于退役阈值。

**工作**

1. 删除 provider-id runtime dispatch。
2. 将 `claude-host.mjs` 兼容入口变为薄 wrapper，最终由发布节奏决定是否删除。
3. 根据 telemetry 分阶段移除 `claude_set_*` writer 与旧 event subscription。
4. 清理 duplicate budget/fallback/provider relay writer，保留数据 migration reader。
5. 更新用户文档、管理员 headless 配置、兼容矩阵和 troubleshooting。

**验收**

- runtime selection 只有 resolver 一个 authority；
- Gateway route selection 只有 ticket/live ordinary route 两条清晰路径；
- repo 搜索没有新增 provider-name special case；
- compatibility aliases 有明确删除版本或长期支持说明。

## 5. 依赖关系与并行边界

```text
Phase 0 contracts
  +--> Phase 1 profiles --> Phase 2 Gateway ----+
  |                                             |
  +------------------> Phase 3 Agent Host ------+--> Phase 4 vertical slice
                                                      |
                                                      +--> Phase 5 certification
                                                      +--> Phase 6 caller migration
                                                               |
                                                               +--> Phase 7 Teams
                                                               +--> Phase 8 recovery
                                                                       |
                                                                       +--> Phase 9 cleanup
```

可并行范围：

- Phase 1 profile store 与 Phase 3 adapter/event contract 可在 Phase 0 后并行，但不能同时修改
  `agent-config-types`；由 Phase 0 owner 先冻结导出。
- Phase 2 Rust Gateway 与 Phase 3 Node host 可并行，使用冻结 ticket/spec schema。
- Phase 7 Team 与 Phase 8 codec 可在 Phase 6 后并行，但共享 identity/event schema 不得各改一份。

建议 ownership：

| owner                  | 文件边界                                                       |
| ---------------------- | -------------------------------------------------------------- |
| Contracts              | `packages/agent-config-types`、resolver、compatibility schema  |
| Provider control plane | `packages/provider-*`、settings/Dexie/headless profile store   |
| Gateway                | `crates/cognia-gateway`、Tauri/headless Gateway host wiring    |
| Agent Host             | `sidecar/*`、`src-tauri/src/claude/*`、capture/handle adapters |
| Orchestration          | Team/Workflow callers、budget/delegation                       |
| Recovery               | Workflow persistence、session import/codecs                    |

共享文件在进入并行实施前指定单 owner；其他 owner 通过已冻结类型消费，避免交叉改写。

## 6. 迁移与回滚

### 6.1 配置迁移

| 旧字段/行为                 | 新表达                                   | 兼容方式                            |
| --------------------------- | ---------------------------------------- | ----------------------------------- |
| provider id 决定 runtime    | `runtimePolicy` + compatibility resolver | legacy reader 推导，new writer 禁止 |
| `proxyMode`                 | `routePolicy` + deployment transport     | 映射后保留原值用于 rollback         |
| `*-anthropic` provider      | deployment + Anthropic transport profile | legacy deployment alias             |
| `claude_set_*`              | generic Agent Host/profile commands      | compatibility command adapter       |
| `toolsEnabled/requireTools` | execution kind/requires/fallback policy  | 按 Phase 6 映射                     |
| runtime-specific session id | canonical ids + `runtimeBinding`         | import/migration adapter            |

### 6.2 发布顺序

1. 先发布 reader/schema + shadow resolver。
2. 发布 dual-write profile migration，旧 reader 继续工作。
3. 发布 headless Gateway/Agent Host，但 flags 默认关闭。
4. 开启内部 vertical slice 与 CI conformance。
5. desktop canary → headless canary → explicit experimental users。
6. 只有 certification 稳定后才允许 `auto`。
7. caller 逐类迁移，最后删除旧 writer。

### 6.3 回滚

- 每个 phase 的 flag 可独立关闭；
- profile migration 在确认旧 reader 退役前保留旧字段；
- Agent SDK/Gateway/manifest 作为一个认证 bundle 回滚；
- ticket path 关闭后回到普通 Gateway/旧 direct path，但不得把已经开始的 session 静默迁移；
- session 恢复必须读取原 execution fingerprint，无法满足则暂停而不是换轨。

## 7. 测试与质量门禁

### 7.1 单元与集成

- TypeScript 新增/修改的 `lib/**`、`components/**`、`hooks/**` 必须 co-located tests。
- Rust 修改在同文件 `#[cfg(test)]` 或 crate integration test 中覆盖。
- Gateway fixture 同时覆盖同协议与跨协议、buffered 与 SSE、success 与 error。
- Agent Host 测试必须包含并发 env isolation、command idempotency 与 event ordering。
- Team 测试必须包含异构 runtime、pool、深度、预算、permission ceiling 与 retry ownership。
- Recovery 测试必须包含冲突、损失报告、stale ticket 与副作用 unknown。

### 7.2 必跑命令

按改动范围选择 targeted test，合并前运行完整门禁：

```bash
rtk pnpm test
rtk pnpm test:coverage
rtk pnpm typecheck
rtk pnpm lint
rtk pnpm lint:i18n
rtk pnpm build
rtk pnpm docs:build
rtk cargo test -p cognia-gateway
rtk cargo test --manifest-path src-tauri/Cargo.toml
```

Sidecar 使用其现有 Node test 命令与真实 Agent SDK live harness；不要用 mock-only 结果声明
vertical slice 完成。Tauri command/host 改动需要 `tauri-smoke`。headless 必须运行真实
`cognia-server` + Gateway + Agent Host smoke。

### 7.3 专项审计

实现阶段结束前运行：

- `pii-gate-auditor`：新增/改道 LLM 与 embedding outbound path；
- `tauri-rust-reviewer`：Gateway/host state、async lock、command registration 与 capability；
- `wiring-auditor`：新 resolver、host、GatewayState、adapter 是否真实接线；
- `test-gap-auditor`：co-located test 与 coverage；
- `static-export-auditor`：前端新增 route/import 是否破坏 static export；
- `i18n-reviewer`：配置 UI 与双语 key。

### 7.4 完成定义

不能只以“测试通过”关闭需求。必须提供以下证据：

- runtime/route/spec trace 显示冻结决策；
- desktop 与 headless 同一 conformance case 结果；
- Gateway ticket、credential lease 与 model binding 可审计但无 secret；
- capability 不满足时 fail-before-spend；
- crash/restart 后 identity、budget、permission 与 route 保持；
- Team 异构执行与默认两层委派有效；
- 旧配置迁移与回滚已实测。

## 8. 已知实施风险与 spike 门

### R1 — Claude session materialization API

**[UNVERIFIED]** Agent SDK 0.3.183 对“由 canonical history 创建可继续原生 resume session”的公开
能力可能不足。Phase 8 前先验证公开 API。若无支持，只允许 contextual replay/new session，
并准确报告 fidelity；不得写私有 Claude JSONL。

### R2 — Gateway same-protocol header/error parity

**[CONFIRMED]** 当前 handler 丢失部分 inbound semantic header，错误 body 会被 Gateway 包装。
Phase 2 必须先建立 golden fixture，避免在“安全过滤”名义下过度透传敏感 header，也避免继续
破坏 Claude Code 的 capability/error matching。

### R3 — snapshot authority migration

**[CONFIRMED]** 当前 snapshot 由 renderer 发布。迁移到共享 profile projection 时，短期可能
出现 dual publisher。必须以 profile version/CAS 明确 authority，禁止最后写入者获胜。

### R4 — credential failover 与副作用边界

**[CONFIRMED]** Gateway 当前 key pool 是 per-request rotation。Agent session 改为 sticky 时，
必须区分“尚未收到响应字节”与“工具/模型可能已产生副作用”。401/403 默认不切账户；所有
failed providerAttempt 都计入预算。

### R5 — `auto` 误把 relay 当 native

**[CONFIRMED]** catalog 当前广泛使用 `family: "anthropic-native"`。在 compatibility 字段上线
前，`auto` 必须保持旧行为或禁用新选择，不能把 family 直接当认证证据。

## 9. 第一张可执行 issue 切分

为降低首批并发冲突，建议先创建以下独立 issues：

1. **Contracts** — 增加 policy/spec/capability/identity schema 与 legacy mapping tests。
2. **Shadow resolver** — 只记录 decision，不改变执行。
3. **Provider profile migration design** — migration fixture 与 redacted round-trip，暂不改 UI。
4. **GatewayHost seam** — 在 Tauri 行为不变的前提下提取 host port。
5. **Gateway transport golden tests** — 先写 header/error/SSE failing fixtures。
6. **Agent Host runtime adapter seam** — 保持旧 command 行为，仅去除 provider-id 内部分支。
7. **Canonical event envelope adapter** — 从 `CaptureStreamEvent` 演进并兼容旧 consumer。
8. **Conformance server** — 独立 test fixture package/process，无 vendor-specific code。

以上八项完成并合并 schema 后，再开启 route ticket、headless Gateway 与 vertical slice 的实现
issues。这样可以先固定边界，避免多个 owner 同时在 Gateway、sidecar 和 Team 中发明不同
版本的同一概念。
