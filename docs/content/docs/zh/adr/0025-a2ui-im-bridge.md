---
title: "ADR-0025 — A2UI ⇄ IM 连接器桥"
description: "五个IM站台上的双向投射A2UI 接口"
---

# ADR-0025 — A2UI ⇄ IM 连接器桥

- **状态**：已接受
- **日期**：2026-05-18
- **架构提升**：v37 → v38（`inboundLedger`随`namespace`变宽，新`connectorCallbackBindings`表，`adapterInstances` `lastKnownCapabilities`增益）
- **替代：部分内容ADR-0009（第二阶段的存档用于 A2UI 投影、回调往返、计算机使用隔离）

## 背景

ADR-0009发布了五个平台连接器（Telegram / Discord / Slack / Lark / OneBot），包含文本+媒体段，以及`MessageSegment`不透明`card`类型，作为唯一用于丰富内容的兜底机制。A2UI（ADR-0017）是代理的structured-UI格式，具有60+的组件类型，但当时它只在browser/Tauri渲染器内运行——IM通道完全没有看到任何此类内容。

IM-completion轨道（第二阶段）通过使A2UI在每个连接处都成为一流的传输来解决这个问题。需要布线两个方向：

- **出站**：助手通过`builtin:a2ui-bridge` MCP服务器生成A2UI 接口;连接器子系统将每个接口投影到平台原生丰富的内容中（Slack 块套件 / Lark 交互卡 / Telegram InlineKeyboardMarkup / Discord 嵌入 + 组件 / OneBot CQ-code带动作文本列表）。
- **回拨回电**：用户交互（Slack按钮/Lark卡片点击/Telegram callback_query/Discord组件交互）会像浏览器渲染器内的信号一样往返给助手。

## 决策

### 能力感知降级

每个适配器都实现了`PlatformAdapter.a2uiCapability(): A2UICapabilityMatrix`（`types/connectors/capability.ts`）。矩阵将35种目录组件类型声明为以下之一：

- `native`——用平台原生丰富的元素渲染。
- `fallback`——降级成`plainTextMirror`（始终安全）。
- `unsupported` — 适配器拒绝;助理SHOULD NOT本频道发出。

`build-options.ts:resolveSendOptions`在每次发送时读取矩阵，在`appendSystemPrompt`上附加`buildCapabilityPromptSection(platform, matrix)`，并强制对任何IM非空矩阵会话`a2uiEnabled = true`。助手会看到当前频道中哪些类型会降级的明确指引，并避免使用无支持的类型。

### `MessageSegment.a2ui`

一种新的段变体通过连接总线传输A2UI 接口：

```ts
{
  type: "a2ui",
  surfaceId: string,
  content: A2UISegmentContent,  // {components, dataModel, rootId, ...}
  plainTextMirror: string,        // always present — degradation safety net
}
```

`types/connectors/segment.ts:segmentsToPlainText` `plainTextMirror` 投射了一个`a2ui`段，因此触发匹配器（关键词、斜线 命令、正则表达式）在各平台仍然能统一使用。

### 每个平台A2UI映射器

五个适配器通过共享工具包拥有平台特定投影（`lib/connectors/adapters/_shared/a2ui-mapper.ts`）：

- `walkA2UISurface(surface, visit)` — 深度优先穿越，带有循环短路。
- `buildActionId(surfaceId, componentId, action)` + `truncateActionId` — 在特定平台长度上限下的确定性ID生成。
- `recordCallbackBinding` / `resolveCallbackBinding` — Dexie背绑定行，当平台强制不透明度ID（Telegram的64字节上限，Discord的100字符上限）时，会绕长action_id来回。
- `generatePlainTextMirror(surface)` — 回退文本投影。

按平台划分的地图覆盖范围：

| 组成部分 | 电报 | Discord | 松弛 | Lark | OneBot |
| --------------- | -------- | -------- | -------- | -------- | -------- |
| 正文 | 本地人 | 本地人 | 本地人 | 本地人 | 本地人 |
| 图片 | 本地人 | 本地人 | 本地人 | 本地人 | 本地人 |
| 卡牌 | 本地人 | 本地人 | 本地人 | 本地人 | 本地人 |
| 警报 | 本地人 | 本地人 | 本地人 | 本地人 | 本地人 |
| 按钮 | 本地人 | 本地人 | 本地人 | 本地人 | 回退 |
| 精选 | 回退 | 本地人 | 本地人 | 本地人 | 回退 |
| RadioGroup | 回退 | 本地人 | 本地人 | 本地人 | 回退 |
| 复选框 | 回退 | 回退 | 本地人 | 回退 | 回退 |
| DatePicker | 回退 | 回退 | 本地人 | 本地人 | 回退 |
| TimePicker | 回退 | 回退 | 本地人 | 本地人 | 回退 |
| TextField | 回退 | 回退 | 本地人 | 本地人 | 回退 |
| TextArea | 回退 | 回退 | 本地人 | 本地人 | 回退 |
| 分隔线 | 本地人 | 本地人 | 本地人 | 本地人 | 本地人 |
| 链接 | 本地人 | 本地人 | 本地人 | 本地人 | 本地人 |
| Row/Column/List | 本地人 | 本地人 | 本地人 | 本地人 | 回退 |
| 排行榜 | 回退 | 回退 | 回退 | 回退 | 回退 |
| 表格 | 回退 | 回退 | 回退 | 回退 | 回退 |

