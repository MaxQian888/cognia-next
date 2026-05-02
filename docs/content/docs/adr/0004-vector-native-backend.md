---
title: ADR-0004 — sqlite-vec Native Vector Backend
description: Replace the non-functional NativeVectorStore stub with a real sqlite-vec-backed implementation; make native the default for new desktop users.
---

# sqlite-vec Native Vector Backend

| Status   | Accepted                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| Date     | 2026-05-02                                                                       |
| Replaces | The non-functional `NativeVectorStore` stub in `lib/vector/store.ts` (commit 1). |

## Context

cognia-next ships a unified `IVectorStore` interface (`lib/vector/store.ts`) with
six declared providers — `chroma`, `pinecone`, `qdrant`, `milvus`, `weaviate`,
and `native`. Five of those providers work; the sixth (`native`, the Tauri-local
"embedded" backend) was non-functional: `NativeVectorStore` called Tauri commands
(`vector_upsert_points`, `vector_search_points`, …) that were never registered in
`src-tauri/src/lib.rs`. The `VectorBackend` user-facing setting type
(`types/twin/index.ts:123`) explicitly omitted `"native"`, so the broken path was
also unreachable from the UI.

Twin and RAG users were therefore forced to set up an external service (Qdrant,
Pinecone, Chroma server, Milvus, or Weaviate) before any vector workflow could run
on the desktop. This directly contradicted the desktop app's offline-friendly value
proposition — a user should be able to ingest documents into their Twin and run RAG
without any external infrastructure.

This decision is **Spec A** of a four-spec "superpowers" plan:

- **A. Vector DB hardening** _(this spec)_ — make the native backend real; clean up surface area.
- **B. Unified tool registry + MCP exposure** _(deferred)_ — single source of truth for
  tools; expose them via standalone stdio MCP servers and an in-app Streamable HTTP server.
- **C. Cognia as ACP server** _(deferred)_ — invert the protocol direction so external editors
  (Zed, terminal clients) can connect to Cognia's built-in agent.
- **D. Cross-cutting hardening** _(deferred)_ — auth tokens, permission gates, per-connection
  allow-lists; lifted only if it grows beyond what falls out of B+C.

## Decisions

### 1. sqlite-vec as the native vector store engine

