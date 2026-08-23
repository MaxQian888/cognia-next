---
title: ADR-0129 — 统一全局搜索
description: 一个搜索面（⌘K）、一个打开入口、一个可重绑的快捷键、一个 provider 注册表——按标题搜会话、按角色 / 日期 / 归档过滤消息历史、命令、页面、设置、人物与应用内各类库——取代六个调色板与三处 ⌘K 监听。
---

# ADR-0129 — 统一全局搜索

| 字段 | 值                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态 | 已接受                                                                                                                                                                                                                                                                                                                   |
| 日期 | 2026-08-16                                                                                                                                                                                                                                                                                                              |
| 基于 | ADR-0099 会话历史搜索引擎（`lib/chat/search/`）；ADR-0094 会话锚点与跨会话跳转；ADR-0098 常驻工作台栏；ADR-0108 Codex 风格桌面工作流（标题栏搜索胶囊、`command-palette-request` 接缝）；ADR-0059 主机画像 / 能力门禁                                                                                                    |
| 范围 | `lib/global-search/**`、`hooks/global-search/`、`components/global-search/`、`lib/shell/command-palette-request.ts`、`lib/shortcuts/app-catalog.ts`、`lib/chat/search/engine.ts`（过滤器）、薄适配器 `components/desktop/command-palette.tsx` 与 `components/mobile/home/mobile-command-palette.tsx`、`components/inbox/inbox-shell.tsx`、`components/settings/settings-shell.tsx`、`components/mobile/shell/mobile-shell-wrapper.tsx`、`lib/desktop/menu-actions.ts`、`lib/plugin/contracts/plugin-points.ts` |

## 背景

对三种壳里所有"搜索"入口的审计发现没有任何统一注册表——六个互不相干的 cmdk `CommandDialog` 调色板、三条查找栏、五六个内联输入框，由四种不同机制打开：

- **⌘/Ctrl+K 被同时占用三次。** 桌面 `CommandPalette`（常驻挂载）、`InboxCommandPalette`（在 `inbox-shell.tsx` 里挂了两次）和 `settings-shell.tsx` 各自有一个裸 `window` keydown 监听。在 `/inbox` 与 `/settings` 上一次按键会打开两个对话框，顺序取决于监听注册顺序。它们都不在可重绑快捷键目录（`lib/shortcuts/app-catalog.ts`）上，因此 ⌘K 既不能改键也不做冲突检查。
- **原生菜单的"命令面板"在 macOS 上是坏的。** `lib/desktop/menu-actions.ts:commandPaletteAction` 伪造 `Ctrl+K` 按键，而调色板在 Mac 上要求 `⌘K`；`title-bar-workspace.tsx` 早已踩过同一个坑并改用 `requestCommandPalette()`，菜单动作却从未迁移。
- **桌面与移动端调色板约 80% 是复制粘贴**，却各缺对方拥有的分组（移动端：没有导航、工作台面板、工作区、插件动作、设置子项，也没有键盘触发；桌面端：没有工作流）。两者都硬编码 12 条"最近会话"，只按 `title + id` 子串过滤会话，对归档会话、角色和日期一无所知。
- **消息搜索存在，但只是一个扁平分组。** ADR-0099 的引擎（`searchChatHistory`）是扎实的索引子串引擎，带绝对评分与分支去重，但调色板没有暴露它的任何查询维度（工作区、归档、按会话折叠），引擎自身也没有角色 / 日期过滤。
- **十几个可搜索的实体库**（记忆、技能、工作流、模板、计划任务、插件、MCP 服务器、绑定平台的收件箱会话、工作台面板、设置分区与控件）只能在各自页面里找到。
- **空态是死的。** 打开调色板不输入任何内容时，看到的与输入后一样是静态列表——没有最近搜索，也没有最近打开。

## 决策

### 1. 一个对话框、一个接缝、一个快捷键

`components/global-search/global-search-dialog.tsx` 是桌面与移动端唯一的全局搜索面。它：

