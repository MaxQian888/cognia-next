# Codex 原生子代理按次选模与已有子代理模型控制方案

状态：Draft / 待评审；仅调查与方案，未实施。日期：2026-10-21（Asia/Shanghai）。作者：Codex。

深度：Heavy。范围：Codex integration、共享契约、外部智能体 manager、任务网关、CLI/materializer、Host/配对设备、现有子代理 UI。评审角色：Agent integration、Gateway/Rust、Frontend、Host、QA。交付顺序按依赖，尚无团队工期承诺。

**建议保留 Codex 自动选择的多代理后端，先补会话能力与原生子代理身份，再开放派生时模型选择；已有子代理切换仅在确认可直接控制的 V1 会话中提供实验入口。** V2 已有子代理受上游所有权限制，界面明确解释，不能用重建或 fork 冒充同一子代理切换。

当前 Cognia 没有全局固定使用 V1 或 V2。已知模型目录可使新任务采用 V2，自定义目录回退项可能采用 V1，恢复任务还受历史记录影响。`0.159.2` 的完整运行配置默认暴露 `spawn_agent.model`；原生通道的按次选模可能已经可用，缺口主要是受控候选集合、结果归因和已有 child 的控制链路。

本机没有运行中的 Cognia 桌面进程，agent-debug bridge 不可达；不能把本次推断写成对某个活跃产品会话的最终判定。默认原生配置使用 `gpt-6.1-sol`，其目录为 V2，因此该默认下的新原生会话预期为 V2。

## 1. 本方案聚焦原生 child 控制，复用现有模型与网关计划

用户要求：确认 Cognia 现在实际使用的 V1/V2，给出派生时动态选模型、已有子代理切换模型的具体接入方案和缺口。

已有 [统一模型目录与任务网关方案](./2026-10-20-subagent-model-catalog-gateway-unification.md) 覆盖多 runtime slot/default。本文件单独记录随后验证出的 V1/V2 所有权、当前 turn 设置和 child 身份问题，避免把更大方案整体改写成另一条工作流。它不创建新的 subagent engine、配置数据库或网关服务。

关联：[ADR-0217](../content/docs/en/adr/0217-agent-integrations-are-packages-behind-host-ports.md)、[ADR-0216](../content/docs/en/adr/0216-each-agent-configuration-keeps-its-own-state.md)、[ADR-0064](../content/docs/en/adr/0064-external-cli-backed-subagent-dispatch-completion.md)、[ADR-0090](../content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md)。

术语约束：

- **原生 child**：Codex 自己的 `spawn_agent` 创建的线程；父子关系由 Codex 证明。
- **Cognia 外部子任务**：Cognia 派发并运行整个 Codex 会话；与原生 child 分开记账和控制。
- **按次选模**：父模型在一次原生 `spawn_agent` 中显式选择模型；不是任意时刻修改全局默认。
- **当前 turn 切换**：同一 child、同一 turn 的下一次模型调用采用新设置；已经发出的请求不会被改写。
- **后续 turn 切换**：更改该 child 后续轮次的默认设置；与当前 turn 切换是两个操作。
- **允许集合**：一个网关任务已获准使用的模型集合；不是任意 provider 的所有模型。

## 2. 当前事实支持“按模型及会话选择”，不支持统一贴 V1/V2 标签

### 2.1 已确认的产品代码与本机观察

