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
//! - `errors`       — the stable `WasmErrorCode` vocabulary.
//! - `services`     — host surfaces (clipboard / notifications / bridge).
//! - `bridge`       — bounded request/response pool to the renderer.
//! - `wit`          — per-version host bindings (`since_v0_2.rs` today).
//!
//! # v0.2.0 is a hard cutover
//!
//! Only `0.2.x` plugins load. There is no v0.1 linker registered and no
//! compatibility shim: a v0.1 binary fails at load with `UPGRADE_REQUIRED`
//! before it is ever compiled. The v0.1 contract and linker are preserved
//! byte-for-byte under `crates/cognia-plugin-runtime/frozen/v0_1/`, outside the
//! module tree so nothing compiles them, held stable by
//! `pnpm lint:frozen-wasm-api` and by [`tests::frozen_v0_1_wit_is_byte_stable`].
//!
//! Test posture follows the project rule: in-file `#[cfg(test)] mod tests`.

// Until the WIT bindgen wiring lands (M1.4), most of the capability /
// runtime surface is reachable only through unit tests. Keep the module
// tree clean of dead-code warnings so the rest of the crate's build stays
// green; the warnings come back automatically once the bindgen-generated
// linker hooks reference these symbols.
#![allow(dead_code)]

pub mod bridge;
pub mod capabilities;
pub mod commands;
pub mod engine;
pub mod errors;
pub mod host;
pub mod installer;
pub mod services;
pub mod store;
pub mod wit;

#[allow(unused_imports)]
pub use host::{WasmPluginHost, WasmPluginState};

/// The semver of the WIT contract the host links against. Plugins compiled
/// against a different MAJOR.MINOR are rejected at load time; PATCH is
/// considered backward-compatible. v0.x bumps minor for breaking changes.
pub const HOST_API_VERSION: &str = "0.2.0";

/// Name of the WASM custom section the build pipeline injects (mirrors
/// Zed's `zed:api-version`). Read by `engine::parse_plugin_api_version`.
pub const API_VERSION_SECTION: &str = "cognia:api-version";

/// **Legacy — v0.1 only.** Stable prefix for a capability declared in the WIT
/// contract but with no real backend.
///
/// No v0.2 host import returns this: every capability the v0.2 contract
/// declares now has a backend, and the cases that used to be stubs are covered
/// by the richer [`errors::WasmErrorCode`] vocabulary instead —
/// `HOST_UNAVAILABLE` for "this build has no backend", `PROVIDER_ERROR` for
/// "the backend failed". Retained because it is still referenced by
/// documentation and by the frozen v0.1 sources, and because removing a
/// declared-stable wire constant is itself a breaking change.
pub const NOT_IMPLEMENTED_CODE: &str = "cognia:not-implemented";

/// Build the legacy v0.1 not-implemented error string. See
/// [`NOT_IMPLEMENTED_CODE`]; v0.2 code should use [`errors::coded`].
pub fn not_implemented_error(capability: &str, detail: &str) -> String {
    format!("{NOT_IMPLEMENTED_CODE}: {capability} — {detail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn host_api_version_is_0_2_0() {
        assert_eq!(HOST_API_VERSION, "0.2.0");
    }

    #[test]
    fn frozen_v0_1_wit_is_byte_stable() {
        // Belt-and-braces alongside `pnpm lint:frozen-wasm-api`, so a
        // contributor who only ever runs `cargo test` still trips the freeze.
        // `include_bytes!` also pins the file's existence at compile time
        // without pulling it into the module tree.
        const FROZEN: &[u8] = include_bytes!("../../frozen/v0_1/cognia-plugin.wit");
        assert_eq!(
            hex::encode(Sha256::digest(FROZEN)),
            "068e972ede012fb98643cfc9f18ba6e93a4592677a22f93dc066631f224b9620",
            "the frozen v0.1 WIT changed — it is a historical artifact and must not be edited"
        );
    }
}
