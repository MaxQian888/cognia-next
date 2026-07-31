# 源代码管理面板（SCM / ADR-0038）— 缺口修复与硬化计划

**日期**: 2026-07-17
**状态**: 待评审（未实施）
**范围**: 六波 —— W0 文档纠偏、W1 后端健壮性、W2 跨传输门控死路、W3 测试补位（Rule-3）、W4 功能缺口、W5 i18n
**参考 ADR**: 0038（Source Control 面板，主 ADR，已严重陈旧见 W0.1）、0067（crate 分解 → `cognia-git`）、0078（CLI↔App bridge，git 复用点）
**关联记忆**: `source-control-panel-scm-audit.md`（本计划的调研底稿）

**一句话**: 这个子系统在本仓里是**异类** —— 它**没有**"建了没接线"的招牌病（62 命令前后端 1:1、27 组件全挂载、8 hook 全用、7 seam 全通、零生产 stub）。真正的缺口是**后端健壮性（redaction/watcher/错误分类）、一处用户可见的跨传输死路、测试黑洞（`commands.rs` 分发层零测）、几处 VSCode 对标增量、以及一份陈旧到误导的 ADR**。

---

## 0. 如何使用本文档

每个工作项自成单元：**问题 → 证据 → 修法 → 验收**。除非标注 **依赖**，否则彼此独立，一项一个 commit。

### 0.1 置信标签 —— 动手前先读这节

沿用 `2026-07-16-scheduler-subsystem-remediation.md` 的约定。**标签不是装饰。**

| 标签            | 含义                                        | 你必须做什么                                   |
| --------------- | ------------------------------------------- | ---------------------------------------------- |
| **[CONFIRMED]** | 本文作者亲手 read/grep 核实，file:line 已对 | 可信，但行号会漂 —— **按符号重定位，别按行号** |
| **[AGENT]**     | 由 subagent 提供证据，作者未独立复核        | **动手前先自行复核这条具体主张**               |
| **[OPEN]**      | 真正未决，需要人拍板                        | **不要默默替它做决定**，见 §6                  |

本文调研由三个 subagent 完成（Rust crate / 前端 UI / 接线可达性）。作者随后对**所有承重主张做了一手复核**（见 §7 溯源）—— 后端健壮性四项、跨传输门控、命令计数、`commands.rs` 无测、功能缺失、ADR 陈旧全部 [CONFIRMED]；测试覆盖细节与 worktree 消费者为 [AGENT]。

### 0.2 证据标准（不可妥协）

凡本文出现「零 / 缺失 / 不存在 / 未接线」的主张，均已跑阳性对照（用同形状命令搜一个已知存在的符号，确认工具在工作，再采信那个零）。你复核时请照做：

```bash
# 阳性对照：这条必须有命中，否则你的 grep 坏了
rtk grep -rn 'RecursiveMode' crates/cognia-git/src/watcher.rs
# 此时的零才可信（本文已验：components/source-control 无 worktree UI）
rtk grep -rln 'worktree' components/source-control/
```

---

## 1. 研究结论（先读这节，它推翻了「面板还缺很多功能」的直觉）

第一直觉是「源代码管理面板功能不全，要补 UI」。**事实相反：这是一个成熟、接线完整的 VSCode-内建-Git 等价面板。**

- **后端** `crates/cognia-git/`（ADR-0067 Phase 2 从 `src-tauri/src/git/` 抽出）：**62 个 `#[tauri::command]`** [CONFIRMED，`commands.rs`]，混合架构 —— git2 只读 + system-git 走网络/写入（保 hooks/签名/凭证），**零生产 stub**（`todo!`/`unimplemented!` 全仓为零，`.unwrap()` 只在 `#[cfg(test)]`）。
- **前端** `components/source-control/`（27 组件）+ `lib/git/` seam + `stores/git/` + `hooks/git/`（8 hook）+ `/source-control` route + StatusBar 分支指示器 + 插件 `git-api.ts` + 设置 `git-section.tsx`。**零孤儿组件、零休眠命令、命令↔UI 触发 1:1。**
- **接线** 7 个 seam 全通：route/GuildRail 入口（`desktopOnly`）、StatusBar watcher 单 owner、`git://status-changed` emit↔listener 成对（companion 还转发到 `/ws/v1/events`，`companion_api/commands.rs:374` [CONFIRMED]）、插件 git-api 已门控、settings 区块 writer/reader 同字段、AI 三功能有触发器+开关、auto-fetch 挂在 always-mounted 的 StatusBar。

