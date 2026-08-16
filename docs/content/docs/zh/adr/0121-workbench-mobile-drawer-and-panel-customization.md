---
title: ADR-0121 — 工作台移动端抽屉与面板级自定义
description: "移动端 Context Workbench 换成真正的 vaul 抽屉（带吸附高度），在活动图标栏之下新增面板级重排/隐藏，并让三处休眠自定义从沉默变为可见。"
---

# ADR-0121 — 工作台移动端抽屉与面板级自定义

**状态**：已接受（2026-08-15）

## 背景

ADR-0083 让所有右侧界面共用一个外壳；ADR-0098 让面板正文关闭后活动图标栏仍留在屏幕上。还剩三处接缝没有处理。

**移动端承诺了自己并不具备的手势。** 窄屏宿主是一个 Radix `Sheet`，上面画了一条 `aria-hidden` 的装饰横条，注释还声称它"保留了抓手提示与滑动关闭手势"。`Sheet` 本质是 Dialog：两者都没有。`artifact-panel.tsx` 里重复了同样的说法。围绕这个空缺还有：固定的 `h-[92dvh]`，没有半开状态；32px 的活动按钮，低于 `globals.css` 为全应用其余部分设定的 44px 底线；没有接 `useBackDismiss`（于是 Android 返回键会把路由从 sheet 底下抽走，而应用里另外二十多个移动端 sheet 都处理了）；也没有软键盘避让——sheet 被 portal 到 `mobile-shell-wrapper` 的布局之外，它的底部预留永远够不到 AI 与评论面板里的输入框。

**自定义只做到了上面一层。** 用户可以重排、隐藏七个*活动*；活动内部那十一到十三个*面板*的顺序由写死的 `order:` 数字决定，而且根本无法隐藏。

**三处功能已经建好、会被持久化，却看不见。** `splitPanelId` / `splitRatio` 及三个 store action、`WorkbenchRailLayout.groups`、`workbenchRailPerProject`，在模型层各自完整却没有任何读者——而且没有一处在用户能看到的地方说明这件事，这正是工作规则 7 要防止的形态。其中一处还在丢数据：`useWorkbenchRailLayout.hide` 从零重建 `{ order, hidden }`，而 `show` 用的是展开；`workbenchRailLayoutOf` 在读取时也会丢掉 `groups`。任何已存储的分组都会被下一次隐藏操作删掉。

## 决策

### 移动端界面改为 vaul 抽屉，并在关闭时卸载

`ContextWorkbenchMobileDrawer` 取代 `ContextWorkbenchMobileSheet`。vaul 早已在仓库里，另有六处界面在用；注释描述过的那些手势这次是真的做出来，而不是再描述一遍。

- **吸附高度 `[0.55, 0.92]`**，`fadeFromIndex` 只作用于最后一档——半开时的意义就是继续读上方的对话，因此不能压暗。当前吸附值上提到 `artifactDockLayoutStore.mobileSnapPoint`，因为关闭会卸载抽屉，组件内 state 撑不过一次关闭再打开。共享的 `ContextWorkbench` 通过 prop 接收它，而不是去 import 那个 store——那会越过四个宿主都依赖的分层。
- **`handleOnly`。** 正文里跑着 Monaco、可滚动的文件树和内嵌浏览器面板，"到处都能拖"会和这三者全部打架。vaul 的抓手自带 2.75rem 的点击区。
- **不使用 `forceMount`。** 原来的 Sheet 把自己挂在画布外，靠 `inert` + `aria-hidden` 保证关闭后不可达；vaul 自己负责退出动画然后把界面丢掉，这是同一个保证，而且不需要两个属性彼此保持一致。没有任何损失：`<Activity mode="hidden">` 本来就会在关闭时销毁面板 effect，所以内嵌浏览器那个进程级 webview 租约从来就没有被关闭的 sheet 占住过——而桌面端 dock 一直是折叠即卸载正文。移动端才是例外。
- **`repositionInputs={false}` 加上实测的 `keyboardHeight` 内边距。** Capacitor 出货配置是 `Keyboard.resize: "native"`，由系统缩放整个 WebView 框架；再让 vaul 在其上重新定位，输入框会被移动两次。`useKeyboardInsets` 在原生下按设计读到 0，在移动端 Web 上读到真实的遮挡量——后者才是真正需要抬起的平台。
- **过渡时长改写在 vaul 真正动画的属性上。** 原 Sheet 用 `--motion-duration-scale` 缩放滑动；vaul 写死了 `transition: transform .5s`，因此同一份约定改由 `[transition-duration:…]!` 承载。`globals.css` 里的减弱动效守卫特异性更高，依然生效。

`onCollapse` 从抽屉的 props 中 `Omit` 掉，由内部提供。这不是整洁性改动：宿主不提供它时 `handleCollapse` 会落到 `setMode("collapsed")`，在抽屉里这会把*正文*藏进一个 92dvh 的模态框**并且被持久化**，于是下次打开还是空的。`project-context-workbench.tsx` 挂载移动端界面时正好没传 `onCollapse`，就处于这个状态。把 prop 拿走，是让这条路走不通，而不只是修好一处调用点。

