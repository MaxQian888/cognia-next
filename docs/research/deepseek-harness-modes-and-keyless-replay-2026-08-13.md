# DeepSeek Harness 模式体系与 Keyless Replay 专项附录

> 研究日期：2026-08-13
>
> DeepSeek Harness 基线：`47f943859bef60e4160492346772ded9b24f765a`（`master`，`0.1.0-rc.5`）
>
> Cognia 对照基线：`68e8dc3b178c5813a471a01e4f55770ab2dd69fe`（`dev`）
>
> 范围：补充分析模式体系与无密钥回放；只使用两仓源码、测试、Git 元数据和 DeepSeek 官方 GitHub 材料。

## 1. 结论先行

DeepSeek Harness（下称 DSH）中被统称为“模式”的概念并非一个枚举，而是多层合同：

1. `web/headless` 是进程级 runtime profile；
2. SDK 是 transport/composition，不是第三个内建 profile；
3. `standard/code/minimal/cordis` 是 agent preset，其中 `cordis` 在 UI 显示为 Creator；
4. `native/code/both` 是 tool presentation；
5. Plan 是 session-local durable state；
6. subagent、dynamic workflow、Ralph 是 delegation/orchestration policy 或工具。

对 Cognia，最重要的结构性建议是把当前宽泛的“mode”拆成五条正交轴：

| 轴                   | 回答的问题                       | 典型值                                                |
| -------------------- | -------------------------------- | ----------------------------------------------------- |
| preset/persona       | 模型是谁、收到什么提示与能力集合 | Standard、Minimal、Creator-like                       |
| authority            | 它被允许做什么                   | plan/read-only、default、full-access                  |
| tool presentation    | 工具如何暴露给模型               | native、code/PTC、both                                |
| orchestration policy | 如何委派、续接、预算与验证       | spawn/fork、one-shot/continuable、workflow/Ralph-like |
| runtime target       | 在哪里、通过何种协议执行         | AI SDK、Claude SDK sidecar、ACP、CLI/headless         |

这五轴可以形成用户友好的 preset，但持久化、切换、审计和安全检查必须分别处理，不能继续把 prompt、权限、运行时和编排语义压进同一个 `modeId`。

Keyless Replay 方面，Cognia **不应新增第二套 `AgentRuntimeEventV1`**。当前 committed baseline 已有 `AgentEventEnvelope` 与 durable canonical log：

- `packages/agent-config-types/src/agent-execution.ts` 定义统一 envelope 和 model/tool/permission/subagent/task/retry/recovery 事件；
- `lib/ai/agent/recovery/canonical-log.ts` 已实现持久 canonical log、幂等序列和恢复检查。

真实缺口是：在现有事件主干上增加可审计的 model-request surface/artifact，并建立两层 replay：

- **Canonical replay**：在 provider adapter seam 重放标准化模型流，验证 Cognia agent/runtime 语义；
- **Runtime replay**：通过本地 provider gateway 重放真实 SSE/HTTP，验证 Claude Agent SDK、AI SDK provider 和 external agent 的实际序列化与生命周期。

## 2. 模式分类：哪些是 UI 模式，哪些不是

| 层级              | DSH 实体                         | UI 可见性                    | 生命周期/持久化                   | 切换约束                |
| ----------------- | -------------------------------- | ---------------------------- | --------------------------------- | ----------------------- |
| Runtime profile   | `web`、`headless`、custom        | CLI 可见                     | profile 文件 + 进程               | 需重启，不是会话切换    |
| SDK composition   | stdio JSON-RPC + caller config   | SDK 调用方可见               | 子进程与 composition              | 由调用方启动/关闭       |
| Agent preset      | `standard/code/minimal/cordis`   | Web 新会话、Settings、header | preset generation + session event | 仅 blank session 可换   |
| Tool presentation | `native/code/both`               | 通常由 preset 隐式决定       | agent composition                 | 活跃 agent 不动态换     |
| Plan              | active/inactive/pending          | `/plan` 与 active chip       | `plan/mode` event                 | turn 内延迟到 pre-step  |
| Subagent policy   | spawn/fork、one-shot/continuable | 模型工具，不是顶层 UI mode   | child descriptor/session          | 由 provider/preset 固定 |
| Workflow/Ralph    | foreground tools                 | 模型工具                     | 单次 tool run                     | 不是 agent-loop mode    |