> **所以本计划不是「补功能」，而是「修好已建成面板的健壮性缝隙 + 堵一处用户可见死路 + 补测 + 纠正陈旧文档」。**

**为什么缺口没人发现**：`Source Control` **不在 `CLAUDE.md` 的 Subsystem Map 里** [CONFIRMED] —— 表里 31 个子系统没有它，尽管它体量比多数都大（62 命令 + 专用 crate + 27 组件）。按 Working Rule 1「先查文档再实现」反而查不到。**这与 scheduler 子系统的返工根因一模一样**（见那份计划的 W4.1）。见 W0.2。

---

## 2. 缺口矩阵（本次调研的可复用产出）

| 层          | 缺口类别     | 代表项                                                               | 严重度 | 置信        |
| ----------- | ------------ | -------------------------------------------------------------------- | ------ | ----------- |
| 文档        | 陈旧/误导    | ADR-0038 写 35 命令（实 62）、Lives-in 指旧路径、缺 Subsystem Map 行 | 低     | [CONFIRMED] |
| 后端-安全   | 不变量未强制 | redaction 只在 2 条路径做，`From<git2::Error>` 裸传                  | 中     | [CONFIRMED] |
| 后端-正确性 | 资源泄漏     | watcher 裸路径 key 无 canonicalize → 重复 watcher                    | 中     | [CONFIRMED] |
| 后端-性能   | 过度注册     | 递归监听把 `node_modules`/`target` 全注册进 OS watch                 | 中     | [CONFIRMED] |
| 后端-UX     | 错误误分类   | HTTP 403/401 → NetworkFailed 而非 AuthRequired                       | 中低   | [CONFIRMED] |
| 前端-可达性 | 跨传输死路   | panel=`isTauri()` vs chip=`+paired` vs seam=`+capacitor+web`         | 中     | [CONFIRMED] |
| 测试        | Rule-3 违规  | `commands.rs` 分发层零测；network mutations/watcher 零测             | 中     | [CONFIRMED] |
| 功能-对标   | VSCode 缺项  | clone / config-write / worktree UI / reflog / GPG / 行级 stage       | 中→低  | [CONFIRMED] |
| i18n        | 硬编码       | `restore-dialog.tsx:79` `placeholder="HEAD"`                         | 低     | [CONFIRMED] |

---

## 3. 工作项

### Wave 0 — 文档纠偏（零风险，先做）

---

#### W0.1 — ADR-0038 已陈旧到误导，逐条纠正 **[CONFIRMED] / 必做**

**问题**：主 ADR 的每一处结构性描述都过时了，会把下一个改这块的人带偏。

**证据**（作者一手复核，读全文 `docs/content/docs/en/adr/0038-source-control-panel.md`）：

| ADR 原文                                      | 现实                                                                                                      | 位置                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| "35 `git_*` commands"                         | **62** 个                                                                                                 | `:9` vs `crates/cognia-git/src/commands.rs`（62 个 `#[tauri::command]`） |
| Lives-in → Backend: `src-tauri/src/git/`      | 已抽到 **`crates/cognia-git/`**（ADR-0067 P2）                                                            | `:8,87`                                                                  |
| Backend 模块列表 15 项                        | 缺 **9 项**：blame / diff_stat / interactive_rebase / reset / restore / sequencer / tag / worktree / repo | `:87`                                                                    |
| Out-of-scope: "`git init` 仅 explainer"       | **已实现** `git_init`（`repo.rs`）+ `git_ignore_add`                                                      | `:105` vs `source-control-panel.tsx:114`                                 |
| Scope: "no GitLens-style inline blame"        | 后端 `git_blame` **已存在**（`blame.rs`，commit-pinnable porcelain），UI `blame-view.tsx` 已挂载          | `:24,104`                                                                |
| Out-of-scope: "Git Graph commit-graph 可视化" | `commit-graph-view.tsx` **已存在且经 TimelineView 挂载**                                                  | `:104`                                                                   |

**仍然准确的未决项**（保留）：submodules/多 repo 工作区、backing sidecar `scm` shim、`twin/code_repo.rs` 迁到 `read.rs`（`read.rs:6-8` 注释仍说"应在后续迁移"—— 未做）、`github/workspace.rs` 收敛到 `exec.rs`。

**修法**：更新 ADR-0038 的 Status/Lives-in/命令计数/模块列表，把已实现项从 out-of-scope 移到"已实现"，保留真正的未决项。**是否新增一份 ADR** 见 §6 [OPEN-5]。

