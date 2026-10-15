---
title: "0227 — Agent 变更经由同一个宿主侧队列集成"
description: "Agent 的工作成为一个钉住的 changeset，审查、检查与审批都绑定到其 head 提交；宿主侧集成事务在复用的集成工作树中组合 changeset，验证确切的候选提交，并以可回滚的比较并交换（CAS）方式更新引用。"
---

# ADR 0227 — Agent 变更经由同一个宿主侧队列集成

**状态：** 已接受  
**日期：** 2026-10-15  
**修订：** ADR-0111（补上其“宿主侧 Agent Team merge-all 晋升事务”缺口）、ADR-0071（审查证据对比运行基线，不再对提交失明）、ADR-0070（新增基于路径的变更风险）  
**相关：** ADR-0038、ADR-0150、ADR-0151、ADR-0176、ADR-0188（验收配置）、ADR-0147

## 背景

Anthropic 在 2026-10-13 发布的《Redesigning source control》介绍了 Scion：一个为每日数万次 Agent 合并而建的集中式、非 Git 系统。changeset 是预写日志条目，引用通过单行比较并交换移动，history 与 blame 由派生索引提供，对象经分层缓存按需获取，验证放在合并之后并配合自动回滚。其中大部分是为了承受 100 GB 的历史和每日 2500 万次 CI checkout。Cognia 在一台机器上针对普通 Git 仓库运行少量 Agent，并且必须继续兼容用户自己的 Git 工具。我们采纳可迁移的思想，不复制其基础设施。

2026-10-15 对代码树的审计表明，Cognia 已具备大部分基础：

- **隔离**：ADR-0111 Registry 为每个聊天回合、定时任务和 Agent Team 派发提供分离 HEAD、加锁、带签名、与源仓库共享对象库的工作树；ADR-0176 让所有克隆共用一个裸镜像缓存并使用 partial clone；稀疏检出与缓存链接来自 `.cognia/workspace.json`。
- **变更捕获**：任务工作区账本记录每次运行的 `ResourceChange`（Agent、类型、哈希、增删行数、敏感性）以及可逆的 `PatchSet`。
- **Git 操作**：`cognia-git` 已提供 diff、history、blame、commit、merge、rebase、cherry-pick、revert、worktree 管理和批量 `update-ref --stdin`；`lib/git/commands.ts` 是面向本地、配对与远程宿主的类型化、按传输路由的门面。
- **验证**：ADR-0188 验收配置按命令哈希审批，在可用的最强沙箱层级、无网络地针对确切修订运行，报告由宿主收集而非轻信。
- **审查**：ADR-0071 主管审查、`lib/git/ai-review.ts` 与 ADR-0070 风险分类器。

缺的是把它们连起来的部分。审计发现：

1. Agent 的变更没有作为一个单元被记录：base 提交、head 提交、文件、审查、检查和合并状态分散在五个模型中，解析出的 base SHA 从未保存。
2. `merge-all` 被拒绝（`registry-controller.ts`、`action.team.reconcile`），因为宿主侧没有任何东西能原子地集成多个工作树。`select` 只创建分支，某一步失败时没有回滚。
3. 没有任何验证会阻断流程。Agent 自行运行的测试只作为证据记录，没有门禁读取。
4. 主管审查对提交“失明”：队友提交了自己的工作后，审查者看到的是空的工作树 diff。
5. 风险只按工具和关键词分类。修改 CI 配置、数据库迁移或凭据文件与修改 README 风险相同；敏感路径只在读取时检查，应用时不检查。
6. blame 与 history 每次调用都重新计算；维护只保持镜像的 commit-graph 新鲜，不包括 Agent 实际工作的源仓库。

## 决策

### 1. changeset 是一个钉住的提交加一份门禁记录

`cognia-task-workspace` 新增 `changeset.rs`，并在现有 SQLite 存储中新增 `agent_changesets` 表（增量迁移；Dexie 不变）。

