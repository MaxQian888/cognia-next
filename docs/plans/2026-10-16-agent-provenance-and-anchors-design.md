# Agent provenance (W2) and project-file anchors (W3): design research

Date: 2026-10-16. Source: read-only Codex (gpt-6-astra) research job over `dev`; `observed` claims cite code, `inferred` claims are design proposals. Companion to `2026-10-16-agent-sandbox-workspace-gap-analysis.md`.

## Summary

建议在 Rust Task Workspace store 中新增独立于 task 生命周期的 provenance 版本投影：实际写入前后内容 → 行来源段 → 持久 run/session/tool/message 引用，由一个受权限约束的 host query 服务编辑器和 agent 工具。W3 复用现有评论 resolver，扩展 anchor payload，不需要 Dexie schema bump。当前数据不足以追溯所有历史行的确切 tool call；必须保留 unknown/inferred，不能把路径事件当成精确行归属。本次仅研究源码，未修改文件、未运行测试。

## Findings

- **observed**: 1. 当前身份数据：TaskRun 包含 run_id、task_id、parent_run_id、agent_id、agent_kind、execution_root、workspace_id、workspace_key、execution_run_id、trace_id、turn_id、attempt_id、provider_attempt_id、surface、baseline_revision 和时间/状态。session_id 不在 TaskRun，而在 TaskWorkspace，需通过 task_id 关联。持久 provenance 必须在 task 被删除前复制这些最小身份字段。
  - Evidence: `crates/cognia-task-workspace/src/types.rs:155`, `crates/cognia-task-workspace/src/types.rs:169`, `crates/cognia-task-workspace/src/store.rs:58`

- **observed**: ResourceEvent 已有 event_id、run_id、seq、observed_at、path、old_path、origin、agent_id、evidence、tool_call_id，以及 provisional/overflow/resync_required/reconciled；现有 evidence 枚举仅 Watcher/Tool/Reconcile。ResourceChange 有 before_hash、hash、old_path、origin、agent_id、binary、resource_kind、capture_class、content_captured；没有独立 before_blob_ref/after_blob_ref 字段，内容通过 hash 查 blob。ResourceEvent 本身没有版本内容 hash 或行范围。
  - Evidence: `crates/cognia-task-workspace/src/types.rs:90`, `crates/cognia-task-workspace/src/types.rs:207`, `crates/cognia-task-workspace/src/types.rs:235`, `crates/cognia-task-workspace/src/ledger.rs:568`

- **observed**: PatchHunk 保存 id、统一 diff header、forward_patch_hash、inverse_patch_hash、additions/deletions，没有结构化 old/new start/count。正反向 hunk body 确实作为 blob 保存。PatchFile 保存 path/old_path、before_hash/after_hash 和 hunks；AppliedFile 保存实际应用前后的 before_apply_hash/after_apply_hash。普通 apply 和 force_apply 成功后记录 applied_selection，并设 applied_selection_known=true；空 selection 表示全部，单个 selection 的空 hunk_ids 表示整文件。undo 使用 AppliedFile 的实际前后内容反向合并，成功后标 Reverted，保留原 selection；KeepCurrent 清空 applied_files/selection。bundle retry 会重置这些字段，所以它们不能替代永久 adoption 事件历史。
  - Evidence: `crates/cognia-task-workspace/src/types.rs:298`, `crates/cognia-task-workspace/src/types.rs:314`, `crates/cognia-task-workspace/src/types.rs:330`, `crates/cognia-task-workspace/src/types.rs:344`, `crates/cognia-task-workspace/src/ledger.rs:578`, `crates/cognia-task-workspace/src/ledger.rs:117`, `crates/cognia-task-workspace/src/ledger.rs:224`, `crates/cognia-task-workspace/src/ledger.rs:353`, `crates/cognia-task-workspace/src/ledger.rs:406`, `crates/cognia-task-workspace/src/service.rs:2390`

- **observed**: Code-adoption 的 Rust attribution 根据前后 fingerprint 找文件，再读取 Git diff，保存包含上下文的新侧 hunk 范围和统计，不保存完整 diff body。TS CodeAdoptionTurnRow 额外保存 taskWorkspaceRunId 和 assistantMessageId，Rust DTO 不含这两个字段；settleTurn 通过 active.runId 连接 Task Workspace，并寻找最后一条用户消息之后的 assistant 消息。Task Workspace 投影到 code-adoption 时 hunks 实际为空。Dexie 只保留最新 10,000 行，现有 adoption 词汇是 pending/accepted/partiallyAccepted/rejected/reverted/unavailable/notApplicable。
  - Evidence: `crates/cognia-git/src/code_adoption/attribution.rs:13`, `crates/cognia-git/src/code_adoption/attribution.rs:37`, `crates/cognia-git/src/code_adoption/mod.rs:53`, `lib/code-adoption/types.ts:29`, `lib/code-adoption/types.ts:39`, `lib/code-adoption/turn-tracker.ts:118`, `lib/code-adoption/turn-tracker.ts:166`, `lib/code-adoption/turn-tracker.ts:206`, `lib/code-adoption/persist.ts:74`, `lib/code-adoption/outcome.ts:77`

- **inferred**: 精确 line→tool 是新增采集能力。现有 tool-evidence 明确只是 causal hints，上传 runId/path/oldPath/kind/toolCallId；record_tool_event 给 metadata 标 Tool，没有 before/after hash 或 hunk 绑定。已确认的生产路径包括 Codex fileChange callback。设计应新增可信 mutation receipt：runId、toolCallId、mutation ordinal、实际 before/after canonical hash、精确变化范围。只有 receipt 与实际版本转换一致，才绑定确定的 toolCallId；旧路径事件只能返回候选或 null，并标 inferred。一个 run 内多个工具修改同文件时，不得选择最后一个路径事件冒充来源。
  - Evidence: `lib/task-workspace/tool-evidence.ts:33`, `lib/task-workspace/tool-evidence.ts:46`, `lib/task-workspace/client.ts:926`, `crates/cognia-task-workspace/src/service.rs:3858`, `crates/cognia-task-workspace/src/service.rs:3890`, `lib/ai/agent/external/integrations/codex.ts:20`, `packages/agent-codex/src/app-server-client.ts:2807`

