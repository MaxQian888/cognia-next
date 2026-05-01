---
title: Vector DB Hardening Design
date: 2026-05-02
status: draft
---

# Vector DB Hardening Design (Spec A)

## Overview

cognia-next ships a unified `IVectorStore` interface (`lib/vector/store.ts`) with six declared providers — `chroma`, `pinecone`, `qdrant`, `milvus`, `weaviate`, `native`. Five of those work; the sixth (`native`, the Tauri-local "embedded" backend) is non-functional: `NativeVectorStore` calls Tauri commands (`vector_upsert_points`, `vector_search_points`, …) that are not registered in `src-tauri/src/lib.rs`. The `VectorBackend` user-facing setting type (`types/twin/index.ts:123`) explicitly omits `"native"`, so the broken path was never reachable from the UI either.

This spec replaces the stub with a real `sqlite-vec`-backed implementation, adds the missing settings surface, and trims dead code in `lib/ai/rag/` and `lib/vector/`.

This is **Spec A** of a four-spec plan:

- **A. Vector DB hardening** _(this spec)_ — make the native backend real; clean up surface area.
- **B. Unified tool registry + MCP exposure** _(deferred)_ — single source of truth for tools; expose them via standalone stdio MCP servers and an in-app Streamable HTTP server.
- **C. Cognia as ACP server** _(deferred)_ — invert the protocol direction so external editors (Zed, terminal clients) can connect to Cognia's built-in agent.
- **D. Cross-cutting hardening** _(deferred)_ — auth tokens, permission gates, per-connection allow-lists; lifted only if it grows beyond what falls out of B+C.

## Goals

- `provider: "native"` works end to end on Tauri desktop with zero user configuration.
- Native becomes the **default** vector backend for new desktop users; existing users keep their configured backend (no silent migration).
- All consumers that already use `IVectorStore` (Twin ingest, Twin runtime, RAG pipeline, chat hook) work against native without changes beyond a switch case and a type widening.
- Dead code in `lib/ai/rag/rag.ts` and the prefixed re-exports in `lib/vector/index.ts` are removed.
- The readiness contract (`lib/vector/readiness.ts`) reports `operational` for native after a probe — no new readiness machinery, the existing `VectorBackendReadinessVerifier` already supports it.

## Non-goals

- ❌ In-process vector tools registered as agent tools (`vector_search`, `vector_add_document`, …) — **spec B**.
- ❌ Any external MCP/ACP exposure — **spec B / C**.
- ❌ `scrollDocuments`, `exportCollection`, `importCollection`, `getStats` for native — **small follow-up spec** (these are admin paths; not blocking the headline feature).
- ❌ Lazy metadata-index materialisation (sqlite `CREATE INDEX … json_extract(...)`) — **future, gated on measurement**.
- ❌ Multi-process locking (multiple Tauri instances pointing at the same `vectors.sqlite`) — **YAGNI; documented assumption**.

## Constraints

- **Tauri data layout** — store at `<app_data>/cognia/vectors.sqlite`, sibling of the existing `scheduler_metadata.sqlite`. Same `dirs::data_dir()` convention.
- **Rust toolchain** — already pinned ≥1.77.2 for Tauri; `rusqlite 0.32` with `bundled` feature is already in `src-tauri/Cargo.toml`. Only new dependency: `sqlite-vec` crate (version pinned to match `rusqlite 0.32`; manual extension load via `unsafe extern` is the documented fallback if upstream lags).
- **Frontend testing** — `pnpm test:coverage` ≥90% on touched files per `CLAUDE.md`. Co-located `*.test.ts(x)` next to source — no `__tests__/` directory.
- **Rust testing** — in-file `#[cfg(test)] mod tests { ... }` per `CLAUDE.md`. No separate `_test.rs` files for unit tests.
- **Web mode** — `output: "export"` (Next.js static export) is preserved. Native backend is hidden in the settings UI when `!isTauri()`; existing `NativeVectorStore` browser-error path is preserved.

## Reuse points (researched)

