---
title: "0240 — 生成的界面会流式呈现、会回应、会计算"
description: "Cognia 的 A2UI 早已具备 68 种组件、增量 Surface 更新、数据绑定和 IM 投影，但模型在聊天里写出的界面存在五个问题：流式输出时以原始 JSON 滚过；JSON 无效时直接消失；在桌面/Web 聊天里按下按钮无法回到智能体；无法声明派生值；URL 不经校验。本 ADR 保留现有 A2UI store 和渲染器，补上这五个缺口：惰性的流式预览、源码兜底、把手势动作路由到所在会话、用于计算值的封闭 JSON 表达式语言，以及与不可信聊天 Markdown 共用的 URL 策略。"
---

# ADR 0240 — 生成的界面会流式呈现、会回应、会计算

**状态：** 已接受
**日期：** 2026-10-24
**相关：** [ADR-0025](./0025-a2ui-im-bridge)（A2UI ⇄ IM 桥）、[ADR-0218](./0218-chat-reading-surface-links-blocks-and-charts)（流式代码围栏渲染器）、[ADR-0236](./0236-built-in-prompts-are-owned-slots-behind-one-prompt-center)（只读的 A2UI 协议提示词）
**证据：** `docs/evidence/2026-10-24-a2ui-adaptive-ui-gaps.md`、`docs/research/2026-10-20-a2ui-strengthening-audit.md`

## 背景

有一份对照 ChatGPT 灵动 UI 的分析，追问 Cognia 的 A2UI 还缺什么。缺口不在组件数量：目录里已有 68 种类型，store 按 id upsert 组件，数据模型通过 JSON Pointer 绑定，Surface 能投影成 IM 卡片。2026-10-20 的审计已经决定加强现有实现，而不是换成 OpenUI。2026-10-24 核对源码时，在“模型输出 → 可用的双向界面”这条路径上发现了五个真实缺口。

