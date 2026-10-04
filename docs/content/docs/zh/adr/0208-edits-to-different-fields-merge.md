---
title: "0208 — 改不同字段自动合并，只有改同一字段才冲突"
description: "共享议题和计划记录每个字段最后变更的修订号。PATCH 的 baseRevision 过期时，只要涉及字段此后未改变，就应用更新。同一字段存在变更才返回 409，并附冲突字段与对应服务端取值。冲突面板只展示分歧字段。board_order 按服务端顺序采用后写者胜，operationId 幂等性不变。"
---

# ADR 0208 — 改不同字段自动合并，只有改同一字段才冲突

**状态：** 已接受，已实现（2026-10-01）**日期：** 2026-09-30 **相关：** [ADR-0149](./0149-a-person-is-not-a-device)（2026-08-28 的写入路径）、[ADR-0206](./0206-a-workspace-streams-its-changes-instead-of-being-polled)（它让过期基线变少，但还不够少）**来源研究：** `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md`（缺口 A4）

## 背景

对共享议题、计划和运行的写入都带 `operationId` 和 `baseRevision`（迁移 `0004_write_concurrency.sql`）。只要基线不等于当前 `revision`，存储就拒绝写入，不检查此次写入修改了哪些字段。下面摘自 `PgStore::patch_issue`（在 `SELECT … FOR UPDATE` 下执行）；内存实现与之相同：

```rust
if issue.revision != guard.base_revision {
    return Err(StoreError::Conflict(/* 当前完整议题 */));
}
```

而线上格式本来就是局部补丁。`PatchIssueBody` 列出 `title`、`body`、`status`、`priority`、`board_order` 和 `assignee`，每项都可选；`PatchPlanBody` 也一样。所以一个人拖动卡片、另一个人同时改它的优先级，后一个写入会拿到 409，尽管两次写入根本没碰同一个字段。

客户端把被拒的写入记为 `conflicted`。`components/issues/collab-conflicts-panel.tsx` 随后展示 `JSON.stringify(row.conflictAuthoritative)`，也就是完整的服务端记录，让用户自己找出哪里不同。ADR-0206 让看板实时化之后，会有更多人同时编辑同一批卡片，这个问题只会更糟。

Figma 和 Linear 都按属性解决：改不同属性的写入永不冲突，改同一属性的写入由服务端排序。只有文本正文会因后写者胜而悄悄丢掉内容，而这恰恰是那些产品要么合并、要么拒绝的地方。

## 决定

### 1. 每个字段记住自己最后变更时的修订号

新增一次迁移（`00NN_field_revisions.sql`，落地时取下一个空闲编号），在 `issues` 和 `plans` 上添加 `field_revisions jsonb NOT NULL DEFAULT '{}'`。每次被接受的写入都会递增 `revision`，并对它改动的每个字段设 `field_revisions[f] = 新修订号`。映射里没有的字段，视为最后在修订 1 时变更。这样所有现存行无需回填即有效，而且偏于保守：旧行会把过期基线视为在所有字段上都冲突。

运行不在此列。运行由持有租约的设备写入（ADR-0149 共享聊天，`shared-run-coordinator.ts`），只有一个写入者；那里出现过期基线说明有 bug，而不是并发编辑。

### 2. 涉及的字段没变过，就接受过期基线

存储的检查变为：

1. 若 `last_operation_id == operationId`，返回已存储的记录。这是现有的幂等重试路径，保持不变。
2. 若 `baseRevision == revision`，直接应用。这是现有的快速路径。
3. 若 `baseRevision > revision` 或 `baseRevision < 1`，返回 400。两者均为无效修订号。
4. 否则，计算 `clashing = { f ∈ patch.fields | field_revisions[f] > baseRevision }`：
   - 为空：应用补丁；
   - 非空：返回 409（见第 3 节）。

各字段有各自的合并规则：

| 字段 | 规则 |
| --- | --- |
| `status`、`priority`、`assignee`、计划 `status` | 同字段冲突 → 409。它们是离散值，后来的人应当看到前一个人的选择 |
| `board_order` | **永不冲突。** 按服务端顺序后写者胜。位置只是提示，重新拖动成本很低，拖动时弹 409 纯属噪声 |
| `title`、`body`、计划 `description` | 同字段冲突 → 409。静默覆盖文本会丢掉工作 |
| 计划 `steps[]` 进度 | 按步骤 id 判断。只有补丁中列出、且在基线之后变过的步骤才冲突 |

