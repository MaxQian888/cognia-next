//! Shared types for the workflow subsystem.
//!
//! These mirror the IPC contract documented in `lib/workflow/runtime/tauri-bridge.ts`
//! and the TypeScript definitions in `types/workflow/visual.ts`. Field names are
//! kept identical (camelCase via serde rename_all) so the JSON bridge has zero
//! impedance.

use serde::{Deserialize, Serialize};

/// Sub-set of the workflow node-kind union that Rust cares about — namely the
/// trigger kinds. Other kinds (action / ai / flow / data / io / annotation) are
/// passed through as opaque strings since the Rust side never inspects them.
#[allow(dead_code)]
pub const TRIGGER_KINDS: &[&str] = &[
    "trigger.manual",
    "trigger.cron",
    "trigger.connector.inbound",
    "trigger.chat.message",
    "trigger.webhook",
    "trigger.integration.event",
    "trigger.team",
    "trigger.goal.completed",
    "trigger.desktop.event",
    "trigger.terminal.command",
    "trigger.pet.event",
    "trigger.workflow.completed",
];

/// Run lifecycle states. Mirrors `RunStatus` in `types/workflow/visual.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Waiting,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Paused => "paused",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => Self::Pending,
            "running" => Self::Running,
            "waiting" => Self::Waiting,
            "paused" => Self::Paused,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    /// Whether this state means the run is no longer in flight. Resumed runs
    /// are filtered against this set on app boot.
    #[allow(dead_code)]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

/// Trigger binding — adapter / session / conversation / character ids the
/// trigger filters on. Mirrors `WorkflowTriggerBinding` in TS.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerBinding {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character_id: Option<String>,
}

/// Input for `workflow_register_trigger`. Sent from TS when a workflow is
/// saved (or its triggers change).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterTriggerInput {
    pub trigger_id: String,
    pub workflow_id: String,
    pub kind: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_path: Option<String>,
    /// HTTP method the receiver allows. Defaults to "POST" when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_method: Option<String>,
    /// Optional HMAC-SHA-256 secret for the X-Signature-256 header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_hmac_secret: Option<String>,
    /// Status code returned to the caller. Defaults to 200 when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_response_status: Option<u16>,
    /// Optional response body template, returned verbatim as the static
    /// fallback (or when the workflow has no `io.webhook.respond` node).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_response_body: Option<String>,
    /// True when the workflow contains an `io.webhook.respond` node — the
    /// receiver then holds the request open for a dynamic response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_await_response: Option<bool>,
    /// How long (ms) to hold an `await_response` request before falling back
    /// to the static response. Absent / 0 = the Rust default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_response_timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<TriggerBinding>,
}

/// The TriggerEvent envelope emitted from Rust to TS via the
/// `workflow:trigger` Tauri event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEvent {
    pub workflow_id: String,
    pub kind: String,
    /// Exact trigger-node id that produced this event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_id: Option<String>,
    pub payload: serde_json::Value,
    /// Wall-clock time the trigger fired (ms since epoch).
    pub origin_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<TriggerBinding>,
}

/// Input for `workflow_persist_run_state`. The TS side calls this on every
/// step transition so a webview crash leaves the Rust mirror with enough
/// state to surface the run on the next boot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistRunStateInput {
    pub run_id: String,
    pub workflow_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_step_id: Option<String>,
    /// Frozen workflow definition; only included on first persist. Subsequent
    /// persists send an absent `snapshot` to keep IPC payloads small.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<serde_json::Value>,
}

/// One row returned by `workflow_reload_in_flight_runs`. Includes the
/// frozen snapshot so the TS orchestrator can re-invoke without re-reading
/// Dexie.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InFlightRunRow {
    pub run_id: String,
    pub workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_step_id: Option<String>,
    pub snapshot: serde_json::Value,
    pub started_at: i64,
}

