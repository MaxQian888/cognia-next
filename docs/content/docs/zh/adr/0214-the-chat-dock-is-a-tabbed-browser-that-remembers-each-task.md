---
title: "0214 — 聊天右侧栏是会记住每个任务的标签式浏览器"
description: "会话摘要不再是一列会挤掉产物右侧栏的侧栏，改成 Codex 式卡片：挂在标题栏按钮下，或悬浮在聊天列旁的空白处。桌面端右侧栏只有一条标签栏，混排会话面板、产物、本地 Chromium 页面和一个 React 新标签页；新标签页不会启动 Chromium。每个会话记住右侧栏开关、标签顺序和当前标签，宽度全局共用。网页（含 localhost）默认用本地 Chromium，单个标签可切到系统 webview 的轻量预览。任务切到后台时关闭它的页面，正在运行的除外。窗口变窄时依次：右侧栏缩小、左栏临时收成图标条、右侧栏改为浮层。"
---

# ADR 0214 — 聊天右侧栏是会记住每个任务的标签式浏览器

**状态：** 已接受
**日期：** 2026-10-03
**修订：** [ADR-0098](./0098-persistent-workbench-rail)（聊天右侧栏的开关不再全局唯一）、[ADR-0201](./0201-the-desktop-browser-runs-chromium-locally)（后端表：localhost 默认走本地 Chromium）
**相关：** [ADR-0083](./0083-context-workbench)（scope 与保留策略）、[ADR-0121](./0121-workbench-mobile-drawer-and-panel-customization)（隐藏的面板仍可到达）、[ADR-0123](./0123-context-workbench-vertical-split)（不重新挂载）、[ADR-0055](./0055-agent-browser-loop)（智能体浏览器循环）

## 背景

会话摘要是一张 320px 卡片，渲染在产物右侧栏旁预留的 `<aside>` 里。打开它会收起右侧栏，右侧栏的任何展示又会关掉它，所以摘要和它描述的产物不会同时出现在屏幕上。卡片最显眼的是五行配置，结果只剩数字。

标签模式下右侧栏有两排标签（`ArtifactTabStrip` 和工作台面板标签），本地 Chromium 在浏览器面板里再加一排。没有产物的会话打开后只看到“还没有产物”。右侧栏开关是所有会话共用的一个持久化布尔值：ADR-0098 这样设计，是为了避免在**产物标签**之间切换时右侧栏反复开合。

工作台的 `activatedPanelIds` 按资源 scope 存储，同时承担标签列表、挂载门控和生命周期记忆，而且不带任何附加数据，放不下一个包含网址的有序标签列表。

## 决定

### 摘要卡片

- 卡片挂在聊天标题行的触发按钮下（桌面端位于标题栏 `actions` 出口），用 Radix Popover 渲染，限制在聊天区域内。右侧栏关闭、且聊天列旁边的空白放得下时，改为悬浮在空白处。
- 宽度为 `min(288px, 聊天宽度 − 16px)`。卡片不写 `dockCollapsed`，也不写 `userDismissed`。
- 内容：项目与分支；运行进度（仅运行中）；等你处理（仅有待处理项时）；改动及 `+/−` 行数；产物；来源（可添加，带“查看全部”）。每一行打开右侧栏对应的标签；“查看全部”打开 `metadata`（任务概览）面板。
- 每行可设为“总是 / 有内容时 / 隐藏”，存在 `AppSettings.sessionSummaryCard`。
- 删除预留摘要列，以及 `summarySessionId`、`openSummary`、`closeSummary`。

### 一条标签栏

- 桌面端聊天右侧栏只渲染一个 `DockTabStrip`。标签可以是会话面板、产物、网页或新标签页。这个宿主下不再渲染工作台自己的标签栏、活动栏和 `ArtifactTabStrip`；`LocalChromiumPreview` 也隐藏自己的标签行。
- 有序标签列表存在新的按会话 store 里。工作台 store 仍负责挂载和生命周期，右侧栏通过 `navigatePanel` / `closePanelTab` 驱动它，因此 ADR-0123 的“不重新挂载”和 ADR-0121 的“可到达”规则不变。产物标签镜像 `artifactStore.openArtifactIdsBySession`，哪些产物处于打开状态仍由它决定。
- 新标签页是 React 面板，不启动 Chromium；选中网址后，该标签变成网页。

### 按任务记忆

- 每个会话保存 `{ open, tabs, activeTabId, lastUsedAt }`，宽度全局共用。清理规则与工作台 scope 一致（30 天 / 200 条）。
- 切换会话时，以记住的 `open` 为准，优先于 `parkIdleArtifactDock` 和桌面端 `useDockAttentionSignal` 的自动展开。没有记录的会话保持现有规则。