**验收**：`pnpm docs:build`（唯一能抓 MDX 预渲染错的检查）；ADR 的 Lives-in 表逐路径可 `ls` 命中；命令计数与 `grep -c '#\[tauri::command\]' crates/cognia-git/src/commands.rs` 一致。

---

#### W0.2 — `CLAUDE.md` Subsystem Map 缺 Source Control 行 **[CONFIRMED] / 必做**

**问题**：一个 62 命令 + 专用 crate + 27 组件的子系统不在复用查找表里，导致"先查文档"查不到 —— 与 scheduler 返工同根因。

**修法**：在 Subsystem Map 加一行：

| Subsystem       | Lives in                                                                                                                                                       | Schema                                    | ADR  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---- |
| 源代码管理(SCM) | `crates/cognia-git/`、`components/source-control/`、`lib/git/`、`stores/git/`、`hooks/git/`、`app/source-control/`、设置 `components/settings/source-control/` | AppSettings.gitSettings.panel（非 Dexie） | 0038 |

**注**：git 面板偏好存在 `AppSettings.gitSettings.panel`（`use-source-control-prefs.ts`），**不是 Dexie 表**，写进去避免下一个人误建表。

**验收**：Map 新行的每个路径可 `ls` 命中。

---

### Wave 1 — 后端健壮性（影响用户/安全，优先）

---

#### W1.1 — redaction 不变量未在边界集中强制，潜在凭证泄漏 **[CONFIRMED] / 中**

**问题**：`error.rs` 文档白纸黑字声明"每个 `detail` 离开后端前都过 `redact`"，但实际只有两条路径做了；任何未来把带凭证 URL 折进 git2 message 或直接 `CommandFailed` 的代码都会漏。

**证据**（作者一手复核，读全文 `error.rs` + `exec.rs:59-98`）：

- `error.rs:10-12` 不变量声明：_"Every `detail` is passed through `crate::exec::redact` before it leaves the backend so a credentialed remote URL never lands in renderer logs."_
- 但 `error.rs:59-70` 的 `impl From<git2::Error>` 把 `err.message().to_string()` **原样**塞进 `NotFound`/`LockHeld`/`MergeConflict`/`Libgit2`，**零 redact**。
- 实际 redact 只有两处：`exec.rs:61`（`classify_failure` 里 `let detail = redact(...)`，已验）和 `remote.rs:25-29`（`list_for`）[AGENT]。
- 所有直接 `GitError::CommandFailed(format!(...))` / `InvalidArgument(...)` 也绕过 `redact`。

**今日实际泄漏风险低**（libgit2 编译时无 https/ssh 传输 ⇒ 带凭证 URL 只出现在网络 op 的 stderr，而那条恰好走 `classify_failure` 已 redact）—— **但这是文档-与-代码互相打脸的脆性不变量**，一次重构就会破。

**修法**：把 redaction 收敛到**序列化边界**，而非各构造点。两选一（见 §6 [OPEN-1]）：

- **A**（推荐）：给 `GitError` 手写 `Serialize`（或 newtype wrapper），在序列化 `detail` 时统一过 `redact` —— 结构性堵死，无论谁构造错误都安全。
- **B**：在 `From<git2::Error>` 与所有直接构造点补 `redact` —— 治标，下一个构造点又会漏。

**验收**：新增单测 —— 构造一个 `detail` 含 `https://user:token@host/repo.git` 的 `GitError`（经 `From<git2::Error>` 与直接 `CommandFailed` 两条路），`serde_json::to_value` 后断言 token **不出现**在输出；`cargo test -p cognia-git error`（**读 tee 日志，别信退出码**）。

---

#### W1.2 — watcher 用裸路径串做 HashMap key，无 canonicalize **[CONFIRMED] / 中**

**问题**：同一 repo 的不同字符串形式（尾斜杠、软链 vs 实路径、`.` vs 绝对路径）会启动**两个独立的递归 watcher**，导致重复 `git://status-changed` 事件；用一种形式 `stop` 会漏掉另一个（watcher 泄漏）。ADR-0038 D4 声称的"单 owner"只是**渲染端纪律**，后端无 refcount/guard。

**证据**（作者一手复核）：

- `watcher.rs:36` `watchers: Mutex<HashMap<String, RecommendedWatcher>>` —— key 是裸 `String`。
- `watcher.rs:144` `state.watchers.lock().insert(repo_path.to_string(), watcher)` —— 直接拿传入串做 key。
- `watcher.rs` **全文无 `canonical`**（已跑阳性对照，`RecursiveMode` 命中而 `canonical` 零）。

