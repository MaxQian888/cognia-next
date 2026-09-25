//! The automation crate's sandbox surface (ADR-0028).
//!
//! The execution sandbox itself — backends, policy, launchers — is
//! `cognia-exec-sandbox` (ADR-0196 P2), re-exported below so
//! `crate::sandbox::…`, `app_lib::sandbox::…` and every `generate_handler!`
//! path resolve unchanged. What stays here is what needs this crate: the
//! three Tauri commands, which record into the automation audit ring through
//! `AutomationState`, and the admission check, which reads the owning
//! plugin's `PluginFacts`.

pub use cognia_exec_sandbox::*;

use cognia_exec_sandbox::types::SandboxHealth;

/// Tauri-exposed read-only diagnostic. The Settings → Sandbox tab
/// (Phase 7) polls this to drive the status badge ("Active" / "Setup
/// required" / "Unavailable") and the "Retry setup" button visibility.
///
/// Cheap — no I/O, no keyring, no spawn. Safe to poll on a 5s interval.
#[tauri::command]
pub async fn sandbox_health_probe() -> Result<SandboxHealth, String> {
    Ok(current_backend().health())
}

/// ACTIVE confinement probe. Distinct from `sandbox_health_probe` (which only
/// checks the backend binary exists and is cheap enough to poll): this spawns
/// real confined commands to verify confinement is actually enforced, so it is
/// invoked on-demand (a "Verify confinement" action), NOT on the status poll.
/// A present-but-broken backend reports `confined: false` here even though the
/// cheap probe shows "Active".
#[tauri::command]
pub async fn sandbox_health_check() -> Result<crate::sandbox::types::ProbeReport, String> {
    Ok(current_backend().probe_confinement().await)
}

/// The plugin that owns every sandboxed tool. `sandbox_exec` is reachable only
/// through `cognia-sandboxed-tools`' `sandbox_bash` / `sandbox_edit` /
/// `sandbox_write` / `sandbox_text_editor`, so the grant check is pinned to
/// that id rather than to a caller-supplied one — an id passed over the
/// transport could simply be forged by the caller it is meant to constrain.
pub const SANDBOX_PLUGIN_ID: &str = "cognia-sandboxed-tools";

/// The two manifest permissions a sandboxed tool call requires.
///
/// `plugins/cognia-sandboxed-tools/src/index.ts` declares exactly these, and
/// the consent UI describes them to the user as "Read and write files on this
/// device" and "Run programs on this device". Until this check existed they
/// were decorative: the user could deny both and every sandbox tool kept
/// working, because `sandbox_exec` validated only the *policy* (path and
/// network scope) and never looked at a grant at all.
pub const SANDBOX_REQUIRED_GRANTS: [&str; 2] = ["native:filesystem", "native:process"];

fn sandbox_audit_reason(
    termination: &str,
    provider: &str,
    requested_timeout_seconds: u64,
    result: Option<&crate::sandbox::types::SandboxResult>,
) -> String {
    format!(
        "tier=os;provider={provider};termination={termination};requested_timeout_seconds={requested_timeout_seconds};timeout={};stdout_truncated={};stderr_truncated={};exit_code={}",
        result.is_some_and(|value| value.timed_out),
        result.is_some_and(|value| value.stdout_truncated),
        result.is_some_and(|value| value.stderr_truncated),
        result
            .map(|value| value.exit_code.to_string())
            .unwrap_or_else(|| "none".to_string())
    )
}

/// Why a sandbox call was refused before it reached the OS sandbox.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxAdmission {
    Allowed,
    PluginNotInstalled,
    PluginDisabled,
    MissingGrants(Vec<String>),
}

impl SandboxAdmission {
    pub fn is_allowed(&self) -> bool {
        matches!(self, SandboxAdmission::Allowed)
    }

    /// Short tag for the audit entry's `reason` field.
    pub fn audit_reason(&self) -> &'static str {
        match self {
            SandboxAdmission::Allowed => "allowed",
            SandboxAdmission::PluginNotInstalled => "plugin_not_installed",
            SandboxAdmission::PluginDisabled => "plugin_disabled",
            SandboxAdmission::MissingGrants(_) => "permission_denied",
        }
    }

    pub fn message(&self) -> String {
        match self {
            SandboxAdmission::Allowed => String::new(),
            SandboxAdmission::PluginNotInstalled => format!(
                "sandboxed tools are unavailable: the \"{SANDBOX_PLUGIN_ID}\" plugin is not installed."
            ),
            SandboxAdmission::PluginDisabled => format!(
                "sandboxed tools are unavailable: the \"{SANDBOX_PLUGIN_ID}\" plugin is disabled."
            ),
            SandboxAdmission::MissingGrants(missing) => format!(
                "sandboxed tools are not permitted: \"{SANDBOX_PLUGIN_ID}\" is missing the {} permission(s). Grant them in Settings → Plugins.",
                missing.join(", ")
            ),
        }
    }
}

