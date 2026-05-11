# Phase D — Headless cognia-server skeleton

Status: **AppStore + SQLite + binary skeleton + Dockerfile shipped. Full RPC-handler rewrite to use `AppStore` is the next milestone.**

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

## What still needs landing

The remaining work is _not_ skeleton-shaped — it's the actual content rewrite. Listed in priority order:

1. **RPC-handler rewrite** — `companion_api::rpc::rpc_handler` arms for `session_list`, `message_get_by_session`, `message_send`, `message_update`, `message_delete` currently call `state.desktop_messages_bridge.<method>` which emits a Tauri event and awaits the WebView. They need a parallel headless path that hits `AppStore` directly. The clean shape:

   ```rust
   enum DataPlane {
       TauriBridge(Arc<DesktopMessagesBridge>),
       Direct(Arc<dyn AppStore>),
   }
   ```

   Each RPC arm picks based on the variant. This keeps the desktop flow byte-identical.

2. **SharedState refactor** — `CompanionState::app_handle` is currently `Option<tauri::AppHandle>`. In headless mode it's always `None`, so the parts that emit Tauri events (sidecar streaming → event_bus, audit events) need a `HeadlessEmitter` shim. The simplest is to have `EventBus::publish` get called directly from headless code paths and skip the `app.listen` registration.

3. **Wire the binary's `serve` subcommand**:
   - Build a headless `SharedState` (`app_handle: None`, the SQLite store wrapped in `DataPlane::Direct`, an empty deny list, etc.).
   - Call `server::spawn_server(port, false /* LAN bind */, tls_material, shared)` — already takes `TlsMaterial` after P0.1.
   - Wait on a shutdown signal (Ctrl-C / SIGTERM).

4. **Cred storage in headless mode** — push dispatcher credentials currently live in a process-wide `Lazy` (`PUSH_DISPATCHERS`). For headless, persist them next to the SQLite store under `/data/push-credentials.{fcm,apns}.json` (encrypted with a key derived from `COGNIA_DATA_DIR`'s perms).

5. **CLI ergonomics** — proper `clap`-based argument parsing once the binary takes more than two subcommands. The hand-rolled parser here is intentionally minimal.

## Verification today

- `cargo build --release --bin cognia-server` succeeds.
- `cargo test -p cognia-next companion_api::store::sqlite` covers the store roundtrip.
- `cargo check --tests` clean across the workspace.
- Dockerfile builds (manual smoke — not enforced in CI).

The headless `serve` path is **not** runnable end-to-end yet — pairing works, but RPCs against the running binary would hit unimplemented handlers. That's the next milestone, tracked in this doc.