| ID  | 状态      | 事实与边界                                                                                                                               | 证据                                                                                   |
| --- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| F01 | Confirmed | 当前检查时没有 Cognia 桌面进程；debug endpoint 存在但不可达                                                                              | `ps` 进程名检查；`node scripts/tauri/agent-debug.mjs status` 返回 `bridge_unavailable` |
| F02 | Confirmed | 可读取的 legacy localStorage 有两个已启用 `codex app-server` 配置，未设网关绑定或后端参数；其中一个为 isolated smoke 配置                | 只读 SQLite 查询并白名单提取；这些旧缓存不是当前账号 revision/head 的权威证据          |
| F03 | Confirmed | 本机共享原生配置默认 `gpt-6.1-sol`，没有显式多代理 feature 覆盖；目录中该模型和 `gpt-6-luna` 为 V2，`gpt-5.6-luna` 为 V1                 | 只读解析共享 config/model cache；未读取或输出凭据                                      |
| F04 | Inferred  | 使用 F03 默认值的新共享原生会话预期为 V2；不能由此判断恢复会话、isolated 配置或远端 Host                                                 | Codex 的配置 → 已记录/继承版本 → 模型目录 → 默认 feature 解析链                        |
| F05 | Confirmed | Cognia gateway projector 不写 `multi_agent_v2` 或 `step_model_switching`；Codex 当前只有 `subagent.default` 一个角色 slot                | `gateway-task.ts`、`model-slots.ts`                                                    |
| F06 | Confirmed | 私有 Codex 目录保留已知 slug 的 bundled `multi_agent_version`；未知 slug 回退项为 `null`                                                 | CLI `codex-model-catalog.ts` 与 Rust `codex_catalog.rs`                                |
| F07 | Confirmed | adapter 已请求 experimental API，但丢弃 `model/list.multiAgentVersion`；thread 摘要也未保留 `canAcceptDirectInput`、父线程身份等控制事实 | `app-server-client.ts` 的 model/thread mapper                                          |
| F08 | Confirmed | collab 原生事件主要被映射成 tool 活动；没有完整 child registry、作用域模型切换和确认链                                                   | 同文件 `CodexThreadItem`、`handleItemStarted/Completed`                                |
| F09 | Confirmed | `setSessionModel` 更新本地 metadata，下一次 `turn/start` 才携带；未调用两个 settings/update 接口                                         | 同文件 `setSessionModel`、`startTurn`                                                  |
| F10 | Confirmed | 共享模型角色契约只接受 `version:1 + slots`；不能直接塞 allowed-model 数组，normalizer 会拒绝未知字段                                     | `packages/agent-contracts/src/model-binding.ts`、`external-agent.ts`                   |
| F11 | Open      | 当前账号 canonical config head、具体活跃 child 的实际后端尚未取得                                                                        | 当前产品未运行；未把旧 localStorage 或 Codex Desktop 自身会话冒充 Cognia 会话          |

检查最近 300 个共享 Codex rollout 的 originator 未发现 Cognia；该有界检查不证明历史上从未运行过。未对全部账号历史做内容检索。

### 2.2 三个真实 CLI / loopback 场景明确了能力边界

本机二进制为 `codex-cli 0.159.2`；上游源码固定 `rust-v0.159.2`，另检查 main 的直接输入策略。使用独立 `CODEX_HOME`、合成模型元数据、本地 Responses fixture；没有真实供应商推理。

| 场景          | 后端来源                                         | 结果                                                                                                                |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| V1 child      | 合成目录声明 V1                                  | 同一 child/turn 中 `probe-child/low → probe-switched/high`；live 返回 `applied`；future update 和下一轮开始均被接受 |
| V2 child      | 显式强制 V2 并暴露模型覆盖                       | 成功派生不同模型；live/future/turn-start 三种 child 直接操作都返回 `-32600` 所有权拒绝                              |
| auto-V2 child | 目录为 V2；未强制启用 V2，未显式配置模型字段暴露 | 仍使用 V2；spawn schema 自带 `model/reasoning_effort`；child 直接操作仍被拒绝                                       |

重要更正：`SpawnAgentToolOptions::default()` 的局部 false 不是运行默认值。`MultiAgentV2Config::default()` 在 `0.159.2` 中把 `expose_spawn_agent_model_overrides` 设为 true。不能把“打开该开关”列为当前版本必需的修复。

可提交的脱敏结果：[probe.json](../reports/2026-10-21-codex-subagent-model-probe.json)。复现脚本与完整生成 schema 在 `.cache/research/codex-subagent-model-2026-10-21/`。V1 fixture 主动注入了 deferred 原生 spawn 调用，验证后端执行，不验证模型自主发现工具的能力。三个实验为便于观察把合成模型的 `tool_mode` 改为普通 function-call 模式；原模型的 code-mode 工具暴露及 model-owned schema override 仍须在 P0/P5 单独验证，不能由本实验直接宣称产品工具字段已全面验收。

