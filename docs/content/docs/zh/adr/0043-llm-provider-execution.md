---
title: ADR-0043 — LLM 提供商执行与本地提供商支持
description: "弥合Cognia庞大LLM-provider配置接口与实际发送路径之间的差距。确立提供商解析器作为协议的唯一权威AI SDK为内置本地引擎（Ollama、LM Studio、llama.cpp、vLLM等）提供一个可用的OpenAI-compatible默认端点，并将每个提供商配置的推理参数通过sidecar的 ai-sdk 调度器线程处理，而非丢弃它们。记录了工具调用对等性、多键旋转、实布线遥测和局部嵌入的分阶段路线图。"
---

# ADR-0043 — LLM 提供商执行与本地提供商支持

> 基于协议的咨询基准由[ADR-0104——提供商诊断控制plane](/docs/en/adr/0104-provider-diagnostics-control-plane)定义。

**状态**：已接受（设计）;增量实现——每阶段对代码进行验证。`feat/unified-plan-execution-hub`，**non-Anthropic调度器**工作——门控工具调用（第二阶段）、AI SDK v6现场映射（`text` / `output` / `tool-error`）、内置本地引擎协议解析和`modelParams`转发——从`qc-stash-backup`快照中恢复，并在内置代理P0波（2026-06-03）期间着陆。**阶段3（多键旋转）**和**阶段4（路由遥测）**的剩余发送路径布线尚未在该分支线上**：types/UI存在，但`selectApiKey`/`recordProviderOutcome`尚未从`build-options`/`use-claude-chat`被调用——推迟给提供商路由波。**作者**：Max Qian + Claude Opus 4.8 **基于**构建**多提供商端口（`provider`/`providerCredentials` on `SendOptions`，`anthropic`与`ai-sdk`调度分拆）、`lib/ai/provider-consumption.ts`、models.dev 目录同步，以及现有提供商设置UI（`components/settings/provider/*`，~50个组件）**影响**影响**：`lib/ai/provider-consumption.ts`，`lib/ai/providers/{inference-params,api-key-rotation,circuit-breaker-machine,health-metrics-collector,model-pricing}.ts`（新），`lib/ai/embedding/{embedding,local-embedding}.ts`，`lib/claude/{build-options,types,provider-telemetry}.ts`，`types/provider/provider.ts`，`stores/settings/{health-metrics,circuit-breaker}-store.ts`，`hooks/chat/use-claude-chat.ts`，`sidecar/dispatch/{ai-sdk,ai-sdk-tools,event-adapter,index}.mjs`，`sidecar/builtin-tools/index.mjs`

## 背景

Cognia 拥有**异常完整的提供商配置 接口：丰富的类型系统（`types/provider/*` — provider/model 配置、10 个本地引擎、路由预设、circuit-breaker/load-balancer/health-metric类型）、四个源模型发现合并（静态目录→ models.dev →远程`/v1/models` →用户策划）、`LocalProviderService`（status/list/pull/delete/stop/embedding 带有 Tauri 命令 + HTTP 回退），以及 ~50 个设置组件（侧边栏、config/models/cost/parameters/routing/health标签页、本地提供商设置向导、Ollama 模型管理器、自定义提供商对话、快速添加、import/export、比较、批处理测试）。

主聊天通过sidecar（`sidecar/dispatch/anthropic.mjs`）的 Claude Agent SDK 进行。任何non-Anthropic 提供商都经过第二个调度员 `sidecar/dispatch/ai-sdk.mjs`，该调度员对 AI SDK 的`streamText()`进行一轮。`lib/claude/build-options.ts:resolveSendOptions`将选中的提供商解析为`provider` + `providerCredentials`并将它们内联发送，使sidecar保持无凭证。

**配置接口远超执行路径。** 审计端到端的混凝土断裂发送路径：

