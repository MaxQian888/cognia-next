---
title: "0167 - 日程属于账户"
description: "定时任务用的是一个机器级、未加密、不在数据治理和备份范围内的独立数据库；它的权限策略执行函数零调用；agent 能碰到的只有三个受 IM 门控的 MCP 工具。三件事同一个根因：日程一直被当成机器的资产，而不是账户的。"
---

# ADR 0167 - 日程属于账户

**状态：** 已接受
**日期：** 2026-09-04
**相关：** [ADR-0002](./0002-scheduler-agent-tool-resolution)、[ADR-0026](./0026-marketplace-integrations)、[ADR-0079](./0079-scheduler-extension-contract)、[ADR-0128](./0128-host-neutral-scheduler)

## 背景

关于定时任务的三条抱怨，最后指向同一个根因。

**数据不属于账户。** `lib/scheduler/scheduler-db.ts` 打开的是一个固定命名、没有账户维度的 Dexie 库 `CogniaSchedulerDB`。主库有的四样它一样都没有，而且缺失的原因是同一个。它不按账户派生库名，所以切换账户看到的是同一批定时任务。它没有挂 `createEncryptedContentMiddleware`，所以 prompt、目标描述、webhook URL 和 IM 会话目标都明文落盘，而同类内容在聊天消息里是加密的。它不在 `CORE_TABLE_NAMES` 里，`policyForTable` 对它返回 undefined，保留、同步、清理策略全部绕过它。`lib/data/build-package.ts` 里一次都没提过它，所以备份和导出静默丢掉用户配置过的每一条日程。

`SchedulerPermissionPolicy` 更糟：它经由 store 的 zustand persist 落在 **localStorage**。一条关于「agent 可以代你做什么」的规则，被存进了属于浏览器配置文件、而不是属于这个人的地方。

**策略是摆设。** `agentAutoCreate`、`confirmationRequired`、`maxTasksPerSource`、`scriptTasksEnabled` 在设置页可改、也持久化了。而读取它们的 `useSchedulerStore.checkPermission` 在整个仓库里零调用。它还带着测试，这是更坏的一种失败：一条没有执行的策略看起来是被验证过的。函数内部的按来源计数写的是 `get().tasks.filter(() => true).length`，后面跟着一句「尚无按来源追踪」的注释，尽管 `createdBy` 从 scheduler schema v3 就存在了。

在这个空档里，另外两条写入路径各自做了安排。`lib/external-bridge/handlers/scheduling.ts` 的 agent 工具硬编码了每会话 8 个的配额，任何设置都够不到它。`lib/plugin/api/scheduler-tasks.ts` 在文档注释里告诉插件作者「必须先查询策略」，然后没有做任何事让这句话成真。

**agent 几乎够不到日程。** 那三个 MCP 工具就是全部的 agent 面，并且在 `lib/claude/build-options.ts` 里被门在 `imOverrideRow?.allowScheduleTools === true` 加上一个 IM 适配器能力之后。桌面聊天里一个工具都没有，所以「每天早上提醒我」是助手可以聊、但做不了的事。就算在 IM 里，这些工具也只能建两种任务类型、两种触发形状，且无法查看、修改、暂停或运行任何东西。

与此同时，调度器早已为产品里每一种 agent 运行准备好了 executor：`chat`、`agent`、`skill`、`external-agent`、`agent-team`、`goal`、`plan`、`workflow`。能力是建好的，只是没有东西能提出请求。

## 决策

### 1. 两张表并入账户数据库

Schema v219 在 `CURRENT_SCHEMA` 中声明 `scheduledTasks` 和 `scheduledTaskRuns`。加前缀命名，是因为在两百张表的库里 `tasks` 和 `executions` 太含糊。

两个反范式化的判别字段随行。`eventType` 本来就有。`createdBySource` 是新增的，而且是必需而非便利：并库后 `createdBy` 落在加密载荷里，不带这一列就无法在每次 agent 写入时回答按来源的配额，除非解密每一行。

加密与索引不冲突。`lib/db/encrypted-content-middleware.ts` 把每个被索引的字段根留在明文 metadata 中、其余整体加密，所以 `[status+nextRunAt]` 及其同类仍然可查，而载荷不可。