| Reuse point                                                                                                                                       | Source                                                                             | Effect on this spec                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `rusqlite 0.32 bundled` already a dep                                                                                                             | `src-tauri/Cargo.toml:52`                                                          | No new SQLite plumbing; only add `sqlite-vec`.                                                                                      |
| `parking_lot::Mutex<Connection>` pattern, WAL + NORMAL pragmas, `execute_batch` migrations                                                        | `src-tauri/src/scheduler/metadata_store.rs`                                        | Mirror byte-for-byte for `vector::db::VectorStore`.                                                                                 |
| `thiserror` error enum + `From<E> for String`                                                                                                     | `src-tauri/src/scheduler/error.rs`                                                 | `VectorError` modeled the same way; commands return `Result<T, String>`.                                                            |
| `tempfile = "3"` already in dev-deps                                                                                                              | `src-tauri/Cargo.toml:88`                                                          | Reuse for native-backend integration tests.                                                                                         |
| `dirs::data_dir().join("cognia").join(...)` path convention                                                                                       | `src-tauri/src/lib.rs:154`                                                         | Same parent dir as scheduler.                                                                                                       |
| Tauri command pattern: `tauri::State<X>` injection, `log::debug/info`, serde return types                                                         | `src-tauri/src/scheduler/commands.rs`                                              | Mirror for `vector::commands::*`.                                                                                                   |
| Readiness contract: `validateVectorConfig` already returns `null` for native when `isTauri()`; `vector-native` already a known `StorageBackendId` | `lib/vector/readiness.ts:93-97`, `lib/storage/persistence/backend-readiness.ts:21` | **Zero readiness code changes needed** — once the underlying store works, readiness reports `operational` after the existing probe. |
| Settings UI lives in Twin tab, not data section                                                                                                   | `components/twin/twin-settings-tab.tsx:20`                                         | Extend `VECTOR_BACKENDS` constant + add a `"native"` branch in `RuntimeConfigCard`. **Do not add a new tab.**                       |
| Twin runtime settings persistence                                                                                                                 | `lib/db/twin-runtime-settings.ts`                                                  | Already Dexie-backed with live observation; native config has no fields beyond the choice itself, so no schema change.              |

## Architecture

### Boundary line

All `sqlite-vec` work lives in Rust. The TS side stays a thin RPC translator. Embeddings continue to be generated on the JS side (`lib/vector/embedding.ts`) regardless of backend — Rust never sees an embedding provider, only `f32[]` vectors.

### Rust module — `src-tauri/src/vector/`