1. **内置本地提供商无法发送任何回合。** sidecar的`resolveProtocol`只识别`openai/openrouter/deepseek/groq/mistral-openai-compat/google/gemini/mistral/cohere/anthropic`——本地引擎ID（`ollama`、`lmstudio`、`llamacpp`......）都不识别。`build-options`只转发`providerCredentials.protocol`**用于自定义提供商**（`isCustomProvider ? protocol : undefined`）。因此选择内置Ollama产生了没有协议→ `resolveProtocol("ollama") === null` → `session_ended: provider "ollama" has no resolvable AI SDK protocol`的协议`provider="ollama"`。设置向导和 Ollama 模型管理器配置了一个聊天永远无法调用的提供商。同样的`resolveProtocol`/`build-options`不匹配也悄悄导致OpenAI-compatible聚合器 `xai` / `togetherai` / `fireworks` 都崩溃了。

2. **无密钥本地提供商无默认端点。**本地引擎不需要API密钥，但需要基础URL。当用户通过向导启用Ollama但未输入密钥时，解析器返回`unresolved`（需要*键*或*基础URL），因此回合从未分派。

3. **配置好的推理参数被删除。**`ai-sdk.mjs`硬编码`maxTokens: undefined, temperature: undefined`进入每个`streamText`调用。提供商参数标签（温度、最大令牌、惩罚等）因此对每个non-Anthropic 提供商都具有装饰性。

## 决策

把**提供商解析器当作决定回合要protocol/endpoint/params什么的唯一权威**，让sidecar尊重这个权威，而不是重新推导出或废弃它。第一阶段奠定了让内置本地提供商真正发挥作用的基础;后续阶段则在基础上逐步提升能力。

### 第一阶段 — 基础（已接受，已实施）

- **解析器中的本地base-URL默认设置。**当内置本地提供商没有显式基URL时，`lib/ai/provider-consumption.ts:resolveOne`现在会退回到目录默认（`LOCAL_PROVIDER_URLS`，通过`getOpenAICompatibleURL`规范化到OpenAI-compatible `/v1` 接口）。这在“需要密钥或基基URL”保护之前运行，因此无密钥的本地引擎能干净利落地解析。显式用户基URLs永远不会被覆盖。因为解析器同时提供聊天发送路径和插件AI 接口，两者都受益。

- **解析器总是转发`protocol`。**`build-options.ts`现在无条件设置`providerCredentials.protocol = resolution.protocol`（之前仅自定义）。解析器已经知道每个提供商的族（`BUILTIN_PROTOCOLS[id] ?? "openai"`，或自定义提供商声明的协议），因此这消除了对sidecar重推协议的脆弱依赖。Anthropic 提供商继续通过`dispatchAnthropic`（由提供商 id选择，而非协议）进行调度，因此转发`"anthropic"`在那里是不活跃的。

- **sidecar中的防御纵深。** `sidecar/dispatch/ai-sdk.mjs:resolveProtocol`现在将每个内置本地引擎ID映射到`"openai"`，因此即使呼叫者忘记设置`protocol`，回合依然有效。显式`providerCredentials.protocol`（现在从`build-options`一直存在）依然优先。

- **推理参数到达请求。** 新的纯辅助器`lib/ai/providers/inference-params.ts:buildModelInferenceParams`将提供商持久化的`inferenceDefaults` / `connectionParams` / `advancedParams`转换为AI SDK v6调用选项命名（`types/provider/provider.ts`中`ModelInferenceParams`——注意v5+重命名`maxTokens → maxOutputTokens`;`topK`/`seed`/`stopSequences` ride in `advancedParams`）。`build-options`将结果附加到`SendOptions.modelParams`;sidecar将其扩展到`streamText`，而非硬编码的 `undefined`s。新场域通过Rust `SendOptions`现有的 `#[serde(flatten)] extra` 覆盖所有，因此**不需要Rust结构变更**。拟人路径忽略`modelParams`。

### 第二阶段 — Tool/MCP non-Anthropic 提供商（已接受，已实现）

