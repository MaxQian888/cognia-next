# AI SDK Harness Providers：定义、能力与 Cognia 适配性研究

> 调研日期：**2026-08-14**  
> 范围：AI SDK 官方 Harness 文档、Vercel `ai` 仓库源码/包清单、官方 npm 元数据，以及 Cognia 当前实现。除 Cognia 本地代码外，只使用一手资料。

## 结论先行

这五个页面介绍的不是普通的“模型 Provider”，而是 **AI SDK Harness adapters**：它们把 Claude Code、Codex、Pi、OpenCode、Grok Build 这类已经自带会话、工具、权限、上下文压缩和工作区能力的完整 agent runtime，统一接到 `HarnessAgent` 上。应用由此可用类似 AI SDK 的 `generate()`、`stream()`、`GenerateTextResult`、`StreamTextResult`、`useChat` 消费方式驱动不同 coding agent，而无需把每个 runtime 的原生事件单独翻译一遍。Harness 和 `streamText`/model provider 是并列、互补的两层，不是替代关系。[官方概览](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) [adapter 说明](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)

对 Cognia 的判断是：**有参考价值，也适合做隔离的 host-side PoC；现在不适合直接替换主聊天、Claude/Codex/OpenCode 原生集成或 provider abstraction。** 最值得借鉴的是统一的 session lifecycle、AI SDK-compatible event projection、host tools、skills、permission 和 sandbox contract。最适合先验证的是 headless/eval/远程隔离执行，而不是桌面端本地工作区主路径。

主要原因：

