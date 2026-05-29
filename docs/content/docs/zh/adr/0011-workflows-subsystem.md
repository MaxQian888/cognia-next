---
title: "0011 — 可视化工作流子系统"
description: "cognia-next 获得一层 n8n 风格的可视化编排能力，让用户把角色、团队、技能、数字孪生、连接器与 AI 原语接线成可执行图，并带有持久化的运行历史。"
---

# ADR 0011 — 可视化工作流子系统

**状态：** 已接受
**日期：** 2026-05-08
**分支：** `feat/workflows-phase1`

---

## 背景

cognia-next 拥有丰富的运行时实体——角色（Characters）、智能体团队（Agent Teams）、技能（Skills）、数字孪生（Twins）、连接器（Connectors）、MCP
服务器、插件（Plugins）——但用户没有一级方式把它们组合成多步自动化。
上一代仓库（`D:\Project\Cognia`）交付过一个成熟的 React Flow 编辑器，含
约 46 种节点类型，但**完全省略了角色 / 团队集成**——它的工作流是纯
自动化，对智能体运行时一无所知。这一缺口正是本次重写的驱动力。

目标：

- 一个仿 n8n 的**可视化图编辑器**：从左侧栏拖拽、用 handle 连线、通过右侧
  inspector 配置、Ctrl+S 保存、用 zundo 撤销 / 重做、用 elkjs 自动布局。
- 一个端到端运行该图的**执行引擎**，把每一步持久化到耐久事件日志，支持
  retry / timeout / 幂等，并在 webview 崩溃后从日志恢复。
- 接入既有基础设施的**触发器分类法**——手动、cron、连接器入站、
  聊天消息、webhook——而不分叉出一套并行的调度器。
- 一个用户可经既有导航 + 侧边栏搜索发现的**设置入口**。
- 一个镜像 数据 / 连接 区块的**5 标签页工作流区块**。
- 一个带甘特时间线 + 逐步 inspector + 从失败处重跑的**运行历史 UI**。
- 一种**混合运行时拆分**——Rust 触发守护进程 + 状态镜像，TS 编排器 + 节点
  执行器——使得 cron 触发器在 webview 最小化到托盘时仍能触发，运行在
  webview 崩溃后仍能存活，同时无需把每个节点实现都分叉进 Rust。
- **内置模板**，让首次使用的用户有一条可克隆的可用流水线。

非目标（明确）：

- 多用户协作 / CRDT——单用户桌面应用。
- 工作流市场。
- 带断点的可视化调试器。

---

## 决策

### 架构总览

```
┌──── Rust (src-tauri/src/workflow/) — always-on, survives webview reload ────┐
│  Cron daemon · Webhook receiver · Connector inbound tap · Run state mirror   │
│  Emits Tauri events: "workflow:trigger" / "workflow:resume"                  │
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │
                                       ▼
┌──── TS (lib/workflow/) — runs inside the webview ───────────────────────────┐
│  trigger-bridge → Orchestrator → RunActor → StepExecutor → NodeRegistry      │
│                                                          │                   │
│                                                          ▼                   │
│  Dexie tables (v22): workflows · workflowRuns · workflowRunEvents            │
│                       · workflowTriggers                                     │
│  UI: editor canvas (React Flow), library, runs (Gantt timeline), templates  │
└──────────────────────────────────────────────────────────────────────────────┘
```

拆分规则一句话即可概括：**Rust 负责「工作流何时开始」与「这次运行是否在崩溃中
存活下来」；TS 负责「给定一次运行，逐步完成工作」。** 跨越只在定义良好的
触发事件与快照持久化调用处发生。这与连接器（ADR 0009）和原生向量存储（ADR 0004）
所用的模式相同。

### 数据库 schema（v22）

在 `lib/db/schema.ts` v22 中新增四张 Dexie 表：

| 表                  | Key  | 用途                                                   |
| ------------------- | ---- | ------------------------------------------------------ |
| `workflows`         | `id` | 工作流定义（图 + 设置）                                |
| `workflowRuns`      | `id` | 每次执行一行，含冻结的工作流快照                       |
| `workflowRunEvents` | `id` | 耐久的逐步事件日志；由编辑器 / UI 响应式查询           |
| `workflowTriggers`  | `id` | 已注册的触发器（cron、webhook、inbound、chat-msg）     |

索引：`[workflowId+startedAt]` 用于运行时间线；`[runId+ts]` 用于按序事件回放；
`[workflowId+enabled]` 用于触发器面板查找。

### 类型模型