## 3. 交付目标按“创建时选择”和“控制已有 child”分别验收

| 目标 | 用户结果                                                          | 验收         |
| ---- | ----------------------------------------------------------------- | ------------ |
| G1   | 看见当前会话的后端证据和每个 child 的可控范围；未知状态明确显示   | V01–V03      |
| G2   | 父模型可为不同原生 spawn 选择已授权集合中的不同模型，保留默认继承 | V04–V06      |
| G3   | 在允许直接控制的 V1 child 上，分别修改当前 turn 或后续 turn       | V07–V10      |
| G4   | V2 child、旧版本、失效 turn、过旧 Host 不出现虚假成功             | V09–V12      |
| G5   | 本地、网关、Host 路径保持账号、预算、PII 和恢复边界               | V06、V11–V15 |

本轮不承诺：已有 V2 child 保持身份的模型切换；把另起 child/fork 显示为原地切换；跨 provider/account；中途扩大活动网关任务的模型集合；强制把所有模型改成 V1；手动逐 token 替换供应商流。

## 4. 能力探测先于操作，后端标签只做解释

扩展已有 Codex model/thread mapper 与可选能力契约，不以 `instanceof` 或模型名字判断权限。沿用 `codexAppServerExtension` 承载 vendor 参数，manager 向 UI/Host 提供窄的规范化调用。

每个 root/child descriptor 至少携带：`agentConfigId`、`configRevision`、运行进程 generation、`rootThreadId`、`nativeThreadId`、`parentThreadId`、`activeTurnId`、模型/effort、`canAcceptDirectInput: boolean|null`、网关 plan fingerprint，以及能力的证据和观察时间。后端为 `v1|v2|disabled|unknown`，证据注明 `recorded|observed-tool|inferred-model`。

证据优先级：已有会话的版本记录/原生工具形状 > 当前模型目录推断。`canAcceptDirectInput=false` 是直接控制禁令；root 的 true 不能反推其后端是 V1。Thread schema 没有独立 `multiAgentVersion` 字段，不发明它；`model/list.multiAgentVersion` 是模型信息，不能伪装为会话最终版本。

能力分别表示 `spawnModelOverride`、`switchCurrentTurn`、`switchFutureTurns`，取 `supported|unsupported|unknown` 并附原因。读取 `config/read` 的 feature 白名单、真实 `model/list`、`thread/read` 与已认证 schema/二进制证据；最终工具暴露还要覆盖 code-mode 及 model-owned schema override，不以配置默认值代替实际参数面。不为了探测而发送模型修改。方法缺失按 optional-method 机制缓存；认证错误、超时、策略拒绝不能缓存成“永久不支持”。缓存键含 Host、二进制身份、进程 generation 与目标线程。

升级启动时的目录支持不能推导为恢复旧线程自动换后端。保持用户会话的现有后端；诊断页同时展示 CLI 版本、目录来源、会话证据和可用操作。

## 5. 派生时由 Codex 原生工具选择模型，网关提前授权有限集合

### 5.1 原生账号通道复用已有 tool surface

保留模型实际目录与原生 `spawn_agent`；按版本解析最终配置，只有明确隐藏模型字段且产品配置要求开放时才写受控 override。不要无条件强制 `multi_agent_v2=true`。保留模型/后端兼容性和 reasoning-effort 校验。

让父模型知道可选的真实 model ID、对应支持档位和默认行为，指令经现有执行入口/PII gate 下发。用户明确要求某次派生用 B 时，父模型在原生参数中选择 B；生成后记录 requested/resolved。模型没有遵从时显示实际结果，不能把提示词当作强保证。

当前 App Server 没有本方案可直接复用的“宿主替父模型执行一次任意 native spawn”接口。因此 UI 第一阶段提供“默认值、允许集合、发给父代理的选模要求”，不伪造一个确定执行的 native-child 创建按钮。命名角色文件可作为后续确定角色配置，但不能绕过本次允许集合。

### 5.2 网关通道扩展现有 role-policy，区分默认模型与允许集合