`sidecar/dispatch/ai-sdk-tools.mjs`（新版）将内置工具的定义（通过新`collectCogniaToolDefs`导出与Anthropic路径共享）和渲染代理插件工具转换为原生AI SDK工具;`ai-sdk.mjs`将它们传递给`streamText`，并设置了`stopWhen`步上限（多步代理循环），并暴露`pendingPluginToolCalls`使插件工具能通过与Anthropic路径相同的`plugin_tool_response`通道往返。事件适配器还针对AI SDK v6字段名（`text` / `output` / `tool-error`）进行了修正——这是一个潜在的漏洞，曾在真实（非假事件）路径上返回空助理文本。工具执行受与Anthropic路径相同的`permission_request`来封禁——`createToolPermissionGate`镜像`canUseTool`（抑制列表+静态规则集短路，尊重`bypassPermissions`，否则通过会话`pendingApprovals`解决渲染器批准），因此本地模型无法静默运行shell/process工具。A2UI仍仅限Anthropic。

### 第三阶段——Multi-API-key旋转（已接受，已实施）

`lib/ai/providers/api-key-rotation.ts`（新）——纯`selectApiKey`（轮询/随机/在清理后的`apiKeys[]`池中最少使用）+ `recordKeyUse`（提前`currentKeyIndex`，按键使用次数增加）。`build-options`选择下一个键，覆盖单键凭证，并持续执行高级触发后不等待（动态导入设置存储，离开热路径）。

### 第四阶段 — 实路由遥测（已接受实现）

`health-metrics-store` + `circuit-breaker-store` 存根被`types/provider/{health-metrics,circuit-breaker}.ts`中已定义的合同的真实实现取代，基于纯模块构建：`health-metrics-collector.ts`（滑动窗口桶→ p50/p95/avg延迟、success/error速率、成本、趋势）和`circuit-breaker-machine.ts`（闭合→开启→半开的冷却）FSM）。`build-options` 现在将这些存储输入`ProviderRoutingEngine` deps（断路器从轮换中下降一提供商;`getPricing`通过`model-pricing.ts`解决），`lib/claude/provider-telemetry.ts`（新）每回合记录一个`use-claude-chat`结果（结果事件成功，`session_ended.error`失败，未回退重新发布前）。

### 第五阶段 — 局部嵌入（已接受，已实现）

`lib/ai/embedding/local-embedding.ts`（新）+ `getEmbeddingModel`中的一个案例将OpenAI-compatible本地引擎（LM Studio、llama.cpp、vLLM、LocalAI、Jan）通过AI SDK openai嵌入客户端及其`/v1` baseURL路由（Ollama 已有原生路径）。向量嵌入适配器（`lib/vector/embedding.ts`）获得了本地提供商 ID、无键处理和baseURL直通;双嵌嵌入设置（`twin-settings-tab` + `TwinRuntimeEmbeddingSettings`）现在会暴露本地引擎和基础 URL 字段，`use-twin-worker`在没有 API 键的情况下激活无键提供商。任何提供本地 `provider` + `baseURL` 的 RAG/孪生/内存调用器都会嵌入本地。

### 第六阶段 — ai-sdk 路径上的无界代理循环（已接受，已实现）

第二阶段向`streamText`传递了一个单`stopWhen`步上限。对于交互转弯，`maxTurns`未设定，因此该上限默认为**16步**——一条单段——任何需要更多工具调用的任务在腿位上限停止环路时无声终止。人形路径没有这样的限制（Agent SDK循环直到模型完成），因此两个通道严重不对称，non-Anthropic通道“过一段时间后自行停止”。`dispatchAiSdk`现在运行AI SDK-blessed _manual代理 loop_（`if (finishReason === "tool-calls") continue; else break`）：每条腿流 16 步块，`tool-calls` 停止的 段自动继续——重新流式累积的对话并运行自动压缩 **在各段之间**，确保长环路不会溢出上下文——直到模型自然停止或每回合预算耗尽。预算`maxStepsBudget`为 `maxTurns`（子代理 / `/goal`）ⁿ 新的`aiSdkMaxSteps`配置（默认 256）♬ 256;在工具仍在待处理时到达该位置，会附加一个可见的“发送另一条消息以继续”的备注，而不是静默停止。捕获侧的空闲看门狗（`lib/claude/run-and-capture.ts`）在同一次处理中进行了对齐：它现在在工具执行时暂停（长的本地工具不是提供商停滞），并在工具返回或permission/review决策发出时立即重新武装。

