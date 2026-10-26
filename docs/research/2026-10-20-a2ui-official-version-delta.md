# A2UI 官方版本校对与 Cognia 兼容边界

日期：2026-10-20，Asia/Shanghai。范围：研究官方协议、schema 和 Cognia 现有协议边界；不修改产品代码、依赖或现有数据。

## 结论

Cognia 可以继续加强自己的 renderer、编辑器和组件体系，同时增加明确的官方协议兼容层。当前准确的目标应当是 **A2UI v0.9.1 稳定兼容 + v1.0 Candidate 独立实验入口**，而不是把现有自定义格式的版本号改为最新值。官方协议并不要求更换为某个 renderer，也不要求将全部 shadcn 原语一一暴露给模型。[官方 v0.9.1 状态](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/README.md)、[v1.0 状态](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/README.md)、[Catalog 及 renderer 定义](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/a2ui_protocol.md)

本次固定的上游源码为 `a2ui-project/a2ui@ba4c47baba5663037217f107d5bcc51f6d35c536`，提交时间 `2026-10-20T05:42:47+08:00`。只读浅克隆位于 `/tmp/cognia-a2ui-official-20261020-audit`。以下技术结论以这个提交中的具体 schema 和规范正文为准，不把首页摘要当作完整协议契约。

## 1. 版本与发布状态

| 名称                                              | 官方定位                                | 对本项目的含义                                               |
| ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| v0.8                                              | Legacy                                  | 可按用户数据来源决定是否兼容，无须因为支持最新版本而自动支持 |
| v0.9                                              | Previous Stable                         | 现有 Cognia 类型文件标注基于此版本，但 wire 格式有实质差异   |
| v0.9.1                                            | Current production release；规范 closed | 应作为首个正式互操作目标                                     |
| v1.0                                              | Candidate，原名 v0.10 draft             | 可跟踪和实验；不能称为当前生产稳定版                         |
| Python `a2ui-core` 0.4.0 / `a2ui-agent-sdk` 0.9.0 | 独立 SDK 软件包版本                     | 不能据此推断 A2UI 协议版本                                   |
| Cognia `A2UI_BRIDGE_VERSION = "0.9.0"`            | 本地 MCP bridge 软件版本                | 不等于官方 v0.9 协议兼容认证                                 |

