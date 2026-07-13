//! Networking foundation shared across cognia subsystem crates (ADR-0067).
//!
//! Currently just [`proxy_config`] — the process-wide outbound proxy state
//! (`current()` / `set_current()`), the reqwest/env-var/WSS plumbing around
//! it, and local proxy-client detection. `app_lib` keeps a facade module so
//! existing `crate::proxy_config::…` call sites (and the app-side `proxy_*`
//! command shells) are unchanged.

pub mod proxy_config;
