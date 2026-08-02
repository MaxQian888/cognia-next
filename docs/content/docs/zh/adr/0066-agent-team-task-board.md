---
title: "ADR-0066 — Agent 团队任务看板与跨界面集成（CQRS）"
description: "赋予Agent-Team任务模型看板接口并在应用中拆除孤岛化：工作区内的保护拖板、通过伴随同步流水线将板子传输到移动端的单向Dexie投影（v104）、手机端编辑的控制平面RPCs、带team:read/team:write的ctx.team插件API、双绑定可视化以及共享完成链接核心。"
---

# ADR-0066 — Agent 团队任务看板与跨界面集成（CQRS）

**状态**：已接受（2026-07-08）**作者**：Max Qian + Claude Fable 5 **基于**团队运行时（ADR-0022）、插件集成（ADR-0032）、移动同步编排器（ADR-0027）、配套远程控制接口（ADR-0005 / ADR-0060）以及双子 运行时 胶水（`lib/ai/agent/team/twin-context.ts`、ADR-0003）。

## 背景

`AgentTeamTask`始终是板状——8个状态（`pending → blocked → claimed → in_progress → review → completed | failed | cancelled`）、`assignedTo`/`claimedBy`、`dependencies`、显式`order`、注释和附件——但唯一的接口是平面卡片网格，模型是孤岛的：插件无法看到团队存储（没有`ctx.team`，与成熟的`ctx.goals`形成对比），三个工作区扩展点为唯读，移动工作区读取**手机自身**空localStorage存储， 所以桌面编写的团队在配对的手机上是隐形的。ADR-0022还推迟了手动重试和pause/resume重试（“v2”），并宣布“不新增Dexie表”进行团队运行。

## 决策

### 1. 每接口一名警卫

`lib/ai/agent/team/task-move-guard.ts:canMoveTask(task, from, to, teamStatus)` 是人类拥有的过渡的唯一唯一事实来源，包含桌面拖板、移动操作表、配套RPCs和插件API：

- 同列重序：始终允许（`order`通过`reorderColumn`重新编号）;
- `pending → cancelled`，`review → completed | failed`（人工裁决），`failed → pending`（**手动重试**——关闭ADR-0022推迟）;
- `blocked` 是依赖导出的，双向只读;
- `claimed` / `in_progress`在运行期间由运行时拥有（`planning`/`executing`）;静止时可能会被推回 `pending`。

商店操作`moveTask` / `reorderTask`会施加防护和副作用（申领释放+`→ pending`时间重置，终端完成印章）。在棋盘上，非法掉落目标在拖拽开始时会变成灰色（`allowedMoveTargets` →DND套件`useDroppable.disabled`）。

### 2. 董事会 UI

工作区任务标签获得了持久的list/board开关（`components/agent/workspace/board/`）。所有决策逻辑都存在于纯`lib/ai/agent/team/board-model.ts`中（列、队友泳道、tag/priority/assignee过滤器、WIP提示与 `maxConcurrentTeammates`、依赖锁定徽章和`resolveDrop`减少器）;组件是薄壳。游泳道模式是阅读视图——拖拽跨航道会意味着重新分配，而板块故意不这样做。两个新的规范扩展点随坐骑一起发售：`agent.team.task.actions`（卡片......菜单）和卡`agent.team.board.toolbar`;`agent.team.panel`的上下文包充满了roster/task聚合。

### 3. 队伍板CQRS：州降，上命令

Zustand代理团队存储仍然是**单一写入源**（ADR-0022对运行时状态的立场保持不变）。跨设备可见性是一种**单向投影**：