**修法**：在 `start`/`stop` 用 key 之前 canonicalize —— `Repository::discover(path)?.workdir()` 或 `std::fs::canonicalize`，统一成规范路径再做 map key。这样同一 repo 的任何字符串形式都命中同一条目。

**验收**：单测 —— 用 `tempfile` 建 repo，以 `path`、`path/`、`path/./` 三种形式各 `start` 一次，断言 `watchers` map **只有一条**；`stop` 一次后 map 为空。

---

#### W1.3 — 递归监听把 `node_modules`/`target`/`.git/objects` 全注册进 OS watch **[CONFIRMED] / 中**

**问题**：`ignore` crate 只在**事件 emit 后**过滤，不阻止 OS **注册** watch。大仓上是每 repo 数千个 inotify/FSEvents watch。VSCode 在原生 watcher 层就 exclude 这些目录。

**证据**（作者一手复核）：`watcher.rs:117` `.watch(&repo_root, RecursiveMode::Recursive)` —— 对 repo 根递归注册；`path_is_relevant`（[AGENT]，`:60-84`）只在回调里丢弃 `node_modules`/`target`/`.git/objects` 的事件，注册已经发生。

**修法**：两选一 —— (A) 保持递归但在 `notify` 支持的层级做 exclude（`notify` 6.x 无原生 exclude，需换 `notify-debouncer` + 手动子树管理，代价大）；(B) 更实际 —— **只递归监听相关子树**：`.git/`（非 objects）+ 用 `ignore::WalkBuilder` 枚举未被 gitignore 的顶层目录逐个 `RecursiveMode::Recursive`，跳过 gitignored 的。见 §6 [OPEN-2]。**建议先量化**（在一个装了 `node_modules` 的真实 repo 上 `start`，用 `lsof`/FSEvents 计数），确认确实是问题再动手。

**验收**：在含 `node_modules` 的 fixture repo 上 `start` 后，断言 watch 注册数不随 `node_modules` 文件数线性增长（或至少：编辑 `node_modules/**` 不产生 `git://status-changed`，这条现在已由 `path_is_relevant` 保证，属回归防护）。

---

#### W1.4 — HTTP 403/401 被误分类为 NetworkFailed 而非 AuthRequired **[CONFIRMED] / 中低**

**问题**：token 权限不足（GitHub 常见）时，渲染端弹**网络错 CTA** 而非**凭证 CTA**，用户被引向错误的排查方向。

**证据**（作者一手复核 `exec.rs:59-98`）：GitHub 对无效/越权 token 报 `fatal: unable to access 'https://...': The requested URL returned error: 403`。该串：

- 不含 auth 分支（`:62-68`）的任何关键词（`authentication failed`/`could not read username`/…）；
- 但含 `unable to access`（`:87`）⇒ 落入 `NetworkFailed`。

**修法**：在 auth 分支（`:62-68`）补上 `the requested url returned error: 401` / `error: 403` / `403 forbidden` / `401 unauthorized` 的匹配，并**置于 network 分支之前**（顺序已对，auth 在 `:62`）。注意 `unable to access` 同时出现在 403 串里，所以新关键词必须先命中。

**验收**：单测覆盖三条真实 stderr —— 403 串 → `AuthRequired`、`could not resolve host` → `NetworkFailed`、`authentication failed` → `AuthRequired`；`cargo test -p cognia-git exec`。

---

#### W1.5 — 三处低危错误处理小修（打包成一个 commit）**[CONFIRMED] / 低**

作者一手复核，三处独立小瑕疵，合并处理：

1. **`exec.rs:80` `LockHeld` 分支缺括号**：`s.contains("index.lock") || s.contains("unable to create") && s.contains(".lock")` —— `&&` 先绑，逻辑**当前正确**但可读性陷阱，一次误编辑就成 bug。加括号：`a || (b && c)`。
2. **`unstage` unborn-HEAD fallback 过宽** [AGENT，`stage.rs:40`]：`git reset HEAD` 失败时**任何**错误都 fallback 到 `git rm --cached`，锁/路径失败被掩盖。改为只在 unborn-HEAD（stderr 含 `ambiguous argument 'HEAD'` / `unknown revision`）时 fallback。
3. **`git_sync` no-upstream 落入泛型 `CommandFailed`** [AGENT，`remote.rs:136-143`]：无 tracking 分支的首次 sync 报"no tracking information"，无 typed kind。补一个 `InvalidArgument` 或新 kind + 可读提示（引导用户 `push --set-upstream`）。

