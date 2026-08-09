//! `cognia:plugin/workflow` host import — emit one trigger event back into
//! the workflow runtime.
//!
//! Requires `extension:workflow` as of v0.2. v0.1 left this ungated because the
//! host only wrote a log line — there was nothing to authorize. v0.2 genuinely
//! re-enters the workflow runtime through the renderer bridge, so an ungated
//! version would let any WASM plugin fire triggers in any workflow without the
//! user ever approving it. The hard cutover was the moment to add the gate at
//! zero migration cost: every plugin has to be rebuilt regardless.

use super::super::errors::{coded, WasmErrorCode};
use super::super::store::HostState;
use super::require;

/// Generic payload cap for one emitted event.
pub const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTriggerEvent {
    pub plugin_id: String,
    pub workflow_id: String,
    pub kind: String,
    pub payload: Vec<u8>,
}

/// Check the capability, validate, then package the inbound emit-event call.
///
/// Ordering matters and is asserted by tests: the capability gate runs before
/// any validation, so a denied plugin learns nothing about which inputs would
/// have been acceptable, and no request state is allocated on its behalf.
pub fn prepare(
    state: &HostState,
    workflow_id: String,
    kind: String,
    payload: Vec<u8>,
) -> Result<PendingTriggerEvent, String> {
    require(state, "extension:workflow")?;
    if workflow_id.trim().is_empty() {
        return Err(coded(
            WasmErrorCode::InvalidRequest,
            "workflow.emit-event: workflow_id is empty",
        ));
    }
    if kind.trim().is_empty() {
        return Err(coded(
            WasmErrorCode::InvalidRequest,
            "workflow.emit-event: kind is empty",
        ));
    }
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(coded(
            WasmErrorCode::PayloadTooLarge,
            format!(
                "workflow.emit-event: payload is {} bytes, over the {MAX_PAYLOAD_BYTES} byte limit",
                payload.len()
            ),
        ));
    }
    Ok(PendingTriggerEvent {
        plugin_id: state.plugin_id.clone(),
        workflow_id,
        kind,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::super::super::store::test_host_state;
    use super::*;

    fn st(id: &str) -> HostState {
        test_host_state(id, &["extension:workflow"])
    }

    #[test]
    fn prepare_requires_the_workflow_capability() {
        let ungated = test_host_state("demo", &[]);
        let err = prepare(&ungated, "wf".into(), "k".into(), vec![]).unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
        assert!(err.contains("extension:workflow"));
    }

    #[test]
    fn capability_denial_precedes_validation() {
        // A denied plugin must not be able to probe which inputs are valid.
        let ungated = test_host_state("demo", &[]);
        let err = prepare(&ungated, "".into(), "".into(), vec![]).unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
    }

    #[test]
    fn prepare_rejects_blank_inputs() {
        let s = st("demo");
        let missing_id = prepare(&s, "".into(), "kind".into(), vec![]).unwrap_err();
        assert!(missing_id.starts_with("INVALID_REQUEST: "));
        let missing_kind = prepare(&s, "wf".into(), "".into(), vec![]).unwrap_err();
        assert!(missing_kind.starts_with("INVALID_REQUEST: "));
    }

    #[test]
    fn prepare_rejects_oversize_payload() {
        let s = st("demo");
        let big = vec![0u8; MAX_PAYLOAD_BYTES + 1];
        let err = prepare(&s, "wf".into(), "k".into(), big).unwrap_err();
        assert!(err.starts_with("PAYLOAD_TOO_LARGE: "));
        // Exactly at the cap is fine.
        assert!(prepare(&s, "wf".into(), "k".into(), vec![0u8; MAX_PAYLOAD_BYTES]).is_ok());
    }

    #[test]
    fn prepare_packages_pending_event() {
        let s = st("demo");
        let ev = prepare(&s, "wf-1".into(), "tick".into(), vec![1, 2, 3]).unwrap();
        assert_eq!(ev.plugin_id, "demo");
        assert_eq!(ev.workflow_id, "wf-1");
        assert_eq!(ev.kind, "tick");
        assert_eq!(ev.payload, vec![1, 2, 3]);
    }
}