| File          | Mirrors                                                 | Responsibility                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mod.rs`      | `scheduler/mod.rs`                                      | Module barrel; re-exports `VectorStore`, command set, public types.                                                                                                                                                                                                                                                                                                 |
| `db.rs`       | `scheduler/metadata_store.rs`                           | `VectorStore { conn: Mutex<Connection> }`. Bootstraps the file at `<app_data>/cognia/vectors.sqlite`, loads `sqlite_vec::sqlite3_vec_init`, applies migrations. Exposes helper methods used by commands.                                                                                                                                                            |
| `schema.rs`   | (new, follows scheduler's inline `execute_batch` style) | Versioned migrations: `migration_meta(version, applied_at)`, `collections`, `points`. Per-collection `vec_<id>` virtual tables created on `vector_create_collection`.                                                                                                                                                                                               |
| `filters.rs`  | (new)                                                   | Pure function: `(PayloadFilter[], "and"\|"or") -> (WHERE fragment, params)`. No DB access — unit-testable in isolation.                                                                                                                                                                                                                                             |
| `commands.rs` | `scheduler/commands.rs`                                 | Nine Tauri commands matching `IVectorStore` (one per non-optional method that touches storage, plus `vector_delete_all_points` for the optional `deleteAllDocuments`), plus one admin command `vector_reset_store` that the settings "Reset vector store" button calls. Each takes `tauri::State<VectorStore>`, logs at debug/info, returns serde-serialised types. |
| `types.rs`    | `scheduler/types.rs`                                    | `Point`, `Collection`, `SearchHit`, `Filter`, `FilterOp` — `serde::{Serialize, Deserialize}`.                                                                                                                                                                                                                                                                       |
| `error.rs`    | `scheduler/error.rs`                                    | `VectorError` (`thiserror`) + `From<VectorError> for String`.                                                                                                                                                                                                                                                                                                       |

### Rust crate dependencies (additions)

`src-tauri/Cargo.toml` gains exactly one entry:

```toml
sqlite-vec = "<pinned to match rusqlite 0.32>"
```

If the published crate doesn't expose a `rusqlite` integration matching our version, the fallback is to load the extension manually via `unsafe extern "C"` per the upstream README — a documented and well-trodden path. Recorded as a known risk in §"Risks".

### State registration

`src-tauri/src/lib.rs:148-155` gains, alongside `SchedulerState`:

```rust
.manage(vector::VectorStore::new(
    dirs::data_dir().map(|d| d.join("cognia").join("vectors.sqlite")),
)?)
```

The `invoke_handler!` list (`src-tauri/src/lib.rs:156`) gains ten new entries — nine for the `IVectorStore` surface, plus one admin command for "Reset vector store":

```
vector::commands::vector_create_collection,
vector::commands::vector_delete_collection,
vector::commands::vector_list_collections,
vector::commands::vector_get_collection_info,
vector::commands::vector_upsert_points,
vector::commands::vector_delete_points,
vector::commands::vector_delete_all_points,
vector::commands::vector_get_points,
vector::commands::vector_search_points,
vector::commands::vector_reset_store,
```

(`vector_health_check` is **not** added; readiness uses the existing `listCollections` probe through `IVectorStore`, which is enough. `vector_scroll_points` is **not** added either — `scrollDocuments` is in the deferred follow-up; the JS-side `NativeVectorStore.scrollDocuments` will throw `"not yet supported on native backend"` and the `IVectorStore` interface marks it optional, so consumers branch correctly.)

### Frontend changes

| File                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/vector/store.ts` (`NativeVectorStore` class) | Replace stub bodies. Existing payload shapes already match the Rust commands designed here; `searchByEmbeddingWithTotal`'s back-compat branch (legacy array vs tagged response) is preserved.                                                                                                                                                                                                                                                       |
| `lib/vector/index.ts`                             | Drop the prefixed re-exports (`addChromaDocuments`, `queryQdrant`, …). Keep raw client modules importable directly — 4 files in `lib/ai/rag/` already import them that way. Drop the misleading `// For Pinecone client functions, import directly from './pinecone-client' on server-side only` comment.                                                                                                                                           |
| `types/twin/index.ts:123`                         | Widen `VectorBackend` to include `"native"`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `types/twin/index.ts:447`                         | Default `vectorBackend` derived: `"native"` when `isTauri()`, else `"qdrant"`. (Implementation detail: a derived default in `lib/db/twin-runtime-settings.ts` rather than a static constant, so SSR and web builds resolve correctly.)                                                                                                                                                                                                              |
| `hooks/chat/use-claude-chat.ts:334`               | Add a `case "native"` branch building `{ provider: "native", embeddingConfig, embeddingApiKey, native: {} }`.                                                                                                                                                                                                                                                                                                                                       |
| `components/twin/twin-settings-tab.tsx:20`        | Add `"native"` to `VECTOR_BACKENDS`. Native renders as a radio with no host/key form fields, plus an "Open data folder" link (uses the existing Tauri `opener` plugin) and a "Test connection" button calling `verifyVectorBackendReadiness`. Also a "Reset vector store" button (two-step confirm) that calls a new `vector_reset_store` command — see §"Error handling/Schema migration failures". Conditional render — hidden when `!isTauri()`. |
| `lib/ai/rag/rag-runtime.ts:VECTOR_BACKEND_IDS`    | Already has `native: "vector-native"` — **no change**.                                                                                                                                                                                                                                                                                                                                                                                              |
| `lib/vector/readiness.ts`                         | **No change.** `validateVectorConfig` already covers native; `VectorBackendReadinessVerifier` works generically.                                                                                                                                                                                                                                                                                                                                    |

