---
title: ADR 0017 — 工作流插件扩展点
description: 让插件能向可视化工作流运行时贡献节点执行器和触发源的正典契约。
---

## 状态

已接受 —— 2026-05-09

## 背景

可视化工作流子系统（ADR 0011）出厂带 32 个内置节点执行器
和 5 种触发器类型。插件此前只能通过单一逃生口参与 ——
即 `action.plugin.invoke` 节点，它会分发进某个插件的
`workflow.task` 扩展点。这对一次性的
「调用我的插件」模式有效，但一旦插件想
贡献一个领域专属节点（例如带有自己参数 schema 和标签的
「从 JIRA 拉取」action）或一个自定义触发源（例如在 push 时
发出触发事件的 GitHub webhook 监听器），它就行不通了。

这个缺口在我们审计编辑器左栏节点面板时浮现出来：
`groupedCatalog()` 被硬编码到内置注册表，插件
无法呈现自己的节点类型，而且执行器注册表既没有
`unregister` 也没有 `subscribe` API —— 意味着即使我们
接好了一条回传通道，编辑器也无法对插件启用 /
禁用生命周期事件作出反应。

## 决策

在现有 `workflow.task` 之外引入两个新的正典扩展点：

```ts
export const CANONICAL_RUNTIME_POINTS = [
  "workflow.node", // 插件贡献的节点执行器
  "workflow.trigger", // 插件贡献的长跑触发源
  "workflow.task", // 既有 —— 预先形式化的 action.plugin.invoke 目标
] as const
```

它们与既有的 `ui-slot` / `hook` / `activation` 分类法并列，
作为第四种 `runtime` 类型。权限门：`extension:workflow`。ADR
审计（`auditPluginPointContracts`）会遍历全部三者。

### 类型契约

`types/plugin/plugin-workflow.ts` 声明运行时形状：

```ts
interface PluginNodeDef {
  kind: string // 无前缀；运行时补上 <pluginId>.
  typeVersion: number
  category: WorkflowNodeCategory | "plugin"
  label: string
  description: string
  iconName: string
  paramsSchema: Record<string, unknown>
  defaultParams?: Record<string, unknown>
  desktopOnly?: boolean
  retryable?: boolean
  timeoutMs?: number
  execute: (ctx: StepExecutionContext) => Promise<StepExecutionResult>
}

interface PluginTriggerDef {
  kind: string
  typeVersion: number
  label: string
  description: string
  iconName: string
  paramsSchema: Record<string, unknown>
  start(ctx: PluginTriggerStartContext): Promise<PluginTriggerHandle>
}
```

`PluginManifest` 新增一个可选的 `workflows` 块，镜像
运行时形状但去掉 `execute` / `start` 函数。把清单条目
接到实际函数上的桥接器，会在 activate 时从插件的
`main` 入口读取它们。

### 面向插件的 API

`PluginContext.workflow` 是插件使用的唯一入口：

```ts
interface PluginWorkflowAPI {
  registerNode(def: PluginNodeDef): () => void
  registerTrigger(def: PluginTriggerDef): () => void
  emitTriggerEvent(workflowId: string, kind: string, payload: unknown): void
}
```

每个 `register*` 返回一个取消订阅函数。运行时还会
在一张按 pluginId 索引的 map 上跟踪每一次注册，于是
管理器的强制禁用会调用
`teardownPluginWorkflowRegistrations(pluginId)` 一次性
清理掉所有东西。

### 类型前缀

插件作者提供无前缀的 kind（例如 `"action.fetchPage"`）。
运行时自动补上 `<pluginId>.` 前缀 —— 于是该 kind
在注册表 / 目录 / 已保存工作流中最终变为
`action.<pluginId>.fetchPage`。触发器 kind 保留开头的
`trigger.` 段（`trigger.<pluginId>.<rest>`），使编排器中
基于命名空间的模式匹配仍然有效。

### 注册表订阅

`lib/workflow/nodes/registry.ts`（以及对应的
`lib/workflow/triggers/registry.ts`）新增
`subscribeNodeRegistry(fn)` /
`subscribePluginTriggerRegistry(fn)`，返回一个取消订阅函数。
通知在 `queueMicrotask` 上分发，使在内置项预先注册之后
挂载的 React effect 仍能观察到这一填充。

### 目录热合并

`lib/workflow/nodes/catalog.ts` 新增一张并行的 `pluginCatalog`
map + `addPluginCatalogEntry` / `removePluginCatalogEntry` /
`subscribePluginCatalog` / `getPluginCatalogSnapshot`。`groupedCatalog()`
在底部发出一个虚拟的 `category: "plugin"` 分组；编辑器的
NodeSearchSidebar 用 `useSyncExternalStore` 对插件
增 / 删作出反应，无需手动重渲染。`searchCatalog()` 会把插件
条目纳入打分。

## 后果

### 正面

- 插件终于在可视化工作流编辑器里拥有了一级扩展表面 ——
  而不只是一个被动的 `workflow.task` 回调。
- 热重载端到端可用：在编辑器打开时启用一个插件，
  新节点无需刷新即出现在侧边栏。
- 既有的 `action.plugin.invoke` 路径保持有效 —— 新的
  `workflow.task` 运行时点是严格的形式化，而非
  破坏性的重定义。
- 边界干净：新类型位于
  `types/plugin/plugin-workflow.ts`，桥接在 `PluginContext` 中，
  目录合并在 `lib/workflow/nodes/` 中。对编排器或
  `WorkflowNodeKind` 没有横切改动。

### 负面

- `WorkflowNodeKind` 是内置项的封闭联合类型；插件 kind
  在注册时通过 `as never` 强转在运行时扩展它。
  长期看我们可能想把该类型放宽为 `string`，并依赖
  目录做已知形状校验。在 Phase 1 我们接受这次强转。
- 触发器 emit 路径（`emitTriggerEvent`）在 Phase 1 是一个桩；实际
  投递进编排器的触发队列要等到 Phase 2，届时
  `trigger-bridge.ts` 会获得一个 `dispatchPluginTrigger` 入口点。

### 中性

- 权限门 `extension:workflow` 是新的，但复用既有的
  权限机制。既有插件清单无需声明
  它，除非它们确实使用了 `PluginContext.workflow.*`。

## 迁移

既有插件或工作流无需迁移。选择
接入新表面的插件声明：

```jsonc
{
  "capabilities": ["workflow", "workflow-trigger"],
  "permissions": ["extension:workflow"],
  "workflows": {
    "nodes": [...],
    "triggers": [...]
  }
}
```

并从 `activate` 调用 `context.workflow.registerNode` /
`registerTrigger`。宿主会在 deactivate 时自动调用返回的取消订阅函数。

## 参考

- `lib/plugin/contracts/plugin-points.ts` —— `CANONICAL_RUNTIME_POINTS`
- `types/plugin/plugin-workflow.ts` —— 定义类型
- `lib/workflow/nodes/registry.ts` —— 订阅 / 注销
- `lib/workflow/triggers/registry.ts` —— 触发器生命周期
- `lib/workflow/nodes/catalog.ts` —— 插件目录热合并
- `lib/plugin/core/context.ts` —— `createWorkflowAPI`
- `components/workflow/editor/node-search-sidebar.tsx` ——
  `useSyncExternalStore` 集成
- ADR 0011 —— 可视化工作流子系统（基础）
- ADR 0006 / 0016 —— 插件系统架构