- 在 app 级快捷键目录上注册 **`app.commandPalette.toggle`**（`ctrl+k`、`allowInEditable`、插件命令 id `command-palette.toggle`）——共享派发器 first-match-wins，可在 设置 → 快捷键 里重绑，不再有私有 `window` 监听；
- 订阅既有的 DOM 接缝 `lib/shell/command-palette-request.ts`，其 detail 由 `{ query? }` 扩展为 **`{ query?, scope? }`**，任何界面都能带着预设范围打开它（会话栏的"全局搜索"、设置壳的查找按钮、原生菜单、标题栏胶囊）；
- 接受可选的受控 `open` / `onOpenChange`，移动端首页壳仍可从搜索条与快捷动作宫格驱动它；另有 `host` 适配器（`onOpenSettings`、`onNewChat?`、`onSelectSession?`）承载两种壳特有的行为。

**移动端两个挂载点，但永不并存。** `AppShellMobile` 只在 `/` 渲染，只挂在那里会让 ⌘K 与接缝在 `/settings`、`/inbox`、`/me/*` 上失效——而这些路由过去是被各自的调色板覆盖的。`components/mobile/shell/mobile-global-search-host.tsx` 由包裹所有移动路由的 `MobileShellWrapper` 挂载，并在 `/` 上返回 `null`，把该路由交给首页壳中懂角色选择器与抽屉的 `MobileCommandPalette`。

`components/desktop/command-palette.tsx` 与 `components/mobile/home/mobile-command-palette.tsx` 变为保持原有 props 的薄适配器，`desktop-app-shell.tsx` 与 `app-shell-mobile.tsx` 无需改动。`InboxCommandPalette` 与 `SettingsFinder` 被移除：它们的数据源成为下述内置 provider，其所在壳不再监听 ⌘K。`commandPaletteAction()` 改为调用 `requestCommandPalette()`。

### 2. provider 注册表 —— `lib/global-search/`

| 模块              | 职责                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `types.ts`        | `GlobalSearchKind`（18 种）、`GlobalSearchScope`（`all · chats · messages · commands · pages · people · library`）及固定的 `KIND_SCOPES` 映射、`GlobalSearchItem`（带高亮位置的 title / subtitle、`meta`、`icon` = lucide 组件或 `avatar` 主体、`score`、`timestamp`、`extra` 标志、`action`）、判别联合 `GlobalSearchAction`、`GlobalSearchProvider`（`kind`、`search()`、空查询用的可选 `suggest()`）、`GlobalSearchContext`。 |
| `query-parser.ts` | `parseGlobalSearchQuery(raw)`——前导 `>`（命令）/ `@`（人物）；`in:<kind|scope>`、`from:user|assistant`、`is:archived`、`before:`/`after:`（`YYYY-MM-DD`、`7d`、`2w`、`3m`）、`workspace:current|all`、`title:`；剩余自由文本即搜索词。未知 token 保留在文本中——解析器绝不吃掉用户本意为字面量的词。                                                                                          |
| `registry.ts`     | `registerGlobalSearchProvider` / `unregister` / `listGlobalSearchProviders` / `subscribeGlobalSearchProviders`。内置 provider 通过 `providers/index.ts` 一次性注册；插件用同一接缝（`GlobalSearchProvider` 是与宿主无关的数据 + `callback` 动作）。                                                                                                                                                 |
| `scoring.ts`      | `scoreTitleMatch(query, text)` = `titleMatchRank`（前缀 / 词首 / 任意位置）与 `fuzzyMatch` 位置及新近度半衰期融合；每个 provider 交给引擎的 `score ∈ [0, 1]`，*全部* 范围下各分组按最佳命中排序。                                                                                                                                                                                              |
| `cache.ts`        | `createSearchCache(loader, ttlMs)`——带 TTL 的按 provider 记忆，每次对话框打开时由 `invalidateGlobalSearchCaches()` 清空。异步 provider 通过它读 Dexie，一次击键绝不重扫整表。                                                                                                                                                                                                                  |
| `recents.ts`      | `localStorage` 里按宿主分键的最近查询（8 条）与最近打开项（12 条），提供 `record*` / `list*` / `clear*` 与供空态使用的订阅。                                                                                                                                                                                                                                                                     |
| `engine.ts`       | `runGlobalSearch(parsed, ctx, { limit, signal })`——按范围（或 `in:` 过滤）解析 provider，带每 provider 预算并发运行，容忍单个 provider 失败（按分组上报，绝不致命），返回 `{ groups, coverage, tookMs }`，每组为 `{ kind, items, total, truncated }`。*全部* 范围下分组顺序是稳定的 kind 优先级再按最佳分数重排；范围页签返回一条可"显示更多"的深列表。                                          |