### 入站回呼信道

`ConnectorBus.dispatchConnectorCallback(event: ConnectorCallbackEvent)`运行四步流水线：去重（`inboundLedger`上的命名空间`"callback"`）→绑定查找（`resolveCallbackBinding`）、→审计（`callback.received` / `callback.deduped` / `callback.unbound`）→ 处理器。

处理器——`lib/a2ui/connector-callback-handler.ts`——将动作附加到`a2uiEventHistory`并从`scheduled-outbound.ts`呼叫`runConnectorDigestTurn`，使助理的下一回合看到点击声，就像渲染器中发生的一样。浏览器端和IM-side用户在同一AI循环中收敛。

#### 修订（2026-08-31）：处理器不再是唯一去向

上面这一步现在是**默认分支**，不是唯一分支。绑定的 `kind` 若指向产品自己画的卡片，
会在模型回合之前短路：卡片已经写明了每个按钮做什么，再花一个回合让模型重新解释它，
既更慢也更不可靠。

| `kind`                | 处理者                                        |
| --------------------- | --------------------------------------------- |
| `issue_action`        | `lib/issues/im/callback-handler.ts`            |
| `wf_approve` / cancel | `lib/a2ui/workflow-approval-handler.ts`        |
| workflow 扇出         | `lib/a2ui/workflow-fanout-handler.ts`          |
| `notification_action` | `lib/notifications/im-callback-handler.ts`     |
| 其余                  | `lib/a2ui/connector-callback-handler.ts`       |

词表本身在 `types/connectors/interaction.ts`，那里才是「一个 `kind` 是什么意思」的
真相源。本 ADR 刻意不逐条复述：那会是第二份会漂移的副本。

第五A2UI MCP工具`a2ui_handle_connector_action`加入桥接（`lib/a2ui/mcp-tool-schemas.ts`），是自定义回调处理器想向特定接口注入动作时的投影端点。

### 计算机使用隔离

`applyComputerUseTools`（`lib/claude/computer-use-tools.ts`）门禁 `imSession === true`：当会话绑定到平台连接器和`ConversationOverrideRow.allowComputerUse !== true`时，辅助器在连接任何本地 Anthropic 工具前会短路。收到的Telegram消息不会意外触发主机的截图/鼠标/键盘操作。

### 来自平台丰富内容的A2UI

`lib/connectors/adapters/_shared/inbound-a2ui-dispatch.ts:projectInboundToA2UI` 将一个入站平台载荷发送到匹配的每个平台`inbound-to-a2ui.ts`映射器，生成一个`InboundA2UIBlock`（`inbound-a2ui-types.ts`），该映射会被持久保存到`StoredMessage.metadata.inboundA2UI`并由 `components/chat/message-parts/inbound-a2ui-renderer.tsx` 渲染，使收件箱显示平台原生丰富的结构。

> 注：本ADR早期草稿描述了一种将`MessageSegment[]`折叠成A2UI 接口的`lib/connectors/a2ui-bridge/segments-to-a2ui.ts:segmentsToA2UI`。该模块从未接线（无来电者），后来被**作为死代码**移除了;上述`InboundA2UIBlock`路径是实入射，且不是出射`a2ui-to-segments.ts`投影的倒数。

## 后果

- `MessageSegment`联盟现有13个变体（新增`a2ui`）。
- Schema v38 — 所有现有连接器部署都会在下一次开放时迁移。
- 这五个适配器均返回能力矩阵;助理提示每回合增加约120个代币IM-bound（能力+引A2UI）。
- `Computer Use`不再默认从IM会话中发射——这是一项重大的安全强化。希望实现自动化IM-driven操作员必须通过“对话设置”标签页为每段对话选择加入。
- Telegram callback_query、Discord INTERACTION_CREATE、Slack block_actions / view_submission Lark im.interactive_message.action_triggered_v1都通过同一个ConnectorBus通道路由——助理代码路径没有每个平台的分支。

## 参考文献

- ADR-0009 — 站台连接器基线
- ADR-0017 — A2UI协议
- ADR-0010 — Claude订阅OAuth（模式重复用于连接器OAuth驱动）
- `lib/connectors/adapters/_shared/a2ui-mapper.ts` — 共享工具包
- `lib/connectors/a2ui-bridge/capability-evaluator.ts` — 能力→提示部分
