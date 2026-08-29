---
title: "0158 — Artifact 与 Canvas：它们住在哪里，谁可以创作"
description: "Artifact 从 5 MB 的 localStorage blob 搬进 Dexie；模型获得按名创建的工具；png/pdf 导出成真；工作流也能触达两者。以及为此退役的八个模块。"
---

# ADR 0158 — Artifact 与 Canvas：它们住在哪里，谁可以创作

**状态：** 已接受
**日期：** 2026-08-29
**相关：** [ADR-0139](./0139-visual-output-routing)、[ADR-0090](./0090-unified-agent-execution)、[ADR-0100](./0100-unified-template-platform)、[ADR-0127](./0127-chat-transport-batching)、[ADR-0138](./0138-chat-reading-area-stability)

## 背景

Artifact / Canvas 子系统体量很大——54 个组件，Canvas 另有 56 个，一个 2 400 行的
Zustand store——而且在本仓库里少见地：**大部分确实已经接线**。
`pnpm audit:unreachable-components` 是绿的，基线里 5 个条目没有一个属于本区域。

缺口比「一整块死代码」更窄、也更难看见。

**模型无法创建 artifact。** `types/agent/tool.ts` 里声明了 11 个工具名，
**两条**消息转换路径（`lib/claude/adapter.ts` 与
`lib/ai/agent/external/event-to-parts.ts`，逻辑完全重复）也都已经会把这样一次调用
变成 `ArtifactPart`。但没有任何地方定义、注册或执行其中任何一个。artifact 只能靠
回合结束时的启发式检测器从回复里捞出来——而它在结构上就不可能知道一张图表的
`chartType`，或作者想要的标题。

**两条路径本来就是坏的。** `components/chat/message-parts/canvas-inline-part.tsx`
链接到 `/canvas/<id>`，一个从未存在的路由——本应用是静态导出，`app/` 下没有任何
动态段。而 React artifact 预览在每个壳里都已失效：React 19 不再发布 UMD 构建，
`unpkg.com/react@19/umd/…` 是 404，每次预览都落到 15 秒超时提示。

**存储在设计上就会丢数据。** artifact、其版本历史与 canvas 文档共用同一个
`cognia-artifacts` localStorage key。为了塞进 ~5 MB 上限，`partialize` 把每个
artifact 的内容截到 100 KB，并淘汰第 200 条之后的全部——每次写入都做一遍，静默，
且不可逆：下次重载读回来的就是被截断的那份。

**png 与 pdf 被宣传却没实现。** `ArtifactExportFormat` 声明了两者；没有任何
adapter 提供；而 ADR-0139 的常驻路由提示在**每次发送**时都对模型宣称 chart
artifact 是「可导出的」。

## 决定

### 1. Dexie 拥有 artifact 与 canvas 文档

schema v206 新增 `artifacts` 与 `artifactVersions`。persist v6 停止把 artifact
写进 localStorage，v7 停止写 canvas 文档。blob 里剩下的是 dock 的偏好：工作区
筛选、按会话分桶的标签页、每个会话停在哪个 artifact。

`lib/artifacts/dexie-bridge.ts` 与 `lib/canvas/dexie-bridge.ts` 是写穿镜像，
启动时给 store 播种。两者遵守账户生命周期强加的两条规则，并都用测试钉死：

1. **绝不写入镜像并非为其建立的那个数据库。** 锁定账户时
   `clearAccountDatabaseSelection()` 在 `clearAccountLocalState()` **之前**执行，
   于是仍在订阅的桥会看到一个空 store 指向另一个数据库。由于删除是从
   「在镜像里、不在内存里」推出来的，那次写入会清空另一个库。数据库名在注水时
   捕获、每次 flush 时复核；改由 `CanvasBridgeProvider` 在 `accountRevision`
   变化时重启两个桥。
2. **注水失败则整个镜像停用。** 部分读取会让内存变成表的一个未知子集，同步它
   就会删掉其余部分。canvas 桥原本把 `.catch` 放在 `.then` **之前**，吞掉失败
   并照常启动订阅。