- **inferred**: 2. 最合适的 patch hook 是 ledger 的 PlannedWrite 提交边界：这里同时拥有实际 before/after bytes。普通 service apply/undo、force_apply、bundle 的 ServiceBundleApplier.apply/compensate 都应汇入同一个 provenance commit helper。bundle 写入目标来自 registry.source_root，不能误用 execution_root。具体设计为：预写 mutation intent 和必要 blobs → commit_plans → 校验实际结果 → 在一个 SQLite transaction 中提交 patch/task 状态、resource version、line segments、adoption event。文件系统与 SQLite 不能组成真正原子事务，必须保留 intent；启动或查询时检查磁盘 hash，匹配预期结果则幂等完成，否则标 gap 并 reconcile。不要在每次底层 write_entry 中直接记 applied，因为失败补偿也会经过它。
  - Evidence: `crates/cognia-task-workspace/src/ledger.rs:22`, `crates/cognia-task-workspace/src/ledger.rs:117`, `crates/cognia-task-workspace/src/ledger.rs:906`, `crates/cognia-task-workspace/src/service.rs:182`, `crates/cognia-task-workspace/src/service.rs:218`, `crates/cognia-task-workspace/src/service.rs:272`, `crates/cognia-task-workspace/src/service.rs:4271`, `crates/cognia-task-workspace/src/service.rs:4310`, `crates/cognia-task-workspace/src/service.rs:4364`

- **inferred**: 将 hunk 映射到最终文件不能直接使用 header 的 new_start。设 B=patch baseline，S=仅应用选中 hunks 后的 desired，C=实际写入前文件，A=最终合并结果。先按源码顺序重放选中 hunks，在 B→S 中只给 '+' 行标来源，上下文行沿用来源；未选 hunk 会改变后续偏移，因此以重建的 S 为准。再对 C→A 保留已有行来源，并将 S 中被证实新增的行通过 S→A 的唯一匹配映射到新增位置。three-way merge 保留的人类前缀/后缀不能归给 agent；C 已有相同内容时也不能抢占其来源。重复文本、多解匹配或冲突人工解决的部分降级 inferred/unknown。纯删除记录 adoption/deletion 事件，但不产生当前行段。
  - Evidence: `crates/cognia-task-workspace/src/ledger.rs:506`, `crates/cognia-task-workspace/src/ledger.rs:675`, `crates/cognia-task-workspace/src/ledger.rs:779`, `crates/cognia-task-workspace/src/ledger.rs:785`, `crates/cognia-task-workspace/src/ledger.rs:794`, `crates/cognia-task-workspace/src/ledger.rs:803`

- **inferred**: integration publish 是另一条必须接入的写路径，不经过 ledger::apply。publish_integration 先存 Publishing/op_log，再 move_target，成功后 finish_integration_publication；后者也被 rollback 和 crash recovery 调用，适合幂等提交 integration provenance。应按 IntegrationItem 的 changeset/head/commit 顺序将来源映射带到 candidate，再在 verified publication 时发布 target-ref 版本；有 checkout 才同步工作目录版本。仅更新未 checkout 的 ref，不能宣称当前编辑器文件已变化。AgentChangeset 虽有 run/task/session/agent 字段，但 capture 使用 latest_workspace_run，不能据此把整个累计 changeset 都算给最后一个 run；需要 capture 时冻结已有执行版本来源图，无法确定的部分保留 changeset 级 inferred 来源。
  - Evidence: `crates/cognia-task-workspace/src/integration.rs:1444`, `crates/cognia-task-workspace/src/integration.rs:1539`, `crates/cognia-task-workspace/src/integration.rs:1670`, `crates/cognia-task-workspace/src/integration.rs:1898`, `crates/cognia-task-workspace/src/integration.rs:1921`, `crates/cognia-task-workspace/src/types.rs:1148`, `crates/cognia-task-workspace/src/types.rs:1492`, `crates/cognia-task-workspace/src/changeset.rs:931`, `crates/cognia-task-workspace/src/changeset.rs:1136`

- **observed**: 3. 可复用的 Rust diff 是现有 Git 路径：ledger 使用 git diff --no-index --binary --unified=3；task crate 已依赖 git2。所查 manifests/lock/source 未发现 similar、imara-diff、diffy。service.line_stats 只是有规模限制的 LCS 计数，不返回映射。建议抽出可测试的 line-map helper，复用 Git diff，固定算法、关闭 external diff/textconv，并使用零上下文变化区间恢复 equal spans；不引入新的 diff 库作为首阶段依赖。
  - Evidence: `crates/cognia-task-workspace/Cargo.toml:34`, `crates/cognia-task-workspace/src/ledger.rs:612`, `crates/cognia-task-workspace/src/ledger.rs:631`, `crates/cognia-task-workspace/src/service.rs:6386`, `Cargo.toml:243`

