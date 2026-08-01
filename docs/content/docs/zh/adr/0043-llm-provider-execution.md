---
title: ADR-0043 — LLM 提供商执行与本地提供商支持
description: "弥合 Cognia 庞大的 LLM 提供商「配置面」与真实「发送路径」之间的断层。确立提供商解析器为 AI SDK 协议的唯一权威，为内置本地引擎（Ollama、LM Studio、llama.cpp、vLLM 等）提供可用的 OpenAI 兼容默认端点，并把每个提供商配置的推理参数透传进 sidecar 的 ai-sdk 分发器（而非丢弃）。同时记录后续分期路线图：工具调用对齐、多 Key 轮换、真实路由遥测、本地 embedding。"
---

# ADR-0043 — LLM 提供商执行与本地提供商支持

> 协议感知的建议性测速由 [ADR-0104 — 提供商诊断控制平面](/docs/zh/adr/0104-provider-diagnostics-control-plane) 定义。

**状态**：已接受（设计）；分阶段增量实现——请按阶段对照代码核实。在 `feat/unified-plan-execution-hub` 分支上，**非-Anthropic 派发器**部分——受门控的工具调用（Phase 2）、AI SDK v6 字段映射（`text` / `output` / `tool-error`）、内置本地引擎协议解析、以及 `modelParams` 透传——已在内置 Agent P0 波次中从 `qc-stash-backup` 快照恢复并落地（2026-06-03）。**Phase 3（多 key 轮换）**与 **Phase 4（路由遥测）**的发送路径接线**尚未进入本分支**：类型/UI 已存在，但 `selectApiKey` / `recordProviderOutcome` 在此尚未被 `build-options` / `use-claude-chat` 调用——推迟到 provider-routing 波次。
**作者**：Max Qian + Claude Opus 4.8
**基于**：多提供商移植（`SendOptions` 上的 `provider`/`providerCredentials`、`anthropic` 与 `ai-sdk` 双分发路径）、`lib/ai/provider-consumption.ts`、models.dev 目录同步，以及既有的提供商设置 UI（`components/settings/provider/*`，约 50 个组件）
**影响**：`lib/ai/provider-consumption.ts`、`lib/ai/providers/{inference-params,api-key-rotation,circuit-breaker-machine,health-metrics-collector,model-pricing}.ts`（新增）、`lib/ai/embedding/{embedding,local-embedding}.ts`、`lib/claude/{build-options,types,provider-telemetry}.ts`、`types/provider/provider.ts`、`stores/settings/{health-metrics,circuit-breaker}-store.ts`、`hooks/chat/use-claude-chat.ts`、`sidecar/dispatch/{ai-sdk,ai-sdk-tools,event-adapter,index}.mjs`、`sidecar/builtin-tools/index.mjs`

## 背景

Cognia 的提供商「配置面」异常完整：丰富的类型系统（`types/provider/*` —— 提供商/模型配置、10 个本地引擎、路由预设、熔断/负载均衡/健康指标类型）、四源模型发现合并（静态目录 → models.dev → 远端 `/v1/models` → 用户自定义）、`LocalProviderService`（status/list/pull/delete/stop/embedding，Tauri 命令 + HTTP 回退），以及约 50 个设置组件（侧栏、config/models/cost/parameters/routing/health 六个 tab、本地提供商安装向导、Ollama 模型管理器、自定义提供商对话框、快速添加、导入/导出、对比、批量测试）。

主聊天经由 sidecar 内的 Claude Agent SDK 运行（`sidecar/dispatch/anthropic.mjs`）。任何非-Anthropic 提供商走第二个分发器 `sidecar/dispatch/ai-sdk.mjs`，用 AI SDK 的 `streamText()` 跑一轮。`lib/claude/build-options.ts:resolveSendOptions` 把选中的提供商解析成 `provider` + `providerCredentials` 并内联下发，使 sidecar 保持「无凭证」。

**配置面远超执行路径。** 端到端审计发送路径暴露出具体断点：