/// Decide whether a sandbox call may proceed, from the owning plugin's live
/// facts. Fails closed on every axis: not installed, disabled, or any required
/// grant absent all deny.
pub fn admit_sandbox_call(
    facts: &crate::automation::record::plugin_facts::PluginFacts,
) -> SandboxAdmission {
    if !facts.installed {
        return SandboxAdmission::PluginNotInstalled;
    }
    if !facts.enabled {
        return SandboxAdmission::PluginDisabled;
    }
    let missing: Vec<String> = SANDBOX_REQUIRED_GRANTS
        .iter()
        .filter(|required| !facts.granted.iter().any(|g| g == *required))
        .map(|s| s.to_string())
        .collect();
    if missing.is_empty() {
        SandboxAdmission::Allowed
    } else {
        SandboxAdmission::MissingGrants(missing)
    }
}

/// Tauri-exposed execution dispatcher consumed by the
/// `cognia-sandboxed-tools` plugin (Phase 4.5). The renderer-side plugin
/// tool's `execute()` forwards every call here.
///
/// Flow: check the owning plugin's grants via [`admit_sandbox_call`], derive a
/// `SandboxPolicy` from `(tool, request)` via `policy::policy_for`, then
/// dispatch through `run_confined`. Each call is also recorded in the shared
/// `AuditRing` with `Surface::Sandbox` (ADR-0028 Phase 14) so the Diagnostics
/// tab can surface allow/deny/error counts alongside the desktop-automation
/// surfaces.
///
/// Errors come back as `String` (Tauri can't serialize the rich
/// `SandboxError` enum directly without a custom impl); the plugin uses
/// `error.message` verbatim as the ToolResult error so the model sees the
/// same stderr-style failure a native shell command would emit.
#[tauri::command]
pub async fn sandbox_exec(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::automation::commands::AutomationState>,
    tool: String,
    command: crate::sandbox::types::SandboxCommand,
    request: crate::sandbox::policy::PolicyRequest,
) -> Result<crate::sandbox::types::SandboxResult, String> {
    use crate::automation::audit::{AuditEntry, Decision as AuditDecision};
    use crate::automation::permission::Surface;
    use std::time::Instant;
    use tauri::Emitter;

    let started = Instant::now();
    let stripped = tool.strip_prefix("sandbox_").unwrap_or(&tool).to_string();
    let cwd_label = command.cwd.to_string_lossy().into_owned();
    let requested_timeout_seconds = command.timeout.as_secs();
    let backend_id = current_backend().health().backend;

    // Permission gate. This runs BEFORE the policy check so a revoked grant
    // denies regardless of how well-formed the request is, and before any
    // process is spawned.
    let admission = admit_sandbox_call(&state.plugin_facts().facts(SANDBOX_PLUGIN_ID));
    if !admission.is_allowed() {
        let msg = admission.message();
        let entry = state.audit.record(AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: Some(SANDBOX_PLUGIN_ID.to_string()),
            command: tool.clone(),
            process_name: Some(format!("os:{backend_id}")),
            window_title: Some(cwd_label.clone()),
            decision: AuditDecision::Deny,
            reason: Some(format!(
                "{};{}",
                admission.audit_reason(),
                sandbox_audit_reason("refused", &backend_id, requested_timeout_seconds, None)
            )),
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(msg.clone()),
        });
        let _ = app.emit("automation:event", &entry);
        return Err(msg);
    }

    let policy = match crate::sandbox::policy::policy_for(&stripped, request) {
        Ok(p) => p,
        Err(err) => {
            let msg = err.to_string();
            let entry = state.audit.record(AuditEntry {
                id: String::new(),
                ts: chrono::Utc::now().timestamp_millis(),
                surface: Surface::Sandbox,
                plugin_id: Some(SANDBOX_PLUGIN_ID.to_string()),
                command: tool.clone(),
                process_name: Some(format!("os:{backend_id}")),
                window_title: Some(cwd_label.clone()),
                decision: AuditDecision::Deny,
                reason: Some(format!(
                    "invalid_policy;{}",
                    sandbox_audit_reason("refused", &backend_id, requested_timeout_seconds, None)
                )),
                duration_ms: started.elapsed().as_millis() as u64,
                error: Some(msg.clone()),
            });
            let _ = app.emit("automation:event", &entry);
            return Err(msg);
        }
    };

    let outcome = run_confined(command, policy).await;
    let entry = match &outcome {
        Ok(result) => AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: Some(SANDBOX_PLUGIN_ID.to_string()),
            command: tool.clone(),
            process_name: Some(format!("os:{backend_id}")),
            window_title: Some(cwd_label),
            decision: AuditDecision::Allow,
            reason: Some(sandbox_audit_reason(
                if result.timed_out {
                    "timeout"
                } else if result.exit_code == 0 {
                    "completed"
                } else {
                    "exit_nonzero"
                },
                &backend_id,
                requested_timeout_seconds,
                Some(result),
            )),
            duration_ms: result.duration.as_millis() as u64,
            error: if result.exit_code == 0 {
                None
            } else {
                Some(format!("exit_code={}", result.exit_code))
            },
        },
        Err(err) => AuditEntry {
            id: String::new(),
            ts: chrono::Utc::now().timestamp_millis(),
            surface: Surface::Sandbox,
            plugin_id: Some(SANDBOX_PLUGIN_ID.to_string()),
            command: tool.clone(),
            process_name: Some(format!("os:{backend_id}")),
            window_title: Some(cwd_label),
            decision: AuditDecision::Deny,
            reason: Some(format!(
                "backend_error;{}",
                sandbox_audit_reason(
                    "backend_error",
                    &backend_id,
                    requested_timeout_seconds,
                    None
                )
            )),
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(err.to_string()),
        },
    };
    let recorded = state.audit.record(entry);
    let _ = app.emit("automation:event", &recorded);
    outcome.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sandbox_health_probe_reports_a_known_backend_id() {
        let health = sandbox_health_probe().await.unwrap();
        let ok = matches!(
            health.backend.as_str(),
            "windows-cognia-sandbox" | "macos-sandbox-exec" | "linux-bwrap" | "mock"
        ) || health.backend.starts_with("uninstalled-");
        assert!(ok, "unexpected backend id: {}", health.backend);
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use crate::automation::record::plugin_facts::PluginFacts;
    use std::time::Duration;

    fn facts(installed: bool, enabled: bool, granted: &[&str]) -> PluginFacts {
        PluginFacts {
            installed,
            enabled,
            granted: granted.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn both_grants_present_is_allowed() {
        let a = admit_sandbox_call(&facts(true, true, &SANDBOX_REQUIRED_GRANTS));
        assert_eq!(a, SandboxAdmission::Allowed);
        assert!(a.is_allowed());
    }

    #[test]
    fn a_denied_grant_denies_the_call() {
        // The whole point of the gate: the user denies `native:process` and the
        // sandbox tools stop working, instead of running anyway.
        let a = admit_sandbox_call(&facts(true, true, &["native:filesystem"]));
        assert_eq!(
            a,
            SandboxAdmission::MissingGrants(vec!["native:process".into()])
        );
        assert!(!a.is_allowed());
        assert_eq!(a.audit_reason(), "permission_denied");
        assert!(a.message().contains("native:process"));
    }

    #[test]
    fn both_grants_denied_names_both() {
        let a = admit_sandbox_call(&facts(true, true, &[]));
        assert_eq!(
            a,
            SandboxAdmission::MissingGrants(vec![
                "native:filesystem".into(),
                "native:process".into()
            ])
        );
    }

    #[test]
    fn unrelated_grants_do_not_satisfy_the_requirement() {
        let a = admit_sandbox_call(&facts(true, true, &["native:input", "native:screen"]));
        assert!(!a.is_allowed());
    }

    #[test]
    fn a_disabled_plugin_denies() {
        let a = admit_sandbox_call(&facts(true, false, &SANDBOX_REQUIRED_GRANTS));
        assert_eq!(a, SandboxAdmission::PluginDisabled);
        assert_eq!(a.audit_reason(), "plugin_disabled");
    }

    #[test]
    fn an_uninstalled_plugin_denies_before_grants_are_considered() {
        let a = admit_sandbox_call(&facts(false, true, &SANDBOX_REQUIRED_GRANTS));
        assert_eq!(a, SandboxAdmission::PluginNotInstalled);
    }

    #[test]
    fn the_default_facts_source_fails_closed() {
        // `NoPluginFacts` is what `AutomationState` holds until `src-tauri`
        // registers the real source at boot. A wiring mistake must deny.
        use crate::automation::record::plugin_facts::{NoPluginFacts, PluginFactsSource};
        let a = admit_sandbox_call(&NoPluginFacts.facts(SANDBOX_PLUGIN_ID));
        assert_eq!(a, SandboxAdmission::PluginNotInstalled);
    }

    #[test]
    fn required_grants_match_the_plugin_manifest() {
        // `plugins/cognia-sandboxed-tools/src/index.ts` declares exactly these.
        // Drift here means the gate checks a permission the plugin never asks
        // for, which denies every call.
        assert_eq!(
            SANDBOX_REQUIRED_GRANTS,
            ["native:filesystem", "native:process"]
        );
        assert_eq!(SANDBOX_PLUGIN_ID, "cognia-sandboxed-tools");
    }

    #[test]
    fn audit_reason_carries_effective_backend_and_result_limits() {
        let result = crate::sandbox::types::SandboxResult {
            exit_code: 137,
            stdout: String::new(),
            stderr: String::new(),
            duration: Duration::from_secs(4),
            timed_out: true,
            stdout_truncated: true,
            stderr_truncated: false,
        };

        assert_eq!(
            sandbox_audit_reason("timeout", "macos-sandbox-exec", 30, Some(&result)),
            "tier=os;provider=macos-sandbox-exec;termination=timeout;requested_timeout_seconds=30;timeout=true;stdout_truncated=true;stderr_truncated=false;exit_code=137"
        );
    }
}
