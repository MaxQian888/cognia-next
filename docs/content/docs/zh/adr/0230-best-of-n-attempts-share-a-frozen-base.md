---
title: "0230 — Best-of-N 尝试共享冻结基线"
description: "Host 账本管理独立尝试、物理工作区写锁、预算和人工胜者授权。"
---

# ADR 0230 — Best-of-N 尝试共享冻结基线

**状态：** 已接受
**日期：** 2026-10-17
**关联：** ADR-0198、ADR-0217、ADR-0227、ADR-0229

## 决策

一次请求在同一个 Host、同一个 Git 仓库中分配 2–4 个独立尝试。
`task-workspaces.sqlite` 的 `best_of_n_groups` 和 `best_of_n_candidates`
是权威数据源；前端及未来同步投影均可重建。request ID 唯一，重复请求返回
已有分配。Host 只解析一次已提交的 base SHA，并记录原 checkout 是否存在
未提交修改；这些修改不会复制给候选。每个候选拥有独立 child session，
使用 `base: { kind: "gitRef", gitRef: baseSha }` 获取 managed bundle。

`lib/best-of-n/service.ts` 的 `startBestOfN` 是 slash command 和 composer
共用入口，接管本次发送，不会再给父会话发送一遍消息。纯核心通过 durable
team dispatch 执行固定 N 个任务，不规划、不分享答案、不自动选择、不综合。
agent/model 和预算通过 capability grant 进入 `resolveSendOptions`，不修改
返回的 SendOptions。

## 所有权、预算和恢复

Host 修改使用 version CAS 和有期限的 owner lease，并由 SQLite 事务保护。
执行期间续租失败即停止。重启后重新绑定账本；执行中断或候选工作区消失时
进入 `recoveryRequired`，不会自动重放可能已经产生副作用的操作。

durable 写锁以 Host canonicalize 后的物理根目录为键，跨 run 和 repository
alias 生效。不同物理根可以同时修改相同相对路径；同一根的别名共享锁。
原有 isolated-parallel 模式仍在同一物理根内检查不重叠的文件所有权。
端口块复用 ADR-0229。

组有有限时长预算；可选 USD 预算平均分配给固定的候选，以只能收紧的 grant
下发。Host 累计已知费用，未知费用保持 `null`，绝不替换为 0。Host 同时检查
累计费用和执行时长。`isolateFailure` 保留失败候选的 checkpoint 和证据，
不会暂停其他候选。零成功候选进入恢复状态；没有代码变化的成功候选可展示，
但不能被选择发布。

配置 USD 上限时，最终 runtime 必须支持执行该上限；第一阶段在发送前拒绝
不支持该能力的组合。仅限制时长的尝试仍可运行；AI-SDK 默认的零费用按未知处理。

## 选择和发布

正常状态为 `preparing → running → awaitingSelection → publishing → published`，
另有 `cancelling`、`cancelled` 和 `recoveryRequired`。归档进度独立记录，
清理失败不能覆盖已经发布成功的状态。

只有受信任的交互式应用调用可选择胜者；Companion、plugin 和 unattended
调用不能通过请求字段伪造交互来源。选择固定 candidate ID 和 captured head
SHA，并停止尚未结束的候选。没有 AI judge。默认创建新的结果分支，只有明确
选择目标时才更新已有分支；永不 push。

frontend plugin 与主 renderer 共享运行环境，因此 Host 还要求原生窗口中由
用户确认候选、记录的 head 和目标分支。确认绑定业务 version，过期后必须重新确认。
等待原生对话框不会占用 progress 队列。仅续租不改变业务 version；候选进展、
owner 变更和实际恢复操作会推进 version。批准后 Host 重新读取、校验状态，再执行
选择 CAS。显式取消意图独立于预算耗尽持久化，因此预算停止后仍可取消并归档。

changeset 捕获在 progress 关联 changeset ID 之前就识别候选 session/workspace，
并始终与冻结基线比较，即使结果分支尚未创建。integration prepare 和 publish
分别检查所选胜者、准确 head、目标分支、单 changeset 和 `onConflict: "stop"`，
通用 SCM 路径也无法发布落选候选。发布复用 ADR-0227 integration queue。
integration 在胜者守卫前规范化目标分支，因此 `main` 和 `refs/heads/main`
表示同一个经用户明确选择的目标。

## 交付边界

第一阶段包含账本、Host commands/catalogs、固定任务驱动、恢复、预算和发布
守卫。第二阶段提供 slash command、仅作用于下一次发送的 composer chip、
比较 dock、人工选择/检查/发布及同步摘要。第三阶段（见下文）提供异构 agent、
CLI 与 plugin 入口、配对设备停止请求和重启恢复；schema 始终不授予选择权限。