### 第七阶段 — 只读内置工具的每个工具执行截止时间（已接受，已实现）

第六阶段的闲置看门狗暂停机制有明显优势：如果工具的`execute`永远无法解决，看门狗会保持暂停状态，回合只有在5分钟的**墙上计时**（`session … did not end within 300000ms`）时才会终止。在AI-SDK路径上，这会咬伤只读文件工具——`content_search`、`file_search`、`glob`、`grep`、`read`、git read工具`lsp_*`等——它们在工作区中没有内部截止时间，因此一个巨大的循环树会使处理器卡住，整个会话超时。插件工具已经有120秒的安全网（`awaitPluginToolResponse`）;而这条路径上的内置工具则没有。

`dispatch/ai-sdk-tools.mjs`现在对每个只读内置处理器（`runBuiltinHandler`）进行了界限：处理器与截止时间竞速，超时`execute`拒绝，因此AI SDK 接口可恢复的`tool-error`。事件适配器将此投影为错误`tool_result`，从而清除飞行中的集并**重新激活空闲看门狗**，使回合继续移动，而不是停滞到墙钟。执行工具（`bash` / shell / 进程 / git-run）自绑且有自己的超时，并且被故意**排除**（判别器是`READ_ONLY_TOOL_NAMES`）——一张全面网可以切断一个真正长的命令。截止时间是`sendOptions.toolExecutionTimeoutMs` ◉ 桥默认（120,000 ms）;CLI从 `toolExecutionTimeoutMs` 配置（默认 120,000 毫秒，`0`禁用）中获取，通过 `session-runner` / `subagent-runner` 注入，完全像`aiSdkMaxSteps`。

### 第8阶段 — 入站网关加固（已接受，已实现）

M3 入站网关（`src-tauri/src/gateway/`）将配置后的提供商暴露为本地OpenAI/Anthropic-compatible端点。其首次切割携带单一承载令牌，无上游超时，硬编码的故障切换状态设置，内存内 25 条请求环，以及非持久配置（`port`/allowlist/rate-limit每次重启都会重置，“`enabled`自动启动”启动路径从未触发）。研究 newapi / oneapi 形成了一个硬化通道，既保持环回优先安全态势，又增加了这些网关著名的自定义功能：

- **配置持久化。** `GatewayConfig`在自动启动检查前的Tauri设置hook中镜像并水合到`<app_data>/cognia/gateway-config.json`，因此监听器确实会在重启后继续。请求时间字段（超时、重试策略、模型暴露）存在于运行中的服务器每次请求读取的`Arc<RwLock<GatewayConfig>>`中——无需重启即可应用;绑定时间字段（端口、绑定接口、允许列表、连接超时、全局速率限制）在`start`时被快照。
- **多重作用域API密钥**（`gateway/api_keys.rs`）。单个令牌成为密钥环支持的`GatewayApiKey { name, secret, modelAllowlist, expiresAt, enabled, rateLimitPerMin, lastUsedAt }`列表——newapi的“令牌”模型。认证在常数时间内匹配任何可用密钥;匹配密钥的模型允许列表和每密钥速率限制每次请求都被强制执行。遗留单一令牌在首次加载时迁移到“默认”密钥。密钥除非在显式揭示时Rust不离开;列表被涂黑为指纹。
- **超时+重试策略。** `connectTimeoutSecs` 限制每个请求（包括流媒体）的连接;`requestTimeoutSecs` 只限制非流式请求（流从不被完全限制）。`maxRetries`限制候选路径，`retryStatusCodes`替换硬编码的 `429|408|5xx` 集。
- **模型暴露。** `exposedModels`允许列表和`hideRawProviderModels`切换过滤器同时用于`/v1/models`和请求解析;结合每个密钥允许列表，这产生了两个独立的门禁（网关在所有情况下所服务的服务与某一密钥可能调用的）。
- **LAN绑定**（选择加入）。`bindInterface: "loopback" | "lan"`绑定`0.0.0.0`并放宽对LAN节点的回环主机检查，同时保留交叉起源（Origin/Referer）拒绝、IPv4允许列表（默认仍仅回环——因此切换到LAN不会暴露任何信息）和密钥认证。通过浏览器DNS-rebinding仍被未变的起源拒绝阻挡。
- **持久请求日志**（Dexie **v99** `gatewayRequestLog`）。网关每个请求发出一个合并`gateway://request-log`事件（成功、上游失败或中间件拒绝）;`GatewayProvider`将其持久化到一个有上限的表，设置“日志”视图通过带有outcome/model过滤器和使用图块的实时查询读取——即newapi日志页面。`gateway://request-outcome`仍然不变地将共享health/breaker/cost遥测数据输入。

