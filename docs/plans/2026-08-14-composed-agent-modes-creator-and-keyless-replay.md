# 可组合 Agent 模式、Creator 工作台与无 Key 快照回放

| 字段          | 值                                                                                     |
| ------------- | -------------------------------------------------------------------------------------- |
| 状态          | Draft for review                                                                       |
| 作者 · 日期   | Claude · 2026-08-14                                                                    |
| 范围          | Agent 模式契约与解析、Creator 工作台、Code 只读工具呈现、无 Key 模型请求回放、Eval CLI |
| 来源          | 用户提交的《Cognia 多模式、Creator 与无 API Key 快照回放完整实施计划》                 |
| 关联          | ADR-0117、ADR-0118；依赖 ADR-0090（统一 Agent 执行）、ADR-0101（Model Evaluation Lab） |
| 分支 / 里程碑 | 当前 `dev` 分支 · Phase 0 起分阶段                                                     |
| 评审方        | Agent Runtime · 插件/Creator · 安全与沙箱 · Eval/CI · 前端与 i18n                      |
| 取证状态      | 全部现状结论已在本仓库 2026-08-14 的工作区上逐条核对（见第 2 节）                      |

> **摘要**
>
> - **变更：** 把扁平的 `AgentModeType` 拆成五个独立控制轴，新增 Creator 内置预置与 `/creator` 工作台，新增只读的 `code` 工具呈现，并建设一套无需真实 API Key 的模型请求快照回放。
> - **原因：** 当前模式枚举把人格、权限、编排、来源混在一起；模式是全局 localStorage 而非会话属性；真正发给模型的请求面（system prompt、tool schema、归一化 messages）从不落盘，导致装配回归不可见、Agent 级用例无法进 CI。
> - **影响：** 运行时路由、权限上限、事件总线、沙箱、Eval 加密资产全部复用现有权威，不新建第二套；首期不新增 Dexie 表。
> - **决策：** 按 Phase 0 → 5 推进，Claude Agent SDK 作为第一个完整 Runtime Replay 实现；Code 首期严格只读，未达门槛不对普通用户开放。

## 1. 目标与非目标

### 目标

1. 普通用户只面对预置（Standard、Minimal、Code、Creator、领域预置），高级用户可独立调节权限 / 工具呈现 / 编排 / Runtime。
2. 每个 turn 冻结一份 `ResolvedAgentCompositionV1`，携带可复现的 digest。
3. Creator 成为正式内置能力，但默认仅开发者可见，且写入范围受 authoring root 约束。
4. `code` 工具呈现首期严格只读，任何 SDK 调用都必须回到统一 tool registry 与权限链路。
5. CI 在无真实 API Key、无外网的条件下能跑通 Agent 级回放。

### 非目标

- 不迁移到其他 Agent 框架，不替换现有 Eval、VisualWorkflow、权限、沙箱、Headless、Canonical Event 系统。
- 首期不实现 Code 模式的写工具、事务回滚与自动修复。
- 不在首期新增 Dexie 表或数据库版本迁移。
- 不回滚或重写当前工作区中已有的 Plugin lifecycle / resource-effects 在途修改。
- 不为 External/ACP 伪造"完整模型快照"能力。

## 2. 现状取证

| 结论                                                     | 状态   | 证据                                                                                                                                         |
| -------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 模式枚举混装人格、权限、编排、来源                       | 已确认 | `types/agent/agent-mode.ts:6`（`AgentModeType`）与 `:38`（`permissionMode`）                                                                 |
| `plan` / `build` 只是权限姿态，不是人格                  | 已确认 | `types/agent/agent-mode.ts:61-81`：两者仅设置 `permissionMode`，无人格差异                                                                   |
| 模式是全局 localStorage，不属于会话                      | 已确认 | `stores/agent/agent-runtime-store.ts:36-52`，persist v1，键 `cognia-next.agent-runtime`                                                      |
| 运行时路由已有权威，不能分叉                             | 已确认 | `packages/agent-config-types/src/agent-execution.ts:156`（policy）、`:228`（resolved spec）、`:221`（`RESOLVED_SPEC_VERSION=2`）             |
| `executionFingerprint` 已存在且已被消费                  | 已确认 | 契约 `agent-execution.ts:268`；计算 `lib/ai/agent/execution/resolve-agent-execution-spec.ts:372`                                             |
| 权限上限已有统一契约                                     | 已确认 | `types/agent/permission-ceiling.ts:11`（`AgentPermissionCeiling`）                                                                           |
| Canonical 事件词汇表可 additive 扩展                     | 已确认 | `agent-execution.ts:802`（envelope）、`:1219`（kind 列表）、`:1230`（未知 kind 必须被忽略）                                                  |
| 开发者模式存在三处独立信号                               | 已确认 | `stores/plugin-runtime/plugin-store.ts:197`；`components/plugins/plugin-devtools-panel.tsx:83`；`lib/plugin/core/manager.ts:2388`            |
| Eval 已有加密资产与可移植 bundle                         | 已确认 | `lib/ai/eval/artifact-crypto.ts`、`lib/ai/eval/assets.ts:98-110`、`lib/ai/eval/replay-bundle.ts`、`packages/eval-core/src/portable.ts`       |
| `cognia eval` 现有子命令为 6 个                          | 已确认 | `cli/src/cli/eval-command.ts:194-253`：`preflight` / `run` / `import` / `status` / `report` / `export`                                       |
| 已有 localhost mock Anthropic server，但只服务浏览器 E2E | 已确认 | `tests/e2e/mocks/anthropic/server.ts`、`tests/e2e/helpers/anthropic-control.ts`                                                              |
| Workflow 运行已有可复用的事件日志                        | 已确认 | `lib/workflow/runtime/event-log.ts:52`（`appendEvent`）、`:187`（`listRunEvents`）、`:223`（`createRunLogger`）                              |
| `readOnlyHint` 是第三方 MCP 注解，不是安全边界           | 已确认 | `types/agent/external-agent.ts:1751`、`lib/external-bridge/mcp-server/server.ts` 多处由服务器自行声明                                        |
| 真实模型请求面从不落盘                                   | 已确认 | 无任何模块持久化最终 system prompt / 归一化 messages / tool schema；仅 `AgentExecutionDecisionTrace`（`agent-execution.ts:833`）记录路由决策 |
| `@cognia/agent-config-types` 是纯源码包、零 `@/` 依赖    | 已确认 | `packages/agent-config-types/package.json`（无 build 脚本，`main` 指向 `src/index.ts`），源码无 `@/` 导入                                    |

