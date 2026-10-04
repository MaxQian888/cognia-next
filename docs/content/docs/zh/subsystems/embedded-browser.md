---
title: 内嵌浏览器
description: 应用内的真实 webview，加上面向公网页面的远程 Chromium —— 一套与引擎无关的工具面、决定某个 URL 可触达哪个后端的 fail-closed 信任分级、操作录制与回放，以及 Chromium Cookie 导入。
---

# 内嵌浏览器

<Status variant="beta">Beta · ADR-0055 → 0072 → 0073</Status>

<TLDR>
  两个后端藏在同一个接口之后。`BrowserEngine`（`lib/browser/agent-engine.ts:28`）由
  `EmbeddedEngine`（原生 Tauri webview）与远程 Chromium 引擎分别实现，因此模型看到的工具面与引擎无关。
  某个 URL 能触达哪个后端不是偏好设置，而是一项安全决策：
  `resolveTrustTier()`（`lib/browser/protocol.ts`）把回环地址判为 `trusted`（开发预览 → 内嵌 webview），
  **其余一律**判为 `public`，并且 fail-closed —— 无法解析的 URL 一律按 public 处理。
  `EngineRoute` 把这个判定连同引擎一起传递，其中还包含一个显式的 `untrusted` 标志，
  含义是「页面内容必须按不可信处理」。
</TLDR>

<StatGrid>
  <Stat label="核心模块" value="14" hint="lib/browser —— 非测试 .ts，含 recording/" />
  <Stat label="UI 组件" value="12" hint="components/browser" />
  <Stat label="React hooks" value="8" hint="hooks/browser" />
  <Stat label="Rust 模块" value="5" hint="src-tauri/src/browser" />
  <Stat label="信任分级" value="2" hint="trusted（回环）· public（其余全部）" />
</StatGrid>

设计动机：Agent 循环见 [ADR-0055](../adr/0055-agent-browser-loop)，
录制见 [ADR-0072](../adr/0072-browser-action-recording)，
Cookie 导入见 [ADR-0073](../adr/0073-chromium-cookie-import)。

## 信任分级决定后端

```ts
type TrustTier = "trusted" | "public"
```

`localhost`、`127.0.0.1`、`::1` 属于受信的开发预览层，路由到内嵌 webview；其余一律为 `public`。
分类器刻意 fail-closed：若 `new URL(...)` 抛错，结果是 `public`，
而不是一个调用方可能忽略掉的错误。

这个判定是**随引擎一起传递**的，而不是在下游重新计算：

```ts
interface EngineRoute {
  engine: BrowserEngine
  backend: "embedded" | "local-chromium" | "user-chrome" | "remote-chromium"
  tier: TrustTier
  /** 页面内容必须按不可信处理（公网来源）。 */
  untrusted: boolean
}
```

正因为 `untrusted` 是路由的一部分，调用方不可能一边持有公网来源的页面，
一边以为自己看的是本地开发预览。

信任层级决定的是页面内容可信到什么程度，而不是由哪个引擎显示：在桌面端安装 Cognia 的本地 Chromium 之后，所有页面（包括 localhost，见 ADR-0214）都在同一个共享 session 中、调用方会话自己的页面上打开；安装之前由内嵌 webview 负责。

## 一套工具面，两个引擎

`BrowserEngine` 是两个引擎共同实现的权威接口，因此 Agent 的工具无需按后端分支。
围绕它的是 `lib/browser/protocol.ts` 中的共享页面交互契约 —— `ElementRect`、`ViewportSize`、
`ContentArea`、`BrowserSelection`、导航 / 加载信号，以及 `SnapshotNode`：
Agent 对页面无障碍树快照中的一个带 ref 的节点。Agent 从这棵树读取结构，而不是从像素。

`OutputDetailLevel`（`"compact" | "standard" | "detailed" | "forensic"`）控制一次工具调用返回多少页面内容 ——
这正是防止一次页面快照淹没上下文窗口的那个旋钮。

## 连接现有 Chrome 与 Edge 标签页

Playwright 插件提供两个 MCP 预设。`playwright` 启动隔离浏览器；
`playwright-existing-browser` 启动 `@playwright/mcp@latest --extension`，等待官方 Playwright
扩展授权用户选择的 Chrome 或 Edge 标签页。先安装扩展，再到 **设置 → MCP 服务器** 添加并
信任 Existing Browser 预设，把它挂到角色上，然后在扩展中选择标签页。任一端断开后，重新
启动 MCP 服务器并再次选择标签页即可；Cognia 不保存免审批 token。