两个入口共用确认对话框，展示已提交基线、不携带未提交修改的提示及可编辑目标。
默认新分支名为 `best-of-n/<requestId>`，使用组的持久请求标识；已有分支必须
显式选择。父 assistant message ID 与 request ID 相同，可从持久消息重建
run card 绑定，不会再向父会话的模型发送一次提示词。

比较 dock 展示只读 diff/changeset 详情。人工选择停止其他尝试并运行已批准
的 ADR-0188 profiles。`checks.ts` 在记录的 changeset head 上创建新的
checkout，不把可变执行目录当作该 commit 的证明。确定性 SCM review 不使用
AI reviewer。发布是独立操作：重新检查固定 head、记录用户审批，再仅以所选
changeset 和 `onConflict: "stop"` 调用 `createScmRuntime.integrate`，集成
结果 commit 也通过原有验证链。

发布后只归档落选工作区和会话，保留胜者。Host 归档状态及会话清理错误独立于
发布状态，并可重试。显式归档未选择的运行时，先取消并停止未完成尝试。
Dexie `bestOfNRuns` 投影已注册数据治理目录和 Companion sync registry，
包含 Host 状态、父消息绑定、准确 head 的证据及摘要，不能授权写操作。
refresh/rebuild 从 Host 证据重建投影，配对设备只读展示同步摘要；不新增
account E2E sync 权威。

定向测试覆盖幂等分配、冻结基线、owner/CAS、物理别名写锁、独立失败、提前
取消、未知费用、人工 exact-head 选择以及 prepare/publish 双重守卫。

## 第三阶段：agent、入口、设备与重启

**异构候选。** 每个候选记录自己的 agent 描述。选择项可以是 `session`（当前
对话的 agent、model 与 provider）、外部 agent 配置的精确 ID，或 preset ID
（`claude-code`、`codex`），后者按共享绑定顺序解析为该运行时第一个已启用、
未绑定 gateway 的配置。slash command 接受 `--agents a,b,...`，每个候选一项；
开始对话框为每次尝试提供一个选择器。预览前和开始前都会重新解析；未知或已
禁用的名称直接拒绝，不会替换为其他 agent。外部候选记录为当前对话的 agent
加 `cognia:external-agent:<configId>` provider。

外部候选通过外部 agent manager 运行，与 Agent Team 队员的启动路径相同：工作
目录为候选自己的工作区根，截止时间为组剩余的时长预算。不转发 MCP server，
候选授权中的工具禁用因此成立。外部执行契约不报告费用、也不执行金额上限：
费用保持 `null`（显示为未知），设置 USD 预算时在尝试开始前拒绝。自身解析
运行时为外部 agent 的 Cognia agent 走同一通道；旧的无作用域外部标记被拒绝。

**CLI。** `cognia-agent best-of-n start|status|list|cancel|select|publish|archive`
通过 CLI bridge 的 `POST /api/dev/best-of-n/{action}` 驱动桌面端，由负责编排
的 renderer 应答。start 复用 composer 的预览与开始路径。select 和 publish 在
`--yes`、`CI` 或没有 TTY 时拒绝；先在终端确认，再经过 Host 的原生审批，因为
bridge 字段无法声明是人做出的选择。原有 Host 命令保持其目录条目。

**插件。** `ctx.team` 新增 `startBestOfN`（`agent:dispatch`，始终使用新结果
分支）、`getBestOfN` 与 `listBestOfN`（`team:read`，读取同步投影）以及
`cancelBestOfN`（`agent:control`）。不提供 select 或 publish，并有测试锁定不存在
此类方法。读取返回不含 owner lease、version、物理根与工作区 ID 的公开投影。

**配对设备。** `BestOfNDeviceRole` 定义两种角色。配对观察者展示投影，并可
请求 Host 停止运行：Host 接受非 owner 发起的取消，不夺取 owner lease（仍做
version CAS），owner 在下一次轮询时逐个结束尝试。选择、发布、检查和归档在
配对设备上保持非活动状态，UI 有标注并由测试锁定。

**重启与被拒绝的发布。** 桌面初始化器在每个进程中执行一次恢复：等待上一进程的
lease 过期（有上限），然后重新绑定所有未完成的组：运行中的尝试标记为
`recoveryRequired`，从未开始的尝试标记为失败，缺失的工作区由 Host 报告。
prepare 之后被 Host 拒绝的发布（例如已检出的目标分支有未提交修改）过去会让
胜者停留在 `integrating`，review 会拒绝该状态。现在 abort 会把 best-of-N
胜者恢复为 `approved`；发布在拒绝后立即释放所持有的集成，任何重试或重启时
也会再次释放，因此重试会重新运行 exact-head 检查并创建新的集成。仍处于
`publishing` 的运行永不 abort。多命令批次中的 `/best-of-n` 会在任何命令运行前
被拒绝。