1. **流式期间只能看到原始 JSON。** Streamdown 的流式渲染器只覆盖 `mermaid` 和 `chart`。` ```a2ui ` 围栏会以代码块的形式流式显示，直到回合封存时，适配器才把它拆成 `a2ui` part。
2. **出错的围栏直接消失。** 负载没有生成 Surface 时，`A2UIPart` 返回 `null`，既没有占位，也没有源码。
3. **桌面/Web 聊天里的按钮到不了智能体。** IM 回调会开启新回合（`connector-callback-handler.ts`），TUI 也会把 `formatActionForAI` 发给它的智能体。但在 GUI 聊天中，`renderPart` 挂载 `A2UIPart` 时没有传处理函数，内置动作 provider 也没有传 `onAction`。`action-handlers.ts` 里的兜底分支（default、`submit`、`execute`）会丢掉所有不归迷你应用处理器管的动作。MCP 工具描述还声称“智能体会在下一回合收到 userAction 事件”，实际上没有任何代码这样做。
4. **计算值无法声明。** `data-model.ts` 里有 `resolveComputedFields` 和 `computedHelpers`，但没有调用方。`ComputedField` 里装的是 JavaScript 闭包，模型没有办法表达，协议里也没有对应字段。
5. **URL 没有校验。** `Link` 和 `Breadcrumb` 直接渲染模型写的 `href`；`Image`、`Avatar` 和 `Card` 会加载任意 `src`；学术检索结果用 `window.open` 打开 `pdfUrl`。聊天 Markdown 早有不可信 URL 策略，`ExternalLink` 的注释也写明 A2UI 应该复用它，但这些组件都没有用上。

## 决策

保留现有的 store、渲染器、持久化、编辑器和 IM 投影，在此基础上做以下改动。

### 流式预览，与封存后的 Surface 分开

新增 `a2ui` 围栏的流式渲染器（`components/chat/renderers/a2ui-streaming-fence.tsx`），由它解析已经写出的前缀（`lib/a2ui/streaming-preview.ts`）。解析遵循以下规则：

- **标量永不截断。** `completePartialJson` 回退到最后一个结构完整的值，再补齐此时尚未闭合的括号。写到一半的字符串、数字或键不会显示出来。对象可以只带部分键，所以组件的属性会随流式输出逐步出现；还没写出 `id` 和 `component` 的组件先不显示。
- **预览只负责绘制。** 只放行 `createSurface`、`updateComponents`、`dataModelUpdate` 和 `surfaceReady` 四种消息，全部改写到保留的 id 前缀（`a2ui-preview:`）下，并强制为 `inline`。
- **未写完的前缀只做增量。** 计算值声明要等围栏完整后才生效，因为操作数列表写到一半会算出错误的值。数据更新在围栏完整之前一律按合并处理，因为它的 `merge` 键可能还没写出来。
- **预览是惰性、临时的。** 预览以只读方式渲染在 `inert` 容器里，解析节流到每 120 ms 一次。封存后的 `a2ui` part 替换它时，预览即被删除。inline Surface 从不持久化，预览也一样；插件的 Surface 创建/销毁钩子会跳过这个前缀，解析器和 MCP 派发监听也拒绝模型写出的内容使用这个前缀。
- **预览有上限。** 嵌套超过 64 层的前缀不做预览，病态的围栏不会在每次节流解析时耗费开销。

负载没有生成 Surface 时，`A2UIPart` 改为显示围栏源码并附上提示，不再什么都不渲染。

### 手势动作回到所在会话

`lib/a2ui/chat-action-routing.ts` 是内置动作 provider 安装为 `onAction` 的兜底处理。它通过现有的 `sendChatMessage` 桥，把动作作为该会话的下一条用户消息发出，但必须同时满足以下条件：

- Surface 已绑定到某个会话。聊天中渲染的 Surface（`a2ui` part、定稿 Markdown 里的围栏，或携带 A2UI 的工具结果）绑定到渲染它的转录列表所属的会话（`TranscriptSessionProvider`），而不是当前聚焦的会话——分屏窗格、侧边对话和构建器转录都不一定是聚焦会话。不在列表中时，依次退回转录行自身的会话和聊天作用域。同一个 Surface id 在多处渲染时，最新的存活渲染接收点击；它释放后，点击交还给上一个渲染。迷你应用、编辑器、预览和模板库从不绑定。
- 组件是一次有意的手势操作：`Button`、`FormGroup` 或 `Link`。表格、图表、分页、标签页和数据变化都不会路由，它们的状态会随下一次手势操作的数据快照一起送达。
- 该动作不是连接器回放（那属于 IM 路径），也不是 1.5 秒内重复的同一手势。

内置迷你应用的动作名（`A2UI_LOCAL_ACTION_NAMES`，包括带数字的键盘、计时预设和记录类动作名）仍在本地处理，有测试把这份名单与处理器的 `switch` 对齐。`refresh` 和 `refresh_data` 原本只打日志，现在也会转发。

消息以控件的标签开头（上限 200 字符），后面跟一个 `a2ui-action` 围栏，内含 Surface id、组件 id 与类型、动作名、动作数据，以及 Surface 的数据模型。动作数据（表单的值）和数据模型各自上限 8000 字节，超出时只给出字节数。正在运行的回合会像对待手打文字一样，对它做 steer 或排队。发送失败时显示提示。

### 计算值是一门封闭的 JSON 表达式语言

Surface 用 `computed: { "<指针>": { op, args } }` 声明计算值，可以写在 `createSurface`、简化负载以及 `dataModelUpdate` 上；在 `dataModelUpdate` 中，`null` 表示删除该声明。操作数可以是字面量、`{ path }` 或嵌套的表达式。

**运算符。** 运算符集合是封闭的，共 30 个：

- 算术：`add`、`subtract`、`multiply`、`divide`、`mod`、`pow`、`min`、`max`、`abs`、`round`、`floor`、`ceil`；
- 聚合：`sum`、`sumOf`、`count`、`countWhere`、`percentage`；
- 格式化：`concat`、`currency`、`fixed`；
- 逻辑：`if`、`eq`、`neq`、`gt`、`gte`、`lt`、`lte`、`and`、`or`、`not`。

**求值**（`lib/a2ui/computed.ts`）：

- 每条声明编译成一个 `ComputedField`，交给现有的 `resolveComputedFields` 执行。原本无人调用的 helper 由此成为实际的执行路径。
- 接受声明之前先检查上限：64 个字段、深度 8、32 个参数、256 个节点。
- 声明映射必须有序：一条声明只能读取普通数据和在它之前声明的目标，不能读取自己的目标、之后的目标，也不能读取包含它们或被它们包含的路径。否则上一次的结果会被回灌，数值会随每次按键漂移。合并后违反此规则的更新会被丢弃。
- 求值只按顺序走一遍，必定终止并收敛。`concat` 的结果超过 10,000 字符时返回 `null`，一串声明无法把字符串长度成倍放大。任何内容都不会被当作代码执行。
- 文本框里的字符串按数字处理，空字段算作 0；结果不是有限数时记为 `null`。

**适用范围。** store 在每次数据变更后重新计算。声明会经过所有序列化点：Dexie 中的 Surface 行、已保存的应用、导入与导出、捕获（`run-and-capture`）、`segmentToMessages` 回放，以及 IM 卡片投影（携带回复时刻的值）。每个序列化点都会重新校验声明；声明无效的消息（或 MCP 调用）在每一处都会被整体拒绝，与 store 的行为一致，而不是去掉声明后保留其余部分。MCP 的 `a2ui_create_surface` 和 `a2ui_data_model_update` 也接受同样的映射，渲染端和 sidecar 两份副本由一致性测试保持同步。

在桌面渲染器之外，headless brain 把 MCP 派发送入同一个 store，计算方式与桌面一致。捕获到的 Surface 以 `a2ui` 内容部件送达 `cognia serve` 和 SDK 客户端，其 payload 携带声明及已算出的值。CLI TUI 在收到部件时校验声明（映射无效时整体拒绝该 Surface，与 store 一致），并在 `/view` 中保留它们；覆盖层把每次编辑写入控件绑定的路径并重新计算，合计会随输入的数量实时变化。

### 统一的 URL 策略

`lib/a2ui/url-policy.ts` 与 `untrustedMarkdownUrlTransform` 保持一致，并有测试把两者绑定。

- **链接：** 只允许 `http:`、`https:`、`mailto:`。读取协议前会先剔除控制字符，所以 `java\tscript:` 会被拒绝。网页链接以 URL 解析器的规范形式返回，`https:evil.com` 或 `https:\\evil.com` 会变成 `https://evil.com/`，`ExternalLink` 能识别它，并让它在应用窗口之外打开。
- **媒体：** 只允许 `http:`、`https:`、`data:image/`、`blob:` 和根相对路径的资源。
- **内联样式：** 渲染器在组件拿到 `style` 之前先经 `safeA2UIStyle` 处理。`url(...)` 目标被媒体策略拒绝的属性会被丢弃；使用 `image-set()`、`src()`、`expression()`、CSS 转义、未闭合的 `url(`，或可执行脚本的属性（`behavior`、`-moz-binding`）也会被丢弃。