建议把 `AgentModelRoleOverrides` 扩展为 V1/V2 union：V1 保持原样；V2 增加 `allowedSpawnModels`（规范化 Cognia bindings）。空或未设置代表旧的已编译模型集合，不代表无限制。显式集合按“调用层 → 模板层 → 配置层”取最高有效层，采用替换语义而不是无界 union。

编译不变量：`plan.models = primary ∪ resolved slots ∪ allowedSpawnModels`，去重且最多 32 个；显式集合必须包含默认 child 的模型。所有 binding 必须落在主任务同一 provider/account。原生账号通道不消费网关 bindings；其候选目录来自原生 `model/list`。

提高内部 `TaskModelPlan` 的指纹格式版本，令允许集合及模型控制策略进入 fingerprint。无需增加第二份持久化模型表。现有 `GatewayTaskModelPlan.additionalModels/modelBindings` 已能表达更多同 deployment 模型，首阶段不扩展 Rust 票据的授权语义。

目录与授权必须一起生成：

```text
Agent/Template settings ──> Manager admission ──> Frozen task model plan
                                                  ├─> Codex private catalog
                                                  ├─> Existing strict route ticket
                                                  └─> Codex native spawn + child controls
                                                          │
Native child facts + gateway observations <────────────────┘
                │
                └─> Existing runtime store / subagent UI
```

一个任务允许 A/B/C，不意味着有三个 provider credential；沿用一个账号、一个租约及共享请求/token预算。更换允许集合需创建新任务；集合内的按次选择不重新签发票据、不改 plan fingerprint。拒绝未授权目标时不自动改成主模型。

Codex catalog 的生成条件从“设置了 child slot”扩展为“任务需要受控候选集合”，覆盖仅设置 allowlist 的情况。CLI 与 Rust materializer 同步，继续使用 vendored model template；不修改 `multi_agent_version` 来规避 V2 限制。

## 6. 先登记真实 child，再发送有作用域的模型操作

### 6.1 child registry 沿用现有 store，不创建假生命周期

扩展 `CodexThreadItem`，保留 `senderThreadId`、`receiverThreadIds`、模型、effort、状态与父子身份。当前只保留 `agentsStates` 不够。结合 `thread/started`、collab 结果、`thread/list` 的 ancestor/source filter 和 `thread/read`，维护可验证的 child 关系。

V2 的子任务可以只表现为工具结果/任务路径，不能仅依赖 V1 collab item。对未落盘 child，使用受控的 `thread/loaded/list` + `thread/read` 作为发现补充，再按 parent/root 精确过滤。不能把整个进程里其他会话的线程暴露到当前聊天。分页、去重、generation、上限和事件驱动刷新属于同一 registry owner；不在 UI 每帧轮询。

投影到现有 `subagent-runtime-store` 时以 `(runtime instance, nativeThreadId)` 作为外部身份，保留 root chat 关联。只观察到路径但未取得线程身份时可展示只读节点，控制保持 unknown。Cognia 外部子任务不改造成原生 child。

### 6.2 用窄请求表达当前或后续作用域

拟议请求字段：`rootThreadId`、`nativeChildThreadId`、`scope: current-turn|future-turns`、`expectedTurnId`（current 必填）、`modelId`、可选 `reasoningEffort`、`operationId`、`expectedProcessGeneration`、`expectedPlanFingerprint`。

manager/Host 先校验调用主体、配置 revision、所属设备/账号、真实父子关系、允许集合和能力。adapter 映射如下：

| 作用域         | RPC                      | 前置条件                                                                                         | 成功语义                                         |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `current-turn` | `turn/settings/update`   | 已知活跃 child turn；允许直接输入；experimental API；`step_model_switching` 开启；目标元数据兼容 | `applied` 表示后续步骤采用新设置；不修改未来默认 |
| `future-turns` | `thread/settings/update` | 允许直接输入；方法受支持；目标合法                                                               | 更新后续默认，不启动新 turn，不改变当前 turn     |

不复用当前 `setSessionModel` 充当实时操作，也不通过 `turn/start` 意外重启 child。第一次只提供单一作用域，不把两次 RPC 包装为原子的“当前和以后全部切换”。