1. **内置本地提供商一句话都发不出。** sidecar 的 `resolveProtocol` 只认 `openai/openrouter/deepseek/groq/mistral-openai-compat/google/gemini/mistral/cohere/anthropic`——完全没有本地引擎 id（`ollama`、`lmstudio`、`llamacpp` …）。而 `build-options` 只对**自定义提供商**转发 `providerCredentials.protocol`（`isCustomProvider ? protocol : undefined`）。于是选中内置 Ollama → `provider="ollama"` 且无 protocol → `resolveProtocol("ollama") === null` → `session_ended: provider "ollama" has no resolvable AI SDK protocol`。安装向导与 Ollama 模型管理器配好的提供商，聊天根本无法调用。同样的 `resolveProtocol`/`build-options` 不一致也悄悄打断了 OpenAI 兼容聚合商 `xai` / `togetherai` / `fireworks`。

2. **无密钥本地提供商没有默认端点。** 本地引擎不需要 API key，但需要 base URL。用户经向导启用 Ollama 却未填写时，解析器返回 `unresolved`（它要求 key 或 base URL 至少有一个），于是该轮永不分发。

3. **配置的推理参数被丢弃。** `ai-sdk.mjs` 把 `maxTokens: undefined, temperature: undefined` 写死进每次 `streamText` 调用。因此 parameters tab（温度、最大 token、惩罚项……）对每个非-Anthropic 提供商都只是装饰。

## 决策

把**提供商解析器视为唯一权威**，决定一轮运行所用的协议/端点/参数，并让 sidecar 尊重该权威，而非自行重新推导或丢弃。Phase 1 落地让内置本地提供商真正可用的地基，后续分期在其上叠加能力。

### Phase 1 —— 地基（已接受、已实现）

- **解析器内的本地 base-URL 默认值。** `lib/ai/provider-consumption.ts:resolveOne` 现在在内置本地提供商无显式 base URL 时回落到目录默认值（`LOCAL_PROVIDER_URLS`，经 `getOpenAICompatibleURL` 规范化为 OpenAI 兼容的 `/v1` 形态）。该逻辑在「需要 key 或 base URL」校验**之前**执行，因此无密钥本地引擎能干净地解析。用户显式 base URL 永不被覆盖。由于解析器同时服务聊天发送路径与插件 AI 表面，两者皆受益。

- **解析器始终转发 `protocol`。** `build-options.ts` 现在无条件设置 `providerCredentials.protocol = resolution.protocol`（此前仅自定义）。解析器本就知晓每个提供商的协议族（`BUILTIN_PROTOCOLS[id] ?? "openai"`，或自定义提供商声明的协议），因此这移除了「sidecar 从 id 重新推导协议」的脆弱依赖。Anthropic 提供商仍经 `dispatchAnthropic` 分发（按 provider id 选择，而非协议），故在该路径转发 `"anthropic"` 无副作用。

- **sidecar 的纵深防御。** `sidecar/dispatch/ai-sdk.mjs:resolveProtocol` 现在把每个内置本地引擎 id 映射为 `"openai"`，即使调用方忘记设置 `protocol` 也能分发。显式 `providerCredentials.protocol`（现已由 `build-options` 始终提供）仍优先。

- **推理参数抵达请求。** 新纯函数 `lib/ai/providers/inference-params.ts:buildModelInferenceParams` 把提供商持久化的 `inferenceDefaults` / `connectionParams` / `advancedParams` 翻译成 AI SDK v6 调用选项命名（`types/provider/provider.ts` 中的 `ModelInferenceParams`——注意 v5+ 重命名 `maxTokens → maxOutputTokens`；`topK`/`seed`/`stopSequences` 搭载于 `advancedParams`）。`build-options` 把结果挂到 `SendOptions.modelParams`；sidecar 将其展开进 `streamText` 取代写死的 `undefined`。新字段经 Rust `SendOptions` 既有的 `#[serde(flatten)] extra` 兜底字段传递，**无需改动 Rust 结构**。Anthropic 路径忽略 `modelParams`。

