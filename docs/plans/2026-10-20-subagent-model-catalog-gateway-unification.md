# 统一 subagent 模型配置、模型目录与任务网关的改造方案

状态：Draft / 待技术评审，未实施。作者：Codex。日期：2026-10-20（Asia/Shanghai）。

深度：Heavy。范围：主应用 UI、共享契约、integration packages、sidecar、CLI/TUI、Rust gateway / sandboxd / companion、Host 配置与配对设备、插件 SDK、导入迁移和测试。

基线：当前 `dev` 工作区，HEAD `07eb0d44b5567f815bbdf70bcb7693f518a9a38d`；检查时有 329 个已跟踪路径存在预先已有的改动。本文描述工作区源码，不代表干净 HEAD、发布包或线上状态。目标里程碑按阶段验收，不承诺未经团队估算的发布日期。

前置研究：[CC Switch 源码对照](../research/2026-10-20-cc-switch-subagent-model-gateway-comparison.md)，固定上游 v4.0.16 / `f92ff0b03964188f1cd011d9302ab8869d7a8219`。

关联决策：[ADR-0090](../content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md)、[ADR-0064](../content/docs/en/adr/0064-external-cli-backed-subagent-dispatch-completion.md)、[ADR-0216](../content/docs/en/adr/0216-each-agent-configuration-keeps-its-own-state.md)、[ADR-0217](../content/docs/en/adr/0217-agent-integrations-are-packages-behind-host-ports.md)、[ADR-0237](../content/docs/en/adr/0237-an-agents-harness-evolves-through-probed-approved-versions.md)。

评审角色：Agent integration、Gateway/Rust、Provider/Account、Frontend、CLI/Host、Security/PII、QA。本文不创建分支、提交、PR、部署或外部文档。

## 0. 实施修订（2026-10-20 复核；与下文冲突时以本节为准）

复核方式：按当前工作区源码逐条核对 §2/§4/§8 的事实（只读代码检索），并用固定版本的上游源码/官方文档核对外部 CLI 配置面（检索日 2026-10-20：Claude Code v2.1.304 / Agent SDK v0.3.304、`claude-agent-acp` v0.85.1、Codex `rust-v0.163.0`、OpenCode v1.19.3、Qwen Code v0.25.3、Goose v1.55.0、Copilot CLI v1.0.100、Gemini CLI v0.64.0、kimi-cli 1.52.0）。外部结论是配置/源码证据，不是 Cognia 真实推理验收；T-* probe 仍需执行。

### 0.1 需要更正的现状事实

| 原文位置                           | 更正                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2 template projection             | 比原文更严重：`resolveDispatchableSubagents` 复制 `model` 但**丢弃 `provider`**，`SubAgentConfig` 根本没有 `cogniaModel`/账号字段；`dispatch-run` 只转发 `model`，不转发 Cognia binding。这是现存 bug，Slice 1 修复                                                                                      |
| §2/§4 目录 owner                   | `collectModelOptions`/`resolveModelMeta` 在 `lib/ai/model-options.ts`；`cognia-model-options.ts` 只拥有 `filterCogniaGatewayModels`/`listCogniaGatewayModelOptions`/Host 目录                                                                                                                            |
| §4 ExternalAgentConfigOptions      | `config-options.tsx` 渲染 ACP 会话 config option（值来自 ACP server），不是 Cognia 的 thinking ladder，不承载角色模型                                                                                                                                                                                    |
| §2 route_ticket                    | 子串包含匹配在 `RouteTicket::resolve_model`（`selector.contains(key)`，最长键胜），family 推导在 `route_planner`；外部 task lease 显式把 7 个 selector 全绑到同一模型、单 candidate。若 task 部署再列出 child 模型，请求 `claude-haiku-*` 会被包含匹配改写到 `haiku→primary`——这是 v2 必须先关掉的串线点 |
| §2 Provider modelRoles             | `DeploymentProfile.modelRoles` 在 TS 侧**没有任何读者**；仅 Rust `gateway_snapshot_json` 映射为 fast/balanced/powerful alias。crosswalk 不是"复用现有消费"，是新增消费，推迟到 Slice 2                                                                                                                   |
| §2 capability contributions        | 只有 a2a/acp/aider/codex/dsh/opencode/pi 七个 package 贡献能力行；`agent-claude-code`、`agent-omp` 不贡献。slot 描述先与 projector 同处（见 0.3）                                                                                                                                                        |
| §4 命名                            | `ExternalAgentModelChoice` 已有两个不同形状（contracts 的 native/cognia union 与 `session-models.ts:492` 的目录行）；新类型避开该名                                                                                                                                                                      |
| §2 CLI task 边界                   | `cli/src/runtime/external/gateway-task.ts` 复制了 RUNTIMES/ALLOWED_FILES，且只做 lstat 检查（无 `O_NOFOLLOW`/nlink/FIFO）；新增文件必须两处同时改，并补齐 CLI 侧检查差距（单列工作项，不在 Slice 1 扩大）                                                                                                |
| 新发现（不在本方案范围，单独跟踪） | `/v1/embeddings` 不经过 PII gate 也不使用 ticket 冻结候选；`agent_gateway_host_task_*` 不在 Host feature manifest；TS/Rust 的 `provider:model` 前缀解析不一致                                                                                                                                            |

### 0.2 外部 CLI 配置面（取代 §8 中的推测）

