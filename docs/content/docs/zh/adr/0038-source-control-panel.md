---
title: "ADR 0038 — 源代码管理面板（VS Code 风格 Git）"
description: "一个完整的 VSCode-built-in-Git 等效面板——文件和hunk层stage/unstage/discard、提交（amend/signoff）、分支操作、fetch/pull/push/sync、存储、合并冲突解决、blame、提交图和时间线——由混合Rust子系统（git2 读取 + system-git 作为 network/writes）支持，并用 Monaco 的DiffEditor渲染。"
---

# ADR 0038 — 源代码管理面板（VS Code 风格 Git）

> **状态**：已接受。实现端到端，并已提取为专用crate — `crates/cognia-git/`（ADR-0067阶段2，已从原`src-tauri/src/git/`移出）：**65 `git_*` 命令**，即`lib/git/`缝隙+存储`stores/git/`+`hooks/git/`控制器，`components/source-control/` UI，`/source-control`路由，以及StatusBar branch/sync指示器。

## 背景

cognia-next 已经有一个“项目”概念（`stores/project/project-store.ts`、`Project.rootDir`），集成终端将其用作工作目录，并且为 Canvas 接口 嵌入了Monaco——但没有版本控制UI**。sidecar的VSCode `scm`垫片明确是四级“NotSupported”，并注明真正的源控UI是“未来独立计划”。这个ADR就是那个计划：一个与活跃项目仓库绑定的VSCode-built-in-Git对应物。

Scope是VSCode**内置**Git功能集。最初被限定为GitLens/Git-Graph领域的两个功能——提交图视图（`commit-graph-view.tsx`，通过时间线访问）和porcelain blame视图（`git_blame` → `blame-view.tsx`）——随后被添加，现已成为面板的一部分（参见**自实施以来**）。

## 决策

### D1 — 混合后端：git2 用于读取，系统 `git` 用于 network/writes

`git2` in `src-tauri/Cargo.toml` 配置`default-features = false`了 `vendored-libgit2` 且没有 **no `https`/`ssh` 功能**——所以这个 libgit2 构建没有编译任何网络传输。这就锁定了分裂：

- **阅读**（状态、差异、log/history、分支、远程、存储列表、冲突、blame）直接使用`git2`——快速、结构化，无子进程。它们运行在`spawn_blocking`上是因为libgit2是同步的。共享的读核心存储在crate的`read.rs`中（模块`twin/code_repo.rs`会在后续中迁移到该模块上）。
- **变异+网络**（stage/unstage/discard、提交、分支switch/create/delete/rename、fetch/pull/push/sync、存储push/pop/apply/drop、标签、重置、恢复、sequencer/interactive-rebase、worktree、冲突解决）调用用户系统`git`通过crate的`exec.rs`。付费也使`pre-commit`/`commit-msg`/`pre-push` hook、GPG/SSH签名、gitattributes过滤器以及OS 凭证管理器/SSH代理的行为完全像用户终端——而git2会绕过这些。这与VSCode本身的做法相符。

### D2 — 来自活跃项目的 仓库 绑定;Open-Folder 回退

面板绑定在当前项目的`rootDir`（终端用于其 cwd 的同一源）。当没有设置任何项目`rootDir`时，用户可以在 `lib/files/file-bridge.ts` `pickDirectory`“打开文件夹”中指向任意仓库。一个新的`/source-control`路线存在于GuildRail活动栏（`AUXILIARY_ENTRIES`），隐藏在移动壳上，像 `/performance` 一样。

### D3 — Monaco DiffEditor差异和冲突解决

复用离线Monaco设置（`lib/canvas/monaco-loader.ts`）和`components/canvas/canvas-panel.tsx` ResizeObserver `layout()`修复。每个差异 hunk 都包含一个**自包含统一补丁**（文件头 + 一个`@@`块），内置于 crate 的`diff.rs`中;hunk级stage/unstage/discard把补丁发回给`git apply --cached`/`--reverse`。冲突解决Monaco我们和他们的差异与accept-ours/theirs/both并列。

### D4 — 单一用户的FS实时刷新watcher