`types/workflow/visual.ts`——单一 barrel，导出：

- `WorkflowNodeKind`——带命名空间的 `<group>.<kind>` 联合类型（7 个类别共 38 种）。
- `VisualWorkflow`——顶层定义（改名以避免与 `./workflow.ts` 中既有的、面向 PPT 的
  `WorkflowDefinition` 冲突）。
- `WorkflowNode<TParams>`、`WorkflowEdge`、`WorkflowSettings`——图的原子；在
  `WorkflowNodeData` 上加索引签名，使 React Flow 的 `Node<TData extends Record<string, unknown>>`
  能接受它们。
- `RunStatus`、`TriggerEvent`、`WorkflowRunRow`、`WorkflowRunEventRow`、`WorkflowTriggerRow`。
- `StepExecutionContext` / `StepExecutionResult`——传给每个 NodeExecutor。
- IPC 契约类型：`PersistRunStateInput`、`InFlightRunRow`、`RegisterTriggerInput`。

### 编辑器

- `@xyflow/react` v12——选它是因为兼容 React 19 + Tailwind v4 + shadcn，并且 v12
  新增了服务端 hydration 支持（`output: "export"` 不会产生运行时错误）。
- `zundo`——Zustand 上的时间中间件，用于撤销 / 重做（历史上限 100 步）。
- `elkjs`——经 `layered` 算法懒加载的自动布局。
- 自定义节点渲染器（`components/workflow/editor/nodes/workflow-node.tsx`）以
  类别配色的 shadcn 风格卡片覆盖全部 38 种。
- `node-search-sidebar.tsx`——可折叠类别分组的拖入画布；使用 HTML5 DnD
  API 与自定义 MIME（`application/x-workflow-kind`）。
- `inspector-panel.tsx`——右侧栏 Sheet，逐种类的配置表单取自
  `inspector/node-config-registry.tsx`。

### 执行引擎

- `lib/workflow/runtime/orchestrator.ts`——入口。校验 → 拓扑排序 → 逐步走完
  队列 → 路由分支 → 持久化每个事件。
- `lib/workflow/runtime/topo-sort.ts`——Kahn 算法，并在
  `flow.loop` / `flow.wait` 处做反向边检测（它们是显式的环入口；通用环仍会抛错）。
- `lib/workflow/runtime/step-executor.ts`——处理 retry（指数 / 固定退避）、timeout
  （经 `AbortController`）、幂等（经 `IdempotencyCache`），以及表达式求解
  （`resolveDeep` 在执行器看到参数之前替换 `{{ $node['id'].out.field }}` 引用）。
- `lib/workflow/runtime/event-log.ts`——仅追加写入器，带批量 `bulkPut` 与一个
  一次性捕获 `runId` 的作用域化 `RunLogger`。
- `lib/workflow/runtime/idempotency.ts`——Inngest 风格的 memoization。崩溃 + 重载后，
  从耐久的 Dexie 事件日志 hydrate，使恢复的运行不会重放任何内容。
- `lib/workflow/runtime/expression.ts`——安全的表达式求解器（**非** `eval()`）；接受
  `$node['id'] · $trigger · $static · $params`，以及 `.field` / `['key']` / `[index]` 访问符。

### 节点执行器注册表

`lib/workflow/nodes/registry.ts` 把 `(kind, typeVersion)` 映射到 execute 函数。注册
作为 import `lib/workflow/nodes/built-ins.ts` 的副作用发生。插件可通过同一个
`registerNodeExecutor` API 注册新执行器；缺失的注册会以
"no executor registered" 运行失败的形式暴露（可恢复）。

Phase 1 交付 23 个真实（非桩）执行器：

