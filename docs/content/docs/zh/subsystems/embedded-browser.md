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
  backend: "embedded" | "remote-chromium"
  tier: TrustTier
  /** 页面内容必须按不可信处理（公网来源）。 */
  untrusted: boolean
}
```

正因为 `untrusted` 是路由的一部分，调用方不可能一边持有公网来源的页面，
一边以为自己看的是本地开发预览。

## 一套工具面，两个引擎

`BrowserEngine` 是两个引擎共同实现的权威接口，因此 Agent 的工具无需按后端分支。
围绕它的是 `lib/browser/protocol.ts` 中的共享页面交互契约 —— `ElementRect`、`ViewportSize`、
`ContentArea`、`BrowserSelection`、导航 / 加载信号，以及 `SnapshotNode`：
Agent 对页面无障碍树快照中的一个带 ref 的节点。Agent 从这棵树读取结构，而不是从像素。

`OutputDetailLevel`（`"compact" | "standard" | "detailed" | "forensic"`）控制一次工具调用返回多少页面内容 ——
这正是防止一次页面快照淹没上下文窗口的那个旋钮。

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
