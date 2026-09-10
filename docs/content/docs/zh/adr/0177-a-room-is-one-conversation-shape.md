---
title: "0177：房间是一种会话形态，有三种成员来源"
description: "角色团队房间、共享会话与 IM 群组统一为一个房间抽象：一个不依赖 React、由持有运行权的一方执行的 runner，一个成员投影，一行房间设置，以及一条 room_send 命令，让伴随端把回合交给宿主而不是在手机上编排。Squad 保持为执行器不动。"
---

# ADR 0177：房间是一种会话形态，有三种成员来源

**状态：** 已接受
**日期：** 2026-09-10
**相关：** ADR-0140（AgentTeam 到 Squad）、ADR-0149（身份平面与协作）、ADR-0131（跨壳收件箱中继）、ADR-0136（跨设备放置）、ADR-0059（无头大脑）、ADR-0169（运行控制）、ADR-0175（RPC 门面）

## 背景

仓库里有四样东西都叫"群聊"，彼此互不相识。

1. **角色团队房间。** `ChatSession.kind === "team"` 让多个角色面对一位本地用户。路由、上下文拼装、轮次规划、主管派发和流式镜像全部塞在一个 React hook 里，`hooks/chat/use-team-chat.ts`，1810 行闭包。配对的手机因此要自己编排整轮，只有每个成员的模型调用通过 `claude_send` 到达宿主。手机在回合中途休眠，整轮就没了。没有 React 树的无头宿主则完全跑不了团队房间。
2. **共享会话。** 协作服务器（ADR-0149）让多个人面对一个助手。两端都被 `NEXT_PUBLIC_SHARED_CHAT_ENABLED` 关着，成员关系躺在 `collabChatMemberships` 镜像里，界面上没有任何地方读它。
3. **IM 群组。** 连接器让一个机器人面对平台里的成员。激活策略在一处解析（`conversation-admission.ts`），群组可以绑定 Squad 却绑不了角色团队，只有 Lark 和 Matrix 能枚举房间里有谁。
4. **Squad**（ADR-0140）。带任务看板的执行器。它不是会话形态，本 ADR 不动它。

纯决策部分本来就是共享的：谁发言（`team-router.ts`）、每个成员读到什么（`team-transcript.ts`）、一条消息是谁写的（`lib/chat/speaker.ts`）、房间里有谁（`lib/chat/room-roster.ts`）。不共享的是它们周围的一切：循环在哪跑、谁汇报状态、房间记住什么、房间设置究竟是什么。

另外三个事实决定了设计。

- hook 的流式镜像按团队会话而不是成员子会话做键。两个成员同时流式输出时，各自都会把对方写了一半的列表当作自己的基线。并行回复在结构上就不可能。
- 记忆已经有按会话的开关（`memoryUse`、`memoryLearn`），所有回忆与蒸馏点都遵守它们。房间的记忆策略不需要新平面，只需要一个设置它们的地方。
- 配对设备的写入通过一条桥接通道到达 TypeScript（`desktop_writes_bridge.rs` 进入 `desktop-write-source.ts` 的 `dispatchCommand`），无头大脑装的是同一个文件。一条分支因此同时服务两种宿主。桌面渲染端必须直接调用 runner，因为桥接分支不是 Tauri 命令。

2026-09-10 的一轮 grill 敲定了 27 条决定。本文记录它们合起来的形态，以及交付它的批次。

## 决定

### 房间是一种形态

**房间**是参与者多于两方的会话。`RoomKind` 说明它的成员关系存放在哪里：

| 类型     | 会话标记                          | 声明的成员                    | 谁来编排                          |
| -------- | --------------------------------- | ----------------------------- | --------------------------------- |
| `team`   | `kind === "team"` 且有 `teamId`   | `Team.members`                | 持有运行权的宿主                  |
| `shared` | 存在 `collaboration`              | `collabChatMemberships`       | 协作服务器（租约，批次 5）        |
| `im`     | 存在 `platformBinding`            | 在 `chat.members.read` 前没有 | 宿主上的连接器运行时              |

`roomKindOf(session)` 是唯一的分类器（`lib/chat/room/kind.ts`）。直接对话是 `null`。Squad 运行不是房间。

### 参与者是投影，不是表

`projectRoomParticipants`（`lib/chat/room/participants.ts`）从该类型对应的存储读取声明侧，与实际发过言的人合并，并给出**完整度**：声明来源能担保名单时是 `full`，平台只暴露人数或管理员时是 `partial`（批次 4），只知道发言者时是 `observed`。第四张表会成为两个平面的第二个写入者，对第三个平面则是空表。头部徽章、提示词名单和输入框的 `@` 补全读同一个答案，而一个只知道发言者的 IM 群组会明说，而不是渲染成一个三人房间。

