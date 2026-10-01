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
`lib/ai/agent/external/session/event-to-parts.ts`，逻辑完全重复）也都已经会把这样一次调用
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

**修订（2026-09-29）：第 9 个工具 `artifact_capture`。** 它不是 `artifact_render`
的回归：它不为用户绘制任何东西，而是把已绘制的像素以 MCP image 块经同一条中继
交还给**模型**，让 agent 能检查原本只能盲交的图表、页面或工作簿。插件渲染器通过
自身的 `mount → ready → dispose` 契约在屏幕外挂载（`ArtifactRendererHandle.ready`，
由异步绘制的渲染器实现）；Recharts / Mermaid / React 的实时预览只存在于 dock 中，
因此这类工件会先被展示再在 dock 里截取（`lib/artifacts/capture.ts`）。只读，所以
是 `allow`。

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

`react` 曾经也只提供 `raw`，理由相同：对未执行的 JSX 做离屏截图就是一个空白矩形。
现在它也提供 `png` 与 `pdf`，办法是向仍在运行的帧索取一份「它画出了什么」的快照
（见下方修订）。原文保留于此：假装可以是比
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

## 已解决 —— srcdoc CSP 实测

**已有答案。** 在 macOS / WKWebView 上，针对一个**不带 `cfg(dev)`** 编译的 Tauri
壳实测：它逐字携带 `src-tauri/tauri.conf.json` 的 `csp`，并通过 asset 协议在
`tauri://localhost` 提供页面。所执行的策略是从真实
`securitypolicyviolation` 事件的 `originalPolicy` 读回来的——所以这是壳**实际下发**
的策略，不是配置文件的说法。

| 问题 | 答案 |
| --- | --- |
| `about:srcdoc` 子框架是否继承壳 CSP？ | **继承** —— 逐字继承，连 tauri 注入的 5 个脚本哈希都在 |
| 沙箱（opaque origin）框架里 `'self'` 是否匹配？ | **匹配** —— 同源 `<script src>` 能加载，内联被拒 |
| `blob:` 文档能绕过吗？ | **不能** —— 无论是否沙箱，同样继承 |

两份策略是**取交集**的。这正是今天这套写法致命的原因：一个 meta 写着
`script-src 'unsafe-inline'` 的框架，在继承的 `script-src 'self' 'wasm-unsafe-eval'
blob:` 之下，**什么都跑不了**——内联被继承的那份划掉，同源 URL 被自己那份划掉。
实测该框架的三个脚本一个都没执行。

因此采用表中第二种架构，**壳 CSP 零改动**。这样的框架里仍能跑的只有两样东西，
预览就只用这两样搭：

- **同源 `<script src>`** —— `/artifact-runtime/react-runtime.js`（React 19 +
  `react-dom/client`，production 构建）与 `/artifact-runtime/artifact-shell.js`
  （框架内引导器）；
- **`blob:` 脚本** —— artifact 自身的代码经宿主转换后由此进入。`blob:` 在两份
  策略里都在，不需要新增任何许可。

JSX 在**宿主**侧、在 Worker 里编译（`worker-src 'self' blob:` 本就允许），所以
`@babel/standalone` 不进框架，任何一处都不需要 `'unsafe-eval'`。框架终其一生只有
一个 `ReactDOM.createRoot`，因此内容更新是就地重渲染，而不是整帧重导航。

在该壳内以生产模块端到端复核过：一个 React artifact——包括用 ESM 写的那种（旧壳
根本解析不了）——**零外部请求**渲染成功；第二个版本渲染进同一个存活的框架，
**0 次 iframe 导航**。