### Phase 2 —— 非-Anthropic 提供商的工具/MCP（已实现）

`sidecar/dispatch/ai-sdk-tools.mjs`（新）把内置工具定义（经新增的 `collectCogniaToolDefs` 导出与 Anthropic 路径共享）与渲染端代理的插件工具转换为 AI SDK 原生 tools；`ai-sdk.mjs` 将其传给 `streamText` 并设 `stopWhen` 步数上限（多步 agentic 循环），同时暴露 `pendingPluginToolCalls`，使插件工具经与 Anthropic 路径相同的 `plugin_tool_response` 通道往返。event-adapter 也按 AI SDK v6 字段名（`text`/`output`/`tool-error`）修正——这是个潜伏 bug，曾导致真实（非假事件）路径下助手文本为空。工具执行经与 Anthropic 路径相同的 `permission_request` 往返闸——`createToolPermissionGate` 镜像 `canUseTool`（suppress-list + 静态 ruleset 短路、尊重 `bypassPermissions`、否则经会话 `pendingApprovals` 等渲染端审批），本地模型无法静默运行 shell/process 工具。A2UI 仍仅 Anthropic。

### Phase 3 —— 多 API Key 轮换（已实现）

`lib/ai/providers/api-key-rotation.ts`（新）—— 纯 `selectApiKey`（在清洗后的 `apiKeys[]` 池上 round-robin / random / least-used）+ `recordKeyUse`（推进 `currentKeyIndex`、累加每 key 用量）。`build-options` 选下一个 key、覆盖单 key 凭证，并 fire-and-forget 回写 advance（动态导入设置 store，避开热路径）。

### Phase 4 —— 真实路由遥测（已实现）

`health-metrics-store` + `circuit-breaker-store` 两个 stub 被替换为 `types/provider/{health-metrics,circuit-breaker}.ts` 既有契约的真实实现，底层为纯模块：`health-metrics-collector.ts`（滑动窗口桶 → p50/p95/avg 延迟、成功/错误率、成本、趋势）与 `circuit-breaker-machine.ts`（closed→open→half-open 含冷却的 FSM）。`build-options` 现把这两个 store 喂入 `ProviderRoutingEngine` deps（熔断打开则将该 provider 移出轮换；`getPricing` 经 `model-pricing.ts` 解析），`lib/claude/provider-telemetry.ts`（新）在 `use-claude-chat` 每轮记录一次结果（result 事件成功 / `session_ended.error` 在任何 fallback 重发前记失败）。

### Phase 5 —— 本地 embedding（已实现）

`lib/ai/embedding/local-embedding.ts`（新）+ `getEmbeddingModel` 中的分支把 OpenAI 兼容本地引擎（LM Studio、llama.cpp、vLLM、LocalAI、Jan）经 AI SDK openai embedding 客户端 + 其 `/v1` baseURL 接通（Ollama 早已有原生路径）。vector embedding 适配层（`lib/vector/embedding.ts`）新增本地 provider id、无密钥处理与 baseURL 透传；twin embedding 设置（`twin-settings-tab` + `TwinRuntimeEmbeddingSettings`）现暴露本地引擎与 Base URL 字段，`use-twin-worker` 让无密钥 provider 无需 API key 即可激活。任何给出本地 `provider` + `baseURL` 的 RAG / twin / memory 调用方现在即本地向量化。

### Phase 6 —— ai-sdk 路径的无界 agentic 循环（已实现）

