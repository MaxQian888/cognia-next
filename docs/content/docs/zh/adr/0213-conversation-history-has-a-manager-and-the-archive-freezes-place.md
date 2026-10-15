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

### 6. 从行内阅读与恢复（2026-10-11 修订）

管理页仍然是一个打开会话的表格，不增加预览面板；但一行本身能说明更多：

- **最后一条消息。** 每一行都在标题下方的事实行中预览最后一条消息（`ChatSession.lastMessagePreview`，侧栏已在使用的非规范化字段）；手机列表为它单独留出一行。
- **归档时间，可排序。** 已归档标签页新增“归档时间”列。它的顺序（`ConversationArchiveOrder`，最新或最早归档在前）是归档专属的维度，因此与 `ConversationSortBy` 并列而不是并入其中——侧栏和已保存视图都看不到它。它持久化在 `useConversationManagerStore.archiveOrder`；选择任意共享排序都会清除它，而它生效期间共享表头报告 `aria-sort="none"`。搜索词会改为按相关度排序，与其他排序一致。多选按行的绘制顺序遍历，因此 Shift 范围选择覆盖的就是屏幕上看到的行。
- **行内恢复。** 已归档的行在 ⋯ 菜单旁带有“恢复”（宽表格上是带文字的按钮，手机上是 44px 图标），与菜单使用同一个 `onUnarchive` 写入器；已移交的行禁用，手机列表处于多选时隐藏。
- **未读排序会说明自己。** 没有任何列按未读排序，因此用一行状态文字说明当前顺序，而不是让所有表头都显示未排序。
- **搜索无结果时提供另一个标签页。** 收窄后的空状态新增“到已归档（或回到活跃）中搜索”，保留搜索词，且仅当那个标签页有内容时才提供。
- **手机布局。** 标签页占据搜索框上方的整行；“选择”变成与搜索、筛选工具并列的图标，搜索框保持宽度；列表从边到边铺开，不再包在带边框的卡片里；归档说明换行到自动归档控件上方，而不是被挤在它旁边。空的活跃标签页标题为“还没有对话”，不再重复页头的“新建对话”。

### 7. 加密列表投影（2026-10-15 修订）

会话列表在持久化就绪标记存在后读取派生表 `sessionList`，`sessions` 仍是权威数据。
投影只保留列表渲染、筛选、排序和跳转需要的字段；完整提示词与 transcript revision
留在源记录。`[workspaceKey+updatedAt]` 索引将缺失和空 project id 都映射为
`workspaceKey = ""`，保持历史会话与配对客户端的可见性。

加密层上方的 DBCore middleware 在同一事务内维护源记录与投影，覆盖导入、同步、
归档、移动和删除。只改变源记录内容时不写入未变化的投影。标题、预览等内容继续
使用账户 cipher 加密，不增加内容索引或明文内容摘要。

Schema v241 新增投影表，v242 是纯数据迁移，在 `storageLayout` 保存源记录已有
密文 IV 的轻量校验记录，不新增索引。加密层下方的 middleware 在源事务内更新校验记录，也覆盖只改变
源内容的写入；只有旧密文已经匹配时才推进校验记录，避免一次新版本的无关写入将
旧版本造成的陈旧投影误判为有效。IV 是已有的加密元数据，不是内容摘要。

Schema v243 在已有 envelope 上新增 `sessions.__cogniaEncryptedContent.iv`
索引。建索引不解密、重新加密或改写源记录、投影和消息。历史明文行没有 IV 索引项，
仍回退到权威源记录读取。

全局列表在同一只读事务内比较源 IV 索引键与校验记录，匹配时避免传输完整源密文。
同时通过主表执行 `sessions.count()` 订阅源行变化，确保不知道 IV 索引的旧静态
schema writer 在相同时间戳下替换记录也会触发刷新；IndexedDB 仍会为这些 writer
维护物理索引。工作区范围查询保留有界的原始源行扫描；缺少索引或 IV 不匹配时仍
回退到原始行及权威源记录。旧版本在新版本关闭期间进行的写入同样可被发现。
v242 升级先重建投影与校验记录，然后更新 v241 就绪标记。重建时在原有源页解密前收集
最多 500 条 IV 校验记录，避免再次读取源数据。每页在原有事务中并行写入加密投影
与校验记录，两者完成后才继续分页或更新就绪标记。任一写入失败都会回滚整个重建，
重试仍然安全。

解锁后的账户 cipher 只缓存经过认证的 `sessionList` payload JSON 文本，上限为
2,048 项和 8 MiB 的按字符串长度计量的存储。每次命中仍校验完整 envelope 和存储坐标，并
重新解析出独立结果；索引元数据仍来自当前记录。锁定或替换 cipher 时同步清空缓存，
锁定后才完成的解密不能重新填充缓存。缓存不改变加密，也不替代源记录与校验记录检查。

在显式事务中读取密集的 `sessionList.bulkGet` 请求时，加密 middleware 使用有界的
原生批量读取：至少 128 个不重复的字符串 id，且表中记录数不超过请求数量的两倍。
解密前先按请求 id 过滤原始记录，保留缺失行位置，并忽略未请求的损坏孤立投影。
重复 id、稀疏列表、隐式事务及事务缓存请求保持逐键读取。源记录成员关系、IV 校验
和脏记录回退逻辑保持不变；小工作区不进入此路径。

Boot 在采用 plugin schema 后检查就绪状态；首次列表读取也会在只读快照之前初始化
新 target 数据库。缺少表或原始读取 middleware 时仍使用完整记录查询。快照与账户、target 迁移
排除派生列表行及其就绪标记，保留其他 storage-layout 行，并在恢复权威 session 后
重建投影。该表不进入 portable backup，也不作为独立域参与同步。

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