**验收**：三处各一个单测；`cargo test -p cognia-git`。

---

### Wave 2 — 跨传输门控死路（前端，用户可见）

---

#### W2.1 — 三处传输门控不一致，配对 web-companion / mobile 点进面板是死胡同 **[CONFIRMED] / 中**

**问题**：**配对 web-companion 客户端**上，StatusBar 分支 chip 是活的、且链到 `/source-control`，但面板渲染 `desktopOnly` 空态 → **死路**。Capacitor 上 RPC 层明确支持 git，整个 UI 却惰性。

**证据**（作者一手复核三处门）：

| 门                        | 判据                                                        | 位置                                          |
| ------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| 面板可用性                | `isTauri()` **仅此**                                        | `hooks/git/use-git-repo.ts:27`                |
| StatusBar 分支 chip       | `enabled && (isTauri() \|\| paired)`                        | `hooks/git/use-git-branch-indicator.ts:50-52` |
| RPC seam `hasGitBridge()` | `isTauri() \|\| isCapacitor() \|\| hasWebCompanionTarget()` | `lib/git/commands.ts:49-50`                   |

chip 点击导航到 `/source-control`（`status-bar-branch.tsx:30` [AGENT]），面板走 `use-git-repo` 只认 `isTauri()`（`source-control-panel.tsx:43,70-82` 渲染 `desktopOnly` empty）。三门对不齐 = 一个活按钮通向一个死页面。

**修法**：**方向需拍板**，见 §6 [OPEN-3] —— 这不是纯技术问题，涉及「SCM 是否应在 mobile/web-companion 可用」的产品决定：

- **A. 收窄**：把 chip 的门从 `isTauri() || paired` 收回 `isTauri()`，承认 SCM 桌面专属 —— 死路消失，代价最小，但放弃了 seam 已具备的多传输能力。
- **B. 放开**：把面板 `available` 门改为 `hasGitBridge()`，让配对/Capacitor 也能进 —— 但需确认 `openFolder`（`pickDirectory`）、rootDir 绑定、watcher 在这些传输下的行为（mobile 无本地 repo；web-companion 驱动的是**远端** host 的 git）。

**无论选哪个，交付物必含**：三门收敛到**单一 helper**（如统一用 `hasGitBridge()` 或统一用 `isTauri()`），杜绝再次漂移；一个测试断言"chip 可见 ⇒ 面板不 desktopOnly"。

**验收**：单测 —— mock `isTauri=false, paired=true`，断言 chip 与面板 available 一致（同真同假）；mock Capacitor 同理。选 B 还需 E2E 或手动在配对客户端点 chip → 落到可用面板而非空态。

---

### Wave 3 — 测试补位（Rule-3：`src-tauri/src/**` ≥90% co-located）

---

#### W3.1 — `commands.rs` 分发层零测试 **[CONFIRMED] / 中（含 Rule-3 违规）**

**问题**：整个 Tauri 命令层 + `blocking` panic-map wrapper **零 `#[cfg(test)]`**（已跑阳性对照，`commands.rs` 里 `#[cfg(test)]|mod tests` = 0 命中）。恰是最容易静默误路由的地方无覆盖：

- `blocking` wrapper 的 panic → error 映射 [AGENT，`:23-31`]
- `git_resolve_conflict` 三路（ours/theirs/both）分发 [AGENT，`:487-495`]
- `git_stage`/`git_unstage`/`git_discard` 的 `hunk_patch` vs `paths` 分支 [AGENT，`:199-226`]

**修法**：为 `commands.rs` 加 co-located `#[cfg(test)] mod tests`，聚焦分发/分支逻辑（用 `tempfile` repo，复用 `tag.rs`/`stash.rs` 已有的 bare-repo harness 形态）。**动手前先复核上面三个 [AGENT] 行号对应的实际分支形状。**

**验收**：`commands.rs` 有测试模块；`cargo test -p cognia-git commands`；`test:coverage` 不倒退。

---

#### W3.2 — network mutations（fetch/pull/push/sync）零集成测试 **[AGENT] / 中**

**问题**：风险最高的 shell 路径（upstream 解析、`push --set-upstream`、prune、sync 顺序）ship 时未验证。`tag.rs:155` 已证明 bare-repo push harness 可行 [AGENT]。