| Runtime                                | 已确认配置面                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 对投影的影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code / ACP                      | 子模型优先级（≥v2.1.251）：调用参数 `model` > 定义 `model`（含 `inherit`）> `CLAUDE_CODE_SUBAGENT_MODEL` > 主模型；`*_FORCE` 存在（≥v2.1.257）。`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` 是别名映射；`ANTHROPIC_SMALL_FAST_MODEL` 已弃用。接受任意自定义 ID；`availableModels` 是 allowlist。ACP v0.85.1 默认 `settingSources: ["user","project","local"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `subagent.default`→`CLAUDE_CODE_SUBAGENT_MODEL`（默认值语义，与 §5.2 一致，不用 FORCE）；`tier.*`→三个 DEFAULT 变量。project settings 可改模型，故 gateway 必须对未授权 selector 拒绝（strict ticket）                                                                                                                                                                                                                                                                                                                                                 |
| Codex app-server / ACP                 | `[agents].default_subagent_model`、`default_subagent_reasoning_effort` 自 `rust-v0.145.0` 起存在，更早版本遇到该键会配置加载失败。`spawn_agent` 用 `list_models(Offline)` 做**精确 slug 匹配**（API key 模式还要求 `supported_in_api`，v2 拒绝 `multi_agent_version = disabled`），effort 按该条目的 `supported_reasoning_levels` 校验。`model_catalog_json` **整体替换** bundled 目录，没有合并模式；每个条目必须带 `base_instructions` 或 `model_messages.instructions_template`。自定义 `base_url` 的 provider 不触发 API-key 模型发现，`model_catalog_url`（≥0.156）同样是替换、不回落 bundled。`config.toml` 中的相对路径按文件所在目录解析，`-c` 中的相对路径按 cwd 解析。子线程 Config 克隆自父线程，只替换 model/effort，顶层 `model_context_window` 会泄漏到子线程。`codex-acp` v2.2.2（agentclientprotocol 版）是启动 Codex app-server 的 TS adapter，锁定 Codex 0.160.1 | 设置 `subagent.default` 时，task 写入只含计划模型的私有 `codex/model-catalog.json`：bundled slug 用 vendored 的 Codex `models.json` 原条目（`rust-v0.163.0`，Apache-2.0，位于 `cli/src/runtime/external/codex-catalog/`），其他 slug 用 Codex 自己的 `model_info_from_slug` 等价条目（vendored `prompt.md`）。上下文窗口与自动压缩阈值写入各条目，不再写顶层键。条目最大约 65 KB，超过 Linux 单个环境变量 128 KiB 的上限，所以 app 只在 payload 中发送小型目录请求，由 Node 与 sandboxd 两个 materializer 用同一份 vendored 文件组装。命名角色文件推迟 |
| OpenCode V1/ACP                        | `task` 工具：目标 agent 的 `model` 优先，否则继承父消息模型；`small_model` 只用于标题等辅助调用，不是 child 默认；`command.<n>.model` 另有链路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `subagent.default`→给内置 subagent（general、explore）及未单独指定的 `mode: subagent` 条目写模型，替换现有"全部改写为主模型"；`aux.small`→`small_model`                                                                                                                                                                                                                                                                                                                                                                                                |
| OpenCode V2                            | `agents/commands`；**V2 根 schema 无 `small_model`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | V2 只有 `subagent.default`，不提供 `aux.small`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Goose / Qwen / Copilot / Gemini / Kimi | Goose `GOOSE_SUBAGENT_MODEL`/`GOOSE_SUBAGENT_PROVIDER`（recipe settings 优先）；Qwen agent frontmatter `model`（`fast` 使用 `fastModel`）、`agents.builtin.exploreModel`；Copilot/Gemini/Kimi 为 agent 定义级 `model`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | P3 输入：Goose 的 child 默认可直接投影（当前被当作 route-owned 丢弃）；其余按 agent 定义级 slot 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 0.3 设计收敛

1. **同 provider/同账号（P2）不需要 v2 `selectorBindings{deploymentId,modelId}`。** 一个 task 仍是一个私有 deployment；租约请求增加"附加模型列表 + selector→model 绑定"，Rust 校验每个值都属于该 deployment，绑定表对每个计划模型加恒等项，ticket 打 `strictSelectors` 标记：只接受精确绑定键或精确候选模型，关闭子串包含匹配。仍是单 candidate，不产生跨模型 failover。精确 deployment+model 目标映射留给 P4。
2. **客户端 selector 在 P2 使用真实模型 ID，不用 `cgm_` opaque ID。** Claude/Codex 依据模型名推断能力（上下文、thinking、Codex 目录校验），opaque ID 会让 CLI 失去模型元数据；同一 deployment 内模型 ID 本身无歧义。opaque selector 仅在 P4 同名跨 provider 时引入。
3. **Slot 描述与 projector 同处。** `lib/ai/agent/external/config/model-slots.ts` 按 gateway runtime 声明 slot（id、kind、可选 effort、证据版本），由 UI、compiler、projector 共用；projector 迁入 owning package 时一并迁入 capability contribution。不在 Slice 1 改生成器。
4. **compiler 放 `lib/ai/agent/external/config/model-plan.ts`（纯函数）。** 当前唯一消费者是 app/headless brain（CLI 只消费已构建的 payload），提前放进 `agent-runtime-kit` 没有第二消费者；出现 package 消费者时再下沉。
5. **类型收窄到可执行的语义。** Slice 1 仅 gateway lane（`cogniaModel` 已设置）生效；slot 选择只有 `inherit-primary` 与 `cognia`（binding + 可选 effort）。`runtime-default`、native 选择与 `allowedModels` 在有可执行 projector 前不进类型，避免 built-but-dormant。
6. **默认不变：** 未设置 slot = 旧行为（主模型）。不做 deployment 角色 crosswalk、不自动降级到 fast。
7. **计划指纹进入 gateway session 元数据。** 续接时指纹不同即要求新 task（与 §11 一致），旧 task 无指纹视为 legacy 单模型。显式 rebind（同 task 换主模型）不比较指纹，重新签发的租约带新计划。
8. **配置层的子任务模型只对配置自身的 provider/账号生效。** 某次运行把主模型换到其他 provider 或账号时，配置层不参与编译，该次运行只用主模型，不因为不是这次调用做的选择而拒绝。调用层（插件派发、模板）的选择仍然严格校验。三处都有标注：类型注释、角色模型说明文案、`manager.test.ts`。
9. **strict mint 只绑定请求的计划模型。** 共享 deployment 列出的其他模型不会进入 ticket 的恒等绑定（`strict_mint_binds_only_the_requested_models_of_a_shared_deployment`）。

### 0.4 Slice 1 交付范围（本轮实施）

| 工作包          | 内容                                                                                                                                                                                                                                                                                                       | 负责                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| S1-A 契约与编译 | `AgentModelRoleOverrides`/slot selection 类型与 normalizer；`model-slots.ts`；`model-plan.ts`（分层合并、同 provider/账号校验、effort 校验、指纹、限额：≤32 模型/≤64 slot）                                                                                                                                | 契约与 slot 描述由主会话；compiler 由 Codex（gpt-6.1-sol） |
| S1-B Projector  | Claude/Codex/OpenCode（V1、ACP、V2）按计划投影；Codex 目录文件；无计划时输出与现状逐字节一致                                                                                                                                                                                                               | Codex（gpt-6.1-sol）                                       |
| S1-C 租约与网关 | Rust `TaskLeaseRequest`/`HostTaskLeaseRequest` 附加模型与绑定、`strictSelectors`、sandboxd/CLI materializer 按目录请求从 vendored 文件生成 `codex/model-catalog.json`（文件名不进 `files` 白名单）；TS local/Host/remote 三条租约路径透传；Host feature 标记；manager admission 编译计划并在续接时校验指纹 | Codex（gpt-6.1-sol）                                       |
| S1-D 派发入口   | `SubAgentConfig`/`PluginSubagentDef` 增 `cogniaModel`、`modelRoles`；修复模板 provider 丢失；`dispatch-run`/plugin dispatch 逐次覆盖；Host config 持久化 `modelRoles`                                                                                                                                      | Codex（gpt-6.1-sol）                                       |
| S1-E 前端       | `RoleModelFields`（复用 `CogniaModelPicker`）接入 agent editor、Host editor/create（`execution-tuning-fields`）、模板编辑器（外部 runtime 模板增加 Cognia 模型与角色行）；不支持/Host 过旧/native lane 的禁用原因；双语 i18n 与同目录测试                                                                  | 主会话                                                     |
| 质量门          | 主会话复核每个 Codex 结果的 diff 并重跑其验证命令；6.1-sol 对抗审查 Rust 租约与 strict 选择器；preflight 六个 auditor                                                                                                                                                                                      | 主会话                                                     |

推迟到后续 slice，并保持 §3 的 blocked/unsupported 记录：跨 provider/账号（P4）、opaque selector、命名角色（Claude agent 文件、Codex role 文件、OpenCode `agent.<name>`）、deployment 角色 crosswalk、会话级覆盖、CLI `/agents models`、CC Switch 与 Codex TOML 导入、P3 其余 runtime（Goose 优先）、OMP 接线、真实供应商 T-* probe 与 Tauri/配对设备验收。

## 1. 推荐扩展现有配置与任务票据，让一次选择贯通到实际请求

在现有主模型选择上增加有能力约束的子模型/角色覆盖，用同一份冻结执行计划生成客户端模型目录、原生配置及网关授权。
复用现有模型目录、账号选择、runtime manifest、ExternalAgentManager、task lease、route ticket、请求账本及 subagent 生命周期；不新增路由引擎、供应商注册表或模型配置数据库。
先交付同供应商、同账号的多模型，再打开跨供应商/账号；Claude Code、Codex、OpenCode 先完成真实 native child，其他 runtime 逐项以能力与实测结果接入。
所有现有 runtime 均进入矩阵和验收；缺少原生 child 或可注入网关协议的 runtime，明确支持 Cognia 编排或原生会话选模，不能伪称可控制其内部 child。
实施前需要确认的产品取舍是跨供应商默认行为、Codex 有损兼容选项以及缺失显式模型的处理；本文给出可直接实施的推荐默认值，见 §16。

### 1.1 需求与验收一一对应

| ID  | 用户结果                                                                      | 最终验收                                                                 |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Claude Code / SDK 可分别选择主模型、默认 child、支持的 family/命名 agent 模型 | V01–V03：配置投影和真实请求均不同；优先级、继承、拒绝可解释              |
| R2  | Codex 的子模型和 reasoning effort 真正生效                                    | V04–V06：目录、`[agents]`、角色文件和请求一致；app-server / ACP 分别验收 |
| R3  | 其他支持的 agent 使用统一入口，能力边界准确                                   | §3 全量矩阵逐项闭环；V07–V10；不能以 Unknown 表示已经完成支持            |
| R4  | 模型目录与实际可运行/授权模型一致                                             | V11–V13：来源、账号、Host、revision、能力和缺失模型状态均正确            |
| R5  | 网关按明确的模型/供应商/账号路由，父子并发不串线                              | V14–V19：同名模型、多账号、伪造 selector、预算、撤销、恢复及协议转换     |
| R6  | 复用已有代码和组件，所有入口使用同一语义                                      | §4 复用清单；V20–V22 覆盖模板、插件、Team、CLI、Host 与 mobile           |
| R7  | 可分阶段上线、观察和回滚                                                      | 每阶段具备独立 gate、退出条件和 kill switch；V23–V24 覆盖版本偏差和回滚  |

完整交付包含实现、真实 runtime 验收、跨 Host 验收和文档；仅 schema、mock 或 UI 可选不算模型支持完成。

### 1.2 保留三类语义，避免把辅助模型当作 subagent

- **Native child**：Claude Agent/Task、Codex spawn、OpenCode 命名 agent 等运行时内部产生的子任务；是否可控制模型必须有对应 producer/config 证据。
- **Cognia-orchestrated child**：`dispatch_agent` / `dispatchSubagent` 创建独立执行；沿用现有权限、预算、取消、结果与树状展示。
- **Auxiliary call**：Aider weak/editor、Qwen fast/advisor/compaction 等辅助调用。可以复用模型绑定机制，但 UI、事件和验收不能标成 native child。

本方案不重写子任务调度器、审批系统、账号 vault、Provider Profile Store、计费系统或协议翻译器；不 patch 外部 CLI 二进制，不默认开启用户全局扩展，也不把 SIWC 认证转换为通用 BYOK。接管用户全局 CLI 配置仍属于现有显式 CC Switch 同步动作，任务执行继续使用私有配置。

## 2. 已有能力足以承载改造，缺口主要在配置传递与精确授权

证据状态：**Confirmed** 为当前源码或实际命令；**Inferred** 为从源码推导；**Proposed** 为本文目标；**Open** 为指定版本的待验证事实。后文设计均为 Proposed，不表示现有功能。

| 证据                                                                                                                                                                                                                                              | Confirmed                                                                                               | 改造结论                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [model-binding](../../packages/agent-contracts/src/model-binding.ts)、[model choice](../../packages/agent-config-types/src/index.ts)                                                                                                              | 已有 `ExternalAgentCogniaModelBinding`、native/cognia 选择；账号 undefined/null/具体 ID 语义不同        | 复用类型并保持语义；不另定义一套 provider/model/account                        |
| [cognia-model-options](../../lib/ai/agent/external/config/cognia-model-options.ts)、[session-models](../../lib/ai/agent/external/session/session-models.ts)、[model-surface-cache](../../lib/ai/agent/external/capability/model-surface-cache.ts) | 分别拥有网关可选模型、原生选模/思考轴和 Host/session 作用域缓存                                         | 统一消费这些来源；不把 native 和 Cognia 目录混成无来源的字符串                 |
| [dispatch](../../lib/plugin/agent-sdk/dispatch.ts)、[dispatch-run](../../lib/claude/agents/dispatch-run.ts)                                                                                                                                       | 已支持逐次 model 覆盖、外部配置 pin、`cogniaModel`                                                      | 统一模型策略在这里透传，不新建 subagent runner                                 |
| [template projection](../../lib/claude/agents/subagents/index.ts)、[template editor](../../components/settings/subagents/panels/template-panel.tsx)                                                                                               | UI 保存 provider/model，但相关模板投影没有完整传递 provider/网关账号语义                                | 补齐现有投影，同时修复丢字段；不能让 UI 成为第二路由器                         |
| [SDK options](../../sidecar/src/runtimes/claude-agent-sdk/options.ts)                                                                                                                                                                             | `agents[name].model` 已传给 SDK                                                                         | 复用原生 agents map；供应商/账号改变必须经已授权网关或独立编排                 |
| [gateway-task](../../lib/ai/agent/external/config/gateway-task.ts)                                                                                                                                                                                | Claude family、Codex、OpenCode role、Qwen/Aider 辅助模型均存在单模型折叠；raw env/config 不是任意逃生口 | 在原有验证和 projector 上扩展受控角色，不能简单放开所有 env/JSON               |
| [mint-session-ticket](../../lib/gateway/mint-session-ticket.ts)、[task_lease](../../crates/cognia-gateway/src/task_lease.rs)                                                                                                                      | 普通 SDK ticket 可有 family bindings；external task 被明确限制为一个 deployment/model                   | 保留 v1 兼容，扩展同一 ticket/task lease 的精确目标绑定                        |
| [route_ticket](../../crates/cognia-gateway/src/route_ticket.rs)、[route_planner](../../crates/cognia-gateway/src/route_planner.rs)                                                                                                                | 目前 `modelBindings` 为 selector→model string；family 可按包含关系匹配；候选集是另一个轴                | v2 必须把 selector 绑定到 deployment+model；仅扩大候选集会导致同名模型串供应商 |
| [Provider Profile schema](../../packages/provider-types/src/provider-profile.ts)、[Rust projection](../../crates/cognia-agent-state/src/provider_profiles/mod.rs)                                                                                 | 已有 deployment `modelRoles.primary/fast/powerful`，headless 投影已有角色 alias                         | 沿用部署角色作为默认输入，不另建全局 role store；任务覆盖不回写 deployment     |
| [integration contracts](../../packages/agent-contracts/src/ecosystem.ts)、[capability contributions](../../lib/agent-ecosystem/capability-catalog.ts)                                                                                             | package-owned manifest 经 generator 生成 runtime/capability JSON；runtime、preset、protocol 不等价      | 扩展现有 contribution 和 live evidence；不手改生成行或维护 UI 私有支持名单     |
| [ledger](../../crates/cognia-gateway/src/passthrough_ledger.rs)、[ledger source](../../lib/router-fusion/calls/gateway-ledger-source.ts)                                                                                                          | 已有 requestedModel、实际 provider/model 与请求计费                                                     | 扩展关联字段即可证明实际路由；不另做一套账本                                   |
| [CC Switch interop](../../lib/ccswitch/switch.ts)                                                                                                                                                                                                 | tier model 可进 Cognia 目录；Claude 同步仅 key/base URL，Codex 仅 auth key                              | 导入角色配置与执行绑定必须显式补齐；导入成功不等于执行映射完成                 |

CC Switch 值得借鉴的是显式角色配置、目录校验、供应商明确绑定与不静默转移。Cognia 应将绑定放进现有任务票据，而不是复制 CC Switch 的设备级 Stack 注册表。上游 Codex classic-subagent 策略来自源码说明，采用前必须通过固定版本测试。

## 3. 所有 runtime 进入覆盖矩阵，native 支持以实际 producer 为准

### 3.1 当前规模与完整静态清单

Confirmed：23 个 canonical runtime rows / 26 个 preset associations；26 个非 custom 静态 presets，另有 custom sentinel。13 rows / 16 presets 在符合 task-owned 本地 launch 条件时支持网关，对应 10 个 family / 11 个 traits profiles。`BUILTIN_EXECUTABLE_PRESET_IDS` 的 20 个直接 backend presets 是另一口径，不能当作全部 runtime。

来源：[runtime catalog](../../protocol/external-agent-runtimes.json)、[presets](../../lib/ai/agent/external/config/presets.ts)、[gateway support](../../lib/ai/agent/external/config/gateway-task.ts)。下表的“网关有”是配置链路存在，不是认证推理已验收。

| Runtime / presets                                          | 当前网关                          | 本方案投影与验收归属                                                                                                               | 阶段  |
| ---------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `claude-agent-acp` / `claude-code`                         | Anthropic                         | child default、family、命名角色；复用 Claude manifest + ACP transport；与 SDK 分别验证                                             | P2    |
| `codex-app-server`                                         | Responses                         | 私有 config、目录、`[agents]`、角色文件与 effort                                                                                   | P2    |
| `codex-acp` / `codex`,`codex-acp`                          | Responses                         | 复用 Codex 语义，通过 ACP start/resume 覆盖验证                                                                                    | P2    |
| `opencode` / `opencode-server`                             | Chat，本地 auto-spawn             | 扩展已有 V1 `agent/command`、`small_model`，保留命名模型                                                                           | P2    |
| `opencode-acp`                                             | Chat                              | 复用 V1 projector；不套用 V2 schema                                                                                                | P2    |
| `opencode-v2-service`                                      | Chat，本地 managed launch         | 扩展 V2 `agents/commands`；attached endpoint 仍受远端边界约束                                                                      | P2    |
| `qwen-code`                                                | Chat                              | 先区分 fast/advisor/compaction；原生 child schema 和实际请求单独补证                                                               | P3    |
| `kimi`                                                     | Chat                              | 扩展已有 env model/provider 投影；child model 需要固定版本 schema+请求证据                                                         | P3    |
| `goose`                                                    | Chat                              | recipe/subrecipe 与模型配置逐项验证；沿用现有环境/keyring隔离                                                                      | P3    |
| `copilot-cli`                                              | Chat BYOK                         | 复用 provider 配置；确认 default child 能力；不得回落 GitHub 原生登录                                                              | P3    |
| `pi` / `pi-rpc`                                            | Chat                              | native RPC 不承诺 child；保留 Cognia 编排；可信扩展 producer 必须单独声明和认证                                                    | P3    |
| `aider`                                                    | Chat / transcript                 | main/weak/editor 分别绑定和验收；native child 继续 unsupported                                                                     | P3    |
| `deepseek-harness` / readonly、workspace、ACP 三个 presets | Chat；SDK transcript / ACP resume | 扩展受控 provider models；三个当前 profiles 均未 compose native child producer，启用时须同步修改 composition、取消、审批和能力证据 | P3    |
| `grok`                                                     | 无                                | 主会话模型 + Cognia 编排；逐 runtime probe 私有配置/协议/认证后决定能否增加 gateway contract                                       | P3    |
| `minimax-code`                                             | 无                                | 同上；复用 ACP vendor profile                                                                                                      | P3    |
| `cline`                                                    | 无                                | 同上；`.clinerules` 不能当 native child API                                                                                        | P3    |
| `qoder`                                                    | 无                                | 同上；保留已有 ACP 连接与认证边界                                                                                                  | P3    |
| `devin`                                                    | 无                                | 同上；保留每会话进程和 model variant/effort overlay                                                                                | P3    |
| `gemini-cli`                                               | 无                                | ACP 主模型不证明支持 OpenAI/Anthropic gateway；先验协议，不能仅改 base URL                                                         | P3    |
| `kiro-cli` / `kiro`                                        | 无                                | 主会话/编排 + 独立 child/gateway probe                                                                                             | P3    |
| `droid`                                                    | 无                                | 主会话/编排 + 独立 child/gateway probe                                                                                             | P3    |
| `cursor-agent` / `cursor-cli`                              | 无                                | 主会话/编排；迁移 importer 不等于原生控制能力                                                                                      | P3    |
| `opencode-remote`                                          | attached server 无 task home      | 仅通过服务明确提供的 model/config 能力下发；拒绝用本机配置伪装远端生效                                                             | P3/P5 |

P3 对每个 Unknown 必须产生“固定版本验证后启用”或“有证据的 unsupported + 可用替代路径”之一。没有证据、环境缺失或认证不可用时状态是 **Blocked acceptance**，不能以 unsupported 关闭，也不能默认发布为支持。若某 runtime 只能用专有上游协议，增加新网关协议属于显式扩展工作包，按相同翻译/安全/验收标准评审，不能靠 generic ACP 推断支持。

### 3.2 静态清单之外的入口也必须覆盖

| 入口                          | 处理原则                                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内部 Claude Agent SDK         | 原生 agents map 直接承载命名角色；执行 spec、默认模型、网关 ticket 使用同一角色策略                                                                                                           |
| 内部 AI SDK                   | 复用现有 `dispatch_agent` 和独立 child executor；不声称供应商原生 child                                                                                                                       |
| `codex-siwc-app-server`       | 复用 Codex 模型类型/目录能力，但保留 SIWC 专用账号和认证；当前不支持通用 BYOK rebinding，跨供应商明确阻断                                                                                     |
| A2A / HTTP / attached network | 服务未提供受支持选模/child 配置时只做编排和能力展示；不创建本机 task home 代替远端配置                                                                                                        |
| plugin/custom presets         | 走现有 registry、capability contribution 和 typed extension；没有模型角色声明时不开放 native override，不建立 plugin 私有路由器                                                               |
| OMP                           | 当前 package 已写但未接 runtime catalog、preset、manager registry、gateway，不能计作已交付；P3 建独立接线工作包，复用 package 的 config/path/session API，真实验证 child model 后才发布该能力 |

OMP 接线是本文明确的增量范围；不要求为每个 ACP-only vendor 新建 package。依据 ADR-0217，ACP-only 的协议/config profile 继续留在 `agent-acp`，package ownership 不因 UI 品牌拆分。

## 4. 复用清单与禁止重复实现的约束

| 问题              | 现有 owner / 必须复用                                                                                                                                                               | 具体扩展                                                                                    | 禁止新增                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 模型与账号引用    | `agent-contracts/model-binding.ts`、现有 model choice re-export                                                                                                                     | 增加非秘密角色覆盖和冻结计划类型；choice 下沉 contracts 后保持原 import re-export           | 第二套 credential/provider binding 类型                       |
| 目录与能力        | `collectModelOptions`、`resolveModelMeta`、`filterCogniaGatewayModels`、`session-models`、`model-surface-cache`                                                                     | 增加角色过滤、来源/revision、Host能力信息和准确失效                                         | 第二份模型数据库、独立刷新轮询器                              |
| Provider 默认角色 | `DeploymentProfile.modelRoles`、现有 migration/snapshot publisher                                                                                                                   | 作为低优先级默认；缺失 family 映射不能靠任意新模型名猜测                                    | 另一张全局 role table                                         |
| UI 模型/账号选择  | [CogniaModelPicker](../../components/agent/external-agent/cognia-model-picker.tsx)、[ProviderModelCombobox](../../components/settings/provider/routing/provider-model-combobox.tsx) | 前者复用网关账号作用域；后者用于 provider 模型展示；增加受控 catalog props 以消费 Host 结果 | 新搜索弹窗、账号 fetcher、重复 Provider list                  |
| 外部配置 pin      | [ExternalAgentConfigPinField](../../components/agent/external-agent/external-agent-config-pin-field.tsx)                                                                            | 保留 exact config 与网关角色覆盖预览                                                        | 按最近连接随意选配置                                          |
| 原生配置选项      | [ExternalAgentConfigOptions](../../components/agent/external-agent/config-options.tsx)、runtime-kit/config-options                                                                  | 复用配置轴读取/写入和现有 thinking ladder；增加 role descriptors                            | 把任意 config JSON 当可安全执行的角色设置                     |
| 容器与表单入口    | `template-panel`、`execution-tuning-fields`、`host-agent-editor`、现有 mobile editor                                                                                                | 小型 RoleModelFields 组合现有控件；模板切 runtime 时保留/提示失效字段                       | 新 Settings section、第二个模型配置页面                       |
| 外部执行          | `dispatchSubagent`、`ExternalAgentManager`、现有 Team dispatcher                                                                                                                    | 只传统一覆盖并在 admission 编译；沿用 hook/权限/取消/预算                                   | 新 subagent engine、native child 的假生命周期                 |
| 配置落盘          | `buildGatewayTaskConfig`、sandboxd gateway_task、CLI prepareGatewayTask                                                                                                             | 扩展同一任务文件白名单、manifest和保护区；vendor projector 逐 runtime 放回 owning package   | 另一套 task home 或全局配置写入器                             |
| 路由与授权        | `task_lease`、`route_ticket`、`route_planner`、现有 translates                                                                                                                      | 同一 ticket 增精确 target map，选定子集，保持成本预留和 PII gate                            | 第二代理服务、全局 Stack key registry、直接绕过 gateway fetch |
| 远端配置          | `host-config-service`、`lib/db/external-agent-configs`、remote-host-configs                                                                                                         | 保留 head/revision/CAS、keyring、feature negotiation                                        | 新 Host config store、逐次发送整个配置的旁路                  |
| 结果与成本        | subagent runtime store、SDK bridge、gateway ledger、Router Fusion                                                                                                                   | 增 requested/resolved/plan fingerprint 关联和 attribution                                   | 第二套日志/计费库、按模型名猜 child 归属                      |
| CC Switch 导入    | `lib/ccswitch`、`subagent-importers`、现有 TOML/YAML parsers                                                                                                                        | 显式导入可表达的角色并报告损失，保持外部 DB 只读                                            | 自动接管 CC Switch 当前账号、全量重写其配置                   |

**新增文件门槛：** 默认扩展现有 owner。两个有明确多消费者的新增实现单元为 `components/agent/external-agent/role-model-fields.tsx`（RoleModelFields，组合 agent/template/Host 三类表单控件）和 `packages/agent-runtime-kit/src/model-plan.ts`（纯 task-model-plan compiler）。后者必须新增，因为现有 `gateway-task.ts` 依赖 app 的目录/设置模块，不能作为 CLI/integration package 的公共编译器；由 host 提供目录/账号事实，秘密解析仍留现有 lease owner。compiler 不 import React、Tauri、vault 或 Node fs。vendor-specific projector 需要新文件时放 owning package，理由是避免 package 反向依赖 app，不能再复制一份原有分支；迁移分支和测试后删除旧 owner 的重复实现。

## 5. 一份非秘密角色策略，派生一份不可变的执行计划

### 5.1 保留主模型现有来源，只新增角色覆盖

主模型继续来自 `ExternalAgentConfig.cogniaModel` / 原生 `model` 和 `ChatSession.externalAgentModels`；不在新对象里再存一份 primary。建议在现有 contracts/model-binding 中增加如下契约，名称为设计草案，字段语义是本方案约束：

```ts
type RoleModelSelection =
  | { kind: "inherit-primary" }
  | { kind: "runtime-default" }
  | { kind: "model"; choice: ExternalAgentModelChoice }

