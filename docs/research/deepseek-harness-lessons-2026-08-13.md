# DeepSeek Harness 深度研究与 Cognia 借鉴建议

> 研究日期：2026-08-13  
> DeepSeek Harness 基线：`47f943859bef60e4160492346772ded9b24f765a`（`master`，`0.1.0-rc.5`）  
> Cognia 对照基线：`68e8dc3b178c5813a471a01e4f55770ab2dd69fe`（`dev`）；另单独标注研究时 dirty worktree 中正在开发的 lifecycle 变更  
> 研究方法：只使用两个仓库的源码、README/架构文档、Git 元数据及 DeepSeek 官方 GitHub 仓库材料。Cognia 工作区存在大量与本报告无关的未提交修改；本研究只新增本文档，未修改产品代码。

## 结论先行

DeepSeek Harness（下文简称 DSH）不是“训练模型、跑 RL rollout、按 reward 更新策略”的训练框架，而是一个面向软件工程 agent 的、可嵌入和可替换的运行时。它最有价值的不是某个 DeepSeek 模型适配器，而是四组工程纪律：

1. **把 agent loop 拆成显式、可拦截、可替换的能力缝隙**：Agent、Session、LLM、Tool、Filesystem、Subprocess、Sandbox、Subagent、Workflow 都有独立 service contract；实现由插件挂载。
2. **把“模型看见过什么”统一成可重放的追加事件日志**：turn、step、user、assistant chunk/message、tool call/result 都有稳定事件语义，恢复、分叉、UI、遥测和上下文派生都从同一日志出发。
3. **工具执行是多阶段安全流水线，而不是直接调用函数**：`pre-execute → monotonic guards → execute → post-execute → finalize → immutable result`，权限、审批、超时、沙箱和结果改写各有固定位置。
4. **资源所有权是一等契约**：创建 agent/workflow/subagent 后，谁持有 handle，谁必须 `dispose()`；插件卸载通过可逆 effect 释放注册和进程，取消与清理有明确的 quiescence 语义。

对 Cognia 来说，最值得借鉴的是这些“运行时契约”和“可验证的不变量”，不是把 Cordis 或 DSH 整仓搬进来。Cognia 已经在产品广度、可视化工作流、评测、跨设备/Headless、插件市场、远程执行和多种 agent 生态上明显更强；真正的短板是内建聊天主链仍跨 React hook、Rust sidecar、Node host 和若干持久化投影分散，缺少一个像 DSH `SessionEvent` 那样统一、可重放、可证明的 agent execution spine。

优先级最高的建议是：

- **P0：定义 Cognia 的统一 `AgentRuntimeEventV1` 与 turn/step/tool 生命周期不变量，先旁路记录，不立刻重写现有消息存储。**
- **P0：把现有权限、插件 hook、sandbox、timeout、telemetry 收敛成一个有固定顺序的 tool execution pipeline。**
- **P1：在现有 PluginContext/registry 上落实 agent/session scoped capability 与统一 disposer ledger，不引入 Cordis。**
- **P1：用 Cognia 已有 eval engine 补上 DSH 明确缺失的 independent verifier；若实现 Ralph 类循环，必须由 verifier 决定继续/完成，而不是信任 worker 自报。**

## 1. 项目定位、成熟度与代码规模