`step_model_switching` 增加受控 typed opt-in，放在 `CodexAgentOptions` 所拥有的 Codex 专属配置中。gateway projector 显式生成该安全字段，沿用现有 raw config allowlist；不放开任意 `features.*` 或任意 `[agents]` JSON。

### 6.3 结果、并发和断线不能伪装成成功

状态：`requested → pending → applied-awaiting-step | rejected | target-unavailable | outcome-unknown`；若有可信执行观测，再从 awaiting-step 进入 `observed`。UI 保留作用域、之前值、请求值、受理值和已观测值。

- 仅在原生确认后更新 applied 状态；不能先乐观更新“当前实际模型”。
- current turn 的已发请求仍使用旧模型。`thread/read.model` 描述配置，不等于每个 step 的推理遥测。
- 切父线程不连带修改已经存在的 child。
- 每个 child 串行处理设置请求；current 操作绑定准确 turn ID，turn 结束或 generation 改变立即失效。
- 断线后请求结果未知，不自动重放 current 操作到新 turn；重连读取状态，必要时由用户重新操作。
- 原生没有 `operationId` 幂等字段；Host 在现有操作/idempotency 边界去重，相同 ID 不同 payload 拒绝，不能宣称底层 exactly-once。
- V2 child 在 RPC 前依据 capability 禁用；若服务端仍返回直接输入拒绝，原样归类为 `direct-input-forbidden`，不尝试其他方法绕过。
- 目标模型改变 node REPL/工具限制等已准入不变量时，保留原生拒绝。不得把“同 provider”当作模型之间必定可切换。

## 7. UI 复用现有设置与子代理视图，明确展示能力和作用域

设置页：在 `CogniaModelPicker`、`RoleModelFields` 与 Codex 配置区域增加“默认子模型 / 可选模型集合 / 实验性当前 turn 切换”。默认自动后端，不提供无证据的“强制 V1”捷径。

运行页：在原生 child 的已有视图中显示实际模型、证据状态和可用作用域。V1 可控节点提供两个清楚命名的动作；V2 显示“此原生子代理由父代理管理，当前不支持直接切换已有子代理模型”，仍可给父代理后续派生选模要求。

旧 runtime/Host、未连接、未知 child、只读导入历史、无合法模型、没有 active turn 分别提供原因。current 动作在 turn 结束后取消 pending；focus、键盘、加载状态和 aria 全部通过现有 primitives 实现。用户文案写 split en/zh-CN 源文件，不直接改生成 JSON。

## 8. Host、ACP 和旧客户端显式协商，不能透传任意 vendor RPC

本地 native app-server 作为首个交付路径；随后沿 `remote-run-client.ts` / `remote-run-service.ts` 的现有 session-operation 分发扩展同一窄操作。Host capability manifest 独立协商“模型策略 V2”和“native child control”，不能沿用旧 model-plan 支持位宣称新操作可用。

Host 把 root session stamp 与 child 绑定，校验 owner/account/device/config lifecycle generation；客户端不能提交其他聊天 child ID。沿已有 process/agent invoke 权限，不新增通用任意 RPC command，不扩大 Tauri filesystem ACL。

ACP：默认值和任务私有目录继续复用现有 `CODEX_CONFIG` projector；不能由“ACP 支持 session/set_model”推导“可控 Codex 内部 child”。现有桥接没有受认证的原生 child 控制扩展，因此已有 child 切换标为 unsupported。未来只有桥接提供明确 typed vendor capability 并通过相同实验后才启用；当前提供选择 native app-server 的可行路径。

V1 role-policy 数据原样读取；V2 仅在所有实际执行端支持后允许保存。旧 normalizer 会拒绝新版本，因此旧客户端不得静默读取并覆盖新配置；沿现有不可变 revision/CAS 保留 raw revision，提示升级。备份、同步、插件定义和模板 normalizer 都保留或明确拒绝新版本；不能丢失 allowlist 后以更宽授权运行。

暂不增加 Dexie table/index/schema version；持久配置仍在既有 head/revisions。若实施发现 JSON schema/备份版本需要提升，必须在相应 owner 完成迁移与兼容测试，不能只改 TS interface。