**修法**：用两个本地 repo（一个 bare 当 remote）建 harness，覆盖 fetch/pull/push/sync + `push --set-upstream` 的 upstream 解析（`remote.rs:106-131`）。

**验收**：`cargo test -p cognia-git remote`（**读 tee 日志**）。

---

#### W3.3 — watcher 生命周期零测试 **[AGENT] / 中**

**问题**：只有纯谓词（`is_relevant_git_internal`/`path_is_relevant`）有测；实际 `start`→debounce→emit→`stop` 路径、以及 W1.2 的 path-key/重复-watcher 行为无测。

**修法**：与 W1.2 同期做 —— canonicalize 修好后，补生命周期测试（含重复-key 断言）。**依赖 W1.2。**

**验收**：见 W1.2 验收 + 一个 debounce coalesce 断言。

---

### Wave 4 — 功能缺口（增量，按产品优先级排）

> 全部为**真实缺失**（作者一手复核：`crates/cognia-git/src/` 生产代码无 `clone`/`config`/`submodule`/`reflog`/`lfs`/`bisect`，`components/source-control/` 无 `worktree` UI）。是否做、先后取决于产品，见 §6 [OPEN-4]。

| 项       | 缺口                                                                                                  | 修法骨架                                                                              | 严重度 |
| -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| **W4.1** | `git clone` 缺失 —— not-a-repo 只能 `init`，无法把已有远端拉进面板                                    | 新 `git_clone` 命令（shell out，进度事件）；not-a-repo 空态加"Clone Repository"入口   | 中     |
| **W4.2** | `git config` 写缺失 —— "empty ident"（无 user.name/email）提交失败在面板内无解药                      | 新 `git_config_set`（局部/全局）；commit 报 empty-ident 时弹内联"设置身份"CTA         | 中     |
| **W4.3** | worktree 管理未在 SC 面板暴露 —— 后端 5 命令齐全，仅 agent-team allocator + project-editor 用 [AGENT] | 在面板加 worktree section（list/add/remove/prune），复用已有 `git_worktree_*` wrapper | 低中   |
| **W4.4** | reflog 读缺失（watcher 已监听 `.git/logs/`）                                                          | 新 `git_reflog` 只读命令 + Timeline 旁的"reflog/recovery"视图                         | 低     |
| **W4.5** | GPG `-S` 签名缺失（只有 signoff）                                                                     | `git_commit` 加 `sign` 参数 + commit-box toggle                                       | 低     |
| **W4.6** | 无行级/子 hunk staging（只有整 hunk）                                                                 | `diff-pane` 加选行 → 构造子 hunk patch → `git apply --cached`                         | 低     |

**注**：W4.1/W4.2 属 VSCode 内建范围内且能让 not-a-repo/empty-ident 流程自洽，**优先级高于** W4.3–W4.6。

---

### Wave 5 — i18n

---

#### W5.1 — `restore-dialog.tsx:79` 硬编码 `placeholder="HEAD"` **[CONFIRMED] / 低**

**问题**：唯一的 i18n offender（作者一手复核，全组件扫描仅此一处硬编码用户串）。虽是 git ref token，仍违反"无硬编码用户串"硬规则。

**证据**：`components/source-control/restore-dialog.tsx:79` `placeholder="HEAD"`（同文件 `:83` `<option value="HEAD" />` 是 value 非展示，不算）。

**修法**：走 `t()`（`sourceControl` 命名空间加 `restore.sourcePlaceholder` = `"HEAD"`，en/zh 同键），或若团队认定 git ref token 属技术标识则在 `lint:i18n` baseline 显式豁免。见 §6 [OPEN-6]。

**验收**：`pnpm i18n:build && pnpm lint:i18n` 绿；`restore-dialog.test.tsx` 更新。

---

## 4. 建议顺序与依赖

```
W0.1 (ADR 纠正)     ── 零风险,现在就做
W0.2 (Subsystem Map)── 零风险,建议第一个合入(立刻阻止下一个人重蹈覆辙)
W2.1 (传输死路)     ── 用户可见;需 [OPEN-3] 先拍板方向
W1.1 (redaction)    ── 独立;需 [OPEN-1] 选 A/B
W1.2 (watcher key)  ── 独立;是 W3.3 的前置
   └─ W3.3 (watcher 测试)
W1.3 (递归监听)     ── 独立;建议先量化再决定是否做([OPEN-2])
W1.4 (403 分类)     ── 独立,小改
W1.5 (三处小修)     ── 独立,一个 commit
W3.1 (commands 测试)── 独立;Rule-3,建议尽早
W3.2 (network 测试) ── 独立
W4.* (功能增量)     ── 全部独立;需 [OPEN-4] 排优先级;W4.1/W4.2 优先
W5.1 (i18n)         ── 独立,小改
```