状态来源：[官方首页](https://a2ui.org/)、[v0.9.1 README](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/README.md)、[v1.0 README](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/README.md)、[Python releases](https://github.com/a2ui-project/a2ui/releases)。Cognia 来源：`lib/a2ui/mcp-tool-schemas.ts:17`。

`git ls-remote` 在本次检查中列出了协议 tag `v0.8`、`v0.9`，以及独立的 Python package tags；没有列出协议 `v0.9.1` 或 `v1.0` tag。因此“当前生产规范”与“是否存在同名 Git release/tag”必须分别陈述，不能仅按 tag 判断最新规范。建议 vendored schema 固定 commit 并记录内容 hash。

### 文档存在不一致，不能照抄示例

1. 首页将 v1.0 概括为 `actionResponse`、action IDs、`theme → surfaceProperties`。固定提交的 `agent_to_renderer.json`、`renderer_to_agent.json`、`common_types.json` 实际使用 `callRendererFunction` / `rendererFunctionResponse` 和 `callAgentFunction` / `agentFunctionResponse`；`theme` 已移除，未声明 `surfaceProperties`。应使用后者作为实现依据。[首页](https://a2ui.org/)、[v1.0 envelope schema](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/agent_to_renderer.json)、[renderer-to-agent schema](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/renderer_to_agent.json)
2. v0.9.1 A2A 文档示例给 capabilities 使用 `v0.9.1` key，但同目录 `client_capabilities.json` 仍要求 `v0.9` key；其 `$id` 和 Basic Catalog 的 `catalogId` 也保留 `v0_9`。应固定并测试与实际对端约定的能力对象，不自行把所有 URL/key 替换成 `v0_9_1`。[A2A 规范](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/docs/a2ui_extension_specification.md)、[capabilities schema](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/json/client_capabilities.json)、[Basic Catalog](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/catalogs/basic/catalog.json)
3. v1.0 仍有表述张力：正文/schema 描述保留 renderer lifetime 唯一 surface ID，同时明确禁止的是未 delete 就重复 create。实验实现宜使用 session/owner 命名空间加新的唯一 ID，稳定 v0.9.1 则按 active surfaces 唯一处理；不要依赖 candidate 的 ID 回收歧义。[v1.0 lifecycle](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/a2ui_protocol.md)、[v0.9.1 evolution](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/docs/evolution_guide.md)

## 2. v0.9 → v0.9.1 的实际变化很小

官方 evolution guide 明确限定两点：统一 MIME 为 `application/a2ui+json`，替换旧 `application/json+a2ui`；surfaceId 从 renderer 生命周期全局唯一放宽为当前活动 surface 唯一，重复 create 前仍须 delete。v0.9.1 消息 schema 同时接受 `version: "v0.9"` 和 `"v0.9.1"`。[演进说明](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/docs/evolution_guide.md)

这次升级本身没有让 Cognia 现有格式突然兼容。Cognia 缺的是此前就存在的官方 envelope、catalog 和运行语义，而不仅是这两个新变化。

## 3. wire 与运行语义对照

| 范畴               | 官方 v0.9.1                                                                                                                                      | 官方 v1.0 Candidate                                                                                | Cognia 当前需要考虑的边界                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 消息 envelope      | `{version, createSurface: {...}}` 等四种操作，单消息恰好一种操作                                                                                 | 四种操作 + `callRendererFunction`、`agentFunctionResponse`                                         | 当前 `{type, surfaceId, ...}`；不能靠改名兼容                                         |
| create             | 必须 `surfaceId`、`catalogId`；支持 `theme`、`sendDataModel`                                                                                     | `catalogId` 可省；可一次传 `components`、`dataModel`、`metadata`；没有 `theme`                     | 当前有 `surfaceType`、`title`、widget 等宿主扩展，须单独保留                          |
| 生命周期           | create 在先；`root` 到达后可逐步渲染；允许未到达的 child/data 引用                                                                               | 隐式不可修改的 `Surface.child = root`；结束 turn 由 transport 发信号                               | 当前 `surfaceReady` 是私有消息，官方两个版本均不接受                                  |
| updateComponents   | 通过 ID 增加或更新组件，不应抹掉本批未出现的已有组件                                                                                             | 同样保留渐进构建；增加跨 catalog 和组合约束                                                        | MCP 描述当前写 `Replace the components tree`，应与实际语义和官方入口区分              |
| updateDataModel    | `path + value` 替换指定节点；省略 path 或 `/` 表示根；省略 value 删除；null 是值                                                                 | value 必填，`null` 删除 key；省略 value 非法                                                       | 当前 `data: object + merge`，不能无损表达全部官方操作                                 |
| data binding       | `{path: "/x"}`，支持 collection 内相对路径和双向输入绑定                                                                                         | 动态 directive 为 `{@path: "/x"}`；模板 `children.path` 与消息 `path` 仍不加 `@`                   | 需要解析层按版本识别，不能全局文本替换                                                |
| functions          | `{call, args, returnType}`；支持格式化、验证、布尔组合、openUrl                                                                                  | `{@call, catalogId?, args}`；returnType/allowedCallers 在 catalog；增加 `@index`                   | 现有 TS dynamic types 主要是 literal/path，不能仅将 function object 原样交给 renderer |
| actions            | 组件 `{event: {name, context}}` 或 `{functionCall: ...}`；向 agent 发送 `{version, action:{name,surfaceId,sourceComponentId,timestamp,context}}` | 增加 `userMessage`、metadata、双向函数 RPC                                                         | 当前 `Button.action: string`、`userAction`、毫秒 timestamp 需明确转换                 |
| checks             | `{condition: DynamicBoolean, message}`，message 必填                                                                                             | condition 是 binding/function；可返回 ValidationResult；message 可省                               | 控件属性验证不等于协议通用 checks evaluator                                           |
| catalog resolution | 单 surface 固定 catalog                                                                                                                          | component/function 显式 catalog 优先，其次 surface 默认；都无则报错，不能从 advertised catalogs 猜 | 不能在官方入口沿用“未知 catalog 回退 Cognia 默认”的行为                               |
| accessibility      | common accessibility label/description                                                                                                           | 增加 live/hidden，要求映射原生可访问性 API                                                         | shadcn primitive 有默认语义仍不等于协议属性已被透传                                   |

官方来源：[v0.9.1 envelope](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/json/server_to_client.json)、[v0.9.1 common types](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/json/common_types.json)、[v0.9.1 actions/errors](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/json/client_to_server.json)、[v1.0 common types](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/common_types.json)、[v1.0 evolution](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/evolution_guide.md)。本地来源：`types/a2ui/schema.ts:122`、`:157`、`:756`、`:777`、`:855`；`lib/a2ui/parser.ts:97`；`lib/a2ui/mcp-tool-schemas.ts:82`；`lib/a2ui/catalog.ts:157`。

### v1.0 函数执行边界必须连同运行时实现

`callRendererFunction` 要求 `functionCallId` 和显式 `callFunction.catalogId`。即使函数返回 void，也要返回对应 `rendererFunctionResponse`。没有 surfaceId 时必须在独立空数据模型执行，不能借用任一已有 surface。顺序到达的同步 surface 操作须先于后续 RPC 生效，而异步函数不得阻塞后续 envelope。[RPC 规范正文](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/a2ui_protocol.md)

可信 catalog 定义的 `allowedCallers` 决定谁可调用，默认 `rendererOnly`。`requiresUserActivation: true` 的函数只能在真实用户交互中执行，不能通过 agent RPC、被动属性计算或 checks 触发。执行时检查注册、参数、调用方、用户激活和返回类型；不能信任模型在消息中自报权限。`openUrl` 是必须遵守用户激活的例子。未知本地函数转向 agent RPC 是 v1.0 规范中的行为，接入前仍要有明确 catalog、工具权限及出站数据治理。[函数与 catalog 定义](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/catalog_definition.json)、[Basic Catalog 函数](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/catalogs/basic/v1/catalog.json)

因此不建议将 v1.0 RPC 与 v0.9.1 envelope 接收一起作为首个小修复。它增加了独立的调用生命周期、loading/error、关联 ID、超时和执行权限边界。

## 4. 官方组件目录并不是 shadcn 目录

固定提交中的 v0.9.1 与 v1.0 Basic Catalog 都有 **18 个组件**：`Text`、`Image`、`Icon`、`Video`、`AudioPlayer`、`Row`、`Column`、`List`、`Card`、`Tabs`、`Modal`、`Divider`、`Button`、`TextField`、`CheckBox`、`ChoicePicker`、`Slider`、`DateTimeInput`。两者都有 **14 个 catalog 函数**：`required`、`regex`、`length`、`numeric`、`email`、`formatString`、`formatNumber`、`formatCurrency`、`formatDate`、`pluralize`、`openUrl`、`and`、`or`、`not`；v1.0 另有协议内置 `@index`，不属于这 14 个 catalog 条目。[v0.9.1 Basic Catalog](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/catalogs/basic/catalog.json)、[v1.0 Basic Catalog](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/catalogs/basic/v1/catalog.json)、[内置 @index](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/common_types.json)

官方鼓励生产应用定义自己的 catalog。Cognia 的 `cognia-standard-v1` 和额外图表、表格、学术组件可以保留；它们不因为不在 Basic Catalog 中就“不合规”，前提是 catalog 契约、schema 和协商真实成立。相反，同名组件存在也不代表兼容：[Catalog 规范](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/a2ui_protocol.md)、本地 `lib/a2ui/catalog.ts:19`。

| 官方 API                                                 | 当前 Cognia API                      | 不能省略的适配                                                           |
| -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Button `child` + action object                           | Button `text` + action string        | 子组件结构、动态文案、event context、local function 不能用字符串改名解决 |
| Card `child`                                             | Card `children` 等 Cognia 结构       | 单 child / wrapper 结构转换                                              |
| CheckBox `value`                                         | Checkbox `checked`                   | 大小写、字段、双向绑定                                                   |
| ChoicePicker `value` 为字符串数组，variant 区分多选/互斥 | Select/RadioGroup 等                 | scalar/array、交互和回写契约                                             |
| DateTimeInput                                            | DatePicker/TimePicker/DateTimePicker | variant/日期时间表示/回写格式                                            |
| Modal                                                    | Dialog                               | trigger/content 引用和打开状态行为                                       |
| Text `h1` 等 variant                                     | Text `heading1` 等                   | 视觉语义映射                                                             |

适配应先覆盖真实生成路径需要的协议组件，再由宿主选择 shadcn 组合。不能将“仓库所有 shadcn 文件数量”作为官方 A2UI 完整性的分母。shadcn 全量能力覆盖是另一条本地产品审计轴。

## 5. 建议的兼容架构

```text
legacy Cognia messages ─ legacy validator ────────────┐
official v0.9/v0.9.1 ─ envelope + negotiated catalog ─┼─ normalized operations ─ existing surface runtime
official v1.0 ─ gated candidate adapter ──────────────┘                         + catalog components
```

必须区分三件事：wire 协议版本、组件 catalog 版本、Cognia 持久化格式版本。建议每个存储 surface/消息记录原始协议、catalog ID、adapter revision 和必要的原始 payload；没有标记的已有数据一律按 legacy 处理，不能用 `{path}` / `{call}` 形状猜版本。

内部操作需要能表达 `create`、component upsert、`replaceDataAtPath`、`deleteDataAtPath`、delete surface，以及本地 transport completion。仅把官方 `updateDataModel` 映射成当前 object merge 会改变替换、数组、scalar、删除和 null 语义，应扩展内部操作或实现严格的操作执行层。不要把 v1.0 的 null-delete 应用到旧 Cognia 或 v0.9.1 数据。

catalog 边界有两条可并行但必须区分的路线：

- **官方 wire + Cognia catalog**：先让官方 envelope 携带明确协商的 Cognia catalog，复用现有组件。只有 schema/动态求值/动作契约也符合对应版本，才可以宣称这种组合可互操作。
- **官方 Basic Catalog**：建立 18 个官方 API wrapper；可用现有 shadcn primitives 和 Cognia 组件实现，但不能将官方 ID 偷换成 Cognia 默认 catalog 然后静默渲染。

能力交换使用 transport metadata / initialization，不是另造一种 A2UI 消息。v0.9.1 重点是 `a2uiClientCapabilities` 和标准 MIME；v1.0 改为 `a2uiRendererCapabilities`、agent capabilities schema/AgentCard 相关约定以及同版本可混用 catalogs。没有共同版本/组件目录时应报告明确不支持，保留文本或既有受控 fallback，不能假装已接受。A2A 特定 URI/header 只在实际使用 A2A 时必要，MCP 工具调用不因此必须迁移 transport。[v0.9.1 A2A extension](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v0_9_1/docs/a2ui_extension_specification.md)、[v1.0 capabilities](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/json/renderer_capabilities.json)、[v1.0 transport/core](https://github.com/a2ui-project/a2ui/blob/ba4c47baba5663037217f107d5bcc51f6d35c536/specification/v1_0/docs/a2ui_protocol.md)

## 6. 优先级

| 优先级         | 范围                                                                                | 完成判据                                                                             |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 必须先做       | 将现有 dialect 明确命名为 Cognia legacy；去除“与官方 v0.9 相同”的误导               | 文档、MCP 描述、prompt、版本元数据口径一致，旧保存数据继续回放                       |
| 必须先做       | 所有入口使用同一严格 parse/validate/normalize 边界                                  | fenced JSON/JSONL、MCP、外部 agent dispatch 行为一致；非法输入不进入 store           |
| 必须先做       | v0.9.1 envelope、JSON Pointer 操作和 catalog 契约                                   | 官方 fixtures、替换/删除/null/数组/转义路径、动作回程通过                            |
| 必须先做       | 渐进消息生命周期与错误回馈                                                          | root/child/data 分批到达可见；中断、重复 create、未知 surface 有稳定状态和结构化错误 |
| 随正式支持推进 | Basic Catalog wrappers、checks、函数白名单、accessibility                           | 对外只广告真实支持的 catalog；未实现语义明确报错                                     |
| 可选实验       | v1.0 @directives、mixable catalogs、inline create、ValidationResult                 | 独立版本 fixture，不能影响 legacy/null semantics                                     |
| 独立工程       | v1.0 双向 RPC、异步校验和动态远程值                                                 | 关联 ID、超时、取消、权限、loading/error、出站数据治理全链路验收                     |
| 当前不必要     | 为升级协议重写编辑器或替换全部 renderer；暴露全部 shadcn 原语；迁移为 A2A transport | 只有具体产品需求才引入，不属于协议兼容的前置要求                                     |

本次对 `lib/a2ui/acp-bridge.ts` 的源码检查还发现其使用的 type guards 只看 `type`，而不是调用 `parseA2UIMessage` 完成字段校验；这属于入口统一校验的独立修复点，不能用接入新版协议替代它。具体影响由本地核心审计继续验证。

## 7. 已运行的 schema 探针

使用仓库已安装的 Ajv `8.20.0`、2020-12 evaluator，只读载入上游 schema/basic catalog；未安装依赖、未运行上游脚本。每个版本独立 Ajv 实例，把 envelope 的 `catalog.json` placeholder 映射到相应 Basic Catalog，并为 v1.0 catalog 的相对 `common_types.json` 注册同一 common schema alias。`strict: false` 允许上游 annotations，`validateFormats: false`；本探针不声称验证 ISO 日期格式或任何运行状态机。

| payload（surfaceId 均为 `s`，版本按列填写）                | v0.9.1 | v1.0                                   |
| ---------------------------------------------------------- | ------ | -------------------------------------- |
| create + 正确 catalogId                                    | 接受   | 接受                                   |
| create 不含 catalogId                                      | 拒绝   | 接受；后续仍要按运行时解析 catalog     |
| create 携带初始 Text components + dataModel                | 拒绝   | 接受                                   |
| create 携带 `theme.primaryColor`                           | 接受   | 拒绝                                   |
| updateComponents + literal Text                            | 接受   | 接受                                   |
| Text.text 为 `{path:"/name"}`                              | 接受   | 拒绝                                   |
| Text.text 为 `{"@path":"/name"}`                           | 拒绝   | 接受                                   |
| updateDataModel 指定 path，省略 value                      | 接受   | 拒绝                                   |
| updateDataModel 指定 path，value 为 null                   | 接受   | 接受；删除语义不同                     |
| Cognia `{type:"createSurface", surfaceType:"inline", ...}` | 拒绝   | 拒绝                                   |
| 官方 envelope 带 `surfaceReady`                            | 拒绝   | 拒绝                                   |
| updateDataModel 根节点 value 为 null                       | 接受   | 接受；不代表根删除运行行为已定义并验收 |

共 **24 次 schema 判定，全部符合上表预期**。这是上游 schema 验证结果，不是 Cognia 已实现/已通过这些案例的声明。

复现核心载入方式（从仓库根目录执行，`auditRoot` 指向上述固定提交的 checkout）：

```js
const fs = require("node:fs")
const Ajv2020 = require("ajv/dist/2020").default
const auditRoot = "/tmp/cognia-a2ui-official-20261020-audit"
const load = (path) => JSON.parse(fs.readFileSync(`${auditRoot}/${path}`, "utf8"))

for (const version of ["v0_9_1", "v1_0"]) {
  const prefix = `specification/${version}/json`
  const common = load(`${prefix}/common_types.json`)
  const catalog = load(
    version === "v1_0"
      ? "catalogs/basic/v1/catalog.json"
      : "specification/v0_9_1/catalogs/basic/catalog.json"
  )
  const envelope = load(
    `${prefix}/${version === "v1_0" ? "agent_to_renderer.json" : "server_to_client.json"}`
  )
  const ajv = new Ajv2020({ strict: false, validateFormats: false })
  ajv.addSchema(common)
  ajv.addSchema(catalog, new URL("catalog.json", envelope.$id).href)
  if (version === "v1_0") {
    ajv.addSchema(common, new URL("common_types.json", catalog.$id).href)
  }
  const validate = ajv.compile(envelope)
  const wireVersion = version === "v1_0" ? "v1.0" : "v0.9.1"
  console.log(
    version,
    validate({
      version: wireVersion,
      createSurface: { surfaceId: "s", catalogId: catalog.catalogId },
    })
  )
}
```

### 后续实现必须补的行为 fixture

这些是验收建议，**本次没有执行**：

- 生命周期：create 后 root 延迟、child 延迟、data 延迟；重复 create；未知 surface 更新；delete 后迟到消息；断流/重连/replay；并发 owner 的同名 surface。
- 数据：根替换、子对象整体替换保留 sibling、数组索引、`~0`/`~1` 转义、相对模板 scope、禁止 prototype 污染；v0.9.1 省略 value 删除与 null 保留；v1.0 null 删除和缺 value 拒绝。
- 目录：已知/未知 catalog、支持列表协商、错版本 catalog、同名异 API；官方 Basic Button/ChoicePicker/Modal/TextField 的真实交互、双向回写、action context 和 ISO timestamp。
- 动态：`required/email/regex/and/formatString`、binding 缺值、检查失败禁用按钮、循环/深度/计算预算、远程调用阻断；v1.0 `@index` 仅模板内有效、literal `@@` 转义、普通 data 的 path/call 不被误执行。
- 安全：未注册函数、错 allowedCallers、无用户激活的 openUrl、未授权跨 surface、dataModel 同步只发给所属 agent；模型不能经 inline catalog 注入执行代码或提升权限。
- 回归：已有 Mini Apps/编辑器/历史/IM/workflow/custom plugin catalog 回放；解析器支持新版不应改变旧消息语义。

## 8. 验证范围和限制

已完成：当前官方站点与固定上游源码核对；v0.9.1/v1.0 schema 和 Basic Catalog 对照；Cognia 指定类型/parser/MCP/ACP 边界源码检查；24 次上游 schema 探针。没有运行 Cognia 全量测试、真实模型、浏览器/Tauri、真实 A2A/MCP 对端互操作或候选版 RPC。报告中的改造路径是建议，不是已交付实现。