**内置 provider**（`lib/global-search/providers/`）：`sessions`（标题 + id，经 `isSessionExposed(…, "global-search")` 过滤，感知归档 / 工作区 / 类型，按新近度排序，`suggest` = 最近会话）、`messages`（包装 `searchChatHistory`，新增 `roles` / `after` / `before` 过滤，*会话* 范围下 `collapseBySession`，覆盖度 → `indexing` / `partial`）、`navigation`（侧栏目录 + 对话 / 画布）、`settings`（可达的 `SETTINGS_NAV` 分区 + `SETTING_CONTROLS` → `/settings?section=&focus=`）、`actions`（新建会话、导出、清空、主题、打开文件夹、检查更新、技能录制器——由对话框宿主解析的 `command` 动作）、`characters`、`teams`、`workspaces`、`workflows`、`skills`、`memories`、`templates`、`scheduled-tasks`、`plugins`、`plugin-actions`（快捷动作注册表）、`mcp-servers`、`inbox`（绑定平台的会话 → `/inbox/c?key=`）、`workbench-panels`。

### 3. 会话搜索：标题*与*内容，可过滤

`ChatSearchQuery` 新增 `roles?`、`after?`、`before?`（在会话元数据步骤应用，语料扫描不变；有过滤时放宽超取倍数）。*会话* 范围显示两组——**会话**（标题命中）与 **提到 … 的会话**（按会话折叠的消息命中）；*消息* 范围则是不折叠的深列表，带角色徽标、相对时间、归档 / 分支副本标签与高亮片段。选中消息命中仍走 `jumpToSessionMessage`（ADR-0094），落点失败会提示。

### 4. 对话框结构

`CommandDialog` 且 `shouldFilter={false}`（排序是引擎的事）：范围页签行（`Tab` / `Shift+Tab` 循环，`Alt+1…7` 直达）、带可移除过滤芯片的输入框、按 kind 渲染行的分组结果（`global-search-result-row.tsx`）、*全部* 范围下每组末尾的"在 <范围> 中显示全部 N 条"、空态（最近搜索、最近打开、建议）、含键盘提示 / 命中数 / 耗时 / 覆盖度说明（"仍在索引更早的历史"）的页脚。移动端渲染同一棵树，全高。

### 5. 不在范围内 / 保持独立

编辑器局部调色板保留：工作流编辑器的节点调色板与 spotlight（`components/workflow/editor/`）、画布内联命令、工作台 `PanelQuickSwitch`（自有可重绑组合键）、会话内查找栏（`chat.search.toggle`）、以及 web 搜索 `/search` 页（不同产品：BYOK 网页问答）。

工作流编辑器调色板保留 ⌘K，但不再走裸监听。它通过 `hooks/workflow/use-workflow-command-palette-shortcut.ts` 在同一分发器上注册 `workflow.commandPalette.toggle`，并在画布挂载期间发布 `view.workflowEditor`；`app.commandPalette.toggle` 则带上完全取反的 `!view.workflowEditor`。同一组合键、相反 `when` ⇒ 分发器的"首个命中即停"循环只可能触发其中一个，`findAppConflict` 不会把这对报成冲突，两行在设置 → 快捷键中都可重绑。编辑器内仍可通过标题栏搜索胶囊（走 `requestCommandPalette()`）打开全局搜索。

## 后果