**交互式 HTML artifact**（`artifacts.interactiveHtml`，默认关闭，开启后仍按
artifact 单独授权）同样由这次实测决定，而不是 `srcdoc` + `'unsafe-inline'`——后者
在这里一行都跑不了。`lib/artifacts/interactive-html.ts` 把所有可执行字节从标记里
提出来：按文档顺序的内联 `<script>` 正文，以及被改写成 `addEventListener` 的 `on*`
属性——处理函数体仍然是**源码**，绝不交给 `new Function`。它们作为有序的 `blob:`
脚本回到框架。第三方 `<script src>` 被丢弃并如实告知，因为框架的策略里没有任何
外部源。框架不带 `allow-same-origin`，artifact 以 opaque origin 运行：拿不到宿主、
拿不到 Cookie、拿不到存储、也上不了网。

### 另外七个 srcdoc 功能

这七个用的正是实测判死的那套写法——`sandbox="allow-scripts"` + `srcdoc` + meta
CSP 的 `script-src` 只写 `'unsafe-inline'`。在打包桌面壳里**它们的脚本一律跑不了**：
MCP Apps 沙箱、插件 webview、VS Code 扩展面板、`plan-html-view`、分享页的
`chat-animated`、`code-execution-strategy`、`task-resources-panel`。每一个的修法都
相同——把框架内代码改成从 `'self'` 或 `blob:` 脚本供给——但每一个都是独立改动，
各自开单跟踪。本批不动它们。

仍未修复：`scripts/gates/check-network-egress.mjs` 看不见模板字符串里的
`<script src="https://…">`——它只扫 `fetch`、`new WebSocket` 与 `new EventSource`。
本次改动移除了应用里最后一处，但盲区本身还在。


## 修订（2026-09-03）：React artifact 支持导出 PNG

上面的「决定」只给了 `react` 一个 `raw`，而 `runtime-adapters.ts` 里的注释把原因
归给「离线 runtime 还没落地」。那个理由在本 ADR 自己让 runtime 落地时就过期了，而
真正的阻塞从未被写下来：React artifact 的帧是 `sandbox="allow-scripts"` 且没有
`allow-same-origin`，父窗口读不进去；而对**源码**做离屏重渲染，截到的是没有执行过
的 JSX。

在帧内栅格化同样不成立，这一点值得记下来，因为它正是最容易想到的做法。html2canvas
会把文档克隆进一个子 iframe 再读回来，而一个不透明源（opaque origin）的文档，连自
己的 `about:blank` 子帧都读不了。用与预览完全相同的方式构造帧、在浏览器里实测：
`contentDocument` 返回 `null`。canvas 与 `toDataURL` 在里面是可用的，但根本没有办法
先把 DOM 弄进 canvas。

所以帧改为**序列化**而不是栅格化。新增的 `capture-snapshot` 消息向它索取一份「它画
出了什么」的静态 HTML 文档，父窗口再把这份快照放进它本来就用于 `html` artifact 的
同源截图帧里渲染。快照里的脚本由既有的净化器剥掉，这在此处是正确的：快照是执行**之
后**的 DOM，脚本已经跑完了。

需要知道的后果：

- **`react` 的 `png`/`pdf` 需要预览处于挂载状态**，这一点和其他所有类型都不同。取不
  到时导出器抛 `ArtifactPreviewNotMountedError`，而不是给出一张空白图。
- **渲染失败的帧会拒绝被截取**，否则它会老老实实序列化一个空 body，导出一张没有任何
  解释的空白 PNG。
- **runtime 构建的新鲜度哨兵现在会把 shell 的源码一并哈希。** 它此前只看 react/babel
  版本和**产物**哈希，于是改动 `artifact-shell-entry.ts` 会让已提交的 bundle 变陈旧，
  而构建还报告「already fresh」。本次的截取处理器正是写好、测好、却被静默地没有发
  布，直到这个哨兵被修好。

## 修订（2026-09-05）：在现有架构上完成 Canvas

七项改动，全部已落地。没有 V2，没有并行的第二套 Canvas，没有第二个 store，也没有替代路由。下面记录每一项的发现，因为多数情况下界面早已存在，发现的是它背后什么都没有。