### 房间设置存在会话行上

`ChatSession.roomSettings`（非索引，不升 Dexie 版本）承载：

| 字段             | 类型                                   | 生效批次 | 作用                                                                 |
| ---------------- | -------------------------------------- | -------- | -------------------------------------------------------------------- |
| `instructions`   | `string`                               | 批次 1   | 以 `## Room instructions` 注入每个成员的系统提示词                  |
| `memory`         | `boolean`                              | 批次 1   | 由 `roomSettingsPatch` 镜像到 `memoryUse` 与 `memoryLearn`           |
| `replyMode`      | `"auto" \| "mention_only" \| "asleep"` | 批次 3   | 现在保存，之后由路由器遵守，在此之前标注为未生效                    |
| `mutedMemberIds` | `string[]`                             | 批次 3   | 现在保存，之后由路由器遵守，在此之前标注为未生效                    |

`resolveRoomSettings` 按类型提供默认值。**人数多于一位的房间默认关闭记忆**（`memoryUse` 与 `memoryLearn` 为 false），用 `instructions` 替代私有记忆原本承载的内容，这样没有成员会把某个人的记忆带进它不属于的房间。只有一位人类的团队房间保持记忆开启。

`replyMode` 到各平面的映射，在批次 3 到 5 交付：

| `replyMode`    | 团队房间                           | IM 群组（`InboundActivationPolicy`） | 共享房间                     |
| -------------- | ---------------------------------- | ------------------------------------ | ---------------------------- |
| `auto`         | 按配置的 `maxAutoRounds`           | `always`                             | 助手回应每一条人类消息       |
| `mention_only` | 首轮仅在 `@` 时触发，无自动轮次    | `mention`                            | 仅在被点名时回应             |
| `asleep`       | 不回复，消息仅保存                 | `off`                                | 向审计写入一条沉默裁定       |

### runner 不依赖 React，在持有运行权的地方执行

`RoomRunner`（`lib/chat/room/runner.ts`）就是 hook 曾经承担的编排，做成一个带两个接缝的类：

- **`RoomRunnerDeps`**：所有做 IO 的东西。sidecar IPC、Dexie、执行代理、每回合的 AI 辅助。`createProductionRoomDeps()` 在桌面渲染端和无头大脑上绑定同一批 lib 模块。
- **`RoomRunnerSinks`**：所有汇报状态的东西。会话状态、成员状态、消息切片、steer 队列、审批、设置。`createStoreRoomSinks()` 写 zustand store，它们是普通模块，在 Node 里也能用。

流式状态按**成员子会话**做键（`runner-streaming.ts`）。每个成员的事件作用于 `基线 + 自己的切片`，从不作用于另一个成员的半成品，store 与 Dexie 看到的房间记录是 `基线 + 每个活跃切片`（按开始顺序）。一次一个成员时，这与旧镜像逐字节一致。多个成员时，这正是批次 3 并行回复需要的形态。

三种执行宿主构造它：

| 宿主         | 构造方式                                        | sidecar 事件               | 成员状态                          |
| ------------ | ----------------------------------------------- | -------------------------- | --------------------------------- |
| 桌面渲染端   | `useTeamChat` 里的 `getHostRoomRunner()`        | hook 中的 `onClaudeMessage` | `useUIStore` 进成员面板           |
| 无头大脑     | `room-runner` 运行时里的 `getHostRoomRunner()`  | 启动时的 `onClaudeMessage`  | `room://member-status` 宿主事件   |
| 伴随端       | `getCompanionRoomProjector()`                   | 镜像的事件通道             | 由成员事件推导                    |

桌面的 `useTeamChat` 与 `room_send` 分支共享**每进程一个** runner，因此手机的回合和本地回合落在同一个 steer 队列和同一个中断集合上。伴随端（Capacitor、web 伴随）从不编排：它的 runner 把持久化都替换为空操作，只把已经收到的成员事件投影进 store，流式文字照样渲染。持久化的行通过同步镜像到达。

没有打开面板的房间的审批现在遵循直接对话的规则：持有该房间控制租约的远端设备来决定，它一直不答则由兜底拒绝，其他情况直接拒绝。以前房间会不看租约就自动拒绝，这就是手机从来无法批准团队成员工具调用的原因。