## 后果

- 内置的本地 提供商（Ollama、LM Studio、llama.cpp、vLLM、LocalAI、Jan 等）现在实际上运行聊天轮流，长期存在的 `xai`/`togetherai`/`fireworks` 聚合器也会发送。
- 多工具任务non-Anthropic 提供商完成，而不是在约16步后默默停止;每回合步预算可配置（`aiSdkMaxSteps`，默认256步），且失控循环接口可见的上限音符，而非无解释结束。
- 一个只读内置工具挂在大型工作区（`content_search`等）后，作为可恢复`tool-error`在`toolExecutionTimeoutMs`（默认120秒）后失败，而不是将整个会话拖到5分钟的墙时钟;执行工具则保留自己的（更长）超时。
- 用户配置的采样设置最终会影响non-Anthropic回合。
- 解析器是唯一决定协议 + 端点 + 参数的地方;sidecar信任它。添加新OpenAI-compatible 提供商现在是catalog/resolver问题，而非sidecar调度表编辑。
- `anthropic`与`ai-sdk`执行分支依然存在：主代理循环（MCP、权限、 A2UI、计算机使用）仍然只存在于Claude Agent SDK路径中。第二阶段缩小了这一空白，但并未完全消除。成熟的单路径设计（如 Cherry Studio、LobeChat、LibreChat）通过一个具备工具能力的客户端路由每个提供商来避免分支;Cognia的分叉是有意将主环与Claude Agent SDK绑定的后果。

### 第 9 阶段 — Gateway 本地 Policy V2 路由（已接受，已实现）

Gateway 请求现在由 Rust `RoutePlanner` 基于经过校验且带版本的策略快照完成解析。显式别名独立采用 `priority`、`weighted` 或 `round-robin` 分配；虚拟模型 `auto` 会先执行能力、可用性、协议、上下文、映射条件和冷却过滤，再应用配置的内置策略。OpenAI 与 Anthropic 仍是唯一可执行的线协议；其他提供商可在配置中展示，但不会进入可执行候选链。

部署轮换与凭据轮换是两类独立预留。部署游标按策略版本、路由和合格候选集指纹隔离；凭据游标按部署和凭据池指纹隔离。凭据池变化会安全重置选择，空白或重复密钥会被移除，全冷却池返回 `503` 与 `Retry-After`。除非经过验证的路由票据明确允许认证故障转移，否则认证错误不会切换凭据或提供商。

重试仍严格限制在首个响应字节提交之前。候选链同时受 Gateway 重试配置和策略回退上限约束；封顶指数退避共享同一个总等待预算，并遵循上游恢复响应头。策略快照在请求路径之外编译；无效 V2 快照会保留上一份有效快照，而不会降级到未过滤链路。