type AgentModelRoleOverrides = {
  version: 1
  slots: Record<
    string,
    {
      selection: RoleModelSelection
      reasoningEffort?: string
    }
  >
  allowedModels?: ExternalAgentModelChoice[]
}
```

slots 由 integration 声明：`subagent.default`、`tier.haiku/sonnet/opus`、`agent.<native-name>`、`aux.<name>`。声明含 kind（child-default / native-agent / tier / auxiliary）、supported selection/choice kinds、effort schema、defaultSource 和 evidence/version。扩展现有 `AgentProtocolCapabilityRow` / `AgentPresetCapabilityRefinement` 的可选 `modelSlots` 元数据，由 package 的 `AgentCapabilityContribution` 汇总并经现有 capability generator 输出；live evidence只能在已声明/校验的schema范围内收紧或确认。不另建品牌名单。manifest 元数据不授予权限；动态名字必须由已发现/导入的角色名单验证。不能把任意 slot string 直接转成文件名、env key 或 upstream 配置键。

将可选 `modelRoles` 字段加入 ExternalAgentConfig、execution options、SubAgentConfig、PluginSubagentDef、相关 Team 执行参数与会话级 override；所有字段引用同一类型。配置/模板/会话覆盖是不同作用域，不互相回写。

`allowedModels` 是除primary/slot已用目标之外、允许原生producer显式选择的附加目录子集；缺省不增加任何目标。数组中的native choice必须有明确modelId，gateway choice必须有合法binding，受同一runtime/账号/host资格校验和32target总限制。该字段按最高有值作用域整体替换，不跨层取union；它不绕过调用方已有权限/预算上限。UI复用相同模型行控件管理此列表，不再请求一份不同来源的catalog。

| 值                                                              | 语义                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `modelRoles` / 某 slot 缺省                                     | 继承下一层；旧配置保持现有行为                                                                                                                                           |
| `slots: {}`                                                     | 当前层没有覆盖，不清空父层                                                                                                                                               |
| JSON patch 中 slot 为 null                                      | 清除该层覆盖；存储后不保留 null slot；走现有 CAS patch 规范                                                                                                              |
| `selection.kind="inherit-primary"`                              | 显式屏蔽更低层该slot设置，冻结到本任务primary；UI“跟随主模型”与“清除本层设置”是两个动作                                                                                  |
| `selection.kind="runtime-default"`                              | 显式屏蔽更低层设置，使用经过descriptor允许的runtime默认；native模式可省略对应字段，gateway模式仅在默认能被解析成已授权target时允许，否则拒绝 `runtime-default-unbounded` |
| `selection={kind:"model", choice:{kind:"native", modelId:...}}` | agent 自有目录模型；native main 时可用；不是 Cognia provider ID。slot中未给modelId的旧native选择归一化为runtime-default，不留歧义                                        |
| `selection={kind:"model", choice:{kind:"cognia", binding:...}}` | 明确的 provider/model/account 引用，启动时解析并冻结                                                                                                                     |
| `cogniaModel: null`                                             | 保持现有“使用 runtime 原生路由”语义，不改成账号默认                                                                                                                      |
| binding.accountId 缺省 / null / ID                              | 启动时默认账号 / manual API settings / 固定账号；归一化后冻结实际身份                                                                                                    |

网关模式的所有执行目标必须是本 task 已授权的 Cognia bindings 或继承目标。不能混用 child 原生账号绕过网关；native 主模型 + Cognia child 需要有支持该组合的受控本地 gateway 全链路，首版拒绝 `mixed-route-unsupported`，可选择独立 Cognia 编排 child。

### 5.2 优先级、冲突和继承必须可解释

策略优先级：逐次调用覆盖 > subagent/template 定义 > 会话级覆盖 > 已 pin 外部配置 > Provider deployment 显式默认 > runtime 原生继承。应用已有默认主模型解析保持原 owner；一个高层 slot 覆盖仅替换该 slot。原生 producer 内部的显式调用/角色 frontmatter 优先级按固定版本 probe 记录，不能声称全 runtime 一致。

跨作用域merge必须区分三态：缺省继续查下一层，inherit-primary终止查找并跟随primary，runtime-default终止查找并由descriptor执行受限默认。reasoningEffort只附属于最终slot模型：较低层模型被高层继承/显式模型屏蔽时，不携带其effort；显式effort不支持时拒绝，不能静默clamp。§15增加这三态、清除和primary变更的组合测试。

deployment角色到runtime slot的默认crosswalk必须写在同一descriptor，不留在UI或compiler私有switch中：

| Slot                                            | 新v2策略的默认来源                                                                 | 限制                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `subagent.default`、`agent.<name>`              | primary；存在显式import/native-role策略时按上层覆盖                                | 不自动将“child”映射到fast，默认不替用户降成本/改模型                                   |
| Claude `tier.sonnet`                            | deployment.primary，未配置则任务primary                                            | 只在该integration声明此slot时生成                                                      |
| Claude `tier.haiku` / `tier.opus`               | deployment.fast / powerful；缺省回任务primary                                      | 引用必须属于同deployment的已列模型，所用账号跟随该默认deployment；P2不能越过同账号限制 |
| OpenCode V1 `aux.small`                         | 已有明确small_model覆盖，否则deployment.fast，缺省回任务primary                    | V2只有当前schema实证存在等价slot时才映射，不猜字段                                     |
| Qwen其他aux、Aider weak/editor、其他runtime aux | 首版默认任务primary以保持现有gateway行为；之后仅经descriptor/真实probe引入其他默认 | 不能把名字为fast/advisor的字段自动映射到deployment.fast，更不能据此声明native child    |
| 未声明slot或未知默认                            | 不生成；显式请求返回unsupported/unknown证据错误                                    | 不根据任意模型名含haiku/opus推导用户策略                                               |

crosswalk仅在用户启用v2策略时生效并出现在预览；无modelRoles的legacy配置继续单模型。runtime有独有默认且用户显式选runtime-default时，仅按该descriptor已验证的解析规则执行。

对Cognia编排child，必须区分“child这次启动的primary”和“它内部将再启动的native children”：前者仍由现有dispatch resolver选择，后者才消费该child自己的modelRoles。编排child的primary顺序为：逐次显式选择 > child模板/定义的明确模型与binding > 会话对该agent的选择 > exact-config pin自身明确primary > 父run的subagent.default > 现有应用/provider默认。父run未设置child默认时保持旧行为；`inherit-primary`明确使用父run已冻结primary。父run的native `agent.<name>`槽不自动匹配Cognia模板ID，也不将父run所有辅助角色复制给子run。独立编排child经已有dispatch权限重新admit，沿用parent预算/权限ceiling，不复用父ticket去调用未授权模型。

区分 **默认值** 和 **强制绑定**：默认 child 用于生成原生默认配置；原生调用选择另一个已授权 selector 可以生效，未知 selector 必须拒绝。首版不添加强制覆盖所有原生 child 的开关，不自动使用 `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`。

显式指定的模型/账号丢失、effort 不支持或必需 slot 不支持时，在 spend 前阻断；不得静默继承或折叠到主模型。只有“未指定”才继承。UI 同时显示配置来源、继承结果和阻断原因。相同 provider/model 的不同 account 不去重为同一 target。

旧 `model` 与 `cogniaModel` 的 v1 路径保留历史行为；v2 同时指定互相矛盾的 gateway primary/model/role 时返回 `model-binding-conflict`。模板现有 provider/model 通过明确迁移 preview 转为 cognia binding，不能因存在 provider 字段就擅自切账号或把原生模型认成网关模型。

### 5.3 冻结计划是派生值，不新增持久化事实源

Admission 从配置 revision、会话覆盖、runtime/version capability、所属 Host 目录、账号授权和 deployment 默认编译出 `ResolvedTaskModelPlan`：

| 字段                                                        | 含义 / owner                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `planVersion=2`、`fingerprint`                              | 同一 canonical serializer 生成；纳入执行 fingerprint、task metadata 和客户端配置 digest    |
| `runtime/profile/versionEvidence`                           | 现有 runtime readiness/certification，不能以语义版本字符串代替 executable identity         |
| `primaryTarget`、`slots`                                    | slot → targetRef；记录配置来源，不复制凭据                                                 |
| `targets`                                                   | targetRef → provider/deployment/model/实际账号引用、能力/effort和授权边界；引用而非 secret |
| `clientSelectors`                                           | task-scoped、无秘密的 opaque selector → targetRef；原生 role alias 映射也是由此生成        |
| `catalogRevision`、`configRevision`、owner/device/workspace | 防旧缓存、账号/Host切换与并发写入的 fence                                                  |
| `projectionDigest`、`compatibilityDecision`                 | 可证明写出的配置与模型目录来自同一计划，记录有损兼容选择                                   |

启动后冻结，不因 UI catalog 刷新、全局默认账号切换或 Provider 列表排序而改变。缓存只缓存非秘密目录和编译输入；不存在持久化 ticket secret 的 compiler cache。

## 6. 模型目录保留来源和能力，客户端只看到任务允许的子集

目录是选择和能力事实，不是授权。复用 `CatalogModel`、`ExternalAgentModelCapabilities`、`CogniaGatewayModelOption`、已有 config option/thinking surface，增加版本化可选元数据即可，不建立第二张完整模型表。

目录有三层：全局 Provider 事实由现有 provider/model catalog 管理；runtime 原生事实由 adapter/model-surface-cache 管理；**task catalog 是执行计划的授权投影**，仅包含用户选择及允许原生 child 使用的 targets。可浏览模型不自动成为可调用模型。

每行保留 native/cognia 来源、provider/deployment、模型 ID、账号作用域、Host、模型能力和证据版本。配对设备只收到可展示字段及必要账号 ID，不返回 key、token、header 或 base URL。对没有 native 模型目录的 agent，不为展示而伪造列表；沿用 ready/unsupported/error 状态与现有 discovery。

客户端 selector 建议使用 `cgm_<opaque-id>` 形式，只含 ASCII 安全字符，不包含凭据、email、endpoint、account ID 或可执行表达式；相同上游模型来自不同账号/部署必须得到不同 selector。selector 仅在当前 ticket/task 映射内有意义，不建立全局可解析 provider key；实际编码须通过 Claude/Codex/OpenCode 固定版本 probe 后锁定。旧任务的 selector 不能在新任务扩大授权。

`/v1/models` 及 Codex/其他 runtime 私有目录文件都消费同一投影，包含正确的 context/output/tool/vision/reasoning facts。未知事实保留 unknown，不填“全支持”；明确不支持 tools/streaming 的模型继续排除。新增 child 模型改变的上下文窗口/effort 必须跟随该模型，不能套用主模型全局值。

缓存失效沿用 `model-surface-cache` 的 epoch/revision 和 Host scope；增加 catalog/modelRoles/config revision、owner/account generation 到 key 或 fence。旧异步结果不得覆盖新选择。删除模型后保留 UI 中的失效引用用于修复，不能静默选邻近项。缓存 TTL 不承担账号撤销授权；每次 admission 和请求时的 authority 仍校验。

## 7. 扩展原有 ticket 为精确目标路由，避免同名模型串供应商

### 7.1 在同一授权 owner 中增加 v2 selector bindings

仅把 `modelBindings` 改为多模型，或把多个 provider 放进 candidates，仍不够：当前 model string 与 candidate deployment 是分离的。建议在现有 RouteTicket/MintRequest 加版本化、可选的 `selectorBindings`：

```text
selectorBindings[selector] = {
  deploymentId,
  modelId
}
```

账号由该 task 私有 deployment override 绑定，不把账号 selector 交给模型任意指定。一个 target 对应一个已校验的 deployment/model pair；相同 provider 的两个账号使用不同私有 deployment identity。复用 `TicketCandidate` 作为目标值或从其派生，避免重复结构。

v2 明确选择的 selector 必须精确匹配，仅在此 deployment/model 上执行；不能继续走所有 ticket candidates 的 fallback walk。现有 route planner 增加“解析 selector→限定候选子集”的步骤，server 的 Chat/Responses/Messages/count-tokens/models 全部使用相同 verdict。翻译只改 wire shape，不重新选择 provider/model。

现有 v1 `modelBindings`、family heuristic 和旧 ticket 行保留兼容。v2 中 family alias 只能来自已冻结的显式映射；未知 opaque selector 立即拒绝，不能被 `contains("haiku")`、普通 alias 或全局 snapshot 救活。必需支持“主子同名模型来自不同 provider/account”反例。

首版显式 target 的 failover 为关闭；原有用户 alias 的故障转移语义不受影响。若后续需要角色级 failover，须在同一 ticket 内明确授权候选链并单独评审，不能因 401/429 自动改账号。

### 7.2 task lease 扩展为多目标，仍只有一套预算和撤销机制

扩展现有 `TaskLeaseRequest`、`HostTaskLeaseRequest`、mintSessionTicket 输入和关联 schema，接收经验证的计划/目标引用；不开放让任意调用方提交无限 provider overrides。

- **Local desktop**：沿用 `prepareExternalAgentGatewayRoute` 的账号解析、credential generation、private provider overrides；逐 target 解析，全部成功才 mint。失败时撤销已准备资源，不启动 process。
- **Host-owned providers**：仍从 Host Profile Store 解析 provider/deployment，配对设备不提交密钥；无 vault 账号概念的 Host 继续拒绝显式 vault account ID。
- **现有 device-owned remote lease**：复用可信 transport、authority subscription、SSRF/public HTTPS 验证；若该路径按现有协议向 Host 委托私有 provider snapshot，只允许沿用现有受保护边界，不能将 snapshot 放入目录响应、普通 config revisions或客户端文件。多目标逐一校验并限制体积。
- **授权与生命周期**：一个 ticket 绑定 task、owner、device、runtime、完整计划 fingerprint；同一 ticket 的 aggregate token/request reserve 约束主模型和全部 child/aux 并发消费。原有 TTL 120 s、Host renew 30 s 保持；任一必要账号权限撤销/lease更新失败，撤销整个计划并 abort task。

跨 provider/账号的资格按每个 target 重新检查，不能仅验证主模型。任务结束先 revoke 后清理 process；保留 native history 时只存非秘密计划标识和必要配置。历史 ticket 的 secret 过期后不可恢复；resume 重新解析原有明确身份并 mint，身份不存在即阻断。

### 7.3 全链路投影只编译一次

```text
现有模型/账号控件 + native目录 + Host目录
                     |
     当前配置revision + 角色覆盖 + runtime证据
                     |
              冻结TaskModelPlan（新增）
                /                   \
      原生配置/任务模型目录       现有task lease / ticket（扩展）
                |                   |
       外部runtime父/子请求 --> 现有Gateway精确解析/PII/预算
                                    |
                             绑定的Provider/Account
                                    |
                        现有账本 + subagent结果投影
