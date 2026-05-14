//! Cognia-specific host imports invoked by the WIT-generated linker.
//!
//! Each module here owns one `cognia:plugin/*` interface from
//! `src-tauri/wit/cognia-plugin.wit`. Implementations consult the per-
//! plugin `CapabilitySet` (carried in `HostState`) and trap the guest with
//! a string error when the call site has not been granted access.
//!
//! Capability strings used as gate keys:
//!
//! | Capability string   | Interfaces gated                   |
//! |---------------------|------------------------------------|
//! | `notification`      | `cognia:plugin/notification`       |
//! | `secrets:read`      | `cognia:plugin/secrets.get`        |
//! | `secrets:write`     | `cognia:plugin/secrets.set/delete` |
//! | `process:spawn`     | `cognia:plugin/process.exec`       |
//! | `shell:execute`     | (alias for `process:spawn`)        |
//! | `clipboard:read`    | `cognia:plugin/clipboard.read-text`|
//! | `clipboard:write`   | `cognia:plugin/clipboard.write-text`|
//!
//! Logger / workflow / AI capabilities are silently allowed today — they
//! are pure-IPC routes that don't expose new attack surface beyond what
//! plugins already get via the existing TS plugin context.

pub mod ai;
pub mod clipboard;
pub mod logger;
pub mod notification;
pub mod process;
pub mod secrets;
pub mod workflow;

use super::store::HostState;

/// Trap-on-deny helper. Returns `Ok(())` when the plugin has been granted
/// `capability`; otherwise produces the canonical "capability denied"
/// error message the guest sees.
pub(crate) fn require(state: &HostState, capability: &str) -> Result<(), String> {
    if state.capabilities.allows(capability) {
        Ok(())
    } else {
        Err(format!(
            "capability `{capability}` not granted to plugin `{}`",
            state.plugin_id
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn dummy_state(caps: &[&str]) -> HostState {
        HostState {
            plugin_id: "p".into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn require_grants_pass_through() {
        let st = dummy_state(&["notification"]);
        assert!(require(&st, "notification").is_ok());
    }

    #[test]
    fn require_denies_with_useful_message() {
        let st = dummy_state(&[]);
        let err = require(&st, "process:spawn").unwrap_err();
        assert!(err.contains("process:spawn"));
        assert!(err.contains("`p`"));
    }
}
