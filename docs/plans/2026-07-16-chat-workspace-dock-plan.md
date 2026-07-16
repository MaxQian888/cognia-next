# 聊天右侧产物区 → 双模式工作区 Dock

**日期**: 2026-07-16
**状态**: 待执行
**参考 ADR**: 0038（Source Control）、0057（Chat rendering / artifact dock 挂载）、0044（Editor LSP）、0065（工作区禁闭）、0068（前端包抽取 / artifact-store 切片）

---

## 1. 研究结论（先读这节，它推翻了「不存在」的默认假设）

**右侧产物区已经存在，而且明确照着 Codex 抄。** 不是死代码，三处挂载全活：

| 位置                       | 文件:行                                             |
| -------------------------- | --------------------------------------------------- |
| 桌面聊天工作区             | `components/desktop/desktop-chat-workspace.tsx:540` |
| 移动端外壳（降级为 Sheet） | `components/app-shell-mobile.tsx:552`               |
| IM 单会话                  | `app/inbox/c/page.tsx:123`                          |

`components/artifacts/artifact-workspace-dock.tsx:9-14` 的注释自己画着这张图：

```
 ┌───────────────────────────┬──────────────┐
 │ Chat (children)           │ Artifacts    │
 │            ◀ resize ▶     │ dock         │
 └───────────────────────────┴──────────────┘
```

宽度 24–50%（默认 34%）、`Cmd/Ctrl+J` 开合、localStorage 持久化（`stores/artifact/artifact-dock-layout-store.ts`，注释同样写着 "Codex / Claude-artifacts style"）、新产物到达自动展开。

### 但它和图里那套是两种不同的东西

|        | 图中 Codex 右侧                               | 现有 ArtifactDock                     |
| ------ | --------------------------------------------- | ------------------------------------- |
| 单位   | 仓库里的**文件**                              | **Artifact**（内容种类）              |
| 来源   | agent 的 Edit/Write **落盘结果**              | 助手正文里**正则检测出的代码块**      |
| 多开   | 顶部标签页（审阅 / SKILL.md / README.md / +） | 单个 `activeArtifact` + 左侧历史 rail |
| 文件树 | 有，带筛选框                                  | 无                                    |
| 审阅   | 工作区真实 diff                               | artifact 的 AI 改写提案 diff          |

证据：

- `types/artifact/artifact.ts:11` — `ArtifactType = code|html|react|svg|mermaid|chart|math|document|jupyter`，**内容种类，没有文件路径概念**。
- `lib/ai/generation/artifact-detector.ts` — 靠 `/```(\w+)?\n([\s\S]*?)```/g` 扫代码块，默认 ≥10 行才建。
- agent 真正改盘的 `Edit`/`Write`/`MultiEdit` 走 `components/chat/message-parts/mcp-tool-card.tsx:71-76` 的 `EditCard`/`WriteCard` 内联渲染，**从不进 dock**。
- 中间栏没有图中那张「已编辑 5 个文件 +93 -48 / 撤销 / 审核」聚合卡。

**一句话**：dock 是「生成物查看器」，图里是「工作区文件浏览器」。壳对了，喂的数据不对。

---

## 2. 已决策

| #      | 决策                                                                                          | 理由                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **双模式 dock**：保留 `artifact` 模式，新增 `workspace` 模式，共用 dock 外壳 / 拖拽 / `Cmd+J` | 不破坏现有产物流（Canvas 仍依赖 `artifact-store`），又能拿到图里那套。替换式改造会废掉 1933 行 / 102 actions 的 `artifact-store` 检测·预览·版本历史链路，风险不对等 |
| **D2** | **审阅真相源 = git 工作区 diff**，复用 `components/source-control/` + `crates/cognia-git`     | `git_discard`（撤销）、`git_diff_file` + 逐 hunk stage/discard（审核）全是现成的，语义硬。turn-scoped 方案的「撤销」要自己实现反向回写，不如 git 硬                 |

**D2 的已知代价（接受）**：看到的是工作区全部改动，含用户自己改的，不严格等于「本轮 agent 改了什么」；且只在 git 仓库内可用。非 git 目录降级为「无审阅卡」，不做 fallback（见 §6 反简化）。

---

## 3. 复用清单 —— 这是接线计划，不是新建子系统

Working Rule 1 要求先证明没有等价实现。逐条证明如下：