```

结论：原生配置、模型目录和实际路由必须共享 plan fingerprint；renderer、CLI、Host 不各自重新推导模型映射。

## 8. Runtime projector 复用现有 schema 和 package ownership

### 8.1 Claude Code / Claude Agent SDK

复用 Claude SDK `agents` map，命名 agent 的 model 写任务 selector；默认 child 和 family 分别生成配置，避免全部指向 primary。Claude ACP 的 task home/CLAUDE_CONFIG_DIR、用户态 agents 目录和受控 settings 通过现有 sandboxd/CLI 文件 owner 投影，先 probe 当前 bridge 如何加载这些来源；未验证前不新增任意 `--agents`/`--settings` 参数。

`CLAUDE_CODE_SUBAGENT_MODEL` 从已授权的 default child 生成；把它加入受控 schema，而不是 raw env 全放行。直接指定的外部 env 与 structured policy 冲突时阻断并给出迁移提示。family alias 与完整 ID、小版本、`inherit`、命名 role、project配置优先级分别用真实 runtime 证明。Claude 的静态模型目录扩展能力按版本 gating，不能只依据 CC Switch 写了某字段就认定 Cognia bundled CLI 支持。

原生 agent provider 字段不具有跨账号权限；跨 provider 的角色只能引用本 task 已授权 selector。SDK-native bridge 继续负责事件与取消；HTTP请求未携带 child identity时只记 selector attribution，不伪造 child lineage。

### 8.2 Codex app-server / ACP

扩展原有私有 `codex/config.toml`，由 package 负责生成经过验证的 `[agents].default_subagent_model`、effort 和模型目录；把相关结构加入 typed customization schema。不得把 `agents` 作为任意对象透传，更不能通过 CODEX_CONFIG 重新注入 provider/auth/env_key。

当 task 原生角色明确配置模型时，生成受控 `agents/<role-ref>.toml` 与 `config_file`，使用 task-relative 固定命名及受限内容；名称不是用户路径。sandboxd 和 CLI 的文件白名单共同扩展目录/profile规则，拒绝路径穿越、symlink、未知文件和引用外部 home。现有用户角色不被全量覆盖；导入与生成分别保留来源及冲突诊断。

模型目录必须包含主模型、default child、命名角色及 task 允许的选择，effort/context facts逐行正确。对当前版本验证 `model_catalog_json` 或等效配置入口；app-server 与 ACP 的 start/resume 都携带相同投影，保留现有 config-over-project route fence。若项目 role 能覆盖模型，只允许其选已授权 selector，否则执行时明确拒绝。

**跨供应商 native child 的发布门槛：** 固定 Codex版本验证任务上下文可被目标后端读取。加密任务不兼容时提供“保持同后端”或“显式启用经典工具”选项，说明失去的功能；默认不静默降级。不删除加密任务块、不伪造成功，不把 provider自己返回401当作可改账号重试。`[features] multi_agent_v2` 与目录字段的优先级必须进入 probe。

SIWC 不进入通用 BYOK 模型计划；仅复用其目录/原生能力，保留专用认证检查。迁移到普通 Codex 配置必须是明确创建/选择另一个 runtime配置。

### 8.3 OpenCode V1/V2/ACP

复用已有 V1 `agent/command` 与 V2 `agents/commands` 的 Zod schema，替换 `openCodeCustomization` 对所有 entry.model 的强制主模型重写：每个允许的角色/命令引用计划中的 target。保留权限、插件、project config隔离规则；不能因保存了模型就顺便放开未授权 provider或插件。

V1 `small_model` 和 V2 对应能力按各自 schema处理，命令的 model override也必须授权，不能成为绕过命名 agent 限制的入口。V1/ACP 与 V2分别产生目录和配置 fixture；project override、fork/resume和原生 child各有真实probe。attached remote server只走其公开API，不写本机文件假装完成。

### 8.4 其他 gateway family 使用同一计划，逐个声明真实 slot

Qwen、Kimi、Goose、Copilot 的 native child slot 由固定版本 probe确认后加入 package/vendor profile；现有辅助模型字段在确证后按 `aux.*` 接入，不能抢占 child默认语义。对无子模型接口的版本，UI显示继承/不支持，编排 child仍可选择自身 runtime模型。

Pi默认不启用用户扩展；需要 native child时显式采用可信且可认证的 extension producer并纳入manifest/能力治理。DSH需要启用经过认证的 composition producer后再发布 native支持，不能仅有child事件reader。Aider只接main/weak/editor多模型。OMP先完成现有 package 的注册/manifest/catalog/gateway接线，再验证其agent config；不复制其路径或RPC客户端。

vendor实现留 owning package 或 ACP vendor profile；host integration仅注入已解析的target metadata、process/file/PII ports。不增加 manager中的vendor class判断或每品牌一个新的 runtime engine。

## 9. 现有界面增加角色行和实际结果，保持一个模型选择入口

Agent editor/Host editor 在原有 CogniaModelPicker 下显示“子任务模型”；有 tier/aux/native-agent 能力时展开对应行。每行复用模型/账号选择控件，展示继承来源、模型名、Provider、账号标签、runtime支持状态；辅助模型明确命名用途。

模板 editor 的 provider/model、external runtime、config pin 使用同一解析预览；选择外部runtime时，Provider选择应写明确的网关binding，native模型从外部目录选择，两者不可共享一个无来源文本框。切runtime或config pin时，对不兼容覆盖先显示诊断，不自动替用户换模型/账号。保存有失效必需项时阻断。

会话 model chip 继续选择主模型，邻近现有配置区域显示子模型概要与“下次任务生效”；正在执行的计划只读。消息/subagent详情使用现有part/tree附加实际 requested/resolved信息；无原生child事件时不承诺每child都能独立定位或取消。

UI状态覆盖 loading、empty、unknown capability、unsupported、catalog unavailable、account locked、missing model、Host outdated、offline、CAS conflict；重试复用现有refresh/reload。支持键盘搜索/选择、可访问名称与焦点返回；所有新字符串和aria写split en/zh-CN并生成校验。继续使用已有TooltipProvider，不新增wrapper。

移动/浏览器配对模式从Host获取目录和role descriptors；不把本机provider设置发送给Host冒充其账号。Standalone web不能启动外部process时显示现有可恢复原因，保留内置执行或配对入口。主应用继续static export，纯compiler不引入fs/server依赖。

## 10. 所有调用入口透传同一策略，Host 协议先协商再发送

| 边界                      | 现有owner                                                                         | 必须增加的验证                                                                         |
| ------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 模板/插件→dispatch        | `subagents/index`、`dispatch-run`、`plugin/agent-sdk/dispatch`                    | 不丢provider/account/role；per-call仅覆盖当前run；external config pin先验家族与enabled |
| Team/Workflow→executor    | 现有执行服务与Team dispatcher                                                     | 不从模板重新推导身份；同一策略进入child admission，继续继承permission ceiling与budget  |
| built-in SDK/AI SDK       | execution spec与sidecar options                                                   | modelRoles进入fingerprint；SDK原生角色与编排路径语义一致且模式有标签                   |
| CLI/TUI                   | `subagent-runner`、`subagent-dispatch`、`subagent-models-model`、CLI gateway-task | 复用编译契约；扩展现有 `/agents models`，不另开模型命令；Node fs不进入browser bundle   |
| Host config CRUD/import   | `host-config-service`、existing revisions/CAS                                     | 校验并保存非秘密覆盖；新revision；去重/复制不借用其他config credentialRefs             |
| remote run/config/catalog | `remote-host-configs`、`remote-run-service`、companion schemas                    | 校验feature marker、owner/device/config revision；旧Host不接收未知字段                 |
| Native process boundary   | sandboxd gateway_task、CLI prepareGatewayTask、external-agent gateway_task        | task manifest与可信binding一致，逐文件固定白名单、hash与原子写；启动不能改写绑定       |
| Plugin SDK                | 现有subagent API与TS/Python types、author type generation                         | 新字段可选；host能力缺失时明确拒绝；runtime插件不能提交密钥、endpoint或未授权target    |

扩展现有 `external_agent_*`、`agent_gateway_*prepare/renew/revoke`，不另造同义命令。建议新增 **拟议** operation marker `external_agent_model_plan_v2`（外部配置/目录/run的v2语义）和 `agent_gateway_model_plan_v2`（多目标lease语义），分别进入现有Host config/process-plane feature operations；closed request/response schemas、known command生成和OpenAPI/AsyncAPI同步。只有配对Host同时声明config、catalog、run、lease v2所需能力时开放高级选项。

旧client→新Host：继续v1单模型；新client→旧Host：无高级覆盖的请求可以v1，有显式子模型必须在发送前提示升级并阻断，不静默剥字段。新旧plugin同理。允许读取新配置但不能表达它的旧写入器不得清除未知字段：新Host对旧schema写入保留现有高级字段或拒绝不兼容编辑。

## 11. 执行与恢复保持原有状态机，模型计划改变时创建新任务

```text
Configured -> CatalogValidated -> PlanFrozen -> LeaseMinted -> ConfigStaged -> Running
                     |               |             |             |             |
                     +------------ Blocked / Failed +-------------+             |
                                                                                |
                        terminal / cancel / authority loss -> Revoke -> Stop -> Released
