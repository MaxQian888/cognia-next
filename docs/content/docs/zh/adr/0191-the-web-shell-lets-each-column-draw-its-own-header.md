---
title: "0191 — 网页壳让每一列绘制自己的标题栏"
description: "桌面风格的标题栏——拖拽区、菜单栏折叠、窗口控制、十一个可定制分段——被原样挂到了浏览器壳上，在一个本身已有窗口框架的标签页里读成了第二道窗框。网页壳现在默认不挂顶栏：会话侧栏、聊天列和工作台各自通过投影系统已有的内联回退绘制自己的 40px 标题行，工作区切换器留在侧栏头部，toolbar.* 插件扩展点改挂到聊天列头。持久化设置项（`webTitleBarEnabled`）可以为需要的用户把顶栏找回来；Tauri 不受影响——在那里顶栏就是窗口框架，不能缺席。"
---

# ADR 0191 — 网页壳让每一列绘制自己的标题栏

**状态：** 已接受 — 已实现
**日期：** 2026-10-22
**相关：** [ADR-0129](./0129-unified-global-search)（比顶栏更长命的命令面板）、[ADR-0122](./0122-first-run-onboarding)（另一处壳让出窗口框架给路由的地方）、[ADR-0144](./0144-workspace-as-the-unit-of-work)（侧栏头部承载的工作区切换器）

## 背景

桌面 `TitleBar` 是为 Tauri 的 `decorations: false` 无框窗口造的：它是拖拽面、菜单栏，也是关闭/最小化/最大化按钮的家，在此之上还承载十一个可定制分段——应用图标、导航箭头、工作区、搜索胶囊、命令中心、四个面板开关。加上 outlets 系统（见 `components/shell/title-bar-outlets.tsx`）之后，各列的标题也开始*投影*进它，这一条 40px 的行还额外托管了侧栏、聊天和工作坞的头部。

在浏览器壳上，这一切都落在一个本身已有窗口框架的标签页里。顶栏成了第二道窗框：`bg-muted/40` 的着色条上叠着彼此重复的入口（三个都通向同一个命令面板；导航箭头与浏览器自带后退重复；窗口控制按钮在浏览器里无所附着），而且每一列的标题都交出了自己的身份。在浏览器里，这套设计读起来是重，而不是整合。

投影系统本身早已留了逃生口：某个分区的 outlet 不存在时，`useTitleBarProjection` 返回 `null`，列标题就地内联绘制。移动端 Sheet 一直就是这么跑的。缺的是一句"在网页上没有顶栏"——以及那些顶栏独自承载的东西该去哪儿。

## 决策

**在浏览器壳上，顶栏是一个默认关闭的设置项。** `ui-store` 新增 `webTitleBarEnabled`（持久化，默认 `false`），在 设置 → 界面布局 → 顶部栏 中切换；项目列表保持可编辑，它就是顶栏重新启用后的布局。在 Tauri 上该标志被忽略：顶栏是窗口框架，始终挂载。

顶栏缺席时，壳反转为列自有的 chrome：

- **会话侧栏**保持合并的工作区形态——导航行、作用域树、页脚——因为 `merged` 现在的含义是"工作区作用域内展开的左缘侧栏"，而不再是"start outlet 存在"。它的头部把原本投影上去的行内联画出：`WorkspaceContextBar`（工作区切换器 + 分支）、搜索放大镜和 ⋯ 列表操作。
- **聊天列**绘制 `ChatHeader` 的内联行——它本就自带侧栏开关和工作坞开关。`toolbar.left` / `toolbar.center` / `toolbar.right` 插件扩展点挪到这里——这是会话路由唯一拥有的壳 chrome——并用投影作用域做门控，使工作区之外的宿主（收件箱详情、Canvas 边聊、移动端 Sheet）保持素净。
- **工作台/产物坞**通过同一回退绘制自己的头部。
- **首页 hero**没有列标题——纯内容。

顶栏缺席后仍然存活的：命令面板（对话框自己绑定 ⌘K/Ctrl+K，侧栏的搜索框也会把已输入的查询移交过去）、⌘B 侧栏开关、状态栏、查找栏和界面布局自定义器。在无栏网页壳上不再存在的：应用内导航箭头（浏览器后退覆盖）、顶栏自带的菜单（⌘K 覆盖）、`TitleBarWorkspace` 的独立芯片（侧栏头部的切换器就是同一个组件）。

## 影响

- **默认的网页体验少了一整行 chrome**，且每一列都保住了自己的上下文——侧栏上的工作区 + 分支、聊天列上的会话标题、工作坞上的面板名。
- **`merged` 是列的属性，不是投影的属性。** 挂在工作区作用域之外的侧栏在任何平台上都保持紧凑形态；本次变化只落在预期的那一个格子里。
- **插件 `toolbar.*` 扩展点跟着聊天列走。** 在非会话类网页路由（设置、工作流）上它们没有宿主——这是刻意的：它们本就是贴着会话的 chrome。
- **Tauri 逐字节不变**：`shellHasTitleBar` 在那里恒为真，`merged` 的解析结果与之前完全一致，顶栏的 outlets、拖拽区、菜单栏和窗口控制原样保留。
- **该标志按浏览器持久化**（localStorage，与其他 chrome 偏好一致）——这是对"这个浏览器窗口的框架已被占用"的刻意解读。

## 实现

- `stores/ui/ui-store.ts` — `webTitleBarEnabled` + `setWebTitleBarEnabled`，经 `partialize` 持久化。
- `components/desktop/desktop-app-shell.tsx` — 仅在 `platform === "tauri" || (platform === "web" && webTitleBarEnabled)` 时挂载 `TitleBar`；是卸载而非隐藏，这样 outlets 根本不会注册。
- `components/desktop/channel-list.tsx` — `merged` 变为 `railExpanded && inScope && (headerOutlet !== null || !shellHasTitleBar)`；`Header` 在 `workspaceChrome` 置位时内联绘制工作区行。
- `components/chat/chat-header.tsx` — 头部在投影作用域内内联绘制时托管 `toolbar.*` 扩展槽。
- `components/shell/title-bar-outlets.tsx` — 新增 `useTitleBarProjectionScope()`，把原先私有的作用域标志暴露出来。
- `components/shell/shell-layout-customizer.tsx` — 顶部栏标签页上的网页专属开关。

测试：`desktop-app-shell.test.tsx`（按平台 + 标志的挂载门控）、`channel-list.test.tsx`（"web shell without the title bar" describe）、`chat-header.test.tsx`（作用域内外的扩展槽托管与投影时让位）、`title-bar-outlets.test.tsx`（作用域 hook）、`shell-layout-customizer.test.tsx`（仅网页出现的开关）、`ui-store.test.ts`（默认值、setter、partialize）。