| 需要的能力                                                 | 已存在于                                                                                                                            | 状态      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| dock 外壳 / 拖拽 / 持久化 / 快捷键                         | `components/artifacts/artifact-workspace-dock.tsx` + `stores/artifact/artifact-dock-layout-store.ts`                                | ✅ 直接用 |
| 多文件标签页（含 dirty 点 + Save All）                     | `components/agent/workspace/editor/project-editor-tabs.tsx`                                                                         | ✅ 需解耦 |
| 文件树（懒加载 / 尊重 .gitignore / CRUD / 右键菜单）       | `components/agent/workspace/editor/project-file-tree.tsx`                                                                           | ✅ 需解耦 |
| Monaco（`file://` URI + 跨文件 LSP + 主题同步 + snippets） | `components/agent/workspace/editor/project-monaco.tsx`                                                                              | ✅ 需解耦 |
| 筛选框 / 项目内搜索（图右上「筛选文件…」）                 | `components/agent/workspace/editor/project-search-panel.tsx`                                                                        | ✅ 需解耦 |
| 编辑器状态机（open/dirty/save/外部变更/LSP root 注册）     | `components/agent/workspace/editor/use-project-editor.ts`                                                                           | ✅ 需解耦 |
| 磁盘读写（路径穿越已在 Rust 侧校验）                       | `lib/files/workspace-fs.ts`                                                                                                         | ✅ 直接用 |
| 外部变更监听                                               | `lib/files/workspace-watch.ts`                                                                                                      | ✅ 直接用 |
| 跨界面「打开这个文件」 seam                                | `lib/files/project-editor-bridge.ts`（终端点路径已在用）                                                                            | ✅ 直接用 |
| 真实 diff + 逐 hunk stage/unstage/discard                  | `components/source-control/{diff-pane,diff-viewer}.tsx`                                                                             | ✅ 直接用 |
| 撤销                                                       | `git_discard` / `git_discard_all`（`crates/cognia-git/src/commands.rs:213,225`）                                                    | ✅ 直接用 |
| 工作区状态 + 实时刷新                                      | `git_status` + `git://status-changed` 事件 + `stores/git/git-store.ts`                                                              | ✅ 直接用 |
| root 来源                                                  | `ChatSession.projectId` → `Project.roots[]` → primary root（`lib/workspace/roots.ts`）；与终端 / source-control 同源（ADR-0038 D2） | ✅ 直接用 |
| 桌面/配对门禁                                              | `hasFsBackend()`（`agent-team-editor.tsx:37`）= `isTauri() \|\| loadCompanionConfig() != null`                                      | ✅ 直接用 |

### 唯一真正要新写的东西

**每文件 `+N −M` 行数。** 已查实 `crates/cognia-git/src/types.rs:33-41` 的 `GitFileChange` 只有 `path / origPath / status / staged / group`，**没有 insertions/deletions**；41 个 `git_*` 命令里也没有 `git_diff_stat`。`components/source-control/change-item.tsx` 因此只画 M/A/D 字母，没有行数。

→ 新增**一个** Rust 命令 `git_diff_stat(repoPath) -> Vec<{path, insertions, deletions}>`。

**不要**把 insertions/deletions 塞进 `GitFileChange`：`git_status` 是 fs watcher 每次 debounce 都打的高频路径，给它加逐文件 diff 计算会在大仓库上拖垮状态刷新。单独命令 + 由卡片懒调，是唯一正确的切法。

---

## 4. 目标形态

```
┌──────────────┬───────────────────────┐
│ Chat         │ [产物|工作区]  ← 模式  │
│              ├──────┬────────────────┤
│ ┌──────────┐ │ 审阅 │ SKILL.md │ +  │
│ │已编辑5个 │ │──────┴────────────────┤
│ │文件+93-48│ │ README.md   │ ▸plugins│
│ │撤销  审核│ │ (Monaco)    │ ▸skills │
│ └──────────┘ │             │  文件树 │
└──────────────┴─────────────┴─────────┘
```

---

## 5. 分阶段计划（每阶段 → 可验证的检查）

### P0 — dock 模式模型

- `artifact-dock-layout-store.ts` 加 `dockMode: "artifact" | "workspace"`，纳入 `partialize`，`version: 1 → 2` + migrate（旧值默认 `"artifact"`）。
- `artifact-dock.tsx` header 加模式切换（`Tabs`/SegmentedControl），复用现有 header 布局。
- 自动展开规则改造：新 artifact 到达 → 切 `artifact` 模式并展开（保持现状）；审阅卡点击 → 切 `workspace` 模式并展开。
- **verify**: `pnpm test -- stores/artifact/artifact-dock-layout-store.test.ts components/artifacts/artifact-dock.test.tsx` — 覆盖两模式渲染 + migrate 老 localStorage 值。

