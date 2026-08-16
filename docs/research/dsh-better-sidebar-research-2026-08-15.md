# DSH Better Sidebar 对 Cognia Workspace 的可借鉴性研究

> 研究日期：2026-08-15  
> 上游仓库：[`omdsh-dev/DSH-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar)  
> 固定基线：[`5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d`](https://github.com/omdsh-dev/DSH-better-sidebar/tree/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d)（版本 `0.12.1`）  
> 本地只读克隆：`/Users/bytedance/Project/DSH-better-sidebar`  
> Cognia 对照基线：`0cb61616a978fa329a3414ac73a24ad751b42853` 加研究时 user-owned dirty worktree；dirty 文件用相对源码链接，不把它们误写成该 commit 已发布内容。  
> 方法：仅检查固定 commit 的源码、测试、包元数据、README 与许可证，并只读对照 Cognia 现有实现；所有上游引用均固定到该 commit。本报告不修改 DSH 源码，也不包含 Cognia 产品实现。

## 结论先行

**有明显可借鉴之处，但应吸收协议与交互原则，不应移植整个插件或另建一套 Cordis workspace service。** 对照 Cognia 现有代码后，真正值得推进的是两个缺口和三个参考模式：

1. **P0：先把 Cognia 已持久化但 dormant 的二 pane split 渲染出来。** 当前 `splitPanelId` / `splitRatio` 和三个 actions 已完整存在，UI 也明确显示 planned，但 renderer 只画一个 tabpanel。DSH 的递归 `SplitNode`、edge-drop 与跨 right/bottom move 是强参考，却不应成为第一步；先验证现有 vertical two-pane 状态的产品价值，再决定是否扩到任意递归 docking。[Cognia dormant model](../../stores/context-workbench/context-workbench-store.ts#L41-L62) [planned UI](../../components/context-workbench/context-workbench.tsx#L1515-L1529) [DSH state model](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L28-L90)
2. **P0/P1：统一 filesystem viewer matching/loading，复用现有 artifact renderer 与 editor bridge。** Cognia terminal path link 只有 Monaco text viewer，project preview 另有 Markdown/HTML/JSON switch，而 plugin renderer registry 只处理 namespaced artifacts；DSH 的 priority/detect/fetchStrategy descriptor 正好补的是这个缝隙，不是整个 workspace shell。[terminal viewer](../../components/terminal/file-viewer-dialog.tsx#L3-L15) [project preview](../../components/editor/project/project-file-preview-panel.tsx#L15-L54) [artifact-only registry](../../lib/artifacts/renderer-registry.ts#L1-L30) [DSH viewer contract](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L203-L255)
3. **参考：递归 split tree 与 pure reducers。** DSH 的 pane/split tree 及跨 panel reducer 是 future arbitrary docking 的具体样本，但不是 Cognia 当前 P0。[state model](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L28-L90) [cross-panel move](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L321-L395)
4. **参考：内容型 open 必须“落在视线内”。** DSH 区分 file/url content open 与纯 type open；Cognia 已有按 deepest root 路由到 live editor、无 editor 才 fallback 的 `project-editor-bridge`，应扩展该 seam，而不是发明第二个 targeted-open service。[Cognia editor routing](../../lib/files/project-editor-bridge.ts#L127-L165) [DSH auto-reveal](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L587-L614)
5. **参考：重型 surface 按需加载且失败可重试。** editor/terminal 独立为 lazy chunks，同一时刻的并发加载共享 promise，失败后清 cache 以允许重试；是否用于 Cognia 要由现有 bundle/performance 证据决定。[chunk loading](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/chunk-loader.ts#L155-L185) [lazy UI states](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/lazy-chunk.tsx#L25-L68)

`contextPanelRegistry` 的 disposer、capability/permission gates、badge、订阅，以及 ContextWorkbench 的 per-panel error boundary、keep-mounted `Activity` 和 `active` prop，Cognia **已经具备**；不要因 DSH 也有而再造一份。Cognia 在 workspace 搜索/recent/pinned/trust/multi-root、conversation grouping/filter/DnD、scope pruning 和 Tauri resource ownership 上也更完整。明确不借鉴：portal + 全局 CSS 挤压、Cordis service/version layer、DSH module-loader、localStorage session store、node-pty host、移动端一次性 bottom→right 迁移。

## 1. Cognia 现状对照：已有、部分已有、真缺口、不借鉴

| 分类                                             | Cognia 证据                                                                                                                                                                                                                                                                                                                                                                                                        | 对 DSH 的判断                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 已有：workspace 导航与安全                       | `WorkspaceSwitcher` 已有大列表 search、recent、pinned、per-root trust badge 和 multi-root 数量展示。[workspace switcher](../../components/shell/workspace-switcher.tsx#L31-L112) [root/trust UI](../../components/shell/workspace-switcher.tsx#L135-L190)                                                                                                                                                          | DSH 的“per conversation local workspace”不构成升级；保留 Cognia 模型。                 |
| 已有：conversation 组织                          | `ChannelList` 已支持 workspace/agent/date/folder grouping、title/content search、persisted quick filters 与 section-scoped DnD。[group/filter model](../../components/desktop/channel-list.tsx#L573-L647) [DnD semantics](../../components/desktop/channel-list.tsx#L828-L881)                                                                                                                                     | 不借鉴 DSH 的单 session list 组织方式。                                                |
| 已有：panel contribution kernel                  | `contextPanelRegistry` 已有 disposer、plugin unregister、badge、subscription、resource/capability/permission gates。[registry](../../lib/context-workbench/panel-registry.ts#L7-L65) [resolution](../../lib/context-workbench/panel-registry.ts#L88-L159)                                                                                                                                                          | 不新增 `betterSidebar` 式 service/version layer；在现有 registry 上扩字段。            |
| 已有：retention / visibility / failure isolation | Activated panels 已保持挂载并收到 `active`，ephemeral panel 可选择卸载；native/plugin surfaces 分别有 error isolation。[retention and active](../../components/context-workbench/context-workbench.tsx#L1545-L1645) [boundary](../../components/context-workbench/context-workbench.tsx#L177-L198)                                                                                                                 | DSH 的 `visible` 与 per-tab boundary 是已实现思想，不是 backlog。                      |
| 已有：有界持久化                                 | ContextWorkbench layouts 按 30 天和 200 scope 裁剪，并在读写边界 normalize。[pruning](../../stores/context-workbench/context-workbench-store.ts#L111-L115) [prune implementation](../../stores/context-workbench/context-workbench-store.ts#L170-L214)                                                                                                                                                             | 明显优于 DSH 无 remove/purge 的 localStorage key；不替换。                             |
| 已有：targeted editor routing                    | `project-editor-bridge` 以 deepest matching root 选择 live editor，支持 open/applyEdit/read/save/diff/reveal/terminal，并返回 handled/fallback 结果。[bridge contract](../../lib/files/project-editor-bridge.ts#L42-L85) [routing](../../lib/files/project-editor-bridge.ts#L127-L182)                                                                                                                             | 扩展/复用 bridge；不新增 parallel open service。                                       |
| 部分已有：split                                  | Store 已持久化 `splitPanelId` / `splitRatio`，有 activate/close/resize actions，narrow 会 auto-close；renderer 明确未读取，菜单显示 planned。[store contract](../../stores/context-workbench/context-workbench-store.ts#L41-L62) [actions](../../stores/context-workbench/context-workbench-store.ts#L346-L367) [ADR-0121](../content/docs/en/adr/0121-workbench-mobile-drawer-and-panel-customization.md#L31-L38) | **真正 P0** 是渲染现有 two-pane split；递归 tree 后置。                                |
| 真缺口：filesystem viewer registry               | Terminal link 是 Monaco-only；project file preview 是本地扩展名 switch；artifact registry 只按 plugin artifact `kind` 解析。[terminal viewer](../../components/terminal/file-viewer-dialog.tsx#L3-L15) [project preview](../../components/editor/project/project-file-preview-panel.tsx#L15-L54) [artifact registry](../../lib/artifacts/renderer-registry.ts#L10-L62)                                             | 吸收 DSH matcher/loader 分离，但接入 Cognia permission/static-export/Tauri file APIs。 |
| 不借鉴                                           | Cognia 是 Next static export + Tauri/Capacitor；上游是 DSH/Cordis React 18 web plugin + Node host。                                                                                                                                                                                                                                                                                                                | 不移植源码、Cordis、node-pty、host routes、bundle protocol 或 localStorage store。     |

## 2. 项目定位与总体架构

这是一个单 npm 包、host/client 双半的 DSH 插件。Host half 提供文件、Git、PTY、预览与 bundle routes；所有操作带 session scope，并以 Host/trusted-host 检查作为浏览器请求 trust fence。[host responsibilities](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/index.ts#L1-L15) [trust-fence decision](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/trust-fence.ts#L57-L76) Client half 创建 session-aware store、extension registry、右侧/底部 workbench、link/file interception 和设置入口。[client wiring](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/index.tsx#L30-L74) [settings contribution](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/index.tsx#L197-L208)

```text
DSH host services
  └─ host half: /sidebar/api, /sidebar/file, /sidebar/html, WebSocket, lazy bundles
       ↕ session-scoped HTTP / WS
client activation
  ├─ SidebarStore: per-session layout + prefs snapshot
  ├─ BetterSidebarService: tab/viewer registries + open/close/update lifecycle
  ├─ built-in descriptors: explorer/editor/git/subagent/terminal/browser/diff
  └─ Sidebar shell: right workbench + bottom workbench + settings/interceptors
```

Host/client 分隔本身值得借鉴：UI contribution 不直接操作 Node/Rust 能力，而是通过明确、session-scoped 的 transport seam 调用。需要注意，上游 trust fence 自己也声明它是 DNS-rebinding/cross-site defense，**不是身份认证**；Cognia 若把同类能力暴露到远程/headless 场景，仍需独立的用户身份、授权和 capability policy。[trust-fence scope](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/trust-fence.ts#L1-L8)

## 3. Workspace / Sidebar UX

### 3.1 双工作台而不是单一 sidebar

桌面端同时提供全高右侧 panel 与只挤压中间列的 bottom panel；两者各有独立 split tree，但 tab 可跨 panel 拖动。面板宽/高分别拖动，共享角点可以同时改宽高。[shell layout contract](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L1-L18) 拖动过程中不逐帧更新 React store，而是直接写 DOM 和 CSS variables，并在 pointer-up 时一次性提交、clamp、持久化；同时用 `requestAnimationFrame` 合并高频 pointer events。[panel drag optimization](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L429-L500)

对 Cognia 的启示是：**layout preview state 与 persisted layout state 应分层**。高频 resize/drag 使用瞬态 DOM/animation state，结束时才写入正式 workspace store；否则 editor、terminal、artifact preview 都会被全树重渲染。

### 3.2 Tab 行为细节

- tab strip 横向溢出时，普通鼠标滚轮转为横向滚动；有 modifier 或无溢出时不截断页面原行为。[wheel behavior](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/TabBar.tsx#L77-L95)
- tab 支持拖到另一个 tab 前重排、拖到 strip 背景追加、拖到 pane edge 建 split、拖到 center 合并；中键关闭是额外效率路径。[tab drag/drop](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/TabBar.tsx#L109-L176) [edge/center semantics](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L321-L395)
- `+` 菜单完全由 registry 派生：过滤 hidden/disabled，按 order 排序，并用 `available` 显示 disabled 状态。[new-tab options](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L99-L116)
- tab 图标、badge、生命周期回调也来自 descriptor；badge 计算异常被隔离，不会击穿 tab strip。[descriptor lifecycle](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L173-L200) [badge guard](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L657-L675)

### 3.3 移动端策略

`<768px` 时只保留一个全宽 right drawer；bottom tabs 会深度优先追加到 right tree 的第一个 pane，bottom tree 被清空且 panel 关闭。迁移是幂等但**对当前 session 永久**，回到桌面不会自动迁回。[mobile shell behavior](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L20-L26) [migration reducer](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L219-L249)

这个方案实现简单，却把响应式 projection 变成持久化数据迁移。Cognia 更适合保留 canonical desktop layout，只在窄屏生成临时 single-pane projection，或至少记录 migration provenance 并允许恢复；否则“临时缩小窗口”会永久改写用户布局。

## 4. State / Data Model

核心数据结构非常紧凑：`SidebarTab` 只有 `id/type/title/path?/diff?/meta?`；leaf 保存 tabs 与 active；split 保存 row/col、sizes 和 children；session state 再组合 right/bottom trees、panel geometry、activePane、explorer expansions 与 terminal/browser counters。[state types](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L21-L90)

关键纪律如下：

- **结构操作尽量是 pure reducer**：split、move、close、activate、resize 等都返回新 state；tree traversal 与两棵树的归属判定集中在 state 模块，而非散落在视图中。[tree helpers](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L173-L205) [tab open reducer](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L471-L506)
- **每个 session 独立 snapshot**：切换 conversation 时，store 以 session id 载入/切换整份 layout；非当前 session 的 targeted open 可以更新并持久化目标 session，而不切换当前 UI。[session store](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L932-L983) [target-session reducer](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L1039-L1070)
- **持久化输入先 sanitize**：旧版/损坏 localStorage 会回退默认 state；width/height 会按当前 viewport clamp；重复 pane/split id 会重新编号；外部插件 tab type 是开放字符串，缺失 descriptor 时保留 tab，由 `OrphanedTab` 兜底。[sanitize entry](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L782-L847) [open tab types and meta restore](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L870-L909)
- **写入按 session 独立 debounce**：targeted open 不会取消另一个 session 的 pending write；localStorage 失败按 best-effort 处理。[persist scheduling](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L1072-L1089)

对 Cognia 来说，最可复用的是“canonical layout schema + pure reducers + versioned/sanitized restore + session/workspace scope”，而不是 localStorage 本身。Cognia 若需要跨设备、Tauri/Web/Capacitor 一致性，workspace layout 应进入已有持久化层并有显式 schema version/migration；上游键名虽含 `v1`，实际恢复依赖 shape sniffing 和字段默认值，并无独立 migration registry。[storage key and restore](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L727-L780)

## 5. Extension Points

### 5.1 Tab descriptor

`TabDescriptor` 覆盖 title/icon/order/hidden/available、single/dedupeKey、createTab、settings、badge、open/activate/close callbacks 和 component。三个很好的设计选择是：

1. `single` 只是 `dedupeKey` 的语法糖，单实例、按 path、按 id 去重统一成一个机制。[dedupe contract](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L135-L171)
2. `createTab` 允许 contribution 自己 mint instance id 和原子 state patch，适合 terminal/browser 这类多实例 surface。[built-in creation](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/builtins/tabs.tsx#L135-L183)
3. plugin-owned `meta` 与 settings blob 可以随 layout 持久化，不要求宿主为每个插件扩主 schema；但必须限制为 JSON-serializable。[tab meta contract](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L28-L40) [settings declaration](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L91-L116)

### 5.2 File viewer descriptor

viewer contract 将“如何选 viewer”和“如何取内容”分开：按 priority 稳定排序；有 head bytes 时先 `detect`，否则按 extension；`none/fsRead/mediaUrl/custom/binary-download` 明确了数据获取策略。[viewer types](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L203-L255) [matching algorithm](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L470-L498)

这适合 Cognia 在现有 artifact renderer 之外补一层通用 `FileViewerContribution`：matcher 与 loader 独立、loader 接收 abort signal、catch-all 保持最低优先级、用户可禁用单个 viewer。不要把 filesystem viewer 误塞进现有 artifact `kind` registry，也不要继续把扩展名 switch 写进各个 editor/viewer component。

### 5.3 Capability negotiation 与生命周期

service 同时暴露 semantic version 和单调增长的 `features` 列表，消费者可按 capability 检测 badge、lifecycle、targeted open、state subscription、tab meta、plugin settings 等能力，而不必只比较版本字符串。[service surface](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L275-L360) [feature list](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L377-L403)

register 返回 disposer；重复 id 明确抛错；callback 抛错被记录但不会打断 workspace 主流程。[registry behavior](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L405-L459) Cognia 可以沿用同样原则，但 contribution disposer 应归属现有 plugin/runtime scope，而不是新增第二套生命周期系统。

## 6. 建议 Cognia 吸收的模式

| 优先级 | 建议                                                                                                   | 可验证的最小验收标准                                                                                                                                                                       | 上游依据                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 完成现有 Context Workbench two-pane split renderer                                                     | `splitPanelId` 真正渲染第二 panel；split ratio 可拖动并持久化；narrow/mobile 自动回单 pane；两个 panel 的 focus、a11y、error boundary 与 lifecycle 都有 co-located tests                   | [Cognia dormant model](../../stores/context-workbench/context-workbench-store.ts#L41-L62) [DSH drop/split UI](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/split-pane.tsx#L76-L205)                                                           |
| P0/P1  | 新增统一 `FileViewerContribution` registry，并复用 `project-editor-bridge` 的 handled/fallback routing | terminal link、project preview 和其他 file open 使用同一 matcher；支持 extension、priority、optional sniff、abortable loader、permission gate 与 fallback；内置和插件 viewer 共用 contract | [Cognia bridge](../../lib/files/project-editor-bridge.ts#L127-L182) [DSH viewer matching](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L470-L498)                                                                                  |
| P1     | 为现有 Context Workbench reveal 增加明确的 content-open / inactive-session 语义                        | 当前 session 的 file/url open 自动确保 host 可见；后台 session 只记录 pending target，不抢当前焦点；所有路径仍经过现有 capability/permission gate                                          | [Cognia registry](../../lib/context-workbench/panel-registry.ts#L7-L65) [DSH targeted open](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L587-L623)                                                                                |
| P1     | 审计昂贵 panel 对既有 `active` signal 的使用                                                           | 隐藏 terminal/task topology/log/browser 后停止不必要的轮询或渲染；重新显示续接；轻量 panel 不为“统一”而强行 keep-alive                                                                     | [Cognia active contract](../../types/context-workbench.ts#L227-L271) [DSH visible prop](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts#L118-L133)                                                                                    |
| P2     | 有性能证据后再引入 release-only layout commit 或专用 lazy-chunk cache                                  | resize 采样证明 React/store churn 后才改提交策略；bundle 分析证明现有 dynamic imports 不足后才新增缓存协议                                                                                 | [DSH drag batching](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L429-L500) [DSH chunk cache](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/chunk-loader.ts#L155-L185) |
| Later  | 仅在 two-pane 证明不足时升级为递归 split tree / cross-dock reparent                                    | 先定义 stable runtime ownership；移动 terminal/browser 后 PTY/WebSocket/webview lease、scrollback、draft 与进程 identity 不重建                                                            | [DSH recursive model](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L42-L90) [DSH remount limitation](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/README_EN.md#L251-L258)           |

## 7. 不宜照搬与已知限制

1. **Portal/CSS 挤压是宿主缺 slot 的补偿。** 上游说明它因 core AppFrame 没有 right-side hole，才把 fixed panels portal 到 `document.body`，再用 CSS variables 挤压 `#root`。[portal rationale](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx#L1-L13) Cognia 应让 workspace 成为一等 layout owner 或正式 slot，避免依赖宿主 DOM 层级与全局 CSS selector。
2. **移动端迁移会永久改写布局。** 进入 narrow 后 bottom tabs 被移动并清空原树，回到 desktop 不恢复；README 也明确把它列为限制。[migration code](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L219-L249) [known limitation](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/README_EN.md#L251-L258)
3. **localStorage-only 不适合跨设备 workspace。** state 只见 `getItem`/`setItem`，写入失败直接忽略；README 宣称“stale state auto-purged”，但固定基线源码中没有 `localStorage.removeItem/clear` 或 purge 路径。这是文档与实现不一致，不能据 README 假定已有清理策略。[README claim](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/README_EN.md#L20-L30) [actual read/write paths](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L750-L780) [persist path](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts#L1072-L1089)
4. **运行时耦合不可移植。** Client bundle、Cordis context、DSH module table、host routes、slots/session/locale services 都是 DSH 专用。其 purity gate 禁止跨插件 value import、要求走 Cordis services，这个原则可借鉴，但 bundler/module-loader 实现不应带入 Next/Tauri/Capacitor。[bundle contract](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/tsdown.config.ts#L1-L39) [purity gate](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/tsdown.config.ts#L222-L240)
5. **资源型 tab 还没有 stable reparent。** 上游明确承认 terminal 跨 pane 会 remount 并重启 shell；这说明“移动 tab 的 layout reducer”与“保持资源 owner/handle 不变”尚未解耦。[known limitations](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/README_EN.md#L251-L258) Cognia 若移动 terminal/browser/remote session，内容实例应由稳定 host 持有，pane 只改变 projection。
6. **现成功能边界并不完整。** Git 无 push/pull/fetch、无 file watcher；Office viewer 依赖外部插件；iframe 登录、third-party cookies、X-Frame-Options 与 in-frame history 都有限制；HTML preview 不含 unsaved draft。[known limitations](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/README_EN.md#L251-L258) 因此它适合作为 workspace shell 与 extension-contract 样本，不应被当成完整 IDE 能力基线。
7. **Trust fence 不等于 authorization。** 它只验证 Host/origin/fetch-site；源码明确说明不是 authentication。固定基线的 `fs.tree/fs.read/fs.write` 也没有像 media/HTML routes 一样统一执行 `isWithin(cwd, path)`，所以不能把这个 host API 当作 Cognia workspace confinement 的替代品。[trust fence](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/trust-fence.ts#L1-L8) [filesystem routes](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/index.ts#L204-L232) [media containment](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/index.ts#L553-L565) Cognia 的 filesystem/terminal/git contribution 仍需进入现有权限、PII、sandbox 与远程访问边界。

## 8. 建议的下一步验证（不等于立即实现）

1. **先完成 two-pane split 的技术方案与交互原型**：不改现有 store schema，直接消费 `splitPanelId/splitRatio`；验证两个真实 panels 同时工作的 focus、resize、lifecycle、mobile 回退与性能，再决定是否进入实现。
2. **单独设计 filesystem viewer contract**：盘点 terminal viewer、project preview、attachments/artifacts 与 plugin renderer 的边界；viewer 只负责匹配/加载/呈现，file open 继续由 `project-editor-bridge` 决定 live editor 还是 preview fallback。
3. **测真实性能瓶颈**：记录 split/resize 期间 workspace commit 次数、React render 次数、terminal/editor 重挂载次数；只有证据显示瓶颈存在时，才采用 direct-DOM preview + release commit。
4. **递归 docking 前先规定资源所有权**：terminal/browser/remote agent view 的 runtime handle 不应归 pane component；验证 drag 后进程、WebSocket、scrollback、unsaved state 均不重建。
5. **移动端保持 responsive projection**：Cognia 已有 drawer/snap-point 语义，不要因临时窄屏永久改写 canonical desktop layout。

## 9. License

上游 `package.json` 声明 MIT，仓库 `LICENSE` 允许使用、复制、修改、合并、发布、分发、再许可和销售，但要求软件的全部或实质部分保留版权与许可声明，并按 “AS IS” 提供、无担保。[package license](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/package.json#L72-L84) [MIT text](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/LICENSE#L1-L20)

因此：

- **吸收思想、接口形状或自行重写**通常没有 copyleft 传播问题；
- **若复制实质性源码/样式/测试**，应在 Cognia 的 third-party notices 或对应文件中保留 `Copyright (c) 2026 dsh-external` 与 MIT 许可证；
- 本段是工程侧许可证观察，不替代法律审查。

## Primary sources

- [Pinned source tree at `5bd961f`](https://github.com/omdsh-dev/DSH-better-sidebar/tree/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3)
- [Client extension service](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/service.ts)
- [Workspace state and reducers](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/state.ts)
- [Sidebar shell](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/client/Sidebar.tsx)
- [Host half](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/src/index.ts)
- [README at the pinned commit](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/README_EN.md)
- [MIT license](https://github.com/omdsh-dev/DSH-better-sidebar/blob/5bd961f7f1f65b2a0ddace6d2b4e7d94a2a2fc3d/LICENSE)
