---
title: ADR-0128 — 主机中立的调度器、executor 补全与远端备份目的地
description: 桌面、无头大脑与 web / 伴侣壳共用一份调度器契约——用能力门禁替代 isTauri() 断崖、主机自有的任务归属、Node 定时驱动、无头侧的 workflow 触发与通知桥接、"唤醒并委托"式的 OS 提升，以及 GitHub / Google Drive 备份后端。
---

# ADR-0128 — 主机中立的调度器、executor 补全与远端备份目的地

| 字段 | 值                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态 | 已接受                                                                                                                                                                                                                                                   |
| 日期 | 2026-08-16                                                                                                                                                                                                                                              |
| 基于 | ADR-0002 调度器；ADR-0079 scheduling crate；ADR-0082 远端主机 / 伴侣传输；ADR-0090 统一 agent 执行；ADR-0011 可视化工作流；ADR-0009 / 0036 连接器与出站治理；ADR-0001 数据备份                                                                            |
| 范围 | `lib/scheduler/**`、`types/scheduler/`、`components/scheduler/`、`stores/scheduler/`、`lib/headless/runtimes/`、`lib/notifications/`、`lib/data/destinations/`、`crates/cognia-scheduling/`、`src-tauri/src/rpc/data_sync.rs`、设置 → 数据卡片。 |

## 背景

对照应用发布的三种壳，对调度器（任务模型、executor、定时驱动、提升、伴侣 RPC、备份）做了一次审计，结论如下：

- **executor 用 `isTauri()` 做门禁。** backup、wiki-rebuild、goal、script、system-source 只肯在桌面跑，连无头大脑（`cognia-server`）也拒绝——而它的运行时清单里已经装了调度器。失败是裸 `Error`，与 bug 无法区分。
- **四种任务类型是死的。** `workflow`、`im-push` 在枚举与表单里存在但没有 executor；`sync`、`ai-generation` 既没有 executor 也没有可信的支撑系统。未注册处理器的 `custom` 静默成功。没有一种诊断类型能端到端验证触发链。
- **定时是渲染端形状的。** tab-lock 无条件触碰 `BroadcastChannel`/`window`，Node 进程要么崩要么没有驱动。无头主机没有基于 `setTimeout` 的定时驱动。
- **无头侧没有回到用户的路径。** 大脑上的 workflow 触发只能通过 Tauri 事件到达；大脑上产生的 toast / OS 通知无处可去。
- **OS 提升在进程外重新执行任务。** 提升后的 `cognia.exe --task <id>` 路径复制了一套只有运行中的应用才拥有的 executor 管线（sidecar 会话、连接器、keyring），提升运行与应用内运行分叉。
- **备份只有一条真实的远端腿（WebDAV / S3）和一条死腿**（`convex`，从未接线），也没法在大脑上跑——那里的"文件系统"是另一个接缝。
- **UI 说不清自己在展示谁的日程。** 驱动远端主机的桌面、手机 / 云伴侣都在静默读取远端主机的任务；类型选择器在哪里都提供全部类型。

完整的 grill（30 条已确认决策）与设计在 `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`；计划在 `docs/superpowers/plans/2026-08-16-scheduler-host-neutral.md`。

## 决策

### 1. 能力门禁，而非平台断崖

`lib/scheduler/host-support.ts` 按任务类型声明主机必须提供什么（`TASK_TYPE_HOST_REQUIREMENTS`）：`lib/platform/capabilities` 里的 `CapabilityId`（`sidecar`、`shell`、`connector-runtime`），或调度器专属的两个需求——`host-filesystem`（桌面或无头）与 `desktop-shell`（仅 Tauri 进程）。executor 调用 `assertTaskTypeSupportedOnHost`，以**结构化**结果失败（`terminalReason: "unsupported-on-host"`），而不是裸抛。没有需求的类型（`workflow`、`test`、`plugin`、`custom`）在任何注册了 executor 的地方都能跑。

弃用类型（`sync`、`ai-generation`）为持久化行保留在枚举中，创建 / 恢复时拒绝（`SchedulerError.deprecatedTaskType`），调度器初始化时自动暂停（`pauseDeprecatedTasks`），并在三个轴上标注：类型文档注释、详情视图横幅、测试。未注册处理器的 `custom` 以 `EXECUTOR_NOT_FOUND` 失败。executor 迟注册（插件启动）的任务在 60 秒宽限窗口内重试（`waitForTaskExecutor`）后再失败。

按主机可运行矩阵（选择器把不支持的类型**禁用并给出原因**，从不隐藏——工作规则 7）：

| 类型                                                     | 需要                | 桌面 | 无头大脑 | Web / 伴侣 webview |
| -------------------------------------------------------- | ------------------- | ---- | -------- | ------------------ |
| `chat` `agent` `skill` `goal` `plan` `agent-team`        | `sidecar`           | ✓    | ✓        | ✗                  |
| `external-agent` `script` `background-command` `monitor` | `shell`             | ✓    | ✓        | ✗                  |
| `backup` `wiki-rebuild`                                  | `host-filesystem`   | ✓    | ✓        | ✗                  |
| `im-push`                                                | `connector-runtime` | ✓    | ✓        | ✗                  |
| `workflow` `test` `plugin` `custom`（有处理器）          | —                   | ✓    | ✓        | ✓                  |
| `system`（原生 OS 任务，卡片创作）                        | `desktop-shell`     | ✓    | ✗        | ✗                  |
| `sync` `ai-generation`                                   | 已弃用              | 暂停 | 暂停     | 暂停               |