### 一个文档属于一个工作区

每个 Canvas **列表**读取的都是原始的 `canvasDocuments` map。切换工作区后，上一个工作区的文档还留在侧栏里；`canvas_read` / `canvas_update` 只按 `sessionId` 划定范围，于是在一个工作区里运行的模型或插件可以读取并改写另一个工作区的文档。

`getCanvasDocumentsForWorkspace` 与 `getCanvasDocumentForWorkspace` 是所有界面共用的两个带范围的读取。按 id 读取的那个，对「不是你的」和「不存在」都回答 `null`，所以两者的差别无法被用来枚举别的工作区。没有 `projectId` 的文档按旧规则放行，与 `applyArtifactWorkspaceFilters` 一致，因为 v86 的回填会在下次启动时给它们补上。

### 关闭不等于删除

Canvas 没有「已打开 vs 全部」的状态，所以标签条上的 X 调用的是 `deleteCanvasDocument`：关掉一个标签页就毁掉了文档、它的版本和评论，没有提示，也无法撤销。

`useCanvasLayoutStore.openDocIds` 就是这个状态。它是每个用户的布局偏好，而不是文档的属性，因为共享同一文档的两个人并不共享同一条标签条。删除保留原义，新增一个说明哪些东西会随文档一起删除的提示，并释放置顶、标签页和评论线程。artifact store 之外的持有者通过 `lib/canvas/document-disposal.ts` 放手，这是一个与 `registerProjectBucketPurger` 同形的注册表，这样一个被持久化、几乎处处被导入的 store 就不会把评论 store 的 localStorage 迁移拖进每个使用方。

### 只有一条 AI 路径

原来有两条。`useCanvasActions` 自己拼提示词，并用 `hasNoLeakingPii` 把关。`lib/plugin/api/canvas-api.ts` 调用 `executeCanvasAction`，后者拼的是**另一份**提示词（附件、按动作区分的温度），而且什么都不把关。插件拿到的是更丰富的提示词，却没有脱敏检查。

现在两者都调用 `runCanvasAction` / `streamCanvasAction`，把关放在里面，而不是散在每个调用点。另有三个动作此前是不可观测的：`review` 和 `explain` 把文本写进编辑器面板里一个没有任何东西渲染的 `useState`，`run` 则让模型在一个真能运行代码的面板旁边**想象**执行代码。现在 `review` 产出带锚点的建议，`explain` 在 AI 面板中渲染，`run` 交给执行面板。

`CanvasAIWorkbenchState` 有六个字段，却完全没有写入方。现在每个字段都有控件和写入方，只有 `pendingReview` 例外：它是 `pendingReviews[documentId]` 的第二份拷贝，于是被删除，而不是去保持同步。建议通过 `generateObject` 按一个 zod schema 返回，取代了原先从 `indexOf("{")` 切到 `lastIndexOf("}")`、再用手写 `typeof` 过滤的做法，后者会静默丢掉它不认识的东西。

### 你接受的 hunk 就是你读到的 hunk

审阅界面渲染的是 `computeDiff`，一个 LCS diff。而 hunk 来自另一套手写的、只向前看五行的 diff。遇到整块移动时，两者对哪些行变了意见不一，于是一个被接受的 hunk 会被应用到读者从未看到过的行号上。现在只有一个 diff，并有一个往返测试，两者一旦再次分叉就会失败。

陈旧状态原本是一个 `isStale` 标志，要靠 `updateCanvasDocument` 记得去设置。现在它由内容指纹（`lib/canvas/content-hash.ts`）推导而来。这很重要，因为被接受的 hunk 是**按行号**应用的：针对已被移动过的内容应用一份提议，会在没有任何报错的情况下损坏文档。同一个指纹也让持久化提议变得安全，于是一个打开着的审阅能在重新加载后保留下来，而不必为了保证它不陈旧而被丢弃。

### 新建的文档可以是一份真正的文档