## 9. 账号、PII、授权与成本保持现有执行边界

更换模型不增加工具/文件/网络权限；role restrictions、parent ceiling 与 lease 仍生效。模型和 effort 是非秘密标识，日志不保存 prompt、token、header 或完整 native config。

原生账号通道受 Codex 自身认证与目录约束，不声称具有 Cognia gateway ticket 的强 allowlist。若产品要求强制限制每个 native 请求，只在网关通道交付这项保证；用提示词约束原生模型选择不是授权机制。

网关继续使用 strict selector、单 provider/account 与已冻结模型集合。父代理选模说明经原有执行服务与 PII gate；已有 child 设置控制只传 ID/effort，不新增内容出站旁路。后续模型请求依旧经过原有网关 PII 路径。

使用现有 request/token budget；新增候选模型可能提高单位成本，在准入展示所选模型成本差异，真实供应商验收前验证按最终模型计费。当前未测得新方案的费用或性能收益，不声称更便宜。

## 10. 可观测性与资源限制围绕模型操作，而非用户内容

结构化日志：`codex.native_child_discovered`、`codex.child_model_change_requested`、`accepted`、`observed`、`rejected`、`outcome_unknown`。日志关联 operation/task/root/child/turn/plan fingerprint；这些高基数字段仅进入受控诊断日志，指标标签只用 backend、scope、route、outcome。

网关可从受控 Codex 请求 metadata 提取白名单 thread/turn ID 关联 actual upstream model；没有关联证据时保持 unobserved。不能把 `Thread.model` 或按钮选择值写为实际推理模型。

设计上限：每任务最多 32 个模型（沿现有 gate）；child registry 活跃条目建议上限 128，终态按现有会话保留策略清理；分页 size 50；仅在运行页订阅、事件缺口或重连时做有界 reconciliation。128 为 Proposed target，QA 需验证合理性，超限不截断成可控但错绑的节点。

每 child 同时最多一个修改 RPC；控制操作超时建议 10 秒、UI 元数据刷新去重，不自动发额外 LLM 调用。目标而非实测：无状态变更时零周期性设置 RPC。任何一次错误 root/child/account 关联、未授权模型请求或虚假 applied，立即停用控制入口并排查；V2 拒绝是预期能力结果，不作为服务故障报警。

## 11. 分阶段工作包明确 owner、复用路径与退出条件

| 包                | 唯一负责角色      | 主要修改位置                                                                                                                                   | 依赖 / 独立退出条件                                        |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P0 能力与身份     | Agent integration | `packages/agent-codex/src/app-server-client.ts`、`history.ts`、`manifest.ts`；共享 `session-operations.ts` / optional adapter capability       | 保留模型/线程事实，建 child registry；V01–V03；不写模型    |
| P1 候选模型策略   | Contracts/Host    | `model-binding.ts`、`external-agent.ts` normalizer、`model-plan.ts`、agent/template/Host config 与 plugin API 验证                             | P0；V1/V2 policy兼容、CAS与备份；V04、V06、V11             |
| P2 派生与网关投影 | Gateway/Rust      | `gateway-task.ts`、CLI `codex-model-catalog.ts` / `gateway-task.ts`、Rust `codex_catalog.rs` / `gateway_task.rs`、三条 lease TS owner          | P1；同任务 A/B/C 目录及 strict ticket 一致；V04–V06        |
| P3 V1 模型控制    | Agent integration | Codex adapter/typed extension、`manager.ts`、共享 operation types                                                                              | P0/P2；current与future独立、未知结果与拒绝；V07–V10        |
| P4 UI / Host      | Frontend/Host     | `role-model-fields.tsx`、agent/template/Host editor、现有 session/subagent UI、`agent-runtime-store`、remote-run client/service、Host manifest | P0–P3；双语 UI 与配对 capability；V11–V13                  |
| P5 认证与文档     | QA                | 原生 CLI fixtures、相关 co-located tests、Playwright、real Tauri/Host 与支持矩阵                                                               | 前述包；V01–V15；真实凭据请求另验，不复用本次 loopback结论 |

