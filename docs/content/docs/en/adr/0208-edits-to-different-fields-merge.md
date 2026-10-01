---
title: "0208 — Edits to different fields merge; only an edit to the same field conflicts"
description: "Shared issues and plans keep, next to their record revision, the revision at which each field last changed. A PATCH with a stale baseRevision is applied when none of the fields it names changed after that revision. A 409 is returned only when the same field changed. It then names the conflicting fields and carries the server's values for just those fields, so the conflicts panel shows the real disagreement instead of the whole record. board_order is last-writer-wins in server order. operationId idempotency is unchanged."
---

# ADR 0208 — Edits to different fields merge; only an edit to the same field conflicts

**Status:** Accepted, implemented (2026-10-01)
**Date:** 2026-09-30
**Related:** [ADR-0149](./0149-a-person-is-not-a-device) (the 2026-08-28 write path), [ADR-0206](./0206-a-workspace-streams-its-changes-instead-of-being-polled) (which makes stale bases rarer, but not rare enough)
**Source study:** `docs/plans/2026-09-30-collaboration-multi-device-gap-analysis.md` (gap A4)

## Context

Writes to shared issues, plans and runs carry an `operationId` and a
`baseRevision` (migration `0004_write_concurrency.sql`). The store refuses any
write whose base is not the current `revision`, and the check does not look at
what the write touches. From `PgStore::patch_issue`, which runs under `SELECT … FOR UPDATE`, and the in-memory store,
which is identical:

```rust
if issue.revision != guard.base_revision {
    return Err(StoreError::Conflict(/* the whole current issue */));
}
```

The wire form is already a partial patch. `PatchIssueBody` names `title`,
`body`, `status`, `priority`, `board_order` and `assignee`, each optional, and
`PatchPlanBody` does the same. So when one person drags a card while another
changes its priority, the second write gets a 409, although the two writes
never touched the same field.

The client queues the refused write as `conflicted`.
`components/issues/collab-conflicts-panel.tsx` then shows the person
`JSON.stringify(row.conflictAuthoritative)`, the entire server record, and
leaves them to work out what differs. As the ADR-0206 feed makes the board
live, more people edit the same cards at the same time, and this gets worse,
not better.

Figma and Linear both solve this per property. Writes to different
properties never conflict, and a write to the same property is ordered by the
server. A text body is the one place where last-writer-wins silently loses
work, and it is the one place those products either merge or refuse.

## Decision

### 1. Each field remembers the revision at which it last changed

A new migration (`00NN_field_revisions.sql`, the next free number when this lands) adds `field_revisions jsonb NOT NULL
DEFAULT '{}'` to `issues` and `plans`. Every accepted write bumps `revision`
and sets `field_revisions[f] = new revision` for each field it changed. A field
missing from the map counts as last changed at revision 1. That makes every
existing row valid without a backfill, and it is conservative: an old row
treats a stale base as conflicting on every field.

Runs are excluded. A run is written by the device that holds its lease
(ADR-0149 shared chat, `shared-run-coordinator.ts`), so it has one writer, and
a stale base there points to a bug, not a concurrent edit.

### 2. A stale base is accepted when the named fields are untouched

The store's check becomes:

1. If `last_operation_id == operationId`, return the stored record. This is
   today's idempotent-retry path, unchanged.
2. If `baseRevision == revision`, apply. This is today's fast path.
3. If `baseRevision > revision` or `baseRevision < 1`, return 400. Neither can
   be honest.
4. Otherwise, work out `clashing = { f ∈ patch.fields | field_revisions[f] > baseRevision }`:
   - empty: apply the patch;
   - non-empty: return 409 (§3).

Each field has its own merge rule:

| field | rule |
| --- | --- |
| `status`, `priority`, `assignee`, plan `status` | same-field clash → 409. They are discrete, and the second person should see the first person's choice. |
| `board_order` | **never clashes.** Last writer wins in server order. A position is a hint, re-dragging is cheap, and a 409 on a drag is pure noise |
| `title`, `body`, plan `description` | same-field clash → 409. Text is where a silent overwrite loses work |
| plan `steps[]` progress | per step id. Only a step named in the patch that changed after the base clashes |