- **捕获**把 Git 隔离的工作区变成不可变提交，且不触碰用户分支和工作树的 index：以工作树 HEAD 初始化临时 index（`GIT_INDEX_FILE`），`add -A` 暂存工作状态，`write-tree` 与 `commit-tree` 生成提交，`refs/cognia/changesets/<id>` 防止其被 GC。`resource.rs` 判定为敏感的文件不进入树，并列为已排除——凭据绝不会经 changeset 进入集成。
- 记录关联任务、会话、运行、Agent、工作区、仓库（Git common dir）、目标引用、**base SHA**、**head SHA**、逐文件统计、声明的依赖、审查、检查、审批、集成 ID 与合并后的 SHA。
- **一切绑定到 head SHA。** 为某个 head 记录的审查、检查结果或审批对另一个 head 无效。修订后重新捕获会移动 head，状态重置为 `draft`，门禁随之失效。
- 状态：`draft → ready → approved | changes_requested → queued → integrating → merged | conflicted | failed`，`merged → rolled_back`，任何非终态可到 `abandoned`。非法转换由宿主拒绝。
- **资格在宿主侧计算**：当前 head 的审查结论为 `approve`，每个必需检查在当前 head 通过，且审查要求人工审批时当前 head 存在人工审批。无论调用方声称什么，集成事务都会拒绝不合格的 changeset。

### 2. 每个目标引用一个宿主侧集成事务

`integration.rs` 与 `integration_runs` 表负责队列。

- **分析**在任何检出之前预测冲突：两两之间以及与目标分支顶端之间使用 `git merge-tree --write-tree --name-only`（Git ≥ 2.38），并辅以文件重叠。按声明的依赖做拓扑排序，再按捕获时间排序。在较旧的 Git 上退化为仅重叠检测，并明确标注。
- **准备**将目标顶端解析为期望的旧 SHA，在**每个仓库复用的集成工作树**中组合 changeset：分离 HEAD，以 `cognia-integration:` 为锁原因加锁，Registry 对账将其识别为宿主所有；两次运行之间用 `checkout --detach --force` 与 `clean -fd` 重置，从而保留被忽略的依赖目录。策略为 `merge`（`--no-ff`，每个 changeset 一个合并提交，带有标明 changeset 与 Agent 的 trailer）或 `rebase`（线性重放 changeset 的提交）。运行期间启用 `rerere`，Git 见过的冲突按相同方式解决，且仍需验证。未解决的冲突中止该步骤；策略决定跳过该 changeset（标记为 `conflicted` 并记录文件）还是停止整次运行。集成内部提交禁用 hooks：验证是显式的验收步骤，而不是某个 hook 的副作用。
- **验证**通过现有 ADR-0188 验收宿主，在集成工作树中针对准备好的候选提交运行必需的验收配置。检查结果记录在候选 SHA 上。
- **发布**以比较并交换移动目标引用：`update-ref <target> <candidate> <expected-old>`。若目标分支在某个工作树中被检出，只有当该工作树干净且 HEAD 等于期望的旧 SHA 时才快进它；工作树有未提交改动时拒绝并给出可操作的错误，而不是让用户的工作树看起来被修改了。交换失败（目标已移动）会把运行标记为 `stale`；编排器基于新的顶端重建，次数有上限。
- **失败恢复。** 当包含多个 changeset 的验证失败时，编排器丢弃最近组合的 changeset，重建并重新验证，次数以队列长度为上限，从而隔离出单个罪魁并将其标记为 `failed`，其余继续集成。崩溃中断的运行在打开时恢复：发布途中被打断且目标已等于候选的运行记为已发布；其他情况变为 `interrupted`，重置集成工作树，其 changeset 回到 `queued`。
- **操作日志与回滚。** 每次引用变化都追加到运行的操作日志。对已发布运行的回滚：若目标仍指向结果，则用比较并交换换回；若目标已继续前进，则在集成工作树中创建 revert 提交，并以同样的比较并交换发布。被回滚的 changeset 变为 `rolled_back`。
- 每个（仓库，目标引用）同时只允许一个运行，由进程内锁与数据表共同保证。

### 3. 审查：先确定性，再由 Agent，必要时由人