| 种类                      | 行为                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `trigger.manual`          | 回显触发器载荷                                                                              |
| `flow.set`                | 把一个值存为运行作用域变量                                                                  |
| `flow.branch`             | 基于真值的双路分裂，带跳过传播                                                              |
| `flow.switch`             | 基于 `subject` 对 `cases[]` 映射的多路分支                                                  |
| `flow.split`              | 纯透传；编排器经下游边扇出                                                                  |
| `flow.join`               | 把上游冻结为 `{joinPolicy, gathered, upstreamCount}`                                        |
| `flow.loop`               | `forEach` / `times` 迭代；子图循环体后续落地                                                |
| `flow.wait`               | 带可取消 `AbortSignal` 的 `setTimeout`                                                      |
| `flow.subworkflow`        | 递归 `runWorkflow` 调用；子工作流失败时不可重试                                             |
| `data.transform`          | 经 `$item` 表达式对数组做 map/filter/sort/flatten/reduce                                    |
| `data.template`           | Mustache 风格 `{{ }}` 渲染（已由 step-executor 展开）                                       |
| `data.code`               | 沙箱化 `Function()`，5 秒超时，支持 async                                                   |
| `io.http`                 | 真实 `fetch`，带 content-type 嗅探；5xx 可重试 / 4xx 不可                                   |
| `io.webhook.respond`      | 暂存一个响应；投递推迟到 Phase 5b webhook 路由                                              |
| `action.character.create` | `createCharacter` Dexie 写入                                                                |
| `action.character.update` | `updateCharacter` Dexie patch（剥离不可变字段）                                             |
| `action.team.create`      | 带成员校验的 `createTeam`                                                                   |
| `action.team.update`      | `updateTeam` Dexie patch                                                                    |
| `action.skill.invoke`     | 从 Dexie 读取真实技能，返回拼接的 markdown                                                  |
| `action.skill.upsert`     | 按 `skillId` 是否存在决定创建或更新；幂等                                                   |
| `action.connector.send`   | 带幂等地 `enqueueOutbound` 到既有 FIFO 队列                                                 |
| `action.connector.draft`  | 为 Inbox UI 中的人工审批 `createDraft`                                                      |
| `ai.prompt`               | 提供 provider+key 时经 `createLlmClient` 真实调用 LLM；否则回退到桩                         |
| `ai.classify`             | 包装 `ai.prompt`，输出受约束的标签                                                          |
| `ai.extract`              | 包装 `ai.prompt`，做结构化 JSON 抽取 + 解析错误暴露                                         |
| `ai.embed`                | 经 `generateTextEmbedding` 生成确定性的基于 hash 的向量（Phase 9 接入真实 embedding）       |

其余种类（`action.character.send`、`action.team.run`、`action.twin.rag`、
`action.twin.ingest`、`action.mcp.invokeTool`、`action.plugin.invoke`）需要与各自子系统
（聊天发送流水线、agent-team manager、twin 运行时、MCP
客户端、插件任务处理器注册表）做更深集成，将在这些桥接落地的后续阶段中交付。

### 触发器桥接

| 触发器                      | 背后实现                                                    | Phase 1？            |
| --------------------------- | ----------------------------------------------------------- | -------------------- |
| `trigger.manual`            | 编辑器的运行按钮                                            | 是                   |
| `trigger.cron`              | TS 中既有的调度器；最小化时由 Rust 守护进程触发            | TS 是；Rust 待办     |
| `trigger.connector.inbound` | `ConnectorBus.dispatchInbound` 生命周期 hook               | 待办                 |
| `trigger.chat.message`      | `lib/claude/build-options.ts:resolveSendOptions` hook       | 待办                 |
| `trigger.webhook`           | 仅 Tauri 的 HTTP 服务器（挂载于 External Bridge 的 axum）  | 待办                 |

### Tauri IPC 契约

定义于 `lib/workflow/runtime/tauri-bridge.ts`。Phase 1 交付**桩**——TS 侧为每个命令调用
`invoke()`，但 `src-tauri/src/workflow/commands.rs` 中对应的 Rust 处理器在
Phase 5a 落地。在 web 模式下，桥接会优雅地 no-op，使编排器仍可端到端运行。

| 方向      | 名称                             | 用途                                               |
| --------- | -------------------------------- | -------------------------------------------------- |
| TS → Rust | `workflow_register_trigger`      | 新增 / 更新一行触发器；守护进程重载调度            |
| TS → Rust | `workflow_unregister_trigger`    | 从 cron 守护进程 + webhook 路由中移除              |
| TS → Rust | `workflow_persist_run_state`     | 在每个步骤转换时更新 SQLite 镜像                   |
| TS → Rust | `workflow_reload_in_flight_runs` | 启动时回放进行中的运行                             |
| TS → Rust | `workflow_ack_completed`         | 成功后清除镜像行                                   |
| Rust → TS | event `workflow:trigger`         | cron / webhook / inbound 扇出                      |
| Rust → TS | event `workflow:resume`          | 从镜像回放一次进行中的运行                         |

### 设置与路由

- **数据**组下的侧边栏入口：`设置 → 工作流`（图标：`WorkflowIcon`，搜索
  关键词覆盖 EN + zh-CN）。