**宿主放置未变。** ADR-0128 决策 6 说每个宿主拥有自己的日程、任务不在宿主之间传递。那是关于放置的陈述，而账户库仍然是宿主本地的。`scheduler-host-target.ts` 依旧通过 `scheduled_task_*` RPC 把客户端路由到配对宿主。账户隔离与宿主放置是两条正交的轴，本 ADR 只动第一条。

`SchedulerDatabase` 作为门面保留，调用点的方法面不变；但它刻意不再是 Dexie 子类：两个表 getter 是私有的，任何需要裸 Dexie 行为的代码都必须在那个模块里提出请求。这条约束立刻暴露出四处越过方法面的调用方，包括 `lib/boot/startup-probe.ts` 直接读 `.tasks`，以及 `cli/src/serve/durability.ts` 把调度器当成第二个具名数据库连同它自己的 flush 钩子一起注册。

### 2. 旧库只收编一次，并且说清楚去了哪里

`lib/scheduler/legacy-db-migration.ts` 在调度器初始化时、任何东西读取日程之前运行。模块里写明、运行时也记日志的诚实限制是：旧库说不出它的行属于哪个账户，因为它从来不知道。这些行会进入升级后第一个活跃的账户，日志会写出是哪一个，这样有多个账户的用户可以把不属于这里的挪走。逐行猜测会更糟。

读不出来的旧库会被原样保留、且不标记完成。里面的行是用户唯一的副本，修好的版本必须还能再试一次。

### 3. 每一条非用户写入都过策略

`lib/scheduler/write-authority.ts` 是唯一的闸门，store、内置技能、MCP 工具和插件 API 全部调用它。它在检查时读 `AppSettings` 而不是 store 快照，这样长时间打开的标签页不会执行一条用户后来收紧过的策略，也让它在没有挂载 store 的无头宿主上照样工作。按来源计数走 `[createdBySource+status]` 索引。

两个顺序是承重的。

宿主闸门先跑。对一个本机根本跑不了的任务类型说「配额已满」，是一个会把 agent 引向错误修复方向的误导性回答。

`confirmationRequired` 在 `agentAutoCreate` 之前检查，因为两个设置回答的是不同的问题：一个是「他们能不能无人值守地做」，另一个是「哪些种类永远需要我」。顺序反过来，第二个列表就永远够不到，因为列表上的类型会在有人被询问之前就被拒绝。

没有确认界面的调用方把「需要确认」当作拒绝，并指向调度器面板。代替用户做决定，正是这个设置要防的事。

策略搬到 `AppSettings.schedulerPermissionPolicy`，在 settings-sync 目录里归为 `device-local`：日程是宿主自有的，所以管辖它的规则按宿主存放是正当的；手机在配对的桌面上建任务，会经由 RPC 对照桌面的策略检查。

### 4. Agent 拿到完整动词集，形式是内置技能

`lib/skills/built-in/scheduler/` 下的 `schedule.*` 技能族遵循 ADR-0026：`list`、`inspect`、`create`、`update`、`set_status`、`run_now`、`delete`。做成内置技能而不是再加几个 external-bridge 工具，是因为那一层已经自带 Zod schema、PII 闸、A2UI 确认卡、审计和按频道的 allowlist，而且 `buildBuiltInSkillManifest` 会把这一层暴露给非 IM 会话。最后这一点才是关键：它是桌面对话第一次能够触及日程的原因。

两处层级判定是刻意的。`run_now` 归为 `write`，尽管它本身不写任何行，因为它会引发任务的效果：`im-push` 任务会发消息，`background-command` 任务会执行命令。因为它不写行就归为 `read`，恰恰是对这个层级的错误理解。`delete` 归为 `destructive` 且需频道 opt-in，因为它是族里唯一不可逆的动词；用户说的是「停一下」或「暂停」时，技能族会把它导向 `set_status`。

三个旧工具保留名字和门控，因为已有 IM 会话是按它们配置的。它们刻意没有被放宽到与技能族对齐：两个覆盖面相同的写入面意味着要同步维护第二套 schema，而技能族本来就覆盖 IM。

## 后果

