---
title: ADR-0055 — 智能体浏览器闭环
description: "为产品智能体提供基于内置 /browser 嵌入式 webview 的 snapshot→按 ref 操作→重新 snapshot 闭环（导航、带稳定 ref 的可访问性树快照、点击/输入/填充/选择/悬停、console 与 network 检查、截图），以受门控的插件工具暴露。第一阶段通过注入 JS 驱动应用内嵌入式 webview，保留人机共享面板；第二阶段为引导式——URL 信任等级路由把公开源标记为 untrusted，并将模型引导到另行接入的 Playwright MCP 工具（mcp__playwright__*）以进行稳健的公开站点自动化，因为渲染进程插件无法透明地调用外部 MCP 工具。"
---

# ADR-0055 — 智能体浏览器闭环

**状态**：已采纳（2026-06-25）
**作者**：Max Qian + Claude

## 背景

内置浏览器（`/browser`）此前是一个被动的、面向人的设计反馈工具：预览本地开发服务器，
让用户点选单个元素获取 CSS 选择器 / `outerHTML` / 文本并写评论发送到对话。所有浏览器
操作都仅限 UI——智能体无法导航、读取或操作页面。模型唯一的 Web 能力是独立的纯 HTTP
通道（`web_fetch` / `web_search`，无 JS 渲染）以及基于坐标的系统级 `computer-use`，
后者看不到嵌入式 webview 的 DOM。

业界智能体浏览器（Playwright-MCP、chrome-devtools-MCP，以及 Codex 自家的应用内浏览器）
在面向模型的设计上收敛到同一范式：模型的主要“视图”是**结构化的可访问性树快照而非像素**；
元素通过**快照中铸造的不透明句柄**（`ref` / `uid`）定位，默认不用原始坐标；闭环是
**snapshot → 按 ref 操作 → 重新 snapshot**；console 与 network 是一等的只读工具。

## 决策

为智能体增加 `snapshot → 按 ref 操作 → 重新 snapshot` 浏览器闭环，采用**混合、分阶段**：

- **第一阶段（本 ADR）——嵌入式引擎。** 通过注入 JS 驱动现有嵌入式 webview。保留人机
  共享、可见、可协同操作的面板（差异化卖点），零额外体积，且在三大桌面系统上均可工作。
  公开站点自动化仅为尽力而为。
- **第二阶段——引导至 Playwright MCP。** 复用既有的 `playwright-mcp` 预设
  （`plugins/playwright-mcp` 已存在）进行稳健的任意公开站点自动化。这是**引导式，而非
  第二个引擎**：渲染进程插件只能调用自己注册的工具（`invokePluginTool` 强制
  `tool.pluginId === pluginId`）；外部 MCP 的 `mcp__playwright__*` 工具位于 sidecar，
  只能由模型自身的工具调用循环触达，因此进程内透明委派不可行。取而代之，信任等级路由把公开源
  标记为 `untrusted`，并由 `browser_navigate` 结果的 `hint` 与 `browser-tools:availability`
  上下文共同引导模型在该服务器接入时直接调用 `mcp__playwright__*`。相对预设零额外体积。

在 macOS/Linux 上，共享视图保真度与完整 CDP 能力互斥：驱动自家嵌入式 webview 受限于
注入 JS 能力但能让人留在闭环中；独立无头 Chromium 拥有完整 CDP 但不可见。第一阶段取
嵌入式路径，第二阶段把公开站点工作交给收益更高的 Playwright MCP。

## 关键通道

预览页面是远程上下文，无 IPC 桥。关键支撑是 Tauri 2.11.1 的 **`Webview::eval_with_callback`**，
它把 JS 执行结果序列化为 JSON 交给 Rust 回调，在三种引擎（WKWebView / WebView2 /
WebKitGTK）上均可用。`eval_embed_with_result` 通过 oneshot + 10 秒超时把该回调桥接为异步
命令——因此旧的 `cognia.invalid/__cognia_select` 哨兵导航技巧不再是唯一的页面→Rust 通道
（仅保留用于人工点选）。在 Windows 上 `eval_with_callback` 会吞掉异常，故每个注入函数都用
`try/catch` 包裹并以错误值返回。

## 纪律与安全

- `snapshot → 操作 → 重新 snapshot`：每个变更类工具内联返回新快照；ref 携带 `generation`。
- 协议白名单仍为 http(s)；`public` 等级标记为 `untrusted`（防提示注入），智能体绝不自动填入密钥。
- `browser_evaluate`（裸 JS，RCE 级）在第一阶段**不注册**，后续作为独立门控、默认关闭的工具。
- `browser_screenshot` 复用已通过单测的、基于区域的 `browser_embed_capture`
  （即人工选区→对话流程已依赖的 `compute_embed_capture_region` 几何），而非重新推导截图边界：
  预览面板把保留区域 rect 发布到 `lib/browser/pane-rect` 单例，引擎据此截图。仅作视觉兜底——
  模型按设计以结构化快照为主。

第一阶段已暴露的工具：`browser_navigate`（含 `browser_back/forward/reload/stop`）、
`browser_snapshot`、`browser_click/type/fill_form/select/hover`、`browser_wait_for`
（等待文本出现/消失）、`browser_screenshot`（PNG 视觉兜底）、
`browser_read_console/read_network`、`browser_get_page`。

## 第一阶段诚实的能力边界（注入 JS 上限）

1. 跨源 iframe 对快照 / console / network / 操作均不可见。
2. 合成事件 `isTrusted:false`，剪贴板 / 文件选择器 / 部分反爬流程会拒绝。
3. 网络**响应体**不可得（仅状态/时延）。
4. 闭合 shadow DOM 不可达；开放 shadow DOM 需显式穿透。

这些对主要的 localhost 场景已足够，且正是 Playwright MCP 所修复的——这也是公开源引导至该处的
原因；它们以明确的限制形式告知模型，而非静默缺口。

## 后果

- 智能体现在可以在用户观看的同一面板中自检并驱动本地开发预览，补齐了原浏览器功能最大的缺口。
- 公开站点自动化以零额外体积复用既有 Playwright MCP 预设；模型按信任等级在两套工具族之间切换，
  而非由宿主透明地切换引擎（渲染进程插件无法做到这一点）。
- 实时 webview eval 桥（`eval_with_callback`）无法被 jest 或 cargo 单测覆盖；以
  `pnpm tauri dev` 跑一次 snapshot→点击→snapshot 闭环作为人工冒烟门。