- **inferred**: 版本推进算法：按保留换行信息的逻辑行拆分 bytes，equal 区间搬移并裁剪旧 RLE segments，删除区间从当前图移除，新增区间由可信 receipt 赋 agent 来源、明确编辑器保存赋 human 来源、其他情况赋 unknown；最后合并相邻相同来源和映射等级的段。统一对外使用 1-based、end-exclusive 行范围，空文件无段；Monaco 的末尾虚拟空行不能自动归属。内容 hash 始终覆盖原始 bytes，明确处理 CRLF、无末尾换行、非 UTF-8、binary。保留 originEvidence 与 mappingEvidence 两个维度，避免一次 reconcile 把原始 tool-reported 证据覆盖掉。
  - Evidence: `crates/cognia-task-workspace/src/ledger.rs:631`, `crates/cognia-task-workspace/src/service.rs:6378`, `crates/cognia-task-workspace/src/types.rs:41`, `crates/cognia-task-workspace/src/types.rs:90`

- **inferred**: 需要修正“editor save 已知 base hash”的前提：OpenFile 只有 savedContent/draftContent/draftVersion/mtime；save 仅传 root/path/draftContent，fs_write_workspace_file 最后直接 std::fs::write。建议和 W1 配套：读取返回 per-file raw SHA-256，保存携带 expectedContentHash，host 在实际写入边界捕获旧 bytes、执行条件保存和原子替换、生成 human mutation receipt。文件服务通过 host 注入 observer 接入 provenance，避免在通用 files crate 中硬编码 UI 或 Task Workspace 生命周期。仅客户端计算 savedContent hash 不能证明它仍等于写入前磁盘；本进程锁也不能阻止未协作的外部编辑器，需要写后校验和 gap 标记。
  - Evidence: `components/editor/project/use-project-editor.ts:70`, `components/editor/project/use-project-editor.ts:1013`, `crates/cognia-files/src/files.rs:1175`, `crates/cognia-files/src/files.rs:1244`, `crates/cognia-files/Cargo.toml:1`, `docs/plans/2026-10-16-agent-sandbox-workspace-gap-analysis.md:30`

- **inferred**: 现有 watcher 观察 execution_root，200ms debounce 且按路径合并；保存的是事件 metadata，没有每个中间版本的 bodies/hashes，默认 origin 还是 Agent。需要另外为获授权的 source/workspace root 建立版本观察入口，不能原样套用该默认值。每次事件读取稳定的新内容，与已保留旧 blob 对比。漏事件或 overflow 后，在 next query 对 last-known→current disk 做 reconcile：只搬移可验证的 equal spans，新行/歧义行 unknown，返回 gap=true；旧 blob 已淘汰时不能恢复准确来源。两次观察之间 A→B→A 的不可见编辑无法被端点 diff 证明或恢复，必须承认观察边界。
  - Evidence: `crates/cognia-task-workspace/src/watcher.rs:14`, `crates/cognia-task-workspace/src/watcher.rs:33`, `crates/cognia-task-workspace/src/watcher.rs:195`, `crates/cognia-task-workspace/src/service.rs:4558`, `crates/cognia-task-workspace/src/service.rs:4580`, `crates/cognia-task-workspace/src/service.rs:4662`, `crates/cognia-task-workspace/src/service.rs:4682`

- **inferred**: 版本键不能仅 UNIQUE(resource_id, content_hash)。已观察到的 A→B→A 可能来自 undo、人类恢复或另一个工具，bytes 相同不保证来源相同；应以 version_id/parent_version_id/sequence 标识观察版本，(resource_id,content_hash) 只建索引。还必须分离 canonical content_hash 与 blob_ref：普通 snapshot 用 raw SHA-256，Git snapshot 用 Git blob OID，ledger AppliedFile 用 raw SHA-256。推荐统一新 content_hash 为 sha256:<hex>，保留原始 blob_ref/hash domain；不能直接比较 ResourceChange.hash 与 AppliedFile.after_apply_hash。
  - Evidence: `crates/cognia-task-workspace/src/snapshot.rs:167`, `crates/cognia-task-workspace/src/snapshot.rs:407`, `crates/cognia-task-workspace/src/ledger.rs:123`, `crates/cognia-task-workspace/src/ledger.rs:1007`, `crates/cognia-task-workspace/src/service.rs:6295`

- **inferred**: 4. Rename 证据强弱不同：watcher 的成对 Name event 可给 old_path；task settle 会按删除/新增内容 hash 相等配对；cognia-git 使用 libgit2 rename detection，但 diff_stat 输出只保留最终路径；changeset 的 git diff -M --name-status 保留 old_path。设计采用稳定 resource_id 与带有效区间的 path_history。可信 explicit rename 且源版本匹配时保持 identity；watcher rename 标 watcher-observed；Git 相似度或 hash 推导标 inferred。多个同内容文件配对、源/目标冲突或证据冲突标 ambiguous，保存候选，不自动合并身份。copy、新建同路径文件使用新 identity；case-only rename 按宿主文件系统规则处理。root identity 也独立于临时 managed workspace，working-tree 与 target-ref 使用分开的版本流。
  - Evidence: `crates/cognia-task-workspace/src/watcher.rs:236`, `crates/cognia-task-workspace/src/service.rs:6141`, `crates/cognia-git/src/diff_stat.rs:36`, `crates/cognia-task-workspace/src/changeset.rs:347`, `crates/cognia-task-workspace/src/changeset.rs:392`, `crates/cognia-task-workspace/src/ledger.rs:444`, `crates/cognia-task-workspace/src/store.rs:549`

- **inferred**: 5. 建议的 SQLite 数据模型如下，均为新增设计。JSON 列沿用现有 store payload 模式；生产迁移需加入 enum CHECK、外键和 root 一致性校验，但绝不引用可 prune 的 task_runs/task_workspaces/workspace_registry 为级联父表。