网页链接经 `ExternalLink` 打开，学术 PDF 经 `openExternal` 打开。被拒绝的链接显示为文字（或它的动作按钮），被拒绝的图片走兜底显示。Breadcrumb 的 `navigate` 动作只携带网页链接或不带协议的界面内路由，绝不携带被拒绝的协议。

A2UI 的 `Markdown` 组件沿用助手自身的聊天 Markdown 策略，因为两者出自同一个模型；来自 IM 发送者的 A2UI 从不渲染为 Surface。

### 协议提示词同步说明

只读的 A2UI 提示词升级到 `contractVersion: 2`，新增四项内容：

- 动作如何回到智能体，包括哪些动作名在本地处理；
- 计算语言，列出全部运算符；
- 链接与图片的 URL 策略；
- 一条图表规则：只供查看的图表或表格遵循可视化输出路由；A2UI 的 `Chart`/`Table` 放在带控件的 Surface 里使用；RichOutput 用于高级 profile。

`a2ui_handle_connector_action` 的 MCP 描述也已改为如实描述它的行为。

## 后果

- 生成的界面在回合流式输出时就地组装，出错的界面会显示源码。
- 桌面/Web 聊天里的按钮与 IM 中的表现一致，都会成为用户的下一条消息。它就是一条普通用户消息，享有与手打文字相同的处理：`dispatchTurn` 中的发送守卫（`scanSendGuard`）与隐私模式脱敏，以及 steer 和排队；前提是用户做了手势操作、Surface 绑定了会话、组件类型在白名单内。
- 计算器、购物车合计、条件标签都不再需要额外的智能体回合。
- Link、Breadcrumb、Image、Avatar、Card、学术 PDF 和内联 `style` 中的 URL 无法让应用窗口跳走、执行脚本或加载本地文件。
- 预览不会与封存后的 Surface 去重；回合封存时预览被替换，会出现一次重新布局。

## 本 ADR 未决定的事项

以下事项仍未解决：

- 官方 A2UI v0.9.1 互操作（审计批次 C）。
- 68 种类型的 JSON Schema 契约。
- 把校验失败反馈给模型。sidecar 工具目前仍返回 `ok: true`。
- A2UI `Markdown` 组件沿用助手的聊天 Markdown 策略，而非 A2UI URL 策略；插件或外部智能体写的 Markdown 是否需要严格模式尚未决定。
- 聊天控制器在接受后又拒绝的发送（发送守卫、并发上限）显示的是控制器的错误，而不是 A2UI 的提示。
- 生成布局的评估工具。
- 默认开启 A2UI。

证据账本把它们逐项记为残余风险。

## 验证

单元和组件测试覆盖：

- 部分 JSON 补全器，包括“不截断标量”的逐字符扫描；
- 预览的生命周期与节流；
- 源码兜底；
- 会话绑定（转录会话、最新存活渲染）与路由规则；
- provider 接线；
- 本地动作名单的对齐测试；
- 每个计算运算符及其上限、求值顺序、引用不变，以及有序规则和 `concat` 上限；
- 计算值在 store、Dexie 水合、导入、捕获、IM 投影、应用保存与导出、headless 内容部件以及 CLI TUI（校验、`/view`、覆盖层实时重算）中的往返；
- MCP schema 一致性与派发转发；
- URL 策略、它与聊天 Markdown 的一致性，以及两条渲染路径上的内联 `style` 清理；
- Link、Breadcrumb、Image、Avatar、Card 与 PDF 的行为。

真实模型在桌面壳中的运行验证记录在证据账本中。