vendor 细节留 `@cognia/agent-codex`；共享契约只放动作/描述类型和守卫，manager 不导入 vendor class。优先扩展现有文件；仅当 adapter 进一步拆分 child registry 有两个独立消费者、且主文件复杂度确实下降时新增 helper，必须有可达调用与同目录测试。

当前 catalog 把 Codex `>=0.149.0` 列为支持范围，认证列表为 `0.150.1`；这不认证新增接口。本次 `0.159.2` 是候选验证版本，不能直接把整个版本段设为支持 live switching。新 feature 独立记录二进制/版本/schema证据，旧版本保持已知功能。

## 12. 验收用真实身份、真实请求字段与拒绝行为证明

| ID  | Given / When / Then                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| V01 | 新线程使用 V2 模型元数据且无强制 V2 开关 → 观察 V2 工具；UI 不因为 feature false 显示 V1                                         |
| V02 | 已知 V1、未知回退模型、disabled配置 → 各自按真实解析，unknown 不伪装 supported                                                   |
| V03 | 恢复旧 V1 或 V2 历史后换主模型 → 保留会话后端证据，不以新模型覆盖 recorded事实                                                   |
| V04 | 同一父任务两次 spawn 分别指定 B/C → 两个真实 native child 的请求模型正确，默认继承仍可用                                         |
| V05 | 仅配置 allowedSpawnModels，未显式设置 child default → 私有目录和允许集合仍完整生成                                               |
| V06 | 网关允许 A/B/C → 三模型精确可达；D、跨 provider、跨 account、别名包含串线均拒绝；同租约预算不重置                                |
| V07 | 可控 V1 child 在工具边界等待，修改 current → 相同 thread/turn 下一请求用 B/high，未来默认不被偷改                                |
| V08 | 修改 future → 当前步骤保留 A，下一轮用 B，不会意外启动额外轮次                                                                   |
| V09 | V2 child 请求任一直接控制 → typed unsupported/原生拒绝；原模型不变，无重建冒充，无自动绕行                                       |
| V10 | turn结束、取消、generation变更、metadata不兼容、重复operation、断线未知 → 不错改其他turn，不虚假成功，不盲重放                   |
| V11 | 旧 Host/旧客户端/旧 plugin 与 V2 policy → 明确升级或拒绝，配置不丢字段、不扩大allowlist                                          |
| V12 | thread/read 不能证明 step actual → UI 区分 accepted与observed；只有网关/原生可信遥测才显示已观测                                 |
| V13 | ACP内子代理、只读导入、未知child、配对离线 → 控制禁用原因正确，普通会话选模仍可用                                                |
| V14 | 新增父代理选模指令与后续模型请求 → 继续通过既有PII/权限/预算路径，没有新fetch/SDK旁路                                            |
| V15 | macOS real Tauri本地及一个paired Host → root/child归属、模型控制、取消/重连、i18n与键盘路径可验；Windows/Linux进入原生fixture CI |

实施时按 owner 跑 `pnpm test --runInBand --runTestsByPath <受影响测试>`，Rust 跑 `cargo test -p cognia-gateway`、`cargo test -p cognia-sandboxd` 对应 filtered tests；涉及 CLI 运行 owning workspace 测试。合并门包括 `pnpm typecheck`、`pnpm lint`、格式、静态导出和受影响真实流；i18n 修改跑 build/build:check/lint。未请求 coverage，本次不运行 coverage。

本次已运行：前序 4 个配置/UI suite 共 183 tests及 1 snapshot通过；V1/V2 native fixture 断言通过；本轮 auto-V2 断言通过。上述不替代未来方案实现测试。此次仅新增文档与脱敏证据，未运行全量 typecheck/build，也未完成 real Cognia UI 或真实供应商验收。

## 13. 发布先只读，再派生，最后实验控制；回滚不改变会话身份

顺序：P0只读诊断 → P1/P2受控按次选模 → P3/P4单机V1 opt-in → Host配对 →认证后扩大。旧配置保持其现有语义；不自动迁移会话后端或把用户的自定义模型伪装成V1。