- 任一路由上一次按键只打开一个对话框；绑定在 设置 → 快捷键 中可见、可重绑。
- 每个实体族距离调色板只差一个 provider 文件；移动端调色板获得它从未有过的 14 个分组，桌面端获得工作流、技能、记忆、模板、计划任务、插件、MCP 服务器、收件箱会话与设置控件。
- 移除：`components/inbox/inbox-command-palette.tsx`、`components/settings/finder/settings-finder.tsx`、桌面调色板 500 行主体、移动端的复制品，以及 `desktop.commandPalette` / `mobile.search` / `inbox.commandPalette` 文案树与查找器自身的界面文案（由 `globalSearch.*` 取代；`settings.finder.controls.*` 作为控件标签保留）。
- 后续：触及常驻语料上限时加 `*grams` 会话预过滤（ADR-0099 B 阶段）；为伴侣画像在服务端持久化"最近打开"。

## 修订（2026-08-21）—— 会话列表同样是一个检索面

按本 ADR 自身的前提审计了侧边栏会话列表——找到一个会话不应取决于你恰好站在哪里——并修复了违背该前提的八处问题。列表现在是本 ADR 治下的第二个检索面，排序器就是同一个函数。

### 6. 视图取代筛选预设

`ConversationSidebarSettings.filterPresets` 只能保存快捷筛选，因此人们真正想要的视图——「未读优先」「本周创建的一切」「检索整个账号」——无法表达：它们各自还需要一个排序、一个分组或一个搜索范围。**视图**（`lib/chat/conversation-views.ts`，`ConversationView`）可固定四个维度中的任意几个：`filters`、`sortBy`、`groupBy`、`search`。

它是**部分覆盖而非快照**：缺席的维度意味着「保持当前值不动」。这正是让每个已存预设天然成为合法视图、无需迁移的原因（预设就是只固定 filters 的视图），也避免了「未读优先」静默丢弃用户已选的分组。

存储沿既有的轴切分：定义存在 settings blob 里以跟随 profile，而**当前处于哪个视图**（`activeConversationViewId`）是 UI store 的布局态，因此手机与桌面可以各自停在不同视图。应用视图因此要写两处——这也是该写入放在 `useConversationFilterController` 而非各端的原因。

任一被固定的维度漂移后（`conversationViewDrift`），chip 显示 `名称 · 已修改`，并提供「恢复视图」/「更新此视图」。旧行为靠比较筛选来推断当前视图，用户一动就丢失视图；这也是「更新此视图」无法提供的原因——那时已经没人知道指的是哪个视图。

三个内置视图作为代码而非数据随包发布（**未读**、**最近创建**、**全局检索**）：它们是那些没人会去菜单里翻找的新语汇的发现入口。它们只能隐藏不能删除，且声称占用内置 id 的存储行会被忽略，以保证内置视图始终可达。

### 7. 搜索范围：一个控件，三条轴

侧边栏能否找到一个会话，过去取决于三件不相干的事——已归档的行只能靠把整个列表切到归档视图、其他工作区的行只有在*分组*恰好是 `"workspace"` 时才可见、消息内容则来自一个设置开关。`ConversationSearchOptions`（`lib/chat/conversation-search-scope.ts`）统一拥有这三条轴，视图可以携带它们，`ConversationSearchScopeControl` 就放在它所治理的输入框旁边。

- `needsCrossWorkspaceSessions(groupBy, search)` 决定 `useSessions` 的订阅，因此「我能不能找到这个会话」不再取决于列表如何分组。
- `includeArchived` **仅在存在查询时生效**。浏览归档会话仍是视图切换器的职责，两个控件因此永不描述同一件事。
- 旧的 `searchScope` 枚举经由解析器折叠进 `content`；对象在两个方向上都优先，因此降级再升级不会复活用户此后已经改掉的设置。

### 8. 同一个排序器，以及对异步同样的诚实

`buildConversationSections` 接受注入的 `scoreTitle`（`ConversationTitleScorer`），由 `hooks/chat/use-conversation-list-model.ts` 提供 `scoreTitleMatch`——于是「dply」在侧边栏也能找到「deploy」，且同一查询在两处的排序一致。用注入而非 import：`lib/global-search/scoring.ts` 已经引用了模型的 `titleMatchRank`，反向边会成环。