补充事实两条，会影响排期而非设计：

- `@cognia/agent-config-types` 的包描述自称"仓库最宽的编译边界（约 750 个 importer）"。契约放这里是对的（CLI、sidecar、插件 SDK 共享），但每次改动的 typecheck 成本高，因此契约要一次性定稳，避免反复微调。
- 该包没有 build 脚本，也不在 `pnpm build:packages` 的 filter 列表中，所以不存在"子 tsconfig paths 覆盖导致独立构建失败"的风险。

## 3. 契约设计（Phase 0 交付物）

全部落在 `packages/agent-config-types/src/`，新增两个文件：`agent-composition.ts` 与 `model-request-surface.ts`，并由 `src/index.ts` 导出。

### 3.1 组合契约

```
AgentPresetDefinitionV1   预置定义：id、来源(builtin|custom|plugin)、人格、
                          systemPromptDelta、defaultToolSet、推荐轴值、可见性
                          (always|developer-only)、是否实验性
AgentCompositionSelectionV1  用户选择：presetId、authority?、toolPresentation?、
                          orchestration?、runtimeBindingRef?、legacyModeId?
ResolvedAgentCompositionV1  turn 冻结结果：schemaVersion、五轴解析值、
                          promptDigest、toolDigest、compositionDigest、
                          executionFingerprint、fallbackReason?、warnings[]
ToolPresentationMode      "native" | "code" | "both"
AgentOrchestrationPolicy  "direct" | "subagent" | "workflow" | "verified-fresh-agent"
```

Authority 复用现有 `AcpPermissionMode` 取值（`plan | default | acceptEdits | bypassPermissions`），Runtime 轴只保存对现有 `AgentExecutionPolicy` 的引用，不重新定义枚举。

### 3.2 Digest 规范（必须一次定稳）

| Digest              | 覆盖内容                                                                 | 明确排除                                       |
| ------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `promptDigest`      | 最终 system prompt 的完整文本（含预置增量、A2UI/goal/twin 注入后的结果） | 时间戳、会话 ID、用户消息正文                  |
| `toolDigest`        | 有序的 `(toolName, schemaDigest, visibility)` 列表                       | 工具实现版本、运行时统计                       |
| `compositionDigest` | 五轴解析值 + `promptDigest` + `toolDigest` + preset 版本                 | 用户 ID、会话 ID、`fallbackReason`、`warnings` |
| `requestDigest`     | 归一化 messages + 解析后的模型配置 + `toolDigest`                        | authorization 头、API Key、任何环境值、时间戳  |

算法统一为：RFC 8785 canonical JSON → UTF-8 → SHA-256 → `sha256:<hex>`,与
`lib/ai/eval/assets.ts:55` 现有 `contentDigest` 的前缀格式保持一致。

**规范化必须复用 `lib/plugin/character-pack/canonical-json.ts`,不能复用
`lib/ai/agent/execution/fingerprint.ts` 的 `canonicalizeSpec`。** 后者按设计会丢弃
名为 `timestamp` / `at` / `turnId` 等的键(任意深度),这对执行指纹是正确的,但用来
做内容 digest 会造成真实碰撞:一个带 `timestamp` 属性的 tool schema 与不带该属性的
schema 会得到相同 digest,从而共用同一条 replay tape。此约束已由
`lib/agent/composition/digest.test.ts` 中的回归用例钉死。

### 3.3 请求面与回放契约

```
ModelRequestSurfaceV1  runId/turnId/attemptId/providerAttemptId/parentRunId、
                       runtimeAdapter、provider、model、purpose、resolvedConfig、
                       promptRef/messagesRef/toolSchemaRef(加密资产引用)、
                       promptDigest/toolDigest/requestDigest、
                       compositionDigest、executionFingerprint
ReplayScenarioV1       actor、inputSteps、platform、replayLevel、
                       permissionScript、workspaceSeed、expectations
ReplayTapeV1           match(归一化条件 + requestDigest)、
                       behavior(stream | error | cancel | hang)、synthetic: boolean
```

Canonical 事件新增一个 kind：`model-request`，payload 只含 digest 与资产引用。
需同时更新 `agent-execution.ts:1167` 的 `CANONICAL_EVENT_KINDS` 与其类型联合。

## 4. 解析、迁移与冻结

### 4.1 旧 ID 映射

| 旧 `agentModeId`                                                                                                 | 预置           | 权限                                    | 编排       | 工具呈现               |
| ---------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------- | ---------- | ---------------------- |
| `general`                                                                                                        | Standard       | `default`                               | `direct`   | `native`               |
| `plan`                                                                                                           | Standard       | `plan`                                  | `direct`   | `native`               |
| `build`                                                                                                          | Standard       | `acceptEdits`                           | `direct`   | `native`               |
| `workflow`                                                                                                       | Standard       | `default`                               | `workflow` | `native`               |
| 领域模式（`research` / `writing` / `data-analysis` / `academic` / `web-design` / `code-gen` / `ppt-generation`） | 同名领域预置   | `default`                               | `direct`   | `native`               |
| custom / plugin                                                                                                  | 同名自定义预置 | 沿用其 `permissionMode`，缺省 `default` | `direct`   | `native`               |
| 未知 ID                                                                                                          | Standard       | `default`                               | `direct`   | `native`（附兼容警告） |