### 2. executor 补全

- **`workflow`** —— `executeDeployedWorkflow`，新增 `WorkflowEntrypoint` / `WorkflowTriggeredFrom.source` 值 **`"schedule"`**，caller `scheduler:task:<id>`，幂等键 `<taskId>:<executionId>`。
- **`im-push`** —— 解析绑定会话，尊重每会话的 `proactivePush` 选择加入，通过 `hasNoLeakingPii`，经治理出站队列（`enqueueGoverned`）入队，因此静默时段、限流、审计（`notify.im_*`）与 agent 发起的推送完全一致。
- **`test`** —— 回显 payload；用于在任意主机上端到端验证触发链。
- **`script`** —— 可插拔 `ScriptRunner`：桌面走 `shell_exec`，无头走 jobs supervisor。

### 3. 按主机选定时驱动

`resolveDefaultTimingDriver()` 在 Tauri 上选 Rust 守护进程，在无头上选 `NodeTimingDriver`（`lib/scheduler/timing/node-driver.ts`，按 2³¹−1 ms 上限分块 `setTimeout`），在 web / 移动上选渲染端驱动 + tab-lock。tab-lock 以 `hasBrowserWindow()` 守卫，Node 进程永不触碰 `BroadcastChannel`。

### 4. 无头桥接

- **workflow 触发** —— `lib/headless/runtimes/workflow-trigger-bridge.ts` 通过伴侣传输的 `/internal/events` 订阅控制帧（`{type:"subscribe", mode:"add|remove|replace", channels}`）订阅 `workflow:trigger`；`lib/workflow/runtime/tauri-bridge.ts` 在非 Tauri 时走同一路径。
- **通知** —— 大脑上产生的 toast / OS 通知每条记录只通过 `remote_notification_publish` RPC（Rust `rpc/data_sync.rs`，现带可选 `source`）在 `notification://remote` 频道发布一次；已连接客户端摄入到本地通知中心（`lib/notifications/remote-subscription.ts`，由 `remote-notification-initializer.tsx` 挂载）。FCM / APNs 仍在范围外。

### 5. OS 提升 = 唤醒并委托

提升后的任务不再在进程外重新执行。原生条目运行新的 `SystemTaskAction::OpenUrl`（macOS `open`、Linux `xdg-open`、Windows `cmd /C start`，由 `validate_open_url` 限定为 `cognia:` / `https:` / `http:`），唤醒 URL 为 `cognia://scheduler/task/<id>?run=<token>`。应用的深链处理器校验每次提升的令牌（`ScheduledTask.promotion { systemTaskId, token, promotedAt, backend }`），再通过普通的应用内 executor 运行任务。暂停 / 恢复 / 删除同步到 OS 条目；提升的任务不由应用内循环武装。无头主机不提升（常驻在线）。

### 6. 主机自有的归属与主机栏

每台主机维护自己的 `CogniaSchedulerDB`；任务不在主机间交接。客户端选择它**管理**哪一份可达日程——`local`（本机）或 `paired`（它驱动 / 配对的主机，经 `scheduled_task_*` RPC）——见 `lib/scheduler/scheduler-host-target.ts`。默认：伴侣与驱动远端主机的桌面偏好 `paired`；记住的 `paired` 在不可达时退化为 `local`。调度器页面显示主机栏（"管理中：本机 / 云端主机 <名称>"、已暂停徽章、仅打开时运行提示、切换按钮）；类型选择器通过 `host_capabilities` RPC 解析**目标**主机的能力。

### 7. 远端备份目的地

`lib/data/destinations/` 新增 **GitHub**（contents API 写入私有仓库——公开仓库被拒绝）与 **Google Drive**（用户自备 OAuth 客户端、**设备流**、`drive.file` 范围、令牌存于 `backup-destinations` keyring 命名空间）两条腿，以及与调度 `backup` executor 同一管线的手动"立即同步"。`convex` 原地弃用。executor 按腿扇出并在备份历史中记录 `destination`。主机文件系统访问经 `lib/data/backup-host-filesystem.ts`，无头运行时注入自己的接缝。设置 → 数据承载两张卡片；调度对话框只提供已配置的目的地。

## 后果

- 新任务类型必须在 `TASK_TYPE_HOST_REQUIREMENTS` 中声明需求（或显式为空）——选择器、executor 门禁与文档矩阵都读这一张表。
- 因主机原因被拒的运行以 `unsupported-on-host` 执行行可见，而非异常；监控能把它们与 executor bug 区分开。
- 提升任务现在与应用内运行行为一致；旧的进程外重执行路径已移除。没有令牌的旧提升在首次使用时重新提升。
- web 独立壳的可用面严格更小，并在界面上直接说明，而不是运行时失败。
- 伴侣 / 远端客户端需处理 `subscribe` 控制帧与 `notification://remote` 频道；旧服务器只是不会发出它们。
- 需要用户凭据的备份目的地（GitHub 令牌、Google 客户端密钥 / 令牌）只存在于主机 keyring，并排除在设置同步之外。