### 浏览器

- 整个桌面端只有一个本地 Chromium session。每个本地 session 都打开 `default` 配置文件，而运行时一个配置文件只允许一个 session 持有，所以“每个面板或每个任务一个 session”会以 `browser_profile_in_use` 失败。该 session 在第一次打开网页时创建，在没有任何页面被持有、也没人观看一分钟后关闭。
- 页面有归属：`chat:<sessionId>` 是某个会话的网页标签及其智能体，`pane:<id>` 是右侧栏之外的浏览器面板。弹窗归属于打开它的页面的主人（运行时现在会报告 `openerId`）。每个归属者最多持有 8 个页面。
- 运行时的每个操作都可以指定 `pageId`，此时作用于该页面而不是前台页面。每个页面有自己的进行中操作、待处理对话框、控制台和网络缓冲。后台任务的智能体可以继续操作自己的页面，用户同时查看别的页面，双方不会互相报 `browser_action_in_progress`。只有屏幕上的面板会激活页面；屏幕投送现在跟随前台页面（之前一直停在开始时的页面上）。
- 每个会话的网页标签保存 `{ url, title, engine }`。`browser` 面板本身不再是一个标签：它负责渲染前台的网页标签，每个标签重新挂载一次；没有打开任何网页时的展示请求会落到新标签页。链接、`browser_open` 和外部桥接的 `revealPane` 都会变成网页标签。用户点击的链接会复用同一地址的标签；智能体复用它正在驱动的页面所在的标签；发给后台会话的请求只在那个会话里排好标签，不会抢占屏幕上的右侧栏。
- 切走时关闭离开任务的页面；如果它的运行还在进行（流式输出或等待审批），页面保留，等运行结束且任务仍在后台时再关闭。切回来时，网页标签变为激活才按记住的地址重新创建页面。
- 智能体路由和浏览器工具记住的“上一个网址”都按会话区分。智能体的第一个页面会填进该会话正在显示的标签。外部桥接客户端在第一次调用时绑定到当时屏幕上的会话。接管了智能体 user-chrome session 的面板在卸载时只断开，不再关闭它。
- 安装后，网页（含 localhost）默认用本地 Chromium；右侧栏之外的空面板仍用 webview。没装时由系统 webview 打开，新标签页提供安装入口。网页标签可以从标签菜单或地址栏的引擎标识切到轻量预览（系统 webview）；离开 Chromium 时会关闭该标签的页面。只有轻量预览带开发者（CDP）面板。
- 元素拾取、标注、Browser Adjust 和检查侧栏在 Chromium 页面（包括用户自己的 Chrome）上同样可用。实现它们的 overlay 与 webview 运行的是同一份，原本就注入了每个 Chromium 页面，缺的只是回传通道：webview 的哨兵导航换成 Playwright 绑定（`__cogniaSignal`），由运行时转发为 `element.selected` 事件。拾取开关、取回、清除、按引用取元素和 Adjust 都是运行时 op，各自只调用一个固定的 overlay 函数并传 JSON 参数，从不执行调用方的 JS，所以在 `browser.evaluate` 不可用的地方（公网来源、用户输入过之后）也能工作。Adjust 的页面代码移入 overlay（`__cogniaAdjust`），两个引擎共用一份实现。`browser_annotate` 通过同一路径读取 Chromium 页面的引用；只有云端浏览器的页面仍会先切到轻量预览（`browser_engine_switched`）。

### 窄窗口

依次让出空间：右侧栏缩到下限，聊天区保持 420px；左栏通过不持久化的临时覆盖收成图标条，不改用户保存的偏好；右侧栏离开这一行，带遮罩浮在聊天区上方。

平板和手机保留现有的 Sheet 与抽屉，卡片在那里以弹出层出现。

## 后果

- 聊天右侧栏不再遵守 ADR-0098 的“开关全局唯一”；Canvas、工作流编辑器和项目编辑器仍然遵守。
- ADR-0201 中 localhost 的默认后端改变：React DevTools 等扩展在开发服务上可用。代价是每个可见的网页标签占一个 Chromium 页面，上限为运行时的 32 页；后台任务的页面会被关闭。
- localhost 页面在 Chromium 中仍可使用拾取、标注和 Adjust；只有开发者（CDP）面板需要切到轻量预览。
- `+/−` 行数依赖 task-workspace 记录，网页版只显示文件数。
- 之前没接上的 `sourceCount` 和 `uncommittedChangeCount` 角标现在接上了。
