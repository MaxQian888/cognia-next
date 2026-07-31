//! Networking foundation shared across cognia subsystem crates (ADR-0067).
//!
//! - [`proxy_config`] — the process-wide outbound proxy state (`current()` /
//!   `set_current()`), the reqwest/env-var/WSS plumbing around it, and local
//!   proxy-client detection. `app_lib` keeps a facade module so existing
//!   `crate::proxy_config::…` call sites (and the app-side `proxy_*` command
//!   shells) are unchanged.
//! - [`http_download`] — streaming download to a file with an incremental
//!   SHA-256 and a hard byte ceiling, shared by the code-server tarball fetch
//!   (`src-tauri`) and the Open VSX `.vsix` fetch (`cognia-plugin-runtime`).
//! - [`ndjson_stream`] — streaming NDJSON POST that reports each parsed line as
//!   it arrives. Backs the Ollama `/api/pull` progress command, the one call
//!   the buffered `proxy_http_request` escape hatch cannot serve.

pub mod http_download;
pub mod ndjson_stream;
pub mod proxy_config;