### Cleanup deletions

- `lib/ai/rag/rag.ts` and `lib/ai/rag/rag.test.ts` — only consumer is the test itself.
- The prefixed direct re-exports in `lib/vector/index.ts` (chroma block lines 22-40 and the matching blocks for qdrant, milvus, weaviate). Pinecone inline types remain (they exist to keep `lib/vector/index.ts` browser-importable; comment is rewritten to explain that).
- The stale doc reference `lib/ai/rag/rag-tools.ts:14` → `agent-tools.ts: createRAGSearchTool` (file does not exist).

Cleanup removes ~400 LOC; new code adds ~600 LOC Rust and ~150 LOC TS. Net change ~+350 LOC excluding tests.

## Data flow

### Write path — `addDocuments`

```
JS caller (Twin ingest / RAG pipeline)
 │  documents: VectorDocument[]
 ▼
NativeVectorStore.addDocuments
 │  1. ensureEmbeddings()      — JS-side, only for docs missing .embedding
 │  2. invoke("vector_upsert_points", { collection, points })
 ▼
vector_upsert_points (Rust)
 │  1. lock conn (parking_lot Mutex)
 │  2. BEGIN TRANSACTION
 │  3. for each point:
 │       INSERT OR REPLACE INTO points(id, collection_id, content, payload_json)
 │       INSERT OR REPLACE INTO vec_<col>(rowid, embedding) VALUES (point_rowid, ?)
 │  4. UPDATE collections SET point_count = (SELECT COUNT(*)…), updated_at = ?
 │  5. COMMIT
 │  6. log::debug counts
 ▼
Returns ()
```

`INSERT OR REPLACE` makes upsert semantics idempotent — Rust does not distinguish add vs update. Single transaction means a mid-batch failure rolls back cleanly.

### Search path — `searchDocuments`

```
JS caller
 │  query: string, options: SearchOptions
 ▼
NativeVectorStore.searchDocuments
 │  1. generateEmbedding(query)  — JS-side
 │  2. invoke("vector_search_points", {
 │       collection, vector, top_k, score_threshold,
 │       offset, limit, filters, filter_mode
 │     })
 ▼
vector_search_points (Rust)
 │  1. lock conn
 │  2. filters.rs: build SQL WHERE fragment + bind params
 │  3. SELECT p.id, p.content, p.payload_json,
 │            vec_distance_l2(v.embedding, ?) AS distance
 │     FROM points p
 │     JOIN vec_<col> v ON v.rowid = p.rowid
 │     WHERE p.collection_id = ?
 │       AND (filter fragment if any)
 │       [AND distance <= score_to_distance(threshold) if any]
 │     ORDER BY distance ASC
 │     LIMIT ? OFFSET ?
 │  4. map rows → SearchHit { id, score: 1.0 - distance/2.0, payload }
 │  5. optionally count(*) for `total` (only when caller used the
 │     WithTotal variant, signalled by a flag in the payload)
 ▼
Returns { results, total, offset, limit }
```

**Score convention.** sqlite-vec's `vec_distance_l2` returns L2 distance (lower = better). The unified interface uses `score` ∈ [0,1] (higher = better). All embedding providers in this project produce unit-normalised vectors (OpenAI, Cohere, Google, Mistral all guarantee this), so the conversion `score = 1 - distance/2` keeps results in [0,1]. Documented at the conversion site in `db.rs`.

### Filter mapping coverage — all 14 ops, no client-side post-filter

The unified DSL (`FilterOperation` in `lib/vector/store.ts`) has 14 ops. SQL JSON1 covers all of them via `json_extract`:

| Op                            | SQL fragment                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `equals` / `not_equals`       | `json_extract(payload_json, '$.{k}') = ?` / `<>`                      |
| `greater_than` / `_or_equals` | `json_extract(...) > ?` / `>=`                                        |
| `less_than` / `_or_equals`    | `json_extract(...) < ?` / `<=`                                        |
| `contains` (string)           | `json_extract(...) LIKE '%' \|\| ? \|\| '%'` (params escape `%`/`_`)  |
| `contains` (array)            | `EXISTS (SELECT 1 FROM json_each(json_extract(...)) WHERE value = ?)` |
| `not_contains`                | negation of the above                                                 |
| `starts_with` / `ends_with`   | `LIKE ? \|\| '%'` / `LIKE '%' \|\| ?`                                 |
| `in` / `not_in`               | `json_extract(...) IN (?, ?, ...)` (empty array → `WHERE FALSE`)      |
| `is_null` / `is_not_null`     | `json_extract(...) IS NULL` / `IS NOT NULL`                           |

`filter_mode = "or"` joins clauses with `OR`, default is `AND`. Coverage matches the Pinecone mapping (`store.ts:193-220`) so filter behaviour is consistent across backends. **`requiresPostFilter` is always false for native.**

### Settings → runtime path

```
User toggles backend in twin-settings-tab.tsx
 ▼
saveTwinRuntimeSettings({ ..., storage: { vectorBackend: "native" } })
 ▼
Dexie write fires Dexie observable
 ▼
hooks/chat/use-claude-chat.ts (memo) sees new settings.storage.vectorBackend
 ▼
switch(storage.vectorBackend) — new "native" case builds:
   { provider: "native", embeddingConfig, embeddingApiKey, native: {} }
 ▼
createVectorStore() returns a NativeVectorStore instance
 ▼
applyTwinContext / RAG pipeline / Twin job worker all receive this store
```

No new state machine. The native backend slots into the existing settings → store factory pipeline.

### Startup

`src-tauri/src/lib.rs::run()`:

1. Resolve `dirs::data_dir().join("cognia").join("vectors.sqlite")`.
2. `vector::VectorStore::new(path)?` — opens the file (creates parent dir if needed), loads `sqlite_vec`, runs schema migrations. Synchronous; failure aborts startup with a logged error and registers the store as **disabled** (every command returns `NotAvailable`). Mirrors `SchedulerState::new`.
3. `.manage(vector_store)`.
4. Commands resolve `tauri::State<VectorStore>` and execute under the shared mutex.

If `dirs::data_dir()` returns `None` (extremely rare on supported platforms), the store is registered disabled, same as scheduler.

## Error handling

### Rust error taxonomy — `VectorError`

```rust
#[derive(Error, Debug)]
pub enum VectorError {
    #[error("Vector store not available: {0}")]
    NotAvailable(String),

    #[error("Collection not found: {0}")]
    CollectionNotFound(String),

    #[error("Collection already exists: {0}")]
    CollectionAlreadyExists(String),

    #[error("Dimension mismatch: collection={collection} expected={expected} got={actual}")]
    DimensionMismatch { collection: String, expected: usize, actual: usize },

    #[error("Invalid filter: {0}")]
    InvalidFilter(String),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),

    #[error("SQLite error: {0}")]
    Sqlite(String),

    #[error("Migration failed: {0}")]
    Migration(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(String),
}

impl From<VectorError> for String { ... }
```

Each command returns `Result<T, String>`. The string surfaces to JS via `tauri::invoke`'s rejection. JS lets `lib/vector/readiness.ts:32` (`classifyVectorError`) tag the message — error texts above match its keyword set (`collection`, `missing`, etc.) where appropriate. For native, most failures classify as `roundtrip-failed`, which is the right diagnostic.

### Concurrency

1. **`parking_lot::Mutex<Connection>`** serialises in-process access. SQLite WAL would allow multi-reader + one-writer at the engine level, but the mutex is simpler and the native backend's expected throughput (≤50 ops/sec at peak Twin ingest) is far below the contention point.
2. **Cross-process** — only the Tauri main process writes; sidecars (Claude, A2UI MCP) never do. Documented as an explicit assumption in the ADR. Out of scope for v1.
3. Lock contention surfaces as latency, not errors.

