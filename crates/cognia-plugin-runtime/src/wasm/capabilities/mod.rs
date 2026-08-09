//! Cognia-specific host imports invoked by the WIT-generated linker.
//!
//! Each module here owns one `cognia:plugin/*` interface from
//! `src-tauri/wit/cognia-plugin.wit`. Implementations consult the per-
//! plugin `CapabilitySet` (carried in `HostState`) and trap the guest with
//! a string error when the call site has not been granted access.
//!
//! Capability strings used as gate keys (v0.2 — every cognia interface except
//! `logger` is now gated):
//!
//! | Capability string    | Interfaces gated                     |
//! |----------------------|--------------------------------------|
//! | `notification`       | `cognia:plugin/notification`         |
//! | `secrets:read`       | `cognia:plugin/secrets.get`          |
//! | `secrets:write`      | `cognia:plugin/secrets.set/delete`   |
//! | `process:spawn`      | `cognia:plugin/process.exec`         |
//! | `shell:execute`      | (alias for `process:spawn`)          |
//! | `clipboard:read`     | `cognia:plugin/clipboard.read-text`  |
//! | `clipboard:write`    | `cognia:plugin/clipboard.write-text` |
//! | `ai:chat`            | `cognia:plugin/ai.generate-text`     |
//! | `extension:workflow` | `cognia:plugin/workflow.emit-event`  |
//!
//! `logger` stays ungated: the host owns the only transport, injects plugin
//! identity, and bounds both arguments, so it exposes no surface to gate.
//!
//! Two gates changed in the v0.2 cutover:
//!
//! - `ai.generate-text` moved from `network:fetch` to `ai:chat`. Raw outbound
//!   HTTP and spending the user's model quota are different consent decisions,
//!   and only the second one passes through the PII redaction gate.
//! - `workflow.emit-event` gained `extension:workflow`. In v0.1 it was ungated
//!   because it only wrote a log line; in v0.2 it genuinely re-enters the
//!   workflow runtime.

pub mod ai;
pub mod clipboard;
pub mod logger;
pub mod notification;
pub mod process;
pub mod secrets;
pub mod workflow;

use super::errors::{coded, WasmErrorCode};
use super::store::HostState;

/// Trap-on-deny helper. Returns `Ok(())` when the plugin has been granted
/// `capability`; otherwise produces the canonical `CAPABILITY_DENIED` error
/// the guest sees.
///
/// Membership is the *granted* set, not the *declared* set — a manifest that
/// asks for a capability the user never approved gets nothing.
pub(crate) fn require(state: &HostState, capability: &str) -> Result<(), String> {
    if state.capabilities.allows(capability) {
        Ok(())
    } else {
        Err(coded(
            WasmErrorCode::CapabilityDenied,
            format!(
                "capability `{capability}` not granted to plugin `{}`",
                state.plugin_id
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::store::test_host_state;
    use super::*;

    fn dummy_state(caps: &[&str]) -> HostState {
        test_host_state("p", caps)
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