迁移做成防崩溃，而不是尽力而为。store 会把旧 blob 注水进内存，而 `partialize`
不再写回，所以 localStorage 那份可能在 Dexie 写入落盘之前就消失——只剩内存里
一份。`lib/artifacts/localstorage-migration.ts` 先把副本寄存到另一个 key，等写入
成功才清除，于是被打断的迁移会在下次启动时重放。

让 Dexie 成为唯一副本，也暴露了 canvas 镜像一直在丢的东西：`docToRow` 从未携带
`sourceArtifactId`、`returnContext`、`authoringOrigin` 与 `aiWorkbench`。在
localStorage 还是权威时这不可见；它一旦不再是权威，就变成「回到它来自的那个
artifact」彻底失效。

### 2. Agent 工具面骑在已有的中继上，而不是第二个 MCP server

```
模型 → sidecar cognia-plugin-tools  （不改）
     → plugin_tool_exec 帧           （不改）
     → handlePluginToolExec          （新分支）
     → runArtifactBuiltinTool        （新） → useArtifactStore
     → plugin_tool_response
     → tool_result → ArtifactPart
```

这条 host-routed builtin-tool 中继已经承载 6 个工具族、跑在两条 dispatch 路径上，
CLI 也在复用。第二个 MCP server 只会换来第二套注册面、第二套权限键，以及第二个
让工具「消失」的地方。

**发布 8 个工具**，不是 11 个。`artifact_search` 折进 `artifact_read` 的可选
`query`——一个可选字段胜过一整个模型每回合都要付费的 schema。`artifact_render`
是 dock 的事。`artifact_export` 被扣下：模型主动往用户磁盘写是同意面问题，而按钮
就在用户眼前一格。

**part 从 `tool_result` 发出，绝不从 `tool_use`。** 这正是「内容已清除」占位符的
根因：`tool_use` 早于行的创建，据此构造的 part 只能指向一个解析不出来的 id。
`lib/artifacts/tool-part.ts` 现在是两条路径共用的唯一转换器，取代了那对重复实现。

**这个联合是契约，不是许愿单。** `types/agent/tool.ts` 里列的名字恰好等于
`buildArtifactManifestEntries()` 与 `buildCanvasManifestEntries()` 发布的集合，
并由测试断言相等。这也是本批**不需要任何休眠标注**的原因：少实现一个名字是一个
红测试，而不是一句没人看的注释。

同意分级跟着界面走。`artifact_delete` 是 `ask`；create / update / read / open 是
`allow`——卡片就在屏幕上，每次写入都留版本，而 `artifact_update` 会经过与启发式
修订同一道评审门。每个名字都要**登记两遍**（裸名与 `mcp__cognia-plugin-tools__`
前缀名），因为 Anthropic 路径看到前者，AI-SDK 路径看到后者。

manifest 与 ADR-0139 的路由提示由**同一个**判定式把门（已提取出来，两者不会漂移）：
常驻提示绝不能宣传一个工具缺席的界面。IM 绑定的会话两者都拿不到。

### 3. png 与 pdf 导出真的实现了，而且只剩一条下载路径

`lib/artifacts/export/` 渲染每种格式。SVG 走 `Image` + canvas；`html` 走离屏的
**非沙箱**同源 iframe——因为 html2canvas 读不进沙箱化的预览框，而内容会先经
`DOMPurify` 消毒，这正是可以去掉沙箱的前提。带 renderer profile 的类型
（`chart`、`mermaid`、`math`）从其挂载节点栅格化，取不到时抛
`ArtifactPreviewNotMountedError`，而不是返回一张空白图。

`react` 只提供 `raw`：对未执行的 JSX 做离屏截图就是一个空白矩形，假装可以是比
拒绝更糟的失败。

三条互相矛盾的下载路径——面板的、面板的「导出为」、以及聊天卡片那个把 chart 存成
`chart.chart` 的 `text/plain` blob——现在全部走 `exportArtifact`。

### 4. 工作流可以触达两者，并有三处刻意的缺席

`action.artifact.{create,update,get,export}` 与 `action.canvas.{create,get}`。
写入走 `runArtifactBuiltinTool`，评审门与版本递增只有一份实现。读取刻意**不**复用：
那个 runner 会截到 8 KB，因为它的消费者是上下文窗口，而工作流的消费者是代码。

