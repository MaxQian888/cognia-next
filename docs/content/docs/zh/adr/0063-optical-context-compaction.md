---
title: "ADR-0063 — 光学上下文压缩（snapcompact“文本即图像”）"
description: "一种新的“光学”对话压缩策略，将旧的帧变成紧凑的，PNG视觉模型会读取，而不是将其总结为有损文本。Pure-TypeScript sidecar渲染器移植自 Oh-My-Pi 的 snapcompact.rs，具备自适应的每提供商形状选择 + 代币预算，支持自动文本摘要回退的往返可读性门禁，多帧分页，以及带文字记录内查看器的耐用归档功能。"
---

# ADR-0063 — 光学上下文压缩（snapcompact“文本即图像”）

**状态**：已接受（2026-07-06） **作者**：Max Qian + Claude Opus 4.8 **构建于**基础：通用（AI-SDK）压缩流水线（`sidecar/dispatch/compaction*.mjs`、`lib/claude/compact-instructions.ts`、ADR-notes 冻结摘要前缀稳定性）、`compact_boundary`事件 + 撤销快照路径（`lib/claude/adapter.ts`、`lib/claude/compaction-undo.ts`）。**灵感来源**：[`oh-my-pi` `crates/pi-natives/src/snapcompact.rs`](https://github.com/can1357/oh-my-pi/blob/main/crates/pi-natives/src/snapcompact.rs)（`text → PNG`热路径）以及“光学上下文压缩”研究的DeepSeek-OCR线。

## 背景

所有现有的压缩策略（`summary`、`hybrid`、`selective`、`recursive`、`sliding-window`）都是**有损文本**：旧回合被LLM摘要替换或省略。因此，长期的代理运行会放弃逐字细节——准确的文件路径、工具输出、决策——以保持在窗口内。

`snapcompact`则是另一种想法：**将存档文本光栅化成密集图像**，让具备视觉能力的模型读取。一种微小的像素字体可以将数千个字符压缩到一个小画面中;由于视觉代币成本跟踪的是图像**分辨率**（图块），而非文本长度，因此一帧打包文本可以花费远少于等效文本的代币数——同时保留**实际单词*，而非摘要。这就是“光学”/文本即图像压缩。

我们从头到尾学习`snapcompact.rs`。这只是热`text → PNG bytes`小径;归一化、帧、提供商形状选择和归档管理则交由（专有）TypeScript层负责。其形状控制——五种捆绑的pixel/TrueType字体、六色句子边界墨水循环（`sent`）与纯黑色（`bw`，适合Anthropic读者）、`lineRepeat`冗余带、Lanczos3单元格拉伸、双列“文档”布局、工具输出暗跨度（`U+000E/F`）、全区块换行折叠（`U+2588`）以及调色板缩窄的1/2/4位索引PNG——均经过评估验证。

## 决策

在通用路径中添加**`optical`**压缩策略，实现为**pure-TypeScript sidecar子系统**（无原生模块——sidecar没有napi，pure-TS渲染器在浏览器/Tauri/Capacitor壳层间工作完全相同;内联字体数据在esbuild-CLI和Tauri捆绑器中都依赖于现有的`dispatch/*.mjs`船路径）。渲染者忠实地移植了`snapcompact.rs`;此外，我们还加入了参考中遗漏的四项能力。

### 渲染器（`sidecar/dispatch/optical/`）

- `fonts-data.mjs` / `fonts.mjs` — 嵌入的公共领域位图字体（`unscii-8` 8×8，X.org `misc-fixed` 5×8），带有十六进制+BDF解析器。
- `raster.mjs` — 网格+两列“文档”光栅化，句子色调循环，暗跨度，全区块单元填充，线重复带，宽单元（CJK）几何体。
- `resample.mjs` — 拉伸形状用可分离的Lanczos3。
- `png.mjs` — 通过Node `zlib`手工卷制PNG（索引为1/2/4位调色板缩窄+真彩色RGB）。
- `render.mjs` — `renderSnapcompactPng(text, options)` → base64 PNG（本地单元索引，拉伸单元RGB索引）。

### 扩展（“更多功能”）

1. **自适应形状 + 令牌预算**（`layout.mjs`）——将目标模型映射到视觉定价家族（Anthropic / OpenAI / Google），选择评估最优font/cell/variant（拟人化为bw;OpenAI为6×6拉伸），估算每帧的视觉令牌成本，只有当光学归档低于等效文本时才进行。分页跨越多个画面，closing/reopening暗淡的跨越剪辑。
2. **往返可读性 + 自动回退**（`readability.mjs`，`compact.mjs`）——一次性视觉回读转录第一帧;多词回忆低于阈值时，会丢弃归档并退回到文本摘要。覆盖率、预算、溢出和可读性有四个门禁;任何失败都会返回`null`，编排器会以相同的摘要方式汇总`middle`，因此**上下文永远不会丢弃到无法读取的图像**。
3. **原始归档 + 按需视图**（`lib/db/optical-archives.ts` Dexie v101、`lib/claude/optical-archive-persist.ts`、`components/chat/message-parts/optical-archive-dialog.tsx`）——每个边界保留帧 + 令牌统计 + 压缩前转录本;紧凑边界标记器会获得“查看帧”按钮，打开包含图片的对话框、before/after令牌比较，以及按需显示原始文本（可跨越加载后持久，不同于内存中的撤销注册表）。
4. **混合框架+多帧**——工具输出为暗色，换行可折叠至整块，转录分页最多可`maxFrames`张图片，最近的尾部保持原文（计划的 `middle → image`，`tail → text`分割本质上是混合的）。

### 管道集成

`planStrategy`获得一个`optical`的计划类型，形状与`single` `middle`相同（所以回退很简单）。`maybeCompact`渲染+验证，将归档剪接为`role:"user"`消息，其前导文本哨兵使其成为**冻结产物**（`isSummaryMessage` / `isOpticalMessage`识别数组内容消息）——因此之前的光学归档会逐字传承，永远不会重新映像或丢失。`compact_boundary`事件包含帧数+属性`compact_metadata.optical`。

## 能力边界

v1 仅对两个小的拉丁-1像素字体进行内行化。较大的 X.org BDFs和CJK TrueType（银色）是一个有文档的延伸点：它们太重无法内联显示，**CJK-heavy 转录通过覆盖门禁+往返检查路由到文本摘要回退**，而不是错误渲染为空白。这是一个诚实的能力边界，而不是简化的代码路径——完整的渲染流程（所有形状控制、色调、调暗、块、重复、文档、拉伸、调色板缩窄）都已实现。添加捆绑的 CJK `.hex`（例如GNU Unifont 子集，同一解析器）可以提升边界而不触及流水线。

## 后果

- 光学压缩是选择加入（`Settings → Conversation → Compaction method → Optical`）;默认状态保持`hybrid`。
- 该策略在验证开启（默认）时，每次压缩额外调用一次视觉调用，且限制为第一帧。
- Vision代币的节省只有在每像素低价的大型档案中才是真实的;预算门禁自动拒绝小型或昂贵案件。
- 存储：档案限制在最新的100行;帧较小（索引PNG），原文可以更大，但受压缩`middle`限制。