### P1 — project-editor 去 agent-team 化（最高回归风险）

现耦合点只有两个：`use-project-editor.ts` 的 `teamId` 入参，和持久化落在 `agent-team-store.editorSession[teamId]`（`use-project-editor.ts:152-158`）。其余（workspace-fs / git worktree / LSP / watch）全是通用的。

- `UseProjectEditorArgs.teamId: string` → `scopeKey: string`（形如 `team:${id}` / `session:${id}`）。
- 持久化从 `agent-team-store` 抽到新的 `stores/editor/project-editor-session-store.ts`，键为 `scopeKey`；**保留 agent-team 既有数据的迁移**（把 `editorSession[teamId]` 搬到 `session store["team:"+teamId]`）。
- 文件移动 `components/agent/workspace/editor/` → `components/editor/project/`，`AgentTeamEditor` 改为薄包装继续存在。
- **反简化红线**：`AgentTeamEditor` 必须逐字保持现有行为（worktree 切换、code-server 回退、`registerProjectEditorOpener`、`PROJECT_EDITOR_GOTO_EVENT`）。这不是重写的借口。
- **verify**: `pnpm test -- components/agent/workspace/editor components/editor/project` 全绿；手动 `pnpm tauri dev` → agent-teams workspace → Editor tab 仍能开文件 / 改 / 存 / 跳转。

### P2 — dock 的工作区模式

- 新 `components/artifacts/workspace-mode/dock-workspace.tsx`：`ResizablePanelGroup` 组合 `ProjectEditorTabs`（上）+ `ProjectMonaco`（中）+ `ProjectFileTree`（右，对齐图）+ `ProjectSearchPanel`。
- root 解析：`activeSessionId` → `ChatSession.projectId` → `Project.roots[]` primary → `path`。无 projectId / 无 root → Empty 态（复用 `agent-team-editor.tsx:43` 的 `Empty` 写法）。
- `hasFsBackend()` 为假 → 工作区模式在模式切换器里禁用并给出原因（**不静默隐藏**，见 §6）。
- 挂 `registerProjectEditorOpener({ root, open })`，让终端 / 审阅卡都能路由进来。
- **静态导出约束**：`workspace-fs` 走 `transport.call`，本身兼容；但工作区模式在纯 web 下必须门禁掉，不能让 `out/` 构建引入 Tauri-only 假设。
- **verify**: `pnpm test -- components/artifacts/workspace-mode`；`pnpm build` 通过；手动在 tauri 里开会话 → 切工作区 → 文件树能展开、点文件开标签页、改了有 dirty 点、`Cmd+S` 存盘。

### P3 — `git_diff_stat` 命令

- `crates/cognia-git/src/`：新增 `diff_stat.rs`，用 `git2` 的 `diff_index_to_workdir` + `diff_tree_to_index`，逐 delta 取 `Patch::line_stats()`。
- 新 DTO `GitFileDiffStat { path, insertions, deletions }`（`#[serde(rename_all="camelCase")]`，与 `types/git/index.ts` 1:1）。
- 在 `commands.rs` 注册命令；**同步补 Tauri capability/ACL 条目**（新命令漏注册是本仓复发坑）。
- 大文件保护：沿用 `git/diff.rs` 既有上限策略，超限返回粗略行数而非阻塞。
- TS 侧 `lib/git/commands.ts` 加 `gitDiffStat(repoPath)`。
- **verify**: `cargo test -p cognia-git`（注意 `proxy_config` 类并行 flake → 必要时 `-- --test-threads=1`）；在脏仓库里手动核对 `git diff --numstat` 数字一致。

### P4 — 中间栏「已编辑 N 个文件 +X −Y」卡

- 新 `components/chat/workspace-changes-card.tsx`：订阅 `stores/git/git-store` + `git://status-changed`，懒调 `gitDiffStat`。
- 位置：`chat-view.tsx` 的 chat 分支，`PlanTrackerDock` 与 `RunStatusBar` 之间（与图中「在对话流下方、composer 上方」一致）。
- 行为：每文件行 → 点击 = 在 dock 工作区模式开该文件；`撤销` → `git_discard`（**必须二次确认**，不可逆）；`审核` → dock 切工作区模式 + 打开审阅标签页。
- 非 git 仓库 / 无改动 → 整卡不渲染。
- **事件监听用 `safeUnlisten`**（StrictMode 双挂载竞态是本仓已知坑）。
- **verify**: `pnpm test -- components/chat/workspace-changes-card.test.tsx`；手动让 agent 改几个文件 → 卡出现、数字对得上 `git diff --numstat`、撤销真的还原。