The whole check runs inside the row lock the store already holds for the
write, so two writes cannot both see the same map and both pass.

### 3. A 409 names what clashed

The conflict body goes from "the whole record" to:

```json
{
  "code": "field_conflict",
  "revision": 12,
  "fields": {
    "priority": { "yours": "high", "theirs": "urgent", "changedAt": 11, "changedBy": "usr_…" }
  },
  "current": { /* the full record, for clients that want it */ }
}
```

`changedBy` comes from the `last_operation_id` author on each field. That
needs a companion `field_authors jsonb` map, written next to
`field_revisions`. It costs one more jsonb column and avoids a join into the
event log on the conflict path.

The client (`lib/collab/outbound-dispatcher.ts`) stores `fields` on the
`conflicted` row. The conflicts panel renders one line per clashing field,
"yours → theirs, changed by X", with **Keep mine**, **Take theirs** and
**Edit**. Keep mine re-sends only the clashing fields, at the new `revision`,
under a fresh `operationId`. The panel's new strings are added in both
`en` and `zh-CN` under `issues.conflicts`.

### 4. What does not change

- `operationId` idempotency, and the unique `created_operation_id` per org.
- Mirror writes. The client still never rewrites the mirror optimistically.
  Pending writes stay an overlay, and the accepted record arrives through the
  normal refresh, which the ADR-0206 feed now triggers.
- Authorization. The capability check runs before the merge check, exactly
  where it runs now.

## Consequences

- Concurrent edits to different fields of one card stop producing conflicts,
  and most board activity is exactly that: drag, reprioritise, reassign.
- A conflict that does reach a person names the field and who changed it, so
  resolving it is a choice, not a JSON diff.
- `issues` and `plans` rows grow by two small jsonb maps.
- New tests:
  - store tests for each merge rule, in both the Pg and in-memory stores;
  - a concurrency test with two writers, one base and disjoint fields, where
    both land and `revision` rises by 2;
  - a 409-shape test;
  - `outbound-dispatcher.test.ts` and `collab-conflicts-panel.test.tsx`
    updates for field-level rows;
  - an RLS test extension proving that `field_authors` does not leak a user id
    across tenants.

## Not decided

- **Merging text.** A three-way merge of `body` using diff3, or a Yjs-backed
  body like Canvas, would remove the last common source of 409s. Neither is
  proposed here. A 409 on `body` with a clear field-level panel is a much
  smaller step, and it shows whether text clashes happen often enough to pay
  for a merge.
- **Labels and project moves.** Both are still withheld on the write path
  (`lib/issues/sources/collab-source.ts`). When they land, they should arrive
  with per-field rules from the start.

## Implementation notes (2026-10-01)

- One `field_revisions jsonb` column per table (migration
  `0012_field_revisions.sql`), not two: each entry carries both the revision
  and the author, `{"status": {"revision": 7, "by": "usr_…"}}`.
- **The `$since` marker.** The first tracked write records `$since` as the
  revision before it, since every later change is stamped. An unstamped field
  therefore last changed at or before `$since`. A row with no marker predates
  tracking: a stale base clashes on every field it names until the row's
  first tracked write. Without the marker, a freshly created issue would have
  conflicted on fields nobody had touched. Pure rule and tests:
  `crates/cognia-collab-server/src/field_merge.rs`.
- An impossible base (ahead of the record) keeps the pre-0208 whole-record
  409; `mutation_guard` already refuses a base below 1.
- The 409 keeps `authoritative` (the whole record) for older clients and adds
  `code: "field_conflict"` and `fields`. The client carries them as
  `CollabConflictError.fields`, the queue row as `conflictFields`, and the
  conflicts panel renders one line per field with the author's name from the
  identity mirror. "Resubmit on latest" is the existing rebase, which re-sends
  only the fields the person edited.
- The Postgres path is covered by
  `stale_patches_merge_by_field_in_postgres` in `tests/postgres_rls.rs`, which
  the CI `postgres-rls` job runs.