未知 ID 的回退**绝不**推断或继承 `bypassPermissions`。`lib/scheduler/executors/index.ts:174`
已有的"先内置后自定义"解析顺序保持不变，只在其后追加组合解析。

### 4.2 冻结与父子关系

- 组合在 turn 开始时解析并冻结，模型调用中途不得变化；切换只允许发生在空闲或 turn 边界。
- 子 Agent 的解析结果必须是父 `AgentPermissionCeiling` 的子集，扩大即拒绝。
- Reviewer 子 Agent 默认 `plan` 权限、独立上下文、独立 verifier，不复用生成 Agent 的隐式上下文。

### 4.3 持久化

- `stores/agent/agent-runtime-store.ts` 升到 persist v2，新增 `defaultComposition`；保留 `modeId` / `setModeId` 作为兼容适配层（`hooks/chat/use-apply-preset.ts:68` 等现有调用先不改）。
- 会话、scheduler payload、prompt preset、teammate preset、插件契约各新增一个可选 `compositionSelection` 字段，`agentModeId` 全部保留。
- 首期不新增 Dexie 表、不 bump schema 版本：新增字段均为非索引可选属性。

## 5. 开发者模式统一

**取证修正**：实施时逐行核对后确认,全局开发者模式信号只有**两处**而不是三处。
`lib/plugin/core/manager.ts:2543` 的 `plugin.config?.debug` /
`NODE_ENV === "development" && plugin.config?.devMode` 是**单个插件的调试插桩**开关
（决定是否给该插件创建 debug context），与"是否展示开发者界面"不是同一个概念，
强行并入会把一个插件的调试标志变成全局门禁。它保持独立。

真正重复的两处，以 `pluginSettings.developerModeEnabled` 为唯一来源收敛：

1. `stores/plugin-runtime/plugin-store.ts:197` 的持久化字段——此前只有
   `lib/plugin/devtools/managed-ide-dev-mode.ts:184` 读它，且没有任何写入方。
2. `components/plugins/plugin-devtools-panel.tsx` 里直接读写
   `localStorage["cognia.plugins.developerMode"]` 并把任意 development 构建视为
   开发者模式的分支，改为读写 store。

迁移规则：任一旧信号为 true 即迁移为启用（单向，只能开不能关，避免升级静默收回
用户已开启的设置）；旧 localStorage key **不清除**，以便降级回旧构建时设置仍在。

Creator 聊天预置的可见性与 `/creator` 工作台入口使用同一门禁。

## 6. Creator 工作台（Phase 3）

`/creator` 路由保持静态导出兼容：生产构建仍产出该路由，未启用开发者模式时只渲染访问门禁组件。

支持产物：Plugin、Skill、Hook、Agent preset、Visual workflow。

九步流程用现有 workflow run + `lib/workflow/runtime/event-log.ts` 表达，不新建项目数据库：
收集需求 → 检查已有实现与契约 → 生成 scaffold/编辑计划 → 展示权限差异并获批 →
生成或修改文件 → 执行 lint/typecheck/build/contract check → 沙箱预览与 hot reload →
独立 Reviewer 子 Agent 验证 → 用户批准安装/导出/发布。

安全边界：用户必须显式选择或创建 authoring root；文件与命令能力限制在该 root 内；
权限扩大、签名、安装、发布、外部写入各自单独审批；复用现有 `PluginDisposableScope`、
插件 CLI、Devtools 与 WASM capability grant，预览销毁后必须通过 cleanup 检查。

## 7. Code 只读工具模式（Phase 4）

模型只看到 `run_code` 与一份 typed 只读 SDK。SDK 内部调用回到统一 tool registry、
参数校验、权限、沙箱、日志与 Canonical Event，不得绕过用户授权或直连底层实现。

**资格来源必须是一方 allowlist**：工具目录中显式声明 `programmaticReadOnly=true`
才可用。不得从 MCP `readOnlyHint` 推导——该注解由第三方服务器自行声明（见第 2 节取证）。

执行环境：独立 Node 子进程 + 现有 OS 沙箱；文件系统为空或只读；网络关闭；
环境变量清洗；`node:vm` 内不暴露 `process`、`require`、`fetch` 或宿主对象。
严格沙箱不可用时 fail closed，不提供非沙箱回退。

首期限额：源码 32 KiB；wall time 30 秒；单次内部工具调用 64 次；最大并发 8；
聚合结果 1 MiB；内存 256 MiB。

## 8. 无 Key 回放（Phase 1、Phase 5）

- **两层**：Canonical replay（重放 envelope，验证 UI/恢复/权限状态/父子日志）与
  Runtime replay（真实 SDK + tool pipeline + 权限 + 持久化，仅替换模型端点）。
- **匹配**：每个父子 actor 独立 replay lease，在未消费 tape 中按归一化 requestDigest 匹配，
  不依赖全局顺序；同一 actor 内 digest 相同但响应不同 → fixture 构建失败。
- **收口**：`assertConsumed` 检查遗漏请求、额外请求、未消费权限、未完成子 Agent、孤儿日志。
- **存储**：复用 eval 加密资产与 `.cognia-eval` bundle，扩展 `model-request`、`model-stream`、
  `permission-tape`、`session-log`、`transport`、`workspace-manifest` 六种 artifact kind；
  录制 opt-in；捕获点在 PII gate 之后；删除 eval 资产时同步删除 replay 引用。
- **CLI**：`cognia eval` 在现有 6 个子命令上新增 `record`（须显式 live 标志、串行）、
  `replay`（默认无 Key、只读 fixture）、`refresh`（只更新可派生 golden，禁止重录 tape）。