日程现在的行为和用户的其余数据一致：按账户隔离、静态加密、纳入治理、随备份导出，并在首次启动时从旧的机器级存储收编过来。

四个权限设置真的起作用了。关掉 agent 自动创建的用户，会拿到一条带理由的拒绝，而不是任务照样出现；按来源的上限也不再把用户自己的日程算进 agent 的额度里。

任何对话里的助手都可以把工作放上日程、并读回已有的内容，受两道独立的闸门约束。有一条需要明说，因为它是「已交付」和「够得到」之间的差别：内置技能只有在当前角色打开了 `enableBuiltInSkills` 时才会到达非 IM 会话。那是一个按角色的开关，不是按技能族的开关，所以对于关掉它的角色，这个技能族存在但用不上。

刻意没做：`monitor`、`backup`、`plugin`、`custom` 仍然使用原始 JSON 载荷编辑器。`monitor` 需要为一个条件联合类型做构建器，另外三个在别处有自己的编写界面；对其中任何一个做近似实现，都会比诚实的文本框更糟。

## 修订 2026-09-25：默认可达，确认即算数

上面那条附注其实就是问题本身：没有任何界面会设置 `enableBuiltInSkills`，所以在桌面端 `schedule.*` 技能族已交付却够不到。而在够得到的地方，默认策略（`agentAutoCreate: false`）会在用户已经在确认对话框里点了「确认」之后拒绝一个 `chat` 任务，因为闸门分不清有人值守和无人值守的写入。

**1. 定时任务技能族有自己的开关。** `SchedulerPermissionPolicy` 新增 `agentToolsEnabled`（默认开；在它出现之前保存的策略按「开」读取）。`resolveSendOptions` 只对上下文设置了 `interactiveChat` 的回合单独提供 `schedule.*` 技能族，并且只经由 `pluginTools`：也就是有人在本应用聊天面板里输入的回合，由实时聊天控制器通过 `buildSendOptions(…, { interactive: true })` 标记。定时运行、CLI、小队、评测、数字分身，以及从配对手机转发过来的回合都不设置：那里没人能回应桌面审批对话框，定时运行也不能给自己继续加日程。这些条目绝不会扩大一个空的允许列表（那会把「所有工具」变成「只有这九个」）；已被其他因素收窄的回合，则像其他技能一样把它们加进去。开关关闭时，这个技能族在任何模式下都会被剔除，旧的 IM 定时工具不再提供，`authorizeTaskWrite` 会以 `agent-tools-disabled` 拒绝任何 agent 写入，`list` / `inspect` 也拒绝读取。策略模块无法加载时按「关」处理。

**2. 人的确认满足「是否有人在」这类规则。** 技能分发器自己设置 `ctx.humanConfirmed`（调用方无法冒充）：点击了本次请求的桌面对话框，或 IM 确认卡回调之后为 true；记住的「本会话内允许」授权为 false。定时任务写入根本不提供这种授权（`suppressAlwaysAllowRule`），因为每一次写入之后都会在无人值守时运行。带 `humanConfirmed` 的 `authorizeTaskWrite` 会跳过 `agent-auto-create-disabled`，对 `confirmationRequired` 类型也不再二次询问；主机闸门、agent 开关、脚本开关和额度仍然生效。没有它时，仍需要人的判定就是拒绝，这也堵上了反方向的漏洞：关闭了写入确认的 IM 渠道，此前可以创建用户明确说过始终需要自己确认的 `goal` 和 `agent-team` 任务。`agentAutoCreate` 现在的含义就是它字面上说的：agent 能否无人值守地写入。

**3. 额度只计算来源拥有的任务。** `TaskWriteRequest.operation` 为 `"create"` 或 `"mutate"`；按来源的额度只约束创建，所以达到上限的 agent 仍然可以暂停、修改、运行或删除它放上去的任务。

**4. 拒绝发生在对话框之前。** `BuiltInSkill.preflight` 在 schema 和 PII 闸门之后、HITL 之前运行。定时任务技能用它运行调度器自己的触发器和载荷规范化（外加各执行器要求的字段），检查任务 id 是否指向真实任务，并按即将发生的确认去询问策略。用户不会再被要求批准一个注定失败的写入。
