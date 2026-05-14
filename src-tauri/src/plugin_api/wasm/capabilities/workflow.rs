//! `cognia:plugin/workflow` host import — emit one trigger event back into
//! the workflow runtime.
//!
//! No capability gate today: every plugin can re-enter the workflow
//! runtime since the same surface is reachable from `ctx.workflow` in TS.
//! Future versions may require `agent:control` for cross-workflow emits.

use super::super::store::HostState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingTriggerEvent {
    pub plugin_id: String,
    pub workflow_id: String,
    pub kind: String,
    pub payload: Vec<u8>,
}

/// Validate then package the inbound emit-event call. The actual
/// `workflow:trigger` Tauri event is fired from `host.rs` so this stays
/// trivially testable.
pub fn prepare(
    state: &HostState,
    workflow_id: String,
    kind: String,
    payload: Vec<u8>,
) -> Result<PendingTriggerEvent, String> {
    if workflow_id.trim().is_empty() {
        return Err("workflow.emit-event: workflow_id is empty".into());
    }
    if kind.trim().is_empty() {
        return Err("workflow.emit-event: kind is empty".into());
    }
    if payload.len() > 4 * 1024 * 1024 {
        return Err("workflow.emit-event: payload exceeds 4 MiB".into());
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
    use super::super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn st(id: &str) -> HostState {
        HostState {
            plugin_id: id.into(),
            capabilities: CapabilitySet::default(),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn prepare_rejects_blank_inputs() {
        let s = st("demo");
        assert!(prepare(&s, "".into(), "kind".into(), vec![]).is_err());
        assert!(prepare(&s, "wf".into(), "".into(), vec![]).is_err());
    }

    #[test]
    fn prepare_rejects_oversize_payload() {
        let s = st("demo");
        let big = vec![0u8; 5 * 1024 * 1024];
        let err = prepare(&s, "wf".into(), "k".into(), big).unwrap_err();
        assert!(err.contains("exceeds"));
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