- `?section=workflows&wfTab=…` 处的 5 标签页区块：
  - **库（Library）**——内嵌与 `/workflows` 处相同的 `<WorkflowLibrary />`。
  - **运行（Runs）**——全局最近运行，带状态过滤 chips。
  - **模板（Templates）**——内置模板画廊（Phase 9 交付 4 个）。
  - **默认值（Defaults）**——继承的 error/retry/secret 默认值的只读摘要。
  - **审计（Audit）**——工作流审计事件（扩展既有的 `mcpAuditLog` 存储）。
- 顶层路由：
  - `/workflows`——库着陆页。
  - `/workflows/[id]`——全屏画布编辑器。
  - `/workflows/[id]/runs`——运行历史列表。
  - `/workflows/[id]/runs/[runId]`——甘特时间线 + 步骤 inspector。

### 内置模板

Phase 1 交付四个模板（`lib/workflow/definition/seed.ts`）——全部由已交付的执行器组成，
因此开箱即可运行：

1. **Hello world**——`trigger.manual` → `ai.prompt` → `flow.set`。
2. **HTTP → transform → summarize**——拉取 JSON、摘取一个字段、做摘要。
3. **Classify then branch**——AI 分类扇入双路分支。
4. **Skills + AI**——把技能打包进下游 AI 步骤的 prompt。

### Web 模式降级

当 `!isTauri()` 时：

- cron 触发器仅在 webview 存活时触发（无 Rust 守护进程）。
- webhook 触发器在触发器面板显示「仅桌面端」提示。
- `chat.message` + `manual` + `connector.inbound` 触发器（这些已在 TS 侧）
  照常工作。
- 库、编辑器、运行历史与模板 UI 全部完整可用。

---

## 测试覆盖

Phase 1 交付**14 个套件共 150 个测试**，全部绿：

| 套件                                               | 覆盖                                                   |
| -------------------------------------------------- | ------------------------------------------------------ |
| `types/workflow/visual.test.ts`                    | 目录完整性、默认值                                     |
| `lib/db/workflows.test.ts`                         | CRUD、duplicate、seed-built-ins、regenerateNodeIds     |
| `lib/workflow/definition/validate.test.ts`         | zod 信封、完整性（环、重复 id）                        |
| `lib/workflow/definition/seed.test.ts`             | 每个模板都校验通过；重复 seed 幂等                     |
| `lib/workflow/runtime/expression.test.ts`          | tokenize / evalToken / resolveExpression / resolveDeep |
| `lib/workflow/runtime/topo-sort.test.ts`           | 线性 / 不连通 / 反向边检测                             |
| `lib/workflow/runtime/orchestrator.test.ts`        | 4 节点 E2E、分支路由、失败模式、resume                 |
| `lib/workflow/nodes/catalog.test.ts`               | 目录 + 搜索的 10 个用例                                |
| `lib/workflow/nodes/built-ins.test.ts`             | 32 个执行器用例，含 ai.prompt 桩回退                   |
| `lib/workflow/editor/store.test.ts`                | Zustand+zundo CRUD                                     |
| `lib/workflow/editor/react-flow-converter.test.ts` | 含 handle/label 边界情形的往返                         |
| `components/workflow/editor/canvas.test.tsx`       | toolbar + 空状态 + dirty 徽章                          |
| `components/workflow/runs/format.test.ts`          | 时长格式化边界情形                                     |
| `components/workflow/runs/run-timeline.test.ts`    | span 构建器，含 retry 折叠 + 仅跳过                    |

---

## 新增文件（Phase 1）

