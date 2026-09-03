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