每个入口跑的都是同一个没有标签的调用：一份标题为「Untitled」的空 Markdown 文档。一个用来编辑文档的子系统，竟然不能从文件打开文档。现在的对话框会询问名称、语言、起始正文或文件。

导入复用 `@cognia/document`，也就是聊天附件和知识库已经在用的解析器，并回答它不回答的两个 Canvas 特有问题：它会变成哪种编辑器语言，以及转换过程中丢失了什么。文本和代码逐字节原样到达。PDF 或 Office 文件会变成可编辑的 Markdown，并在创建任何东西之前说明这一点。

起始内容刻意既不用统一模板平台（ADR-0100），那是给可安装、可分享、带参数的模板用的；也不用编辑器代码片段注册表，那会在缓冲区里留下 `${1:name}` 这样的 tab 停靠点。

### 停止就是停止解释器

取消一次 Python 运行，中止的是一个 Rust 侧从未看见的 `AbortController`。UI 脱离了，子进程却一直跑到 30 秒超时。现在每次运行带一个 id，`canvas_cancel_python` 会杀掉它，正在进行的调用会返回程序在被终止前已经产生的输出。

注册表持有的是**取消信号，而不是子进程**：`wait_with_output` 会消耗句柄，所以把子进程停放在注册表里，就意味着要再把它取出来才能等待，而在等待期间到达的取消会扑空。管道在各自的任务上被排空，所以一个写出超过管道缓冲区的程序，不会让取消本该拯救的那次运行陷入死锁。

「设置 → Canvas → 执行」有七个控件，却没有读取方。现在其中三个被读取。另外四个被**移除而不是禁用**：`autoExecute`、`preserveVariables`、`sandboxMode` 和 `pythonRuntime`。后两者看上去是安全与能力控件，实际上什么也不做，而真正的隔离在 `AppSettings.canvasCodeSandboxEnabled`（设置 → 沙箱）。某种语言能否运行，在点击之前就向宿主询问。

### 一个真正的 CRDT，以及只携带 id 的链接

旧的 CRDT 是基于位置的，而且**没有变换**。一个操作是一个绝对字符索引，被拼接进接收方已经被改动过的字符串，所以两个人同时在索引 10 处插入，双方都在原始索引 10 处应用，文档就此分叉，而两边的 `version` 都在递增。它唯一的冲突机制是一个因果门，会**丢弃**它无法排序的东西，没有缓冲，也没有重试，因此一次乱序投递就会永久丢失。

**Yjs 是新增的依赖，也是唯一新增的依赖。** 本仓库在 JS 或 Rust 里都没有可复用的 CRDT，而手写一个正是上面那套实现的由来。其他一切都是复用的：`lib/artifacts/diff.ts` 里的 LCS diff、用于导入的 `@cognia/document`，以及编辑器用 CodeMirror 6，而不是再加第二个编辑器框架。

`deserializeState` 已被删除。它解析攻击者提供的 JSON，并照单安装其中描述的任何会话、参与者和权限，而分享链接和任何类型为 `"sync"` 的入站帧都能触达它。现在状态以不透明字节的形式到达，只能合并进客户端已经加入的会话。

分享链接原先携带会话、它的所有者、参与者、权限标志、内容和整份操作日志，外加一个 `?server=` URL，加入页会把它写进持久化设置并置 `enabled: true`，对 scheme 和 host 不做任何校验。现在它只携带三个标识符。原先的两半对编码方式也意见不一，所以本应用生成过的任何链接都解码不了，而页面却在什么都没加入的情况下报告成功。

## 修订，2026-09-05：协同平面学会承载 Canvas 文档

上一条修订记录了 `cognia-collab-server` 不提供任何 Canvas 路由，因此传输层不可达，并以关闭的方式失败。现在它提供这些路由，客户端也能到达它们。

### 服务端不链接 Yjs，也不需要