**W0.2 建议第一个合入** —— 一行文档、零风险，且立刻阻止下一个人"先查文档"查不到 SCM 而重复造轮子。

---

## 5. 验证命令

```bash
# TS
pnpm test -- <changed test files>
pnpm test:coverage:changed -- --strict              # ≥90% on changed files
pnpm exec eslint <changed files>                    # 只 lint 你改的(eslint . 全仓红,pre-existing)
NODE_OPTIONS=--max-old-space-size=16384 pnpm typecheck   # 门禁 = 无 NEW 错误(baseline 已破)

# Rust —— 读日志,别信退出码(RTK/tee 会掩盖 cargo 失败)
cargo test -p cognia-git 2>&1 | tee /tmp/git-test.log
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tee /tmp/tauri-check.log

# i18n(碰了 messages 才需要,W5.1)
pnpm i18n:build && pnpm lint:i18n

# 文档(W0.1 必须 —— 唯一能抓 MDX 预渲染错的检查)
pnpm docs:build

# 真机验证(W2.1 选 B / W4.1 / W4.2 必须)
pnpm tauri dev
```

### 5.1 本仓陷阱（每条都对应一次真实事故）

- **破损的 baseline —— 门禁是"无 NEW 失败",不是"全绿"**：`pnpm typecheck` 有存量错误；`eslint .` 全仓红；`cargo test` 有存量失败。不确定就 stash 前后对比，**只 gate 你改的文件**。
- **RTK 会掩盖 cargo 退出码** —— 必须 `tee` 并读日志（见 `build-and-package-layout` 记忆）。cargo target 在**仓库根** `target/`，不在 `src-tauri/`。
- **git 面板偏好不是 Dexie** —— 存在 `AppSettings.gitSettings.panel`（`use-source-control-prefs.ts`）。本计划**无** Dexie 迁移；若 W4 某项要加持久化，先确认落哪。
- **Jest 分区**：`stores/git/**`、纯 `.ts` 跑 **node** 环境（无 `window`/IndexedDB）；组件测试跑 jsdom。改 store 测试踩这个 → 加 `/** @jest-environment jsdom */` docblock 或 mock。
- **i18n 分源**：改 `i18n/messages/{en,zh-CN}/sourceControl.json` 后跑 `pnpm i18n:build`；生成的 `en.json`/`zh-CN.json` **从不手改**（PostToolUse hook 强制 en/zh 键平衡）。
- **并发工作树**：其他 agent 会话可能共用本分支。任何 git stage/commit 前照 `concurrent-tree-safety` skill；**别裸 stash**；逐项 commit，别把整波打成一个巨 diff。
- **changeset**：W1.4/W1.5/W2.1/W4.* 是用户可感知的修复/功能 ⇒ 每项 `pnpm changeset`（选 `cognia-next`；fix=`patch`，feature=`minor`）。W0（文档）、W1.1–W1.3（内部健壮性,无可感知行为变化）、W3（测试）属内部改动,**跳过 changeset**。W1.4 用户会看到 CTA 变化 ⇒ 需 changeset。

### 5.2 每项的 Definition of Done

1. 行为完整实现（无 stub） 2. co-located 测试已加且绿 3. `test:coverage:changed --strict` 过 4. `eslint` 在改动文件上干净 5. `typecheck` 无新增错误 6. 碰了 i18n ⇒ `i18n:build` + `lint:i18n` 绿 7. 碰了 Rust ⇒ `cargo test -p cognia-git` 过（**读日志**） 8. 碰了 ADR/docs ⇒ `docs:build` 过 9. 用户可感知 ⇒ 有 changeset 10. 一项一个 commit / PR

---

## 6. [OPEN] —— 需要人拍板，不要默默替它决定

**[OPEN-1] W1.1 redaction 修法：序列化边界 vs 各构造点？**

- **A. 手写 `Serialize`（推荐）**：结构性堵死，任何未来构造点都安全，但要小心 `thiserror`/`serde` derive 的交互（`#[serde(tag=..., content=...)]` 已用，手写需保持同样 wire shape）。
- **B. 各构造点补 redact**：治标，改动分散，下一个人加 `CommandFailed` 又会漏。
  **倾向 A**，但需确认手写 `Serialize` 不破坏现有 `{ kind, detail }` wire 契约（前端 `err.kind` switch 依赖它）。

