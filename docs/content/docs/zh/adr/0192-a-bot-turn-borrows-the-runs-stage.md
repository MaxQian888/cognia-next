---
title: "0192 — 机器人回合借用运行的舞台"
description: "连接器触发的机器人回合过去像一个二等运行时：进度被压扁成状态卡片里的一个折叠面板，最终回答以一张光秃秃的 Card 1.0 div 发出，`ask_user` 则弹出一个 IM 会话里没人看得到的桌面对话框。本 ADR 让机器人回合借用桌面运行拥有的同一座舞台——租户支持时使用飞书原生 `message_cot` 思维链，带状态头 / 引用输入 / 页脚 / 内联图片的 Card 2.0 结果卡，经由持久回调绑定机制路由的交互式 `ask_user` 卡片，注入首轮的群聊未读上下文，以及让机器人投递获得与其他受治理运行相同的运行卡、审批按钮和思维链的执行运行绑定——全部构建在既有的 A2UI 表面、绑定与外发队列机制之上，而不是一条并行的机器人管线。"
---

# ADR 0192 — 机器人回合借用运行的舞台

**状态：** 已接受 — 已实现
**日期：** 2026-09-21
**相关：** [ADR-0009](./0009-platform-connectors)（平台连接器与受治理外发队列）、[ADR-0025](./0025-connector-runtime)（连接器运行时）、[ADR-0036](./0036-connector-inbox-writes)（IM 适配器契约）、[ADR-0089](./0089-connector-run-presentation)（运行呈现驱动器）、[ADR-0131](./0131-connector-callback-authorization)（回调绑定与统一授权守卫）

## 背景

连接器机器人路径能够回复一条消息，却无法像桌面运行那样*演绎*一个回合。对照 `ies/aiden-bot` 与 `ies/aiden-bot-server`——本次工作被要求对齐的飞书机器人参考实现——有四个缺口最关键：

**没有思维链。** 进度以 CardKit 状态卡里一个折叠面板的形式抵达会话——一条被压扁的文本时间线，每个节拍都整体重建。飞书对此有原生表面（`im/v1/message_cot`，一条 AG-UI 事件流），aiden-bot 用交错排列的推理段与工具调用行来驱动它；Cognia 从未调用过这个 API。

**最终回答是最朴素的卡片。** 一个带 markdown 的 Card 1.0 `div`：没有状态头，没有触发消息的引用，没有带提问者 / 耗时 / 中断状态的页脚，`![](路径)` 图片引用也只是字面文本，而不是上传后的 `image_key`。

**`ask_user` 对着空房间提问。** 该工具挂起在渲染进程的提问对话框（`stores/agent/ask-user-store`）上。对连接器触发的回合而言，没有人在看桌面端——问题永远到不了会话，运行就此悬挂。定时摘要回合同样如此，它们甚至连提问者都没有。

**群聊与机器人投递的边缘很薄。** 群聊回合只看得到 @ 它的那条消息——上一次助手回复与触发消息之间的环境消息完全不可见，被回复的消息也不贡献引用。机器人投递（`lib/bot/`）写的是真实的 `executionRuns` 行，却没有 `executionRunBinding`，所以在 IM 里从不出现运行卡、审批按钮或思维链。

每个缺口的朴素修法都是一条机器人专用通道——专用卡片 schema、定制 webhook 处理器、并行的权限路径。这正是我们拒绝的：Cognia 已经拥有 A2UI 表面、持久回调绑定、统一授权守卫、受治理外发队列和运行中断。机器人回合应当借用这座舞台，而不是再搭一座。

## 决策

### 原生思维链带能力门控，而不是分叉的呈现器

`run-presentation/lark-cot.ts` 把连续的 `RunProjectionSnapshot` 投影为 AG-UI COT 事件（`RUN_STARTED` → `REASONING_MESSAGE_*` → `TOOL_CALL_START/END` → `STEP_STARTED/FINISHED` → `RUN_FINISHED/RUN_ERROR`），`lark-driver.ts` 在状态卡之前创建 COT 消息，使过程位于卡片上方的会话流中。投影状态是纯 JSON，持久化在 `ref.opaqueState` 里，崩溃的驱动器重启后正确地继续 diff，而不是重放。

写入器遵守该 API 的真实契约——每批 ≤50 事件、间隔 ≥65ms、时间戳严格递增、`230001`（"消息不是 COT"）绝不重试——创建走能力门控：当租户或域名不支持 `message_cot` 时，驱动器回退到既有卡片时间线，并把运行标记为 `presentedCot`，使一次中途死亡的 COT 强制走 `replace_card` 而不是留下静默缺口。PII 从不越过边界：COT 文本只来自已脱敏的活动标签、步骤标题和固定 i18n 字符串；`TOOL_CALL_ARGS` 被刻意地从不发送。

### 结果卡是投影出的段，而不是模板

`adapters/lark/result-card.ts` 把最终回答构建为 Card 2.0 表面：状态头（running / done / error / interrupted 配色）、当平台没有原生引用时的 `> 回复：…` 触发消息引用、带提问者 / 运行链接 / 耗时与"已中断"标记的页脚，以及经由 `lark/upload.ts` 上传为 `image_key` 的 `![](path|url|data:)` 图片引用——上传失败时降级为链接。卡片作为受治理的外发段发出，任务上盖有 `metadata.resultCard`（`{runId, status, interrupted}`），因此既有的 `onConnectorOutbound` 插件钩子可以带着结构化上下文观察、否决或改写它，而不是猜测卡片 JSON。