### Dimension mismatch — most likely user-visible error

Scenario: a collection was created with `text-embedding-3-small` (1536 dim) → user switches embedding model to `text-embedding-3-large` (3072 dim) → next upsert fails.

- `collections` row records `dim` at create time.
- `vec_<id>` virtual table is created with that dim.
- `vector_upsert_points` validates `vector.len() == collection.dim` per point and returns `DimensionMismatch` with both numbers.
- Frontend surfaces a toast with a "Recreate collection with new model?" action. The action calls `truncateCollection`; for Twin, the existing source-reindex flow re-embeds; for ad-hoc collections the user re-adds documents manually.

### Schema migration failures

Migrations live in `schema.rs` as `(version, sql_batch)` tuples. `migration_meta` tracks current version; on open, find max applied version and run newer migrations in order, each in its own transaction.

Failure → `VectorError::Migration("v3: <sqlite error>")` → startup logs error, store registered **disabled**, every command returns `NotAvailable`. Data file is **never** auto-truncated. Recovery is manual: user backs up `vectors.sqlite` and reports the issue.

The settings UI offers a "Reset vector store" button (with explicit two-step confirm) for the unlikely case that a user wants to walk away from a corrupt file. Implementation: a tenth Tauri command `vector_reset_store` (registered alongside the other nine) closes the connection, deletes `vectors.sqlite`, `*.sqlite-shm`, `*.sqlite-wal`, then re-runs `VectorStore::new` to recreate an empty file with current schema. Returns `()` on success; the UI prompts the user to refresh once it resolves.

### Disk / corruption / out-of-space

- **Corrupt SQLite file** (rare with WAL): operations fail with `database disk image is malformed`; surfaces as `VectorError::Sqlite(...)`. Same data-safe posture as migration failure.
- **Disk full** during write: transaction rolls back atomically; caller sees `Sqlite("database or disk is full")`; Twin job marks source as failed; user retries after freeing space.
- **File deleted under us** at runtime: returns `disk I/O error`; surfaces as `Sqlite(...)`. Next app restart recreates an empty file. Destructive but recoverable. **No runtime polling or auto-recreate.**

### Web mode

`NativeVectorStore` already checks `isInTauri()` and throws `"Native vector store is only available in Tauri environment"`. Preserved. Settings UI hides the "Native" radio when `!isTauri()`. Mirrors how Twin source upload gates desktop-only paths.

### Embedding errors are unchanged

Embedding generation runs entirely on the JS side via `lib/vector/embedding.ts` regardless of backend. Network errors, rate limits, invalid keys all surface the same way they do for cloud backends today. No native-specific handling.

## Testing

Coverage target ≥90% per `CLAUDE.md`.

### Rust unit tests (in-file `#[cfg(test)] mod tests`)

**`filters.rs` — pure-function tests, no DB.** One test per op (14) + AND/OR composition + edge cases:

