---
name: dexie-migration
description: Change the Dexie (IndexedDB) schema in lib/db/schema.ts safely. Use whenever a change needs a new table, index, or dropped table — covers the version bump, the concurrent-claim check, the governance catalog, and the test updates the repo requires.
---

# Dexie Schema Change

`lib/db/schema.ts` declares the whole store set once, as `CURRENT_SCHEMA` at
`CURRENT_SCHEMA_VERSION`, on top of a frozen `SCHEMA_V240` baseline.

## Workflow

1. **Read the current version** from `CURRENT_SCHEMA_VERSION` in
   `lib/db/schema.ts`. Docs and memory lag; the constant is the only source.
2. **Check for concurrent claims.** Other sessions and branches take the next
   number too. Before claiming, check `git diff dev -- lib/db/schema.ts` and
   any sibling branch you know is in flight; if a collision is plausible,
   claim N+1 and say why.
3. **Edit `CURRENT_SCHEMA` and bump `CURRENT_SCHEMA_VERSION`.** An edit without
   a bump is silently ignored on existing databases. Drop a table by setting
   it to `null`, never by deleting the key. Add a new table to
   `CORE_TABLE_NAMES` in `lib/data-governance/table-catalog.ts`, then run
   `pnpm db:governance:write`.
4. **Data backfills:** CLAUDE.md says local data is not migrated, but
   `schema.ts` still carries three `.upgrade()` steps (v240–v242). Ask the
   user before adding a new backfill.
5. **Update `lib/db/schema.test.ts`** in the same change (the version
   assertion and any shape tests).
6. **Update consumers** (`lib/db/*.ts` table accessors, types) and their
   co-located tests.
7. **Verify**: `pnpm test -- lib/db` and `pnpm typecheck`.

## Notes

- Table accessor modules live in `lib/db/` (one file per domain). Reuse the
  existing patterns there; don't invent a new access layer.
- If the migration supports a feature documented in an ADR, mention the new
  version number in the ADR's schema column (Subsystem Map in CLAUDE.md uses
  it too, but only update CLAUDE.md when asked).