- **Runtime 顺序**：Claude（扩展 `tests/e2e/mocks/anthropic/server.ts` 的 harness，
  用无权限占位 token 满足 SDK 参数校验、禁止真实外连）→ AI SDK 本地 provider adapter →
  External/ACP scripted peer（无法暴露内部请求时只保证 wire protocol + canonical 事件，
  并在报告中标记 fidelity 降级）。
- **平台**：浏览器只支持 Canonical replay；Runtime replay 需要 Tauri/headless 宿主，
  缺失时显示明确的禁用原因。

## 9. 分阶段交付与验收

| 阶段    | 交付                                                                                               | 验收                                                                  |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Phase 0 | 三组契约、digest 规范、兼容 resolver、legacy 迁移、开发者模式统一、shadow `model-request` 事件     | 新旧会话解析稳定；无权限升级；UI 与执行行为零变化；无破坏性迁移       |
| Phase 1 | fixture、tape server、`assertConsumed`、CLI 三命令、Claude 纵向切片、Eval Lab 基础 import/run/diff | CI 在无真实 Key、无外网条件下稳定通过                                 |
| Phase 2 | 预置选择器与高级轴上线；Standard/Minimal/领域预置启用；plan/build/workflow 转兼容 overlay          | Creator 仍隐藏；Code 显示为实验性或不可用；每种组合有可回放快照       |
| Phase 3 | `/creator`、authoring root、安全工作流、预览、Reviewer                                             | 覆盖五类产物；Creator 专属回放场景全绿；预览销毁无资源泄漏            |
| Phase 4 | 沙箱 runner、typed SDK、资格目录                                                                   | 见下方开放门槛；未达标继续保持实验隐藏                                |
| Phase 5 | AI SDK 与 External/ACP 回放；完整 UI 语义快照；跨平台 fixture                                      | 稳定 replay suite 从可选检查升级为合并门禁；内部停止直接依赖扁平 mode |

Code 广泛开放门槛（全部满足才解除隐藏）：零权限绕过；零非 loopback 网络访问；
任务成功率相对 native 下降不超过 5 个百分点；基准任务模型 turn 中位数至少下降 20%；
p95 总耗时恶化不超过 25%。

## 10. 测试矩阵与门禁

按仓库硬规则：`components/**`、`hooks/**`、`lib/**`、`stores/**`、`src-tauri/src/**` 下
每个新增或修改文件都必须有同位置测试，改动文件覆盖率 ≥90%（`pnpm test:coverage:changed --strict`）；
所有新增用户可见文案必须同时进 `i18n/messages/en.json` 与 `zh-CN.json`；
每个用户可见变更补一条 `pnpm changeset`。

自动化场景：

- **组合**：全部旧 ID 映射、自定义/plugin 预置、未知 ID 安全回退、父子权限上限、turn 冻结。
- **Runtime**：三种 runtime 的 execution fingerprint 与工具集合一致性。
- **Replay**：纯文本、native tool、code tool、并行调用、批准/拒绝、重试、hang、取消、
  pre-chunk error、compaction、provider 切换。
- **多 Agent**：orchestrated child、SDK native child、父取消、子失败、孤儿检测、verified fresh agent。
- **Code 安全**：`process` / `require` / `fetch` / 文件系统 / 网络逃逸；无限循环、内存、
  并发、RPC 畸形、取消、嵌套权限。
- **Creator**：路径逃逸、权限差异、生成失败恢复、preview hot reload、dispose、独立 Reviewer、发布审批。
- **UI**：预置与高级轴、开发者门禁、Creator 状态机、Replay diff、键盘操作、ARIA 与中英文文案。
- **数据**：localStorage v2 迁移、旧会话、Eval bundle 导入导出、加密与删除传播。
- **安全**：PII gate 顺序、secret 扫描、认证头剥离、无非 loopback egress。

合并前至少执行：

```bash
rtk pnpm typecheck && rtk pnpm lint && rtk pnpm i18n:build && rtk pnpm i18n:build:check && rtk pnpm lint:i18n && rtk pnpm lint:static-export && rtk pnpm sidecar:test && rtk pnpm test:evals && rtk cargo test -p cognia-automation && rtk pnpm build
```

外加聚焦的 Playwright 与 Tauri Runtime Replay 用例，以及 `pnpm docs:build`（本计划新增的两篇 ADR 是 MDX 预渲染的唯一门禁）。

## 11. 可观测性与发布红线

有界指标：composition 解析结果与安全回退次数；replay 成功率、fidelity、mismatch 分类；
Code 模式耗时、内部调用数与 limit 命中；Creator 各阶段成功率、恢复率与 dispose 泄漏。
**不记录**用户 prompt、文件内容、路径或高基数 run ID。

发布红线（任一命中即停止发布）：secret canary 泄漏；真实外网请求；权限绕过；
未消费的模型/权限 tape 被忽略；Creator 预览销毁后仍存在资源泄漏。

## 12. 回滚

- 关闭 `agentCompositionV2` → 恢复旧选择器，继续读 `agentModeId`。
- Code kill switch → 立即移除 `run_code` 与 Code 预置。
- Creator 由统一开发者模式门禁隐藏，可单独关闭。
- 新增事件与字段均为 additive，旧版本忽略未知事件。
- 已生成的 workflow run 与加密 replay 资产保持可读或按原保留策略清理，不做数据降级。

## 13. 实施状态

**Phase 0 已完成并验证**（2026-08-14）。落地文件：

