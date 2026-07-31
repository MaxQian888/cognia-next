---
title: ADR-0081 — 工作流可调用单元收敛与链式触发
description: 所有已发布工作流统一由一个共享类型化 runner 执行（消灭幽灵工具），工作流技能保证 runner 在会话内可用，trigger.workflow.completed 以深度与自触发防护实现解耦的工作流链。
---

# ADR-0081 — 工作流可调用单元收敛与链式触发

**状态**：已接受（2026-07-17）

## 背景

发布一个工作流（ADR-0011，`lib/workflow/CONTEXT.md` 的 D5）会登记三个调用面：类型化
agent 工具、类型化 `flow.subworkflow` 目标、以及 `kind:"workflow"` 的技能目录条目。
其中两个调用面与实际实现发生了漂移：

1. 生成的技能正文指示模型调用每工作流的 `wf_<slug>` 工具，但**全库没有任何代码注册它**——
   真正的 runner 是通用的 `wf_run_workflow_typed`（按 name 参数分发）。启用工作流技能的
   模型被指向一个幽灵工具。
2. 启用 `kind:"workflow"` 技能既不特判渲染，也不保证 runner 工具在会话中——图能否被调用
   完全取决于 `cognia-workflow-ai` 插件恰好处于启用状态。
3. 没有原生的「工作流 A 完成 → 启动工作流 B」联动。唯一的组合方式是 `flow.subworkflow`
   （父运行内嵌子运行）和一条狭窄的调度器事件任务路径。

## 决策

1. **一个共享类型化 runner，不注册每工作流工具。** `wf_run_workflow_typed`
   （名称与定义的唯一来源是 `lib/workflow/publish/runner-tool.ts`，插件注册与所有其他
   表面共享它）是已发布工作流的调用面。`published.toolName`（`wf_<slug>`）仅作展示。
   执行核心位于 `lib/workflow/publish/run-workflow-typed-tool.ts`；插件注册只是薄包装。
2. **图体技能自愈并保证 runner 可用。** `renderSkillsSection` / `renderSkillsCatalog`
   特判 `kind:"workflow"`：正文/目录行在渲染时由工作流名重新推导（修复前存量行里指向
   `wf_<slug>` 的旧正文无需迁移即自愈），并以精确的 `{ "name": … }` 调用形态指向共享
   runner。`lib/claude/build-options.ts` 的技能→工具投射在工作流技能激活且插件未提供时
   自动补齐 runner 清单项（在语义裁剪之后追加，不会被裁掉）；插件解析未命中时,
   `lib/claude/plugin-tool-ipc.ts` 直接执行共享核心。
3. **`trigger.workflow.completed` 链接解耦的工作流。** 编排器在每个真实终态
   （succeeded/failed——含校验、preflight、排序失败）经
   `lib/workflow/runtime/workflow-completion-fanout.ts` 火并遗忘地发布完成事件。匹配的
   订阅（可按来源 `workflowId` 与结果 `status` 过滤）经由规范触发桥分发，载荷为
   `{ workflowId, workflowName, runId, status, output?, error?, chainDepth }`。
4. **防环/防风暴。** 链深上限 `MAX_WORKFLOW_CHAIN_DEPTH`（10），通过触发载荷
   （`chainDepth`）继承；工作流永远不会触发自身（即使订阅未加过滤）。catch 子运行
   （`suppressCatch`）与编辑器局部运行（`startStepId` / `restrictToStepIds`）不发布。
5. **事件等待成真。** `flow.wait` 的 event 模式在进程内 wake 总线（`subscribeWake`）上
   阻塞，键为用户声明的 `eventKey`（缺省为运行级 `runId:stepId`），可选超时；
   `wf_emit_workflow_event` 是 agent 可达的唤醒源。订阅前到达的事件被丢弃，不排队。

## 影响

- 模型启用任何已发布工作流技能都能实际执行图——指令、清单与执行兜底对同一个工具名达成一致。
- 「A 完成 → 跑 B」通过在 B 中放置 `trigger.workflow.completed` 节点表达，B 不再内嵌于
  A 的运行、预算或错误策略。
- 校验现在拒绝所有环（配套的 topo-sort 变更）：旧的「授权回边」容忍度让永不迭代的图通过
  校验。迭代唯一由 `flow.loop` v2 容器表达。
- 链式载荷携带来源运行的完整输出；消费方经 `$trigger.payload.output`（或触发节点自身的
  透传输出）读取。

## 参考

- `docs/plans/2026-07-16-workflow-linkage-remediation.md` —— 驱动本决策的审计。
- ADR-0011（工作流子系统）、ADR-0022（并发）、ADR-0034（错误分支）。
