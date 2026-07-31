---
title: ADR-0032 — 智能体团队插件集成
---

# ADR-0032 — 智能体团队插件集成

> 状态：**已通过** · 2026-05-23

## 背景

Agent Team 子系统（ADR-0022）以独立编排引擎的形式上线：数据模型、Zustand
store、F-path workflow synthesizer、`BudgetGuard`、`TeammatePool`、
`TeamNotifier`，以及完整的 workspace UI。

与此同时，插件系统沉淀出 `OVERLAY_REGISTRY_CAPABILITIES` 调度回路（PR-D），
统一了五类形状一致的能力 — `skills`、`mcpServerPresets`、
`nativeAnthropicTools`、`externalAgentPresets`、ADR-0030 `characterPacks` —
每个都通过 `createOverlayRegistry` 注册到 overlay 中。

但两边从未打通。Agent team 无法消费任何插件能力：`AgentTeamConfig` 没有
`capabilities` 字段，队员无法引入插件技能，团队可用的 subagent 只有
`lib/claude/agents/subagents` 里硬编码的 4 个 workflow-\*。插件也没有
"贡献完整团队蓝图"的 manifest 字段。

本 ADR 记录 2026 年 5 月这次工作的集成方案。

## 决策

通过 7 个协同机制，把 Agent Team 提升为**插件生态一等公民**：

### 1. 两层能力作用域

- `AgentTeamConfig.capabilities: TeamCapabilityBundle` — 团队级默认池，所有
  队员继承。
- `TeammateConfig.capabilities: TeammateCapabilityOverlay` — 每个队员的
  override，按 key 提供 `add` / `remove` / `replace` 三态语义。
- `lib/ai/agent/team/capability-resolver.ts:resolveTeammateCapabilities`
  作为唯一的纯函数把两者合并成 `ResolvedCapabilities` 给运行时消费。

### 2. Subagent 插件能力（overlay-registry 第 6 项）

插件通过 `manifest.subagents: PluginSubagentDef[]` 声明（与 Claude SDK
`AgentDefinition` 形状一致）。通过 `subagent-registry` 注册（一行
`createOverlayRegistry`）。built-in workflow-\* 与 overlay 并存，运行时投影由
`lib/claude/agents/subagents/index.ts:resolveAllSubagents` 完成。插件 subagent
id 命名空间化为 `<pluginId>:<id>`，确保不会与 dispatcher 名称冲突。

### 3. Agent-Team-Template 插件能力（overlay-registry 第 7 项）

插件通过 `manifest.agentTeamTemplates: PluginAgentTeamTemplateDef[]` 贡献
完整团队蓝图。每条可声明 `requires` 块（跨能力依赖）；注册时验证并印戳
非阻塞 warning，sibling registry 变动时刷新（沿用 ADR-0030 character-pack
模式）。设置 UI 把 warning 渲染为禁用的 "Use" 按钮和缺失依赖徽章。

### 4. 全谱 hook 集成

`runTeamLifecycle` 在 7 个关键点 dispatch 插件 hook（`onTeamStart` /
`onTeamPlanReady` / `onTeamBudgetWarn` / `onTeamComplete`），
`action.team.task.dispatch` executor 在 claim / release 时 dispatch
`onTeammateClaim` / `onTeammateRelease` 以及现有的 `onAgentStart` /
`onAgentComplete` / `onAgentError`。

`BudgetGuard` 已有的 `on("warning_crossed")` / `on("critical_crossed")`
事件 emitter 直接接入 `onTeamBudgetWarn`，没有新增 emitter 基础设施。

### 5. Consensus / SharedMemory / Delegation 编排器

store 已经有 `upsertConsensus` / `writeSharedMemory` / `upsertDelegation` /
`updateDelegationStatus` 等 CRUD。本次集成新增三个**薄**编排器模块：

- `consensus-orchestrator.ts` — `createConsensus` / `castVote`（达到阈值
  自动解决）/ `resolveConsensus`（lead 强制）/ `cancelConsensus`，纯函数
  `tallyVotes` / `computeWinner` 承担算术。
- `shared-memory-orchestrator.ts` — `publishEntry`（通过
  `packages/redact/src/index.ts:hasNoLeakingPii` 把 PII 写入挡在门外）/
  `deleteEntry` / `autoPublishTaskResult` / `clearTeamMemory`。