Phase 2 给 `streamText` 传入单个 `stopWhen` 步数上限。交互轮次不设 `maxTurns`，故该上限默认 **16 步**——单段——任何需要更多工具调用的任务在段上限掐断循环时静默结束。Anthropic 路径无此限制（Agent SDK 跑到模型完成为止），两条通道因此严重不对称，非-Anthropic 通道"跑一会儿就自动停"。`dispatchAiSdk` 现采用 AI SDK 官方的_手动 agent 循环_（`if (finishReason === "tool-calls") continue; else break`）：每段流式一个 16 步分块，以 `tool-calls` 收尾的段自动续跑——以累积对话重新流式，并**在段间**跑自动压缩以防长循环撑爆上下文——直到模型自然停止或耗尽本轮预算。预算 `maxStepsBudget` = `maxTurns`（子代理 / `/goal`）▸ 新增的 `aiSdkMaxSteps` 配置（默认 256）▸ 256；耗尽时若仍有工具待调，会追加一条可见的"再发一条消息可继续"提示，而非静默结束。同批对齐了 capture 侧空闲看门狗（`lib/claude/run-and-capture.ts`）：工具执行期间暂停（长本地工具不是提供商停流），并在工具返回或权限/审查决策派发时立即重新武装。

### Phase 7 —— 只读内置工具的单次执行截止时限（已实现）

Phase 6 的空闲看门狗暂停有一处利刃：若某工具的 `execute` 永不 resolve，看门狗一直暂停，本轮只能在 5 分钟**挂钟**上死亡（`session … did not end within 300000ms`）。在 ai-sdk 路径上，这恰好咬住只读文件工具——`content_search`、`file_search`、`glob`、`grep`、`read`、git 只读工具、`lsp_*`——它们遍历工作区且**没有内部截止**，故超大/含环目录会让 handler 挂起、拖垮整个会话超时。插件工具早有 120s 安全网（`awaitPluginToolResponse`），但此路径上的内置工具没有。

`dispatch/ai-sdk-tools.mjs` 现对每个只读内置 handler 设限（`runBuiltinHandler`）：handler 与一个截止时限竞速，超时则 `execute` reject，使 AI SDK 抛出可恢复的 `tool-error`。event-adapter 将其投射为带错的 `tool_result`，从而清空 in-flight 集合并**重新武装空闲看门狗**，本轮继续推进而非卡到挂钟。执行类工具（`bash` / shell / process / git-run）自带超时、被刻意**排除**（判据为 `READ_ONLY_TOOL_NAMES`）——一刀切的网会误杀合法的长命令。时限 = `sendOptions.toolExecutionTimeoutMs` ▸ 桥默认（120000ms）；CLI 从 `toolExecutionTimeoutMs` 配置取值（默认 120000，`0` 关闭），由 `session-runner` / `subagent-runner` 注入，与 `aiSdkMaxSteps` 完全同构。

## 后果

- 内置本地提供商（Ollama、LM Studio、llama.cpp、vLLM、LocalAI、Jan…）现在真正能跑一轮聊天，长期损坏的 `xai`/`togetherai`/`fireworks` 聚合商也能分发。
- 非-Anthropic 提供商上的多工具任务现在能跑到完成，而非约 16 步后静默停止；每轮步数预算可配置（`aiSdkMaxSteps`，默认 256），失控循环会显式提示上限而非无解释结束。
- 在大型工作区上挂起的只读内置工具（`content_search` 等）现在会在 `toolExecutionTimeoutMs`（默认 120s）后以可恢复的 `tool-error` 失败，而非把整个会话拖到 5 分钟挂钟；执行类工具保留各自（更长的）超时。
- 用户配置的采样设置终于对非-Anthropic 轮次生效。
- 协议 + 端点 + 参数由解析器一处决定，sidecar 信任它。新增一个 OpenAI 兼容提供商现在是目录/解析器的事，不再需要改 sidecar 分发表。
- `anthropic` 与 `ai-sdk` 的执行分叉仍在：主 agent 循环（MCP、权限、A2UI、computer-use）仍只存在于 Claude Agent SDK 路径。Phase 2 收窄但不消除该缺口。成熟的单路径设计（Cherry Studio、LobeChat、LibreChat）通过把每个提供商路由经同一个支持工具的客户端来避免分叉；Cognia 的分叉是把主循环绑定到 Claude Agent SDK 的有意后果。