| 文件                                                               | 内容                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/agent-config-types/src/agent-composition.ts`             | 五轴契约、`AUTHORITY_RANK`、`narrowAuthority`、digest payload、校验器 |
| `packages/agent-config-types/src/model-request-surface.ts`         | 请求面、tape、scenario 契约、`findAmbiguousTapes`、校验器             |
| `packages/agent-config-types/src/agent-execution.ts`               | 新增 `ModelRequestPurpose` 与 `model-request` canonical 事件          |
| `lib/agent/composition/digest.ts`                                  | SHA-256 内容 digest（复用 RFC 8785 规范化器）                         |
| `lib/agent/composition/preset-catalog.ts`                          | Standard / Minimal / Code / Creator + 既有 mode 的投影                |
| `lib/agent/composition/legacy-mode-mapping.ts`                     | `agentModeId` 迁移与安全回退                                          |
| `lib/agent/composition/resolve-composition.ts`                     | 解析、封顶、父子上限、降级告警                                        |
| `lib/plugin/devtools/developer-mode.ts`                            | 开发者模式唯一来源与单向迁移                                          |
| `components/providers/initializers/developer-mode-initializer.tsx` | 启动迁移，已挂载于 `app/layout.tsx`                                   |

验证结果：改动文件全部带同位置测试，152 个用例通过；覆盖率
statements/functions/lines 100%，branches 最低 90.9%（均达 90% 线）；
`agent-config-types` 全量 + canonical 事件消费方共 397 用例通过；
ESLint 无告警；全量 `tsc --noEmit` 中我改动的文件零错误。

**Phase 1 进行中**。已完成回放基座（纯逻辑，可被 app 与 CLI 共用）：

| 文件                                           | 内容                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `lib/ai/replay/normalize-anthropic-request.ts` | wire payload → 归一化请求面 → 四个 digest（录制与回放共用同一实现） |
| `lib/ai/replay/lease.ts`                       | 按 actor 的 tape lease、匹配、`assertConsumed`、报告格式化          |
| `lib/ai/replay/fixture.ts`                     | fixture 校验、actor 交叉引用、歧义拒绝、synthetic 准入、可用性判定  |

归一化明确丢弃三类字段，每一类都有理由：`metadata`（含 `user_id`，既破坏跨用户
匹配也会把标识符写进可提交 fixture）、`cache_control`（prompt cache 断点只影响
计费与延迟）、`stream`（同一问题以流式或整体返回仍是同一个问题——行为由 tape 表达）。
tool **顺序**保留，因为 provider 对其敏感。

已完成回放与录制的可执行部分（Node-only，落在 `cli/`，不进 app bundle）：

| 文件                                         | 内容                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `cli/src/eval/replay/tape-server.ts`         | loopback tape server：SSE / 整体响应 / error / cancel / hang，未命中显式拒绝  |
| `cli/src/eval/replay/recording-proxy.ts`     | 透传录制代理：转发真实 provider、抽取 text delta、生成 tape，不留存任何请求头 |
| `cli/src/eval/replay/run-replay.ts`          | 编排：加载 → 可用性判定 → 启动 server → 驱动 → `assertConsumed`               |
| `cli/src/eval/replay/fixture-maintenance.ts` | `record` 会话捕获与 `refresh` 派生项整理（绝不触碰 behavior/digest）          |
| `cli/src/cli/eval-command.ts`                | 新增 `replay` / `record` / `refresh` 三个子命令                               |

两个关键实现决策（与初版设想不同，已在实现中修正）：

1. **actor 路由走 URL 而非 header**。provider SDK 只接受一个 base URL，不会附加自定义
   header，因此 actor 由路径承载：`/a/<actorRef>/v1/messages`，由
   `TapeServer.baseUrlFor(actorRef)` 生成。子 Agent 只要用各自的 `ANTHROPIC_BASE_URL`
   启动即可自动落到自己的 lease。
2. **purpose 在回放期通常不可得**，因为没有任何 provider SDK 会转发"我为什么调用模型"。
   因此新增 `ReplayLease.takeByDigest()`：以 digest 为强键匹配，仅当该 actor 下唯一命中
   时才消费；跨 purpose 出现同 digest 多条候选时拒绝并记为 unmatched，绝不猜测。

Claude 纵向切片的 runtime driver 已完成：`cli/src/eval/replay/runtime-driver.ts`
（由 `cognia eval replay --runtime` 触发）。它跑真实的 CLI agent session——真实
build-options、真实 sidecar、真实 SDK、真实 tool pipeline、真实权限 gate、真实持久化
——只通过 `SendOptions.env` 覆写把模型端点指向 tape server。注入的
`ANTHROPIC_API_KEY` 是自描述占位串 `cognia-replay-no-credential-required`，仅用于
满足 SDK 的"必须有 key"检查；它一旦出现在任何 provider 日志里就是发布红线，
而不是好奇心。权限脚本按 `(toolName)` 单次消费，脚本外的请求一律 deny——回放绝不
授予录制中不存在的权限；子 Agent 生命周期从 canonical 日志读取，未完成者计入
`assertConsumed` 的 loose ends。

`lib/ai/replay/model-request-shadow.ts` 提供 shadow `model-request` 事件的构造：
从已解析的 SendOptions 切片（systemPrompt / allowedTools / model / 采样参数）算出
prompt、tool、request 三个 digest，只输出 digest 与引用。`containsOnlyDigestsAndRefs()`
被导出并有用例钉死，用来防止有人日后把 payload 扩宽成内容——那是"可观测信号"和
"数据泄漏"之间唯一的区别。注意其 `requestDigest` 是 **prompt+tools 身份**而非完整
replay key（`resolveSendOptions` 运行时 message 列表尚未定稿），完整 tape 仍由
recording proxy 产出。

**Phase 1 尚未完成**：把 shadow 事件接到真实发送路径的发射点（构造器已就绪，
尚未在 send 路径上调用）、Eval Lab 的 Replay 工作区（导入 / preflight / 运行 /
diff / refresh 审批）。

**Phase 2 已完成核心**（预置 UI 与高级轴，已接入真实界面）：

| 文件                                                  | 内容                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `i18n/messages/{en,zh-CN}/agentComposition.json`      | 选择器、三条高级轴、解析摘要与全部降级告警文案（中英已对齐）      |
| `i18n/messages/{en,zh-CN}/agentMode.json`             | 新增 standard / minimal / code / creator 四个预置的名称与描述     |
| `stores/agent/agent-runtime-store.ts`                 | persist v2：`defaultComposition` + `sessionCompositions`，v1 迁移 |
| `components/agent/composition/composition-picker.tsx` | 预置选择 + 高级轴 + 解析摘要 + 告警                               |
| `components/chat/session-settings-sheet.tsx`          | 挂载点（按会话作用域）                                            |

两点设计要点：

1. **组合按会话保存**。旧实现只有一个全局 `modeId`，在一个会话里改模式会静默改掉
   其它所有会话（包括正在跑 turn 的那个）。store 现在分成"新会话的默认值"与
   "每个会话自己的选择"两件事，`modeId` / `setModeId` 保留为兼容适配器并与
   `defaultComposition.presetId` 双向同步，避免未迁移的读取方看到陈旧值。
2. **摘要展示的是解析结果而不是请求值**。组合可能被预置上限、父 Agent ceiling 或
   宿主能力静默收窄；只显示用户所选会对下一轮的实际行为撒谎。

**Phase 3 已完成骨架与全部安全边界**（`/creator` 工作台）：

| 文件                                           | 内容                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `types/creator/index.ts`                       | 五类产物、九步、五类独立审批、authoring root、权限差异、评审结论、销毁报告 |
| `lib/creator/steps.ts`                         | 九步状态机；`canAdvance` 与独立的 `canWrite`                               |
| `lib/creator/authoring-root.ts`                | 唯一根 + 密钥/VCS deny 列表；委托 `lib/files/permissions.ts` 做包含判定    |
| `lib/creator/permission-diff.ts`               | 扩大需审批、收窄不需要；审批绑定到具体新增集合                             |
| `lib/creator/run-log.ts`                       | 进度写入既有 workflow run event log，并可从日志重建                        |
| `lib/creator/preview.ts`                       | 预览生命周期基于 `PluginDisposableScope`，销毁后做泄漏检查                 |
| `lib/creator/reviewer.ts`                      | 独立 Reviewer：`plan` 权限 + 只读根 + 封闭 brief（无对话上下文入口）       |
| `stores/creator/creator-store.ts`              | 只存"授权"与"运行指针"，不存步骤状态                                       |
| `components/creator/*`、`app/creator/page.tsx` | 门禁、根授权、步骤轨、权限差异、评审面板                                   |
| `lib/runtime/surface-contract.ts`              | `/creator` 登记（不进导航栏，入口在同门禁的 devtools 面板）                |

四点设计要点：

1. **包含判定不重写**。`lib/files/permissions.ts` 已经实现了根匹配、`..` 归一、
   Windows 盘符/UNC 与分段级 deny glob 并有完整用例；在 Creator 里再写一遍等于造出
   第二条更弱、且会与第一条漂移的边界。本模块只加 Creator 专属策略（唯一根、
   密钥 deny 列表、写入需审批）。同时保留原模块的性质说明：这是**词法预检**，
   看不见指向根外的符号链接，权威判定仍是 Rust `*_confined` 命令。
2. **步骤顺序就是安全属性**。唯一可写的 `apply-changes` 排在 `approve-permissions`
   之后，并由 `canAdvance` 强制，而不是靠调用方自觉按序走。`canWrite` 与之分离，
   让文件层可以直接断言，不依赖 UI 先调用过 `canAdvance`。
3. **审批绑定到具体新增集合**。生成器二次运行、多要一项能力时，
   `approvalCoversDiff` 返回 false，旧审批不再生效——否则第二遍生成可以借着
   用户为更小集合给出的批准把能力夹带进来。
4. **进度只有一份**。步骤状态一律从 run event log 重建，store 里没有第二份副本；
   两份"权限门是否已过"迟早会分歧，而分歧的那一次就是越权写入。

**九步执行体已补齐**：

| 文件                                       | 内容                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| `lib/creator/executor.ts`                  | 九步编排；`runCreatorStep` 单步、`runCreatorPipeline` 连续推进 |
| `lib/creator/file-writer.ts`               | 三道写入门禁（运行状态 → 词法预检 → Rust `*_confined`）        |
| `lib/creator/handlers.ts`                  | 四个外部端口的默认实现：未接通的一律大声失败                   |
| `hooks/creator/use-creator-run.ts`         | 持有 per-process 的 plan（日志里没有、也不该有）               |
| `components/creator/creator-workbench.tsx` | 需求输入 + "运行流程"按钮 + 停在哪一步的原因                   |

四点设计要点：

1. **外部世界一律走注入端口。** 生成器、工具链、沙箱预览、Reviewer 分别活在四个不同
   运行时（agent session、宿主 shell、插件 scope、子 Agent）。直接调用的编排器根本
   跑不进渲染端，更不可能在没有桌面宿主的情况下被测。
2. **未接通的端口大声失败，不静默成功。** 一个"报告生成器没接通"的步骤是诚实的、
   会进运行日志；一个悄悄返回空计划的步骤会让流程一路走到交付却什么都没产出。
3. **写入有三道门,顺序固定。** 运行状态(`canWrite`)→ 词法预检(`checkCreatorAccess`)
   → Rust `*_confined`(权威、能看见符号链接)。第一道在解析路径之前就检查,
   跳过门禁的调用方从错误里学不到任何文件系统信息。
4. **恢复运行时重新推导,而不是持久化。** plan 里是文件内容,不该进"可以附在 bug
   报告里"的日志。所以重载后的运行会重跑可重复的生产者(`plan-scaffold` / `verify`)。

**执行体开发中发现并修掉一个安全漏洞。** 恢复运行时 `approve-permissions` 在日志里
已标记完成,`canAdvance` 不会再问一次;于是重新生成的、更宽的 plan 会带着为更窄
diff 授予的批准直接写文件。修法是在重新推导之后无条件复查 `approvalCoversDiff`,
与首次通过时的防夹带是同一条规则。这个洞是被"恢复运行"的用例逼出来的,不是读代码
读出来的。

**生成器 / Survey / Reviewer 三个 agent 端口已接通**：

| 文件                               | 内容                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| `lib/creator/agent-ports.ts`       | 三段 prompt + 严格解析器 + handler 工厂（纯，注入 `runTurn`） |
| `lib/creator/agent-turn-runner.ts` | 真实 `runTurn`：PII 门禁、只读收窄、Reviewer 会话隔离         |

复用的是 `runAndCaptureAssistantReply` —— connector 自动回复、Agent Team、
定时 goal、插件 Agent SDK、eval 都走这一条，Creator 因此自动共享执行 broker 的
全局并发上限、可观测性与取消。

四点设计要点：

1. **模型输出是不可信输入，解析严格。** 只接受形状完全正确的 JSON 对象；
   单条 file 项非法则整个 plan 被拒，而不是跳过那一条——写一半比不写更难收拾。
   `extractJson` 不会"扫描第一个 `{`"，否则散文里的示例也会被当成结果解析。
2. **路径在解析期和写入期各查一次，职责不同。** 解析期查是为了给出清晰的整体拒绝，
   写入期(`writeCreatorFile`)查是边界——即使解析器哪天被绕过，边界仍然成立。
3. **只读是在 spread 之后重新断言的。** `resolveSendOptions` 解析出的默认值可能很宽；
   runner 在展开它之后无条件把 `permissionMode` 压回 `plan`、把 `allowedTools`
   换成读工具集。生成器只负责"提议"，写盘只有 `writeCreatorFile` 一条路。
4. **Reviewer 的会话隔离是构造保证的。** `purpose === "review"` 每次新铸一个 session id，
   调用方即使显式传入 `authoringSessionId` 也无法把生成器的上下文交给它；
   报告的 authority 取自 runner 而非模型自述——自述的话审阅面板那行"证据"就没意义了。

**Phase 3 尚未完成**：`verify`（需要宿主 shell 跑 lint/typecheck/build/contract）
与 `deliver`（安装 / 导出 / 发布）两个端口仍未接通，会以命名的失败出现在 UI 与
运行日志里。三个 agent 端口是**未经真实模型验证的**：解析器、门禁与隔离都有用例，
但没有跑过一次真实的端到端生成。

**Phase 4 已完成执行器与全部安全边界**（Code 只读工具呈现）：

| 文件                                                 | 内容                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `lib/settings/builtin-tools-data.json`               | 32 个工具显式标注 `programmaticReadOnly: true`（一方 allowlist）  |
| `lib/ai/code-mode/eligibility.ts` + 同名 `.mjs`      | 渲染端与 sidecar 共读同一份 allowlist                             |
| `lib/ai/code-mode/limits.{ts,json}`                  | 六项限额；JSON 为唯一真源，supervisor 直接读同一份                |
| `lib/ai/code-mode/sdk-typegen.ts`                    | 由真实 JSON Schema 生成 typed SDK `.d.ts`，不手写签名             |
| `lib/ai/code-mode/availability.ts` + `host-probe.ts` | fail closed 判定 + kill switch；喂给 `supportedToolPresentations` |
| `sidecar/builtin-tools/run-code/sandbox-child.mjs`   | `node:vm` 受限 realm，SDK 在 realm 内构造                         |
| `sidecar/builtin-tools/run-code/supervisor.mjs`      | 子进程、环境清洗、空 cwd、限额、allowlist 复核、结果封顶          |
| `sidecar/builtin-tools/run-code/index.mjs`           | `run_code` 工具定义；宿主无沙箱时不注册该工具                     |

四点设计要点：

1. **资格是显式一方 allowlist，不是推导。** `requiresApproval === false` 只表示
   "不弹审批",`TodoWrite` / `TaskCreate` / `TaskUpdate` / `monitor_cancel` 都带这个
   标记且都会改状态。`divergesFromApprovalFlag()` 被导出并有用例钉死:它一旦返回空
   列表,就说明有人把资格重新定义成了审批标记。同样也不从 MCP `readOnlyHint` 推导
   ——那是第三方服务器自述的注解,不是安全边界。
2. **沙箱里发现并修掉了一个真实逃逸。** 第一版把宿主 realm 的函数直接注入 vm 上下文,
   于是 `cognia.read.constructor("return process")()` 能在**宿主 realm** 编译执行
   （`codeGeneration: { strings: false }` 只约束沙箱 realm),拿到子进程真正的
   `process`。现在 SDK 由一段 in-context 引导脚本构造,宿主桥接函数只作为闭包参数存在;
   工具**结果和错误**也以 JSON 文本过界、在 realm 内 revive,否则结果对象的原型链
   同样会把宿主 realm 泄漏出去。三条逃逸路径各有用例。
3. **`both` 与 `code` 一起受门禁。** `both` 暴露同一个 `run_code` 执行器,只挡 `code`
   会留下一条通往同一沙箱的无防护路径。
4. **fail closed 没有开关。** `assertSandboxable()` 是唯一判定点,没有任何 flag、
   环境变量或参数能把它变成警告;宿主无严格沙箱时 `run_code` 根本不注册。

**Phase 4 接线已打通**（端到端可达）：

| 环节         | 实现                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| 组合上线     | `AgentExecutionSendSpec.composition`（新增可选字段，回答第 14 节未决问题 1）      |
| 组合解析     | `lib/agent/composition/resolve-turn-composition.ts` → `build-options.ts` 发送路径 |
| sidecar 分发 | 两条 dispatch 都读 `execution.composition.toolPresentation`                       |
| 工具面切换   | `applyToolPresentation()`：`code` 只留 `run_code`，`both` 追加，`native` 原样返回 |
| SDK 声明     | `sdk-declaration.mjs` 由真实 `inputSchema` 生成，嵌入 `run_code` 的 description   |
| 宿主探测     | `sandbox_health_check`（ADR-0028 主动确认探针）→ `useCodeSandboxPresentations`    |
| 实际约束     | supervisor 通过 `COGNIA_CODE_SANDBOX_LAUNCHER` 的 argv exec 包装器启动子进程      |

三点补充说明：

1. **`strictSandbox` 从"声明"改成了"机制"。** 早先版本读一个裸的
   `COGNIA_STRICT_SANDBOX=1` 标记——任何人都能设置，而且 sidecar 自身是不受约束地
   运行的（它需要外网访问模型），fork 出的子进程因此不会继承任何约束。现在必须提供
   一个真实的 exec 包装器 argv（Rust 侧由 `crate::sandbox` 渲染 bwrap / sandbox-exec），
   `strictSandbox` 为真当且仅当这个包装器存在。IPC 走 fd 3，两种后端都会透传。
2. **渲染端用的是主动确认探针而不是廉价可用性探针。** `sandbox_health_probe` 只检查
   后端二进制是否存在，一个"存在但坏掉"的后端在它那里是 `available: true`；
   `sandbox_health_check` 会真的跑一遍受限命令。Code 只认后者。
3. **SDK 声明生成移到了 sidecar。** 只有这一层拿得到工具的真实 `inputSchema`；
   渲染端只有工具名，在那里生成就只能编造签名，而"能通过编造签名类型检查的生成代码"
   比没有声明更糟。原先的 `lib/ai/code-mode/sdk-typegen.ts` 已删除，不留悬空实现。

Rust 侧的注入也已接上：`src-tauri/src/claude/code_sandbox.rs` 复用既有的
`cognia_automation::sandbox::launcher`（`bwrap_prefix` / `sandbox_exec_prefix`，
与受限终端、Canvas Python 执行同一套渲染器）产出 argv 前缀，
`sidecar.rs` 在 spawn 时写入 `COGNIA_CODE_SANDBOX_LAUNCHER`。scope 为：
scratch 目录唯一可写、Node 运行时与 sidecar 目录只读、网络无条件关闭——
工具调用一律走 IPC 回宿主，`run_code` 子进程没有任何正当理由开 socket。

注入**有意做成不可失败**：没有沙箱后端的宿主（当前的 Windows、未装 `bwrap`
的 Linux）是受支持的正常配置，为了禁用一个可选模式而让 sidecar 起不来、
整个聊天不可用是不成比例的。变量不设置的后果就是 Code fail closed。

**macOS 上已用真实 `sandbox-exec` 端到端验证**（不是靠推断）：

| 断言                                       | 结果                                     |
| ------------------------------------------ | ---------------------------------------- |
| fd 3 的 IPC 通道穿过 `sandbox-exec` 包装器 | 通过（工具调用往返正常，5 连发亦可）     |
| 受限子进程内 vm 仍无 `process`             | 通过（`typeof process === "undefined"`） |
| 写 scratch 目录之外                        | 拒绝                                     |
| 写 scratch 目录之内                        | 允许（**修正后**，见下）                 |
| 出网                                       | 拒绝（EPERM）                            |

**验证过程发现并修掉一个真 bug。** Seatbelt 的 `subpath` 规则按**解析后**的真实路径
匹配，而 macOS 的 `std::env::temp_dir()` 返回 `/var/folders/…`（指向
`/private/var/folders/…` 的符号链接）。未解析就写进 profile，写权限规则匹配不到任何
东西，子进程连自己的 scratch 目录都写不了，每次 `run_code` 都会 EPERM。修法是把路径
过一遍既有的 `sandbox::paths::safe_canonicalize`（`run_confined` 早就这么做，
`launcher` 这条路径没有），并加了一条回归用例钉死。

这个 bug 靠读代码是发现不了的——`cargo check`、`cargo test`、所有单元测试在修复前
全都是绿的。

**Linux 路径仍未验证**：本机没有 `bwrap`。合入前需要在装有 bubblewrap 的 Linux 上
重跑同一组断言。

**Phase 5 尚未开始**：AI SDK 与 External/ACP 回放、门禁提升。

### 实施中发现的既有问题（非本次引入，未修改）

1. `pnpm typecheck` 在当前工作区已有 **153 个既有错误**，主要来自另一会话未提交的
   HostState（ADR-0116）在途改动，例如 `lib/sync/host-state-service.ts`、
   `lib/sync/host-state-store.ts`、`packages/agent-config-types/src/host-state.ts`
   （BigInt 字面量 target 低于 ES2020）。默认 8 GB 堆会 OOM，需
   `--max-old-space-size=14336` 才能跑完。
2. `pnpm docs:build` 在类型检查阶段失败：`docs/` 工作区的 `lib/*.test.ts` 缺少
   jest 类型声明。这挡住了 ADR 的 MDX 预渲染门禁，两篇新 ADR 因此**尚未经过
   `docs:build` 验证**。

## 14. 未决问题（实施前需拍板）

1. `ResolvedAgentCompositionV1` 是否要投影进 `AgentExecutionSendSpec`（`agent-execution.ts:266`）
   传到 sidecar，还是只留在渲染端与事件里？前者让 sidecar 能 fail closed，代价是 wire 字段扩容。
2. Code 模式的 typed SDK 从哪里生成？现有 tool registry 是否已有足够稳定的 JSON schema
   可直接产出 `.d.ts`，还是需要先补一层工具目录元数据。
3. `verified-fresh-agent` 编排与现有 Agent Team 的 reviewer 能力如何划界，避免出现两套 reviewer。
4. Replay fixture 的合成语料由谁维护、放在哪个目录，以及 `refresh` 允许触碰的 golden 白名单范围。
5. ADR-0116（当前为未提交的在途工作）落地后，HostState 的 session 权威是否会影响
   "组合按会话保存" 的写入路径——需要在 Phase 0 收尾前与该工作对齐。
