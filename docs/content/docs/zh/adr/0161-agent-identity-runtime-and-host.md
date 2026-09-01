---
title: "0161：智能体、它的运行时、它的宿主，是三个问题"
description: "第一方运行时成为同一份目录里的普通一行，回合的运行时收敛为一个由会话持有的 AgentRuntimeRef，内置智能体定义合并为一份共享目录，而不是每个外壳各写一份。"
---

# ADR 0161：智能体、它的运行时、它的宿主，是三个问题

**状态：** 已接受
**日期：** 2026-09-01
**相关：** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)、[ADR-0117](./0117-composed-agent-modes-and-creator)、[ADR-0142](./0142-agent-sdk-two-layer-product)、[ADR-0077](./0077-tui-external-agent-hosting)

## 背景

产品把一条通道叫「内置 agent」，其余都叫「外部」。这两个词都没有描述真正的区别。

**内置通道是一种承载机制，不是一个智能体。** `AgentRuntime` 是
`"claude-sdk" | "external"`，而 `claude-sdk` 并不表示 Claude Agent SDK，它表示
「随附 Node sidecar 决定跑的东西」。sidecar 里有两个运行时
（`sidecar/dispatch/runtime-adapter.mjs`）：面向 Anthropic 的 `claude-agent-sdk`，
以及面向其他所有 provider 的 `ai-sdk`。哪一个承接本回合由
`runtimeFromLegacy`（`lib/ai/agent/execution/legacy-mapping.ts`）从 provider 推导，
从来不由那个 chip 决定。于是 DeepSeek 会话在运行时菜单、tooltip 和无障碍名称里
都读到「内置 Anthropic SDK sidecar」，而该 chip 在内置通道上只有图标，
这意味着错误的措辞是屏幕阅读器拿到的唯一措辞。

与此同时，同一家厂商、同一批模型的 Claude Code，被归在 18 个外部预设之一。
真正的分界是「由我们的 sidecar 拉起」对「由别的东西拉起」，
却挂着一个承诺「第一方对第三方」的标签。

**内置通道是唯一不在注册表里的通道。** 外部协议、外部预设、子智能体、
MCP 预设、钩子、团队、角色，全都是带插件叠加层的目录。内置运行时是一个封闭联合里的
字符串字面量，硬编码在 store、组合器 chip、工具条和发送路径里，
因此只有它无法被枚举、被描述、被查询能力、被报告健康度。

**三个字段回答同一个问题。** `runtime`、`externalAgentId`、`externalHostConfig`
分别持久化，可以描述出一条「有通道没有目标」的状态。那种状态发不出任何回合，
而组合器 chip 里大约 40 行修复副作用的存在，只是为了让三者彼此和解，
其中还包括一个回归：修复逻辑会在每次重启时把用户选中的插件后端智能体改写回默认值。

**通道是全局的，组合却是按会话的。** ADR-0117 把 `modeId` 移到会话上，
正是因为单一全局值会改变其他所有会话的目标，包括一个正在进行中的回合。
`runtime` 被留成了全局，并在发送时读取，这是同一个缺陷落在更大的那根轴上。

**内置智能体定义存在两份。** 应用侧有四个 `workflow-*` 子智能体，加上 `Explore`
与 `Plan`。CLI 侧有 `general-purpose`、`Explore` 与 `Plan`。两份 `Explore` 与
`Plan` 的提示词与工具集推导都不同，应用侧根本没有 `general-purpose`，
而且两个外壳对冲突的处理也不一致：CLI 允许发现到的智能体覆盖内置，
应用却把用户模板放进 `template:` 命名空间，因此覆盖不了。

## 决定

### 1. 三根轴，各自命名

| 轴 | 问题 | 归属 |
| --- | --- | --- |
| 身份 | 这是谁（名称、提示词、工具、模型角色） | 内置目录、插件子智能体、用户模板，统一投影为线上的 `AgentDefinition` |
| 运行时 | 由什么执行（进程加协议） | `AgentRuntimeRef` |
| 落位 | 跑在哪台机器上 | 沿用既有的 `executionTarget` 与 `SessionExecutionBinding`，不动 |

`TeammateExecutionBinding` 在下一层已经把运行时与落位分开了。主聊天会话一直没有
得到同样的处理，这次补上。

### 2. 第一方运行时是目录里的普通一行

`lib/ai/agent/runtime-catalog` 把每个运行时列为一个 `AgentRuntimeDescriptor`：
内置通道、每个本机配置的外部智能体、每个已配对宿主拥有的配置。要守住的规则是：
第一方运行时必须能用第三方运行时用的那条记录来描述。如果 `claude-agent-sdk`
不能和 `codex` 并排放进目录，那就是目录错了。

目录是纯函数。所有输入都由调用方传入，因此它不做任何外壳探测，
可以跑在快速测试工程里。React 侧的接线在
`hooks/agent/use-agent-runtime-catalog.ts`，只负责收集输入。

### 3. 内置那一行说出它推导出的引擎