We implement the native backend using
[`sqlite-vec`](https://github.com/asg017/sqlite-vec), a SQLite extension that adds
vector similarity search via virtual tables (`vec0`). The database lives at a
single file: `<app_data>/cognia/vectors.sqlite` — a sibling of the existing
`scheduler_metadata.sqlite`.

`rusqlite 0.32` with the `bundled` feature is already a production dependency of
the scheduler subsystem; only `sqlite-vec` is a new crate entry.

### 2. IVectorStore interface contract is preserved

The existing `IVectorStore` interface and all its consumers (Twin ingest,
Twin runtime, RAG pipeline, chat hook) work against native without any behavioural
changes beyond a `case "native"` branch in the store factory switch and a type
widening in `VectorBackend`. Consumers are backend-agnostic by design.

### 3. Eleven Tauri commands implement the interface surface

The Rust module `src-tauri/src/vector/` registers eleven commands in
`src-tauri/src/lib.rs`:

```
vector_create_collection
vector_delete_collection
vector_list_collections
vector_get_collection
vector_upsert_points
vector_delete_points
vector_delete_all_points
vector_get_points
vector_search_points
vector_truncate_collection
vector_reset_store          (admin — "Reset vector store" button)
```

Admin-path methods (`scrollDocuments`, `exportCollection`, `importCollection`,
`getStats`) are deferred; the JS-side `NativeVectorStore` stubs throw
`"not yet supported on native backend"`, which is the correct behaviour for an
optional `IVectorStore` method.

### 4. Score convention: `score = 1 − distance / 2`

`sqlite-vec`'s `vec_distance_l2` returns L2 distance (lower = better). The unified
interface uses `score ∈ [0, 1]` (higher = better). All embedding providers in
this project produce unit-normalised vectors (OpenAI, Cohere, Google, Mistral),
so the identity `score = 1 − distance / 2` keeps results in `[0, 1]`. The
conversion is documented inline in `db.rs`.

### 5. Native becomes the default for new desktop users

`lib/db/twin-runtime-settings.ts`'s defensive merge layer sets
`vectorBackend: isTauri() ? "native" : "qdrant"` for any user whose persisted
settings do not yet contain a `vectorBackend` key. Existing users keep their
configured backend — there is no silent migration.

### 6. Settings UI hidden on web

The "Native (Tauri local)" radio in the Twin settings tab is conditionally
rendered only when `isTauri()` is true. `NativeVectorStore` already checks
`isTauri()` and throws `"Native vector store is only available in Tauri
environment"` on the web path — this guard is preserved.

### 7. Dead code removed in commit 5

`lib/ai/rag/rag.ts` (whose only consumer was its own test) and the prefixed
re-exports in `lib/vector/index.ts` (`addChromaDocuments`, `queryQdrant`, …) are
deleted. The stale doc comment in `lib/ai/rag/rag-tools.ts:14` referencing a
non-existent `agent-tools.ts` is fixed. Net change: ~400 LOC removed, ~600 LOC
Rust added, ~150 LOC TS added.

## Data model

The Rust module `src-tauri/src/vector/` follows the same layered structure as
the scheduler subsystem (`src-tauri/src/scheduler/`):

| File          | Responsibility                                                              |
| ------------- | --------------------------------------------------------------------------- |
| `mod.rs`      | Module barrel; re-exports `VectorStore`, commands, public types.            |
| `db.rs`       | `VectorStore { conn: Mutex<Connection> }`. Opens/creates `vectors.sqlite`,  |
|               | loads `sqlite_vec`, runs versioned migrations.                              |
| `schema.rs`   | Versioned migrations: `migration_meta`, `collections`, `points` tables;     |
|               | per-collection `vec_<id>` virtual tables.                                   |
| `filters.rs`  | Pure function: `(PayloadFilter[], mode) → (WHERE fragment, params)`. All 14 |
|               | `FilterOperation` variants covered via SQL JSON1 `json_extract`.            |
| `commands.rs` | Eleven Tauri commands matching `IVectorStore`; thin wrappers over `db.rs`.  |
| `types.rs`    | `Point`, `Collection`, `SearchHit`, `Filter`, `FilterOp` (serde).           |
| `error.rs`    | `VectorError` (`thiserror`) + `From<VectorError> for String`.               |

Initial schema (migration v1):

```sql
-- tracking table
CREATE TABLE IF NOT EXISTS migration_meta (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

-- collection registry
CREATE TABLE IF NOT EXISTS collections (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    dim                INTEGER NOT NULL,
    description        TEXT,
    embedding_model    TEXT,
    embedding_provider TEXT,
    metadata_json      TEXT,
    point_count        INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

-- dense points
CREATE TABLE IF NOT EXISTS points (
    rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL,
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    payload_json  TEXT,
    UNIQUE(collection_id, id)
);
```

Per-collection vector tables are created at collection-create time:

```sql
CREATE VIRTUAL TABLE vec_<id> USING vec0(embedding float[<dim>]);
```

PRAGMAs applied on every connection open: `WAL`, `synchronous = NORMAL`,
`foreign_keys = ON`.

## Alternatives considered

### Pure-Rust HNSW (`hnsw_rs`, `instant-distance`)

These crates provide fast approximate nearest-neighbour search but are
in-memory only by default. A parallel persistence layer (serde + file I/O, or a
separate SQLite table for the graph) would need to be written and maintained.
`sqlite-vec` provides both indexing and persistence in a single storage engine
that is already in our toolchain (`rusqlite 0.32 bundled`). Rejected.

### Bundled Qdrant sidecar

Bundling a Qdrant binary adds meaningful installer size and introduces a sidecar
process whose lifecycle (start, crash recovery, version upgrades) the app would
need to own. The expected scale for a personal-twin desktop workflow is well below
100k points — Qdrant's horizontal-scaling story is irrelevant here, and its
single-node overhead is unjustified. Rejected.

### LanceDB

LanceDB is an alternative embedded vector database with a Rust core. It offers a
different storage paradigm (columnar, Arrow-native) and has a growing Rust
integration. However, it represents a larger dependency surface, a less mature
Rust API, and a fundamentally different query model from the SQL JSON1 filter DSL
we've already designed for `sqlite-vec`. Rejected on weight and maturity grounds.

## Consequences

**Positive**

- Native is a real first-class backend; Twin works zero-config out of the box on
  the desktop. No external service required for the headline use case.
- The `IVectorStore` abstraction holds: all existing consumers work without
  modification.
- Dead code in `lib/ai/rag/rag.ts` and the prefixed re-exports in
  `lib/vector/index.ts` are removed, reducing surface area (commit 5).
- Readiness machinery requires zero changes: `validateVectorConfig` already covers
  native when `isTauri()`, and `VectorBackendReadinessVerifier` works generically.

**Trade-offs and risks**

- New Rust dependency: `sqlite-vec`. Pinned to match `rusqlite 0.32`. If upstream
  API changes, the documented fallback is loading the extension manually via
  `unsafe extern "C"` — a well-trodden path per the upstream README.
- Soft ceiling at approximately 1M points on JSON1 metadata filtering without lazy
  index materialisation. Personal-twin scale (≤100k points) is comfortably under
  this ceiling for v1; a `CREATE INDEX … json_extract(…)` materialisation pass is
  a documented follow-up, gated on telemetry.
- Cross-process concurrency assumption: only the Tauri main process writes to
  `vectors.sqlite`. Multi-process write contention (e.g., two running Tauri
  instances pointing at the same data dir) is explicitly YAGNI for v1 and is
  documented in the spec's §Concurrency.
- Windows build uses `rusqlite bundled` — already validated by the scheduler
  subsystem; no new build risk.

## Follow-ups

The following items are explicitly deferred and tracked in the spec:

1. **Admin-method parity for native** — `scrollDocuments`, `exportCollection`,
   `importCollection`, `getStats`, `countDocuments`, `renameCollection`. These
   currently throw `"not yet supported"` on the native backend. A small follow-up
   spec will add the Tauri commands and JS wiring.

2. **Lazy metadata-index materialisation** — `CREATE INDEX … json_extract(…)` for
   frequently filtered fields. Deferred; gated on measuring tail latency against
   real-world Twin datasets.

3. **Vector tools as in-process agent tools** — registering `vector_search`,
   `vector_add_document`, etc. as agent tools usable inside a conversation. Spec B.

4. **ACP exposure of Cognia's built-in agent** — inverting the protocol direction
   so external editors can connect to Cognia. Spec C.

## See also

- `src-tauri/src/vector/db.rs` — VectorStore struct, schema bootstrap, sqlite-vec integration
- `src-tauri/src/vector/filters.rs` — SQL filter builder (all 14 `FilterOperation` ops)
- `src-tauri/src/vector/commands.rs` — eleven Tauri commands
- `lib/vector/store.ts` — `NativeVectorStore` JS implementation
- `types/twin/index.ts` — `VectorBackend` type (widened to include `"native"`)
- `lib/db/twin-runtime-settings.ts` — defensive default: `"native"` when `isTauri()`
- `components/twin/twin-settings-tab.tsx` — settings UI (native radio + reset button)
- `docs/superpowers/specs/2026-05-02-vector-db-hardening-design.md` — full Spec A