- `delegation-orchestrator.ts` — `delegateToBackground`（驱动
  `background-agent-manager` + `executeAgent`）/ `delegateToExternal` /
  `completeExternalDelegation` / `cancelDelegation`。

每个编排器都 dispatch 对应的插件 hook（`onConsensus*` / `onSharedMemory*` /
`onTeamDelegation*`）。

### 6. PresetEditor 复用做 TeammateConfigDialog

`<PresetEditor>`（`components/settings/presets/preset-editor.tsx`）本已支持
身份 / 能力 / 工具 / 高级 四节，外加 skill 与 mcp catalog 注入。集成做了：

- 加两个可选 props — `extraSections` 与 `requireContent` — 允许调用方
  追加自定义节、跳过 system prompt 必填校验。
- `PresetEditorState` 加 4 个可选字段（`nativeAnthropicToolIds`、
  `characterPackId`、`externalAgentPresetId`、`subagentIds`）。
- 新增 5 个 editor section（NativeTools / Subagent / Character /
  ExternalPreset / TeamCapabilityOverlay）。
- `<TeammateConfigDialog>` 包装 `<PresetEditor>` + 新 section + 一个
  roster section（runtime / specialization / temperature）。

不重复造编辑器：`<PresetEditor>` 作为预设、custom mode（未来）、
teammate 三个领域的唯一编辑器源头。

### 7. Workspace settings 重构

`workspace/settings.tsx` 从平铺卡片切换为 4 个 accordion：**Overview**
（保留原有 3 张卡片）、**Plugins & capabilities**（新）、**Governance**
（TeamGovernancePolicy 编辑器）、**Memory**（SharedMemory KV 视图）。
`activity.tsx` 加入 ReportTimeline + ConsensusPanel。

## 持久化迁移

`stores/agent/agent-team-store/store.ts` 把 `PERSIST_VERSION` 从 1 升到 2。
迁移函数作为纯函数 `migrateAgentTeamPersisted` 导出，对持久化 `defaultConfig`
与每个 template 的 `config` 回填 `governancePolicy` + `capabilities` 默认值。
对 v2 输入幂等。

## 新增的 `CANONICAL_HOOK_POINTS`

`onTeamStart` · `onTeamPlanReady` · `onTeammateClaim` · `onTeammateRelease` ·
`onTeamBudgetWarn` · `onTeamComplete` · `onConsensusOpened` ·
`onConsensusVoted` · `onConsensusResolved` · `onSharedMemoryWrite` ·
`onSharedMemoryDelete` · `onTeamDelegationStart` · `onTeamDelegationComplete`

每个都带类型化 payload（见 `types/plugin/plugin.ts`）。

## 影响

- 插件现在以与扩展 character / skill / mcp / native-tool 完全相同的方式扩展
  Agent Team。
- 新增第 8 项能力 = 在
  `lib/plugin/contracts/capability-bridge-map.ts:OVERLAY_REGISTRY_CAPABILITIES`
  中加一行。
- TeammateConfig 编辑统一到 preset editor，未来 preset 的改进会自动惠及
  teammate 编辑。
- 缺失依赖的插件团队模板保持可见但不可用 — 操作员得到可发现性提示，而非
  静默失败。

## 复用审计（沿用既有资产）

- `createOverlayRegistry` factory — 4 个既有 registry + 2 个新增（subagent
  - agent-team-template），每个都是一行实例化。
- Consensus / shared memory / delegation / execution report 的 store CRUD
  action 已存在，编排器只是薄业务逻辑包装。
- `BudgetGuard.on(...)` emitter API 未改 — hook dispatch 以 listener 形式
  追加。
- 复用 `<PresetEditor>`，不重新造 `AgentSubjectEditor`。
- 沿用 `packages/redact/src/index.ts:hasNoLeakingPii` 作 SharedMemory PII 红线
  （ADR-0003 红线）。

## 参考

- ADR-0022 — Agent Team 运行时硬化
- ADR-0030 — Character pack overlay 能力（`requires` warning 模式同源）
- ADR-0020 — Computer Use 完整性（native-anthropic-tool 能力）
- ADR-0017 — Workflow 插件扩展点（workflow 能力形状）