```

结论：preflight失败必须发生在process启动和模型消费之前；启动后的错误沿用现有terminal事件和资源释放，不引入第二套任务状态存储。

| 事件                           | owner / 顺序 / 幂等                                                      | 恢复与用户结果                                                           |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 重复start                      | manager admission按taskId+planFingerprint防并发；lease prepare保留唯一性 | 相同请求复用已知结果或返回already-running，不多发一次推理                |
| 目录/账号在准备中变化          | compiler输出generation；mint前后assertCurrent；CAS检查config revision    | 废弃旧计划，回到可修复blocked，不自动选账号                              |
| 多target准备部分失败           | host内完成验证再一次mint；失败释放临时引用，未启动process                | 不留下半份目录/半个可消费ticket                                          |
| 写文件或启动失败               | stage到私有临时目录后原子发布；失败先revoke再cleanup                     | 原生history按既有策略保留；运行不冒充成功                                |
| cancel/timeout/renew失败       | 复用AbortSignal、cancel registry、lease.signal；先revoke后bounded kill   | cancel与finish竞态只终结一次；所有renew timer/disposer退出               |
| 进程崩溃/Host断联              | ticket过期/撤销；现有run journal保留failure；secret不恢复                | resume重新验证owner/device/runtime/targets并重新mint                     |
| 模型/账号被删除或权限撤销      | 当前task整体abort；未运行配置保留失效引用                                | 显式选择新目标；不因为同名模型换provider                                 |
| 修改modelRoles或目录投影规则   | v2默认新taskId，通过现有handoff/transcript机制延续                       | 不在有native children时原地重写config；legacy primary rebind保持现有边界 |
| 旧native history携带旧selector | 仅在原plan身份可重新授权时重建同映射；否则新任务handoff                  | 不能让历史selector解析到当前全局默认provider                             |
| 请求可能已被上游接收但连接断开 | 沿用现有uncertain账本；不跨target自动重发                                | 明确消费不确定状态，保留人工重试语义                                     |

模型映射变化使fingerprint变化；同fingerprint remint只能同映射/授权子集，不允许扩大候选。跨workspace、owner或device不能resume同task；即使模型字符串相同也不例外。

## 12. 安全与成本沿用现有边界，精确绑定不等于新增授权

- **权限：** 列出模型、读取目录、选择账号、派发外部process是不同权限。保留plugin外部派发gate、permission cascade、workspace/sandbox策略；descriptor声明不会授予权限。每target由task所属Cognia账号授权，不得借用别的config的credentialRefs。
- **秘密：** 配置和plan只存引用；keys/token仅在现有vault/keyring/lease私有override内，process只拿task bearer。多账号凭据不写models.json、TOML、prompt、日志、错误或导出。账号默认在admission解析成实际身份后冻结。
- **PII：** prompt/文件/tool结果仍走现有outbound gate；ticket请求继续经过Rust `body_has_no_leaking_pii`。补测子模型、协议转换、工具结果和图片路径，不能为外部native child开旁路。配置导入的agent prompt同样走现有PII admission。
- **路径/网络：** 角色名与config_file分开验证；相对路径、symlink、大小、引用深度受现有file host和sandbox限制。remote目标逐个执行现有DNS pinning/public HTTPS/redirect规则，不放宽私网条件。
- **预算：** 一次task的主子aux共用现有ticket budget/reservation，取消后拒绝新请求。每个请求按实际provider/model定价；unknown price按现有策略，不假装主模型价格适用。首版不新增按child分钱的第二预算系统。
- **原生配置优先级：** project/home env不能扩大授权。允许CLI拒绝模型选择，也允许gateway拒绝越权请求；不通过去掉限制来追求“能跑”。

## 13. 在现有账本证明 requested 与 resolved 一致

扩展现有日志/trace/ledger关联字段：`planVersion`、`planFingerprint`、`configRevision`、`selector`、`resolvedTargetRef`、runtime/profile/versionEvidence、projectionDigest、decision source及reasonCode。requestedModel和实际provider/model沿用已有字段。

role归属来自selector或运行时事件，记录 `attribution=selector|runtime-event|unknown`；背景请求用到haiku不自动算native child。精确child lineage只在已有权威事件可关联时补充。

拟议信号进入现有telemetry/diagnostic owner，不另部署指标服务：

| 信号                                    | 有限维度                                          | 阈值 / 动作                                                                    |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `agent_model_plan_admission_total`      | runtime family、plan version、result、reason enum | canary中任何可归因的错误账号/目标解析立即停止该runtime v2 rollout              |
| `agent_model_projection_mismatch_total` | runtime/profile、projection stage                 | 出现一次即可阻断对应版本；保存已脱敏配置digest和expected/observed              |
| `gateway_model_selector_refused_total`  | unknown/expired/unauthorized等reason              | 测试故意拒绝单独标识；真实流量连续异常检查旧目录/Host skew，不自动开放fallback |
| `gateway_task_lease_failure_total`      | prepare/renew/revoke、host class                  | renew失败立即abort；revoke失败保持告警并依赖TTL，不继续发新请求                |
| `agent_model_plan_compile_ms`           | runtime family、warm/cold                         | 目标见下文；超标先检查重复目录读取与非秘密缓存                                 |

不把task/session/account/model任意字符串放metric label，避免高基数；详细关联留现有受控日志/trace。保留期、删除与账号隔离沿用所属账本策略；本方案不另存prompt/secret审计副本。

性能/容量为 Proposed target，尚未测量基线：每task最多32个不同target、64个slot映射、128 UTF-8 bytes/slot名；计划与目录投影合计最多256 KiB，角色导入正文使用现有更严格限制。超限在admission拒绝并提示收窄，不能截断后继续。warm纯编译p95目标≤10 ms（32targets/64slots），不增加LLM调用，role数量不线性增加provider发现网络请求；credential解析去重后按现有host并发限制执行。P0记录基线和测试硬件，P1据测量调整目标并附证据，不能把目标写成已实现收益。

## 14. 渐进迁移旧字段，回滚不把新策略悄悄改成主模型

### 14.1 存储与导入

现有local agent store保存agent对象，Host保存config head+revisions；新字段可选、非索引。首版不需要新Dexie table/index或抢占schema版本。更新现有normalizer、Zustand migration/partialize、Host schema和CAS；若实现发现确需索引，走dexie-migration claim程序并重审，而不是在本计划预订版本号。

旧配置无modelRoles：归一化为legacy single-model路径，读操作不改存储；用户显式编辑才写新revision。老字段primary继续由旧owner保存。模板provider/model投影修复附带迁移preview，用户的native选择不自动变Cognia路由。

升级Codex importer：在现有adapter增加TOML配置/role bundles，复用smol-toml及导入file abstractions；只读取用户选择的根和相对角色文件，bounded size/depth、拒绝symlink/traversal，不跟随任意config_file；保留未识别字段的loss report，不导入auth或命令。旧Markdown/YAML格式继续可读，标注为legacy格式。

CC Switch导入只读取DB；把可表达的family/subagent配置转换成统一role overrides并预览，缺失provider/账号绑定的项标待选择。导入Codex默认子模型与effort时验证目录；不修改CC Switch DB、活跃登录或用户全局agent文件。全局同步若需要扩展，沿现有planSwitch/applySwitch的显式作用域、备份和drift检查完成，独立于任务启动。

导出/同步仅包含非秘密引用和策略版本；另一个账号/Host导入后重新绑定，不能自动采用同名account ID。新字段在跨端sync/backup的allowlist有明确分类；opaque selectors和ticket secret不进入可移植配置。

### 14.2 版本兼容与回滚

| 组合                               | 行为                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| v1配置 + 新client/Host             | 保留单模型；无数据重写                                                                                        |
| v2策略 + 新client/旧Host           | 发送前阻断高级选项，展示升级要求；不剥字段                                                                    |
| 旧client + 新Host v2配置           | 可兼容读取primary；无法保留新字段的编辑被拒绝/字段保留，不能覆盖丢失                                          |
| v2 ticket + 旧gateway              | feature/schema协商阻断，不发无法解释的请求                                                                    |
| 新gateway读取v1持久ticket metadata | 按旧默认解析；secret缺失仍须remint，不恢复权限                                                                |
| binary回滚后遇到v2本地配置         | 发布前验证旧normalizer是否保留未知字段；不能安全保留时用导出快照+禁止编辑提示，要求先升级，不能单模型静默执行 |

拟议flag加入现有feature配置体系：全局 `agentModelPlanV2`、按runtime/version的projection开关、`agentCrossProviderChildModels`，具体命名在P1统一注册。关闭UI入口不改变已运行task的冻结计划；紧急kill switch按plan version/runtime撤销ticket并停止对应任务。正常回滚让v2任务完成或明确取消，新的v2任务被阻断；v1继续可用。回滚不删除高级配置/role文件来源，用户升级后可修复恢复。

## 15. 分七阶段交付，每阶段有独立证据和回滚条件

### 15.1 工作包、依赖与退出条件

| 阶段 / owner                                         | 前置依赖                                   | 交付范围                                                                                                                    | 必须通过                                                                                 | 回滚 / 不满足时                                                        |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0 能力基线；Agent integration + QA（主责QA）        | 本方案评审                                 | 按§3逐runtime固定executable/version/profile；抓native child/model/config目录证据；建立fixture与不支持原因，确认编译性能基线 | 所有23rows/26presets有记录；支持/不支持/blocked有来源，Claude/Codex/OpenCode probe可重放 | 不改执行路径；无证据runtime不得进入其enable阶段                        |
| P1 契约/目录/影子编译；主责Agent contracts           | P0核心runtime证据                          | shared modelRoles/slot descriptors、compiler、fingerprint、Host schema协商、store兼容；现有UI只读预览；不改变请求           | V11–V13、V20、V23；legacy结果一致、影子计划稳定、无secret；生成catalog gates通过         | 关闭plan编译flag；读取旧字段不受影响                                   |
| P2 核心同provider/同account；主责Gateway integration | P1 + Claude/Codex/OpenCode固定版本probe    | v2 ticket精确pair、单provider多model、原有lease预算、三类runtime projectors/目录与UI角色行；SDK/ACP/app-server分别接通      | V01–V08、V14–V18；真实主子请求与账本一致；并发串线为0                                    | 按runtime关闭v2准入；停止失败任务，保留策略                            |
| P3 全runtime能力闭环；主责Agent integrations         | P1；复用P2已验证路由                       | 其他7个gateway families的角色/aux投影；9个非gateway ACP及remote逐项probe；OMP接线；DSH/Pi producer如启用则同步治理          | V09–V10、§3全量矩阵；每项明确verified/unsupported/blocked，native声明与实际producer一致  | 逐runtime/版本撤回，不能以一个runtime通过代表其余                      |
| P4 跨provider与账号；主责Gateway/Rust                | P2；相关runtime在P3已明确能力              | multi-private deployments、全目标authority、精确selector、同名模型、多账号；Codex可见兼容策略                               | V14–V19真实双provider/双账号；加密任务失败case；0次错误身份消费                          | 关闭cross-provider flag；不将策略折叠为primary；用户保留同provider选项 |
| P5 全入口和Host验收；主责CLI/Host                    | P1 wire先兼容；P2/P3；跨provider场景依赖P4 | Team/Workflow/plugin、CLI/TUI、remote三种Host路径、paired web/mobile、CC Switch/Codex导入、backup/sync与版本偏差            | V20–V24；同plan指纹/配置/账本一致；真实Tauri和headless/paired验收                        | 禁用高级remote操作并提示升级；v1不受影响；保留config revision          |
| P6 分批发布与收尾；主责Release/QA                    | 各runtime相关阶段均通过                    | 从已认证版本canary到扩大；双语文档/ADR、支持矩阵、runbook；删除已迁移的重复projector分支                                    | 验收证据链接完整、0串账号/越权、回滚演练成功；无built-but-dormant字段                    | 安全错路由立即kill对应v2；无证据项保持blocked且不宣称整体全部通过      |

P3并不允许放弃难实现runtime。每个未通过项都有下表的probe owner和证据产物；无法注入兼容协议的产品需明确声明支持边界，并对需要新增协议的工作包重新估算。最终报告分别列“native child模型已验收”“仅编排/辅助模型”“阻塞”，不合并成一个全支持数字。

实施依赖为 P0→P1→P2；P3可复用P1契约并在P2路由稳定后验收；P4依赖目标runtime已认证；P5的schema先随P1发布，完整跨端流随P2/P4打开；P6逐runtime收口。UI、导入、CLI不能等待最后才补字段透传。

### 15.2 未知能力有具体补证责任

| Probe / 单一owner role                                      | 必需证据                                                                                      | 结果如何影响实施                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| T-CLAUDE；Claude integration                                | SDK/ACP版本、default env / per-call / role优先级、full selector、catalog、实际child请求       | 锁定slot和目录投影语法；任意model ID不被接收则不发布该模式             |
| T-CODEX；Codex integration                                  | app-server/ACP role TOML与catalog、effort、project覆盖、encrypted task与classic选项；SIWC边界 | 无法跨后端读任务则P4禁用该组合，允许明确的同后端模式                   |
| T-OC；OpenCode integration                                  | V1/ACP/V2分别加载task role model、native child和resume、attached server API                   | 三份schema/fixture独立，禁止用V1成功证明V2                             |
| T-QWEN / T-KIMI / T-GOOSE / T-COPILOT；对应ACP vendor owner | 每项独立固定版本，主/child/aux字段与私有home有效，捕获目标请求和认证                          | native字段无法证明时不显示native选项；aux可独立验收                    |
| T-PI / T-DSH；对应integration owner                         | 可信producer/composition是否存在，模型字段、审批取消、lineage和PII                            | 未挂producer维持编排模式；若增加必须走现有扩展认证                     |
| T-OMP；OMP integration owner                                | registry/catalog/manifest接线、固定版本agent config、实际child model                          | 接线和模型支持分别有gate；不按package存在判定完成                      |
| T-ACP9；ACP integration owner                               | 9个runtime分别记录协议/目录/认证与private config注入能力                                      | 能兼容则加入现有gateway contract；否则给出有来源边界或显式新协议工作包 |
| T-REMOTE；Host integration owner                            | A2A/attached/plugin各自公布的model/role能力、Host fence                                       | 不向未声明服务下发child配置；不偷偷启动本机替代                        |
| T-AIDER；Aider integration owner                            | weak/editor独立请求、目录和统一预算                                                           | 完成aux多模型；native child保持有证据的unsupported                     |

### 15.3 验收场景要求实际请求证据

| ID  | Given / When / Then                                                                      | 最窄owner / 真实流                             |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| V01 | Claude主模型A/default child B，产生native child后上游分别收到A/B                         | SDK options/projector单测 + 固定SDK/Claude ACP |
| V02 | family与命名role不同，完整ID/继承/per-call交叉时按该版本规则执行                         | Claude projector/bridge + 实际Task/Agent       |
| V03 | child显式模型不存在、没有tools或账号丢失，启动或请求被明确拒绝，不消费primary            | compiler/admission + gateway拒绝               |
| V04 | Codex A/B和effort存在目录，spawn原生child后模型与effort正确                              | app-server与ACP分别真实probe                   |
| V05 | 缺目录、失效effort、project role和config_file路径异常分别有明确结果                      | Codex importer/projector + private filesystem  |
| V06 | 不同后端encrypted任务失败，不剥任务；经典选项显示能力代价并仅在支持版本生效              | Codex + 两后端真实失败/恢复                    |
| V07 | OpenCode V1/ACP/V2角色B与primary A不被强制改写，命令model也受授权                        | 原有schemas + 三种真实runtime                  |
| V08 | 同版本project overrides、fork/resume不扩大授权或回落全局模型                             | 核心runtime集成 + retained task                |
| V09 | Aider/Qwen辅助模型与native child标签分开；各aux请求目标正确                              | owning package + gateway请求捕获               |
| V10 | 全§3 runtime逐项有真实native证据或明确限制；OMP实际接线；DSH/Pi不虚报producer            | runtime gate + 真实probe记录                   |
| V11 | native目录、Cognia目录与Host目录同名模型保留来源和账号作用域                             | model options/surface/cache + UI               |
| V12 | 切Host、账号锁定、删除模型或晚到的异步结果不会覆盖新选择                                 | 现有cache/store tests + paired flow            |
| V13 | UI可浏览模型不自动进入task `/models`；task目录只含被授权子集，能力事实逐行正确           | catalog projection + gateway endpoints         |
| V14 | A/B两provider同名模型，父子并发各进明确deployment/key，串线0                             | Rust mock upstream A/B + 真实fixture           |
| V15 | 同provider两账号、默认账号切换或另一owner/device重放，授权保持冻结/请求拒绝              | lease/authority + vault/Host边界               |
| V16 | 伪造`cgm_`、带haiku子串、旧task selector和越权role均不走global fallback                  | route_ticket/server对抗测试                    |
| V17 | parent/children并发花费受一个aggregate budget约束，token/request reservation正确         | Rust budget/ledger集成                         |
| V18 | cancel、deadline、renew失败、账号撤销、进程崩溃和重复start都终结一次并释放timer/process  | manager/lease + native Host故障注入            |
| V19 | Messages/Chat/Responses、stream/tool/image/count_tokens/models均使用同一target与PII gate | gateway conformance + 现有translations         |
| V20 | 模板、插件、Team/Workflow、CLI/TUI逐次覆盖得到相同normalized plan，无丢字段              | co-located调用边界集成                         |
| V21 | Host-owned profiles、device-owned remote lease、local desktop分别正确；手机不收到秘密    | companion schema + headless/paired E2E         |
| V22 | importer导入Codex role/CC Switch mappings有preview/loss报告，未知字段/用户role保留       | import adapters + filesystem fixture           |
| V23 | 新旧client/Host/plugin组合与CAS冲突不丢策略；schema未知字段不被静默剥除                  | protocol contract + compatibility fixtures     |
| V24 | disable/rollback后v1可用、v2配置保留、运行中task按策略停止，不静默降级                   | release/rollback演练                           |

真实证据至少包括runtime executable/version/profile、脱敏配置和目录digest、plan fingerprint、请求selector、resolved provider/model及credential测试标识、terminal结果。不能只看生成TOML或模型自己的文字回答；mock upstream只证明协议/授权，认证供应商probe再证明产品兼容。无权威事件的child归属保留unknown。

### 15.4 复用测试入口，按改动选择检查

先为每个行为修复写失败用例并确认失败原因，再实现。修改governed源文件补同目录测试；`components/ui`、`components/ai-elements`不新增unit test文件。覆盖率本地仅在用户明确要求时运行，本方案没有开启coverage；CI现有changed-file gate继续有效。

以下是**实施阶段待执行命令**，不是本次已通过声明：

```sh
# shared contracts/catalog/admission，按实际变更追加同目录 suites
pnpm test --runInBand --runTestsByPath lib/ai/agent/external/config/gateway-task.test.ts lib/gateway/mint-session-ticket.test.ts lib/ai/agent/external/session/session-models.test.ts
pnpm test --runInBand --runTestsByPath lib/gateway/host-task-lease.test.ts lib/gateway/remote-task-lease.test.ts components/agent/external-agent/cognia-model-picker.test.tsx

