---
title: "ADR-0057 — 聊天渲染完整性（MCP 内容块 + 子智能体持久化）"
description: "在弥补聊天渲染空白时做出的两个难以逆转的决定：（1） 保留第三方MCP工具结果[]块[]块[text/image/resource/audio]在工具部件上，而不是将其压扁成不透明的字符串，从而使任意MCP工具渲染images/resources丰富，而非像base64墙面;以及（2）将已完成的子代理的终端快照（toolCalls/logs/finalResponse）持久化到其消息部分，使内联调度树在冷重载时存活——无需添加Dexie表。两者都是可加的，并且向后兼容变更前的消息。"
---

# ADR-0057 — 聊天渲染完整性（MCP 内容块 + 子智能体持久化）

**状态**：提议（2026-06-28） **作者**：Max Qian + Claude **基于**构建内容**：ADR-0020（电脑使用内联截图——唯一之前的图像存活先例）、ADR-0022（代理团队运行时硬化）、ADR-0024（OCR子系统）、ADR-0032（代理团队插件集成）。

## 背景

聊天消息渲染器（`components/chat/message-renderer.tsx`）已经成熟——~20种组件类型，~18个工具和专用的富卡，depth-N子代理树。弥补剩余缺口后，出现了两个决策，其反转成本高到足以记录，因为两者都改变了持久消息部分的**形状**以及生成该部分的**适配器流水线**。

### Gap 3 — 第三方MCP工具结果

MCP工具的效果，按规格来说，是`content: [{type:'text'|'image'|'resource'|'audio', …}]`。sidecar/SDK完整地交付了该数组，但`lib/claude/adapter.ts:flattenToolResultContent`在任何渲染器看到之前就将其合并为`updateToolPart`字符串：文本块串接，所有非文本块`JSON.stringify`-ed。图像块仅作为JSON代码块内的base64墙保存下来。只有Cognia自有工具（`wiki_*`、`rag_search`等）和Claude内置卡有专用卡;**所有第三方MCP工具都掉进了那个不透明的垃圾堆**。结构化数组正好在一个上游点（`updateToolPart`）处活着，因此需要丰富渲染的数据已经存在——这些数据在UI前一步被丢弃。

### Gap 7 — 子代理内联树在重新加载时消失

`subagent`消息部分仅携带身份 + 状态快照;实时工具列表、日志和最终响应都存放在**短暂**`useSubagentRuntimeStore`中（从未持续存在）。消息（含`parts`）逐字通过Dexie `messages`桌传递。所以在页面重新加载后，完成的运行扩展树会被清空——静态字段存活了，但运行的实际工作却没有。

## 决策

### D1 — 加法保持MCP `content[]`，逐块渲染

`lib/claude/adapter.ts`现在将原始内容块附加到成功状态工具部分，作为`mcpContent?: McpResultBlock[]`（输入`lib/claude/parts-extensions.ts`）**同时保持**扁平的`output`字符串。一个新的`McpContentBlocksCard`（`components/chat/message-parts/mcp-renderers/`）正在逐步推进：文本→降价、图片→ `ImageBlock`、资源→ code/file/download、音频→ `AudioBlock`。`McpToolBodyOrContent`在有`mcpContent`时，将没有专用卡的工具路由到块卡，否则会路由到通用的 `ToolBody`。

两名保安确保安全且低噪音：
- **仅在至少一个区块非文本时才附加**（`extractMcpContentBlocks`）。纯文本结果保持在现有的平坦字符串路径上——没有行为变化，也没有常见情况下的持久化膨胀。
- **`output` 被保留**，因此在此更改前仍存在的消息（仅字符串）且优先的A2UI/错误状态路径不受影响。

**替代方案已拒绝。** （a） 一种启发式JSON美化器，`JSON.parse`-detects不透明字符串中的结构——当真实数组上游可用时，该结构是有损、猜测且无意义的。（b）保留平坦——使第三方MCP image/resource输出无法使用。

### D2 — 在零件上持久化子代理终端快照（无新Dexie表）

`SubagentPart`获得可选的`toolCalls` / `logs` / `finalResponse` / `toolUses`。`lib/claude/subagent-bridge.ts:applySubagentUpdate`仅在终端状态转换时写入（completed/failed/cancelled/timeout/rejected）。`subagent-part.tsx` 先读取 live store，运行结束后（重载后）会回退到持久快照。

仅终端写入是承载约束：`subagentSignature`（门禁消息数组重写的廉价变更摘要）故意排除`toolCalls`/`logs`/`progress`，并且已经在终端转换时发生了变化。在那个转换中写一次快照，就是搭便车在一个注定会发生的重写上——在每个运行的跳上写入，会重写每个工具事件的整个消息数组（正是签名存在的目的是避免的流失）。

**备选已拒绝。** 一个新的 Dexie 表镜像 运行时 存储——它复制了一个持久通道（`messages.parts`），该通道已经逐字往返，加载时需要重新加入消息。运行时存储是恰当的短暂的;持续存在的部分才是冻结树的正确归宿。

## 后果

- **向后兼容。** 这两个更改都是可加的可选字段;`isSubagentPart`不变（仅检定`type`+`subagentId`）;旧的持久消息显示和以前完全一样。
- **有界快照。** 持久化的子代理快照继承存储的上限（~100 toolCalls / ~50 日志）;有更多新手的游戏只保留最新的。
- **流水线耦合。** `adapter.ts`现在是决定通用工具中哪些内容能留给渲染器的唯一地方——未来的丰富渲染工作键是从`mcpContent`中提取，而不是重新解析字符串。
- **同一变化中相关的弥合间隙**（非ADR-worthy，记录以供参考）：未知部件回退卡、非图像文件预览、字级差值（`fast-diff`）、子代理流式文本被限制为详细模式、progress-UX统一到诚实工具数量、共享`BackgroundedRunControls`、OCR `ocr-result`聊天部分，以及将产物底座挂载到移动聊天壳上。

## 当前状态修订（2026-08-13）

Structured MCP content 与 durable terminal/subagent snapshot 已实现，并有 renderer 测试覆盖。两个已命名 defect 已关闭；原 `Proposed` 状态只作为历史保留，不应被理解为需要新增另一套 renderer fallback pipeline。