1. Cognia 已经有完整的 `streamText` provider rail、Claude Agent SDK sidecar，以及 ACP、Codex app-server、OpenCode v1/v2 的外部 agent adapters；Claude/Codex/OpenCode harness 会与现有能力高度重叠。
2. Claude Code、Codex、OpenCode 和 Grok Build adapter 都在网络 sandbox 内安装并启动 bridge/CLI，通过暴露端口的 WebSocket 回传事件；这与 Cognia 当前直接操作用户本地 workspace 的桌面产品语义不同。远程 sandbox 还需要仓库上传/同步、凭证注入和结果回收。
3. 当前 `HarnessAgent` 没有 typed structured-output surface，五个 adapter 的直接用户输入也都只接受文本；因此不能无损替代 Cognia 已有的结构化模型调用和附件/多模态路径。[`HarnessAgent` 源码](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts) [ACP 文本输入转换](https://github.com/vercel/ai/blob/main/packages/harness-acp/src/v1/acp-v1-prompt.ts)
4. 所有 Harness 包仍被官方标为 **experimental**，文档明确提示版本间可能发生 breaking changes。[官方概览](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)

## 1. Harness provider 到底是什么

AI SDK 目前有两套不同抽象：

| 抽象            | 封装对象               | 入口                                          | 谁控制 tool loop / history      | 适合场景                                                       |
| --------------- | ---------------------- | --------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Model provider  | 一个 language model    | `generateText`、`streamText`、`ToolLoopAgent` | 应用/AI SDK                     | 精确模型参数、结构化输出、自定义 loop、通用聊天                |
| Harness adapter | 一个完整 agent runtime | `HarnessAgent`                                | Claude Code/Codex/Pi 等 runtime | coding agent、原生工具/权限/压缩、多轮 session、workspace 操作 |

官方定义中，harness runtime 自己拥有 workspace access、built-in coding tools、native session state、compaction、permission flow 和 runtime-specific config；`HarnessAgent` 负责把这些能力投影到统一 contract。一个完整部署通常包含四部分：

- `@ai-sdk/harness`：`HarnessAgent`、session、stream/event、tool、permission 和 lifecycle contract；
- 一个 adapter，例如 `@ai-sdk/harness-codex`；
- 一个 `HarnessV1SandboxProvider`，例如 `@ai-sdk/sandbox-vercel`；
- adapter 背后的原生 runtime/SDK/CLI。

`HarnessAgent.generate()` 和 `.stream()` 返回 AI SDK-compatible result，文本、reasoning、tool call/result、usage、finish reason 尽量使用 AI SDK 原生 shape；file change、compaction 等没有通用 part 的事件被映射为 dynamic provider-executed tool parts。Session 保存 runtime、sandbox、工作目录、原生对话历史和 pending approval，必须显式 `destroy()`、`detach()` 或 `stop()`；跨进程继续则持久化 opaque resume/continuation state。[官方概览](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) [HarnessAgent 文档](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)

## 2. 共通能力与共通限制

### 2.1 共通能力

- **Streaming：支持。** 所有 adapter 都通过 `HarnessAgent.stream()` 输出 `StreamTextResult`；bridge/runtime event 会被增量翻译为 AI SDK stream parts。
- **会话与恢复：支持。** `createSession()` 创建显式 session，支持 stable `sessionId`、detach/stop/resume、未完成 turn 的 suspend/continue；具体 runtime 能保留多少原生状态仍由 adapter 决定。
- **三类工具：支持。** runtime built-in tools、由 host 执行的 AI SDK tools、adapter 配置的 MCP servers。Host tool 在应用 Node.js 进程执行，并可获得 restricted sandbox handle。[Harness tools 文档](https://ai-sdk.dev/docs/ai-sdk-harnesses/tools)
- **Skills：五个 adapter 均支持。** adapter 负责将通用 skill materialize/映射成 runtime 能发现的形式。[adapter capability matrix](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)
- **Cancellation：contract-level 支持。** `createSession`、`generate`、`stream`、continue 和 sandbox bootstrap 都接受 `AbortSignal`；core 把 signal 传给 adapter/runtime 和 host tools，并把用户触发的终止映射为 AI SDK `abort` stream part，而不是普通 error。[`run-prompt.ts`](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/run-prompt.ts) [`harness-agent.ts`](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts)
- **UI 兼容：支持。** Harness stream 可转 `toUIMessageStream` 并由 `useChat` 消费，但 UI 必须把 session resume state 作为真正的对话连续性来源，不能只重放 message history。[HarnessAgent 文档](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)

### 2.2 共通限制

- **实验状态。** “1.0.x” 包版本不代表 API 已稳定；官方仍明确标注 experimental 和 breaking-change 风险。
- **Node.js host。** 当前官方包声明 `node >= 22`，不能放进 Cognia 的 static-export browser bundle；只能在 sidecar、CLI、headless service 或其他 Node host 使用。[`@ai-sdk/harness` package.json](https://github.com/vercel/ai/blob/main/packages/harness/package.json)
- **没有 typed structured output。** 当前 `HarnessAgent` 的 AI SDK `Agent`/`GenerateTextResult`/`StreamTextResult` output generic 固定为 `never`，调用面没有 `Output.object(...)` 一类 schema channel。即使某些底层 SDK 原生具备 JSON schema 能力，Harness abstraction 当前也没有暴露它。[`HarnessAgent` 源码](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts)
- **直接输入是 text-only。** Claude Code、Codex、OpenCode、Pi 都会拒绝非 text message parts；Grok Build 走 ACP，而当前 ACP converter 同样显式拒绝 image、audio 和 embedded file parts。可把附件先写进 sandbox 再让 agent 用 read 工具读取，但这不是直接 vision input，且多一次工具调用。[Claude Code converter](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts) [Codex converter](https://github.com/vercel/ai/blob/main/packages/harness-codex/src/codex-harness.ts) [OpenCode converter](https://github.com/vercel/ai/blob/main/packages/harness-opencode/src/opencode-harness.ts) [Pi converter](https://github.com/vercel/ai/blob/main/packages/harness-pi/src/pi-utils.ts) [ACP converter](https://github.com/vercel/ai/blob/main/packages/harness-acp/src/v1/acp-v1-prompt.ts)
- **sandbox 不是本地 workspace 的透明代理。** bridge-backed adapter 需要 network sandbox 和暴露端口。应用需要自行准备仓库内容、依赖、环境变量和产物同步；首次 session 还可能发生 CLI/bridge 安装冷启动。
- **权限能力不完全一致。** Host-executed AI SDK tool approvals 可跨 adapter 使用，但 built-in approval/filtering 取决于 runtime，不能假设所有 adapter 等价。[Harness tools 文档](https://ai-sdk.dev/docs/ai-sdk-harnesses/tools)

## 3. 五个 adapter 对比

| Adapter     | 安装包                                                      | runtime/process model                                                      | Auth 入口                                                | Built-in approval / filtering          | 关键约束                                                                |
| ----------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Claude Code | `@ai-sdk/harness` + `@ai-sdk/harness-claude-code` + sandbox | sandbox 内运行 Claude Agent SDK/Claude Code bridge；WebSocket 回 host      | `auto`、`direct`、`ai-gateway`; Anthropic 或 Gateway env | ✅ / ✅                                | network sandbox + port；首次 bootstrap；text-only input                 |
| Codex       | `@ai-sdk/harness` + `@ai-sdk/harness-codex` + sandbox       | sandbox 内运行 `@openai/codex-sdk` bridge；WebSocket 回 host               | `auto`、`direct`、`ai-gateway`; OpenAI 或 Gateway env    | ❌ / ❌                                | built-in 必须 `allow-all`；不能过滤 `bash`/`webSearch`；text-only input |
| Pi          | `@ai-sdk/harness` + `@ai-sdk/harness-pi` + sandbox          | Pi 在 **host Node process**；sandbox 仅作远程 FS/shell                     | `auto`、`openai`、`anthropic`、`custom`、`ai-gateway`    | ✅ / ✅                                | 不需端口；inline extension 运行在 host，必须可信；text-only input       |
| OpenCode    | `@ai-sdk/harness` + `@ai-sdk/harness-opencode` + sandbox    | sandbox 内启动 bridge + OpenCode server；WebSocket 回 host                 | `auto`、`anthropic`、`openai`、`ai-gateway`              | ✅ / ✅，filtering 通过 auto-rejection | network sandbox + port；首次安装 SDK/CLI；text-only input               |
| Grok Build  | `@ai-sdk/harness` + `@ai-sdk/harness-grok-build` + sandbox  | sandbox 内由 `@ai-sdk/harness-acp` 启动 pinned Grok CLI，通过 ACP + bridge | `auto`、`direct`、`ai-gateway`; xAI 或 Gateway env       | ✅ / ❌                                | 首次 session 要外网安装 pinned CLI；ACP v1 功能缺口；text-only input    |

能力表依据官方 adapter matrix 和五个 provider 页面。[adapter capability matrix](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)

### 3.1 Claude Code

`@ai-sdk/harness-claude-code` 通过 `@anthropic-ai/claude-agent-sdk` 连接 Claude Code。Adapter 把 bridge 依赖在第一次 session 启动时安装到 sandbox，通过 sandbox 暴露的 WebSocket 把事件送回 host。常用配置包括 `model`、`maxTurns`、`env`、`thinking`、`mcpServers`、bridge port/timeout/token。[官方页面](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code)

Auth `auto` 优先 AI Gateway，之后 fallback 到 Anthropic direct。支持 `VERCEL_OIDC_TOKEN`、`AI_GATEWAY_API_KEY`/`AI_GATEWAY_BASE_URL`、`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`。支持 read/write/edit/bash/glob/grep/webSearch 等 common tools 和 built-in approval/filtering。

对 Cognia：功能重合最大。Cognia sidecar 已直接依赖较新的 `@anthropic-ai/claude-agent-sdk`，并有本地 tool/MCP/permission/event 逻辑；harness 当前 bridge 又 pin 自己的 Claude SDK 和 CLI 版本，会形成第二套 runtime/update cadence。[Cognia sidecar package](../../sidecar/package.json) [官方 bridge package](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/package.json)

### 3.2 Codex

`@ai-sdk/harness-codex` 通过 `@openai/codex-sdk` 在 sandbox 内运行 bridge，并把 Codex thread events 转成 harness events。常用配置为 `model`、`reasoningEffort`、`webSearch`、`mcpServers` 和 bridge controls。[官方页面](https://ai-sdk.dev/providers/ai-sdk-harnesses/codex)

Auth `auto` 优先 Gateway，之后 fallback 到 OpenAI direct；支持 `OPENAI_API_KEY`、`CODEX_API_KEY`、`OPENAI_BASE_URL`、organization/project 等。OpenAI-compatible endpoint 需要 `auth: 'direct'` + `OPENAI_BASE_URL`。

最大能力差异是 **没有 built-in approval 和 filtering**：必须使用 `permissionMode: 'allow-all'`，不能通过 `activeTools`/`inactiveTools` 关闭 Codex 自带的 shell/web search；只有 host tools 的 approval/filtering 仍正常。文件改动有时以 dynamic `fileChange` parts 出现，而不是可见的 model-callable tool。该包曾有 tool relay authorization bypass，`<=1.0.28` 受影响、`1.0.29` 修复；任何 PoC 都必须锁定修复后的版本并限制 host-exposed sensitive tools。[官方安全公告 GHSA-qw9h-448j-6rph](https://github.com/vercel/ai/security/advisories/GHSA-qw9h-448j-6rph)

对 Cognia：已有 native `codex-app-server` adapter 和 ACP surface，原生路径更适合本地 workspace、交互式 approval 和 Codex-specific session features。Harness 更适合作为 remote sandbox execution/eval 的统一 rail，而不是取代现有 adapter。[external manager](../../lib/ai/agent/external/manager.ts) [Codex app-server client](../../lib/ai/agent/external/codex-app-server-client.ts)

### 3.3 Pi

`@ai-sdk/harness-pi` 封装 `@earendil-works/pi-coding-agent`。它是五者中架构最不同的一个：Pi runtime 和显式 `extensionFactories` 在 host Node.js 进程运行，sandbox 只是 remote filesystem/shell，所以不需要暴露端口，也可以使用 `@ai-sdk/sandbox-just-bash`。[官方页面](https://ai-sdk.dev/providers/ai-sdk-harnesses/pi)

Pi 的 model/auth 最灵活：可选 OpenAI、Anthropic、AI Gateway 或按 `<PREFIX>_API_KEY`/`<PREFIX>_BASE_URL` 注册 custom provider；built-ins 包含 read/write/edit/bash/grep/glob/ls，支持 approval 和 filtering。

关键安全边界是 inline extension：factory 拿到 host process 环境权限，只能加载可信代码；官方刻意关闭了 filesystem extension discovery、theme 和 prompt-template discovery。Cognia 已经通过社区 `pi-acp` adapter 接入 Pi；`@ai-sdk/harness-pi` 的潜在价值是改成直接封装 Pi runtime、减少社区 shim 的版本滞后风险，而不是从零增加 Pi coverage。Extension 仍必须经过与 Cognia plugin/tool bridge 同等级的信任、PII 和权限审计。[Cognia Pi surface](../../lib/ai/agent/external/ecosystem-adapters.ts)

### 3.4 OpenCode

`@ai-sdk/harness-opencode` 在 sandbox 内安装 bridge、`@opencode-ai/sdk` 和 `opencode-ai`，启动 OpenCode server 后通过 WebSocket 回传 session events。配置包括 provider-prefixed `model`、`provider`、`reasoningVariant`、`mcpServers` 和 bridge controls。[官方页面](https://ai-sdk.dev/providers/ai-sdk-harnesses/opencode)

Auth 可使用 Anthropic、OpenAI 或 AI Gateway，支持 built-in approval；built-in filtering 由 auto-rejection 实现。工具面比 Codex 更完整，包括 read/write/edit/bash/glob/grep/ls/webfetch/skill/todowrite/agent。

对 Cognia：项目已经有 OpenCode HTTP 和 v2 client，并直接依赖 `@opencode-ai/sdk`；harness bridge 还 pin 自己的 OpenCode SDK/CLI 版本。因此，除非目标明确是“把 OpenCode 放进统一 remote sandbox harness”，否则继续维护现有 protocol adapter 更直接。[OpenCode client](../../lib/ai/agent/external/opencode-client.ts) [OpenCode v2 client](../../lib/ai/agent/external/opencode-v2-client.ts) [Cognia package](../../package.json) [官方 bridge package](https://github.com/vercel/ai/blob/main/packages/harness-opencode/src/bridge/package.json)

### 3.5 Grok Build

`@ai-sdk/harness-grok-build` 不是直接实现一套 Grok bridge，而是配置 `@ai-sdk/harness-acp`，让 ACP 管理安装、session、stream、tools 和 lifecycle。第一次 session 需要 network egress，在 sandbox 内安装 pinned `@xai-official/grok@0.2.111`；CLI/ACP command 不能通过 `createGrokBuild()` 覆盖。[官方页面](https://ai-sdk.dev/providers/ai-sdk-harnesses/grok-build)

Direct auth 使用 `XAI_API_KEY`；Gateway 模式把 Gateway credential/base URL 映射成 Grok 所需 env。Common tools 包含 bash/edit/grep/webSearch/write，native tools 还包括 read/list/todo/subagent/monitor/workflow/scheduler/image generation。

限制主要来自 ACP v1：没有 portable model-step boundary/per-step usage、manual compaction、mid-turn steering、built-in filtering；adapter 只能推断 step，usage 可能 unknown。对 Cognia，新增 Grok Build 最低重复的路线很可能是先验证它能否直接接入现有 ACP adapter/preset；只有需要 AI SDK Harness 的统一 result/session contract 或远程 sandbox lifecycle 时，才值得再引入这个包。

## 4. 对当前 Cognia 项目的帮助

### 4.1 能直接带来价值的部分

| 价值                             | 对 Cognia 的具体意义                                                     | 建议                                                                       |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 统一 runtime contract            | 五种 runtime 归一为 session、stream parts、tools、usage、resume state    | 借鉴 contract；PoC 中验证映射到 canonical event envelope 的损失率          |
| AI SDK UI 兼容                   | 可接 `toUIMessageStream`/`useChat`                                       | 只在新的 host-backed surface 使用，不改主聊天存量 contract                 |
| Sandbox-first execution          | 适合不可信仓库、CI 修复、eval、远程 headless task                        | 这是最合适的首个产品场景                                                   |
| Host AI SDK tools + MCP + skills | 理论上能复用 Cognia 工具/skills，而不只用 runtime built-ins              | 必须复用 PII gate、permission resolver 和 restricted sandbox，不得另开旁路 |
| Cross-runtime eval               | 同一 prompt/session facade 对比 Claude Code/Codex/Pi/OpenCode/Grok Build | 很适合 agent eval、兼容性和回归基准                                        |
| Pi 直接集成                      | 可替代当前社区 `pi-acp` shim，直接封装 Pi runtime                        | 作为第二阶段对照 PoC；保留现有 ACP 路径作回退                              |

### 4.2 与现有架构的重叠

Cognia 已经有三条相关 execution surface：

1. **Model rail**：`lib/ai/provider-consumption.ts` 统一 provider settings/model resolution；`standalone-engine.ts`、`agent-executor.ts` 和 sidecar 用 `streamText` 驱动模型与工具。这一层仍应保留，因为它提供 Harness 当前缺少的 direct model control、typed structured output 和成熟多模态消息路径。[provider consumption](../../lib/ai/provider-consumption.ts) [standalone engine](../../lib/ai/chat/standalone-engine.ts) [agent executor](../../lib/ai/agent/agent-executor.ts)
2. **Claude rail**：sidecar 直接使用 Claude Agent SDK，并已经实现 Cognia built-ins、MCP/plugin tools、permission gate、PII gate、abort、plan mode 和 UI event translation。[AI SDK tool bridge](../../sidecar/dispatch/ai-sdk-tools.mjs) [sidecar package](../../sidecar/package.json)
3. **External-agent rail**：manager 已注册 ACP、Codex app-server、OpenCode/OpenCode v2、A2A、DSH 等 protocol adapters，并将事件归一到 canonical execution log。[external manager](../../lib/ai/agent/external/manager.ts)

因此，Harness 最合理的位置不是第四套平行 UI/chat stack，而是现有 host execution boundary 下的一个 **optional protocol/runtime adapter**：

```text
Cognia UI / workflow / eval
        -> existing canonical execution contract
        -> optional AI SDK Harness host adapter
        -> HarnessAgent + selected harness + sandbox provider
        -> normalized events back into Cognia canonical envelope
```

### 4.3 集成阻力

- **Static export boundary**：主 Next.js app 在 production 是 static export，Harness 的 Node/process/WebSocket/sandbox 依赖只能进入 sidecar/CLI/headless service，不能从 React renderer 直接 import。[Next config](../../next.config.ts)
- **版本对齐**：本次调研时项目 pin `ai@7.0.59`、`@ai-sdk/react@4.0.62`，尚未安装 Harness 包；npm 最新 `@ai-sdk/harness@1.0.71` 自身依赖 `ai@7.0.65`。PoC 前应成组升级/锁定 AI SDK、Harness core、adapter 和 sandbox provider，避免同一进程出现两份不兼容 AI SDK types/runtime。[Cognia package](../../package.json) [`@ai-sdk/harness` npm](https://www.npmjs.com/package/@ai-sdk/harness)
- **工作区同步**：官方 Vercel Sandbox 示例创建的是独立 remote filesystem。Cognia 需要定义 upload、增量 sync、Git identity、large repo、symlink/submodule、secret files、产物下载和冲突策略。
- **凭证/PII**：adapter 能通过 sandbox request transformation 注入 credential，但 Cognia 的 outbound prompt、host tool result 和 workspace-derived content 仍必须经过现有 `@cognia/redact` gate；不能因为流量由 Harness 发出就绕过治理。
- **权限语义差异**：Codex/Grok 的 built-in filtering 不足，不能直接套用 Cognia 现有“按 tool 精细禁用”的安全假设。
- **事件保真**：统一 projection 会隐藏一部分 native event。尤其 Grok/ACP usage/step 不完整、Codex file changes 可能是 dynamic parts，必须验证 canonical log、trace、token usage、approval UI 和 replay 行为。
- **冷启动和网络依赖**：bridge-backed adapter 第一次 session 安装依赖；Grok 明确要求 network egress。生产环境应准备可复用 sandbox template/snapshot，并锁定依赖供应链。

## 5. 推荐决策

### 当前决策

**不做主路径迁移；做一个窄范围、可删除的 host-side PoC。**

优先级建议：

1. **P0：contract/eval PoC。** 在 CLI 或 headless service 中接一个 bridge-backed adapter（Codex 或 OpenCode）和一个 host-process adapter（Pi），验证 streaming、abort、resume、host tool、permission、usage、workspace diff 到 Cognia canonical envelope 的映射。不改 renderer/provider settings。
2. **P1：remote sandbox coding task。** 选择一次性 CI/eval/不可信 repo 修复任务，补齐仓库上传、PII gate、artifact 回收和 teardown；这能真正利用 Harness 的 sandbox-first 优势。
3. **P1：Grok Build via existing ACP。** 先用 Cognia 当前 ACP rail 验证 Grok CLI；若 ACP native path 已满足需求，就没有必要只为一个 runtime 引入整套 Harness。
4. **P2：Pi direct-adapter 对照。** 若多-provider coding agent 或低 bridge 冷启动有明确产品需求，将 `@ai-sdk/harness-pi` 与现有 `pi-acp` 路径做兼容性、冷启动和事件保真对照；inline extensions 默认关闭，仅允许显式可信 factory。
5. **暂缓：替换 Claude/Codex/OpenCode 主集成、主聊天/附件路径、provider model abstraction。** 等 Harness API 稳定、structured output 和 direct multimodal input 补齐，并证明统一层没有丢失 Cognia 需要的 native features 后再评估。

### PoC 通过标准

- 同一套 Cognia canonical event consumer 能消费两个不同 harness，而无 runtime-specific UI branch；
- abort 在 2 秒内停止 runtime/tool，session 随后仍可用或可明确销毁；
- detach/stop/resume 后 workspace、conversation 和 pending approval 行为可预测；
- Cognia host tools 全部经过 permission resolver、PII gate、timeout 和 audit trace；
- 非 text input 被产品层显式降级为 sandbox file，不静默丢附件；
- remote workspace upload/download 对目标 repo 的 Git diff 无损；
- 统计冷启动、warm start、每 turn latency、sandbox cost 和额外 token/tool roundtrip；
- Codex adapter 版本高于安全公告修复线，且 sandbox 内不运行未审计依赖时暴露敏感 host tools。

## 6. 版本快照（2026-08-14）

官方 npm registry 在调研时返回：

| Package                       |   Latest |
| ----------------------------- | -------: |
| `@ai-sdk/harness`             | `1.0.71` |
| `@ai-sdk/harness-claude-code` | `1.0.74` |
| `@ai-sdk/harness-codex`       | `1.0.73` |
| `@ai-sdk/harness-pi`          | `1.0.72` |
| `@ai-sdk/harness-opencode`    | `1.0.72` |
| `@ai-sdk/harness-grok-build`  |  `1.0.7` |
| `@ai-sdk/harness-acp`         |  `1.0.8` |
| `@ai-sdk/sandbox-vercel`      | `1.0.71` |

这些数字是时间点快照，不是稳定性承诺。安装时应重新核对 release notes、依赖树和安全公告，并将同一 Harness release family 一起锁定。[Vercel AI repository](https://github.com/vercel/ai/tree/main/packages/harness) [npm `@ai-sdk/harness`](https://www.npmjs.com/package/@ai-sdk/harness)

## 7. 一手资料

- [AI SDK Harness overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)
- [HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)
- [Harness tools](https://ai-sdk.dev/docs/ai-sdk-harnesses/tools)
- [Harness adapters and capability matrix](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)
- [Claude Code adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code)
- [Codex adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/codex)
- [Pi adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/pi)
- [OpenCode adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/opencode)
- [Grok Build adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/grok-build)
- [Vercel `ai` Harness source](https://github.com/vercel/ai/tree/main/packages/harness)
- [Codex Harness security advisory](https://github.com/vercel/ai/security/advisories/GHSA-qw9h-448j-6rph)