### `room_send` 与 `room_stop` 是桥接命令

两条新命令，`target: execution`，能力 `agent.run`，传输 http/websocket/webrtc，资源 `room`，由两种宿主上的 `room.host-run` 特性宣告：

- `room_send { sessionId, content?, webSearchContext?, attachmentManifest?, regenerate?, editMessageId? }` 在宿主接受回合的那一刻就回答 `{ accepted: true }`。团队回合可能跑几分钟，而桥的超时是 30 秒，所以宿主把它分离运行，伴随端从成员事件得知结果。
- `room_stop { sessionId }` 中断所有进行中的成员，收齐确认后回答。

`callerDeviceId` 由 Rust RPC 层从已验证的设备上下文注入，从不读客户端载荷。配对在设计上就是同一个人，所以伴随端回合持久化的用户行带着 `collaboration.author = { kind: "human", id: <宿主绑定的人，否则本地账户>, displayName: <设备标签>, source: "device:<id>" }`。这就是每一行由非本地主体写入的记录的身份规则：发言者解析器能说出是谁写的，而不是把所有远端写入折叠成匿名的 `User:`。

### 采纳的业内做法

回复模式与沉默裁定（ChatGPT、Slack 里的 Claude）。发言策略、话痨度与静音（AutoGen、SillyTavern）。交接目标的转移图（AG2）。人在输入时让位（SillyTavern）。未点名的追问交给上一个回答者（LangGraph swarm）。轮次与停滞的预算（Agents SDK、Magentic-One）。Agent 消息永远不构成同意（Claude Code agent teams）。群组里默认关闭记忆（ChatGPT）。状态字符串（Slack）。带引用的范围补课（Slack AI、Gemini）。机器人来源标记作为环路断路器（Slack、Discord、Telegram）。

## 批次

| 批次            | 范围                                                                                                                                                                                                                      | 关键文件                                                                                                                                                         | 落地前保持休眠的部分         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| B1 基础         | `lib/chat/room/`（kind、settings、participants、runner、streaming、deps、sinks、host），`room_send` 与 `room_stop`，`room-runner` 无头运行时，成员面板里的房间设置区，徽章与上下文名单改用投影                            | 本 ADR 的文件清单                                                                                                                                                | `replyMode`、`mutedMemberIds` |
| B2 原语         | 消息行上的 `replyTo { messageId, preview }`，`reactions`（IM 入站事件，`send.reaction` 可用时出站镜像），从 `tool-<name>` 片段推导并自动清除的 agent 状态字符串，基于 `sessionState.lastReadAt` 的未读分隔线，IM 线程渲染 | `packages/agent-config-types`、`lib/db/messages.ts`、`lib/sync/handlers/messages.ts`、`components/chat/message-renderer.tsx`、`stores/ui`、`lib/connectors/bus.ts` | 无，每个类型随其 UI 一起落地 |
| B3 编排         | 输入框里的手动成员选择，`Team.replyConcurrency: sequential \| parallel`，消息头部的按成员中断，`planAutoRound` 与 `selectPrimaryResponder` 中的 `handoffTargets` 与 `talkativeness`，静音，输入时暂停，粘性回答者，`replyMode` 生效 | `lib/claude/team-router.ts`、`lib/chat/room/runner.ts`、`components/settings/teams-section.tsx`、`components/chat/composer.tsx`                                   | 无                           |
| B4 IM           | 收件箱里区分群组与私聊，各适配器的 `chat.members.read` 及完整度分级，`ConversationOverrideRow.characterTeamId` 经 runner 带角色前缀回复，Discord 线程检测缓存到 `connectorConversationStates`，四张连接器表进入伴随同步   | `lib/connectors/**`、`lib/connectors/adapters/*/`、`lib/data-governance/table-catalog.ts`、`lib/sync/handlers/`                                                   | `partial` 完整度             |
| B5 共享房间     | 去掉 `NEXT_PUBLIC_SHARED_CHAT_ENABLED` 改为运行期探测（存在协作连接且 `/health` 特性含 `shared-chat`），带审计行的沉默裁定，默认关闭记忆，经无头回合回退生成带 `@msg:` 引用的补课卡片                                      | `lib/collab/**`、`lib/chat/room/`、`components/chat/`                                                                                                             | 无                           |
| 之后            | 协作流上的人类在线状态，人对人的 `@`，按人审批，邀请人进入团队房间，agent 私语，runner 作为共享房间租约执行器，解除团队与共享互斥                                                                                       | `crates/cognia-collab-server`、`lib/collab/`、`components/chat/shared-session-panel.tsx`                                                                          | 尚未定义类型                 |

