---
title: 0034 — 工作流编辑器完整性 & 插件对等性
description: 节点配置补全、工作流级设置、运行可观测性、错误分支路由，以及面向 Visual Workflows 的 ADR-0032 级插件可扩展性。
---

## 状态

已接受（2026-05-23）。2026-08-12 已对照工作流编辑器中实际挂载的侧栏、inspector registry、工作流 runtime 与插件 capability registry 再次确认实现。

## 背景

Visual Workflows 子系统（ADR-0011/0017/0022）已拥有成熟的画布 + 混合运行时，但四个缺口阻碍了"功能完整"：

1. **节点配置覆盖率** — 67 种节点类型，仅 41 种接入 inspector registry。11 个 `action.desktop.*` 表单已存在但从未被导入（桌面节点回退到原始 JSON）；`trigger.team`、`action.team.task.dispatch`、`trigger.desktop.event` 没有表单。`params-schemas.ts` 中一个真实 bug 导致 `action.team.task.dispatch` 的校验被禁用（引用了 `requiredString` 但未调用）。
2. **无工作流级设置 UI** — `WorkflowSettings`、variables、credential refs 没有编辑器。
3. **插件联动仅限节点/触发器**（ADR-0017）— 无 template overlay、无 `requires` 校验、无设置界面，且内置的 `action.skill.invoke` / `action.mcp.invokeTool` executor 忽略了插件 overlay registry。
4. **编辑器中无运行可观测性** — `components/workflow/runs/` 下已有一套完整的运行历史 UI，但与路由耦合，从画布无法到达。

## 决策

- **节点配置补全。** 接入 11 个桌面表单；为 3 个未接入的类型添加表单；修复 `requiredString()` bug；增加支持表达式的 URL 校验；添加 `trigger.team` 透传 executor。引入可复用的 `EntityPicker`（可搜索，基于 `components/ui/combobox`）、`CronBuilder`（复用 `lib/scheduler/cron-parser`）、`DurationField`；在 inspector 中暴露"跳转到下一个错误"。
- **Settings 标签页。** 新增右侧栏 **Settings** 标签页，编辑 `WorkflowSettings`（错误策略、超时、并发、重试、时区）、作者级 `variables` 映射（以 `{{ $vars.KEY }}` 引用）以及 credential refs — 全部通过编辑器 store 的信封变更器，由既有的保存路径持久化。`variables` 是附加的可选字段（无需 schema version 升级）。
- **Runs 标签页。** 新增右侧栏 **Runs** 标签页，复用既有的 `RunTimeline` / `RunStepDetail` / `RunStatusPill` / 格式化器（路由解耦，非重建），选中步骤可在画布上高亮定位。
- **错误分支路由。** `errorPolicy: "branch"` 完整实现：节点暴露第二个 `error` 源 handle，边携带 `kind: "error"`，编排器将失败节点沿其 error 边路由（保持运行继续），复用既有的 decision/`propagateSkip` 引擎。`"continue"` 也已实现（跳过下游，完成运行）。
- **插件对等性（ADR-0032 镜像）。** 新增 `workflow-template` overlay capability：`PluginWorkflowTemplateDef` + `workflow-template-registry` + `validateWorkflowTemplateRequires`（非阻塞警告）+ `projectPluginWorkflowTemplate` + `defineWorkflowTemplate` SDK helper，接入 `OVERLAY_REGISTRY_CAPABILITIES` 和 `PLUGIN_CAPABILITY_CONTRACTS`（`support: "supported"`）。四个新生命周期钩子（`onWorkflowNodeStart/Complete/Error`、`onWorkflowTriggerFired`）从编排器 + 触发桥 dispatch。`action.skill.invoke` 和 `action.mcp.invokeTool` 在 Dexie 表未命中时回退到 skill / mcp-server-preset overlay registry。模板在 Settings 标签页的"Plugins & capabilities"区域展示，带"Use"操作。

## 后果

- 每种节点类型现在都有结构化 inspector 表单；桌面节点不再回退到原始 JSON。
- `errorPolicy` 端到端完全生效；Settings 标签页不再暴露无效选项。
- 插件对工作流达到 ADR-0032 成熟度：完整蓝图、依赖警告、更丰富的钩子，以及节点级消费插件 skill/MCP。
- `{{ $vars.X }}` 在运行时解析（编排器将 `workflow.variables` 织入表达式作用域），并在表达式编辑器中自动补全。
- 无需 Dexie 迁移：`variables` 作为可选属性挂载在既有 `workflows` 行上。