在该 placement 下，图标栏末尾的按钮读作 **关闭** 并画 `X`，而不是在一个没有右边缘的界面上写"折叠工作台"配右侧面板图标；同时禁用"再点一次当前活动即关闭"的 VS Code 约定——在抽屉里这会让一次手滑的二次点击丢掉整个界面，而抽屉本来就有三个明确的出口。

### 面板级自定义位于图标栏之下，而非并列

`settings.workbenchPanels`（`{ order, hidden }`，走共享的 `resolveOrderedLayout`）负责活动*内部*标签页的顺序与隐藏。

- **隐藏去掉的是标签页，不是面板。** 面板仍留在 `resolvedPanels` 里，所以 `publishActiveContextPanels`、命令面板、`Ctrl+Shift+E` 和 `Ctrl+1..7` 依然够得到它。这个兜底正是隐藏可以放心提供的全部理由，也和活动层已有的规则完全一致。
- **某个活动下的面板被全部隐藏时，它的图标按钮也一并去掉**——一个点开是空白正文的图标比没有图标更糟，而面板无论如何都还能用快捷键打开。
- **静态目录 + 一致性测试。** 面板定义是在闭包了会话状态的 hook 内部构造的，静态时无从枚举，而自定义器（可从设置进入）也没有一个活着的工作台可问。`WORKBENCH_PANEL_CATALOG` 复制了真正住在 `chat-dock-panels.tsx` 里的身份信息，`workbench-panels.test.ts` 直接扫描该源文件把两者钉在一起——这和 `taxonomy-parity.test.ts` 对活动分类法给出的答案是同一个。
- **每个活动一个 `CustomizerLists`。** 面板顺序只在自己的分组内有意义，单一扁平列表会诱导出界面无法兑现的拖拽。各分区最终都提交回同一份扁平存储顺序。
- 编辑器渲染在现有 **Workbench** 标签页内、图标栏编辑器的下方。单开一个标签页会让用户去猜两个入口里哪一个才管"工作台"。

### 休眠状态要写在用户看得见的地方

> **部分被 ADR-0123 取代。** 分屏不再休眠：它已经会渲染，`splitPlanned` 及其
> disabled 菜单项已被移除。图标栏面板分组与按项目图标栏布局不受影响，仍如下文
> 所述处于休眠状态。

分屏、图标栏面板分组、按项目图标栏布局，各自补齐工作规则 7 缺失的两条轴：类型里说明为何休眠，界面上标注为规划中，测试把两者钉住。形态沿用 `settings/external-bridge/panels/scopes-panel.tsx`——禁用控件 + "规划中"徽标 + 原因说明。工作台的布局菜单也不再在宿主没有 reset 动作时于 `@[20rem]` 以上隐藏自己，因为那个菜单现在是唯一说明分屏不可用的地方。

`groups` 的丢数据路径随标注一起修掉：`hide` 和 `workbenchRailLayoutOf` 都会把该字段带过去。休眠必须意味着"还没用上"，而不是"被悄悄抹掉"。

### 对话栏获得绝对下限

`CHAT_MIN_PX`（420px），以 `dockCapForChatFloor` 的形式实现——做成 dock 的上限而不是 chat 的下限，因为面板库每个边界只接受一个单位，而上限能一次覆盖所有入口（拖拽、窄/宽预设、双击、从更宽窗口恢复的宽度）。

dock 的百分比是它所在 `ResizablePanelGroup` 的份额，而这个 group 不是窗口：右侧终端 dock 先在 shell 行里切走了一块，`sidebarSide: "right"` 时还有两列图标栏在它之外。1280px 屏幕配 30% 终端时，workspace profile 的 65% 只给对话留下约 315px。上限在 `onLayoutChanged` 里按实测宽度刷新——它本来就会在挂载和每次缩放时触发，因此不需要额外的 observer。

## 影响

关闭移动端工作台现在会拆掉它的面板，因此面板内的瞬态状态（滚动位置、没发出去的评论草稿）不会跨关闭保留。这与桌面端 dock 的一贯行为一致，也正是让 vaul 自己掌管退出动画、而不是用 `forceMount` 跟它对抗的代价。

`WORKBENCH_PANEL_CATALOG` 是 `chat-dock-panels.tsx` 中身份信息的第二份副本。一致性测试是它可被接受的前提：新增面板却没有目录项会让测试失败，而不是悄悄变成不可自定义。Canvas、工作流编辑器与项目编辑器的面板是各自内联声明的，这里刻意不收录——将来接入只是在目录后追加，外加测试里加一行。

三块各自独立拥有的右侧界面之间，真正的共享宽度预算仍未建模。`CHAT_MIN_PX` 只是便宜的那一半：无论这一行被压到多窄，dock 都不能把对话挤到读不了的宽度以下。