内容命中比标题命中晚一拍。两端都不得在 `contentSearch.loading` 期间声称「找不到 X」——那读起来像未命中，随后又自相矛盾——一字符查询现在会明说，而不是静默降级为仅标题（消息索引需要 `CONTENT_SEARCH_MIN_QUERY`）。

### 9. 日期跟随排序轴

无论排序如何，分桶过去都取自 `lastMessageAt`，于是「按创建时间」产出的是按最后活动分桶的列表，而 `oldest` 让行在正序表头下倒着走。`resolveConversationTimeBasis(sortBy)` 现在同时决定分桶、表头与活动筛选所读的时间戳；`oldest` 连同桶序一起倒转；而 `title` / `unread`——它们根本没有日期轴——渲染为单个扁平段，而不是一组解释不了列表的表头。（按首字母分组不成立：`localeCompare` 能排序中文标题，但没有拼音表就没有单个首字符能命名该组。）

### 10. team 是真正的分组轴

`groupBy: "team"` 过去只是发出普通日期桶，并依赖桌面 guild rail 已经过滤了列表——这让没有 rail 的移动端呈现出「按 team 分组」却其实并未分组的列表。`ConversationGroupAxis` 新增 `"team"`；rail 降级为*跳转*到某个 team 分区的方式，而收窄到单个 team 是既有 `teamIds` 筛选面的职责。

### 11. 阅读时把列表按住

列表是按活动排序的实时查询，因此后台会话会把行从光标下挪走——在日期分桶下甚至整个离开该分区。`lib/chat/conversation-order-freeze.ts` + `hooks/chat/use-conversation-order-freeze.ts` 在指针位于列表上时按住*顺序*（以及分区归属）。新增与删除从不被按住：冻结插入会与新会话的 reveal 打架，而按住已删除的行会留下一个点开什么也没有的行。

悬停是唯一的信号，按住本身是无声的。第一版还把「已滚动」也作为信号，于是按住可能活得比它的理由更久（往下滚一段然后走开），因而需要一个「N 条更新」的 pill 来逃出去。那个 pill 就是征兆——需要出口的机制，说明它按得太久了——而且它会为用户*正在打字的那个会话*弹出来，因为它自己的新消息和别的消息一样会重排列表。已滚动但未悬停意味着在阅读而非瞄准；此时行移动正是列表在做它该做的事。

`@tanstack/react-virtual` 只对长的**扁平、不可拖拽**分区做窗口化（搜索结果、`title` / `unread` 排序、超过 200 行）——那是唯一既没有 sticky 分组头要钉住、也没有 sortable 上下文要求条目留在 DOM 里的场景。

### 12. 其余修正

- `modelFolders` 同时在做两件事：在归档视图隐藏 folder *分组*，以及饿死 folder *筛选面*的选项，于是归档视图下的 chip 显示原始 folder id。已拆开。
- 「显示 N / 共 M」的 chip 改用 `visibleCount`（屏上的行），而 `filteredCount` 保留原义用于空态判定——把所有分组折叠起来并不等于「筛选无结果」。
- 设置 → 会话卡片移除 `sortBy` / `groupBy` / `searchScope`。该卡片决定行*长什么样*；设置页不是回答「我的会话去哪了」的地方，而视图能携带这些，设置页不能。
- `mobile.home.ungroupedWorkspace` / `ungroupedAgent` 在两种语言里都不存在，移动端的未分组表头一直在渲染自己的 key。已补齐，并新增 `ungroupedTeam`。

**新增范围：** `lib/chat/{conversation-views,conversation-search-scope,conversation-order-freeze,conversation-group-axis}.ts`、`lib/chat/conversation-{list-model,filters}.ts`、`hooks/chat/{use-conversation-list-model,use-conversation-filter-controller,use-conversation-order-freeze}.ts`、`components/chat/conversation-filter-controls.tsx`、`components/desktop/{channel-list,session-row}.tsx`、`components/mobile/shell/mobile-channel-list.tsx`、`components/settings/conversation/conversation-sidebar-card.tsx`、`stores/ui/ui-store.ts`、`packages/agent-config-types/src/index.ts`。