官方总入口：[`apps/cli/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/README.md)、[`agent-presets/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/preset/agent-presets/README.md)、[`tools/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/tools/README.md)、[`plan-mode/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/plan/plan-mode/README.md)。

## 3. Runtime profile：Web、Headless、SDK

### 3.1 Profile 是进程级插件栈

`dsh --profile <name>` 读取 `$DSH_HOME/profiles/<name>`；bundle patch 按 manifest 顺序合并，再叠加 profile patch、home patch 与 `--patch`。

`web` 和 `headless` 是 `PROFILE_TEMPLATES` 唯一会自动初始化的模板；`dsh web` 只是 `--profile web` 的 alias。实现见 `packages/boot/app-boot/src/profile.ts::{PROFILE_TEMPLATES,loadProfile,composeEntries}`：[官方源码](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L113-L125)。

Profile patch 可被 watch 并事务性重组；失败时保留 last-good tree。它影响整个 host composition，不应出现在会话 `mode` picker 中。

### 3.2 Web

Web 是 `dsh-base + dsh-web-app`，增加 HTTP/webserver、gateway、workspace、storage、projection cache 和 browser plugin roster。

它把 model-facing agent rows 从 host plane 移到 per-session preset；`ui-agent-preset`、`ui-plan`、`ui-workflow-run` 只是 browser surface，不拥有运行时语义。配置证据：[`web-app/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/web-app/cordis.patch.yml)。

### 3.3 Headless

Headless 是 `dsh-base + dsh-headless`：创建 fresh persisted agent，提交一个 positional task，等待 quiescence，flush session，打印最后一条非空 assistant 文本，再按 turn 结果退出。

它没有 Host、HTTP、Web 或 browser plugin，也没有同一 invocation 内的 follow-up。详见 [`packages/bundle/headless/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/headless/README.md)。

### 3.4 SDK 不是第三种内建 profile

`packages/sdk/` 提供协议、TypeScript client 和 stdio JSON-RPC server；调用者仍需给出 runtime executable 与 `cordis.yml`。

Wire 提供 initialize、prompt、shutdown 和 notifications，但没有 per-prompt result、session close 或 prompt cancel；`session/prompt` 返回 inbox admission `messageId`，不是最终回复。证据：[`packages/sdk/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/README.md)。

**Cognia 建议**：把 desktop/headless/CLI/ACP/external-agent 放在 runtime target 轴；session preset 不决定 transport，transport 也不隐式授予 authority。

## 4. 四个真实 Agent Preset

四个 system preset 位于 `apps/cli/config/agent-presets/`，`preset.yml` 提供展示元数据，`agent.cordis.yml` 提供真实能力：[官方目录](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets)。

### 4.1 Standard

Standard 是完整 coding-agent baseline，默认 native tools。

**Cognia：直接借鉴其角色**。把 Standard 定义为稳定能力基线；其他 preset 用显式差异生成，并把 resolved preset digest 写入每次 model-request artifact。

### 4.2 Code / PTC

Code 与 Standard 基本相同，差异是 `tool-presentation.mode: code`。

在 code presentation 下，模型直接看到 `run_code`，通过生成的 TypeScript/Python SDK 调用真实工具；越过 `run_code` 直接调用其他工具会先得到 `UNKNOWN_TOOL`。`both` 则同时暴露 native 与 code 入口。实现语义见 [`agent-tool-presentation/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-tool-presentation/README.md)。

**Cognia：适配采用**。Code 不应成为另一套 agent loop，应只是 tool-presentation 轴；其权限仍通过现有 permission gate，生成 SDK 也只能暴露已授权工具。

### 4.3 Minimal

Minimal 使用固定 persona、persistent bash、`str_replace_editor` 与 bare filesystem，不启用 compaction。