每个休眠字段都在三个轴上标注（硬规则 7）：类型上的注释、界面上的未生效标签、钉住该标签的测试。

## 后果

- **房间在持有运行权的地方运行。** 桌面与无头宿主完整编排。伴随端在附着租约下观察与控制。独立的 web 壳是只读镜像。浏览器扩展不参与。
- **离线。** 团队房间在宿主上无网也能跑。共享房间离线时只有读取加草稿，草稿从不乐观发送。
- **hook 是适配器。** `useTeamChat` 构造 store sinks，持有事件订阅，转发给 runner（宿主）或 `room_send`（伴随端）。它现有的 85 个测试是这次抽取的回归网。编排本身在 `lib/chat/room/runner.test.ts` 里用假件测试，没有 store 也没有数据库。
- **清单上多一个特性标记。** `room.host-run` 告诉客户端可以把房间回合交出去。没有它，房间在该设备上是只读的，客户端也能说明原因。
- **注册成本。** 一条桥接命令要碰描述符、两份 schema 目录、`CALLER_DEVICE_ID_COMMANDS`、`KNOWN_COMMANDS`、`data_sync.rs` 的分发分支、特性清单，以及生成器的宿主分类表（`room_` 归入 `agents`）。生成器重新生成 OpenAPI 文档、Rust 与 CLI 的命令表和目录哈希。

## 非目标

- 在宿主之外执行房间的云运行时。
- 应用内的线程实体。`replyTo` 是行上的引用，IM 线程渲染平台的 `threadId`。
- 共享房间的乐观离线发送。
- 对真实 IM 账号的认证。适配器针对夹具测试。
- 对 Squad 的任何改动。

## 实现更新（2026-09-10，批次 1）

已落地：`lib/chat/room/{types,kind,settings,participants,runner,runner-streaming,runner-deps,production-deps,store-sinks,runner-host}.ts`、`lib/companion/{room-send-client,room-write-handlers}.ts`、`lib/headless/runtimes/room-runner.ts`、`room_send` 与 `room_stop` 分支及其注册、`room.host-run` 特性、`components/context-workbench/panels/team-members-panel.tsx` 里的房间设置区、改用 `projectRoomParticipants` 的徽章与 `lib/chat/team-transcript.ts`，以及变薄的 `hooks/chat/use-team-chat.ts` 适配器。

有两处实现推翻了计划。上下文名单仍然只观察用户消息，因为成员自己的回复已经在声明侧，再观察一遍没有增益。伴随端投影从成员事件加一小段空闲宽限来推导房间的忙碌状态，而不是让宿主再发布一条状态帧，因为这些事件本来就在线上。

## 实现更新（2026-09-10，批次 2）

已落地，每一项都带着自己的界面和测试，这一批没有休眠项：

- 消息行上的 `metadata.replyTo` 与 `metadata.reactions`，类型在 `packages/agent-config-types/src/message-room-primitives.ts`。两者都放在 `metadata` 下而不是作为列：这张行有两个手写的构造函数和一份提升字段清单，接线时发现 `collaboration` 列在每次持久化时都被两者丢掉，伴随端回合上房间运行器盖的作者章因此丢失。已在 `lib/db/messages.ts` 修正。
- 回复：消息行上的动作把目标暂存到指定面板（`stores/chat` 的 `replyTo`），组合器把它作为回合元数据带出，一个辅助函数（`lib/chat/turn-metadata.ts`）把它映射进每个宿主的发送选项。直聊控制器和房间运行器在行上盖章，并把引用作为提示前的一行读给模型，从不混进用户输入的文字。`room_send` 的请求 schema 携带它。连接器运行时把入站 IM 回复的父消息保存为同一种引用。
- 表情回应：`lib/chat/reactions.ts` 通过 `setMessageReaction`（在事务内重读）切换行上的记录，并在 `local` 写入路由上镜像到平台。总线把入站表情事件落到行上（`lib/connectors/reactions-inbound.ts`）。在伴随端选择器禁用并说明原因，因为行属于宿主。
- 状态字符串：`lib/chat/room/member-activity.ts` 从成员自己的转录切片推导它正在用的工具，运行器通过 `members.setActivity` 接收器发布并带 90 秒过期，UI store 与 `memberStatus` 并列保存，成员面板和参与者徽章显示它，无头 `room://member-status` 帧携带它。
- 未读分隔线：外壳在标记已读前先捕获 `lastReadAt`（`lib/chat/unread-marker.ts`），列表在第一条更新的消息上方画线，发送即清除标记。
- IM 话题：平台话题本来就是独立的会话键。收件箱头部现在用一枚徽章说明这一点，并在所属频道也在本地时链接过去。没有新增话题实体。