`canvas_document_updates` 与 `canvas_documents.snapshot` 中的每个载荷都是不透明的更新。服务端给它们排序、按序交回、拒绝重复的操作 id，且从不解码任何一条。这之所以成立，是因为 Yjs 更新满足交换律：一个加入者先应用快照，再依次应用其后的每条更新，无论这些写入以什么顺序落地，最终都会到达与所有人相同的状态。

出于同样的原因，压缩是客户端的行为。一个持有完整文档的对端发送 `Y.encodeStateAsUpdate`，并注明它覆盖到的序号，序号不超过它的行就此变得多余。只有维护者可以这样做，因为来自落后对端的快照会淘汰它从未见过的编辑；而且存储会拒绝一个让标记回退、或越过现有范围的 `coversSequence`。

因此 `yrs` 不进入构建。两侧唯一新增的依赖，就是客户端本来就需要的那一个。

### 成员关系沿用工作区

没有按文档的成员表。Canvas 文档不像共享聊天会话那样逐个邀请，所以在 `workspace_memberships` 旁边再建一套成员系统，只会多出一个让两者彼此漂移的地方。`CanvasAction` 映射到已有的角色阶梯上：viewer 读取，member 编辑和评论，maintainer 删除、压缩并管理分享。组织的 owner 或 admin 以维护者身份进入，这由 `resolve_workspace_access` 决定，而不是由 Canvas 模块里的任何东西决定。

工作区之外的调用者收到 404 而不是 403。向他们确认某个 id 确实对应一份他们看不到的文档，本身就是泄露。

### 鉴权逐帧进行

票据证明的是持有者 30 秒前能读，而一条连接能存活数小时。每个入站写入都会重新解析调用者的工作区角色：在一个本来就要插入和更新的事务旁边多做一次带索引的查找。这样把某人移出工作区，会在下一次按键时就停止他的输入，而不是等到他下次重连。

### 离线队列之所以可行

`(document_id, operation_id)` 是唯一的。排空中途被打断，客户端就不确定哪些写入已经落地，而诚实的恢复方式是把它们全部重发：第二次尝试会返回已经存储的那条更新，而不是把这次编辑记录两遍。同样的性质也让 `POST .../updates` 能同时服务实时路径和追赶路径。

### 客户端这一半

provider 不再持有 URL 或令牌。它接收一个工厂函数，每次重试都重新调用一次，这一下回答了三个不同的问题：渲染进程里一个裸的 `WebSocket` 会错过桌面端的代理设置；一次性票据无法在重连时重放；而由调用方提供 URL，恰恰是旧加入页把传输层指向任意主机的方式。

Canvas 的调用走 `CollabClient`，共用它的授权缓存、遇到 401 重试一次的逻辑，以及它的传输。分享链接现在携带来自登录绑定的真实组织，取代了任何服务端都不可能认可的字面量 `"personal"`。

有两处行为变化值得点名。连接失败时报告 `error` 而不是 `disconnected`，这样一个被拒绝的连接就能与从未尝试过区分开。重连时以真正的参与者身份重新加入，而不是以一个灰色、名为 `"Reconnecting..."` 的参与者加入，那正是对端以前在成员列表里看到的。

默认关闭，由 `COLLAB_CANVAS_ENABLED` 控制。

## 修订，2026-09-05：编辑器接入文档，评论随之移动

上一条修订把编辑器绑定和评论锚点列为未决。两者现在都已落地。

### CRDT 只能接收，从不发送

`applyLocalUpdate` 是唯一会产出待广播操作的东西，而它在生产代码中没有调用者。每一次真实的编辑都从编辑器流向 artifact store 就停住了，所以 `Y.Doc` 只有在对端改动时才会变。两个人编辑同一份文档，会看着对方的改动陆续到达，而自己的改动一条也发不出去。

