---
title: ADR-0023 — Vector cloud backends in Rust
---

# Status

Accepted — 2026-05-17.

# Context

Pre-migration, `lib/vector/store.ts` shipped TypeScript implementations of
five cloud vector providers (Chroma, Pinecone, Qdrant, Milvus, Weaviate),
each importing the upstream npm SDK and instantiating it inside the
Tauri webview. The five SDKs (`@pinecone-database/pinecone`,
`@qdrant/js-client-rest`, `chromadb`, `@zilliz/milvus2-sdk-node`,
`weaviate-client`) plus their gRPC / Parquet transitive dependencies
were aliased to an empty stub via `next.config.ts` to keep the static
export bundle clean. The unintended consequence: selecting any cloud
provider in production failed at runtime — `new ChromaClient()`
resolved against `module.exports = {}` and threw `... is not a
constructor`.

The cloud paths were effectively dead code: shipped, included in
`package.json`, surfaced in the settings UI, but unable to execute.

# Decision

Port the five cloud backend implementations from TypeScript to Rust
under `src-tauri/src/vector/backends/`. Use one shared async trait
(`VectorBackend`) so each backend exposes the same operation surface;
dispatch through a per-`configId` `Arc<dyn VectorBackend>` cache
(`VectorRegistry`) constructed lazily from OS-keyring-stored credentials.

The native sqlite-vec backend continues to use its existing
`VectorState`/`vector_*` command surface — there is no functional benefit
to running the existing sync sqlite path through the async trait in
this iteration.

# Architecture

```
TypeScript                        |  Rust
                                  |
CloudVectorStore (shared)         |  VectorRegistry
  ├ ChromaVectorStore             |    └ resolve(provider, configId)
  ├ PineconeVectorStore           |         ↓
  ├ QdrantVectorStore             |    Arc<dyn VectorBackend>
  ├ MilvusVectorStore             |         ├ PineconeBackend (reqwest)
  └ WeaviateVectorStore           |         ├ QdrantBackend (qdrant-client)
        │                         |         ├ ChromaBackend  (reqwest)
        ▼                         |         ├ MilvusBackend  (reqwest)
   vectorCloudInvoke              |         └ WeaviateBackend(reqwest)
        │                         |
        ▼ Tauri invoke()          |  credentials::{save, load, delete}
   vector_cloud_*                 |         ↓
                                  |  keyring_secrets   (OS keyring)
                                  |  com.cognia.vector.<provider>/v1
                                  |    account = configId
                                  |    value   = JSON(VectorCredentials)
```

## Component breakdown

- **`VectorBackend` trait** (`src-tauri/src/vector/backend.rs`):
  12 async methods — `create_collection`, `delete_collection`,
  `list_collections`, `get_collection`, `upsert`, `delete_points`,
  `get_points`, `truncate`, `query`, `scroll`, `count`, `health_check`.

- **`VectorRegistry`** (`src-tauri/src/vector/registry.rs`):
  `RwLock<HashMap<String, Arc<dyn VectorBackend>>>` keyed by `configId`.
  `resolve()` lazily reads credentials from the keyring and instantiates
  the backend on first access. `provider = "native"` is rejected — the
  native sqlite path stays in `VectorState`.

- **Credentials** (`src-tauri/src/vector/credentials.rs`):
  tagged-union `VectorCredentials` (one variant per cloud provider),
  serialised as JSON, stored in the OS keyring under namespace
  `vector.<provider>` keyed by `configId`. Wraps the existing
  `crate::keyring_secrets` module.

- **Tauri command surface** (`src-tauri/src/vector/commands.rs`):
  14 new `vector_cloud_*` commands. All cross-provider commands take
  `(provider, configId)` plus operation arguments. Naming intentionally
  avoids collision with the 17 legacy native `vector_*` commands so the
  rollout is purely additive on the Rust side.

- **TS invoke layer** (`lib/vector/invoke.ts`):
  typed wrappers (`vectorCloudInvoke.*`) per command. Wire shape uses
  snake_case (matches Rust serde default); TS callers pass camelCase to
  this module and the wrappers translate.

- **TS cloud stores** (`lib/vector/store.ts`): one `CloudVectorStore`
  base class + 5 three-line subclasses. The base owns the JS-side
  cross-cutting concerns the Rust trait doesn't handle:
  - Embedding generation (calls OpenAI/Google/Cohere/Mistral directly)
  - `applyUnifiedPostFilters` for provider-agnostic substring / null
    operators the Rust translators drop
  - `applyThresholdAndPagination` for score cutoff + offset slicing

## Trade-offs

