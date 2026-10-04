---
title: "0213 — 会话历史有了管理页，归档会冻结会话的位置"
description: "新增独立的 /conversations 管理页，分活跃和已归档两个标签。页面直接复用聊天侧栏的列表模型、筛选控制器、行菜单、批量操作栏和写入边界，不另做一套。用户向已归档会话发消息会取消归档，后台写入不会。归档不清除置顶和文件夹，但在归档内冻结。归档新增清空归档、按不活跃时长自动归档的维护任务、手机端多选和快捷键。设置 → 会话页收窄为 Agent 运行时视图。"
---

# ADR 0213 — 会话历史有了管理页，归档会冻结会话的位置

**状态：** 已接受
**日期：** 2026-10-03
**相关：** [ADR-0002](./0002-scheduler-full-agent-resolution)（调度器维护任务）、[ADR-0009](./0009-platform-connectors)（收件箱有自己的归档路径）、[ADR-0129](./0129-unified-global-search)（⌘K `is:archived`）、[ADR-0144](./0144-workspace-as-the-unit-of-work)（工作区范围）、[ADR-0200](./0200-files-is-a-view-that-keeps-what-you-keep)（文件页：在现有数据之上做功能页的先例）、[ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background)（协调器与线程）

## 背景

之前有两处在管理会话历史，但两处都不好用。

**设置 → Agent 运行时 → 会话**等于第二个会话管理器，而且绕开了共享的写入链路（`useSessions` → `useConversationRowActions` → `SessionRowMenuItems`）：

- 删除时不做清理：不关闭 sidecar，不解除 IM 绑定，不发 `SESSION_DELETED`，也不走 Host 路由。
- 重命名后 `titleAuto` 仍保持开启。
- 点"恢复"只改了聊天 store，用户还停在 `/settings`。
- 嵌入、IM 和已归档会话都列出来了，但没有任何标记。
- 费用没用详细的有效成本。
- 时间格式、费用格式和删除确认都是自己另写的。
- 不能排序，没有批量操作、归档和导出。

**归档**是聊天侧栏里的一种模式，问题包括：

- 任何地方都看不到归档了多少会话。
- 打开一个已归档会话，看起来和普通会话没有区别。
- "全局搜索"不搜归档。
- 已归档的置顶或文件夹会话只有一半功能可用。
- 范围标题上的未读数统计的是*活跃*会话。
- 预览上限导致"全选"实际只选中一部分。
- 手机端没有批量操作，空归档也没有返回入口。
- 归档划分在三处各算一遍。

## 决策

### 1. 一个管理页，用列表自己的部件拼成

`/conversations` 以表格列出所有工作区中可见的会话。代码位于 `app/conversations/`、`components/conversations/`、`hooks/conversations/`、`lib/conversations/` 和 `stores/conversations/`。页面分**活跃**和**已归档**两个标签，分法与侧栏的视图切换一致；`?tab=archived` 直接打开归档。

页面不重新实现任何列表规则：

- **行数据**：`useSessions({ crossWorkspace: true })`，按标签切分后交给 `buildConversationSections` 的新 `flat` 模式排序（只有一个分区，没有置顶上浮、文件夹和日期分组）。
- **筛选、排序和保存的视图**：用共享的筛选控制器，但传入页面自己的状态（`filterState`，持久化在 `useConversationManagerStore`）。在表格里筛选不影响侧栏，反之亦然。保存的视图定义仍然属于用户配置，两边共享。
- **搜索**：标题排序器，开启后同时搜索消息内容索引（`useChatHistorySearch`）。
- **写入**：`useConversationRowActions` 调用带路由的写入函数，自带转交（handoff）锁检查、提示、撤销和遥测。
- **复用的组件**：
  - 行菜单：`SessionRowMenuItems`，桌面端转交（hand-off）来自 `useSessionDesktopHandoffs`；
  - 行内重命名：`useInlineRename`；
  - 批量操作栏：`ChannelListBulkActions`，使用 `layout="bar"`；
  - 空状态：`ConversationListEmptyState` 和 `ConversationNarrowedEmptyState`；
  - 导出对话框；
  - 删除确认；
  - 清空归档对话框。
- **用量列**（轮次、Token、费用）：由 `useSessionUsageSummaries` 提供，只读取当前显示的行。设置 → 会话也用这个 hook。

表头排序与 `ConversationSortBy` 一一对应：标题、最近活动（最新或最早）、创建时间。所以表头和筛选菜单的排序项总是一致。用量列不能排序。

"全选"选中整个筛选结果，而不仅是当前已显示的部分。"显示更多"每次加载 100 条。

路由在以下位置注册：

- 导航目录（`types/shell/sidebar.ts`，含 ⌘K 别名）；
- surface contract：`standalone: "full"`、`companion: "remote"`、`offline: "cached-read"`，与聊天本身相同；
- 全视口路由列表；
- Go 菜单，TypeScript 和 Rust 两端都有。

聊天侧栏仍然是*使用*会话的地方。侧栏和手机列表的 ⋯ 菜单都新增了"管理会话…"，会打开管理页的对应标签。设置 → 会话收窄为 Agent 运行时视图，包含三部分：带计数的管理页入口卡片、绑定 SDK 的会话、原生 SDK 会话。

### 2. 用户自己发消息会取消归档，后台写入不会

用户向已归档会话发送消息时，会话会取消归档，并弹出可撤销的提示（`useUnarchiveOnUserTurn`）。机器人、调度器和连接器的写入不会改变归档状态：会话被归档，就是为了不再打扰用户，后台轮次不代表用户回到了这个会话。