`export` 返回字节而不调用 `saveExport`——后者在桌面会弹出原生保存对话框，会把
无人值守的运行卡在一个没人应答的模态框上。

刻意缺席：`delete`（无人值守地删掉用户保存的产物是同意面问题）、`canvas.update`
（canvas 文档是编辑器缓冲，权威副本是 `editorRef.current.getValue()`，后台写入
要么暂存一个没人接受的 diff，要么覆盖某人正在敲的字）、`canvas.open`
（在无头运行里「显示一个面板」没有意义）。

### 5. 八个模块选择退役而不是接线

它们各自都有一个已经在跑的更好实现；接线只会制造第二套机制。

| 退役 | 为什么不接线 |
| --- | --- |
| `lib/canvas/plugins/` | 与 `PluginExtensionSlot canvas.toolbar` + `lib/plugin/api/canvas-api.ts` 竞争的第二套 canvas 插件模型 |
| `use-chunk-loader` + `chunked-document-store` + `large-file-optimizer` | 在 Monaco 自己的虚拟化之上再做一层 JS 窗口化，两者互相打架 |
| `lib/sandbox/web/` | 它声称的调用方从未存在；`lib/native/code-execution-strategy.ts` 在每个壳里都能跑 JS/TS/JSX/HTML/CSS |
| `use-canvas-documents` | store 之上的薄排序门面 |
| `use-canvas-auto-save` | 持有 `localContent`，会与面板权威的 `editorRef.getValue()` 打架。它唯一更好的行为——切文档时取消挂起的那一 tick——被搬进了面板 |
| `version-diff-view.tsx` | 7 行的 re-export shim |
| `ArtifactListCompact` | 所有真实场景已被 `ArtifactTabStrip` / dock / `ArtifactList` 覆盖 |

两个值得留的休眠模块改为接线：`getCanvasPerformanceProfile` 现在驱动大文档的
**有意**降级（也是 `CanvasEditorContext.performanceMode` 的第一个写入方），
`ContextAnalyzer` 给 Canvas 建议加上作用域块——前提是先让它委托给已接线的
`symbolParser`，而不是自带第二个正则解析器。

## 后果

- 长 artifact 保住全文，旧 artifact 不再被淘汰。`cognia-artifacts` blob 降到 KB 级。
- 在大 canvas 文档里移动光标，不再把用户所有的 canvas 文档重新序列化一遍。
- 模型可以为它创建的东西命名，所以 chart artifact 带得上 `chartType`——这是启发式
  检测器产不出来的。
- 备份携带两张新表，按域导出的「Artifacts」读 Dexie。v206 之前写出的、artifact
  在 localStorage 快照里的包，仍然可以导入。
- manifest 变更跨 IPC 边界，所以 Jest 全绿不代表壳可用；`tauri-smoke` 才是那道门。

## 未决

**React artifact 预览仍然是坏的，修法卡在一次实测上。** 把运行时放到
`public/artifact-runtime/` 提供，前提是知道 `about:srcdoc` 子框架是否继承打包壳的
CSP（`src-tauri/tauri.conf.json`）；**若继承**，还要知道沙箱（opaque origin）框架
里的 `'self'` 是否匹配。两份调研从规范出发得出了相反结论。这必须在
`pnpm tauri build` 里量，不能在 `pnpm dev`（完全没有 CSP），也不能在
`pnpm tauri dev`（页面来自 `localhost:3000`）——正是这个歧义把
[ADR-0076](./0076-local-provider-management-transport) 的失败藏了好几个月。

结论会导向三种不同架构；同一个问题还决定另外七个「srcdoc + 内联脚本」功能是否
受影响：MCP Apps 沙箱、插件 webview、VS Code 扩展面板、`plan-html-view`、分享页的
`chat-animated`、`code-execution-strategy`、`task-resources-panel`。该实测，以及
按 artifact 单独授权的交互式 HTML，另行跟踪。

本次也未修复：`scripts/gates/check-network-egress.mjs` 看不见模板字符串里的
`<script src="https://…">`——它只扫 `fetch`、`new WebSocket` 与 `new EventSource`。
本次改动移除了应用里唯一一处，但盲区本身还在。