官方 README 将 DSH 定义为 DeepSeek AI 开源的 agent harness，核心口号是 “everything is a plugin”，底层使用 Cordis；同时明确标注 **developer preview** 并警告会有破坏性兼容变更。当前源码根包版本为 `0.1.0-rc.5`，要求 Node `^22.19.0 || >=24.0.0`，官方入口是 `npx @deepseek-ai/dsh web`，也提供源码运行、Headless 和 Python SDK。证据：[`README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md)、`package.json`。

本地 Git 与官方 repository API 元数据显示：

- HEAD 为 `47f943859b...`，提交信息为 `Merge pull request #2519 from deepseek-harness/feat/npm-public`；
- 历史中有 12,293 个 commit，可见仓库并非一个小型 demo；
- `packages/` 与 `apps/` 下共有 228 个 `package.json`，测试文件约 647 个；
- 官方 GitHub repository id 为 `1333065091`，仓库公开、未归档，默认分支为 `master`；
- **公开仓库创建于 2026-08-13T11:56:32Z**，但导入历史的根提交 `b67e81ac97647270b3002d78532baf3a5b68cbc3` 可追溯到 2026-06-10；这表示“内部开发历史很多”和“公开生态刚上线”同时成立；
- GitHub Releases 与 Tags 在研究时均为空；`rc.5` 不能等同于已有稳定 release channel。

这些数字说明 DSH 对接口隔离、发布颗粒度和验证投入很大，但不能用导入 commit 数量推断公开社区成熟度。由于目前仍是刚公开的 RC developer preview，本文把它视为**高质量设计样本**，而不是稳定依赖。来源：[仓库 API](https://api.github.com/repos/deepseek-ai/deepseek-harness)、[根提交](https://github.com/deepseek-ai/deepseek-harness/commit/b67e81ac97647270b3002d78532baf3a5b68cbc3)、[Releases](https://github.com/deepseek-ai/deepseek-harness/releases)、[Tags](https://github.com/deepseek-ai/deepseek-harness/tags)。

## 2. 总体架构

### 2.1 Cordis 插件树，而非传统“核心 + 插件”

DSH 的运行实例是一棵 Cordis plugin tree。模型适配器、agent loop、tool registry、session log、sandbox、settings、credentials、telemetry 乃至 Web UI 都是插件。插件向共享 `Context` 提供 service、typed event 和 reversible effect；插件卸载时注册按作用域撤销。官方架构文档甚至明确写道“没有需要打补丁的 privileged core”。证据：[`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md) 的 `Cordis`、`Core packages`、`Where new behavior goes`。

启动配置通过四层组合完成：

```text
bundle rows（按 profile 顺序）
  → profile/cordis.patch.yml
  → $DSH_HOME/cordis.patch.yml
  → CLI --patch overlay
  → Cordis plugin tree
```

`dsh-base` 提供 agent 基础能力，`dsh-web-app` 增加浏览器应用，`dsh-headless` 增加一次性无服务器 runner。每行配置都有 id，可被上层 patch 整行替换；`dsh --profile web --dump-config` 可查看最终挂载树。证据：`packages/bundle/base/README.md`、`packages/bundle/headless/README.md`、`packages/boot/app-boot/README.md`，以及 [`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md) 的 `Profiles and bundles`。

### 2.2 它实际可以做什么

默认 Web coding preset 不只是聊天壳。官方配置组合了 Bash/PowerShell、文件读写与搜索、后台 jobs、skills、goals、plan mode、上下文压缩、continuable/fork subagent、动态 workflow、Ralph、todo、ask-user 与 DeepSeek Web Search。Code preset 还把多工具调用折叠成 `run_code` 内的程序化编排，减少模型往返。Codex 与 Claude Code subagent provider 已实现，但标准 preset 中默认 `disabled: true`，不能描述为无需配置即可用。证据：[`apps/cli/config/agent-presets/standard/agent.cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/standard/agent.cordis.yml)、[`apps/cli/config/agent-presets/code/agent.cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/code/agent.cordis.yml)、[`docs/tool-catalog.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-catalog.md)。

模型层既有原生 DeepSeek adapter，也有基于 pi-ai 的多供应商/自托管 OpenAI-compatible route。MCP client 支持 stdio 与 Streamable HTTP、热重载、重连和工具列表变化，但当前只把 MCP Tools 接进模型工具面，Resources/Prompts 尚无 consumer。证据：`packages/llm/llm-deepseek/README.md`、`packages/llm/llm-pi-ai/README.md`、[`packages/mcp/mcp-client/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/mcp/mcp-client/README.md)。

### 2.3 核心 spine

| 层            | 关键服务/符号                                    | 职责                                                            |
| ------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Session       | `Session`, `SessionStore`                        | 追加事件日志、分叉、内存会话、flush；持久化由外部 provider 订阅 |
| Agent         | `Agent`, `AgentRegistry`, `AgentHandle`          | agent 身份、inbox、状态、followup/steer/inject、取消、所有权    |
| Agent loop    | `AgentImpl`、driver                              | claim 输入、turn/step、请求模型、执行工具、收尾                 |
| Prompt        | `ctx.systemPrompt`                               | 插件注册 prompt section，按 scope 组装                          |
| LLM           | `ctx.llm`                                        | provider route 与 streaming vocabulary                          |
| Tools         | `ToolRuntime`, `ToolDefinition`, `ToolExecution` | schema registry、权限/guard/执行/结果流水线                     |
| Capability    | `FileSystem`, `SubprocessRuntime`, `Sandbox` 等  | service definition 与 provider 可替换                           |
| Orchestration | `SubagentRuntime`, `WorkflowEngine`              | 子 agent、动态 JS workflow、Ralph 循环                          |

这些包之间通过 service 和事件连接，而不是互相导入具体实现。例如扩展包依赖 `@deepseek-ai/dsh-agent`，不依赖 `agent-loop`；Filesystem 与 Subprocess provider 被替换成 E2B 后，Bash、PTY、LSP 消费者一起进入同一个远端 execution world。证据：`packages/core/agent/src/index.ts` 的 `AgentRegistry`、`packages/core/agent/src/runtime-types.ts` 的 `Agent`/`AgentHandle`、`packages/fs/fs/src/index.ts` 的 `FileSystem`、`packages/subprocess/subprocess/src/index.ts` 的 `SubprocessRuntime`。

## 3. 一次任务的执行流

DSH 明确区分 **turn** 与 **step**：一个 step 是一次模型请求及其请求的工具调用；一个 turn 可以包含零到多个 step。简化后的顺序如下：

```text
Agent.followup/steer/inject
  → durable inbox splice
  → turn/start
  → claim next-step context + one next-turn prompt
  → agent/pre-step waterfall（reject 或 rewrite）
  → step/start
  → user/message*
  → system-prompt/assemble
  → agent/request waterfall
  → llm/stream waterfall
  → assistant/chunk*
  → assistant/message
  → tool/call*
  → tool pipeline
  → tool/result*
  → step/end
  → 若工具或 inbox 仍要求继续，则下一 step
  → agent/turn-stopping
  → turn/end(completed|max-tokens|aborted|blocked|error|interrupted)
```

精确序列见 [`docs/agent-lifecycle.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/agent-lifecycle.md)。具体实现集中在 `packages/core/agent-loop/src/agent.ts` 的 `AgentImpl` 与请求/step 驱动逻辑、`packages/core/agent-loop/src/tool-calls.ts` 的工具调度；公开面定义于 `packages/core/agent/src/runtime-types.ts`。

几个值得注意的语义：

- `followup` 进入独立的下一 turn；`steer` 尽量进入最近的 step boundary；`inject` 只注入上下文且不主动唤醒。
- `agent/pre-step` 返回的 reject 是权威决定；即使首个 batch 被拒绝或改写为空，也会留下一个没有 step 的已关闭 turn，记录这次尝试。
- `assistant/chunk` 原样入日志以保证 UI 流式回放；`assistant/message` 是成功 provider call 的稳定结果，即使内容为空也记录 usage 与 chunk 来源序列。
- 取消不是一个模糊布尔值。`Agent.cancel(cause, options)`、`whenIdle()`、`runMaintenance()` 和 `dispose()` 分别处理活动中断、整体静止、非 turn 维护任务和所有权释放。

## 4. Task / Env / Agent / Rollout / Verifier / Reward / Data 抽象审计

这是理解项目用途最容易误判的地方。DSH 的强项是 agent runtime，不是 RL/eval harness。

| 概念        | DSH 是否一等抽象           | 实际对应物                                                                    | 判断                                                                                                  |
| ----------- | -------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Task        | **否**                     | Headless positional `task: string`、Ralph `objective`、workflow `args`        | 没有统一 `Task` 接口、任务状态机、数据集 case 或 reset 协议；任务只是进入 Agent 的输入                |
| Environment | **部分**                   | `FileSystem`、`SubprocessRuntime`、`Sandbox`、E2B shared owner、cwd/workspace | 是“执行世界能力组合”，不是 RL 的 `reset/step/observation` environment                                 |
| Agent       | **是，且很强**             | `Agent`, `AgentRegistry`, `AgentHandle`, `Inbox`, `AgentOptions`              | 身份、消息路由、作用域、生命周期、模型 route、session 都有明确契约                                    |
| Rollout     | **否**                     | turn/step、Python `Session.run()` 的 owned activity interval、`WorkflowRun`   | 可以把一次 run 的事件投影成 trajectory，但没有 `Rollout` 类型、采样策略、batch、seed 或 rollout store |
| Verifier    | **否**                     | tool schema/guard/invariant 只验证协议与安全；不验证任务完成正确性            | `tool-ralph` 明确说 completion 由 worker 自报，independent evaluator/verifier 尚未实现                |
| Reward      | **否**                     | 无 reward function、score aggregate 或训练反馈                                | telemetry/usage 不是 reward；tool result 也不是任务质量评分                                           |
| Data        | **运行数据强，评测数据弱** | `SessionEvent` append log、JSONL/SQLite persistence、projection/cache         | 会话数据是核心；dataset/schema/import/split/golden reference 不存在                                   |

关键一手证据：

- `BENCHMARK.md` 只有“使用 Python SDK、为独立 benchmark task 使用不同 workspace/session id”的运行指引，没有 dataset、scorer、verifier、reward contract。
- `packages/workflow/tool-ralph/README.md#Known Limitations and Deferred Work` 明确写明：完成是 worker self-declaration，没有 independent evaluator/verifier；token、price、elapsed budget 也 deferred。对应实现是 `packages/workflow/tool-ralph/src/index.ts` 的 `RALPH_SCRIPT`、`readRunResult()` 与 `apply()`。
- Python SDK 的 `Session.run()` 返回 `RunResult(session_id, final_response, finish_reason, events, notifications, session_root)`；它描述 prompt 入 inbox 后直到整体 idle 的 owned interval，而不是与 prompt 因果绑定的 rollout。证据：[`python/sdk/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md)。

因此，DSH 可作为 Cognia agent execution contract 的参考，不能替代 Cognia 的 `lib/ai/eval/*`。

## 5. 关键抽象详解

### 5.1 Agent 与 Inbox

`Agent` 公开 `id/options/session/inbox/status/ctx`，以及 `cancel`、`whenIdle`、`runMaintenance`、`send`、`followup`、`steer`、`inject`。`AgentHandle` 再加 `dispose()`，形成“只有 handle holder 能销毁”的 capability。`AgentRegistry.create/resume()` 还支持一个未发布阶段的 `setup(agentCtx)` 事务：先把 agent-local 能力装好，随后才发布 agent/session；setup、commit 或 publication 失败会整体回滚。证据：`packages/core/agent/src/runtime-types.ts` 的 `Agent`/`AgentHandle`/`AgentSetup`，`packages/core/agent/src/index.ts` 的 `AgentRegistry.create()`、`resume()`、`setFactory()`。

Inbox 不是普通内存数组。`packages/core/agent/src/inbox.ts` 的 `Inbox` 通过 `agent/inbox/spliced` 写入 Session log，并把 `next-turn` 与 `next-step` 投影出来；`claim()` 先持久删除，再发布 claimed 通知。这样取消、恢复和 UI 都能知道消息是插入、领取还是丢弃。

### 5.2 Session 与事件数据

`Session` 是单一事实源。核心事件覆盖：

- 结构：`turn/start|end`、`step/start|end`；
- 模型表面：`user/message`、`assistant/message`、`tool/result`；
- 流式/诊断：`assistant/chunk`、`tool/call`、request headers；
- 插件日志：`goal/change`、`todo/write`、`sandbox/mode`、`compaction/*`、`subagent/descriptor`、`workflow/*` 等。

`deriveMessages()` 从 surface events 派生模型 history；原则是 **model-visible means logged**。Session 还支持 `fork(source, boundary)`、seed boundary、crash repair 和 invariant companion。证据：`packages/core/session/src/types.ts` 的 `SessionEventMap`/`TurnEndReasonMap`，`packages/core/session/src/index.ts` 的 `Session`/`SessionStore`，[`docs/persistence-catalog.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/persistence-catalog.md)。

持久化本身是 provider seam：

- JSONL：追加、批量 fsync、可选 zstd frame、chunk run lossless packing、尾部修复；
- SQLite：一事件一行、事务批量 append、WAL、revision、load 时闭合 interrupted turn；
- 两者都要求 contiguous seq、JSON-serializable data 和单 session 单 writer。

证据：`packages/session/session-persistence-jsonl/README.md`、`packages/session/session-persistence-sqlite/README.md`。

### 5.3 Tool pipeline

模型产生 tool-call 后，`ToolRuntime` 并不直接调用 `execute()`，而是经过：

1. `tools/pre-execute` waterfall：普通 hook、权限、沙箱准备，可 allow/deny/ask；
2. monotonic guards：只能 deny/abstain，不能被后置插件重新放宽；
3. `ctx.approval`：需要时进行一次性人工批准，服务缺失则 fail closed；
4. `tools/execute` waterfall：timeout、retry、metrics 等 around-dispatch concern；
5. tool body；filesystem mutation 还会走 `fs/write-intent` / `fs/edit-intent`；
6. `tools/post-execute`：accept/block/replace/additional context；
7. outer normalization 与 `ToolDefinition.finalizeContent`；
8. frozen `tools/result` 通知和 durable `tool/result`。

完整图见 [`docs/tool-execution-pipeline.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-execution-pipeline.md)，接口与执行实现在 `packages/core/tools/src/index.ts` 的 `ToolRuntime`、`ToolDefinition`、`ToolExecution`、`execute()`。

这套设计最重要的不是事件名字，而是两个不变量：

- **权限只能单调收紧**：普通 pre hook 可以组合策略，但 owner policy 放在不可重排的 monotonic guard 中。
- **只有一个最终模型可见结果**：异常、拒绝、timeout、post rewrite 最终都规范化为冻结的 outcome，再写 `tool/result`。

### 5.4 Workflow 与 Subagent

`SubagentRuntime` 是 provider registry。provider 可以是同进程新 Agent、父 session fork、ACP、Codex、Claude Code 或另一个 DSH SDK runtime。公开 run contract 把 child id、result、cancel/dispose 和 provider capability 暴露给 holder；可继续 child 还有 durable descriptor、followup、interrupt、report 和冷恢复。证据：`packages/subagent/subagent/src/index.ts` 的 `SubagentRuntime`，`packages/subagent/subagent/src/types.ts` 的 `SubagentProvider`/`SubagentRun`。

`WorkflowEngine` 执行模型写出的 JavaScript orchestration script。`WorkflowStartRequest` 含 `meta/script/args/subagentProvider/maxTotalAgents/parent/signal`；`WorkflowRun` 含 `id/meta/result/cancel/dispose`；`result` 永不 reject，错误被规范化为 `stopReason: error|cancelled`。当前实现使用 Node worker thread 隔离脚本，宿主控制 child agent 启停、并发/数量上限、取消和 bounded disposal。证据：`packages/workflow/workflow/src/runtime-types.ts` 的 `WorkflowStartRequest`/`WorkflowRun`，`packages/workflow/workflow/src/types.ts` 的 `WorkflowResult`，`packages/workflow/workflow-worker-thread/src/host.ts` 的 `WorkerThreadRun`。

`tool-ralph` 证明了组合价值：fresh-agent 循环只是 workflow + subagent 上的普通插件，没有修改 agent loop。但它也证明了验证缺口：worker 的结构化 `status=complete` 并非独立认证。

## 6. 扩展点与开发治理

DSH 的主要扩展方式可以归纳为：

| 需求                          | 扩展方式                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| 新模型                        | 向 `ctx.llm` 注册 adapter                                  |
| 新模型工具                    | `ctx.tools.register(defineTool(...))`                      |
| 新 prompt 内容                | `ctx.systemPrompt.section(...)`                            |
| 新 filesystem/process/sandbox | 实现 service definition 对应 provider                      |
| 新 subagent 后端              | `ctx.subagents.registerProvider(...)`                      |
| 请求、step、turn 拦截         | `agent/*` waterfall/serial events                          |
| 权限/审计/timeout             | `tools/*` 与 `fs/*` capability events                      |
| agent-local 行为              | 注册到 `agent.ctx`，随 agent disposal 撤销                 |
| 新部署组合                    | bundle/profile/patch，而非 fork 核心                       |
| 新 durable domain state       | declaration merge `SessionEventMap` + projection/invariant |

此外，仓库把“文档与契约同步”自动化得很彻底：`package.json` 包含 tool/config/persistence/module graph/Cordis API/extension catalog 的生成与 freshness verifier；README 还要求每个包描述 Model Experience、token effect、KV cache effect 和 limitations。这比单纯写架构图更可操作：改变接口后若文档图和 catalog 没更新，CI 会失败。

## 7. 部署、Headless 与分布式执行

### 7.1 实际具备的能力

- Web profile：本机 HTTP Web UI，默认 `127.0.0.1:3080`。
- Headless profile：一次命令提交一个 task，创建持久 Agent，等待 idle、flush Session、输出最后 assistant text，然后按 turn reason 退出；**不启动 HTTP server**。证据：`packages/bundle/headless/README.md` 的 runner contract。
- SDK runtime：stdio JSON-RPC；Python `DeepSeekHarness` 懒启动并复用同版本 bundled executable，可复用 session/persistent shell。证据：`packages/sdk/server/src/index.ts` 的 `apply()`、`packages/sdk/protocol/src/types.ts`、[`python/sdk/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md)。
- API Gateway：Typert 从 Host service 的 `@Remote`/`@RemoteScope` 生成 Client unary RPC contract；streaming/session event 不属于该 unary descriptor。证据：`docs/api-gateway.md`、`packages/api/gateway/src/*`。
- 远端 execution world：E2B provider 同时替换 filesystem 和 subprocess，使 Bash、PTY、LSP 进入同一远端 Linux sandbox。
- 外部 agent：ACP、Codex、Claude Code、DSH SDK 都可作为 subagent provider。

### 7.2 不能误称为“分布式平台”的部分

DSH 当前没有 scheduler、worker pool、tenant/resource quota、cluster lease、distributed session writer、remote workflow checkpoint 或服务化 control plane。E2B README 明确说它不是 whole-harness runtime：Cordis services、agent/session/log、LLM requests 和 skills 仍在 host process；sandbox 也是 ephemeral POC，没有 reconnect、snapshot、volume、host sync 或 deployment platform。`WorkflowEngine` 当前同样 foreground、无 journaling/resume、无 token budget。

所以准确描述是：**DSH 有优秀的 remote capability seam 和 external-agent provider seam，但没有完整的分布式 agent platform。**

## 8. 优势与限制

### 8.1 优势

1. **抽象边界真实可替换**：E2B 替换 fs/subprocess 后现有 Bash/PTY/LSP 无需 fork，证明 seam 不是纸面接口。
2. **可重放性强**：raw chunks、request facts、tool calls/results、turn reason 全都可恢复；UI、telemetry、fork、resume 不各自发明事实源。
3. **安全顺序明确**：审批、单调 guard、沙箱、timeout、post rewrite 与最终结果的先后关系被代码和生成图同时固定。
4. **生命周期可靠**：agent/workflow/subagent/process 都强调 holder-owned handle、bounded cancellation、dispose、quiescence。
5. **按 agent scope 组合**：同一进程内不同 session/agent 可以有不同 tool/prompt/provider，注册随 agent context 销毁。
6. **精确请求重建与 keyless full-surface replay**：`packages/core/agent-loop/tests/request-reconstruction.spec.ts` 验证每次模型请求可由日志 surface + `request/header` 重建；`dsh-llm-replay` 从记录的 Session JSONL 还原 stream，`dsh-acp-snapshot` 同时捕获 ACP stdout、parent/child session logs、system prompt 与 tool schema，使完整 agent composition 可以无 API key 回放。证据：[`packages/test-support/llm-replay/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/llm-replay/README.md)、[`packages/test-support/acp-snapshot/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/acp-snapshot/README.md)。
7. **测试和文档治理成熟**：大量 contract/property/e2e 测试，生成 catalog 与中英双语 freshness gate，Known Limitations 不回避未完成能力。
8. **嵌入友好**：CLI、Web、Headless、Node/TS SDK、Python stdio SDK 使用同一 agent spine。

### 8.2 限制

1. **仍是 developer preview**：官方承诺会有 breaking changes；session format 也明确没有 migration。
2. **不是 eval/RL harness**：无 dataset、rollout、verifier、reward；`BENCHMARK.md` 只是运行说明。
3. **动态 workflow 不耐久**：foreground only、无 journal/resume、无 saved/nested workflow、无 aggregate token budget。
4. **Ralph 完成不可信**：worker 自报完成，缺独立 verifier；round count 是唯一 aggregate effort bound。
5. **E2B 是 POC**：sandbox ephemeral、无 host sync、非 whole runtime、同 UID 控制文件隔离不完整，SDK 仍可能在 host 内存保留完整输出。
6. **持久化不适合多写者服务**：JSONL/SQLite 都要求单 session 单 writer；SQLite 使用同步 `DatabaseSync`，无 busy timeout/retry，格式无 migration，也没有 delete API。
7. **包数量与 Cordis 心智成本高**：228 个 package manifest、配置层/realm/scope/event waterfall 对普通贡献者不轻；如果团队没有同等级 catalog 和 invariant 治理，容易只得到碎片化。
8. **Headless 能力窄**：一次 task、无交互 surface、无 HTTP control plane；不能替代 Cognia 的长期运行 Headless 服务。
9. **安全边界需要逐项读限制**：默认 permission preset 是 `workspace-write + ask`，但 sandbox 只承诺文件效果，不等于网络/进程隔离；credentials 文件即使使用 `0600`，同 UID 的 agent tool process 仍可主动读取。证据：`docs/subsystems/sandbox.md`、`packages/credentials/credentials-local/README.md`。
10. **遥测开启后需要自带脱敏策略**：OTel telemetry 默认 disabled；若启用 FULL/FEEDBACK_ONLY，默认规则可能携带完整消息、tool args/results、命令输出、文件内容、system prompt、tool schema 与 cwd。Cognia 不应复制其默认开启后的隐私姿态。证据：`packages/session/session-telemetry-otel/README.md`。

## 9. 与 Cognia 的重叠与差异

### 9.1 能力矩阵

| 领域              | DSH                                                                         | Cognia 当前                                                                                                            | 判断                                                                             |
| ----------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 内建 agent loop   | 独立 core packages，turn/step/event 语义统一                                | React `use-claude-chat` → Tauri → Node sidecar → Claude SDK，事件再归约到 UI message                                   | DSH spine 更干净；Cognia provider/UI 能力更丰富但耦合更高                        |
| 插件              | everything-is-plugin，Cordis service/effect/scope                           | 成熟 PluginContext、WASM/TS/Python、marketplace、权限、extension/hook registries                                       | Cognia 广度更大；DSH 的统一 service/effect 纪律值得吸收                          |
| 会话数据          | 追加 `SessionEvent` 是模型事实源，并验证 request reconstructability         | `UIMessage` transcript、agent trace span、workflow run event 等多投影分别持久化                                        | Cognia 缺统一 agent execution ledger 与 exact model-request reconstruction       |
| Tool pipeline     | 固定多阶段 pipeline + monotonic guard + frozen result                       | Claude SDK `canUseTool`、Rust/前端 permissions、plugin hooks、sandbox 分散在多个边界                                   | 最适合直接借鉴的领域                                                             |
| Workflow          | 模型写 JS、worker thread、subagent fan-out、foreground                      | 持久 VisualWorkflow DAG、节点 registry、并发、lease、idempotency、resume、remote step、trigger                         | Cognia 明显更强，不应被 DSH workflow 替换                                        |
| Subagent          | provider seam，in-process/fork/ACP/Codex/Claude/DSH SDK                     | built-in subagents、agent team、external agent presets、ACP、跨 host dispatch                                          | 能力重叠；DSH run-handle contract 更统一                                         |
| Sandbox           | local OS + Windows ACL + E2B provider seam                                  | OS/microVM/CUA、per-session binding、remote sandbox、Rust hardening                                                    | Cognia更广；可借鉴“同 execution world 的 fs+process provider”                    |
| Eval/verifier     | 基本没有                                                                    | `EvalCase/EvalDataset/EvalTarget/EvalSample/Scorer`、pass@1/pass^k、gate、calibration、chat/team/workflow/twin targets | Cognia 显著领先，应反向补足 runtime verifier                                     |
| Headless/远程     | 一次性 CLI、stdio SDK、本地 Web server                                      | Headless service plane、450 command contract、events/bridge、gateway、companion、Compose/K8s                           | Cognia 显著领先                                                                  |
| 可观测性/测试回放 | session event + telemetry + keyless ACP/session/full-header snapshot replay | OTel-compatible `AgentTraceSpan`、logs、usage、eval trajectory、广泛 E2E/conformance                                   | Cognia评测/集成门禁更强；DSH 的精确请求重建与 full-surface keyless replay 更完整 |

### 9.2 Cognia 的具体证据

- 内建 Claude 链路由 `hooks/chat/use-claude-chat.ts` 的 `send()` 驱动，经 `lib/claude/ipc.ts::sendPrompt`、`src-tauri/src/claude/sidecar.rs`、`sidecar/dispatch/anthropic.mjs::dispatchAnthropic`，事件最终由 `lib/claude/adapter.ts::applySdkEvent` 归约；详见 `docs/content/docs/en/chat/built-in-agent/runtime-loop.mdx`。
- Chat transcript 以 `UIMessage[]` 形式由 `lib/db/messages.ts::persistMessages`/`replaceSessionTranscript` 写 Dexie；agent trajectory 另由 `packages/agent-trace/src/types.ts::AgentTraceSpan` 和 `lib/db/agent-traces.ts` 维护。这些都很有用，但不是一个能重建完整 turn/step/tool/inbox 的统一日志。
- Visual workflow 的 `lib/workflow/runtime/orchestrator.ts::runWorkflow` 已具备 snapshot、validation、capability preflight、toposort、并发、Dexie run/event、Rust shadow、idempotency、lease/heartbeat、resume、remote capability；`lib/workflow/nodes/registry.ts::registerNodeExecutor` 支持版本化 node executor。它比 DSH 当前 ephemeral workflow engine 更适合 Cognia 产品。
- **已提交基线**中的 Plugin lifecycle 已出现 DSH 式方向：`lib/plugin/core/disposable-scope.ts::PluginDisposableScope` 反向释放同步/Promise disposer，`lib/plugin/core/context.ts::createFullPluginContext` 通过 `withPluginDisposableScope()` 包装 context，`lib/plugin/core/manager.ts` 在 teardown 调用 scope disposal。
- **研究时 dirty worktree 的在研增强**进一步加入显式 `resource-effects` metadata、pending async registration、generation、dirty teardown state，以及新的 `lib/plugin/core/lifecycle-coordinator.ts::PluginLifecycleCoordinator` 并在修改中的 manager 调用 `acquire/release`。这些尚未属于 `68e8dc3b...` 的稳定基线，不能作为已落地能力；本报告只把它视为“Cognia 正在向同一方向收敛”的证据。
- Eval 已有完整抽象：`types/eval/eval.ts` 的 `EvalCase`、`EvalDataset`、`EvalSample`、`Scorer`、`EvalReport`；`lib/ai/eval/runner.ts::EvalTarget/runEval`；`lib/ai/eval/index.ts::runDatasetEval`；chat/team/workflow targets 从 `AgentTraceSpan` 组装 trajectory。这正是 DSH 缺失的 verifier/reward-like evaluation plane。
- Sandbox 已有 provider-neutral contract：`types/sandbox/index.ts::SandboxSessionBinding/SandboxConnectionRow`、`lib/sandbox/lifecycle-contract.ts::SandboxProviderAdapter`、`lib/sandbox/policy-bridge.ts::clampSandboxPolicy`。适合吸收 DSH execution-world 一致性，不需要引入其 provider 代码。

## 10. 建议分级

### 10.1 直接采用（采用契约与不变量，可在现有架构内实现）

#### A. 统一 turn / step / tool outcome 词汇

为 Cognia 新增版本化的 `AgentRuntimeEventV1`，至少覆盖 `turn.started/ended`、`step.started/ended`、`user.entered`、`assistant.delta/final`、`tool.requested/started/settled`、`inbox.inserted/claimed/discarded`、`runtime.error`。明确 `completed/max-tokens/aborted/blocked/error/interrupted`，避免把 provider result、sidecar exit、用户取消和 crash 都压成一个字符串。

#### B. “模型可见即有日志依据”

任何进入模型的 user content、injected context、tool result、compaction replacement 都必须能从 durable event 重建。PII gate 后实际发送的 payload 应记录 secret-free digest/route facts，而不是原始敏感值。此原则可先用于新 unified execution path，再逐步覆盖旧链路。

#### C. 固定 tool execution pipeline

在一个中心模块中固定 `pre-policy → approval → monotonic guard → around execution → post-policy → finalize → immutable result`。Claude sidecar、plugin tool、MCP、sandbox tool、external-agent tool 不再各自决定顺序。现有 permission/hook/sandbox 代码作为 adapter 接入。

#### D. Handle 所有权与 bounded disposal

统一 agent/subagent/workflow/external process handle：`result` 有稳定 outcome，`cancel(reason)` 第一原因获胜，`dispose()` 幂等并等待或明确 bounded abandonment。将 `PluginDisposableScope` 的反向 ledger 扩展为 runtime resource 的通用模式。

#### E. 生成式 contract catalog 与 invariant tests

从事件类型、tool registry、plugin points、headless manifest 生成一份 agent lifecycle/tool pipeline catalog，并在 CI 校验 freshness。新增 property/conformance tests 验证 call/result 配对、turn/step enclosure、final result 唯一性、guard 单调性和 disposal 无泄漏。

#### F. Exact request reconstruction 与 keyless snapshot replay

为每个 model call 持久化 secret-free、版本化 request header（system prompt、tool schema、provider/model route、model-visible prefix 的内容或可验证引用），保证请求可从日志重建。构建 keyless replay adapter，从录制的 root/child event logs 重放 provider stream，并把 ACP/外部 agent stdout、permission、tool presentation、session events、prompt/schema sidecar 作为同一 scenario 的快照面。Cognia 已有强 Eval/E2E/conformance 基础，这项工作应补“确定性复现”，而不是再造 eval runner。

### 10.2 适配后采用（思想正确，但必须顺着 Cognia 现有优势改造）

#### A. Event sourcing 采用 shadow-ledger 迁移

不要立刻用 DSH Session log 替换 `messages`、`agentTraces`、workflow events。先旁路写 `AgentRuntimeEventV1`，继续让现有 UIMessage 与 trace 成为生产读模型；通过 parity job 验证“从 event ledger 投影出的 transcript/usage/tool trajectory”与现存表一致，成熟后再切读。

#### B. Service Definition / Provider / Consumer 三段式

沿用 Cognia 的 registry/PluginContext，而不是引入 Cordis。优先把 `filesystem`、`process`、`sandbox`、`subagent`、`model transport` 统一为 agent/session scoped provider；确保同一个 binding 下 fs、shell、LSP、editor 真正处于同一 execution world。

#### C. Profile/bundle 思想映射到现有 preset 与 RuntimeTarget

把 DSH 的 bundle/profile/patch 思想映射成 Cognia 的 Character/AgentMode、external preset、RuntimeTarget、plugin bundle 与 deployment binding。目标是“最终组合可 dump、可 diff、可重放”，不是复制 `cordis.patch.yml`。

#### D. Ralph + independent verifier

可以新增“fresh-worker iterative run”作为 Agent Team/Workflow 模板，但每轮输出只是一份 claim。独立 verifier 通过 Cognia `EvalTarget`/`Scorer` 或专门的 `CompletionVerifier` 检查 workspace diff、测试、目标约束和 evidence；只有 verifier pass 才结束。预算必须同时覆盖 rounds、tokens、USD、wall clock 和失败重试。

#### E. Remote execution seam

借鉴 E2B provider 的“fs + subprocess 同世界”证明方式，把 Cognia 现有 `SandboxProviderAdapter`、remote step broker、task workspace 和 terminal backend 组成可替换 execution-world bundle，并加跨 provider conformance suite；不照搬 E2B POC 的生命周期和安全假设。

### 10.3 不适合 Cognia

1. **整仓迁移 Cordis / everything-is-plugin**：会与现有 PluginManager、Rust commands、Dexie、Tauri lifecycle、Headless contracts 形成第二套容器；迁移收益低于风险。
2. **用模型生成任意 JS workflow 替代 VisualWorkflow**：Cognia 的持久 DAG、审核、节点 schema、风险门、lease、resume、UI 与分布式执行更符合产品；任意脚本会扩大供应链与 RCE 风险。
3. **用 DSH Headless 替代 Cognia Headless service**：DSH 只处理一次 task 且不开 server；Cognia 已有长期运行、版本化 contract、events/bridge、认证与 450 command control plane。
4. **用 DSH JSONL/SQLite 替换 Cognia durability ladder**：其单 writer、无 migration/delete、同步 SQLite 等限制不满足 Cognia 多 runtime/跨设备方向。
5. **照搬 228 包的拆分粒度**：Cognia 已是大型 monorepo；应复制边界与 contract tests，不复制发布单元数量。
6. **把 DSH worker self-report 当 verifier**：这是其文档明确承认的未完成能力，不能作为 goal completion 或自动合并依据。

## 11. 具体实施路线图

### Phase 0：契约与基线（1–2 周）

产物：ADR + types + conformance tests，不改变用户行为。

1. 画出现有 Claude、AI SDK、external agent、MCP/plugin tool 的实际 event/tool 顺序。
2. 定义 `AgentRuntimeEventV1`、`TurnEndReason`、`ToolOutcome`、`RuntimeResourceHandle`。
3. 为现有 `permission_request`、plugin hooks、sandbox policy、tool spans 建立到统一 pipeline stage 的映射。
4. 记录基线：每种路径的事件缺口、重复事实源、不可恢复状态和 disposal 行为。

验收：schema round-trip、事件序列 property tests、不会包含原始 secret/PII、现有路径零行为变化。

### Phase 1：旁路 durable execution ledger（3–5 周）

1. 在 Rust↔Node↔React 边界赋予全局稳定 `sessionId/turnId/stepId/callId/seq`。
2. Sidecar 输出先通过一个 protocol normalizer，再同时喂给现有 `applySdkEvent` 与 ledger writer。
3. 记录 raw delta 与 canonical final，保证 final 可引用 source delta seqs。
4. 实现 crash repair：未闭合 tool/step/turn 追加 synthetic `interrupted/unknown outcome`，不伪造成功。
5. 构建 transcript、tool trajectory、usage 三个投影，与现有 `messages`/`agentTraces` 做 parity 比较。
6. 为每个实际 model request 写入可重建 header；加入断言：重建 request 必须与发出的 post-PII-gate request 在结构和摘要上相等。

验收：kill -9 Node/Rust/brain 后可恢复；重复/乱序 frame 不破坏 seq；投影与现有 UI 在黄金样例上等价。

### Phase 2：统一 tool pipeline（3–5 周）

1. 建立中心 `ToolExecutionPipeline`，identity 与 caller signal 不可被 hook 替换。
2. 现有 Claude approval、plugin permissions、risk ceremony、sandbox clamp、timeout、telemetry 逐个适配。
3. 引入 monotonic guard：owner policy 只能 deny/abstain；plugin post hook 无法放宽。
4. 所有失败统一为 typed `ToolOutcome`，且只发布一次 immutable final result。
5. 覆盖 builtin、plugin、MCP、workflow/external-agent transport tools。

验收：矩阵测试覆盖 allow/ask/deny/abort/timeout/body throw/post throw；每个 call 恰好一个 settled outcome；高风险命令无法通过 hook 重排绕过。

### Phase 3：agent-scoped capability 与生命周期（4–6 周）

1. 在现有 PluginContext/registry 上增加 `AgentCapabilityScope`，不引入 Cordis。
2. 将 fs/process/sandbox/terminal/LSP provider 绑定到同一 execution-world id。
3. Agent/subagent/workflow/provider 返回统一 handle，并纳入 `PluginDisposableScope` 或同源 ledger。
4. 加入 scope dump/diff，能解释某 session 实际使用的模型、工具、policy、sandbox、workspace 和 provider。

验收：卸载 provider 后既有 handle 按契约收尾、新建被拒绝；不同 session capability 不串线；资源泄漏检测通过。

### Phase 4：有验证器的 fresh-agent loop（3–4 周）

1. 先作为 VisualWorkflow/Agent Team 模板，不新增另一套 orchestration runtime。
2. worker 输出结构化 evidence；verifier 从 workspace snapshot、测试结果和目标约束独立判断。
3. 复用 `types/eval/eval.ts::Scorer` 思想，但把 online verifier 与 offline report 区分，禁止 fail-open。
4. 支持 round/token/cost/time 四重预算、重试策略、blocked 升级和人工接管。

验收：伪造 `status=complete` 但测试失败时继续/失败；verifier 不可用时不得当作通过；所有判断进入 ledger。

### Phase 5：治理与渐进切换（持续）

1. 生成 event/tool/capability catalog 与中英实现文档。
2. 对 Headless、desktop、web standalone、companion、external agent 做同一 conformance suite。
3. 建 keyless snapshot tier：固定输入脚本 → 真进程边界 → replay model → 捕获完整 transport/session/prompt/tool-schema surfaces；录制与回放都验证所有脚本已消费。
4. 先让 eval/replay/debug 读取 ledger，再让新会话 UI 读取投影；旧消息表保留回滚期。
5. 证明 ledger 成为事实源后，才删除双写与重复状态。

## 12. 主要风险与缓解

| 风险               | 表现                                   | 缓解                                                                                     |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| 双写漂移           | ledger 与 messages/traces 不一致       | 只增不改；parity report；按 session feature flag 切换；保留原读路径                      |
| 存储膨胀           | raw stream delta 与 tool payload 很大  | lossless chunk packing、分层 retention、payload handle；canonical log 不随意丢事件       |
| PII/secret 泄漏    | 事件日志比 UI message 更完整           | outbound gate 后记录 digest/route；敏感字段引用 encrypted blob；导出默认脱敏             |
| 顺序与竞态         | Rust/Node/React/remote events 乱序     | 单 session seq owner；幂等 event id；gap detection；明确 synthetic repair                |
| 兼容性             | event schema 以后无法迁移              | `schemaVersion`、upcaster、golden fixtures；不要采用 DSH “未发布所以无 migration”策略    |
| 性能               | 每个 delta durable write 阻塞 UI/Node  | append buffer + explicit flush boundary；写入放 Rust/brain；projection 增量更新          |
| 插件绕过策略       | hook 顺序变化放宽权限                  | monotonic guard 独立于 plugin waterfall；owner policy 固定在 final pre-dispatch gate     |
| 生命周期泄漏       | worker/thread/process 在 cancel 后继续 | holder-owned handles、bounded grace、quiescence metrics、process-group cleanup           |
| 过度抽象           | 为“一切可替换”拆出大量包               | 只为已有两个 provider/consumer 的边界建 seam；模块内接口优先，稳定后再抽 package         |
| 在线 verifier 误判 | LLM judge fail-open 或被 worker 欺骗   | deterministic evidence 优先；verifier failure = inconclusive/fail closed；与执行模型隔离 |
| 动态脚本安全       | 任意 workflow JS 形成 RCE              | 继续以 typed VisualWorkflow 为主；脚本节点须 sandbox、capability allowlist、审计和预算   |

## 13. 建议的决策

建议 Cognia **借鉴 DSH，但不要依赖或迁移到 DSH**。

最有价值的落点是一个新的、实现无关的 agent execution contract：

```text
AgentRuntimeEventV1（事实源）
  ├─ TranscriptProjection → 现有 chat UI / persistence
  ├─ TraceProjection      → AgentTraceSpan / OTLP
  ├─ EvalProjection       → EvalSample / scorer
  └─ RecoveryProjection   → resume / interrupted outcome

ToolExecutionPipeline（唯一调用入口）
  policy → approval → monotonic guard → execute → post → frozen outcome

AgentCapabilityScope（组合与所有权）
  model + tools + fs/process/sandbox + subagent + disposers
```

这三块正好补齐 Cognia 当前最深的结构性缺口，又不会牺牲其已经领先 DSH 的 VisualWorkflow、Eval、Headless、跨设备与产品生态。若只能选一个近期项目，应先做 **Phase 0 + Phase 1 的 execution ledger**；它既能提升 crash recovery 和调试，又会为 tool pipeline、eval replay、跨 host execution 与未来统一 Agent SDK 提供共同底座。

## 14. 一手来源索引

### DeepSeek Harness 官方仓库

- [README：定位、developer preview、运行方式](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/README.md)
- [Architecture：Cordis、profiles/bundles、turn flow、session log、capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md)
- [Agent lifecycle sequence](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/agent-lifecycle.md)
- [Tool execution pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/tool-execution-pipeline.md)
- [Capability seams graph](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/capability-seams.md)
- [Python SDK contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/python/sdk/README.md)
- [E2B shared sandbox owner](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/e2b/e2b/README.md)
- [Workflow seam](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/workflow/README.md)
- [Ralph contract and explicit verifier limitation](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/tool-ralph/README.md)

精确源码符号：

- `packages/core/agent/src/runtime-types.ts::{Agent, AgentHandle, AgentSetup, AgentFactory}`
- `packages/core/agent/src/index.ts::AgentRegistry`
- `packages/core/agent/src/inbox.ts::Inbox`
- `packages/core/agent-loop/src/agent.ts::AgentImpl`
- `packages/core/session/src/index.ts::{Session, SessionStore}`
- `packages/core/session/src/types.ts::{SessionEventMap, TurnEndReasonMap}`
- `packages/core/tools/src/index.ts::{ToolRuntime, ToolDefinition, ToolExecution}`
- `packages/fs/fs/src/index.ts::FileSystem`
- `packages/subprocess/subprocess/src/index.ts::SubprocessRuntime`
- `packages/subagent/subagent/src/index.ts::SubagentRuntime`
- `packages/workflow/workflow/src/runtime-types.ts::{WorkflowStartRequest, WorkflowRun}`
- `packages/workflow/workflow-worker-thread/src/host.ts::WorkerThreadRun`
- `packages/sdk/server/src/index.ts::apply`

### Cognia 对照源码与 ADR

- `docs/content/docs/en/chat/built-in-agent/runtime-loop.mdx`
- `hooks/chat/use-claude-chat.ts::{send, handleEvent}`
- `lib/claude/adapter.ts::applySdkEvent`
- `lib/db/messages.ts::{replaceSessionTranscript, persistMessages}`
- `packages/agent-trace/src/types.ts::AgentTraceSpan`
- `lib/workflow/runtime/orchestrator.ts::runWorkflow`
- `lib/workflow/nodes/registry.ts::{registerNodeExecutor, unregisterNodeExecutor}`
- `lib/plugin/core/disposable-scope.ts::{PluginDisposableScope, withPluginDisposableScope}`
- `lib/plugin/core/lifecycle-coordinator.ts::PluginLifecycleCoordinator`
- `types/eval/eval.ts::{EvalCase, EvalDataset, EvalSample, Scorer, EvalReport}`
- `lib/ai/eval/runner.ts::{EvalTarget, runEval}`
- `lib/ai/eval/index.ts::runDatasetEval`
- `types/sandbox/index.ts::{SandboxSessionBinding, SandboxConnectionRow}`
- `lib/sandbox/lifecycle-contract.ts::SandboxProviderAdapter`
- `docs/content/docs/en/adr/0101-model-evaluation-lab.md`
- `docs/content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md`
- `docs/content/docs/en/adr/0059-cloud-deployment-headless-brain.md`
- `docs/content/docs/en/adr/0017-workflow-plugin-extension-points.md`