**[OPEN-2] W1.3 递归监听：现在优化还是先量化？**
`notify` 6.x 无原生 exclude，正确修法（按子树选择性监听）代价不小。**建议先量化**：在一个真实带 `node_modules` 的 repo 上测 watch 注册数与内存，确认是真问题再投入。若量级可接受，可降级为"记一笔 known-limitation"而非工作项。

**[OPEN-3] W2.1 传输门控方向：收窄（桌面专属）vs 放开（mobile/web-companion 可用）？**
这是**产品决定**：SCM 是否应在配对 web-companion（驱动远端 host 的 git）与 Capacitor（无本地 repo）上可用？

- 收窄 = 承认桌面专属，最小改动，死路消失。
- 放开 = 兑现 seam 已有的多传输能力，但 `openFolder`/rootDir 绑定/watcher 在远端与移动端的语义都要重新定义（远端 host 的 fs watcher 谁来跑？mobile 根本没有本地 repo）。
  **无论选哪个，三门必须收敛到单一 helper。** 建议**先收窄止血**（消除用户可见死路），放开作为独立特性单独立项评估。

**[OPEN-4] W4 功能缺口优先级？**
clone/config/worktree/reflog/GPG/行级 stage 全是真实缺失，但需求未明。**建议**：W4.1（clone）+ W4.2（config）优先（让 not-a-repo/empty-ident 自洽，属 VSCode 内建范围）；worktree UI（W4.3）取决于是否要与 agent-team 隔离特性对齐；reflog/GPG/行级 stage 属 power-user 长尾。请按产品优先级排，**不要一次全做**。

**[OPEN-5] W0.1 只改 ADR-0038 还是另开新 ADR？**
命令数/路径/模块列表属"更正陈旧内容" ⇒ 直接改 0038。但若要固化"混合后端契约 + git2-vs-shell 边界 + 错误分类表"作为可复用规范，可另开一份 ADR（编号 `ls docs/content/docs/en/adr/` 取 max+1，**别在本文写死编号**）。倾向**先改 0038**，规范化视需要再说。

**[OPEN-6] W5.1 `HEAD` placeholder：`t()` 还是 baseline 豁免？**
git ref token（`HEAD`）是否算"用户可见串"有争议。走 `t()` 最合规；若团队认定技术标识可豁免，则在 `lint:i18n` baseline 显式登记（**别静默留着**，Working Rule 7：刻意休眠/例外必须三轴标注）。

---

## 7. 调研溯源

三路 subagent（Rust crate `analyze-rust-core` / 前端 UI `analyze-frontend` / 接线可达性 `wiring-auditor`）+ 作者对全部承重主张的一手复核。

**作者亲手核实过的**（可直接采信，[CONFIRMED]）：

- `crates/cognia-git/src/commands.rs` 62 个 `#[tauri::command]`；`commands.rs` 零 `#[cfg(test)]`（阳性对照过）
- `error.rs` 全文（不变量声明 `:10-12` vs `From<git2::Error>` `:59-70` 不 redact）
- `exec.rs:59-98` `classify_failure`（auth 分支无 403、`unable to access`→NetworkFailed、LockHeld 缺括号）
- `watcher.rs:36`（裸 String key）、`:117`（`RecursiveMode::Recursive`）、`:144`（insert）、全文无 `canonical`
- 三处传输门：`use-git-repo.ts:27`、`use-git-branch-indicator.ts:50-52`、`commands.ts:49-50`
- `restore-dialog.tsx:79` `placeholder="HEAD"`
- `companion_api/commands.rs:374` 转发 `git://status-changed`
- 生产代码无 `clone`/`config`/`submodule`/`reflog`/`lfs`/`bisect`（阳性对照过，`config` 仅测试 helper）
- `components/source-control/` 无 worktree UI（阳性对照过）
- ADR-0038 全文陈旧点；`source-control-panel.tsx` 组件组成；`src-tauri/src/lib.rs` 命令注册块；`CLAUDE.md` Subsystem Map 无 SCM 行

**未独立复核的**（标 [AGENT]，动手前自行验证）：redaction "只有两条路径" 的完整枚举、worktree 消费者（allocator.ts / use-project-editor.ts）、`commands.rs` 三个分支的确切行号、network/watcher 测试缺口的完整清单、AI/settings/plugin-api 接线细节（wiring-auditor 报告全通,未逐条复核）、`status-bar-branch.tsx:30` 的导航目标。