# Native/Sandbox：使用现有workspace crate，不跳过Rust路径
cargo test -p cognia-gateway
cargo test -p cognia-sandboxd gateway_task
cargo test -p cognia-external-agent gateway_task

# generated manifests/contracts与架构复用
pnpm audit:agent-capabilities
pnpm audit:external-agent-runtimes
pnpm audit:package-boundaries
pnpm audit:sidecar-architecture
pnpm audit:rust-architecture
pnpm audit:colocated-tests
pnpm audit:command-parity
pnpm audit:companion-command-manifest
pnpm audit:invoke-arg-parity
pnpm audit:host-parity
pnpm audit:pii-boundaries

# UI、types与production边界
pnpm i18n:build
pnpm i18n:build:check
pnpm lint:i18n
pnpm lint:static-export
pnpm lint
pnpm typecheck
pnpm build
```

Sidecar修改使用现有 `pnpm run sidecar:test <实际修改suite路径>` / `pnpm sidecar:typecheck`，不向其runner追加不支持的独立`--`参数；package自身脚本以其package.json为准。插件改动同步TS/Python types、author-types生成与现有SDK检查，不新建平行测试runner。

E2E在现有`tests/e2e`按web/tauri/mobile归属扩展，必要的新spec标为拟新增：模型角色表单与capability错误→`pnpm test:e2e --project=chromium <spec>`；真实native→现有`pnpm test:e2e:tauri <spec>`和runtime smoke；配对设备→mobile项目与headless运行。复用[ACP smoke](../../scripts/smoke/acp-live.mjs)、[gateway process harness](../../tests/conformance/harness/gateway-process.mjs)和各vendor smoke，而不是再做第三个launcher。执行真实Tauri前按tauri-agent-debug/tauri-smoke，实施E2E前按cognia-e2e及当前治理规则补细化步骤。

至少Mac Apple Silicon完整走核心真实流；Linux/headless验租约、进程与路径；Windows验证私有配置/路径/启动，受runtime catalog平台限制的项标有来源的不适用。配对web/mobile验证功能，不能用browser fixture声称本机CLI已验收。跨协议/多账号生产开放前，真实供应商凭据与审批由既有授权范围决定，不因方案存在自动调用。

### 15.5 本次实际检查与未检查项

本次只新增方案，未实现上述行为。实际执行两组互不重叠的现有baseline tests：

1. `mint-session-ticket`、`host-task-lease`、`remote-task-lease`、`cognia-model-options`、`session-models`、`model-surface-cache`、`cognia-model-picker`：**7 suites / 169 tests通过**，Jest 1.673 s。
2. `gateway-task`、`presets`、`install-catalog`：**3 suites / 208 tests通过**，Jest 0.555 s。

合计 **10 suites / 377 tests通过**。这是当前复用基础的回归证据，不证明拟议v2策略已实现。方案另做格式、引用路径和结构检查；未运行全量lint/typecheck/build、Rust tests、coverage、真实推理或E2E。历史CC Switch研究中的测试结果不混入本次合计。

## 16. 决策、风险与实施前行动有明确 owner

### 16.1 推荐默认值使实施不依赖隐藏决策

| 决策                   | 选项                                          | 推荐 / 结果                                                                                            |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Q1 跨provider/账号默认 | 全开 / 全禁 / 经认证组合显式开启              | 同provider同account先开；跨provider/账号flag默认关，P4按runtime/version开放；所有runtime仍保留矩阵责任 |
| Q2 Codex加密任务不兼容 | 静默classic / 只同后端 / 明示classic选项      | 默认同后端；显式选择classic才降级并展示能力代价；不兼容组合不发布                                      |
| Q3 显式子模型失效      | 静默继承 / 阻断                               | 阻断并提供修复入口；未配置才继承，避免意外花费和错模型                                                 |
| Q4 全局配置与task配置  | 直接改用户home / 私有task投影                 | 继续私有task；CC Switch全局同步只沿既有显式操作                                                        |
| Q5 非兼容runtime / OMP | 用ACP选模冒充native / 隐藏 / 分能力认证并接线 | 分能力认证；OMP先接线再声明；缺认证环境标blocked，不掩盖为unsupported                                  |
| Q6 自由模型选择范围    | 整个provider目录授权 / 仅显式task子集         | 仅task子集，初始最多32targets；需要原生自由选模时用户明确加入允许集合                                  |

这些是方案推荐，评审可以修改；未修改时按推荐实现。不会因为需要评审就把核心数据结构或错误处理留空。

### 16.2 主要风险与解决责任

| 风险                                     | containment / owner                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| 外部CLI升级改变model/catalog/child优先级 | ADR-0237固定版本探针与identity认证；Agent integration owner撤回该版本能力            |
| selector映射与candidate分离导致错误账号  | Gateway owner强制exact deployment/model子集；V14–V16为发布阻断                       |
| 一次task角色增多放大token与并发          | Gateway owner复用aggregate reserve与bounded target数；不为每role新建无上限进程       |
| project自定义agents/plugin绕过投影       | Runtime/Host owner限制配置来源；最终gateway拒绝未知selector，权限不因配置声明扩大    |
| 旧Host/旧client清除新字段                | Host ownerfeature协商/CAS/旧schema写保护；V23未过不开放remote v2                     |
| vendor-native child无法观察完整lineage   | QA/Frontend明确unknown attribution；账本证明请求模型，不捏造子任务状态               |
| DSH/Pi/OMP能力声明大于已接线路径         | Integration owner同时验manifest、注册、producer和实际请求；built-but-dormant不计完成 |

### 16.3 实施前行动与建议评审时间

以下DDL是2026-10-20提出的**建议评审节点**，不是已确认开发排期；交付日期由完成P0后按工作包估算。

| 行动                                          | 单一owner role           | 建议DDL    | 关闭证据                                              |
| --------------------------------------------- | ------------------------ | ---------- | ----------------------------------------------------- |
| 确认Q1–Q6及支持矩阵验收口径                   | Agent技术负责人          | 2026-10-22 | 评审记录，任何范围变化逐项列出                        |
| 确认v2精确target契约与多账号authority         | Gateway/Rust负责人       | 2026-10-22 | 类型/schema草案、同名模型对抗用例、兼容决策           |
| 固定核心runtime版本与认证测试环境             | QA负责人                 | 2026-10-23 | T-CLAUDE/T-CODEX/T-OC探针清单、凭据授权与测试记录位置 |
| 校验RoleModelFields三入口复用及状态/i18n设计  | Frontend负责人           | 2026-10-23 | 组件复用diff计划、可访问性/Host状态稿                 |
| 给23rows及非静态入口分配具体integration owner | Agent integrations负责人 | 2026-10-23 | 每probe有负责人及证据要求，不再依赖generic ACP判断    |

### 16.4 评审记录与完成定义

| 轮次                   | 日期       | 结果 / 限制                                                                                   |
| ---------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 源码与复用审计         | 2026-10-20 | 已检查共享类型、目录/缓存、UI、dispatch、lease/ticket、Host/CLI、runtime packages；附全量矩阵 |
| 现有baseline验证       | 2026-10-20 | 10 suites / 377 tests通过；不含拟议行为验收                                                   |
| 方案结构/引用/格式审查 | 2026-10-20 | 已检查R1–R7、24个V场景、P0–P6和62个本地引用；格式按Prettier校验；后续修订重新检查             |
| 人工技术/安全/产品评审 | 待安排     | 未批准实施；Q1–Q6采用推荐值形成可评审版本                                                     |

完成条件：R1–R7逐项有证据，V01–V24按真实能力适用性关闭；每个runtime的native/aux/orchestrated/gateway状态明确，有blocker就保留；config→catalog→lease→actual request可关联；无重复注册表/路由器/账号选择器；release与rollback演练及双语用户文档完成。

## 17. 主要源码与后续维护入口

- 契约：[model-binding](../../packages/agent-contracts/src/model-binding.ts)、[adapter](../../packages/agent-contracts/src/adapter.ts)、[ecosystem](../../packages/agent-contracts/src/ecosystem.ts)、[execution types](../../packages/agent-config-types/src/agent-execution.ts)、[Provider Profile](../../packages/provider-types/src/provider-profile.ts)。
- 模型目录：[cognia-model-options](../../lib/ai/agent/external/config/cognia-model-options.ts)、[session-models](../../lib/ai/agent/external/session/session-models.ts)、[model-surface-cache](../../lib/ai/agent/external/capability/model-surface-cache.ts)、[use-cognia-gateway-models](../../hooks/agent/use-cognia-gateway-models.ts)。
- 配置/派发：[gateway-task](../../lib/ai/agent/external/config/gateway-task.ts)、[ExternalAgentManager](../../lib/ai/agent/external/manager.ts)、[dispatch](../../lib/plugin/agent-sdk/dispatch.ts)、[host-config-service](../../lib/ai/agent/external/config/host-config-service.ts)、[remote-host-configs](../../lib/ai/agent/external/runtimes/remote/remote-host-configs.ts)。
- 网关/文件边界：[task_lease](../../crates/cognia-gateway/src/task_lease.rs)、[route_ticket](../../crates/cognia-gateway/src/route_ticket.rs)、[server](../../crates/cognia-gateway/src/server.rs)、[sandbox task](../../crates/cognia-sandboxd/src/gateway_task.rs)、[CLI task](../../cli/src/runtime/external/gateway-task.ts)、[external-agent task](../../crates/cognia-external-agent/src/gateway_task.rs)。
- 能力生成：[capability catalog](../../lib/agent-ecosystem/capability-catalog.ts)、[runtime catalog](../../lib/agent-ecosystem/runtime-catalog.ts)、[gen-agent-capabilities](../../scripts/build/gen-agent-capabilities.mjs)、[gen-external-agent-runtimes](../../scripts/build/gen-external-agent-runtimes.mjs)。
- Runtime owner：`packages/agent-{claude-code,codex,acp,opencode,pi,dsh,aider,omp}/src`；ACP-only vendor留在现有vendor profiles。具体已确认状态与probe见§3、§15。
- 前置外部证据：[CC Switch对照研究](../research/2026-10-20-cc-switch-subagent-model-gateway-comparison.md)含固定SHA源文件与测试链接；不把main分支漂移后的实现混入当前结论。