打开已归档会话时，顶部显示带**取消归档**按钮的 `ArchivedConversationBanner`。欢迎页的"继续"不会推荐已归档会话。

### 3. 置顶和文件夹保留，但在归档内冻结

归档不会清除置顶和文件夹，取消归档后会话回到原来的位置，什么都不丢。在归档内，这两者只作为状态显示，不再是可以拖入或调整的位置：

- 列表模型不生成置顶分区。
- 行菜单不提供置顶或取消置顶、移到文件夹、新建文件夹，也不提供已读和未读操作。
- 置顶拖放区和手动排序关闭。
- 范围标题不显示"+"、未读数和"全部标为已读"。
- 批量操作栏的选项取决于选中了什么：归档只作用于选中的活跃会话，取消归档只作用于选中的已归档会话；只有在没有选中已归档会话时，才提供置顶、移动和已读状态操作。

管理页的行仍然显示置顶图标和文件夹标签，因为它们告诉用户会话恢复后会回到哪里。

### 4. 归档自己的工具

- **清空归档**（`EmptyArchiveDialog`）：
  - 通过 `deleteSessionsRouted` 删除范围内所有已归档会话：有 Host 时发送 Host 意图，否则调用 `deleteSessionsWithTeardown`。
  - 跳过正在转交的会话，并说明保留了几个。
  - 入口在侧栏 ⋯ 菜单、手机抽屉和管理页的"已归档"标签。
- **按不活跃天数自动归档**：
  - 设置项为 `AppSettings.conversationArchive.autoArchiveAfterDays`，可选 7、14、30、60、90 天，其他值一律视为关闭。同步类别为仅桌面端。
  - 清理由调度器维护任务 `conversation-auto-archive` 执行：每 6 小时一次，标签为 `system:conversation-archive`。配对客户端不执行，因为会话由 Host 管理。
  - 候选选择是纯函数（`lib/chat/auto-archive.ts`），以下会话永远不会被选中：
    - 置顶、正在转交或绑定了 IM 的会话；
    - 正在打开或运行中的会话；
    - 项目协调器，以及未解决的项目线程；
    - 生命周期仍然活跃的附属子会话。
  - 不活跃时长用 `conversationLastActivityAt` 计算，与列表日期分组使用的值相同。
  - 设置 → 对话和管理页的"已归档"标签共用同一个 `AutoArchiveControl` 组件。
- **手机端多选**：使用共享的批量操作栏（`layout="bar"`）。
- **快捷键** `shell.conversation.toggleArchive`：默认 `Ctrl+Shift+Backspace`，可以改绑。它对当前聚焦的行生效，没有聚焦行时对当前打开的会话生效，切换归档状态。行菜单里会显示这个快捷键。

### 5. 归档和删除只有一个写入入口

路由逻辑集中在 `lib/chat/session-archive-writes.ts`：

- `setSessionsArchived(ids, archived)`：Host 意图可用时，每个 id 发送一个 Host 意图；否则在本地一次批量写入。
- `deleteSessionsRouted(ids)`：删除按同样的方式路由。

`useSessions`、聊天横幅、发送路径和清空归档对话框都调用这个模块，所以任何界面归档或删除时都会经过 Host 路由和清理。取消归档现在也可以撤销；撤销一次归档会重新打开当时打开的会话。

## 影响

- 侧栏、手机抽屉和管理页共用同一条写入链路和同一个列表模型。在模型里改一条规则，三处同时生效。
- 管理页的筛选和排序只在本页生效，所以它的状态可以有意与侧栏不同。保存的视图两边共享。
- 设置页不再自己管理会话。原来在那里显示的会话信息，现在都链接到管理页。
- 侧栏的归档视图有意做得比管理页轻：没有表格，没有用量列，没有自动归档设置。

## 不在范围内

- 收件箱列表和连接器覆盖设置仍对 IM 会话使用各自的归档路径（ADR-0009）。
- 取消归档不会重新打开归档时关闭的附属子会话：关闭操作没有记录原因，重新打开可能把因为其他原因关闭的子会话也恢复了。
- 手机端批量操作栏和管理页的行菜单不能新建文件夹，只能把会话放进已有文件夹。新建文件夹仍然在侧栏中操作。

## 验证

- 归档语义：
  - `lib/chat/session-archive-writes.test.ts`
  - `hooks/chat/use-session-archive-actions.test.ts`
  - `hooks/chat/use-conversation-row-actions.test.ts`
  - `lib/chat/conversation-list-model.test.ts`（`flat` 模式，以及归档内没有置顶分区）
  - `components/chat/session-row-menu-items.test.tsx`
  - `components/desktop/channel-list-bulk-*.test.tsx`
  - `components/desktop/channel-list.test.tsx`
- 管理页：
  - `components/conversations/conversation-manager*.test.tsx`
  - `hooks/conversations/use-conversation-manager.test.ts`
  - `stores/conversations/conversation-manager-store.test.ts`
  - `lib/conversations/conversation-manager.test.ts`
  - `app/conversations/page.test.tsx`
- 自动归档：
  - `lib/chat/auto-archive.test.ts`
  - `lib/chat/auto-archive-schedule.test.ts`
  - `components/conversations/auto-archive-control.test.tsx`
- 路由注册：
  - `lib/runtime/surface-contract.test.ts`
  - `lib/shell/full-viewport-routes.test.ts`
  - `lib/desktop/go-menu.test.ts`
  - `lib/desktop/menu-actions.test.ts`
  - `src-tauri/src/menu.rs` 测试