`run-presentation/runner.ts` 为持久运行的里程碑结果卡复用同一构建器，因此一个因超时、中断或恢复而结束的飞书运行会得到同样的终态产物。

### `ask_user` 搭乘回调绑定机制

"问题去哪儿"由注册表接缝决定，而不是由工具决定：

- `hitl/im-elicitation-context.ts` —— 连接器运行时为每次捕获注册一个上下文，位置紧邻 `makeImPermissionResponder`，携带适配器、会话、投递目标、发起人、运行 id、drafting 标记，以及绑在捕获 `approvalController` 上的中止信号。`scheduled-outbound.ts` 里的摘要回合以 `actorScope: {mode: "conversation"}` 注册，因为它们没有单一请求人。上下文随捕获消亡，`getImElicitationContext` 把已中止的上下文视为不存在，迟到的 `plugin_tool_exec` 事件永远无法复活一个已死回合的卡片。
- `lib/claude/plugin-tool-ipc.ts` —— `ask_user` 分支按会话查找；有活上下文则路由到 `runImAskUser`，没有则继续使用桌面对话框。两条路径返回同一个 `formatAskUserAnswer` 字符串。
- `hitl/ask-user-question.ts` —— 构建双语 A2UI 问题卡（每个选项一个 Button——单选用 `select`、多选用 `toggle`，`allowText` 时加 TextField，外加 Skip 按钮），在入队*之前*为每个交互组件预写一行持久 `connectorCallbackBindings`（与映射器投递时的 upsert 完全一致，使路由行先于卡片可被按下就存在），经受治理网关入队，在有运行 id 时把等待镜像到一条持久的 `ask_user` 运行中断上，并在结算时冻结卡片——飞书走审批卡命令帧，其他平台走剥掉控件的受治理编辑。
- `hitl/ask-user-registry.ts` —— 待答提示，以 `${sessionId}:${toolUseId}` 为键，带 TTL 兜底（默认 10 分钟）与属主中止结算，一张被遗忘的卡片永远无法把回合永远卡住。
- `bus.ts` —— 在通用 A2UI 交接之前的短路分支：带绑定的按下抵达时已通过统一守卫授权；无绑定的关联事件（Telegram ForceReply `input`、Discord `modal_open` 提交、卡片 dismiss）按 `surfaceId` 匹配，并按提示自身的 actor scope 复查。`toggle` 只重绘不结算；`select`/`submit`/`submit_text`/`skip` 结算；对已死提示的按下被审计并吞掉——绝不成为新的模型回合。`dismiss` 动作优先于组件烘焙的任何 op。

两条刻意的不变量：`select`/`toggle`/`submit` 只接受模型真实提供的选项值（一次按下永远不能凭空造出答案），卡片重绘沿用原始绑定过期时间而不是铸一个新的。surface id 取 `au_<16 hex>`，使生成的 `a2ui:<surface>:<component>:<verb>` 动作 id 保持在 Telegram 64 字节 `callback_data` 上限之内，从而不哈希地往返于绑定表。

### 群聊上下文是注入的，不是存储的

`bot/sources/connector-inbound.ts` 存储所有未丢弃的群消息；`runtime.ts` 现在把模型从未见过的那些——上一次助手水位线与触发消息之间的环境消息——连同解析出的 `replyTo.preview` 引用，装配成一个 XML 上下文块前置到模型提示词。存储的入站行保持干净；只有提示词携带上下文，因此历史读起来是人写的那样，而模型读到的是房间当时在说的话。

### 机器人投递获得呈现绑定

`bot/runtime/im-presentation.ts` 为源自 IM 的机器人投递构建 `executionRunBinding`，使通用呈现运行器自动接手——运行卡、思维链、审批按钮——没有任何机器人专用渲染路径。既有的 `bot` 控制处理器（`approve`/`deny`/`stop`/`retry`）免费地在 IM 中可达。

### 顺带落出的一个事务边界修复

`createRunInterrupt` 与 `step.ts` 的 compare-and-resolve 事务写于 schema v227 增加 `notificationProjectionWork` 之前；其中的日志追加现在会触碰该表，Dexie 中止了每一次审批创建。两个事务现在都列出了该表——这一个修复同时修好了工具、计划、机器人与 ask-user 中断。

## 影响

- 飞书会话把推理、工具调用与提问看作原生表面；不支持 `message_cot` 的租户毫无损失——它们保留卡片时间线。
- 桌面对话框契约原样不动；`ask_user` 在两种传输上只有一个格式化结果。
- 每个交互组件都是一行持久绑定，因此重启安全的去重、过期与 actor-scope 强制来自 ADR-0131 的守卫，而不是每张卡片的临时检查。
- 新增平台是增量工作：一个遵守 `bindingHintFields` 的映射器免费获得问题卡、toggle 重绘与冻结；不能做卡片的平台得到 `widget.fallbackText` 镜像与按 surface 关联的文本路径。
- 机器人投递现在在 IM 中露出待决中断——运行卡成为一个卡住的机器人回合唯一显形的地方，而不是一行静默日志。

## 已考虑的替代方案

**并行机器人专用卡片管线**（整体移植 aiden-bot-server 的形态）被否决：它会重复连接器栈已经拥有的去重、授权、重试与冻结逻辑，而且未来每一种 HITL 都得建两遍。

**经由既有桌面对话框的渲染进程侧征询**（把 IM 回答推回 `ask-user-store`）被否决：对话框的生命周期是渲染进程 store，不是持久提示——它无法在重载后存活，无法被回调绑定按 actor 限定范围，还会把 IM 延迟耦合到渲染进程焦点状态上。
