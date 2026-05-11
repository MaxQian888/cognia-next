# Phase D — Headless cognia-server

Status: **AppStore + SQLite + binary + Dockerfile + RPC-handler rewrite all shipped. `cognia-server serve` now boots a working HTTPS listener that handles every message / session RPC against SQLite.**

This document captures the architectural choices made on the spot for Phase D and outlines what still needs to land before the headless deployment is usable end-to-end.

## What landed

### `companion_api::store` (Rust)

- `AppStore` trait with the methods the RPC handlers will eventually consume:
  - `list_sessions(limit, offset, before)`
  - `get_messages_by_session(session_id, limit, offset)`
  - `create_message(session_id, content, role)`
  - `update_message_content(message_id, content)`
  - `delete_message(message_id)`
  - `upsert_session(id, title, kind)`
- `SqliteAppStore` implementation backed by `rusqlite` (already in the deps tree for the scheduler / vector store). Single-tenant, single-connection serialised with a `parking_lot::Mutex` — appropriate for the single-tenant deployment shape.
- Tests in `companion_api::store::sqlite::tests` cover roundtrip, ordering, pagination, and not-found semantics.

### `src-tauri/src/bin/cognia-server.rs` (new binary)

- Two subcommands today:
  - `cognia-server pair --device-name <name>` — issues a real pair JWT against the same signing-secret keyring the Tauri build uses, prints the `cgnp2|<base64>` payload the mobile QR encodes. Includes the SHA-256 SPKI fingerprint of the headless cert.
  - `cognia-server serve --port <port>` — placeholder that logs the intended state and exits. The full bring-up requires the RPC-handler rewrite below.
- `COGNIA_DATA_DIR` (or the platform default data dir) hosts the SQLite store and TLS cert. Both are stable across restarts.

### `Dockerfile.cognia-server`

Two-stage build (Rust builder → Debian slim runtime), volume-mounted `/data`, port `7890` exposed. Includes a Node runtime layer pre-installed so the Anthropic sidecar can be wired without rebuilding the base image.

## Architectural decisions made on the spot

| Decision                     | Choice                                                      | Why                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage engine               | SQLite via `rusqlite`                                       | Already in the deps tree (`vectors.sqlite`, `scheduler_metadata.sqlite`). Single-tenant; no Postgres complexity needed.                                                                                  |
| V2 vs alternative deployment | "Alternative deployment" (single-tenant server without GUI) | Cloud-canonical with the desktop as a peer client is a much bigger refactor than this milestone budgets. The single-tenant shape covers self-host on a VPS without touching the desktop's existing flow. |
| Concurrency model            | One SQLite connection behind a `Mutex`                      | Single-tenant means low concurrency; a pool would be over-spec.                                                                                                                                          |
| RPC handler dispatch         | Bridges still own the Tauri-mode path                       | The bridges remain for the WebView-backed desktop. Headless mode will dispatch via `AppStore` once handlers are rewritten.                                                                               |
| Sidecar deployment           | Same Node child process pattern Tauri uses                  | Reuses the existing `@anthropic-ai/claude-agent-sdk` integration without surgery.                                                                                                                        |

## RPC-handler rewrite (now landed)

`companion_api::rpc::rpc_handler` arms for `session_list`, `message_get_by_session`, `message_send`, `message_update`, `message_delete` all route through a `DataPlane` abstraction now:

```rust
pub enum DataPlane {
    TauriBridge { bridge: Arc<DesktopMessagesBridge>, app: AppHandle },
    Direct(Arc<dyn AppStore>),
}
```

`DataPlane::pick(state)` picks Direct if a headless store has been installed via `install_headless_store`, falls back to the Tauri bridge otherwise. The desktop flow stays byte-identical; the headless flow short-circuits to SQLite without ever round-tripping to a WebView.

The `cognia-server serve` subcommand:

1. Opens `<COGNIA_DATA_DIR>/cognia-server.sqlite`.
2. Calls `tls::ensure_certificate` to load / generate the self-signed cert.
3. Installs the SqliteAppStore via `install_headless_store`.
4. Publishes the cert fingerprint via `set_tls_fingerprint` (so `/api/v1/whoami` returns it — P0.3).
5. Builds a `SharedState` with `app_handle: None`.
6. Calls `server::spawn_server(port, false /* LAN bind */, tls_material, shared)`.
7. Awaits Ctrl-C, then triggers graceful shutdown.

## What still needs landing

1. **Sidecar integration** — `cognia-server serve` doesn't itself spawn the Anthropic agent SDK Node sidecar. Message CRUD against SQLite works end-to-end; AI replies need the same `src-tauri/src/claude/sidecar.rs` spawn path. The Dockerfile already includes a Node runtime layer for this.
2. **Wave 2 RPCs in headless mode** — `character_*` / `skill_set_enabled` / `plugin_set_enabled` etc. still route through `desktop_writes_bridge`. They return an error in headless mode (no app_handle → bridge can't emit). Either add equivalent AppStore methods, or fail fast with a clearer error envelope.
3. **Push cred storage in headless mode** — `PUSH_DISPATCHERS` is process-wide and in-memory. Persist under `<COGNIA_DATA_DIR>/push-credentials.{fcm,apns}.json`.
4. **CLI ergonomics** — proper `clap`-based argument parsing once the binary takes more than two subcommands.
5. **mDNS + tunnel** — `cognia-server serve` doesn't broadcast mDNS or run cloudflared. Both are desktop-tray-driven today; headless deployments typically sit behind a reverse proxy with a real domain, so neither is strictly required.

## Verification today

- `cargo build --release --bin cognia-server` succeeds.
- `cargo check --tests` clean.
- `companion_api::store::sqlite::tests` (4 cases) cover the SQLite store.
- `companion_api::data_plane::tests` (4 cases) cover the dispatch + Direct round-trip.

The headless `serve` path is now runnable end-to-end for message / session CRUD — `cognia-server serve --port 7890` boots an HTTPS listener that accepts every message-related RPC against SQLite. AI-reply generation is the remaining gap (needs the sidecar).