有两处实现推翻了判断。计划把 `replyTo` 和 `reactions` 作为列放"在行上"，实际放到了 `metadata` 下，因为列必须同时穿过两个行构造函数和提升清单，`collaboration` 列证明了这条路容易漏。另外转录现在把表情回应读成不带主体 id 的计数，agent 能看到某条回复被点赞，却不会拿到是谁点的。

## 实现更新（2026-09-10，批次 3）

已落地，每一项都带着自己的界面和测试：

- **路由读取房间设置。** `routeTurn` 接收房间的 `mutedMemberIds`、`replyMode` 与组合器的 `explicitTargetIds`（`lib/claude/team-router.ts`）。优先级自上而下：`asleep` 不回复任何人；组合器的选择、然后是 `@`，精确到达这些成员（不论是否静音，因为两者都是用户的主动行为）；`mention_only` 之外不回复；最后团队自己的策略只在未静音的成员中运行。`holdReasonFor` 说明空结果为何是沉默，运行器保存回合并回到空闲。批次 1 的 `data-inert` 标记和设置里的说明已移除；回复模式按钮下方的提示说明每种模式的效果，静音列表下方的提示说明静音不影响什么。
- **手动成员选择器。** 组合器能力栏里的按钮打开成员名单勾选（`components/chat/composer/room-target-picker.tsx`），选择是 `stores/chat/room-target-store.ts` 里按会话保持的状态，作为 `ComposerTurnMetadata.targetMemberIds` 随每次发送带出，并以 `room_send.targetMemberIds` 到达宿主。上下文行里的芯片显示选择，没有选择时说明房间为何可能保持安静（休眠、仅 @ 时回复、手动团队且未选人）。
- **`Team.replyConcurrency`。** `parallel` 让一轮里的所有成员基于同一份记录同时开始，建立在批次 1 为此准备的按子会话键控的流式状态上。`sequential`（缺省，所有旧行）行为不变。
- **按成员中断。** `RoomRunner.stopMember` 中断某一成员正在进行的子会话，保留其部分回复，让本轮继续。消息头部在成员正在书写的回复上显示停止按钮，依据的是成员的实时状态而不是行的流式标记，因此两个同时回复的成员各有各的按钮。伴随端走 `room_stop { sessionId, characterId }`。
- **`TeamMember` 上的 `handoffTargets` 与 `talkativeness`。** `planAutoRound` 丢弃发言者声明目标之外的交接（缺省为任何人，`[]` 为没有人，提示词会告诉成员是哪一种），绝不把发言权交给已静音的成员，并让没被点名的成员按其 talkativeness 掷骰后每轮最多插话一次，掷骰通过注入的 `random` 完成以便测试确定。只有真正的交接被截断时才报告轮次耗尽，健谈成员用完轮次不算。团队编辑器的成员覆盖卡上有这两个字段，写入时校验（目标必须是队友，且不能是自己）。
- **粘性应答者。** `stickyResponderOf` 找出仍是候选的上一位发言成员。智能主答路由被告知除非另一成员明显更合适否则保留它；没有工具模型时它是确定性的回退（其后是最健谈的成员，再是首位声明的成员）。
- **让位给正在输入的人。** 组合器在团队房间记录每次按键（`stores/chat/composer-typing-store.ts`）。运行器在自动轮次前等待，只要最近一次按键不足 4 秒，最多等 20 秒；一旦有排队的引导或房间被停止则完全退让。无头大脑没有按键信号，因此从不等待。
- **IM 平面上的 `replyMode`。** `admitConversationEvent` 读取已绑定会话的回复模式：`asleep` 以 `room_asleep` 拒绝（与其他策略拦截一样审计），`mention_only` 强制 `mention_each`，`auto` 遵从运营者的策略。

有三处实现推翻了判断。上文映射表写着 IM 平面上 `auto` 映射为 `always`，实际映射为"按配置"，因为一个覆盖所有运营者激活策略的默认值会在设置出现的那一刻改变每个群的行为。停止令牌和按成员上限保持不变，但轮次耗尽的报告变成有条件的：健谈成员用完轮次不是被打断的对话。按成员停止不得不成为运行器方法而不是 store 标记，因为原有标记只在成员开始前读取，永远够不到正在回复的成员。