现在 Monaco 和 CodeMirror 都写入 `Y.Text`，由一条文档级的更新总线察觉。关键正在于监听文档，而不是某一个调用点：AI 应用、模型工具写入和插件写入都以同样的方式发出，它们谁都不需要知道协同的存在。总线按一个「远端」哨兵来过滤，而不是按一份本地来源的清单，因为列出本地来源就意味着每条新的改动路径都得记得把自己加进去，而忘记的后果是一次没有任何人收到的编辑。

绑定生效期间，`Y.Text` 拥有这些字符，store 的 `content` 是它的防抖投影，所以预览、导出、AI 动作、大纲和版本历史继续读同一个字段，谁都不需要了解 CRDT 是什么。

编辑器通过订阅注册表找到自己的会话，而不是自己持有一个。会话属于协作面板，一个兄弟组件；把它提升到 `crdtStore` 旁边的第二个状态容器里，就会让会话同时住在两个地方。

### 评论指向字符，而不是索引

评论原本以绝对偏移量和一个修订号固定，修订号一变，`isContextCommentAnchorStale` 就把整个线程置灰。对偏移量而言，这是唯一诚实的做法，因为顶部加一行就会让其下的所有偏移失效；但这意味着评论会因为与它毫不相干的编辑而变陈旧。

Yjs 相对位置能在插入、删除以及他人的并发编辑之后依然有效。两端向外粘附，所以贴着任一边界打字，都会落在评论范围之外：评论针对的是当时在那里的那些字符，而不是之后追加到它们旁边的内容。

删除被评论的片段时，两端会塌缩到同一点上，而不是解析失败；因此一个原本覆盖着内容、如今塌缩了的范围，会被解读为文本已被删除。如果把那个空位置报告出去，评论就会被渲染成针对塌缩落点的内容，而那个落点是文档开头。

这一切都是增量的。存储的偏移量保留下来，没有实时文档的设备读的就是它们；面板只在显示时做解析，通过一个其他所有资源都不设置的 prop。

### 真正决定了什么的设置，以及两个什么也没决定的设置

四个协作设置有了读取方：`showCursors`、`showSelections` 和 `cursorSmoothing` 构成绘制远端装饰所用的样式表，`presenceTimeout` 是 awareness 协议自身的空闲截止时间。`showAvatars` 就是参与者列表。用 CSS 隐藏装饰、而不是扣下 awareness，是刻意为之：这样重新打开设置时，显示的是对端此刻的位置，而不是在对方下次打字之前什么都不显示。

另外两个按执行设置那一节同样的理由被移除。`serverUrl` 指向一个没有任何东西读取的信令服务器，而协同平面在哪里，早已由 `lib/collab/connection.ts` 决定。`syncInterval` 是一种本系统并不存在的轮询模型的节奏，把这个名字重新绑定到本地保存的防抖上，只是换个标签，而不是接线。

### 刻意仍未决定的部分

- **离线重放队列在内存中。** 连接断开时被拒的帧会被排队，并在重连时刷出，这覆盖了短暂断线，但覆盖不了重新加载。持久队列是一张增量的 Dexie 表，不在这一批里。
- **评论锚点还没有到达服务端。** `canvas_comments.anchor` 存放 Yjs 相对位置，客户端也会计算它，但 Canvas 评论仍然住在本地的 `contextComments` 表里。通过协同平面的评论路由同步它们，是剩下的另一半。
- **富文本 Markdown 编辑**尚未发布。计划中点名的是 Milkdown。复用路径是在 `@codemirror/lang-markdown` 之上用 CodeMirror 6 的装饰实现，它本来就是依赖；而且与 ProseMirror 的往返转换不同，它不会丢失不受支持的结构，因为缓冲区始终是 Markdown。

## 修订（提议中），2026-09-30：Canvas 协同默认开启之前必须成立的条件

**本修订状态：** 提议中。来源研究为 `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md`，缺口 A5。