### P5 — 审阅标签页

- dock 工作区模式的第一个固定标签「审阅」，内嵌 `components/source-control/diff-pane.tsx`（已含逐 hunk stage/unstage/discard + Monaco DiffEditor）。
- **不新写 diff UI**。若 `diff-pane` 与 source-control 面板耦合过紧，只做最小 props 提取，不重写。
- **verify**: 手动在 dock 里 stage 一个 hunk → `/source-control` 路由里状态一致（两个界面共享 `git-store`，必须不打架）。

### P6 — 门禁

- i18n：**新键写 `i18n/messages/{en,zh-CN}/artifacts.json` 等分片源，然后 `pnpm i18n:build`**。绝不直接改 `i18n/messages/en.json`（那是构建产物，改了会被覆盖）。ICU 里的字面量 `{ } < # |` 需转义。
- 每个新文件配同目录 `*.test.tsx`；`pnpm test:coverage:changed -- --strict`。
- `pnpm changeset` → 选 `cognia-next` → `minor`（用户可见新功能）。
- `/preflight` 跑六个审计器（test-gap / i18n / static-export / tauri-rust / pii-gate / wiring）。
- **wiring 审计尤其重要**：本仓最复发的缺陷就是「造好了但没接上」。

---

## 6. 反简化红线（Working Rule 2）

以下每一条都是「省事但会留坑」的诱惑，明确禁止：

1. **不许**把 `git_diff_stat` 的行数塞进 `git_status` 图省事 —— 拖垮高频状态刷新。
2. **不许**为了非 git 目录造第二套 turn-scoped diff 真相源 —— D2 已决策单一真相源；非 git 就诚实地不显示审阅卡，而不是悄悄降级成一个语义不同的东西。
3. **不许**在 web/非 Tauri 下静默隐藏工作区模式 —— 要显式禁用 + 说明原因（本仓「意图性休眠必须三轴标注」的规则：类型上注明 + UI 标注 inert + 测试钉住）。
4. **不许**趁 P1 重写 `AgentTeamEditor` —— 那是解耦，不是重构许可证。
5. **不许**往 `artifact-store.ts` 加新 action —— 它已 1933 行 / 102 actions，ADR-0068 S5 明确要求切片而非增长。工作区模式的状态放新 store。
6. **不许**新写 diff 渲染 UI —— `diff-pane` / `diff-viewer` 已经存在且久经使用。

---

## 7. 风险与坑（均有前科）

| 风险                                                                         | 缓解                                                                                                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 嵌套 `ResizablePanelGroup`（dock 外层 + ChatPaneGroup 分屏 + dock 内层三栏） | 现状已是两层嵌套且工作正常；第三层需实测拖拽手感，必要时给内层独立 `layoutVersion` key                                                                   |
| Monaco 多实例（dock 工作区 + artifact 模式 + Canvas 可能同屏）               | `artifact-panel-content.tsx` 已在 dock 里挂 Monaco，无新增打包风险；但要确保模式切换时 dispose（复用 `lib/canvas/monaco-diff-disposal.ts` 的防竞态经验） |
| `git://status-changed` 监听器 StrictMode 双挂载                              | 用 `safeUnlisten`；watcher 单一属主仍是 StatusBar（ADR-0038 D4），**dock 绝不自己起 watcher**                                                            |
| dock 与 `/source-control` 状态打架                                           | 共享 `stores/git/git-store`，不新建并行状态                                                                                                              |
| 共享工作树（其他 agent 会话并发改同一棵树）                                  | 提交前 `rtk proxy git status` 复核；不 bare-stash                                                                                                        |
| 新 Rust 命令漏注册 capability/ACL                                            | `tauri-rust-reviewer` 审计器专门查这条                                                                                                                   |
| 大仓库文件树/diff 卡顿                                                       | 文件树已懒加载 + 尊重 .gitignore；`git_diff_stat` 沿用既有大文件上限                                                                                     |

---

## 8. 未决 / 后续

- 「本轮 agent 改了什么」的精确高亮（D2 接受了不精确）：可后续用 `lib/connectors/activity/diff-producer.ts`（已能从 Edit/Write 工具调用产出 `{filePath, hunks, stats}`，目前只喂 IM 活动卡）叠加标注。**本计划不做**。
- 移动端：工作区模式在 Sheet 里体验存疑，本计划只保证不崩（门禁关闭），不做移动端适配。
- `/inbox/c` 挂载点的工作区模式语义（IM 会话通常无 projectId）：默认落 Empty 态。