kill switch关掉控制写入口与可选实验feature，不终止已有child、不回滚已发送模型请求、不改写原生历史。角色策略V2已有数据保持可读/只读；降版不能静默清掉允许集合再执行。已进入unknown的操作保留诊断记录，重连只做读确认。

## 14. 评审决策与待验事实均有明确负责角色

| 决策            | 选项                                  | 建议与代价                                                           |
| --------------- | ------------------------------------- | -------------------------------------------------------------------- |
| Q1 后端策略     | 自动保留 / 强制V1以换取控制           | 自动保留；V2已有child不提供切换。避免牺牲模型原生协作语义            |
| Q2 派生选模保证 | 父模型原生参数 / 新建独立Cognia child | 本方案交付前者；清晰反馈requested/resolved，不把提示词承诺成确定创建 |
| Q3 强allowlist  | 所有原生账号 / 网关任务               | 只保证网关强执行；原生目录与账号原生约束如实标注                     |
| Q4 V1 live开关  | 默认启用 / opt-in                     | opt-in并按实际版本能力启用；先保证future/current作用域清楚           |
| Q5 允许集合变更 | 活动任务扩容 / 新任务                 | 新任务；本轮复用既有租约，不增加并发重签授权复杂度                   |

| 待验项                      | 单一负责角色      | 拟定复核日期（非交付承诺） | 退出条件                                                             |
| --------------------------- | ----------------- | -------------------------- | -------------------------------------------------------------------- |
| 实际目标Cognia会话后端      | Agent integration | 2026-10-22                 | 产品运行后读取当前canonical config/head与root/child事实；替换F11未知 |
| 原生版本认证与candidate目录 | QA                | 2026-10-23                 | 真实目标二进制/schema通过V01–V10，供应商请求另附证据                 |
| Host/backup版本协商         | Contracts/Host    | 2026-10-23                 | V2 policy拒绝/保留规则与V11测试明确                                  |
| 实验入口与不可用文案        | Frontend          | 2026-10-23                 | V2限制、scope和accepted/observed可理解且双语完整                     |

评审记录：2026-10-21，作者按 technical-proposal checklist自查完成；独立Agent/Gateway/Host/QA评审待进行。proposal integrity、ownership、失败/恢复、授权与兼容均已定义；未验证的产品/供应商流程作为明确验收项保留，不标记通过。

## 15. 证据入口

- [当前Codex适配器](../../packages/agent-codex/src/app-server-client.ts)、[manifest](../../packages/agent-codex/src/manifest.ts)、[history](../../packages/agent-codex/src/history.ts)。
- [角色契约](../../packages/agent-contracts/src/model-binding.ts)、[normalizer与Codex选项](../../packages/agent-contracts/src/external-agent.ts)、[session operations](../../packages/agent-contracts/src/session-operations.ts)。
- [模型slot](../../lib/ai/agent/external/config/model-slots.ts)、[plan compiler](../../lib/ai/agent/external/config/model-plan.ts)、[gateway projector](../../lib/ai/agent/external/config/gateway-task.ts)、[manager](../../lib/ai/agent/external/manager.ts)。
- [CLI目录](../../cli/src/runtime/external/codex-model-catalog.ts)、[Rust目录](../../crates/cognia-sandboxd/src/codex_catalog.rs)、[ticket精确匹配](../../crates/cognia-gateway/src/route_ticket.rs)、[task lease](../../crates/cognia-gateway/src/task_lease.rs)。
- [Host能力](../../lib/platform/host-feature-manifest.ts)、[remote client](../../lib/ai/agent/external/runtimes/remote/remote-run-client.ts)、[remote service](../../lib/ai/agent/external/runtimes/remote/remote-run-service.ts)。
- [脱敏原生实验与当前状态边界](../reports/2026-10-21-codex-subagent-model-probe.json)。
- OpenAI官方：[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[App Server](https://learn.chatgpt.com/docs/app-server)。
- 固定上游：[后端选择和完整默认配置](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/config/mod.rs)、[会话后端记录](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/session/mod.rs)、[V2直接输入限制](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/thread_input.rs)、[live/future语义测试](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/tests/suite/v2/turn_settings_update.rs)。