- **Dexie v104 `agentTeamBoard`**（`lib/db/agent-team-board.ts`）：任务列（id = taskId）+ 每队一列团队元行（`team:<teamId>`携带状态、容量、阵容含双绑定`knowledgeTwinIds`）。纪元/MS时间戳、限制评论帖、截断result/error预览。
- **仅桌面投影器**（`lib/db/agent-team-projection.ts`）：商店订阅身份差异`tasks`/`teams`/`teammates`，整合为微任务刷新，修改`bulkPut`s，并与同步墓碑配对删除;关于安装修剪孤儿的完整和解。由桌面同步源提供商和无头 Brain 运行时安装——从未安装在手机上，因为手机的空存储会抹去镜子。
- **同步**：`agentTeamBoard` 加入`SyncableTable`、桌面 delta 读取器（光标 `updatedAt`）、处理器 注册表和Rust `sync_registry`（墓碑）。Dexie从不回信给店里。
- **控制平面**：六个远程控制门控RPCs（`team_task_move|create|comment`、`team_run_pause|resume|stop`）通过通用桌面写入桥接器传输。TS手臂（`lib/companion/agent-team-write-handlers.ts`）通过实时`canMoveTask`重新验证，回应`{ ok, reason }`——一个陈旧的手机快照永远无法推动桌面板拒绝的操作。它们被故意**不*放在移动端离线队列中：命令必须根据实时运行状态进行验证，而不是几个小时后重放。`team_run_resume` acks 触发后不等待（生命周期很长）。
- **移动板**（`components/mobile/agent-teams/team-board-mobile.tsx`）：通过liveQuery渲染镜像（在最后同步快照中离线工作），通过动作表移动，目标来自同一守卫，评论通过RPC。当本地商店空闲但存在同步的元行时，移动工作区会退回到该板——修复了桌面隐形的漏洞。

### 4. 暂停/继续（关闭第二次延期ADR-0022）

`agentTeamManager.pause`存在（中止 + 标记`paused`）;`resume`现在重新进入生命周期：被搁置的`claimed`/`in_progress`任务重置为`pending`（声称已释放），卡住的队友重置，黑板从持久`task.result`重新做种（共享内存仅在内存中——否则重启会使依赖任务枯竭;`autoPublishTaskResult`重新应用PII 门禁），`RunTeamLifecycleDeps.taskFilter`滴落完成工作——过滤后的id会穿线进`synthesizeTeamWorkflow`，因为`satisfiedDependencyIds`存活的依赖项能干净利落地合成。`review`任务从不自动恢复（等待董事会裁决）。相关地，波形路径（自适应重新规划/进度账本）现在会在波浪之间重新开放其重复使用的运行列——ADR-0061 P4所有权守卫（“终端行永不复活”）默默跳过了第一波之后的每一波;伴随的软取消（`cancelled`行）依然被遵守。

### 5. 插件 + 双井去隔壁

- **`ctx.team`**（`lib/plugin/api/team-api.ts`，基于`goal-api.ts`）：读数 + `subscribe` `team:read`;`createTask`/`addComment`/`moveTask`-through-guard在`team:write`之后（和`goal:write`一样，属于非危险级别）。**插件没有运行控制**——组建团队消耗了实际计算，且仍是人力或远程控制的决策。
- **双人可见性**：深度运行时整合（每队友双人注射，`twin_knowledge_search`）在UI中是看不见的。板块现在显示swimlanes/cards上的双子徽章，知识双胞胎芯片行，并根据创建表单的分配者选择者与每个绑定双胞胎的专长简介（`twin-expertise-hints.ts`——纯粹、零LLM调用、零新数据流）进行排序。
- **完成连锁取消**：进球和球队完成的排队共享`lib/runtime/completion-linkage-core.ts`（懒惰运行时负荷、每场比赛单打、`gateModelText` PII红线）。目标↔团队任务模型统一仍是一个明确的**非目标**。

## 后果

- 板子的守护语义仅在一个功能中执行;UI、RPC和插件接口无法漂移。
- ADR-0022“团队运行禁止新增Dexie桌”的标杆;`agentTeamBoard`是一个只有一个写手的读镜，而不是第二个唯一事实来源——结构上不可能产生分歧（投影仪总是投影整个存储）。
- 手机可以监控并引导桌面团队，但永远不会成为第二位写手;冲突语义是通过构造避免的，而非解决。
- 插件可以在任务级别范围内将外部工作（问题跟踪器）输入到板子并做出响应。

## 非目标

跨团队组合板、云团队运行时、跨泳道的拖拽重分配、插件控制的跑步以及目标↔团队任务模型统一。
