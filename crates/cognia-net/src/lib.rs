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
//! - [`sse_stream`] — streaming `text/event-stream` GET that reports each frame
//!   as it arrives. Backs the Ops Controller live-event command (ADR-0059): an
//!   SSE body never completes, so the buffered `proxy_http_request` escape
//!   hatch delivers nothing at all rather than merely delivering it late.
//! - [`provider_diagnostics`] — connectivity + balance-script diagnostics
//!   for a configured provider, running user-authored scripts in a QuickJS
//!   sandbox with a hard wall-time limit. `app_lib` keeps the three
//!   `provider_diagnostics_*` command shells so this crate stays tauri-free.
//! - [`outbound_pii`] — fail-closed PII detection for text crossing native
//!   network boundaries.

pub mod http_download;
pub mod inbound_policy;
pub mod ndjson_stream;
pub mod outbound_pii;
pub mod provider_diagnostics;
pub mod proxy_config;
pub mod request_cancellation;
pub mod sse_stream;