一个`notify` watcher（crate的`watcher.rs`，子系统唯一的管理状态）会发出去`git://status-changed`事件，忽略`.git/`下的所有refs/index/merge状态，并通过`ignore` crate丢弃gitignor的工作树切换。为避免卸载竞态，watcher有**单一拥有者**：始终安装的StatusBar控制器（`useGitBranchIndicator`）。面板从不自行启动watcher——每次安装和每次变异后都会刷新，所以正确性从不取决于触发事件。

### D5 — 类型错误模型

crate的`error.rs`定义了`thiserror`枚举，序列为`{ kind, detail }`（`NotARepo` / `DirtyWorkingTree` / `MergeConflict` / `AuthRequired` / `NetworkFailed` / `PatchFailed` / `LockHeld` / `GitNotInstalled` / ...）。渲染器开启 `err.kind` 来驱动不同的UI→（如解析器冲突、认证→ 凭证 CTA、非仓库 →打开文件夹），而不是局部脆弱子串匹配。每个`detail`都会经过一个URL-credential编辑器（`exec::redact`）后，才离开后端。

## 居住于

| 层 | 路径 |
| -------- | --------------------------------------------------------------------- |
| 后端 | `crates/cognia-git/src/` — `commands`、`read`、`exec`、`status`、`diff`、`diff_stat`、`stage`、`commit`、`branch`、`remote`、`stash`、`merge`、`history`、`blame`、`tag`、`reset`、`restore`、`sequencer`、`interactive_rebase`、`worktree`、`repo`、`watcher`、`error`、`types`（根据ADR-0067阶段提取自`src-tauri/src/git/`） |
| 缝隙 | `lib/git/`（`commands.ts`、`events.ts`、`types.ts`、`language-map.ts`、`load.ts`） |
| 州际 | `stores/git/git-store.ts`，`hooks/git/{use-git-repo,use-git-actions,use-git-branch-indicator}.ts` |
| UI | `components/source-control/*`（包括`blame-view`、`commit-graph-view`、`timeline-view`）、`app/source-control/page.tsx`、GuildRail + StatusBar条目 |

## 验证

- Rust：`cargo test -p cognia-git`（阅读发球台日志——RTK掩盖Cargo出口代码）。System-git 测试被 `git --version` probe 控制;Cargo目标居住在仓库根`target/`。
- 前端：`pnpm typecheck`、`pnpm build`、`pnpm test`（共址，≥90%），`pnpm lint:i18n`（`sourceControl`命名空间+`desktop.guildRail.sourceControl`）。
- 手动（`pnpm tauri dev`）：克隆一个仓库，确认克隆工作区打开→阶段 a hunk →触发身份要求提交→保存仓库本地和全局身份，并确认原始提交重试，→切换分支→ fetch/pull/push/sync →存储→解决时间线冲突→ blame →。

## 自此实施（最初范围确定）

- **提交图视图**（`commit-graph-view.tsx`，通过时间线）和**porcelain blame**（`git_blame` → `blame-view.tsx`）。
- **`git init`**，从非仓库状态（`git_init`在`repo.rs`中）加`git_ignore_add`——非非-仓库状态不再仅限解释者。
- **worktree管理**，从同步工具栏：列出、创建、打开、删除，选择性删除链接分支，并通过现有`git_worktree_*` 命令接口层修剪陈旧的worktree记录。
- **仓库从空源控制器状态（`git_clone`）和repository-local/global提交身份恢复（`git_identity` / `git_set_identity`）进行克隆**。缺失身份提交失败会使用带有类型错误的`identityRequired`错误，打开内联恢复对话框，并在用户保存姓名和邮箱后重新尝试原始提交。

## 超出范围 / 后续

- 多仓库工作区（每个项目一个活跃仓库）和子模块。
- 用这个UI来支持sidecar VSCode `scm`垫片。
- `twin/code_repo.rs`迁移到crate的`read.rs`，并汇聚到crate `exec.rs` `github/workspace.rs`。
- 尚未实现（候选后续）：reflog/recovery视图、GPG `-S`提交签名（今天仅签出）、以及行级/子层hunk 暂存。