**Cognia：适配采用**。适合作为低变动、可复现的诊断 preset，但不能把“工具少”误当“权限低”；bash 仍是高权限能力。

### 4.4 Cordis / Creator

Creator 是 Standard 加 live Cordis inspection/mount 与 preset authoring skill；其信任级别等同 shell。`trust: system|user` 主要用于展示，不构成 sandbox。

**Cognia：建设正式的 Creator preset，但不直接采用其执行模型**。Creator 应成为与 Standard、Code、Minimal 并列的一等预置，服务于插件、Skill、Hook、Agent preset 和 VisualWorkflow 的创建与调试，而不是一个可绕过边界的“超级权限模式”。

建议的 resolved composition：

| 轴                    | Creator 默认值                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| `preset/persona`      | `creator`：理解 Cognia 扩展合同、模板、测试与发布规则                         |
| `authority`           | 仅 authoring workspace 内 `acceptEdits`；安装、提权、发布和外部副作用逐项审批 |
| `toolPresentation`    | `both`：简单操作用 native tools，批量检查/生成可用 Code/PTC                   |
| `orchestrationPolicy` | direct + 可调用 reviewer/verifier child；复杂产物可生成 VisualWorkflow        |
| `runtimeTarget`       | 优先本地/隔离 runtime；预览实例不得复用主应用的高权限 capability handle       |

Creator 的核心工具面应包括：

- 只读检查 resolved plugin/skill/hook/workflow/preset catalog、schema、权限和版本；
- 从仓库现有模板生成扩展，编辑范围锁定在专用 authoring workspace；
- 执行 manifest/schema/i18n/test/build/WASM capability 检查并给出结构化诊断；
- 在 disposable preview scope 中安装、热重载和观察 logs/hooks/performance；
- 生成权限 diff、产物 diff、snapshot diff，用户批准后才能安装到正式 registry 或导出/发布；
- 创建 verifier child 对功能、权限最小化、资源释放和 keyless replay fixture 做独立验收。

Cognia 已有 `lib/plugin/devtools`、WASM capability grant、插件权限门、hot reload diagnostics、`lib/skills`、Hooks、VisualWorkflow 和 disposable lifecycle 基础，应把这些能力编排成 Creator preset，而不是再造 Cordis。严禁模型在主进程挂载任意可执行 composition；插件 authoring 继续受权限、签名/来源、sandbox 和 disposable scope 管理。

Creator 的会话和预览也必须进入 full-surface snapshot：至少 pin 生成时的 system prompt、authoring tool schema、requested/granted permissions、preview generation、hot-reload/dispose 事件以及 reviewer child 日志。这样 Creator 本身的能力扩张也能在无 API Key CI 中被审查。

### 4.5 Preset 生命周期与切换

`AgentPresets.mount()` 为 preset 建 standing mount；session 通过 scope parent 加入。文件 `mtime + size` 变化只为新 session 建 generation，旧 session 继续使用旧 generation。

Child 使用同步 `composeFrom()` 继承父级同一 generation。创建 preset 写入 session header；blank-session switch 另写 `agent-preset/selected`，恢复时由 `resolveSessionPreset()` fold。

只有未产出内容的 blank session 可以 `recompose()`，避免新工具集无法解释旧 tool calls。详见 [`agent-presets/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/preset/agent-presets/README.md#where-to-call-mount)。

限制包括：generation 不会在进程内主动回收；stamp 不覆盖相邻 skill/asset 变化；user preset 仍是可执行代码。

**Cognia 建议**：冻结 `presetId + presetDigest + toolSetDigest` 到 turn/request，而不是只保存可变 `modeId`；有历史 tool calls 后，能力切换必须开启新会话或显式迁移。

## 5. Plan：durable state，不是 persona

`plan/mode {active}` 是 append-only、last-write-wins 的 session event；`foldPlanMode()` 可从任意日志前缀恢复。

- idle 时立即 append；
- open turn 时写 pending intent；
- 下一次 accepted `agent/pre-step` 才提交；
- same-step retry 使用已冻结 assembly，不消费 pending；
- `/plan [message]` 切换后可继续提交普通 user message；
- `exit_plan_mode` 始终注册，保持 tool catalog 稳定。

源码：`PlanModeController`、`foldPlanMode()` 与 `set()`，见 [`plan-mode/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/plan/plan-mode/src/index.ts)。