- empty filter list → `(None, vec![])`.
- mixed types (string filter against numeric column) → returns the literal SQL fragment unchanged; SQLite handles type coercion at exec time.
- special chars in LIKE values escape correctly (`%`, `_`, `\`).
- `in`/`not_in` with mixed primitive types in array.
- empty array in `in` → `WHERE FALSE`.

**`db.rs` — integration tests using `tempfile::NamedTempFile`.**

- Migrations apply on a fresh file; no-op on a current file.
- `create_collection` with custom dim creates a `vec_<id>` virtual table of that dim.
- `upsert_points` is idempotent (same id twice → 1 row, second wins).
- Transaction rollback on mid-batch failure (force a dimension mismatch on point 3 of 5; assert points 1–2 also rolled back).
- `delete_collection` drops `points` rows AND the `vec_<id>` virtual table; subsequent `list_collections` doesn't list it.
- Search returns ordered hits, applies `LIMIT`, `OFFSET`, threshold.
- Combined search + filter: insert 10 points with varying metadata, query with `category = "x"`, assert only matching subset returned in distance order.
- Concurrent reads under the mutex (4 threads × 100 searches; assert no panic, results internally consistent).

**`commands.rs` — minimal smoke tests.** Most logic lives in `db.rs` and `filters.rs`; commands are thin wrappers. Test: state injection, payload deserialisation matches expected JS shape, error mapping converts `VectorError` to `String`.

### TS unit tests (co-located `xxx.test.ts`)

**`lib/vector/store.test.ts` — extend the existing file.** Currently has a `createVectorStore factory` block that touches native; add:

- `NativeVectorStore.addDocuments` mock-`invoke` test: assert the exact payload shape (`{ collection, points: [{ id, vector, payload }] }`).
- Score-conversion test: stub `invoke` to return distance values; assert `score = 1 - distance/2`.
- `searchByEmbeddingWithTotal`: both legacy-array and tagged-shape responses parse correctly.
- Filter pass-through: caller passes `PayloadFilter[]`, assert it's serialised to `{ key, value, operation }` per the Rust shape.
- Web-mode rejection: when `isInTauri()` is false, every method throws the documented error.

**`lib/vector/readiness.test.ts` — extend.** Add:

- Native + Tauri = success path.
- Native + non-Tauri = `unconfigured` with the right diagnostic code.
- Native dimension-mismatch returned by store → `roundtrip-failed` classification.

### Settings UI test (`twin-settings-tab.test.tsx`)

The tab already has tests; add:

- Native radio renders only when `isTauri()` is true.
- Selecting native saves via `saveTwinRuntimeSettings`.
- "Test connection" calls `verifyVectorBackendReadiness` and renders the result classification.

### Cross-cutting consumer tests

`lib/twin/job-worker.test.ts`, `lib/twin/runtime/apply-twin-context.test.ts`, `lib/ai/rag/rag-pipeline.test.ts` already mock `IVectorStore` — **no changes required** (they're backend-agnostic).

### One integration test — wire-format drift catcher

Single new file `lib/vector/native.integration.test.ts`. Conditionally skipped when `process.env.TAURI_AVAILABLE !== "1"`. Exercises the full JS→Rust roundtrip: create collection, upsert 5 points, search, filter, delete collection. Catches command-shape drift between the two sides. Runs locally on developer machines and on a dedicated desktop CI lane.

### What we do not test

- `sqlite-vec`'s own search quality. Trusted upstream.
- Cross-platform filesystem quirks beyond what `tempfile` covers — relying on `rusqlite` + `dirs`, same posture as scheduler.
- E2E with a running Twin pipeline writing real embeddings — manual smoke during rollout, not CI.

### Coverage verification

`pnpm test:coverage` for TS, `cargo test --manifest-path src-tauri/Cargo.toml -p app_lib` for Rust. CI already runs both. Met when both report ≥90% on touched files.

## Migration & rollout

### No data migration

Nobody has data on the native backend today. Cloud-backend users are unaffected — their `vectorBackend` setting stays put, their data stays put. Change is purely additive.

### Default-backend posture

| User type                                | Current default                                | New default                                                  |
| ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Existing user                            | Whatever they configured                       | **Unchanged.** No silent migration.                          |
| New user (first launch after this lands) | `qdrant` (`DEFAULT_TWIN_RUNTIME_SETTINGS:447`) | **`native`** when `isTauri()`, else `qdrant` (web fallback). |

The desktop default flip is the headline UX win — Twin works zero-config out of the box.

### Phased delivery (within this single spec)

One PR, staged commits:

1. **Rust foundation** — `vector` module, `VectorError`, schema, filters, commands, registration in `lib.rs`. Rust tests green; TS unaffected.
2. **TS wiring** — replace `NativeVectorStore` body, widen `VectorBackend` type, add `case "native"` in chat hook. TS tests green; UI still hides native.
3. **Settings UI delta** — `"native"` in `VECTOR_BACKENDS`, conditional render, "Test connection" wiring, "Reset vector store" button.
4. **Default flip** — new-user default to native on desktop.
5. **Cleanup** — delete `lib/ai/rag/rag.ts`, drop prefixed re-exports, fix stale doc reference.
6. **ADR + docs**.

Each commit is independently green; bisect lands on a meaningful boundary.

### ADR — `docs/content/docs/adr/0004-vector-native-backend.md`

Numbered 0004 to follow 0001/0002/0003. Same template as ADR 0003 (Twin). Captures:

- **Decision**: `sqlite-vec` as the native backend; single-file SQLite at `<app_data>/cognia/vectors.sqlite`.
- **Context**: previous "embedded" promise was non-functional; Twin and RAG users were forced to set up an external service.
- **Alternatives considered**: pure-Rust HNSW (capacity-limited), Qdrant sidecar (binary size + lifecycle), LanceDB (alternative paradigm). Each with rejection reason.
- **Consequences**: native becomes a real first-class backend; new dependency `sqlite-vec`; ~1M point soft ceiling without metadata-index materialiser (planned follow-up).
- **Follow-ups**: lazy index materialisation; `scrollDocuments`/`exportCollection`/`getStats` parity; vector tools in spec B.

### Other docs

- `CLAUDE.md` — one-liner under "Critical Notes": "Native vector store is sqlite-vec backed; data lives at `<app_data>/cognia/vectors.sqlite`. Web mode forces a cloud backend."
- Existing Twin section in `CLAUDE.md` references `VectorBackend` indirectly; no rewrite — the type expansion is backward-compatible.
- `README.md` — one-line update to the supported-backends list **only if** that list is already advertised there. Verify during implementation; do not add new advertising copy.

## Risks

1. **`sqlite-vec` crate version mismatch with `rusqlite 0.32`.** Mitigation: pin a compatible version; fallback is manual extension load via `unsafe extern "C"` (well-trodden upstream pattern). Documented in the ADR.
2. **Windows build pain with bundled SQLite.** Already mitigated — `rusqlite` is already used by scheduler in production with the `bundled` feature; the toolchain works.
3. **Performance ceiling on filter ops without indexes.** Acceptable for v1 (desktop personal-twin scale, ≤100k points). Approach-2 lazy-index materialisation is a documented follow-up if telemetry shows tail latency above target.
4. **Default flip regressing existing users.** Mitigated by the "existing user keeps their config" rule — only new users land on native. The flip is a one-line change; trivial to revert if reports surface.

## Acceptance criteria

- `provider: "native"` works end to end on Tauri desktop: create collection, upsert points, search, filter, delete collection, list collections.
- `verifyVectorBackendReadiness({ provider: "native", ... })` returns `state: "operational"` after probe on Tauri; returns `unconfigured` on web.
- All existing Twin/RAG tests pass unchanged (proves the backend swap is transparent at the `IVectorStore` boundary).
- `pnpm test:coverage` reports ≥90% on `lib/vector/store.ts` (NativeVectorStore class), and on the Rust-side `vector` module.
- New user on desktop: first launch → Twin settings show "Native (Tauri local)" selected; ingesting a source succeeds without any external service configuration.
- Cleanup removes `lib/ai/rag/rag.ts` and the prefixed re-exports; `tsc` and `pnpm lint` stay green.
- ADR 0004 committed.

## Appendix: SQL schema (initial migration v1)

```sql
CREATE TABLE IF NOT EXISTS migration_meta (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL UNIQUE,
    dim                 INTEGER NOT NULL,
    description         TEXT,
    embedding_model     TEXT,
    embedding_provider  TEXT,
    metadata_json       TEXT,
    point_count         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
    rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL,
    collection_id  INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    content        TEXT NOT NULL,
    payload_json   TEXT,
    UNIQUE(collection_id, id)
);

CREATE INDEX IF NOT EXISTS idx_points_collection ON points(collection_id);
CREATE INDEX IF NOT EXISTS idx_points_id ON points(id);
```

Per-collection virtual tables `vec_<id>` are created at `vector_create_collection` time:

```sql
CREATE VIRTUAL TABLE vec_<id> USING vec0(embedding float[<dim>]);
```

PRAGMAs applied on every connection open:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```