```
types/workflow/visual.ts                                   types
types/workflow/visual.test.ts
lib/db/workflows.ts                                        CRUD
lib/db/workflows.test.ts
lib/db/schema.ts                                           v22 block (modified)
lib/db/seed.ts                                             hooks seedBuiltInWorkflowTemplates
lib/workflow/definition/validate.ts                        zod + integrity
lib/workflow/definition/validate.test.ts
lib/workflow/definition/seed.ts                            4 built-in templates
lib/workflow/definition/seed.test.ts
lib/workflow/runtime/expression.ts                         expression resolver
lib/workflow/runtime/expression.test.ts
lib/workflow/runtime/event-log.ts                          durable event writer
lib/workflow/runtime/idempotency.ts                        memoization cache
lib/workflow/runtime/secret-resolver.ts                    NoopSecretResolver + in-memory
lib/workflow/runtime/tauri-bridge.ts                       IPC stubs (web no-op)
lib/workflow/runtime/topo-sort.ts                          Kahn's + back-edge
lib/workflow/runtime/topo-sort.test.ts
lib/workflow/runtime/step-executor.ts                      retry / timeout / idempotency
lib/workflow/runtime/orchestrator.ts                       top-level entry
lib/workflow/runtime/orchestrator.test.ts
lib/workflow/nodes/catalog.ts                              metadata for sidebar / palette
lib/workflow/nodes/catalog.test.ts
lib/workflow/nodes/registry.ts                             executor registry
lib/workflow/nodes/built-ins.ts                            14 real + stub executors
lib/workflow/nodes/built-ins.test.ts
lib/workflow/editor/store.ts                               Zustand + zundo
lib/workflow/editor/store.test.ts
lib/workflow/editor/react-flow-converter.ts                round-trip
lib/workflow/editor/react-flow-converter.test.ts
lib/workflow/editor/auto-layout.ts                         elkjs lazy-loader

components/workflow/editor/canvas.tsx                      React Flow shell
components/workflow/editor/canvas.test.tsx
components/workflow/editor/toolbar.tsx
components/workflow/editor/empty-state.tsx
components/workflow/editor/node-search-sidebar.tsx
components/workflow/editor/inspector-panel.tsx
components/workflow/editor/inspector/node-config-registry.tsx
components/workflow/editor/inspector/forms/index.tsx       18 per-kind config forms
components/workflow/editor/inspector/forms/shared.tsx
components/workflow/editor/nodes/workflow-node.tsx         single-renderer for all 38 kinds
components/workflow/library/workflow-library.tsx
components/workflow/library/workflow-card.tsx
components/workflow/library/workflow-create-dialog.tsx
components/workflow/runs/run-list.tsx
components/workflow/runs/run-detail.tsx
components/workflow/runs/run-timeline.tsx
components/workflow/runs/run-timeline.test.ts
components/workflow/runs/run-step-detail.tsx
components/workflow/runs/run-status-pill.tsx
components/workflow/runs/format.ts
components/workflow/runs/format.test.ts
components/settings/workflows/workflows-section.tsx        5-tab Settings shell
components/settings/workflows/tabs/library-tab.tsx
components/settings/workflows/tabs/runs-tab.tsx
components/settings/workflows/tabs/templates-tab.tsx
components/settings/workflows/tabs/defaults-tab.tsx
components/settings/workflows/tabs/audit-tab.tsx

app/workflows/page.tsx
app/workflows/[id]/page.tsx
app/workflows/[id]/runs/page.tsx
app/workflows/[id]/runs/[runId]/page.tsx
```

修改：

```
components/settings/settings-nav-config.ts                 + workflows entry
components/settings/settings-shell.tsx                     + dynamic import + case
i18n/messages/en.json                                      + workflows tab labels
i18n/messages/zh-CN.json                                   + workflows tab labels
package.json                                               + 5 deps
```

---

## 后续阶段交付内容

- **Phase 5a**——Rust 触发守护进程（`src-tauri/src/workflow/`）：cron 守护进程（tokio-cron）、
  挂载于 External Bridge axum 的 webhook 接收器、SQLite 中的运行状态镜像。
- **Phase 5b**——接到聊天发送流水线 + ConnectorBus 入站 tap 的 TS 触发器桥接
  （`trigger-bridge.ts`、`resume-controller.ts`）。
- **Phase 6 余下部分**——约 15 个更多的节点执行器，集成聊天流水线、agent-team
  manager、twin 运行时、MCP 客户端，以及连接器出站 runner。
- **Phase 9 打磨**——边 / 节点上的 framer-motion 缓动、每个节点上展示
  上次运行状态的运行状态 pill、OKLCH 感知的 MiniMap、更多键盘快捷键。
- **Phase 10 余下部分**——完整的覆盖率闸门（`pnpm test:coverage`、`cargo test`、
  `pnpm tauri build`）。

---

## 来源

- [@xyflow/react v12 release notes](https://xyflow.com/blog/react-flow-12-release)
- [n8n node typeVersion](https://docs.n8n.io/integrations/creating-nodes/build/reference/node-versioning/)
- [Inngest step.run memoization](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [Temporal — durable execution](https://temporal.io/blog/temporal-replaces-state-machines-for-distributed-applications)
- [zundo — Zustand temporal middleware](https://github.com/charkour/zundo)
- ADR 0009（平台连接器）——Rust↔TS 混合拆分的模式参考。
- ADR 0008（External Bridge）——共享 Tauri axum 实例的模式参考。
- ADR 0004（原生向量存储）——SQLite 镜像持久化的模式参考。