CREATE TABLE IF NOT EXISTS provenance_roots (
root_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, host_id TEXT NOT NULL,
canonical_root TEXT NOT NULL, stream_key TEXT NOT NULL,
repository_fingerprint TEXT, next_seq INTEGER NOT NULL DEFAULT 1,
UNIQUE(principal_id,host_id,canonical_root,stream_key)
);
CREATE TABLE IF NOT EXISTS resource_identity (
resource_id TEXT PRIMARY KEY, root_id TEXT NOT NULL,
identity_state TEXT NOT NULL, current_version_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS path_history (
entry_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, resource_id TEXT,
relative_path TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER,
state TEXT NOT NULL, evidence TEXT NOT NULL, candidates_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS path_history_current
ON path_history(root_id,relative_path) WHERE to_seq IS NULL;
CREATE TABLE IF NOT EXISTS provenance_sources (
provenance_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, origin TEXT NOT NULL,
session_id TEXT, turn_id TEXT, task_id TEXT, run_id TEXT, agent_id TEXT,
execution_run_id TEXT, trace_id TEXT, assistant_message_id TEXT,
tool_call_id TEXT, event_id TEXT, evidence TEXT NOT NULL,
created_at INTEGER NOT NULL, details_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provenance_mutations (
operation_id TEXT PRIMARY KEY, root_id TEXT NOT NULL,
operation_key TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL,
kind TEXT NOT NULL, commit_state TEXT NOT NULL,
manifest_json TEXT NOT NULL, selection_json TEXT NOT NULL,
created_at INTEGER NOT NULL, UNIQUE(root_id,seq)
);
CREATE TABLE IF NOT EXISTS resource_versions (
version_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL,
parent_version_id TEXT, operation_id TEXT NOT NULL,
content_hash TEXT NOT NULL, blob_ref TEXT, line_count INTEGER NOT NULL,
completeness TEXT NOT NULL, observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_versions_hash
ON resource_versions(resource_id,content_hash);
CREATE TABLE IF NOT EXISTS line_origin_segments (
version_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
provenance_id TEXT NOT NULL, mapping_evidence TEXT NOT NULL,
PRIMARY KEY(version_id,start_line), CHECK(start_line>=1 AND end_line>start_line)
);
CREATE TABLE IF NOT EXISTS provenance_adoption_events (
operation_id TEXT NOT NULL, provenance_id TEXT NOT NULL, unit_key TEXT NOT NULL,
state TEXT NOT NULL, details_json TEXT NOT NULL,
PRIMARY KEY(operation_id,provenance_id,unit_key)
);
CREATE TABLE IF NOT EXISTS provenance_blob_pins (
owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, hash TEXT NOT NULL,
PRIMARY KEY(owner_kind,owner_id,hash)
);

identity_state 为 active/deleted/ambiguous；commit_state 为 prepared/committed/aborted/reconcile_required；manifest 保存每个实际写入的前后版本/hash、rename 关系和 bundle/integration 标识。segments 必须无重叠并覆盖所有真实行，未知行也有显式 unknown source。新增 apply_provenance_migration()，沿用 CREATE IF NOT EXISTS、pragma_table_info 检查后 ALTER、最后建索引的顺序。

- Evidence: `crates/cognia-task-workspace/src/store.rs:46`, `crates/cognia-task-workspace/src/store.rs:119`, `crates/cognia-task-workspace/src/store.rs:438`, `crates/cognia-task-workspace/src/store.rs:580`, `crates/cognia-task-workspace/src/store.rs:631`

- **inferred**: adoption 必须独立于行来源、单独记录事件：候选生成为 pending；全部选定单位成功落入目标为 applied；仅部分文件/hunk/新增行采用为 partial；明确拒绝或一次已完成 selection 排除的单位为 discarded；确实应用后被 undo/rollback 移除为 reverted。冲突不等于 discarded，失败的 undo 不等于 reverted。聚合状态从单位状态计算，纯删除/rename 也有单位，不能只按 additions 比例。普通后续编辑导致某些行消失，只更新 survivingLineCount，不自动把原采用行为改成 reverted。undo 应从持久的 before-version 来源图恢复被还原的行，同时保留其后独立的人类修改；不能把恢复的老行归给执行 undo 的 agent。
  - Evidence: `crates/cognia-task-workspace/src/resource_index.rs:28`, `crates/cognia-task-workspace/src/resource_index.rs:68`, `crates/cognia-task-workspace/src/ledger.rs:224`, `crates/cognia-task-workspace/src/ledger.rs:267`, `crates/cognia-task-workspace/src/ledger.rs:406`, `lib/code-adoption/outcome.ts:77`, `lib/code-adoption/outcome.ts:85`

- **observed**: 当前 prune 的删除清单：跳过 pinned、未过期、Running/Settling 或 Ready/Conflict patch 的 task；清理 Git worktree/shadow execution directory，Git 清理还 unpin snapshot base 并尝试删除 isolation branch；managed workspace 转 Removing 后删除 registry 行，级联删除 workspace_root_leases、workspace_sensitive_grants、workspace_archives、workspace_capture_baselines。delete_task 删除 task_workspaces，级联删除 task_runs（含 baseline）、task_resources、task_resource_events、task_patch_sets。最后删除不再被 task run/resource/patch payload、archive、capture baseline 引用的 task_blobs 行及磁盘 blob。此路径不删除 agent_changesets、integration_runs、workspace_source_bindings、workspace_bundles、maintenance events 或 sensitive audit。
  - Evidence: `crates/cognia-task-workspace/src/service.rs:3956`, `crates/cognia-task-workspace/src/service.rs:4040`, `crates/cognia-task-workspace/src/service.rs:5440`, `crates/cognia-task-workspace/src/registry.rs:690`, `crates/cognia-task-workspace/src/store.rs:52`, `crates/cognia-task-workspace/src/store.rs:483`, `crates/cognia-task-workspace/src/store.rs:527`, `crates/cognia-task-workspace/src/store.rs:563`, `crates/cognia-task-workspace/src/store.rs:933`, `crates/cognia-task-workspace/src/store.rs:959`, `crates/cognia-task-workspace/src/store.rs:1364`

- **inferred**: Retention 设计：继续使用现有 blob store，在 prune_unreferenced_blobs 中显式加入 provenance_blob_pins，不能只新增表却忘记 blob GC。task prune 前完成最小 source metadata 快照，当前 line map、path_history 和被当前段引用的来源不受 task TTL 影响。单独 GC 可压缩旧 versions/operation 历史和已无当前引用的详情，但保留当前图与 adoption 摘要；只在显式 project-history 删除时清除这些保留记录。建议初始可配置上限：文本 2 MiB/100k 行、单次返回最多 2,000 段和 100 个历史事件、旧全文版本最多 32 个/文件；这些是设计参数，尚未基准测试。现有 blobs 默认预算 1 GiB，新 pins 仍计入总预算。容量不足必须返回 degraded/capacity 状态，不能静默删除当前来源或伪报完整；有界存储无法承诺无限历史全文。
  - Evidence: `crates/cognia-task-workspace/src/store.rs:680`, `crates/cognia-task-workspace/src/store.rs:702`, `crates/cognia-task-workspace/src/store.rs:1364`, `crates/cognia-task-workspace/src/types.rs:1060`, `docs/plans/2026-10-16-agent-sandbox-workspace-gap-analysis.md:51`

- **observed**: 6. RPC 现状：可复用 command wrapper 在 cognia-task-workspace-host/host_surface.rs；src-tauri/task_workspace.rs 仅 re-export，src-tauri/lib.rs 注册。Companion filesystem.rs 有独立 task_workspace arms，现有多个 task/run-id 读取直接调用 service，没有在该 arm 中调用 authorize_workspace_root。authorize_workspace_root 在 headless 使用 SpawnPolicy，在 desktop 使用已注册项目 root 并 canonicalize；远端还检查 transport/capability/approval。host.observe 不能替代 root/session 级授权。
  - Evidence: `crates/cognia-task-workspace-host/src/host_surface.rs:1463`, `src-tauri/src/task_workspace.rs:1`, `src-tauri/src/lib.rs:1021`, `src-tauri/src/companion_api/rpc/filesystem.rs:892`, `src-tauri/src/companion_api/rpc/filesystem.rs:970`, `src-tauri/src/companion_api/rpc.rs:3263`, `src-tauri/src/companion_api/rpc.rs:3312`, `crates/cognia-companion/src/remote_execution.rs:379`, `protocol/companion-commands.json:20882`

- **inferred**: 新增 host command：task_workspace_resource_history({rootId, resourceId?|relPath, startLine?, endLine?, expectedContentHash?, cursor?, limit?})。rootId 解析为当前获授权的持久 root，所有 resource/version/cursor 必须属于它。返回 {resourceRef,relativePath,versionId,contentHash,segments,provenance,adoptionHistory,identityState,reconcileStatus,nextCursor}；复用 ResourceRefV1，version 使用 versionId，不返回 canonical_root、execution_root、blob 文件路径或聊天正文。expectedContentHash 不匹配返回明确 stale 结果，不让 UI 把旧行号套到新内容。新增 Rust 类型/service/store、host wrapper、Tauri 注册、Companion arm/command list、output_registry、三个 protocol catalog 和 lib/task-workspace/{types,client}.ts；按现有 generator 更新 known_commands/OpenAPI/CLI artifacts，不手改生成文件。
  - Evidence: `packages/agent-config-types/src/governance.ts:19`, `crates/cognia-task-workspace-host/src/host_surface.rs:1532`, `src-tauri/src/companion_api/output_registry.rs:775`, `protocol/companion-request-schemas.json:17510`, `protocol/companion-response-schemas.json:15833`, `lib/task-workspace/client.ts:3`, `package.json:355`, `package.json:357`

- **inferred**: 权限设计必须在读取前执行：device 需要对应 host.observe capability 和当前 root grant；service scope 仍需其 SpawnPolicy/root scope；agent root 由可信 session execution context 解析，模型不能指定任意 root/session。查询不能依赖 get_task 成功，否则 prune 后不可用。路径需要 confinement、symlink、敏感资源检查；来源会话引用另行做读授权，不能仅因可读文件就泄露其他私有 session。首版共享会话直接拒绝本地 history 工具，返回不含路径的 workspace_history_forbidden；未来开放需显式 workspace/resource grant 与来源会话权限。现有 assertSharedSessionRead 只证明共享会话读取权，文件分享另有授权；shared assistant serializer 不会普遍剔除文件路径，不能依赖它兜底。
  - Evidence: `src-tauri/src/companion_api/rpc.rs:3263`, `src-tauri/src/companion_api/rpc.rs:3288`, `lib/workspace/session-root.ts:74`, `lib/collab/shared-session-access.ts:15`, `lib/collab/shared-session-access.ts:81`, `lib/collab/shared-run-coordinator.ts:663`, `lib/collab/shared-run-coordinator.ts:691`

- **inferred**: 7. 聊天跳转复用现有 messagePermalinkQuery({sessionId,messageId}) 和 jumpToSessionMessage：后者处理 focus、history/viewport readiness、超时及用户切走。新增 task_workspace_bind_run_message，在 turn-tracker settle 时幂等绑定 assistantMessageId 到 durable source metadata，host 校验 run/session 所属关系；优先由实际 turn 完成事件传精确 message ID，现有 closing-message 查找用于兼容回填。不要把 turn_id、task run_id 或 code-adoption 数值 runId 当 messageId。没有 message ID 时使用 buildSessionHref 降级到会话；会话已删除、未同步或无权限时显示 unavailable。保留 provenance 引用不等于永久保留聊天正文。
  - Evidence: `lib/chat/message-permalink.ts:38`, `lib/chat/message-permalink.ts:82`, `lib/chat/cross-session-jump.ts:28`, `lib/chat/cross-session-jump.ts:55`, `lib/code-adoption/turn-tracker.ts:206`, `lib/code-adoption/turn-tracker.ts:217`, `lib/code-adoption/persist.ts:20`, `lib/code-adoption/persist.ts:74`

- **inferred**: 8. UI 现状及接入：ProjectMonaco 已有 editor/monaco refs、按文件的 model/workbench 生命周期和 teardown；monaco-workbench.setDecorations 按 typeId 隔离。现有 Git blame 后端与 gitBlame transport 已完整存在，Source Control 的 BlameView 是 HTML gutter/Sheet，不是 Monaco inline blame。建议新增 hooks/editor/use-project-file-provenance.ts 负责 bounded query/cache/draft remap，由 ProjectMonaco 绑定独立 decoration collection、hover provider 和本地 conversation action；复用或提取 BlameView 的来源展示，加 Git/Agent 切换，保留两者不同语义。请求返回时校验 host/root/model URI/version/hash；dirty buffer 先做 saved→draft 投影，修改行显示 human/unsaved，不能直接显示磁盘 attribution。清理 provider/listener/decoration 时不能影响 LSP/plugin 标记；标签、aria、错误状态写入 en/zh-CN split i18n。
  - Evidence: `components/editor/project/project-monaco.tsx:143`, `components/editor/project/project-monaco.tsx:293`, `components/editor/project/project-monaco.tsx:313`, `lib/editor-workbench/monaco-workbench.ts:265`, `crates/cognia-git/src/blame.rs:18`, `lib/git/commands.ts:344`, `components/source-control/blame-view.tsx:3`, `components/source-control/blame-view.tsx:122`, `components/source-control/source-control-panel.tsx:710`

- **observed**: 9. 工具现有两条接入路径：lib/claude/*-builtin-tools.ts 可经 build-options.pluginTools → plugin-tool-ipc 在 renderer 执行；sidecar resident built-ins 经 collectCogniaToolDefs 同时适配 Claude SDK MCP 和 Cognia AI SDK。resident registry 已接 hostRpc/sessionId，Rust 私有 host_rpc 在 desktop/headless 共用 dispatch_runtime_rpc；当前 dispatcher 路由 sessionStore/jobs 等，没有 workspace history。独立 external MCP tool-bridge 没有 hostRpc。只声明 readOnlyHint 不足以实现权限一致性，catalog/permission ladder 还读取 requiresApproval。
  - Evidence: `lib/claude/editor-builtin-tools.ts:4`, `lib/claude/build-options.ts:3906`, `lib/claude/plugin-tool-ipc.ts:379`, `sidecar/src/tools/builtin/registry.ts:39`, `sidecar/src/tools/builtin/registry.ts:51`, `sidecar/src/tools/adapters/sdk-mcp.ts:46`, `sidecar/src/tools/adapters/ai-sdk.ts:218`, `crates/cognia-sidecar/src/supervisor.rs:656`, `src-tauri/src/claude/host.rs:102`, `crates/cognia-companion-rpc/src/sidecar_runtime.rs:153`, `sidecar/src/mcp/servers/tool-bridge.ts:155`, `sidecar/src/policy/tool-catalog/catalog.ts:19`

- **inferred**: 推荐 workspace_resource_history 采用 resident hostRpc adapter，保证 headless 可用：新增 sidecar/src/tools/builtin/workspace-history/index.ts，接 registry；私有方法 workspace.resourceHistory 在 crates/cognia-companion-rpc/src/sidecar_runtime.rs 分发到同一 host query/auth helper。模型 schema 只暴露相对 path/resourceId、行范围、limit；session/root scope 从可信执行上下文绑定并由 host 再验证。更新 lib/settings/builtin-tools-data.json、build-options 的工具可用性和 lib/claude/permissions/workspace-history-tool-rules.ts，声明 read-only、requiresApproval=false，显式 deny 始终优先。若某 runtime 使用 host-routed manifest，则新增 lib/claude/workspace-history-builtin-tools.ts/plugin-tool-ipc adapter，但每个 runtime 只注册一种实现，避免 resident 与 manifest 重名。返回内容走现有 model-safe/PII 输出 gate，不携带原始聊天正文；无 hostRpc/broker 的 external bridge 明确 unavailable，不能回落到任意本机扫描。
  - Evidence: `sidecar/src/tools/builtin/core-files/monitor.ts:180`, `sidecar/src/tools/builtin/core-files/monitor.ts:198`, `sidecar/src/tools/builtin/metadata-parity.test.ts:101`, `sidecar/src/tools/adapters/ai-sdk.ts:210`, `sidecar/src/policy/permission/ladder.ts:307`, `lib/claude/permissions/editor-tool-rules.ts:26`, `lib/claude/plugin-tool-ipc.ts:121`, `crates/cognia-companion-rpc/src/sidecar_runtime.rs:153`

- **observed**: 10. W3 现状有一个重要修正：ContextCommentAnchor 已经有 optional quotedText，但 project producer 没填写，只存 start/end/revision。fileBaseToken 由 draftVersion、mtime、externallyChanged 和 draftContent 的轻量 token 拼成，不是 durable hash。ContextCommentsPanel 已有 resolveAnchor 回调，并在显示时派生 anchor，不修改原记录；stale 判断主要是 revision mismatch。评论序列化保存整个 anchor payload，CURRENT_SCHEMA_VERSION 当前为 243，contextComments 索引没有任何 anchor 子字段。因此扩展 quotedText/prefix/suffix/baseContentHash 等可选 payload 字段不需要 Dexie bump。
  - Evidence: `types/context-comment.ts:24`, `types/context-comment.ts:28`, `types/context-comment.ts:82`, `components/editor/project/project-context-workbench.tsx:44`, `components/editor/project/project-context-workbench.tsx:412`, `components/context-workbench/context-comments-panel.tsx:61`, `components/context-workbench/context-comments-panel.tsx:81`, `components/context-workbench/context-comments-panel.tsx:159`, `lib/db/context-comments.ts:32`, `lib/db/schema.ts:438`, `lib/db/schema.ts:663`

- **inferred**: W3 payload 设计：保留原 start/end/revision，填写 quotedText，新增 optional anchorVersion:1、baseContentHash、baseVersionId、prefixContext、suffixContext、resourceIdentityId、quoteComplete。创建时对准确的 draftContent 捕获，不能拿磁盘 hash 代表未保存文本；baseVersionId 仅在 bytes/hash 确认相同时填写。建议 prefix/suffix 各 128 UTF-16 code units，quote 上限 8 Ki code units；超大选择显式 quoteComplete=false 并保留完整选择长度/hash，不能把截断 quote 当完整 anchor。已有 provenance base blob 可用于 diff；未保存 base 在当前 editor 内存可用，重开后若无保留版本则走 quote fallback。无需强制为每条评论保存整份文件或引入 CRDT。
  - Evidence: `types/context-comment.ts:12`, `components/editor/project/project-context-workbench.tsx:409`, `components/editor/project/use-project-editor.ts:77`, `lib/db/context-comments.ts:128`, `docs/plans/2026-10-16-agent-sandbox-workspace-gap-analysis.md:49`

- **inferred**: W3 resolver：相同 content hash 直接 resolved；有 base content 时先用行 diff 搬移范围，再对边界行做字符 diff，输出 UTF-16 offsets。发生位置变化为 moved；原文删除或映射歧义时转 quote 搜索：先全文精确匹配，用 prefix/suffix 和旧位置距离消歧，再在旧位置附近有限窗口 fuzzy 搜索。建议初始窗口 ±200 行，接受阈值 similarity≥0.90 且领先第二候选≥0.10，必须由 fixtures 校准；重复匹配、低分、截断 quote 无法验证完整范围时返回 orphaned。结果独立为 {status,start?,end?,lineRange?,resolvedContentHash,method,confidence}，不改原 anchor，也不改评论 resolvedAt。新增 lib/context-workbench/project-file-comment-anchors.ts 作为纯算法模块；项目 hook 异步准备结果，接现有同步 resolveAnchor。保存版本可新增只读 task_workspace_resolve_text_anchor 使用 host 已保留 base；dirty draft 在前端解析。缓存按 base/current hash，旧请求失效。legacy anchor 无 quote/base 时保留保守 stale 状态，不猜位置。
  - Evidence: `components/context-workbench/context-comments-panel.tsx:61`, `components/context-workbench/context-comments-panel.tsx:81`, `types/context-comment.ts:54`, `types/context-comment.ts:82`, `components/editor/project/project-monaco.tsx:356`, `lib/chat/intraline-diff.ts:1`, `lib/chat/intraline-diff.ts:30`

- **inferred**: W3 还需处理 rename 后的评论查找：当前 resourceId 由 projectId:rootId:relPath 生成，新增 stable identity 不会自动找到旧评论。新评论可使用 host-scoped stable resource identity，读取时通过可信 path_history 查询旧路径 alias 并去重，或显式迁移旧 resourceId；ambiguous rename 不自动迁移。现有 [resourceKind+resourceId] 索引足够实现，不需 bump。只有新增 Dexie base-content 表、resourceIdentityId/taskWorkspaceRunId/assistantMessageId 索引或改 CURRENT_SCHEMA 索引定义时才需要从当前 243 协调递增；本建议避免这些变化。
  - Evidence: `lib/context-workbench/project-file-proposals.ts:30`, `lib/context-workbench/project-file-proposals.ts:35`, `components/editor/project/project-context-workbench.tsx:281`, `lib/db/context-comments.ts:100`, `lib/db/schema.ts:643`, `lib/db/schema.ts:663`, `lib/db/schema.ts:1052`

- **inferred**: 分阶段实施计划：P1，Rust owner 在 types.rs/store.rs 新增 additive schema、provenance.rs 和 line_map.rs，定义证据/状态/identity/版本算法与 GC pins；新模块有必要，因为 resource_index.rs 仅折叠文件级净变化并丢弃 hunk 细节。验证旧库重开、重复迁移、RLE 不变量和 task prune 后查询。P2，Rust host owner 接 ledger apply/force/undo、bundle compensation/retry、integration publication/recovery、watcher 和 files save receipt；配套 W1 条件保存；TS owner 在 tool-evidence/turn-tracker 绑定 tool/message。验证 actual post-apply hash、partial/merge/rollback/crash。P3，RPC/tool owner 接 query/auth/catalog/client、resident adapter、permission metadata；验证 desktop/headless/paired parity及共享拒绝。P4，editor owner 接 Monaco gutter/hover、Source Control 展示、permalink 和 i18n；验证 dirty model 与 tab lifecycle。P5，comment owner 扩展 payload、producer、resolver/panel 和 rename aliases；验证旧数据兼容及 moved/orphaned。P3 依赖 P1/P2，P4 依赖 P3；P5 的 quote fallback 可先行，host base/rename 能力随后接 P3。所有阶段先交付对应行为测试，再启用用户入口。
  - Evidence: `crates/cognia-task-workspace/src/resource_index.rs:3`, `crates/cognia-task-workspace/src/resource_index.rs:45`, `crates/cognia-task-workspace/src/service.rs:4243`, `crates/cognia-task-workspace/src/integration.rs:1539`, `crates/cognia-task-workspace-host/src/host_surface.rs:1463`, `components/editor/project/project-monaco.tsx:293`, `components/context-workbench/context-comments-panel.tsx:61`

- **inferred**: 测试与验收：Rust co-located tests 覆盖未选前置 hunk 导致偏移、three-way merge 保留人类行、两个工具同路径/事件乱序、无 receipt 的 null tool、纯删除、rename+edit/copy/重复内容歧义、A→B→A、Git OID/SHA256、CRLF/空文件、缺 blob、overflow、容量不足、写文件成功但 SQLite 提交前崩溃、bundle 补偿失败/重试、integration publish/rollback recovery，以及 prune 后完整 source/message 引用。扩展现有 service 的 apply/undo/partial/prune fixtures。RPC 测未授权 root/device、headless policy、traversal/symlink、敏感路径、跨 session refs、共享错误无路径、cursor 越界。前端扩展 client、turn-tracker、project-monaco、blame-view、project-context-workbench、context-comments-panel 测试；W3 覆盖范围前插入、范围内修改/删除、重复 quote、emoji UTF-16、dirty draft、旧 anchor 和缺 base。增加真实 editor 流程：agent apply→人类插行→rename→task prune→hover 跳转，以及评论 moved/orphaned。实施时只运行定向 Jest、cargo test -p cognia-task-workspace <filter>、对应 host crate tests、companion-api:check 与相关 contract tests；本次没有执行这些验证。
  - Evidence: `crates/cognia-task-workspace/src/service.rs:8481`, `crates/cognia-task-workspace/src/service.rs:8734`, `crates/cognia-task-workspace/src/service.rs:8989`, `crates/cognia-task-workspace/src/service.rs:9113`, `crates/cognia-task-workspace/src/integration.rs:3414`, `src-tauri/src/companion_api/rpc/tests.rs:4313`, `lib/task-workspace/client.test.ts:685`, `lib/code-adoption/turn-tracker.test.ts:141`, `components/context-workbench/context-comments-panel.test.tsx:107`, `lib/editor-workbench/monaco-workbench.test.ts:384`, `sidecar/src/tools/builtin/metadata-parity.test.ts:74`, `package.json:355`

- **inferred**: 上线与风险控制：先隐藏 UI/tool、启用 additive schema 和受限采集，再运行确定性 fixtures，最后分批开放查询与 UI。历史回填只对仍存在且可验证的 blobs/patches/actual hashes执行，标明 inferred/reconciled；不承诺恢复已经 prune 的正文或未观察到的工具顺序。出现错误来源、跨 root/session 数据暴露或写入回归时停止 rollout；关闭新入口保留 schema/metadata，不做破坏性回滚。记录 bounded 指标：projection gap、unknown line ratio、ambiguous identity、reconcile latency、pinned bytes、failed mutation finalization；不以真实路径/session 内容作日志或指标标签。主要剩余风险是外部写竞争、重复文本的不可判定归属、storage pressure、长期聊天不可达，以及 headless/external runtime 的可信 session context 接线。
  - Evidence: `crates/cognia-task-workspace/src/ledger.rs:906`, `crates/cognia-task-workspace/src/store.rs:710`, `crates/cognia-task-workspace/src/service.rs:4580`, `lib/code-adoption/persist.ts:74`, `lib/collab/shared-run-coordinator.ts:663`, `sidecar/src/mcp/servers/tool-bridge.ts:155`

## Open questions

- 各 external agent/provider 能否提供带实际 before/after hashes 的可信 per-tool mutation receipt，当前源码不能证明；不具备该能力的路径只能承诺 run 级来源和 nullable/inferred tool linkage。

- 建议的 2 MiB/100k 行、历史版本保留数、query 大小和 fuzzy 阈值尚未做性能或误匹配实验，实施前需用代表性仓库 fixtures 校准。

- 首版建议共享会话拒绝本地 provenance；若必须开放共享或无 hostRpc 的独立 external MCP bridge，需要额外的服务器 workspace grant/可信 broker 设计，现有 session.read 和路径事件不足以授权。

## Decisions (2026-10-16)

- **Tool linkage:** a precise line→tool-call link is recorded only from a trusted mutation receipt whose before/after hashes match the observed transition. Agents and providers that send no receipt get run-level provenance with a nullable tool link marked `inferred`, never a guessed tool call.
- **Bounds:** the initial limits are 2 MiB or 100k lines per text, 32 retained full-text versions per file, 2,000 segments and 100 history events per query, and fuzzy re-anchoring at similarity ≥0.90 with a ≥0.10 lead over the runner-up. These are configurable constants pinned by fixtures. Exceeding a bound returns a `degraded`/`capacity` status and never silently drops current provenance.
- **Shared sessions:** `workspace_resource_history` and the editor query refuse with `workspace_history_forbidden` and carry no paths. External MCP bridges without a host RPC report the tool as unavailable.
- **Rollout:** the schema is additive and capture starts with the first release. No feature flag hides correct behaviour. Each phase ships with its tests before its user entry point is enabled.
- **Phases:** P1 schema + `line_map` + `provenance` modules; P2 capture hooks (ledger apply/force/undo, bundle apply/compensate, integration publish/recovery, W1 editor-save receipt, watcher reconcile, turn-tracker message binding); P3 host query + RPC + resident agent tool + permissions; P4 Monaco gutter/hover + Source Control view + permalink; P5 (= W3) comment anchor payload, resolver and rename aliases.