该接入保持在 `BrowserEngine` 之外，公开的是上游 `mcp__...` 工具，而不是内部 `browser_*`
工具。它可以复用所选浏览器配置中的登录页面，但密码、OTP 与 token 仍须用户接管输入。
预设默认屏蔽 `browser_run_code_unsafe`，不启用 devtools、vision 或 PDF capability，并继续把
页面内容视为不可信。

内部控制面中，隔离 Chromium 支持新页面、原生拖放与对话框处理，以及 viewport、整页与元素
截图。内嵌 WebView 支持已有的双击、聚焦、缩放、查找与批量表单；不支持的请求会返回
`browser_feature_unsupported`。

## 代码位置

```
lib/browser/
  agent-engine.ts          # BrowserEngine 接口 · EmbeddedEngine · EngineRoute
  remote-chromium-engine.ts  # public 层后端
  remote-stream.ts         # 远程后端的帧流
  protocol.ts              # 共享契约 + resolveTrustTier + SnapshotNode
  client.ts                # 渲染端客户端
  agent-activity.ts        # 在聊天中呈现的活动事件
  annotation-queue.ts      # 浮层标注
  selection-source.ts      # 面板的元素拾取来自哪里（按引擎区分）
  pane-rect.ts             # webview 在应用布局中的几何
  cookie-import.ts         # Chromium Cookie 导入（ADR-0073）
  session-types.ts
  recording/
    recorder.ts · replayer.ts · protocol.ts · exporters.ts   # ADR-0072

src-tauri/src/browser/
  embedded.rs · overlay.rs · commands.rs · cookie_import/

components/browser/     # 12 个组件 —— 浏览器外壳、地址栏、浮层
hooks/browser/          # pane webview、历史、加载态、元素选择、
                        # 区域可见性、流程录制、选区→聊天
```

## 元素拾取、标注与 Adjust

两个桌面引擎运行同一份注入的 overlay（`lib/browser/overlay.injected.js`）：拾取器、悬停框和信息面板、多选/框选/文本选取，以及 Browser Adjust（`__cogniaAdjust`）。它们只有传输方式不同，`ElementSelectionSource`（`lib/browser/selection-source.ts`）替 `useElementSelection` 屏蔽了这一点：

- 内嵌 webview 用哨兵导航发出拾取信号，Rust 拦截后发出 `browser://element-selected`；面板通过 `browser_embed_*` 命令取回拾取结果。
- 本地 Chromium 和用户自己的 Chrome 通过 Playwright 绑定（`__cogniaSignal`）发信号，运行时把它转发为携带 `{pageId, count, generation}` 的 `element.selected` 事件，并按页面自行编号，刷新页面后也不会重复编号；显示该页面的面板通过 `browser.selection.drain` 取回。

`browser.select-mode`、`.selection.drain`、`.selection.clear`、`.selection.for-ref` 和 `browser.adjust` 各自只调用一个固定的 overlay 函数并传 JSON 参数，运行时会对页面返回的内容做大小限制和结构校验（`services/workspace-runtime/src/element-selection.mjs`）。它们都不是 `browser.evaluate`，所以在公网来源、用户输入过之后也能工作。选择卡片和标注队列在两个面板里是同一个组件（`BrowserInspectionRail`，ADR-0214）。

overlay 的其他上报（加载完成、SPA 导航、控制台、网络和 DOM 变化推送）同样靠哨兵导航传递，而只有内嵌 webview 会拦截它们。在 Chromium 中每次上报都会把页面带到错误页，因此运行时在 overlay 之前注入 `OVERLAY_TRANSPORT_SCRIPT`，把这些钩子设为空操作：Playwright 本来就会报告同样的信息。Chromium 还会在文档还没有根元素时就运行 init 脚本，所以 overlay 改为等有根元素后再挂载样式表（`appendWhenRooted`），而不是抛错导致整个 overlay 没有安装。

## 录制与回放

`FlowRecorder`（`lib/browser/recording/recorder.ts:38`）捕获一条浏览流程；
`replayer.ts` 负责回放，`exporters.ts` 将其转为可持久化的产物。
录制协议与实时浏览协议刻意分离，因此一条录制好的流程不会隐式依赖临时的引擎状态。

## 相关文档

<Cards>
  <Card title="ADR-0055" href="../adr/0055-agent-browser-loop" description="Agent 浏览循环与引擎无关的工具" />
  <Card title="ADR-0072" href="../adr/0072-browser-action-recording" description="操作录制" />
  <Card title="ADR-0073" href="../adr/0073-chromium-cookie-import" description="Chromium Cookie 导入" />
  <Card title="沙箱" href="./sandbox" description="远程 Chromium 后端被隔离的地方" />
</Cards>
