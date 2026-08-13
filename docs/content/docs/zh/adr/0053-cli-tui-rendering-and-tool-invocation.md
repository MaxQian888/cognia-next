---
title: ADR-0053 — Agent CLI TUI 渲染与工具调用打磨（流式 markdown 缓存 · 节奏揭示 · 更丰富的工具卡片 · sidecar 工具性能）
description: "让 cognia-agent TUI 的 markdown 渲染更自然、流式更顺滑（按内容/主题键的渲染缓存、按词对齐的节奏揭示、六级标题、行内代码去厚重底色、表格链接脚注 + 宽度钳制、代码竖线悬挂），丰富工具调用卡片（逐工具 spinner + 计时、审批时内联 diff 预览、工具感知的结果计数、实时记录中已完成上下文工具折叠、加固结果配对），并削减 sidecar 内置工具延迟（共享进程快照缓存、git 仓库校验缓存、非阻塞 ripgrep 探测、write 解码去重）。"
---

# ADR-0053 — Agent CLI TUI 渲染与工具调用打磨

**状态**：Accepted（2026-06-20）
**作者**：Max Qian + Claude Opus 4.8
**承接**：[Agent CLI TUI](../subsystems/cognia-agent-tui) 子系统、ADR-0050（操作体验加固），以及 sidecar 内置工具。

## 当前状态修订（2026-08-13）

Interactive transcript cells 已交付。剩余搜索工作属于兼容清理：在行为对等测试通过后，让 legacy `content_search` 与 `file_search` 名称委托到 canonical ripgrep/glob adapter，并在兼容期保留旧名称。

## 背景

TUI 的 markdown 渲染、工具卡片与 sidecar 内置工具均可用，但经一轮调研（并参考 OpenCode / Crush / glamour）发现若干粗糙处：

- **Markdown** 每次 token flush 都重新词法化整段回答、并对每个已完成代码块重跑 `cli-highlight`（长流式下 O(n²)；highlight.js 是主要开销）。行内代码默认带厚重灰底；h4–h6 全塌缩为 h3 样式；表格内链接渲染出内联 `(url)`，但列宽计算未计入它（撑乱列对齐）；宽表格可能溢出；换行的代码行回退到第 0 列。
- **工具卡片** 只有静态 `⏳`（无 spinner / 计时），无论何种工具都显示原始行数，**权限**弹窗不预览编辑。缺 input 的 `tool-result` 在多个异名工具并发时可能被配到错误卡片。上下文采集工具（read/grep/glob/ls）的连发淹没了真正的工作。
- **Sidecar 内置工具** 每次调用都重新枚举全部进程（4 个只读进程工具各自 spawn `ps`/PowerShell）；每个 git 工具都额外 spawn 一次 `git rev-parse` 校验仓库；首次 ripgrep 探测用 `spawnSync` 阻塞事件循环；`write` 对内容解码两次。

## 决策

### Markdown 渲染（`cli/src/tui/markdown/`、`components/Markdown.tsx`）

- **渲染缓存**（`render-cache.ts`）：对词法化（按源文本）与代码高亮（按内容 + 主题键）做有界 LRU 记忆化。命中返回与直接调用完全一致的值，故输出不变——只省了重复工作。这就是让已完成代码块每次 flush 为 O(1) 的"(hash, theme)"缓存。我们刻意**未**采用 token 级稳定前缀拼接：`marked` 对部分块类型（heading/quote/hr/table）会吞掉其后的空行，而对另一些（paragraph/code/list）会发 `space` token，故把稳定前缀拼回去无法在不耦合 marked 内部的前提下保持逐字节一致——一旦不一致，文本提交时会发生重排。
- **节奏揭示**（`render/use-paced-reveal.ts`）：可关闭（`streamReveal` 渲染偏好）、仅 TTY、按词/标点对齐地揭示实时回答，镜像 OpenCode 的 `createPacedValue`。在 CI / 非交互输出中不生效。
- **美学**：六级视觉可辨的标题；行内代码为前景色、默认无底色（主题可选 `inlineCodeBg`）；表格列 CJK 感知并按宽度钳制，无 OSC-8 时把偏离标签的链接渲染为 `label[n]` + 脚注（同时修复链接列宽 bug）；代码正文行换行时悬挂在竖线下。

### 工具调用（`components/CellView.tsx`、`DiffView.tsx`、`format/*`、`state/reducer.ts`）

- **实时状态**：运行中的工具显示动画 spinner + `· Ns` 计时（`render/use-elapsed-seconds.ts`）。
- **工具感知的结果提示**：`format/tools.ts:resultCountLabel` 给 grep "N matches"、glob "N files"、ls "N entries"，而非原始行数。
- **审批时的 diff 预览**：权限弹窗通过与工具卡片共享的 `DiffView` 内联预览拟议编辑（有上限）。
- **上下文工具折叠**（`format/context-group.ts`）：在全屏**实时**记录中，相邻一串已完成的上下文工具折叠为一行摘要。经典 `<Static>` 回滚区按设计保留逐工具行——它是追加式的，折叠增长中的串会破坏已写入行（真实约束，选择如实呈现而非绕过）。
- **结果配对**：无名/无 key 的 `tool-result` 现在只完成**唯一**在运行的工具，绝不在多个并发的异名工具间猜测。

### Sidecar 内置工具（`sidecar/builtin-tools/`）

- **进程快照缓存**（`process/inventory.mjs:getProcessSnapshot`）：1.5s TTL 的快照由 list/get/search/top_memory 共享，把连发收敛为一次枚举。
- **git 仓库校验缓存**（`git/run.mjs`）：`assertRepo(cwd)` 成功后记忆化（失败不缓存，故新 `git init` 会重试）。
- **非阻塞 ripgrep 探测**（`core/rg.mjs`）：首次 PATH 查找用异步 `spawn` 替代 `spawnSync`。
- **`write` 解码去重**：传入内容只规范化一次而非两次。

## 影响

- 长流式回答不再每次 flush 重新高亮已完成代码；记录重渲更省。
- 用户面对具体 diff 审批；运行中工具显示进度；搜索结果读起来有意义。
- 进程密集或 git 密集的一轮 spawn 的子进程大幅减少。

## 范围之外（刻意延后）

- **Token 级稳定前缀流式** —— 对 marked 的空行处理脆弱（见上）；改由渲染缓存安全地拿到流式收益。
- **窗口化 `read`** —— 文件本就需整读以做二进制检测，且 `decodeText` 的整文件 BOM/EOL 规范化是正确性关键；窗口化重写为边际分配收益冒输出变化之险。
- **统一 `content_search` / `file_search` 到 ripgrep 引擎** —— 较大且行为敏感，留待专门跟进。
- **`<Static>` 回滚区逐卡片交互式展开/折叠** —— 与 Ink 追加式模型不兼容（同一约束把上下文折叠限定在实时记录）。

## 2026-08 跟进——renderer model 与结构化 part

渲染现增加纯 `TerminalBlock` 层，包含 styled terminal line、plain-copy text、精确 row count、
stable id 与 interaction target。实现继续使用 `marked@4`，不把 renderer 工作与 parser major
升级捆绑。golden test 覆盖窄宽度、CJK/emoji/combining text、hostile terminal control、
malformed streaming Markdown、table/list/quote，以及 Mermaid/math/A2UI fence fallback。

canonical envelope 新增 additive `content-part` event，覆盖 sources、files、A2UI、
artifact/canvas 引用与 custom fallback。durable event 不保存 binary/base64 body。URI 与 local
path policy 会约束 hyperlink/media；只有 trusted builder 可以发出 OSC-8、graphics 或 screen control。
