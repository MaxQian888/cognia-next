---
name: dexie-migration
description: Add or revise Cognia's Dexie schema safely. Use when a change needs a table, index, schema version, or IndexedDB backfill in lib/db/schema.ts; covers concurrent version claims, upgrade callbacks, consumers, and required tests.
---

# Dexie Schema Migration

`lib/db/schema.ts` is the single authority. Versions are append-only and
monotonic; shipped version blocks are immutable.

## Workflow

1. **Read the live schema and tests.** Search every `this.version(` in
   `lib/db/schema.ts`; the highest registered number is the base. Inspect the
   nearest migration and its test before designing the next one. Treat docs and
   remembered version numbers as hints only.
2. **Claim against the current tree.** Run `rtk git status --short --
   lib/db/schema.ts lib/db/schema.test.ts` and `rtk git diff --
   lib/db/schema.ts`. Re-read the highest version immediately before editing;
   shared-tree work can claim it while you investigate. Use the next unused
   integer and record the version in the migration test name.
3. **Append a new `this.version(N)` block.**
   - New tables/indexes: `.stores({ ... })` listing ONLY changed tables
     (Dexie merges unchanged ones).
   - Data backfill / reshaping: chain `.upgrade(async (tx) => { ... })`.
     Upgrade callbacks must be idempotent-safe and handle records created by
     every earlier version.
   - Preserve every shipped block. Correct an old schema with a new version.
4. **Update `lib/db/schema.test.ts`** in the same change. For an additive
   schema change, assert the new table/index opens at the claimed version. For
   an upgrade callback, seed the immediately preceding shape, open the current
   `CogniaDB`, and assert both transformed and unaffected records.
5. **Update consumers** (`lib/db/*.ts` table accessors, types) and their
   co-located tests. Coverage stays ≥90%.
6. **Verify**: `rtk pnpm test -- lib/db/schema.test.ts`, the changed consumer
   tests, `rtk pnpm typecheck`, and `rtk pnpm test:coverage` before completion.

## Notes

- Table accessor modules live in `lib/db/` (one file per domain). Reuse the
  existing patterns there; don't invent a new access layer.
- If an ADR records the affected schema contract, update its English and
  Chinese copies when the implementation changes that contract.