/// Webhook trigger payload — the body of the inbound HTTP request, plus
/// surface metadata so workflows can branch on the request method or query
/// params without parsing them themselves. Constructed in Phase 5b when the
/// webhook router lands; the type is defined now so the contract is locked.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookTriggerPayload {
    pub method: String,
    pub path: String,
    pub headers: std::collections::BTreeMap<String, String>,
    pub query: std::collections::BTreeMap<String, String>,
    pub body: serde_json::Value,
    /// True when the body parsed as JSON; false when it was returned as a
    /// raw string blob.
    pub body_was_json: bool,
    /// Correlation id for the held-open response channel. Present only when
    /// the receiver is awaiting a dynamic response (the workflow has an
    /// `io.webhook.respond` node); the workflow echoes it back through the
    /// `workflow_webhook_respond` command. Absent for fire-and-forget hooks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_status_round_trips_via_serde() {
        for status in [
            RunStatus::Pending,
            RunStatus::Running,
            RunStatus::Waiting,
            RunStatus::Paused,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            let s = serde_json::to_string(&status).unwrap();
            let back: RunStatus = serde_json::from_str(&s).unwrap();
            assert_eq!(status, back);
            assert_eq!(RunStatus::from_str(status.as_str()), Some(status));
        }
    }

    #[test]
    fn run_status_is_terminal_marks_only_finished_states() {
        assert!(!RunStatus::Pending.is_terminal());
        assert!(!RunStatus::Running.is_terminal());
        assert!(!RunStatus::Waiting.is_terminal());
        assert!(!RunStatus::Paused.is_terminal());
        assert!(RunStatus::Succeeded.is_terminal());
        assert!(RunStatus::Failed.is_terminal());
        assert!(RunStatus::Cancelled.is_terminal());
    }

    #[test]
    fn run_status_from_str_returns_none_for_unknown_strings() {
        assert!(RunStatus::from_str("nonsense").is_none());
        assert!(RunStatus::from_str("").is_none());
    }

    #[test]
    fn register_trigger_input_round_trips_with_camelcase_fields() {
        let input = RegisterTriggerInput {
            trigger_id: "trg_1".into(),
            workflow_id: "wf_1".into(),
            kind: "trigger.cron".into(),
            enabled: true,
            cron: Some("0 9 * * 1-5".into()),
            timezone: Some("Asia/Shanghai".into()),
            webhook_path: None,
            webhook_method: None,
            webhook_hmac_secret: None,
            webhook_response_status: None,
            webhook_response_body: None,
            webhook_await_response: None,
            webhook_response_timeout_ms: None,
            binding: Some(TriggerBinding {
                adapter_id: Some("telegram_main".into()),
                ..Default::default()
            }),
        };
        let s = serde_json::to_string(&input).unwrap();
        // camelCase must hold for the IPC contract.
        assert!(s.contains("\"triggerId\""));
        assert!(s.contains("\"workflowId\""));
        assert!(s.contains("\"adapterId\""));
        let back: RegisterTriggerInput = serde_json::from_str(&s).unwrap();
        assert_eq!(back.trigger_id, "trg_1");
        assert_eq!(back.cron.as_deref(), Some("0 9 * * 1-5"));
    }

    #[test]
    fn trigger_event_serializes_with_camelcase_origin_at() {
        let ev = TriggerEvent {
            workflow_id: "wf_1".into(),
            kind: "trigger.cron".into(),
            trigger_id: Some("trg_1".into()),
            payload: serde_json::json!({ "tick": true }),
            origin_at: 1_700_000_000_000,
            binding: None,
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"workflowId\""));
        assert!(s.contains("\"triggerId\":\"trg_1\""));
        assert!(s.contains("\"originAt\""));
        assert!(s.contains("1700000000000"));
    }

    #[test]
    fn trigger_kinds_constant_lists_every_known_trigger() {
        for kind in TRIGGER_KINDS {
            assert!(kind.starts_with("trigger."));
        }
        assert!(TRIGGER_KINDS.contains(&"trigger.manual"));
        assert!(TRIGGER_KINDS.contains(&"trigger.cron"));
        assert!(TRIGGER_KINDS.contains(&"trigger.connector.inbound"));
        assert!(TRIGGER_KINDS.contains(&"trigger.chat.message"));
        assert!(TRIGGER_KINDS.contains(&"trigger.webhook"));
        assert!(TRIGGER_KINDS.contains(&"trigger.team"));
        assert!(TRIGGER_KINDS.contains(&"trigger.goal.completed"));
        assert!(TRIGGER_KINDS.contains(&"trigger.desktop.event"));
        assert!(TRIGGER_KINDS.contains(&"trigger.terminal.command"));
        assert!(TRIGGER_KINDS.contains(&"trigger.pet.event"));
        assert!(TRIGGER_KINDS.contains(&"trigger.workflow.completed"));
    }
}