- **变更风险**（`lib/scm/review/assess-change-risk.ts`）是对 changeset 文件的纯函数：受保护路径（内置默认值涵盖 CI 工作流、部署、迁移、锁文件、所有权与 Cognia 配置，另加 `.cognia/workspace.json` 中声明的 `review.protectedPaths`）、敏感排除、删除、二进制文件与规模。返回 ADR-0070 的 `RiskTier`、原因，以及是否需要人工审批（命中任何受保护路径或为 `high`）。
- **审查 Agent** 按文件复用 `lib/git/ai-review.ts`，并经过 `hasNoLeakingPii`。出现 `critical` 发现即请求修改。没有可用模型时审查记为不可用，并要求人工审批——门禁绝不会悄然通过。
- **检查**是仓库已审批的验收配置，在 `review.requiredChecks` 中声明为必需。未审批或已变更的配置被拒绝，与 ADR-0188 一致。
- **人工审批**是绑定到 head SHA 的显式操作。

### 4. 一个源码管理端口

`lib/scm/` 在现有 `lib/git/commands.ts` 与任务工作区客户端之上暴露 `SourceControlService`——快照、diff、history、blame、commit、merge、回滚、changeset 与集成。目前 Git 是唯一后端；按类型注册的后端注册表为其他后端留出空间，而不需要第二个门面。本地与远程宿主本来就是传输层的问题，保持不变。

### 5. Agent Team 通过队列集成

`merge-all` 不再被拒绝：Registry 控制器为每个候选捕获一个 changeset（声明任务图依赖），运行审查门禁并交给集成队列。团队显式选择时目标为运行的 base 分支（`integration.target: "base"`）；默认结果发布到 `agent/<run>/integrated`，因此无人值守的团队绝不会移动用户没有指定的分支。主管审查发生在 changeset 捕获之前，因此其证据对比环境与运行的基线（`baseRef`，否则为源检出所在分支）：已提交与未提交的改动都会呈现，消除对提交的“失明”；每一级证据都与审查智能体经过同一道敏感路径与 PII 门禁。`select` 在后续步骤失败时回滚其已创建的分支。

### 6. 性能：共享对象、不可变缓存、增量索引

- blame 与 history 结果在 `cognia-git` 中以 Git common dir、解析后的提交 ID、路径与选项为键缓存。键不可变，因此无需失效；工作树 blame 从不缓存。
- Registry 维护为每个拥有托管工作树的源仓库写入带 changed-path Bloom 过滤器的分片 commit-graph，使 `log -- <path>`、merge-base 与祖先检查变成查表。不写入任何用户 Git 配置（即 ADR-0176 回避 `git maintenance register` 的原因）。
- 冲突预测使用 `merge-tree`，无需检出；集成工作树复用而非每次新建。
- 已合并或已放弃 changeset 的引用随现有快照保留期过期。

## 后果

- Agent 的工作从捕获到合并都是一个可检查、可回滚的单元。
- `merge-all` 可用且具备事务性：目标只移动一次，以比较并交换方式移动到按组合结果验证过的候选提交。
- 检查或审批无法被挪用到另一份代码上。
- 凭据无法经 changeset 进入集成。
- 用户的检出不会因为引用在其下方移动而显得被修改。
- 回滚是一次有记录的操作，而不是一次调查。
- 未采纳：虚拟文件系统、自定义对象协议、作为服务的服务端合并、仅合并后验证。一旦有测量表明链接工作树加 partial clone 不够用，再重新讨论。

## 验证

- `cargo test -p cognia-task-workspace changeset integration`：使用临时 index 捕获（用户 index 不变）、敏感排除、绑定 head 的门禁失效、转换拒绝、merge-tree 预测、rerere 复用、跳过/停止冲突策略、CAS 发布成功与过期拒绝、已检出干净分支的快进与有改动时的拒绝、各状态的崩溃恢复、通过交换与通过 revert 回滚、同一目标的并发运行被拒绝。
- `cargo test -p cognia-git query_cache` 与维护相关测试。
- `lib/scm/**`、风险评估、审查 Agent、编排器（过期重试、罪魁隔离）、Agent Team 控制器（`merge-all`、`select` 回滚）与 UI 的同目录 Jest 测试。
- 一个多 Agent 并发测试将三个已捕获的 changeset（两个互不相交，一个冲突）送入同一队列，并断言发布后的引用、冲突记录与回滚结果。
