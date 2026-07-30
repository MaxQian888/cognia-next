---
title: "0098 — 常驻工作台图标栏"
description: "收起 Context Workbench 时保留活动图标栏，支持拖拽重新展开与松手吸附，并把宿主的真实可见性接入插件契约。"
---

# ADR 0098 — 常驻工作台图标栏

**状态：** 已接受
**日期：** 2026-07-29

## 背景

ADR-0083 让所有右侧表面共用一个外壳，带一条 48px 的活动图标栏。但它四个宿主里的三个——聊天 artifact dock、Canvas、工作流编辑器——收起时把整个外壳**缩到零宽**并卸载。一旦收起，屏幕上没有任何东西表明预览、审阅、AI、评论、工作区这些面板存在，唯一的回路是记住 ⌘J。只有不传 `onCollapse` 的项目编辑器会走到工作台自己的 `mode: "collapsed"`，从而保住图标栏。

同一条缝还带来三个缺陷：

- **开关会失灵一次。** `react-resizable-panels` 在拖拽越过 `minSize` 时会自行折叠 `collapsible` 面板。没有宿主把这件事写回去，于是 dock 视觉上已收起而 `dockCollapsed` 仍为 `false`；下一次 ⌘J 白白对一个已折叠的面板调用 `collapse()`。
- **`isPluginContextPanelVisible` 会说谎。** 它读的是 per-scope 的 `layout.mode`，而那三个宿主从不写这个字段，所以整条右栏归零时插件的 `onDidChangeVisibility` 仍报告「可见」。
- **`setMode("collapsed")` 是休眠的**，同样因为它写的字段容器的持有者并不读。

## 决策

收起改为把宿主容器缩到活动图标栏而不是缩到零，并且图标栏可以拖拽重新展开。

- **`railOnly` 由宿主驱动，不走 per-scope。** `ContextWorkbench` 新增 `railOnly` prop，与既有的 `mode: "collapsed"` 合流成内部的 `bodyHidden`。「右栏是否打开」对每个宿主是**一个全局事实**；把它塞进按**资源**分键的 `contextWorkbenchStore.layouts[scopeKey]`，会让用户在 artifact 标签间切换时 dock 反复开合。
- **面板体是卸载而不是隐藏。** rail-only 会摘掉整个面板容器，因此嵌入式浏览器的进程级 webview 租约照旧释放，与零宽 dock 完全一致。聊天 dock 把这次翻转延后一个折叠动画，让收缩的外壳擦除的是真实内容。
- **吸附在松手时结算，绝不在拖拽中进行。** `lib/ui/panel-snap.ts` 是一个单位无关的纯函数，四个宿主共用：低于下限 → 折叠；从图标栏拖出 → 回到记忆宽度；落点在某个宽度预设的物理 24px 内 → 吸到该预设。实时磁吸必须从「本次 resize 触发的布局回调」里回写，会自我重入。
- **`ActiveContextHost` 新增 `isVisible` 与 `collapse`**，即既有 `ensureVisible` 的对偶。可见性翻转通过 `notifyActiveContextHostVisibility` 广播——它只 notify 不重新注册，因为重新注册会把一个正在收起的后台宿主重新盖章为「当前活跃」。
- **`workbenchRailPersistent` 是独立的 `AppSettings` 键**，默认开启，编辑入口紧挨图标栏定制器。它之所以不并入 `workbenchRail`，理由与 `sidebarSide` 不并入 `sidebarLayout` 相同：后者的修改器会重建整个对象，且它的「恢复默认」意思是「把我的活动顺序放回去」，绝不该顺手把图标栏关掉。

仅限桌面。窄屏维持全高 Sheet：820px 平板上 24% 的 dock 只有约 197px，而 Sheet 承载的是同一个工作台、同一个资源。

## 影响

除非用户主动关闭，每条右栏现在都固定占用 48px；当 `sidebarSide: "right"` 时右边缘会并排两条图标列（64px 导航 + 48px 工作台）。这是接受的代价：两条栏职责不同，而那个开关就是退路。

`workbenchRailPersistent` 由三个持有容器的宿主消费，**刻意不被项目编辑器读取**——它没有容器：它的收起一直就是 rail-only，而且一旦整条消失就没有用户可达的路径把它找回来（`showContextWorkbench` 是调用方传的 prop，不是控件），所以在那里做零宽折叠会把工作台锁死。由「`manageOwnWidth` 且不传 `onCollapse` 的宿主仍通过 per-scope mode 到达 rail-only」这条测试钉住。

工作流编辑器的桌面分支此前同时跑着两套「已关闭」的概念——一个覆盖在零宽面板上的本地 `rightCollapsed` state，加上其侧栏回落到的 per-scope mode。现在它像其他宿主一样传 `onCollapse`/`onEnsureVisible`，只留一个持有者。
