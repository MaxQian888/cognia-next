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

**内置 provider**（`lib/global-search/providers/`）：`sessions`（标题 + id，经 `isSessionExposed(…, "global-search")` 过滤，感知归档 / 工作区 / 类型，按新近度排序，`suggest` = 最近会话）、`messages`（包装 `searchChatHistory`，新增 `roles` / `after` / `before` 过滤，*会话* 范围下 `collapseBySession`，覆盖度 → `indexing` / `partial`）、`navigation`（侧栏目录 + 私信 / 画布）、`settings`（可达的 `SETTINGS_NAV` 分区 + `SETTING_CONTROLS` → `/settings?section=&focus=`）、`actions`（新建会话、导出、清空、主题、打开文件夹、检查更新、技能录制器——由对话框宿主解析的 `command` 动作）、`characters`、`teams`、`workspaces`、`workflows`、`skills`、`memories`、`templates`、`scheduled-tasks`、`plugins`、`plugin-actions`（快捷动作注册表）、`mcp-servers`、`inbox`（绑定平台的会话 → `/inbox/c?key=`）、`workbench-panels`。

### 3. 会话搜索：标题*与*内容，可过滤

`ChatSearchQuery` 新增 `roles?`、`after?`、`before?`（在会话元数据步骤应用，语料扫描不变；有过滤时放宽超取倍数）。*会话* 范围显示两组——**会话**（标题命中）与 **提到 … 的会话**（按会话折叠的消息命中）；*消息* 范围则是不折叠的深列表，带角色徽标、相对时间、归档 / 分支副本标签与高亮片段。选中消息命中仍走 `jumpToSessionMessage`（ADR-0094），落点失败会提示。

### 4. 对话框结构

`CommandDialog` 且 `shouldFilter={false}`（排序是引擎的事）：范围页签行（`Tab` / `Shift+Tab` 循环，`Alt+1…7` 直达）、带可移除过滤芯片的输入框、按 kind 渲染行的分组结果（`global-search-result-row.tsx`）、*全部* 范围下每组末尾的"在 <范围> 中显示全部 N 条"、空态（最近搜索、最近打开、建议）、含键盘提示 / 命中数 / 耗时 / 覆盖度说明（"仍在索引更早的历史"）的页脚。移动端渲染同一棵树，全高。

### 5. 不在范围内 / 保持独立

编辑器局部调色板保留：工作流编辑器的节点调色板与 spotlight（`components/workflow/editor/`）、画布内联命令、工作台 `PanelQuickSwitch`（自有可重绑组合键）、会话内查找栏（`chat.search.toggle`）、以及 web 搜索 `/search` 页（不同产品：BYOK 网页问答）。工作流编辑器的裸 ⌘K 监听在 `/workflows/editor` 内仍与全局监听竞争；并入同一接缝是后续工作（`canvas.tsx` 正被并行会话重构）。

## 后果

- 任一路由上一次按键只打开一个对话框；绑定在 设置 → 快捷键 中可见、可重绑。
- 每个实体族距离调色板只差一个 provider 文件；移动端调色板获得它从未有过的 14 个分组，桌面端获得工作流、技能、记忆、模板、计划任务、插件、MCP 服务器、收件箱会话与设置控件。
- 移除：`components/inbox/inbox-command-palette.tsx`、`components/settings/finder/settings-finder.tsx`、桌面调色板 500 行主体、移动端的复制品，以及 `desktop.commandPalette` / `mobile.search` / `inbox.commandPalette` 文案树与查找器自身的界面文案（由 `globalSearch.*` 取代；`settings.finder.controls.*` 作为控件标签保留）。
- 后续：把工作流编辑器调色板并入接缝；触及常驻语料上限时加 `*grams` 会话预过滤（ADR-0099 B 阶段）；为伴侣画像在服务端持久化"最近打开"。