Web 用 `/plan` 与 active chip 显示状态；projection 能从 `command/run` 与 `plan/mode` 还原 pending target，但 service 的内存 pending intent 在极端重启点仍可能丢失。

Plan 只是 soft prompt guidance，不是 sandbox；mutation tools 仍在 catalog 中。spawn child 默认 inactive，fork child 因复制日志而继承状态。

**Cognia：保留并强化现有实现**。Cognia 已有 `AgentModeConfig.permissionMode: plan`、`PLAN_MODE_PROMPT`，以及更完整的 `AgentPlan/PlanRuntime` DAG、审批、预算、暂停、refine 与 workflow synthesis。应补的是 session-local collaboration state 和 request artifact，而不是复制 DSH 的简化 controller。

## 6. Subagent、Dynamic Workflow 与 Ralph

### 6.1 Subagent 是多维描述符

DSH 至少分三维：

1. provider：in-process spawn/fork 或外部 provider；
2. context seed：spawn fresh，fork 复制截至最后一个 `turn/end` 的 balanced prefix；
3. lifecycle/delivery：one-shot/continuable 与 foreground/background。

`subagent/descriptor` 是 durable event。One-shot 由 holder 管理资源并在完成后 dispose；continuable child 有 durable Session、单个 process-local Activation、cold resume、FIFO follow-up，interrupt 只取消当前 turn。详见 [`subagent/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/README.md)。

`send_message` 返回的是 admission，不是 child answer；`list_agents` 不列 one-shot child。

当前存在值得警惕的 config/docs 漂移：base/headless 把 spawn 设为 continuable、fork 设为 one-shot；Web Standard/Code/Creator 的真实配置却把两者都设为 continuable，而 fork README 仍宣称 shipped composition 没有 continuable fork。证据：[`standard/agent.cordis.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/standard/agent.cordis.yml#L186-L199)、[`base/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/cordis.patch.yml#L308-L330)、[`fork README`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent-fork-in-process/README.md#L58-L61)。

**Cognia：适配采用**。记录 `provider/contextSeed/lifecycle/delivery/authority/policySnapshot/presetDigest`，不要新增一个“subagent mode”总枚举；并以 conformance 校验 UI metadata、preset 和 provider runtime 声明一致。

### 6.2 Dynamic Workflow

Dynamic workflow 是 foreground tool：模型生成 JavaScript，在 worker thread 执行，再 fan-out subagent。结果用 `stopReason` 表达错误/取消，而不是 reject。

它不是已保存的 workflow，也不提供 background、journal/resume、嵌套 workflow 或 token budget；nested Code Mode dispatch 也不会完整进入 workflow transport event。

**Cognia：不复制执行器**。Cognia 已有可视化 workflow、run log 与恢复能力；只借鉴“模型提出临时 DAG”的 UX，将其编译到现有 workflow IR 后再验证、预算和执行。

### 6.3 Ralph

Ralph 是普通 foreground fixed-workflow tool，不是自循环 agent mode。每轮创建 fresh child，保持 immutable objective，通过 bounded structured handoff 和 workspace memory 延续；`continue/complete/blocked` 主要由模型自报。

它没有独立 verifier、checkpoint/resume、scheduler、fan-out、retry 或 token/cost budget。

**Cognia：适配采用模式，不复制工具**。复用 fresh child、bounded handoff、workspace memory；由 Eval scorer/verifier 判定完成，由现有 workflow journal、budget、pause/resume 管理运行。

## 7. DSH 的请求重建不变量

每个模型 epoch 的 `EpochHeader` 记录 resolved call config、adapter default markers、system prompt 与 ordered tool schemas；`Agent.buildRequest()` 在 dispatch 前物化默认值并写 full header。

Messages 由 session event prefix 的 `Session.deriveMessages()` 纯函数派生；`foldRequestHeader()` 取最近的完整 header。Invariant listener 在 replay provider 之前检查 frozen request/messages、session prefix、step/header 和派生结果相等。

`request-reconstruction.spec.ts` 用 theorem-style 测试覆盖默认值、route switch、resume、compaction、prompt 变化、middleware freeze 与 retry：[官方测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/tests/request-reconstruction.spec.ts)。

边界要说清：这证明内部 `GenerateOptions` 可重建，不证明 provider 最终 HTTP bytes、auth header、SDK serialization、cache 或 billing；`AbortSignal` 等 operational state 也不属于 durable request。

## 8. `llm-replay`：从日志恢复模型流

`deriveReplayScript()` 展开 packed rows，按 `(turn, step)` 收集 `assistant/chunk`；每个 `finish` 关闭一次 `stream()` call，同一 turn/step 可包含多次 retry call。

带 `llmStreamCall: true` 的 `compaction/summary.rawOutput` 会恢复为 canonical blocks；未 finish 的 group 视为异常流，需显式 override。源码：[`llm-replay/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/llm-replay/src/index.ts#L193-L262)。

Replay entry 支持：

- `chunks`：正常完整流；
- `throw`：先输出 prefix，再抛 `LlmError`；
- `hang`：输出 partial 后等待 abort，可用 `readyFile` 协调 cancel。

`replay.override.json` 可整体替换 primary script，或按 call index patch/append；loader 对未知字段、错误 discriminant、重复 index fail-loud。Child override 不受支持。

`{{fromRequest:<regex>}}` 会扫描 live messages 的 string leaves，最后匹配获胜；它适合回填随机 id，但不校验 system/tools/config，不能替代 request assertion。

Root 使用 `session.jsonl`，children 使用 `session.N.jsonl`；fork child 从 `seedLength` 后派生，避免重放继承的 parent chunks。

`assertConsumed()` 拒绝未绑定 script、少消费、额外 session/call。弱点是 live child 依赖首次 model call 顺序认领 fixture，并发 sibling 可能非确定。

Replay provider 可声明 provider/model/context/modalities/default max tokens/reasoning/retry；`paceMs` 只模拟节奏，不应成为正确性条件。

## 9. `acp-snapshot`：真实边界的无密钥 scenario

四层执行链：

1. `launchAcpTestAgent()` 启动真实 source/built subprocess 和 ACP SDK client，捕获 raw stdout/stderr/update，permission fail-closed；
2. `runScenario()` 驱动 initialize/new/prompt/fail/cancel/waits/permission，建立临时 cwd 与 session root，harvest parent/child JSONL；
3. normalizers 只稳定 identity/path/time；
4. `defineAcpSnapshotSuite()` 比较或刷新 stdout、session、header pins，并执行 fixture/UNKNOWN_TOOL guards。

官方说明：[`acp-snapshot/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/acp-snapshot/README.md)。

典型 fixture：

```text
scenario-name/
├── input.json
├── session.jsonl
├── session.1.jsonl
├── stdout.expected.jsonl
├── system-prompt.expected.md
├── tool-schemas.expected.json
├── replay.override.json
└── workspace/
```

三种工作流：

| 模式    | 模型来源                | 写入                 | 运行策略        |
| ------- | ----------------------- | -------------------- | --------------- |
| replay  | committed logs/override | 只比较               | keyless，可并行 |
| record  | 真实 provider           | 重录 model scenarios | 显式授权、串行  |
| refresh | committed replay        | 重写派生 goldens     | keyless、串行   |

入口见 [`vitest.snapshot.config.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/vitest.snapshot.config.ts) 与 [`suite.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/acp-snapshot/src/suite.ts#L1092-L1450)。

本次已验证的直接证据：

- `pnpm exec vitest run --config vitest.snapshot.config.ts -t code-mode-turn`：**1 passed、115 skipped，无 API key**；
- 一次意外全量运行：**114 passed、1 skipped、1 failed**，失败项为 `background-job-admission` snapshot drift。

后一个结果恰好证明：即使不访问 provider，这套门禁仍能发现 app/persistence/protocol 的真实跨层行为漂移。

## 10. Normalization、header pin 与安全边界

`normalizeStdout()` 逐行 parse JSON 并验证 stdout purity；RPC id 按出现顺序归一。Session normalizer 归一 createdAt、event/packed timing、hook duration，但保留 `seq` 与业务 payload。

cwd、macOS `/private` alias、session UUID、spill locator 被 token 化；separator 只在已知 path-bearing 字段中统一，避免破坏 command、regex 或模型文本。源码：[`normalize.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/test-support/acp-snapshot/src/normalize.ts)。

Refresh 只有在 logical layout 对齐且 normalized mapping 为双射时复用旧随机值；message id 还需 identity-free fingerprint 唯一，防止“为了稳定”掩盖真实结构变化。

每个 `headerClass` 必须有一个 `pinsHeader` scenario；完整 system prompt 与 ordered tool schemas 单独存 sidecar，普通日志只留 token。Child scope 可各自 pin。

捕获面包括 model chunks/usage/finish、resolved request surface、工具与权限、retry、root/child logs、workflow/session events、ACP stdout 与初始 workspace。

明确遗漏包括：

- provider 原始 delta partition、最终 HTTP/auth/serialization/cache/billing；
- 并发 sibling 的稳定 identity；
- compressed/SQLite harvest；
- stderr golden 与通用 final-workspace snapshot；
- Web 像素/CSS/layout 回归；
- 未标记 external summarizer，以及需 override 的 pre-chunk throw/hang。

Normalizer **不是 secret redactor**。用户/assistant 文本、tool args/results、shell/file 内容、完整 prompt/schema 都可能进入 Git；当前未见统一 API key/token/password scan。

**Cognia 安全要求**：Git fixture 只允许 synthetic data；录制前通过 PII/secret gate；真实 trace 继续使用加密 artifact、访问审计和 retention；replay/refresh 进程不得加载生产 provider secrets。

## 11. Cognia 的两层 Keyless Replay 设计

### 11.1 不重复事件主干

保留 `AgentEventEnvelope` 与 `canonical-log.ts`，新增 additive `ModelRequestSurfaceV1` artifact/reference，至少包含：

- `sessionId/runId/turnId/attemptId/parentRunId/modelCallOrdinal`；
- resolved provider/model/runtime/reasoning/sampling/output cap；
- model-visible system/append prompts、messages/attachments projection；
- ordered tool/MCP schemas 与 tool presentation；
- preset/persona、authority、orchestration policy、runtime versions/digests；
- content-addressed artifact refs 与 `requestDigest`。

不要把 secrets、raw auth headers 或不可重建的 `AbortSignal` 写入 canonical log。每次 outbound boundary 前，用纯函数重建并与 live request 做 invariant equality；replay adapter 不得绕过此检查。

现有 `lib/ai/eval/replay-bundle.ts` 是加密 Eval artifact 容器，不是 model stream replay。可以新增 request/stream artifact kind，但容器加密职责与 replay runtime 必须保持分离。

### 11.2 Tier A：Canonical replay

在 Cognia 的统一 provider/agent stream seam 注入 canonical replay adapter：

- 从 committed synthetic `AgentEventEnvelope` 派生 text/reasoning/tool/usage/finish；
- 以 `run/turn/attempt/parent/modelCallOrdinal` 精确绑定 root 与 child；
- throw/hang/cancel 用严格 override sidecar；
- `assertConsumed()` 检查未绑定、少消费、额外调用和额外 session；
- 同一 scenario 比较 canonical log、session materialization、wire frames、permission/elicitation、prompt/tool pins。

这是快速、provider-independent 的 PR 默认门禁，覆盖 AI SDK、ACP、CLI/headless 和 UI bridge 共享语义。

### 11.3 Tier B：Runtime replay

Runtime replay 让真实 SDK 仍发 HTTP/SSE，但目标是 localhost replay gateway；gateway 校验请求并返回录制/合成的 provider-native 流。

Claude rail 已有可复用基础：`sidecar/dispatch/live-harness.mjs` 和 `sidecar/dispatch/anthropic.live.test.mjs` 会启动真实 Claude Agent SDK/sidecar，指向本地 mock `ANTHROPIC_BASE_URL`，使用仅 localhost 的 dummy key。

已验证命令 `pnpm exec node --test sidecar/dispatch/anthropic.live.test.mjs`：**3/3 passed，6.43s**，覆盖 reply、session id 和 live steer。因而 Claude runtime replay 不需从零设计，只需把固定 mock 扩为 scenario-driven recorded SSE、严格 request matcher 与 consumption gate。

AI SDK rail 应按 provider transport 建本地 gateway/adapter contract test：Canonical replay 验证统一语义，Runtime replay 验证 AI SDK 的实际 request serialization、tool-call framing、abort/retry 和 finish mapping。

External agent/ACP rail 不假定都能改 `BASE_URL`：

- 可注入 endpoint 的 provider 使用 localhost HTTP/SSE replay；
- 只暴露 ACP/stdio 的 agent 使用 scripted transport peer；
- 无法无密钥启动的外部二进制只做 protocol conformance，不虚假宣称 provider-runtime coverage。

## 12. Cognia Fixture 建议布局

```text
tests/replay/scenarios/<scenario>/
├── scenario.json
├── requests/
│   ├── root.0.request.json
│   └── child-1.0.request.json
├── streams/
│   ├── root.0.canonical.jsonl
│   ├── root.0.anthropic.sse
│   └── child-1.0.canonical.jsonl
├── overrides/
│   └── root.1.throw.json
├── expected/
│   ├── agent-events.jsonl
│   ├── session.json
│   ├── wire.acp.jsonl
│   ├── system-prompt.md
│   ├── tool-schemas.json
│   └── workspace-manifest.json
└── workspace/
```

`scenario.json` 声明 runtime target、五轴配置、步骤、permission answers、等待条件、header class、fixture schema/version 和 synthetic-data classification。

文件名中的 root/child label 只是可读别名；真实绑定使用 canonical identity，不使用“第几个 child 首先调用模型”的竞态启发式。

Record/replay/refresh 规则：

- `record`：必须显式 live-provider flag、受控 credential、串行写入、PII/secret scan 后才可落盘；
- `replay`：默认 CI 路径，禁网或只允许 loopback，不读取 provider secret，只比较；
- `refresh`：仍由 keyless replay 生成派生 golden，串行写入，diff 必须人工审查；
- record 只更新 raw request/stream；refresh 才更新 normalization 后的 session/wire/sidecar，避免一次命令同时改“输入事实”和“期望事实”。

## 13. 分阶段路线图与验收

### Phase 0：合同与安全基线

交付：

- 定义五轴 resolved composition 与 `ModelRequestSurfaceV1`；
- 把 request artifact reference 加到既有 `AgentEventEnvelope`；
- 定义 stable call identity、digest、artifact classification；
- 建 synthetic-only、PII/secret scan、loopback-only test-token 规则；
- 为现有 Claude live harness 增加 reusable scenario loader 设计。
- 定义 Creator preset 的五轴 composition、authoring workspace 边界、审批点与 preview lifecycle。

验收：

- 给定同一 canonical prefix，request reconstruction 与 dispatch payload value-equal；
- preset、authority、tool presentation、orchestration、runtime 任一变化都会改变相应 digest；
- fixture secret canary 被门禁拒绝；
- 不新增平行 runtime event log。

### Phase 1：Canonical Replay MVP

交付：

- canonical stream recorder/loader、strict override、`assertConsumed()`；
- root/child/attempt/ordinal 精确绑定；
- transport-neutral scenario runner 与 normalization；
- AI SDK 主路径、headless/ACP 各接入一个真实 runtime scenario。

首批验收场景：text、native tool、code/PTC tool、parallel tools、permission approve/deny、retry、cancel/hang、compaction、child spawn/follow-up、plan enter/exit、provider switch，以及 Creator 创建扩展、权限审批、preview hot reload/dispose 和 reviewer child。

必须证明：无 API key、网络只允许 loopback、真实工具/permission/session persistence 仍执行；少一次或多一次模型调用都 fail；刷新后再次 replay 无 diff。

### Phase 2：Runtime Replay 与 CI/Eval 集成

交付：

- Claude localhost gateway 支持 recorded Anthropic SSE、request matcher、abort/retry/steer；
- AI SDK provider-native gateway fixtures；
- external-agent ACP/stdio scripted peer；
- Eval Lab 导入 replay case、加密 record bundle 与人工 refresh review；
- PR keyless suite、manual/nightly live-record lane、config/docs conformance gate。

验收：

- Claude 真实 SDK 在 dummy localhost-only key 下覆盖 reply/session/steer/tool/cancel/retry；
- Canonical 与 Runtime 两层对同一 scenario 产出等价 semantic envelopes；
- provider serialization drift、prompt/schema drift、subagent call-count drift、permission drift 各有故障注入测试；
- fixture schema/runtime version 不兼容时 fail-loud，不静默 normalize。

## 14. 风险与取舍

| 风险                    | 控制                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| prompt/tool/output 泄密 | synthetic-only Git、PII/secret gate、真实 bundle 加密与 retention         |
| snapshot churn          | 只归一已知 volatile；保留 seq/业务 payload；prompt/schema pin             |
| normalization 掩盖回归  | 双射/结构对齐后才复用值；UNKNOWN_TOOL 与 digest fail-closed               |
| 多 runtime 语义不一致   | canonical surface + runtime-native attachment；每条 rail 做 conformance   |
| 并发 child 绑定错误     | canonical parent/attempt/ordinal，不用 first-call order                   |
| replay 重复副作用       | disposable workspace、fake connector、loopback provider、权限 fail-closed |
| artifact 体积           | content-addressed blobs、dedupe、digest refs、retention，不删重建所需事实 |
| mode 继续耦合           | 五轴独立 schema/state；preset 只是组合，不是新的万能枚举                  |
| 配置与文档漂移          | 从 runtime manifest 生成可见 metadata，并在 conformance 中比较            |

## 15. 最终建议

### 直接采用

- full request snapshot + reconstruction invariant；
- replay/record/refresh 三态与 `assertConsumed()`；
- root/child 全表面 snapshot、prompt/tool-schema pins；
- blank-session capability freeze 与 preset digest；
- runtime config/UI metadata conformance。

### 适配采用

- Standard/Minimal/Code/Creator 作为五轴 preset；Creator 复用现有插件、Skill、Hook、Workflow、devtools 与 disposable scope，只在隔离 authoring workspace 中生成和预览；
- Plan 的 durable collaboration state，但继续使用 Cognia 的权限与 DAG；
- subagent descriptor 的正交字段与 lineage；
- Ralph 的 fresh child/bounded handoff，接入 Eval verifier 与 workflow journal；
- DSH replay 思路落为 Canonical + Runtime 两层，复用 Cognia 现有 canonical log、Eval Lab 和 Claude live harness。

### 不适合直接采用

- Cordis 可执行 preset loader，以及 Creator 的 shell-equivalent trust；这不代表放弃 Creator 产品形态；
- Plan 只靠 prompt；
- foreground-only、无 journal/budget 的 workflow/Ralph；
- SDK 无 cancel/session-close 的极简 wire；
- first-call-order child binding；
- 未经 secret scan 的完整日志入 Git；
- 用单个 `mode` 枚举承载 preset、权限、工具协议、编排与 runtime。

DSH 已用真实 subprocess、真实工具和真实 persistence 证明，模型网络调用可以被 durable request/stream artifacts 替代，而测试仍能发现跨层行为漂移。Cognia 的起点更高：事件主干、恢复日志、Eval Lab、conformance 与 Claude 本地 mock rail 已经存在。最短路径不是重建 harness，而是补上 request reconstruction、canonical replay、runtime replay gateway 和统一 scenario fixture。