那几条修订有意留下三个未决项；拿客户端和服务端对照时又发现第四个：本 ADR 选定的压缩方式没有任何触发点。`CollabClient.pushCanvasSnapshot` 和 `pullCanvasUpdates` 在 `lib/collab/client.ts` 中存在，却没有调用者；`listCanvasComments`、`createCanvasComment`、`listCanvasVersions`、`createCanvasVersion`、`readCanvasPresence` 也一样。服务端的 `canvas_document_updates` 因此无限增长，新加入者要重放写入过的每一条更新。

这里不推翻上文的任何决定：服务端依然从不解码更新，`yrs` 依然不进入构建。

### 1. 重放队列在重新加载后仍在

`CanvasWebSocketProvider.messageQueue` 改为一张 Dexie 表的投影：`canvasPendingUpdates: "[documentId+operationId], documentId, queuedAt"`。这需要修改 `CURRENT_SCHEMA`、提升版本号，并加入 `CORE_TABLE_NAMES`。本地更新先写入这张表，再交给连接发送；服务端确认（即存储后的行）回来时删除。

服务端的 `(document_id, operation_id)` 本来就唯一，所以重新加载后清空这张表，与内存队列在短暂断线后的重发一样安全。这张表只在本地，从不同步到配对手机：未发出的编辑属于做出它的那台设备。

### 2. 由维护者的客户端按规则压缩，而不是手动

压缩仍是维护者的行为，这一点沿用原决定。变化在于：维护者的客户端现在无需被要求就会执行压缩。

- **何时执行：** 快照标记之后的更新超过 500 条，或总量超过 2 MiB。客户端从加入时本就要拉取的 `pullCanvasUpdates` 分页中得知这两个数。
- **由谁执行：** 完全同步的维护者，即 `canvasPendingUpdates` 中没有待发行、且已追上流的最新位置。若有多位这样的维护者，由 awareness `clientID` 最小的那位执行。
- **发送什么：** 通过 `pushCanvasSnapshot` 发送 `Y.encodeStateAsUpdate(doc)`，`coversSequence` 为它已应用的最后一个序号。存储已经拒绝回退或越过现有范围的标记，所以两位维护者竞争的代价只是一次白费的上传，不会丢编辑。

没有维护者在线的工作区，会一直等到有维护者上线才压缩。这正是当初选择「只有维护者可以压缩」的用意。

### 3. 评论和命名版本迁到协同平面

- Canvas 评论从 `contextComments` 迁到协同平面的评论路由，并带上上文修订中已经计算好的 Yjs 相对位置锚点。
- 文档转为协同时，其上已有的本地评论由所有者通过一个明确的「带上评论」步骤发布一次。这与共享聊天的「显式转换」规则一致。
- 命名版本通过 `createCanvasVersion` 在协同平面上创建，入口是已有的版本历史面板（`components/canvas/version-history-panel.tsx`）。
- 本地、非协同的文档继续使用 `contextComments` 和本地版本，对它们没有任何变化。

### 4. 只凭证据翻转默认值

只有下列条件全部满足时，`canvas.collaboration.enabled`（`types/canvas/settings.ts`）和 `COLLAB_CANVAS_ENABLED` 才改为默认开启：

- 第 1–3 项已发布；
- 该改动在 CI 的 `postgres-rls` 任务（`.github/workflows/test.yml`）中通过，且 Canvas 路由在其覆盖范围内；
- 两台机器的 `tauri-smoke` 通过：并发输入、在连接断开时中途重新加载、在第二台机器上观察到一次压缩；
- 子系统文档 `subsystems/canvas/collaboration.mdx` 描述的是实际发布的 Yjs 架构。它已于 2026-09-30 按代码重写，第 1–3 项落地时须随之更新。

### 本修订之后仍未决定

- **富文本 Markdown 编辑**，与上文未决列表相同。
- **在线状态**：目前是 awareness 协议按文档维护的。与设备、共享聊天共用的在线状态模型是来源研究中的路线图 P2-12 项，不属于本修订。