| Aspect                 | Pre-migration                            | Post-migration                                           |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Cloud provider runtime | Dead (SDKs aliased to `{}`)              | Real (Rust HTTP/gRPC)                                    |
| Bundle weight          | Heavy server-side deps shipped+aliased   | 5 SDKs + grpc/parquet transitives removed                |
| Credentials            | Cleartext in IndexedDB (Zustand persist) | OS keyring, addressed by `configId`                      |
| Filter expressiveness  | All ops handled JS-side per provider     | Comparison ops in Rust, substring/null in JS post-filter |
| Web/SSR deploy         | Cloud broken (alias stubs)               | Cloud unavailable (no Tauri commands in web)             |

The web/SSR loss is acceptable: the project ships Tauri-only for cloud
vector use cases today.

## Provider-specific notes

- **Pinecone** — REST against `https://api.pinecone.io/indexes` for
  control-plane, lazy-cached host for data-plane (`/vectors/upsert`,
  `/query`, `/vectors/delete`, `/describe_index_stats`).
- **Qdrant** — Official `qdrant-client = "1.18"` crate, gRPC mode.
  Port 6334 is the default gRPC port; users must configure URLs
  accordingly.
- **Chroma** — REST against `/api/v1/collections/*`; `create_collection`
  uses `get_or_create: true` for idempotency.
- **Milvus** — Deliberately uses the HTTP `/v2/vectordb/*` API rather
  than `milvus-sdk-rust 0.1.0`. The SDK was confirmed broken
  (`build-script-build` panics without a local `protoc` install).
  The HTTP path keeps Milvus uniform with the other reqwest backends.
- **Weaviate** — REST for schema (`/v1/schema`) + batch upsert
  (`/v1/batch/objects`), GraphQL for query (`/v1/graphql`).

## Migration path

A one-shot startup hook (`lib/vector/migrations/credential-migration.ts`)
reads the pre-ADR-0023 Zustand persisted blob, writes the cleartext
credentials into the keyring under `migrated-<provider>` configIds,
strips the cleartext fields from localStorage, and sets the
`vector-credentials-migrated` flag. Idempotent — second runs are
no-ops.

Existing users see no functional change; their cloud configs become
keyring-backed transparently on first launch after the upgrade.

# Consequences

**Positive:**

- Cloud provider selection now actually works in Tauri production
  builds.
- Bundle shrinks (5 npm SDKs + their gRPC/Parquet transitives removed).
- Credentials no longer sit in plaintext IndexedDB.
- New cloud providers can be added by implementing a single trait, with
  no JS-side changes beyond a credential variant.

**Negative / Deferred:**

- Web/SSR deploy of the same Next.js app loses cloud vector support.
  Acceptable — Tauri is the primary surface.
- The 8 advanced native-only commands (`export_collection`,
  `import_collection`, `rename_collection`, `truncate_collection`,
  `delete_all_points`, `get_stats`, `reset_store`, `get_store_size`)
  remain native-only. Adding them to the trait is a future PR if
  cloud equivalents become useful.
- Filter ops the Rust translators drop (substring / null-check on
  Pinecone/Qdrant; `in/not_in` on Milvus/Weaviate) fall back to JS
  post-filter. For very large result sets this means over-fetching.

# Affected modules

- New Rust: `vector/{backend,credentials,registry,backends/*}.rs`
- Modified Rust: `vector/{types,commands,mod,error}.rs`,
  `lib.rs` (handler registration, state management),
  `keyring_secrets.rs` (wired into lib.rs)
- New TS: `lib/vector/invoke.ts`, `lib/vector/migrations/`
- Rewritten TS: `lib/vector/store.ts` (2582 → 1400 lines)
- Modified TS: `lib/vector/readiness.ts`,
  `lib/plugin/api/vector-api.ts`, `lib/ai/rag/{citation-formatter,context-manager}.ts`,
  `stores/vector/vector-store.ts`
- Deleted TS: `lib/vector/{chroma,pinecone,qdrant,milvus,weaviate}-client.ts`
  (+ tests, ~4700 lines)
- Config: `next.config.ts` SDK aliases removed; `package.json` SDK
  dependencies removed.

# Verification

- `cargo check --no-default-features`: 0 errors.
- `cargo test --lib vector::*`: 24 tests (filter translators, credential
  serde, registry, wiremock-mocked HTTP backends).
  _Note_: the Windows host's test executable currently fails to load
  (pre-existing 0xc0000139 DLL issue, unrelated to this migration).
- `pnpm typecheck`: clean (the 6 pre-existing
  `components/settings/companion/webrtc-card.test.tsx` errors are
  unrelated work-in-progress).
- `pnpm test -- lib/vector/`: vector module tests pass.
- `pnpm build`: succeeds. Bundle inspection confirms no `PineconeClient`
  / `ChromaClient` / `MilvusClient` class symbols leak into
  `out/_next/static/chunks/`.
