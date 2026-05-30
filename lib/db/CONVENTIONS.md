# `lib/db` conventions

The cognia-next data layer is a single IndexedDB database (`CogniaDB`, db name
`"cognia-claude"`) accessed through [Dexie](https://dexie.org). This document
captures the conventions the existing modules already follow so new code stays
consistent. It is descriptive, not aspirational — when in doubt, copy the
nearest existing module.

## Architecture at a glance

- **One database, one singleton.** `schema.ts` declares the `CogniaDB` class and
  the version chain, and exposes `getDb()` — a lazily-created, memoized,
  client-only singleton. Never construct `CogniaDB` directly outside `schema.ts`.
- **Per-table CRUD modules.** Each table gets a `lib/db/<table>.ts` module of
  async helper functions that call `getDb()`. These are the supported API; UI
  code imports from them (or uses `useLiveQuery` over `getDb().<table>`).
- **`getDb()` is client-only.** It throws on the server (static export
  pre-renders pages where `window` is undefined). Wrap usage in client
  components / effects.
- **Seeding.** Built-in rows (characters, skills, presets, workflow/goal
  templates, teams) are seeded once per process via `seed.ts`, kicked off lazily
  from `getDb()`. Seeders are idempotent (stable ids + `bulkPut`). `whenSeeded()`
  resolves when seeding completes.

## Schema versions (hard rules)

- **Never reorder, edit, or delete a historical `version(N).stores()` block or
  its `upgrade()` callback.** Dexie replays the whole chain on open; mutating
  history corrupts live user databases. Only ever append a new, strictly higher
  version.
- Pure index/table additions use an empty/additive `.stores({})` with **no**
  `upgrade()` hook. Add a hook only when existing rows need backfilling or
  reshaping, and make it **idempotent** (guard so re-running on reopen is safe).
- Document each new version with a short `// vNN — …` comment on the table
  property and/or the `.stores()` block.

## Row types — where they live

Decision tree (top match wins):

1. **A full domain type already exists** (in `@/types/*`, the owning subsystem
   module, or as a Rust mirror) → **reuse it.** Import it directly as the row
   type (e.g. `Goal`, `WikiArticle`), or `extends` it when the row is that type
   plus a couple of persistence fields (e.g.
   `AutomationAuditLogRow extends AuditEntry { conversationKey? }` in
   `lib/automation/audit.ts`). Never re-declare an interface that already
   exists elsewhere.
2. **The type belongs to a subsystem with a clear home** → put it there, not in
   `lib/db/`. Domain types live in `@/types/<area>` (e.g. the VS Code extension
   cache rows live in `types/plugin/vscode-extension-cache.ts`); persistence
   rows owned by one subsystem live in that subsystem's module (e.g.
   `TtsProviderKeyRow` in `lib/tts/types.ts`, `AutomationAuditLogRow` in
   `lib/automation/audit.ts`, `WorkflowViewportBookmarkRow` next to its CRUD in
   `lib/workflow/editor/viewport-bookmarks-db.ts`).
3. **The row is genuinely Dexie-only and table-local** → define it next to its
   CRUD module: co-located in the module itself when that module owns it
   (e.g. `BackupHistoryRow` in `backup-history.ts`, `ModelsDevCatalogRow` in
   `models-dev-catalog.ts`, `SessionStateRow` in `session-state.ts`), or in a
   dedicated `*-types.ts` when several tables share a file or `schema.ts` must
   avoid importing heavy CRUD deps (e.g. `plugin-types.ts`, `connector-types.ts`,
   `canvas-types.ts`, `inbox-telemetry-types.ts`).
4. Wherever it lands, if `schema.ts` previously exported the type, **re-export
   it from `schema.ts`** (`export type { X } from "…"`) so `@/lib/db/schema`
   stays a stable import surface for existing call sites.

Files in `types/**` are not in the Jest coverage scope, so a type moved there
needs no coverage test. A pure type-only file kept under `lib/**` either gets a
co-located side-effect test (see `canvas-types.test.ts`) or an entry in
`collectCoverageFrom`'s exclusion list (see `a2ui-types.ts`, `plugin-types.ts`,
`connector-types.ts` in `jest.config.ts`).

Keep the per-field JSDoc on row interfaces — it is the primary documentation for
the persisted shape.

## IDs

- **Row records** use a sortable, collision-resistant id:
  `"<prefix>_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)`
  (e.g. `char_`, `s_`, `m_`, `bh_`). Pick a short, table-specific prefix.
- **Append-only events / audit entries** use `crypto.randomUUID()` (e.g. goal
  events, connector audit) — they are not user-facing and benefit from being
  unguessable and globally unique.

## Timestamps

- Always epoch milliseconds via `Date.now()` (number columns, not ISO strings).
- `createdAt` is set once on insert; `updatedAt` is bumped on every write.
- CRUD helpers may accept an optional `ts?` / `createdAt?` override so tests can
  pin deterministic values; otherwise default to `Date.now()` inside the helper.

## Error handling

- **Reads** (`get*` / `list*`): return `undefined` (or `[]`) on miss. Do **not**
  throw for "not found".
- **Writes**: throw on a broken invariant (immutable/overlay row, missing parent,
  bad precondition). Use a clear `Error` message.
- **Background / fire-and-forget** (telemetry, trigger dispatch, usage counters):
  isolate with `.catch(() => undefined)` so a best-effort write never surfaces an
  error to the caller.

## Capped / ring-buffer tables

Audit-style tables (`backup-history`, `connector-audit`, `inbox-telemetry`,
`automationAuditLog`) are append-and-trim: every write prunes to a `*_CAP`
constant inside a `rw` transaction. Expose the cap via a `__TESTING__` export so
tests can exercise the trim cheaply.

## Tests

- Co-locate `xxx.test.ts` next to the source (no `__tests__/` dirs).
- Standard setup for CRUD modules:
  ```ts
  import "fake-indexeddb/auto"
  // ...
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    await getDb().<table>.clear() // if the seed touches your table
  })
  ```
- Build fixtures with small `make*()` / `build*()` helpers rather than inline
  JSON blobs; query the DB through the module's public helpers.
- **Type-only modules** (`*-types.ts`) still get a co-located test: a runtime
  side-effect `import "./x-types"` (so coverage traces the empty module) plus a
  representative literal value per row shape. See `canvas-types.test.ts`.

## Imports / barrel

- Prefer importing directly from the per-table module
  (`import { getWorkflow } from "@/lib/db/workflows"`).
- `index.ts` re-exports `schema`, a handful of namespaces, and the
  plugin-API-shaped `db` / `messageRepository`. Keep its namespace exports
  alphabetized; do not change exported symbol names (plugin code depends on
  `db`, `messageRepository`, and `DBAgentTrace`).

## Type strictness

Keep these modules `any`-free and `@ts-ignore`-free. Use `Omit` / `Pick` /
`Partial` for create/update input shapes, and `Record<string, unknown>` only for
genuinely free-form blobs (manifests, settings payloads).
