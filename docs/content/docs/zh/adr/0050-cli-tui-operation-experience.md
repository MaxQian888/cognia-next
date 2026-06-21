---
title: ADR-0050 —— Agent CLI 终端界面操作体验加固（编辑快捷键 · 死命令接线 · 文档）
description: "把 cognia-agent 的 Ink TUI 立为一等子系统，并加固其操作体验：为输入框补 readline 式行删除与按词移动、接通早已宣传却休眠的 /permissions remove 命令、拒绝冲突的改键、补齐缺失的参数提示——仅做高确定性修复，不重写光标/撤销/浮层。"
---

# ADR-0050 —— Agent CLI 终端界面操作体验加固

**状态**：已接受（2026-06-20）
**作者**：Max Qian + Claude Opus 4.8
**承接**：`cognia-agent` 独立智能体（`cli/`）、新的 [Agent CLI 终端界面](../subsystems/cognia-agent-tui) 子系统页，以及 ADR-0026（内置技能与 lark-cli 桥）。

## 背景

`cognia-agent` 的交互式 TUI（`cli/src/tui/`，约 175 个源文件：纯 reducer、斜杠命令系统、
20 个运行时控制器、13 个浮层、markdown/提及/主题层，以及 readline 式输入框）已成长为一个成熟子系统，
但仍有两处缺口：

1. **它没有文档。** `subsystems/cognia-cli` 一节文档讲的是 *Rust 插件作者* CLI（`crates/cognia-cli`）；
   TypeScript 智能体 TUI 既无子系统页也无 ADR，且 `cli/README.md` 仍把交互式 TUI 描述为“后续阶段”。
2. **对操作体验逐部分的检查**在输入框与命令接线中暴露出一小批高确定性缺陷。初轮排查的许多“发现”是
   假阳性（状态栏其实已显示权限模式并对 `bypassPermissions` 告警；markdown 层已有完整 CJK 宽度处理；
   多数 `argumentHint` 已存在），因此本 ADR 只记录**已核实**的改动，以及刻意**不做**的项。

## 决策

### 1 · 输入框补 readline 式行删除与按词移动

输入框此前只绑定了 `Ctrl+A/E`（行首/行尾）与 `Ctrl+W`（向左删词）。来自 bash/zsh/readline 的用户期待更多。
以纯 `buffer.ts` 操作（由纯 `keymap.ts` 意图驱动）新增：

- `deleteToLineStart`（**Ctrl+U**）与 `deleteToLineEnd`（**Ctrl+K**）—— 注册为可改键动作
  `lineKillToStart` / `lineKillToEnd`，因此会出现在 `/keybind` 中，并像既有快捷键一样与用户覆盖合并。
- `moveWordLeft` / `moveWordRight` —— 绑定到 **Ctrl+←/→**（及 Alt+←/→）。当终端未随方向键带上修饰键时，
  keymap 优雅退化为单列移动，因此在简陋终端上没有回归。

### 2 · 接通早已宣传却休眠的 `/permissions remove`

`permissionsRemove()` 早已完整实现，**它自己的报告文本还提示用户运行 `/permissions remove <tool>`**，
但命令从未接线：既没有 `remove` 子命令，运行时路由也把 `req.action === "remove"` 静默回落到
`permissionsList`。新增 `remove` 子命令（带 `<tool>` 提示）并路由到 `permissionsRemove(pd, req.arg)`，
把一个误导用户的死命令变成可用命令。

### 3 · 拒绝冲突的改键

`findKeybindingConflicts()` 早已存在却从未被调用。`/keybind <动作> <键>` 现在会计算改键后的表，并在某
键位与另一动作冲突时**拒绝**，给出冲突项与解决方式——而不是任由命令表里靠前的动作悄悄抢走共享键。
把动作改回它当前自己的键仍然允许。

### 4 · 补齐真正缺失的参数提示

补上确实缺失的 `argumentHint`——`/mcp enable|disable|toggle <name>` 与
`/plugin show|enable|disable <id>`——让这些子命令像其同辈一样有行内提示。

## 刻意不做（按设计排除范围）

为保持高确定性、零回归，以下项经评估后**未做**：

- **把 `Del` 当作前向删除。** 拆分 `key.backspace || key.delete` 看似正确，实则不安全：许多终端把
  **退格**键报成 `key.delete`（原始 `0x7F`），把 `key.delete` 当前向删除会破坏退格。该合并刻意保留并已记录。
- **按显示宽度重写光标、输入框撤销/重做、浮层返回栈。** 三者都是更大、更高风险的重构（缓冲区按 UTF-16
  偏移而非显示列索引；浮层按设计是单活跃槽）。宁可延后，不仓促上马。

## 影响

- 输入框在常用编辑快捷键上达到 readline 对齐；权限面可在 CLI 完全控制；`/keybind` 再也无法造成静默冲突；
  半输入的子命令都会提示参数。
- TUI 现在是有 ADR 与子系统页的有文档子系统，纠正了“后续阶段”的过时定位。
- 所有改动都是纯函数或薄接线，附带同目录测试；不触碰桌面、sidecar 或 Rust 代码。

## 验证

`pnpm cli:test`（受影响套件全绿，含新增的 buffer/keymap/keybinding/命令/运行时用例）、
`cli/` 的 `tsc --noEmit` 干净，新增纯操作对行内与跨行光标两种情形都有单测。

## 后续 —— 第 2 轮迭代（渲染、用量真实性、长任务可见性）

第二轮沿用同样的"找出休眠数据、接通、保持纯函数"的方法，覆盖渲染与用量：

- **实时 API 限额（A1）。** sidecar 的 `fetch-interceptor` 早已把每个 `anthropic-ratelimit-*` 头作为
  `usage_headers` 消息发出，却无人消费。`useAgentSession` 现经纯模块 `format/rate-limits.ts` 折叠为
  `state.rateLimits`；`/limits` 显示实时"API 限额"块，并有可选的 `ratelimit` 页脚段汇总最紧的剩余额度。
- **长任务预算/步骤（B1）。** `driven-turns` 现填充 `ActivityState.max`（loop `--n` / goal `maxTurns`）与
  `note`（本次运行累计 token + 间隔 loop 的节奏），活动 pill 因此显示确定性进度条与实时预算。
- **撤销/重做（C1）。** *取代第 1 轮的延后决定。* 实现为 reducer 拥有的撤销/重做栈，**仅在文本变化时**
  快照缓冲区（纯光标移动不快照）；`Ctrl+Z`/`Ctrl+Y` 可改键（`KEYBINDABLE_ACTIONS` → 13）。宽度感知光标
  重写与浮层返回栈仍延后。
- **成本趋势 + SDK 上下文（A2）。** `/usage` 新增每轮成本火花线（`state.costHistory`，共享 `turnCostUsd`）。
  `/context` 现经 runtime 通过新的 `getContextUsage` 控制往返追加 SDK 的权威实时分解——CLI sidecar 协议
  新增 `control`/`control_response` 消息对（桌面早已具备）。
- **内联图片（D1）。** 工具结果中的 base64 图片块，在支持图形的终端内联渲染（`format/terminal-graphics.ts`，
  现含 kitty 分块），其他终端显示紧凑占位，而非倾倒 base64 长串（`format/result-images.ts` 抽取并省略）。

所有新增都保持纯核 + 薄接线 + 同目录测试；未改动桌面、Rust 或 sidecar 代码（sidecar 的 `control` 处理早已存在）。
唯一的预存在 `App.test` 权限浮层超时与本次无关。
