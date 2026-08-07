// Tauri commands that bridge TS callers into the Rust hooks runtime.
//
// The built-in agent fires hooks in-process from `claude::sidecar`. External
// agents (claude-code / codex / opencode) are parsed entirely in TS
// (`lib/ai/agent/external/manager.ts`) because the Rust `external_agent` module
// is a pure stdio pass-through — so TS calls `run_agent_hook` to reach the SAME
// settings.json hook runtime instead of duplicating it.
//
// `set_trusted_workspaces` seeds the Rust-side trust gate from the frontend's
// Dexie ledger so project/local-scope hooks only load for trusted directories.

use serde::Serialize;
use serde_json::Value;

use super::trust;
use super::{
    hook_event_name, load_effective_settings, run_session_scoped, run_tool_scoped, HookDecision,
    HookEvent,
};

/// Wire shape returned to TS. `block` set ⇒ the caller should treat the action
/// as denied (only honoured on the permission path); `additionalContext` is a
/// prompt/context contribution; `warnings` are non-blocking diagnostics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDecisionDto {
    pub block: Option<String>,
    pub additional_context: Option<String>,
    pub warnings: Vec<String>,
}

impl From<HookDecision> for HookDecisionDto {
    fn from(d: HookDecision) -> Self {
        Self {
            block: d.block,
            additional_context: d.additional_context,
            warnings: d.warnings,
        }
    }
}

/// Parse the PascalCase event name from TS into a `HookEvent`.
fn parse_event(event: &str) -> Option<HookEvent> {
    serde_json::from_value::<HookEvent>(Value::String(event.to_string())).ok()
}

/// Run a settings.json hook for an external-agent lifecycle event.
///
/// - `event`: PascalCase `HookEvent` (e.g. "PreToolUse", "PostToolUse", "Stop").
/// - `tool_name`: when present, the hook is tool-scoped (matcher tested against it);
///   when absent it is session-scoped.
/// - `cwd`: project dir; project/local hooks load only if it is a trusted workspace.
/// - `payload`: event-specific fields merged into the hook payload `fields`.
#[tauri::command]
pub async fn run_agent_hook(
    event: String,
    session_id: String,
    cwd: Option<String>,
    tool_name: Option<String>,
    payload: Option<Value>,
) -> Result<HookDecisionDto, String> {
    let Some(hook_event) = parse_event(&event) else {
        return Err(format!("unknown hook event: {event}"));
    };
    let resolved_cwd = trust::resolve_trusted_cwd(cwd.as_deref());
    let settings = load_effective_settings(resolved_cwd.as_deref());
    let fields = payload.unwrap_or(Value::Null);

    let decision = match &tool_name {
        Some(tool) => {
            run_tool_scoped(
                &settings,
                hook_event,
                &session_id,
                resolved_cwd.as_deref(),
                tool,
                fields,
            )
            .await
        }
        None => {
            run_session_scoped(
                &settings,
                hook_event,
                &session_id,
                resolved_cwd.as_deref(),
                fields,
            )
            .await
        }
    };

    for w in &decision.warnings {
        log::warn!("run_agent_hook[{}]: {w}", hook_event_name(hook_event));
    }
    Ok(decision.into())
}

/// Replace the Rust-side trusted-workspace set with the frontend's ledger.
/// Called on startup and whenever the user grants/revokes workspace trust.
#[tauri::command]
pub fn set_trusted_workspaces(paths: Vec<String>) {
    trust::set_trusted_paths(paths);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_roundtrips_known_events() {
        assert_eq!(parse_event("PreToolUse"), Some(HookEvent::PreToolUse));
        assert_eq!(parse_event("PostToolUse"), Some(HookEvent::PostToolUse));
        assert_eq!(parse_event("Stop"), Some(HookEvent::Stop));
        assert_eq!(parse_event("SessionStart"), Some(HookEvent::SessionStart));
        assert_eq!(parse_event("Setup"), Some(HookEvent::Setup));
        assert_eq!(parse_event("SubagentStart"), Some(HookEvent::SubagentStart));
        assert_eq!(
            parse_event("DirectoryAdded"),
            Some(HookEvent::DirectoryAdded)
        );
        assert_eq!(
            parse_event("MessageDisplay"),
            Some(HookEvent::MessageDisplay)
        );
        assert_eq!(parse_event("nope"), None);
    }

    #[test]
    fn dto_maps_all_fields() {
        let decision = HookDecision {
            block: Some("denied".into()),
            additional_context: Some("ctx".into()),
            warnings: vec!["w1".into()],
        };
        let dto: HookDecisionDto = decision.into();
        assert_eq!(dto.block.as_deref(), Some("denied"));
        assert_eq!(dto.additional_context.as_deref(), Some("ctx"));
        assert_eq!(dto.warnings, vec!["w1".to_string()]);
    }

    #[test]
    fn dto_serializes_camel_case() {
        let dto = HookDecisionDto {
            block: None,
            additional_context: Some("hi".into()),
            warnings: vec![],
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("additionalContext"));
        assert!(!json.contains("additional_context"));
    }
}