整个检查都在存储本来就为写入持有的行锁内完成，两次写入不可能看到同一份映射后都通过。

### 3. 409 写明冲突在哪里

冲突响应从「整条记录」改为：

```json
{
  "code": "field_conflict",
  "revision": 12,
  "fields": {
    "priority": { "yours": "high", "theirs": "urgent", "changedAt": 11, "changedBy": "usr_…" }
  },
  "current": { /* 完整记录，供需要的客户端使用 */ }
}
```

`changedBy` 取自每个字段上 `last_operation_id` 的作者，因此需要一个配套的 `field_authors jsonb` 映射，与 `field_revisions` 一起写入。代价是多一个 jsonb 列，好处是冲突路径上无需连接事件日志。

客户端（`lib/collab/outbound-dispatcher.ts`）把 `fields` 存进 `conflicted` 行。冲突面板为每个冲突字段显示一行「你的 → 对方的，由 X 修改」，并提供**保留我的**、**采用对方的**和**编辑**。「保留我的」只重发冲突字段，基于新的 `revision`，并使用新的 `operationId`。面板新增的文案同时加到 `issues.conflicts` 下的 `en` 和 `zh-CN`。

### 4. 不变的部分

- `operationId` 幂等性，以及每个组织内唯一的 `created_operation_id`。
- 镜像写入。客户端依然从不乐观改写镜像：待发写入仍只是一层覆盖，被接受的记录经常规刷新到达，而这次刷新如今由 ADR-0206 推送流触发。
- 授权。能力检查仍在合并检查之前，位置与现在完全相同。

## 后果

- 对同一张卡片不同字段的并发编辑不再冲突，而看板上的大部分活动正是这样：拖动、调优先级、改指派。
- 真正需要人处理的冲突会写明字段和修改者，解决它是做选择，而不是比对 JSON。
- `issues` 和 `plans` 的行各多两个小 jsonb 映射。
- 新增测试：
  - Pg 与内存两种存储上，每条合并规则的测试；
  - 并发测试：两个写入者、同一基线、字段不相交，两次都成功，`revision` 增加 2；
  - 409 响应形状测试；
  - 更新 `outbound-dispatcher.test.ts` 与 `collab-conflicts-panel.test.tsx`，覆盖字段级冲突行；
  - 扩展 RLS 测试，证明 `field_authors` 不会跨租户泄露用户 id。

## 尚未决定

- **合并文本。** 用 diff3 对 `body` 做三方合并，或像 Canvas 那样用 Yjs 承载正文，都能消除最后一种常见的 409。本 ADR 都不提议。在 `body` 上返回 409、配以清晰的字段级面板，是小得多的一步，也能看出文本冲突是否频繁到值得为合并付出代价。
- **标签与跨项目移动。** 两者在写入路径上仍被拦截（`lib/issues/sources/collab-source.ts`）。等它们落地时，应当一开始就带上字段级规则。

## 实现说明（2026-10-01）

- 每张表一个 `field_revisions jsonb` 列（迁移 `0012_field_revisions.sql`），而不是两列：每一项同时记录修订号和作者，形如 `{"status": {"revision": 7, "by": "usr_…"}}`。
- **`$since` 标记。** 第一次被跟踪的写入把它之前的修订号记为 `$since`，因为此后的每次改动都会留下印记。因此没有印记的字段，最后一次变更必然发生在 `$since` 或之前。没有该标记的行早于跟踪机制：在它第一次被跟踪的写入之前，过期基线在它涉及的每个字段上都算冲突。如果没有这个标记，刚创建的议题会在没人碰过的字段上冲突。纯规则与测试见 `crates/cognia-collab-server/src/field_merge.rs`。
- 不可能的基线（超前于记录）仍返回 0208 之前的整条记录 409；`mutation_guard` 本来就拒绝小于 1 的基线。
- 409 保留 `authoritative`（完整记录）以兼容旧客户端，并新增 `code: "field_conflict"` 与 `fields`。客户端将其作为 `CollabConflictError.fields` 携带，队列行存为 `conflictFields`，冲突面板逐字段显示一行，并从身份镜像中取作者姓名。「在最新版本上重新提交」沿用现有的变基，只重发此人编辑过的字段。
- Postgres 路径由 `tests/postgres_rls.rs` 中的 `stale_patches_merge_by_field_in_postgres` 覆盖，在 CI 的 `postgres-rls` 任务中运行。
