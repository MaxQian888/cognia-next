---
title: "0123 — Context Workbench 纵向分屏"
description: "把 ADR-0121 记录为 dormant 的双窗格真正渲染出来；用绝对定位泳道而非 resizable group，使任何一个窗格都不会被重建。"
---

# ADR 0123 — Context Workbench 纵向分屏

**Status:** Accepted
**Date:** 2026-08-15

## 背景

ADR-0121 记录了三处「已建成、已持久化、但不可见」的功能，`splitPanelId` /
`splitRatio` 与其三个 store action 是其中之一：模型层完整，每次读取都会归一化并
夹紧，却没有任何 renderer 读它们。按 Working Rule 7，这份 dormancy 被写在三个轴
上——类型上的注释、布局菜单里一条 disabled 的「Split view (not available yet)」，
以及一条把两者钉住的测试。

本次移除这份 dormancy。状态机本来就是已经稳定的那一半；缺的是一个能同时显示两个
panel 而不破坏其中任何一个的 body。

## 决策

### 用泳道，而不是 resizable group

硬性要求是：开分屏、关分屏、拖比例、**以及交换主次**，都不能重建已挂载的 panel。
这里代价高的正是那几个——嵌入式浏览器持有进程级 webview lease，workspace 持有
Monaco buffer，terminal 持有 pty。

React 按「类型 + key + 位置」reconcile，所以把 panel 挪进 `<ResizablePanel>` 就是
换父链，等于重挂载；交换更是两个窗格同时换父链。Portal 也救不了——`updatePortal`
比较 `containerInfo`，换容器就是 delete 加 create。

活得下来的结构是：一个稳定容器、每个 panel 一个稳定 wrapper，只有内联盒模型几何在
变。`absolute inset-0` 改成 `absolute inset-x-0` 加内联的 `top`/`bottom` 或
`top`/`height`。任何配置下都是同一个元素、同一个 key、同一个父节点：React 只更新
属性，而不 reconcile 新子树。单窗格时算出来的盒子与改动前一致。

`components/source-control/diff-pane.tsx` 仍然是「持久化纵向分屏」的好范例，但不是
这一处的范例——它的两个子节点从不会是同一个组件在槽位之间移动。

### lifecycle 键在可见集上

`onFirstActivate` / `onRestore` 原本键在「唯一在前台的 panel」上，而这回答不了第二
个窗格提出的问题。交换主次改变了谁在前台，却没有任何东西进入或离开屏幕；拖动分隔
条则两者都没变。

一个 ref 按各自回答的问题拆成两个。`lastActivePanelRef` 仍表示「这是一次导航吗」，
驱动前进/后退历史；`lastVisiblePanelsRef` 表示「有东西出现或消失吗」，驱动回调。
只有进入可见集的 panel 才会收到回调，于是交换是静默的，拖动也是静默的。

### `narrow` 关闭分屏，`collapsed` 不关

narrow 放不下两个堆叠窗格，所以它关闭分屏。折叠是可见性状态而非布局状态：
`bodyHidden` 把 per-scope 的 `collapsed` 与宿主驱动的 `railOnly` 合并，正是为了让
两条折叠路线不会各说一套，而 `railOnly` 的宿主根本写不了 store。在折叠时关闭，会
让其中一条路线具有破坏性而另一条没有。

panel 的 `preferredMode` 在分屏打开时也停止收窄。几乎每个 panel 到达 `reveal` 时
带的都是默认的 `"narrow"` 偏好，所以照做的话，下一次 rail 点击就会关掉分屏，交换
永远观察不到。`preferredMode` 是偏好而不是指令；显式的 `setMode("narrow")` 照常
关闭。

### 迁移清空一个它同时保留的字段

持久化版本 2 → 3 清空 `splitPanelId` 却保留 `splitRatio`。v3 之前两者都是 dormant
的——没有 renderer 读过，所以里面存的只可能是遗留默认值或手工写入，绝不是用户选择
过的布局；恢复它等于在升级后第一次加载就画出没人要过的第二个窗格。比例则和
`panelWidths` 一样是被记住的偏好，所以重新打开分屏会回到用户上次留下的位置。

只有迁移会清空它。`partialize` 与 `merge` 不能，否则一个活着的分屏撑不过一次刷新。

### 投影，而不是写入

mobile drawer 与任何窄于 480px 的 body 都只渲染单窗格，同时原样保留
`splitPanelId`。因此手机——或者一次拖到阈值以下再拖回来——都无法破坏桌面布局。

这也是 `isPluginContextPanelVisible` 去问宿主而不是问 layout 的原因。
`ActiveContextHost` 增加了 `visiblePanelIds()`，该检查优先读它，对更早的宿主则退回
layout。直接读 `splitPanelId` 会在一台并没有绘制第二个窗格的设备上报告它可见——正是
ADR-0098 当初添加 `isVisible` 所修的同一类谎报。

### 无障碍

两个可见的 tabpanel 配一个 selected tab 不是一个 tabs widget。分屏时两个窗格都变成
带标签的 region，而 group 标签条降级为使用 `aria-pressed` 的按钮组。键盘导航不受
影响：它查的是 panel 的 data 属性而不是 role。分隔条是可聚焦的 window splitter，带
`aria-valuenow` / `min` / `max`，支持方向键、Shift+方向键与 Home/End。

### 拖拽期间的持久化

指针拖拽只改写 `--wb-split` 自定义属性，并在释放时向 store 提交一次。每次
pointermove 都写 store 会在手势进行中重新渲染整个 workbench——连同一个 Monaco
buffer、一个内嵌浏览器和一个终端——而这个数字在拖拽结束前没有任何别处会读。键盘
resize 则立即提交，因为一次按键本身已经是一个完成了的手势。

## 影响

- `splitPlanned` 及其 disabled 菜单项被移除。没有空间时，菜单现在会说明该切换到
  什么，而不只是说不行。
- `ContextPanelRenderProps.active` 表示「在某个可见窗格里」，分屏时两个 panel 都为
  true。它驱动 `inert`、`aria-hidden`、`<Activity>` 以及插件 webview 的 visibility
  事件，这些都无需额外改动即可跟随。
- `PluginContextWorkbenchState` 增加了 `splitPanelId` 与 `splitRatio`。
  `ownsActivePanel` 仍表示在前台的那个 panel：`setMode` 与 `setPinned` 会重塑整个
  workbench，而位于下半部的插件并没有被交付这个界面。
- 不提供面向插件的 split / reparent / move 方法。在没有消费者之前加上它，只会重新
  制造本 ADR 正在移除的那种 dormancy。

部分取代 ADR-0121，该 ADR 的「三处 dormant 功能」一节仍将分屏描述为未渲染。