描述符携带 `derivedAdapter`，走的是冻结执行规格用的同一个 `runtimeFromLegacy`，
因此标签不会和 dispatch 实际做的事漂移。只有为真时那一行才读作
「Anthropic Agent SDK，运行于随附 sidecar」，否则读作「AI SDK，运行 {provider}」。

内置通道仍然是一个可选项而不是两个，因为适配器是推导出来的，不是选出来的。
`AgentRuntimeRef` 仍然带一个可选的 `adapter` 钉选位，对齐
`TeammateExecutionBinding.runtimePolicy`，并且这个钉选位是**刻意休眠**发布的：
在类型上写明、任何界面都到不了、并由测试钉住。日后要让它生效是解析器的改动，
不是类型的改动。

### 4. 一个 ref，由会话持有

`AgentRuntimeRef` 是 `builtin`、`external:<agentId>`，或带准入戳的
`host:<configId>`。一个值让「有通道没有目标」无法被表达。持久化 v2 到 v3
会折叠那三个旧字段，在半途写入导致两者都有值时优先采用宿主戳，
并把 v2 的死状态落回默认通道而不是继续携带。扁平字段作为弃用镜像保留，
只由 `setRuntimeRef` 写入，因此尚未迁移的读者仍然看到真相，
降级安装也仍然开在正确的通道上。

这个 ref 会挪到 `AgentCompositionSelectionV1` 上，作为 `runtimeBindingRef`
真正的含义，而 store 只保留新会话的默认值。该字段目前还承载着导入会话的
外部智能体原生 session id，那是第三个互不相干的含义，会拿到自己的名字。

### 5. 一份内置智能体目录，两套工具词表

应用与 CLI 读同一份 `BuiltinAgentEntry` 清单，按 surface 打标签。工具策略以抽象方式
声明（`inherit`、`read-only`、显式白名单），由每个外壳按自己的词表解析，
于是一份目录服务两个工具面，而不必假装两者是同一份清单。

`general-purpose` 以 CLI 与 team 两个 surface 进入目录。本次改动不把它放进普通聊天：
应用侧本来就有至少六个可派发子智能体，`dispatch_agent` 从不会被扣下，
而给每一个聊天回合都加一个通用委派是需要单独决策的行为变更。

### 6. 优先级：内置可被替换，插件保持命名空间

内置 id 是裸的。插件 id 保持 `<pluginId>:<id>`，因为命名空间隔离是一条安全属性。
用户或项目模板可以占用一个裸 id 并遮蔽内置项，这是把 CLI 已有的规则扩展到应用，
也与同类智能体系统 `project > user > builtin` 的解析方式一致。

### 7.「内置」描述的是定义，不是运行时通道

这个词现在表示「随应用发布、且你可以替换的智能体定义」，
它不是某种承载机制的名字。运行时通道的用户可见文案，说的是 Cognia 自带运行时，
以及承接本回合的那个引擎。

### 8. 外部回合走冻结执行规格

`LegacyExecutionSignals.runtime` 已经存在，`runtimeFromLegacy` 也已经会回答
`"external"`。只是聊天从来没有把它传进去，于是外部回合完全绕开了 ADR-0090：
没有能力门、没有执行指纹、没有统一的成本与链路记账。聊天会把解析出的 ref 喂给
`resolveAgentExecutionSpec`。`ExternalAgentManager` 仍然是
`runtimeAdapter === "external"` 的执行者，规格成为它的契约，而不是它绕过的东西。

## 后果

- 组合器 chip 不再声称一个它并没有在跑的引擎，包括无障碍名称，
  那曾是它在默认通道上的唯一措辞。
- 一个运行时可以通过一条记录被描述、被拦截、被告警、被报告健康度，
  于是新增一条通道是加一行目录，而不是在四个文件里加第四个分支。
- 「外部但什么都没选」这个死状态无法被表达，为侦测它而存在的修复副作用随之消失。
- 在一个会话里切换运行时，不再改变其他会话的目标。
- `Explore` 与 `Plan` 不再是共用一个名字的两个不同智能体。
- 成本、链路与能力门覆盖到外部回合，此前它们什么都不上报。

## 备选方案

**只改标签，到此为止。** 这修好了那句话，没修好任何结构。通道仍然不可枚举，
三个字段仍然会互相矛盾，下一条运行时仍然是第四个分支。

**把内置适配器做成用户可选（两行）。** 那会造出一个解析器并不遵守的控件。
适配器由 provider 推导，提供一个 dispatch 会忽略的钉选，正是这个仓库反复踩到的
「建好却休眠」。这个钉选位留在类型里，休眠且带标注，直到有解析器遵守它。

**把五种智能体定义形状合并成一种。** 目录形状、创作形状与线上形状承担的职责
确实不同，而 SDK 的 `AgentDefinitionV1` 是 ADR-0142 下的另一个产品面。
真正错的是那些会静默丢字段的无名投影，不是形状多于一种这件事。
