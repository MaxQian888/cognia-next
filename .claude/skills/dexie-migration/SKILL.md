---
name: dexie-migration
description: Add a new Dexie schema version to lib/db/schema.ts safely. Use whenever a change needs a new table, index, or data backfill in the IndexedDB schema — covers version claiming, upgrade callbacks, and the test updates the repo requires.
---

# Dexie Schema Migration

`lib/db/schema.ts` is the single authority. Versions are append-only and
monotonic; shipped version blocks are immutable.

## Workflow

1. **Find the current highest version** — search `this.version(` in
   `lib/db/schema.ts` and take the last block. Do NOT trust memory, docs, or
   CLAUDE.md for the number; they lag.
2. **Check for concurrent claims.** Other agents/branches routinely take the
   next number (this has happened repeatedly: v66, v69 were both lost to
   concurrent work). Before claiming, also check `rtk git diff dev -- lib/db/schema.ts`
   and any sibling branch you know is in flight. If a collision is plausible,
   claim N+1 and note why.
3. **Append a new `this.version(N)` block.**
   - New tables/indexes: `.stores({ ... })` listing ONLY changed tables
     (Dexie merges unchanged ones).
   - Data backfill / reshaping: chain `.upgrade(async (tx) => { ... })`.
     Upgrade callbacks must be idempotent-safe and handle records created by
     every earlier version.
   - Never edit an existing version block — even to "fix" it. Add a new one.
4. **Update `lib/db/schema.test.ts`** in the same change: the version-number
   assertion, plus tests for any upgrade callback (seed old-shape records,
   open at N, assert the new shape).
5. **Update consumers** (`lib/db/*.ts` table accessors, types) and their
   co-located tests. Coverage stays ≥90%.
6. **Verify**: `rtk pnpm test -- lib/db` and `rtk tsc`.

## Notes

- Table accessor modules live in `lib/db/` (one file per domain). Reuse the
  existing patterns there; don't invent a new access layer.
- If the migration supports a feature documented in an ADR, mention the new
  version number in the ADR's schema column (Subsystem Map in CLAUDE.md uses
  it too, but only update CLAUDE.md when asked).
