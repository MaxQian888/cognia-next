//! WASM Component Model plugin host (ADR 0013).
//!
//! Loads `type === "wasm"` plugins compiled against the cognia WIT contract
//! (see `src-tauri/wit/cognia-plugin.wit`). Each plugin instance runs in
//! its own wasmtime `Store<HostState>` with:
//!
//! - capability-gated host imports (see `capabilities/`),
//! - WASI Preview 2 (filesystem preopens to the plugin's data dir,
//!   clocks/random/io/cli),
//! - per-store linear-memory + table-element caps from `StoreLimits`,
//! - cooperative interruption via `Config::epoch_interruption(true)` and a
//!   shared 100 ms epoch ticker spun up by `init_engine`,
//! - a 30 s wall-clock timeout around every guest call (override per plugin
//!   via `manifest.wasm.callTimeoutMs`).
//!
//! Module layout
//!
//! - `engine`       — global `Engine` + ticker singleton.
//! - `store`        — per-plugin `HostState` + builders.
//! - `host`         — `WasmPluginHost` (TS-facing facade) + Tauri commands.
//! - `capabilities` — one file per cognia: import group.
//! - `wit`          — per-version host bindings (`since_v0_1.rs` today).
//!
//! Test posture follows the project rule: in-file `#[cfg(test)] mod tests`.

// Until the WIT bindgen wiring lands (M1.4), most of the capability /
// runtime surface is reachable only through unit tests. Keep the module
// tree clean of dead-code warnings so the rest of the crate's build stays
// green; the warnings come back automatically once the bindgen-generated
// linker hooks reference these symbols.
#![allow(dead_code)]

pub mod capabilities;
pub mod commands;
pub mod engine;
pub mod host;
pub mod installer;
pub mod store;
pub mod wit;

#[allow(unused_imports)]
pub use host::{WasmPluginHost, WasmPluginState};

/// The semver of the WIT contract the host links against. Plugins compiled
/// against a different MAJOR.MINOR are rejected at load time; PATCH is
/// considered backward-compatible. v0.x bumps minor for breaking changes.
pub const HOST_API_VERSION: &str = "0.1.0";

/// Name of the WASM custom section the build pipeline injects (mirrors
/// Zed's `zed:api-version`). Read by `engine::parse_plugin_api_version`.
pub const API_VERSION_SECTION: &str = "cognia:api-version";
