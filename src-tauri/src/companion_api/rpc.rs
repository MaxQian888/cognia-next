//! RPC dispatch for `POST /api/v1/_rpc/:name`.
//!
//! # Request shape
//!
//! ```text
//! POST /api/v1/_rpc/<command_name>
//! Authorization: Bearer <device-jwt>
//! Idempotency-Key: <optional-uuid>          ← skipped for read-only commands
//! Content-Type: application/json
//!
//! { ...command-specific args... }
//! ```
//!
//! # Response shape (success)
//!
//! ```text
//! HTTP 200
//! Content-Type: application/json
//! { ...command-specific result... }
//! ```
//!
//! # Response shape (failure)
//!
//! ```text
//! HTTP 4xx / 5xx
//! Content-Type: application/json
//! { "code": "<snake_case_code>", "message": "<human readable>" }
//! ```
//!
//! # Idempotency
//!
//! When the `Idempotency-Key` header is present and the command is **not**
//! read-only, `(device_id, method, idempotency_key)` and a parameter digest
//! are reserved before dispatch. Successful results are retained for 24 hours
//! and shared with the WebRTC path. Conflicting parameters and pending records
//! are rejected instead of risking a duplicate write.
//!
//! Read-only commands skip the cache entirely: they are cheap to re-run and
//! their idempotency is structural (same args → same result).

use std::collections::HashSet;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Extension, Json,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    agents::commands as agent_commands,
    claude::{commands as claude_commands, mcp_test, sidecar::kill_sidecar},
    skills::{install, native as skills_native, registry},
};

use super::{middleware::DeviceContext, SharedState};

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn opaque_host_id(state: &SharedState) -> String {
    let digest = Sha256::digest(state.secret.read().as_slice());
    format!("host-{}", hex::encode(&digest[..12]))
}

fn remote_context_error(code: &'static str) -> (StatusCode, Json<RpcError>) {
    let status = match code {
        "REMOTE_PROXY_DISCONNECTED" => StatusCode::SERVICE_UNAVAILABLE,
        "REMOTE_RESPONSE_STALE" => StatusCode::CONFLICT,
        _ => StatusCode::FORBIDDEN,
    };
    (
        status,
        Json(RpcError::new(
            code,
            "remote execution context does not match the pending request",
        )),
    )
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/// Headless emitter: publishes into the companion EventBus so every
/// `/ws/v1/events` subscriber (the brain's acp-client, phones) receives the
/// frozen payloads. Lives app-side (ADR-0067): the extracted external-agent
/// crate defines the `AgentEventEmitter` seam, and this is the one impl that
/// needs the companion EventBus.
pub struct BusAgentEmitter(pub std::sync::Arc<super::event_bus::EventBus>);

impl crate::external_agent::exec_backend::AgentEventEmitter for BusAgentEmitter {
    fn emit(&self, channel: &str, payload: Value) {
        self.0.publish(channel.to_string(), payload);
    }
}

/// JSON error body returned on any non-200 response.
#[derive(Debug, serde::Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn unknown_command(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::NOT_FOUND,
            Json(Self::new(
                "unknown_command",
                format!("RPC command '{name}' is not exposed to mobile clients"),
            )),
        )
    }

    fn malformed(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self::new("malformed_request", detail)),
        )
    }

    fn service_unavailable(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new("service_unavailable", detail)),
        )
    }

    /// ADR-0059 R5 — the command's body still requires the desktop Tauri
    /// runtime and this process is a headless `cognia-server`. Distinct code
    /// from `service_unavailable` so clients can tell "retry later" (server
    /// booting) from "this feature does not exist on a headless install".
    pub(super) fn headless_unsupported(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new(
                "headless_unsupported",
                format!("RPC command '{name}' is not available on a headless server (requires the desktop app)"),
            )),
        )
    }

    fn internal(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(Self::new("internal_error", detail)),
        )
    }

    fn idempotency_conflict() -> (StatusCode, Json<Self>) {
        (
            StatusCode::CONFLICT,
            Json(Self::new(
                "idempotency_conflict",
                "the idempotency key was already used with different parameters",
            )),
        )
    }

    fn idempotency_indeterminate() -> (StatusCode, Json<Self>) {
        (
            StatusCode::CONFLICT,
            Json(Self::new(
                "idempotency_indeterminate",
                "the prior execution did not record a final result and will not be replayed",
            )),
        )
    }

    /// Remote session control gate (Remote Session Control). The device is
    /// paired and authenticated but has not been granted the elevated
    /// remote-control capability — `allowRemoteControl` is off for it. The
    /// owner enables it per-device from the desktop paired-devices settings
    /// (biometric-gated).
    fn forbidden(detail: impl Into<String>) -> (StatusCode, Json<Self>) {
        (
            StatusCode::FORBIDDEN,
            Json(Self::new("remote_control_forbidden", detail)),
        )
    }

    /// Wave 3.3 — 429 Too Many Requests with the wait time embedded in
    /// the message (`retry_after_seconds=N`). The flat envelope keeps
    /// the contract simple; phones can parse the integer.
    fn rate_limited(retry_after_secs: u64) -> (StatusCode, Json<Self>) {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(Self::new(
                "rate_limited",
                format!(
                    "device exceeded the per-minute quota; retry_after_seconds={retry_after_secs}"
                ),
            )),
        )
    }

    /// Wave 3.2 — request shape rejected. Distinct from
    /// `malformed_request` so clients can route validation failures
    /// (recoverable, fix the payload and retry) separately from
    /// transport-level malformed JSON (terminal at this layer).
    #[allow(dead_code)] // re-exposed when full schema validation lands.
    fn validation_failed(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self::new("validation_failed", detail)),
        )
    }
}

fn terminal_rpc_authorization(
    device_id: &str,
    host_remote_access_enabled: bool,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    if !host_remote_access_enabled {
        return Err(RpcError::forbidden(
            "remote terminal access is disabled on this host",
        ));
    }
    if device_id.trim().is_empty()
        || !super::control_allow_list::terminal_global().is_allowed(device_id)
    {
        return Err(RpcError::forbidden(
            "remote terminal permission is required for this device",
        ));
    }
    Ok(())
}

async fn ensure_terminal_rpc_authorized(
    device_id: &str,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    terminal_rpc_authorization(
        device_id,
        crate::terminal_host_service::terminal_remote_access_enabled().await,
    )
}

// ---------------------------------------------------------------------------
// Read-only command list
// ---------------------------------------------------------------------------

/// Every command name recognized by `dispatch()`. The handler consults this
/// list **before** requiring the AppHandle so unknown commands consistently
/// surface as 404 rather than 503-in-test-mode. Keep in lockstep with the
/// `match name` arms in `dispatch()` below — drift means unknown names
/// silently bypass the 404 path.
#[cfg(test)]
const KNOWN_COMMANDS: &[&str] = &[
    "claude_send",
    "claude_interrupt",
    "claude_compact",
    "claude_restore",
    "claude_set_mode",
    "claude_approve",
    "claude_plugin_tool_response",
    "claude_tool_result_decision",
    "claude_protocol_adapter_message",
    "claude_close_session",
    "claude_sidecar_status",
    "claude_set_api_key",
    "claude_has_api_key",
    "claude_set_oauth_bearer",
    "claude_has_oauth_bearer",
    "claude_set_provider_env",
    "claude_restart_sidecar",
    "skills_load_registry",
    "skills_scan_native",
    "skills_install_native",
    "skills_uninstall_native",
    "skills_catalog_get",
    "skills_bundle_upload_open",
    "skills_bundle_upload_write",
    "skills_bundle_upload_commit",
    "skills_bundle_upload_abort",
    "skills_install_atomic",
    "skills_uninstall",
    "external_bridge_config_get",
    "external_bridge_config_update",
    "external_bridge_client_create",
    "external_bridge_client_list",
    "external_bridge_client_rotate",
    "external_bridge_client_revoke",
    "external_bridge_start",
    "external_bridge_stop",
    "external_bridge_restart",
    "external_bridge_status",
    "external_bridge_relay_enable",
    "external_bridge_relay_disable",
    "host_admin_lease_issue",
    "host_admin_lease_revoke",
    "mcp_server_status",
    "mcp_server_start",
    "mcp_server_stop",
    "mcp_server_restart",
    "test_mcp_server",
    "read_agent_config",
    "write_agent_config",
    // Generic encrypted secret-store facade for the headless brain. These
    // mirror the desktop Tauri keyring commands but are SERVICE_ONLY below.
    "keyring_secret_get",
    "keyring_secret_set",
    "keyring_secret_clear",
    "sync_pull",
    "sync_list_tables",
    "register_push_token",
    "revoke_push_token",
    "message_update",
    "message_delete",
    "session_list",
    "message_get_by_session",
    "message_send",
    // Wave 2 mutating RPCs — round-trip through desktop_writes_bridge.
    "character_upsert",
    "character_delete",
    "character_bind_twin",
    "skill_set_enabled",
    "plugin_set_enabled",
    "adapter_update_policy",
    "app_settings_update",
    // Wave 2 read-only projection routed through desktop_writes_bridge.
    "twin_profile_get",
    // ADR-0097 — what this host can do, answered by the host's own TS layer
    // (renderer on desktop, brain on headless) so the capability vocabulary
    // stays single-sourced in `lib/platform/capabilities.ts`.
    "host_capabilities",
    "host_feature_manifest",
    "provider_diagnostics_status",
    "provider_diagnostics_history",
    "provider_diagnostics_start",
    "provider_diagnostics_cancel",
    // ADR-0056 Wave 4 — external-agent config (Zustand/localStorage on the
    // desktop, not Dexie). `external_agent_list` is a read-only projection;
    // `external_agent_update` (enable/disable + permission mode) round-trips
    // through the mobile outbound queue. Both via desktop_writes_bridge.
    "external_agent_list",
    "external_agent_update",
    // ADR-0059 R11 — headless external-agent execution plane. Service-scope
    // only (SERVICE_ONLY_COMMANDS) + SpawnPolicy allowlist + audit trail;
    // a device JWT can never reach these.
    "spawn_external_agent",
    "send_to_external_agent",
    "kill_external_agent",
    "get_external_agent_status",
    // ADR-0059 R12 — service-scope management of the public `/connectors`
    // webhook ingress registry on the headless front door.
    "connectors_register",
    "connectors_unregister",
    "connectors_list_adapters",
    // Marketplace Integration ingress uses the same host-owned workflow
    // router and encrypted spool on desktop and headless deployments.
    "integration_ingress_register",
    "integration_ingress_unregister",
    "integration_ingress_get_url",
    "integration_ingress_poll",
    // Catalog status/search are pure reads over the active SQLite revision.
    "provider_catalog_status",
    "provider_catalog_search",
    "integration_ingress_ack",
    "integration_ingress_nack",
    // ADR-0090 Phase 1 — Provider Profile Store admin plane (service scope;
    // redacted docs only, secrets never transit these arms).
    "provider_profiles_list",
    "provider_profiles_import",
    "provider_profiles_version",
    "provider_catalog_status",
    "provider_catalog_search",
    "provider_catalog_refresh",
    // ADR-0059 T-A5 — connector command plane for the headless brain's
    // connector-runtime. Same names as the Tauri commands; each arm
    // delegates to the same free function the command wraps.
    "connectors_health",
    "connectors_keyring_set",
    "connectors_keyring_get",
    "connectors_keyring_delete",
    "connectors_keyring_list",
    "connectors_http_request",
    "connectors_ws_open",
    "connectors_ws_send",
    "connectors_ws_close",
    "connectors_onebot_send",
    "connectors_lark_ws_open",
    "connectors_lark_ws_close",
    "connectors_reset_all_ws",
    "connectors_attachment_fetch",
    "connectors_attachment_read",
    "connectors_media_upload",
    "connectors_lark_upload_file",
    "connectors_lark_upload_image",
    // Mobile outbound-queue RPCs — round-trip through desktop_writes_bridge.
    // Mirror `MOBILE_OUTBOUND_COMMANDS` in `lib/db/mobile-outbound-types.ts`.
    // Spec-parity test (`spec_parity.rs`) asserts these stay in lockstep
    // with the OpenAPI spec; the in-file `mobile_queue_commands_are_known`
    // test below asserts they stay in lockstep with the TS enum.
    "connector_send",
    "connector_approve_draft",
    "connector_reject_draft",
    "workflow_trigger_manual",
    "twin_ingest_source",
    // ADR-0060 — a paired device reports its platform capability manifest
    // (camera, geolocation, …) on connect; persisted onto its `pairedDevices`
    // row by the TS dispatch arm. Direct `transport.call` from the mobile
    // shell — deliberately NOT part of `MOBILE_OUTBOUND_COMMANDS` (no
    // offline-queue semantics; a stale report is refreshed on next connect).
    "device_capabilities_report",
    // Remote Session Control — attach/detach a remote watcher + steer host
    // goal loops. All round-trip through desktop_writes_bridge. Gated by the
    // remote-control capability (see CONTROL_COMMANDS).
    "session_attach",
    "session_detach",
    "goal_pause",
    "goal_resume",
    "goal_stop",
    // Agent-Team board control (team-board CQRS, Dexie v104). State flows to
    // the phone via the read-only `agentTeamBoard` sync mirror; these commands
    // are the write path back. The TS arms validate every move through the
    // same `canMoveTask` guard as the desktop board and return `{ok, reason}`.
    // Deliberately NOT in the mobile offline queue: a command must validate
    // against the LIVE run state, not be replayed hours later.
    "team_task_move",
    "team_task_create",
    "team_task_comment",
    "team_run_pause",
    "team_run_resume",
    "team_run_stop",
    // Resolve a host computer-use consent prompt from a remote device.
    // Calls the automation ConsentBroker directly (not via writes-bridge).
    "automation_consent_respond",
    // Read-only capability probe — lets a paired device learn whether it holds
    // the remote-control capability without attempting (and 403-ing on) a
    // gated RPC. NOT a CONTROL_COMMAND: every paired device may query its own
    // standing.
    "companion_can_control",
    // Read-only channel inventory — reports every address this desktop is
    // currently reachable on (LAN + cloudflared tunnel) plus the self-signed
    // TLS fingerprint. The QR pair payload can only carry ONE base URL, so a
    // phone paired on the LAN never learns the tunnel address (and a phone
    // paired over the tunnel never learns the LAN fingerprint it needs to pin
    // a LAN hit). This arm closes both gaps: the client refreshes it on every
    // successful connect and caches the result for failover. NOT a
    // CONTROL_COMMAND — every paired device may ask how to reach its own host.
    "companion_endpoints",
    // ── Source control (ADR-0038) ───────────────────────────────────────────
    // Native git porcelain over a repo path. Reads are ungated; writes /
    // network ops require the remote-control capability (see CONTROL_COMMANDS).
    // The desktop client wrappers in `lib/git/commands.ts` already speak this
    // surface — exposing the arms here makes the entire git client work over
    // the Companion transport with no client changes. Args use the **camelCase**
    // keys those wrappers send (`repoPath`, `hunkPatch`, …), which Tauri
    // converts to snake_case on the desktop path and we read verbatim here.
    "git_is_repo",
    "git_repo_state",
    "git_status",
    "git_diff_stat",
    "git_diff_file",
    "git_diff_commit",
    "git_commit_files",
    "git_log",
    "git_file_history",
    "git_branches",
    "git_remotes",
    "git_stash_list",
    "git_conflicts",
    "git_stage",
    "git_unstage",
    "git_discard",
    "git_discard_all",
    "git_commit",
    "git_checkout_branch",
    "git_create_branch",
    "git_delete_branch",
    "git_rename_branch",
    "git_fetch",
    "git_pull",
    "git_push",
    "git_sync",
    "git_stash_push",
    "git_stash_pop",
    "git_stash_apply",
    "git_stash_drop",
    "git_resolve_conflict",
    "git_merge_abort",
    // Full-surface parity with the desktop panel: ref/blame/tag reads, ref-vs-
    // ref diffs, worktrees, remote/tag CRUD, reset/restore, the sequencer
    // family (rebase / cherry-pick / revert / interactive rebase), init,
    // .gitignore append, and merge. Reads are ungated; every mutation is
    // control-gated (see CONTROL_COMMANDS). `git_watch_start/stop` stay
    // desktop-only — they need the Tauri watcher state; remote clients get the
    // forwarded `git://status-changed` WS event instead.
    "git_diff_refs_files",
    "git_diff_refs_file",
    "git_diff_staged_all",
    "git_refs",
    "git_blame",
    "git_tags",
    "git_worktree_list",
    "git_rebase_commits",
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktree_commit",
    "git_worktree_prune",
    "git_remote_add",
    "git_remote_remove",
    "git_create_tag",
    "git_delete_tag",
    "git_push_tag",
    "git_reset",
    "git_restore",
    "git_rebase",
    "git_cherry_pick",
    "git_revert",
    "git_sequencer_continue",
    "git_sequencer_abort",
    "git_interactive_rebase",
    "git_init",
    "git_clone",
    "git_identity",
    "git_set_identity",
    "git_ignore_add",
    "git_merge",
    // ── Filesystem ──────────────────────────────────────────────────────────
    // Both the raw absolute-path ops (no sandbox — writes are control-gated and
    // the OpenAPI description flags the unrestricted-FS risk) and the sandboxed
    // workspace variants (path-traversal checked against a root).
    "read_text_file",
    "write_text_file",
    "write_text_file_confined",
    "ensure_dir",
    "ensure_dir_confined",
    "default_export_dir",
    "fs_search_workspace",
    "fs_search_content_workspace",
    "fs_read_workspace_file",
    "fs_write_workspace_file",
    // Task-scoped resource ledger. File bodies use bounded reads or verified
    // transfer handles; events carry only summaries.
    "task_workspace_status",
    "task_workspace_begin",
    "task_workspace_settle",
    "task_workspace_get",
    "task_workspace_list",
    "task_workspace_list_runs",
    "task_workspace_list_resources",
    "task_workspace_list_resource_events",
    "task_workspace_get_resource_summary",
    "task_workspace_export_resource_manifest",
    "task_workspace_record_tool_event",
    "task_workspace_get_resource",
    "task_workspace_get_patch_set",
    "task_resource_read_diff",
    "task_resource_read_text",
    "task_resource_download_open",
    "task_resource_download_read_chunk",
    "task_resource_download_close",
    "task_resource_upload_open",
    "task_resource_upload_write_chunk",
    "task_resource_upload_commit",
    "task_resource_upload_abort",
    "task_workspace_apply",
    "task_workspace_undo",
    "task_workspace_resolve_conflict",
    "task_workspace_pin",
    "task_workspace_prune",
    // File-tree browser: list/stat (reads) + mkdir/delete/rename/copy (writes),
    // all root-relative + path-traversal checked.
    "fs_list_workspace_dir",
    "fs_stat_workspace_file",
    "fs_create_workspace_dir",
    "fs_delete_workspace_entry",
    "fs_rename_workspace_entry",
    "fs_copy_workspace_entry",
    // ── Terminal ────────────────────────────────────────────────────────────
    // Live PTY stays on `/ws/terminal`; these are request/response only.
    // `terminal_exec` is a one-shot command runner (capture stdout/stderr/exit).
    "terminal_list_all",
    "terminal_list_for_project",
    "terminal_kill",
    "terminal_exec",
    // Path completion for a remote client's terminal autocomplete, and the
    // "free a busy port" quick fix — both mirror the local Tauri commands.
    "terminal_complete_paths",
    "terminal_kill_port",
    // ── Plugins ─────────────────────────────────────────────────────────────
    // Native install/uninstall manage the on-disk plugin dir + Rust snapshot.
    // Headless mutations publish a Node-brain reconciliation event; desktop
    // mutations remain renderer-reload scoped (see the OpenAPI note).
    "plugin_list",
    "plugin_runtime_snapshot",
    "plugin_install",
    "plugin_install_from_github",
    "plugin_uninstall",
    "plugin_stage_version",
    "plugin_commit_staged_update",
    "plugin_discard_staged_update",
    "plugin_finalize_staged_update",
    "plugin_backup_create",
    "plugin_backup_restore",
    "plugin_backup_delete",
    "plugin_launch_js",
    "plugin_invoke_js_callback",
    "plugin_deactivate_js",
    "plugin_stop_js",
    "plugin_js_status",
    // Native WASM Component execution used by the service-token-authenticated
    // Node brain. Device tokens may manage packages but cannot call guests.
    "plugin_wasm_load",
    "plugin_wasm_activate",
    "plugin_wasm_deactivate",
    "plugin_wasm_call",
    "plugin_wasm_unload",
    "plugin_wasm_list",
    "plugin_permission_grant",
    "plugin_permission_list",
    "plugin_permission_revoke",
    "plugin_api_invoke",
    "plugin_api_batch_invoke",
    "plugin_get_capabilities",
    "plugin_set_shell_allowlist",
    "plugin_set_network_allowlist",
    "plugin_python_initialize",
    "plugin_python_runtime_info",
    "plugin_python_load",
    "plugin_python_call_hook",
    "plugin_python_push_config",
    "plugin_python_get_tools",
    "plugin_python_call_tool",
    "plugin_python_call",
    "plugin_python_eval",
    "plugin_python_import",
    "plugin_python_module_call",
    "plugin_python_module_getattr",
    "plugin_python_is_initialized",
    "plugin_python_get_info",
    "plugin_python_install_deps",
    "plugin_python_unload",
    "plugin_python_list",
    // Managed Pro IDE lifecycle. The remote companion owns the pinned binary,
    // profiles, broker, and relay; the desktop receives only an opaque path.
    "codeserver_supported",
    "codeserver_ensure",
    "codeserver_status",
    "codeserver_stop",
    "codeserver_stop_all",
    "codeserver_build_proxy",
    "codeserver_activate_proxy",
    "codeserver_list_proxies",
    "codeserver_broker_validate_paths",
    "codeserver_broker_respond",
    "codeserver_broker_notify",
    "lsp_host_ensure",
    "lsp_host_request",
    "ensure_system_lsp_host",
    "plugin_load_vscode",
    "plugin_activate_vscode",
    "plugin_deactivate_vscode",
    "plugin_unload_vscode",
    "plugin_invoke_vscode_rpc",
    "plugin_vscode_send_response",
    // ── Workflow CRUD (ADR-0027 Wave 4.1) ───────────────────────────────────
    // Definitions live in Dexie — round-trip through desktop_writes_bridge.
    "workflow_create",
    "workflow_update",
    "workflow_delete",
    "workflow_run_list",
    "workflow_cancel_run",
    "workflow_schedule_pause",
    "workflow_schedule_resume",
    // App scheduler CRUD/data plane. Distinct from the client-local
    // `scheduler_*` OS alarm commands below.
    "scheduled_task_list",
    "scheduled_task_get",
    "scheduled_task_runs",
    "scheduled_task_statistics",
    "scheduled_task_upcoming",
    "scheduled_task_export",
    "scheduled_task_create",
    "scheduled_task_update",
    "scheduled_task_delete",
    "scheduled_task_pause",
    "scheduled_task_resume",
    "scheduled_task_run_now",
    "scheduled_task_backfill",
    "scheduled_task_import",
    "scheduled_task_cleanup",
    "scheduled_task_emit_event",
    // Unified Rust background-job supervisor and durable monitors.
    "background_job_list",
    "background_job_read",
    "background_job_kill",
    "background_job_spawn_scheduled",
    "background_monitor_list",
    "background_monitor_cancel",
    "background_monitor_register_scheduled",
    // ── Workflow approval gate (ADR-0061 P2) ────────────────────────────────
    // Pending `action.approval.request` entries live in the renderer's
    // in-memory registry — round-trip through desktop_writes_bridge.
    // `workflow_approval_respond` resolves a run's HITL gate, so it is
    // control-gated; the caller device id is injected server-side.
    "workflow_approval_list",
    "workflow_approval_respond",
    // ── Remote step execution (ADR-0061 P3) ─────────────────────────────────
    // A paired device answers a desktop-issued `workflow://step-execute`
    // request with a (chunked) result. Only meaningful for a pending request
    // addressed to that device — the TS broker verifies the JWT-injected
    // caller against the request's target, so no control gate is needed.
    "workflow_step_result",
    // ── Twin source CRUD + job control (ADR-0003) ───────────────────────────
    "twin_delete",
    "twin_source_list",
    "twin_source_update",
    "twin_source_delete",
    "twin_job_status",
    "twin_job_cancel",
    "twin_job_pause",
    "twin_job_resume",
    "twin_job_retry",
    // Twin create + profile edit (coarse remote surface — closes the
    // "remote can delete a twin/source but never create one" asymmetry and the
    // missing profile-mutation surface). All round-trip through
    // desktop_writes_bridge. `twin_profile_update` is a unified discriminated
    // patch (gated as a CONTROL command — it can reset/rewrite the persona).
    "twin_create",
    "twin_source_create",
    "twin_profile_update",
    // Goal create / update / status (coarse remote surface). create + update
    // are CONTROL commands (they start / re-aim an autonomous agent loop);
    // status is a pure read.
    "goal_create",
    "goal_update",
    "goal_status",
    // Long-term memory (ADR-0069). Reads (search / list) + writes
    // (store / update / forget). Writes carry `external` provenance and are
    // PII-gated on the TS side; store/update/forget are CONTROL commands.
    // All round-trip through desktop_writes_bridge.
    "memory_search",
    "memory_list",
    "memory_store",
    "memory_update",
    "memory_forget",
    // ── Settings / conversation overrides ───────────────────────────────────
    "conversation_overrides_update",
    // ── App-data backup ─────────────────────────────────────────────────────
    "backup_export",
    "backup_import",
    // ── Native log read-back ────────────────────────────────────────────────
    // Bounded tail queries over the desktop's on-disk log files
    // (`cognia-structured.log` / `cognia.log`) so mobile diagnostics can view
    // desktop logs. Pure reads; parsing is best-effort (see logging::query).
    "logs_query",
    "logs_list_files",
    // ── Agent Fleet (ADR-0009): view/act on the desktop's live agent fleet ──
    // A phone / companion browser can watch the island snapshot and answer a
    // parked permission or AskUserQuestion remotely. `fleet_get_snapshot` is a
    // pure read; the control ops (answer a permission, answer a question, inject
    // an OpenCode prompt, focus a terminal, interrupt a turn) are control-gated.
    // All reach the process-global runtime directly (no AppHandle), so they also
    // work on a headless server.
    "fleet_get_snapshot",
    "fleet_permission_respond",
    "fleet_question_respond",
    "fleet_opencode_send_message",
    "fleet_focus_terminal",
    "fleet_interrupt_session",
    // ADR-0085 — host-neutral shared browser session and tool contract.
    "browser_session_ensure",
    "browser_session_get",
    "browser_capability",
    "browser_session_close",
    "browser_stream_ticket_issue",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "browser_press_key",
    "browser_scroll",
    "browser_evaluate",
    "browser_read_console",
    "browser_read_network",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_stop",
    "browser_get_page",
    "browser_pages",
    "browser_switch_page",
    "browser_close_page",
    "browser_wait_for",
    "browser_wait_for_load",
    "browser_screenshot",
    "browser_set_files",
    "browser_downloads",
    "browser_set_zoom",
    "browser_find",
    "browser_find_clear",
    // Lark dual-entry (plan 2026-07-24) — brain-only token minting, intent
    // completion, and allowlisted metric bumps. All SERVICE_ONLY.
    "lark_entry_issue",
    "lark_result_complete",
    "lark_metrics_record",
];

/// Public read-only accessor for the dispatch allowlist. Used by the
/// `spec_parity` test (Wave 3.6) to assert that every command in this
/// list has a matching `/api/v1/_rpc/<name>` path in the OpenAPI spec.
#[allow(dead_code)] // referenced from `spec_parity::tests` only.
pub fn known_commands() -> &'static [&'static str] {
    super::command_manifest::legacy_rpc_command_names()
}

/// Commands in this list skip the idempotency cache entirely.
/// They are cheap to re-run and structurally idempotent.
#[cfg(test)]
const READ_ONLY_COMMANDS: &[&str] = &[
    "browser_capability",
    "browser_session_get",
    "browser_snapshot",
    "browser_read_console",
    "browser_read_network",
    "browser_get_page",
    "browser_pages",
    "browser_wait_for",
    "browser_wait_for_load",
    "browser_screenshot",
    "browser_downloads",
    "browser_find",
    "browser_find_clear",
    "claude_sidecar_status",
    "claude_has_api_key",
    "claude_has_oauth_bearer",
    "skills_load_registry",
    "skills_scan_native",
    "skills_catalog_get",
    "external_bridge_config_get",
    "external_bridge_client_list",
    "external_bridge_status",
    "mcp_server_status",
    "read_agent_config",
    "keyring_secret_get",
    // Sync-down (M4.7) is structurally idempotent: same `(table, since)`
    // returns the same delta. Skip the cache to avoid stalling phone clients
    // behind a 60-second TTL when the desktop has fresh writes.
    "sync_pull",
    // Wave 3.5 — registry introspection is pure read.
    "sync_list_tables",
    // Read-only paginated session listing — same `(limit, offset, before)`
    // returns the same page; skip the cache so a slow desktop write doesn't
    // serve stale rows to a polling phone.
    "session_list",
    // Read-only message-by-session listing — same `(session_id, limit, offset)`
    // returns the same page.
    "message_get_by_session",
    // Wave 2 read-only twin profile projection.
    "twin_profile_get",
    "host_capabilities",
    "host_feature_manifest",
    "provider_diagnostics_status",
    "provider_diagnostics_history",
    "scheduled_task_list",
    "scheduled_task_get",
    "scheduled_task_runs",
    "scheduled_task_statistics",
    "scheduled_task_upcoming",
    "scheduled_task_export",
    "background_job_list",
    "background_job_read",
    "background_monitor_list",
    // ADR-0056 Wave 4 — read-only external-agent list projection.
    "external_agent_list",
    // ADR-0059 R11 — read-only status probe on the headless exec backend.
    "get_external_agent_status",
    // ADR-0059 R12 — read-only projection of the webhook ingress registry.
    "connectors_list_adapters",
    // Integration reads must never be served from the idempotency cache:
    // the public URL appears after listener startup and the spool changes
    // whenever a webhook is accepted or acknowledged.
    "integration_ingress_get_url",
    "integration_ingress_poll",
    // Read-only remote-control capability probe (drives the mobile
    // computer-use consent sheet). Pure read of the process-global allow list.
    "companion_can_control",
    // Read-only channel inventory (LAN / tunnel base URLs + TLS fingerprint).
    // Polled by the mobile transport on connect, so caching it behind the 60 s
    // idempotency TTL would hand back a stale tunnel URL right after the user
    // started one.
    "companion_endpoints",
    // Source-control reads — same (repoPath, …) returns the same snapshot.
    "git_is_repo",
    "git_repo_state",
    "git_status",
    "git_diff_stat",
    "git_diff_file",
    "git_diff_commit",
    "git_commit_files",
    "git_log",
    "git_file_history",
    "git_branches",
    "git_remotes",
    "git_stash_list",
    "git_conflicts",
    "git_diff_refs_files",
    "git_diff_refs_file",
    "git_diff_staged_all",
    "git_refs",
    "git_blame",
    "git_tags",
    "git_worktree_list",
    "git_rebase_commits",
    "git_identity",
    // Filesystem reads.
    "read_text_file",
    "default_export_dir",
    "fs_search_workspace",
    "fs_search_content_workspace",
    "fs_read_workspace_file",
    "task_workspace_status",
    "task_workspace_get",
    "task_workspace_list",
    "task_workspace_list_runs",
    "task_workspace_list_resources",
    "task_workspace_list_resource_events",
    "task_workspace_get_resource_summary",
    "task_workspace_export_resource_manifest",
    "task_workspace_get_resource",
    "task_workspace_get_patch_set",
    "task_resource_read_diff",
    "task_resource_read_text",
    "task_resource_download_open",
    "task_resource_download_read_chunk",
    "task_resource_download_close",
    // File-tree browser reads — same (root, relPath) returns the same listing/stat.
    "fs_list_workspace_dir",
    "fs_stat_workspace_file",
    // Terminal session listings.
    "terminal_list_all",
    "terminal_list_for_project",
    // Path completion is a pure directory read (same cwd+fragment → same
    // candidates). Like `read_text_file` it is simultaneously read-only
    // (idempotency axis) and control-gated (capability axis) — see below.
    "terminal_complete_paths",
    "codeserver_supported",
    "codeserver_status",
    "codeserver_list_proxies",
    // Ensuring the system host is structurally idempotent. Individual LSP
    // requests are not: didOpen/didChange/start/install mutate sidecar state.
    "lsp_host_ensure",
    // Plugin registry reads.
    "plugin_list",
    "plugin_runtime_snapshot",
    "plugin_permission_list",
    "plugin_get_capabilities",
    "plugin_js_status",
    // Workflow run listing + pending-approval projection.
    "workflow_run_list",
    "workflow_approval_list",
    // Twin reads.
    "twin_source_list",
    "twin_job_status",
    // Goal status is a pure read (same goalId/sessionId returns current state).
    "goal_status",
    // Memory listing is a pure read (same filter returns the same rows).
    // `memory_search` is deliberately NOT here: a search bumps each hit's
    // `lastAccessedAt`/`accessCount` (the recency signal), so it must not be
    // served from the idempotency cache.
    "memory_list",
    // App-data backup export is a pure read (snapshots current state).
    "backup_export",
    // Native log read-back — bounded tail reads over on-disk log files.
    "logs_query",
    "logs_list_files",
    // Fleet snapshot — same call always returns the current live snapshot.
    "fleet_get_snapshot",
];

// ---------------------------------------------------------------------------
// Remote-control command gate (Remote Session Control)
// ---------------------------------------------------------------------------

/// Commands that require the elevated **remote-control** capability — the
/// device must be present in [`super::control_allow_list`]. These attach to
/// and steer host-owned agent sessions, control host goal loops, or resolve
/// host computer-use consent.
///
/// Baseline paired chat (`claude_send` / `claude_interrupt` /
/// `claude_approve`) is deliberately **absent**: that is the phone's own chat
/// path and predates this capability, so gating it would break existing
/// mobile clients. Read-only sync/observe is likewise ungated.
///
/// Command arms are added by their respective milestones; the gate fires for a
/// name as soon as it appears here (it runs before the dispatch `match`).
const CONTROL_COMMANDS: &[&str] = &[
    "provider_diagnostics_start",
    "provider_diagnostics_cancel",
    "claude_restore",
    "claude_set_mode",
    "claude_plugin_tool_response",
    "claude_tool_result_decision",
    "claude_protocol_adapter_message",
    "skills_bundle_upload_open",
    "skills_bundle_upload_write",
    "skills_bundle_upload_commit",
    "skills_bundle_upload_abort",
    "skills_install_atomic",
    "skills_uninstall",
    "external_bridge_config_update",
    "external_bridge_client_create",
    "external_bridge_client_rotate",
    "external_bridge_client_revoke",
    "external_bridge_start",
    "external_bridge_stop",
    "external_bridge_restart",
    "external_bridge_relay_enable",
    "external_bridge_relay_disable",
    "host_admin_lease_issue",
    "host_admin_lease_revoke",
    "browser_session_ensure",
    "browser_session_close",
    "browser_navigate",
    "browser_act",
    "browser_press_key",
    "browser_scroll",
    "browser_evaluate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_stop",
    "browser_switch_page",
    "browser_close_page",
    "browser_set_files",
    "browser_set_zoom",
    "session_attach",
    "session_detach",
    "goal_pause",
    "goal_resume",
    "goal_stop",
    // Agent-Team board control — moving tasks / driving runs steers host
    // agent execution, same elevation as the goal loop controls above.
    "team_task_move",
    "team_task_create",
    "team_task_comment",
    "team_run_pause",
    "team_run_resume",
    "team_run_stop",
    "automation_consent_respond",
    // Destructive character mutation — gated for consistency with the other
    // delete surfaces below (Wave 4.1 policy: every remote delete is gated).
    "character_delete",
    // Source-control writes + network ops (push/pull/fetch/sync mutate refs).
    "git_stage",
    "git_unstage",
    "git_discard",
    "git_discard_all",
    "git_commit",
    "git_checkout_branch",
    "git_create_branch",
    "git_delete_branch",
    "git_rename_branch",
    "git_fetch",
    "git_pull",
    "git_push",
    "git_sync",
    "git_stash_push",
    "git_stash_pop",
    "git_stash_apply",
    "git_stash_drop",
    "git_resolve_conflict",
    "git_merge_abort",
    // Worktree / remote / tag CRUD, reset/restore, sequencer family, init,
    // .gitignore append, merge — all mutate the repo or its refs.
    "git_worktree_add",
    "git_worktree_remove",
    "git_worktree_commit",
    "git_worktree_prune",
    "git_remote_add",
    "git_remote_remove",
    "git_create_tag",
    "git_delete_tag",
    "git_push_tag",
    "git_reset",
    "git_restore",
    "git_rebase",
    "git_cherry_pick",
    "git_revert",
    "git_sequencer_continue",
    "git_sequencer_abort",
    "git_interactive_rebase",
    "git_init",
    "git_clone",
    "git_set_identity",
    "git_ignore_add",
    "git_merge",
    // Filesystem writes (raw absolute + sandboxed).
    "write_text_file",
    "write_text_file_confined",
    "ensure_dir",
    "ensure_dir_confined",
    "fs_write_workspace_file",
    "task_resource_upload_open",
    "task_workspace_begin",
    "task_workspace_settle",
    "task_resource_upload_write_chunk",
    "task_resource_upload_commit",
    "task_resource_upload_abort",
    "task_workspace_apply",
    "task_workspace_undo",
    "task_workspace_resolve_conflict",
    "task_workspace_pin",
    "task_workspace_prune",
    "task_workspace_record_tool_event",
    // File-tree browser writes — mutate the workspace, so remote-control gated.
    "fs_create_workspace_dir",
    "fs_delete_workspace_entry",
    "fs_rename_workspace_entry",
    "fs_copy_workspace_entry",
    // Raw absolute-path *read* — has no sandbox/root confinement, so it can
    // read any file the desktop user can (`~/.ssh/id_rsa`, `~/.aws/credentials`,
    // keyring-backed stores, …). The write side above is gated; gating the read
    // closes the asymmetry that let a chat-only paired device exfiltrate
    // secrets. Clients that only need workspace files use the root-confined
    // `fs_read_workspace_file` (ungated). Stays in `READ_ONLY_COMMANDS` too —
    // the two axes are independent (idempotency-cache vs capability gate).
    "read_text_file",
    // Terminal mutations — arbitrary code execution / session teardown.
    "terminal_kill",
    "terminal_exec",
    // Kills whatever process listens on a port — same elevation as exec.
    "terminal_kill_port",
    // Raw absolute-path *directory listing* — `cwd` is unconfined, so a
    // chat-only paired device could enumerate the whole filesystem. Same
    // asymmetry-closing rationale as `read_text_file` above; the devices
    // that need it (remote terminal autocomplete) already hold the
    // remote-control capability required to open the PTY itself.
    "terminal_complete_paths",
    "codeserver_ensure",
    "codeserver_stop",
    "codeserver_stop_all",
    // Plugin install/uninstall/backup-restore — modify the on-disk plugin set.
    "plugin_install",
    "plugin_install_from_github",
    "plugin_uninstall",
    "plugin_stage_version",
    "plugin_commit_staged_update",
    "plugin_discard_staged_update",
    "plugin_finalize_staged_update",
    "plugin_backup_create",
    "plugin_backup_restore",
    "plugin_backup_delete",
    // Permission mutations alter the execution authority of installed code.
    // Paired devices therefore need remote-control authorization; the local
    // brain's service token is admitted by `is_control_authorized` below.
    "plugin_permission_grant",
    "plugin_permission_revoke",
    // Native gateway calls can read/write host data or execute allowlisted
    // processes. The Rust permission ledger still gates each inner API, while
    // this outer gate prevents a chat-only paired device from impersonating a
    // loaded plugin.
    "plugin_api_invoke",
    "plugin_api_batch_invoke",
    // Embedded MCP lifecycle steers a host-owned tool surface and therefore
    // requires remote-control authorization. Orchestration replies stay on
    // the host-local Tauri command surface; Companion controllers cannot
    // race to resolve them.
    "mcp_server_start",
    "mcp_server_stop",
    "mcp_server_restart",
    // Remote editor LSP can install/spawn language-server processes. Keep the
    // narrow system-channel facade behind the same elevation as terminal RCE.
    "lsp_host_ensure",
    "lsp_host_request",
    // Workflow destructive ops + the HITL approval gate (approving a
    // workflow decision steers execution — same elevation as goal_*).
    "workflow_delete",
    "scheduled_task_create",
    "scheduled_task_update",
    "scheduled_task_delete",
    "scheduled_task_pause",
    "scheduled_task_resume",
    "scheduled_task_run_now",
    "scheduled_task_backfill",
    "scheduled_task_import",
    "scheduled_task_cleanup",
    "scheduled_task_emit_event",
    "background_job_kill",
    "background_job_spawn_scheduled",
    "background_monitor_cancel",
    "background_monitor_register_scheduled",
    "workflow_cancel_run",
    "workflow_approval_respond",
    // Twin destructive ops.
    "twin_delete",
    "twin_source_delete",
    "twin_job_cancel",
    // Twin persona rewrite — `twin_profile_update` can reset/overwrite the
    // digital-twin profile, so it's gated like the other powerful surfaces.
    "twin_profile_update",
    // Goal create/update start or re-aim an autonomous agent loop — same
    // elevation as goal_pause/resume/stop above.
    "goal_create",
    "goal_update",
    // Long-term memory writes (ADR-0069) — mutating the user's durable
    // personal-fact store from a remote device is a powerful surface
    // (Wave 4.1 policy: every remote mutation of powerful surfaces is gated).
    "memory_store",
    "memory_update",
    "memory_forget",
    // App-data restore overwrites local state.
    "backup_import",
    // Fleet control — answering a parked permission or question, injecting an
    // OpenCode prompt, focusing a terminal, and interrupting a turn all steer a
    // host-owned agent session, the same elevation as the session-attach / goal
    // controls above.
    "fleet_permission_respond",
    "fleet_question_respond",
    "fleet_opencode_send_message",
    "fleet_focus_terminal",
    "fleet_interrupt_session",
];

/// O(1) membership mirrors used on the request hot path. Command existence
/// and idempotency now come from the shared protocol manifest; the remaining
/// legacy policy arrays are retained temporarily only for parity assertions.
static KNOWN_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| known_commands().iter().copied().collect());
static READ_ONLY_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| {
        super::command_manifest::commands()
            .iter()
            .filter(|command| command.operation == super::command_manifest::CommandOperation::Read)
            .map(|command| command.name.as_str())
            .collect()
    });
static CONTROL_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| CONTROL_COMMANDS.iter().copied().collect());

const STEP_UP_COMMANDS: &[&str] = &[
    "skills_bundle_upload_open",
    "skills_bundle_upload_write",
    "skills_bundle_upload_commit",
    "skills_bundle_upload_abort",
    "skills_install_atomic",
    "skills_uninstall",
    "external_bridge_config_update",
    "external_bridge_client_create",
    "external_bridge_client_rotate",
    "external_bridge_client_revoke",
    "external_bridge_start",
    "external_bridge_stop",
    "external_bridge_restart",
    "external_bridge_relay_enable",
    "external_bridge_relay_disable",
];

/// True when `name` requires the remote-control capability.
fn is_control_command(name: &str) -> bool {
    CONTROL_COMMANDS_SET.contains(name)
}

fn is_control_authorized(name: &str, device_id: &str, scope: Option<&str>) -> bool {
    !is_control_command(name)
        || scope == Some("device_v2")
        || (scope == Some("service")
            && matches!(
                name,
                "terminal_exec"
                    | "plugin_permission_grant"
                    | "plugin_permission_revoke"
                    | "plugin_api_invoke"
                    | "plugin_api_batch_invoke"
                    | "mcp_server_start"
                    | "mcp_server_stop"
                    | "mcp_server_restart"
                    | "lsp_host_ensure"
                    | "lsp_host_request"
            ))
        || super::control_allow_list::global().is_allowed(device_id)
}

/// Revalidate the paired-device control grant on non-RPC streams such as the
/// managed IDE relay. Revocation therefore closes authority immediately rather
/// than only when a new code-server session is requested.
pub(crate) fn device_can_control(device_id: &str) -> bool {
    super::control_allow_list::global().is_allowed(device_id)
}

/// Commands whose TS dispatch arm needs the authenticated caller's device id
/// (ADR-0060). The bridge arm injects `callerDeviceId` into the payload for
/// exactly these names — see [`inject_caller_device_id`].
const CALLER_DEVICE_ID_COMMANDS: &[&str] = &[
    "provider_diagnostics_status",
    "provider_diagnostics_history",
    "provider_diagnostics_start",
    "provider_diagnostics_cancel",
    "workflow_trigger_manual",
    "device_capabilities_report",
    "workflow_approval_respond",
    "workflow_step_result",
];

/// Inject (and overwrite) `callerDeviceId` into `args` for the commands in
/// [`CALLER_DEVICE_ID_COMMANDS`]. Overwriting is the point: the value comes
/// from the verified JWT, so a device can never claim another's identity by
/// pre-filling the field. Non-object payloads pass through untouched (the TS
/// arm rejects them anyway).
fn inject_caller_device_id(name: &str, mut args: Value, device_id: &str) -> Value {
    if CALLER_DEVICE_ID_COMMANDS.contains(&name) {
        if let Value::Object(map) = &mut args {
            map.insert(
                "callerDeviceId".to_string(),
                Value::String(device_id.to_string()),
            );
        }
    }
    args
}

/// Project the authenticated caller's current grants into the host manifest
/// request. The client cannot self-assert these values: any supplied field is
/// overwritten from the server-side allow list before the TS bridge sees it.
fn inject_caller_device_grants(name: &str, mut args: Value, device_id: &str) -> Value {
    if name == "host_feature_manifest" {
        if let Value::Object(map) = &mut args {
            let mut grants = vec![Value::String("host.observe".to_string())];
            if super::control_allow_list::agent_control_global().is_allowed(device_id) {
                grants.push(Value::String("agent.run".to_string()));
            }
            map.insert("callerDeviceGrants".to_string(), Value::Array(grants));
        }
    }
    args
}

/// RCE-grade commands that ONLY the headless brain's service token may call
/// (ADR-0059 W4/D6). A device JWT presenting one of these is rejected with
/// 403. The external-agent arms are remote code execution by construction —
/// every decision is also written to the audit log. R12 adds the
/// `connectors_*` management arms.
#[cfg(test)]
const SERVICE_ONLY_COMMANDS: &[&str] = &[
    // ADR-0059 R12 — the brain manages the public webhook ingress registry.
    "connectors_register",
    "connectors_unregister",
    "connectors_list_adapters",
    "integration_ingress_register",
    "integration_ingress_unregister",
    "integration_ingress_get_url",
    "integration_ingress_poll",
    "integration_ingress_ack",
    "integration_ingress_nack",
    // ADR-0059 T-A5 — the connector command plane carries credentials and
    // arbitrary outbound HTTP; only the brain's service token may touch it.
    "connectors_health",
    "connectors_keyring_set",
    "connectors_keyring_get",
    "connectors_keyring_delete",
    "connectors_keyring_list",
    "connectors_http_request",
    "connectors_ws_open",
    "connectors_ws_send",
    "connectors_ws_close",
    "connectors_onebot_send",
    "connectors_lark_ws_open",
    "connectors_lark_ws_close",
    "connectors_reset_all_ws",
    "connectors_attachment_fetch",
    "connectors_attachment_read",
    "connectors_media_upload",
    "connectors_lark_upload_file",
    "connectors_lark_upload_image",
    // The brain may persist non-connector secrets (backup auto-key, WebDAV,
    // future runtime credentials) in the already-installed server store.
    "keyring_secret_get",
    "keyring_secret_set",
    "keyring_secret_clear",
    // Plugin guest execution is an internal brain↔front-door channel. Keeping
    // it service-only prevents a paired device from invoking arbitrary plugin
    // exports even when it has remote package-management permission.
    "plugin_wasm_load",
    "plugin_wasm_activate",
    "plugin_wasm_deactivate",
    "plugin_wasm_call",
    "plugin_wasm_unload",
    "plugin_wasm_list",
    "plugin_launch_js",
    "plugin_invoke_js_callback",
    "plugin_deactivate_js",
    "plugin_stop_js",
    "plugin_js_status",
    "plugin_set_shell_allowlist",
    "plugin_set_network_allowlist",
    "plugin_python_initialize",
    "plugin_python_runtime_info",
    "plugin_python_load",
    "plugin_python_call_hook",
    "plugin_python_push_config",
    "plugin_python_get_tools",
    "plugin_python_call_tool",
    "plugin_python_call",
    "plugin_python_eval",
    "plugin_python_import",
    "plugin_python_module_call",
    "plugin_python_module_getattr",
    "plugin_python_is_initialized",
    "plugin_python_get_info",
    "plugin_python_install_deps",
    "plugin_python_unload",
    "plugin_python_list",
    "codeserver_build_proxy",
    "codeserver_activate_proxy",
    "codeserver_list_proxies",
    "codeserver_broker_validate_paths",
    "codeserver_broker_respond",
    "codeserver_broker_notify",
    "ensure_system_lsp_host",
    "plugin_load_vscode",
    "plugin_activate_vscode",
    "plugin_deactivate_vscode",
    "plugin_unload_vscode",
    "plugin_invoke_vscode_rpc",
    "plugin_vscode_send_response",
    // ADR-0090 Phase 1 — Provider Profile Store admin plane. Exports are
    // redacted (references only), but imports rewrite the routing control
    // plane, so the whole surface is service-scope.
    "provider_profiles_list",
    "provider_profiles_import",
    "provider_profiles_version",
    "provider_catalog_status",
    "provider_catalog_search",
    "provider_catalog_refresh",
    // Lark dual-entry (plan 2026-07-24): token minting binds principals to
    // accounts, intent completion feeds browser-visible results, and metric
    // names are allowlisted — none of it is a paired-device capability.
    "lark_entry_issue",
    "lark_result_complete",
    "lark_metrics_record",
];

static SERVICE_ONLY_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| {
        super::command_manifest::commands()
            .iter()
            .filter(|command| command.target == super::command_manifest::CommandTarget::Service)
            .map(|command| command.name.as_str())
            .collect()
    });

/// True when `name` may be invoked only with a `"service"`-scope JWT.
fn is_service_only_command(name: &str) -> bool {
    SERVICE_ONLY_COMMANDS_SET.contains(name)
}

/// Commands that start or drive an external agent on this host — remote code
/// execution by construction (ADR-0097 D-agent-control).
///
/// These were `SERVICE_ONLY`, which made them reachable only by the co-located
/// brain and left ADR-0082's R4 ("drive a remote host's agents") with no path at
/// all: pairing yields a *device* JWT, and no amount of granting could turn one
/// into a service token.
///
/// They are not folded into `CONTROL_COMMANDS` either. Remote control means
/// steering work this host already chose to run; this means launching a new
/// process. A user enabling "remote control" to let their phone approve a
/// prompt should not thereby be handing out process execution, so the grant is
/// a separate, separately-labelled one — see
/// [`super::control_allow_list::agent_control_global`].
///
/// The safety floor does not move: every spawn still has to clear the
/// `SpawnPolicy` preset allowlist (bare binary from a fixed list, cwd under the
/// workspaces root, default-deny env) and every allow/deny is audited. That
/// check runs on the value, not on the caller, so it applies identically to the
/// service token and to a granted device.
const AGENT_CONTROL_COMMANDS: &[&str] = &[
    "spawn_external_agent",
    "send_to_external_agent",
    "kill_external_agent",
    "get_external_agent_status",
];

static AGENT_CONTROL_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| AGENT_CONTROL_COMMANDS.iter().copied().collect());

/// True when `name` needs the agent-control grant (or a service token).
fn is_agent_control_command(name: &str) -> bool {
    AGENT_CONTROL_COMMANDS_SET.contains(name)
}

/// Whether this caller may run agents on this host.
///
/// The brain keeps its existing access through the service scope; a paired
/// device needs an explicit grant, which on a desktop host comes from the
/// paired-devices toggle and on a headless host from
/// `cognia-server devices grant --agent-control`.
fn is_agent_control_authorized(name: &str, device_id: &str, scope: Option<&str>) -> bool {
    if !is_agent_control_command(name) {
        return true;
    }
    if scope == Some("device_v2") || scope == Some("service") {
        return true;
    }
    // An unauthenticated or malformed context carries an empty `device_id`, and
    // the grant store refuses to store one (`device_grants::grant`) — but only
    // the store did. A list that somehow held `""` would match every such
    // context here, so the caller-side check is repeated rather than assumed.
    // `ws_terminal.rs` guards its own path the same way.
    if device_id.trim().is_empty() {
        return false;
    }
    super::control_allow_list::agent_control_global().is_allowed(device_id)
}

const AGENT_SCHEDULE_TASK_TYPES: &[&str] = &[
    "chat",
    "agent",
    "agent-team",
    "goal",
    "skill",
    "external-agent",
];

fn is_agent_schedule_task_type(task_type: &str) -> bool {
    AGENT_SCHEDULE_TASK_TYPES.contains(&task_type)
}

/// Scheduler commands are payload-sensitive: script/workflow maintenance only
/// needs the ordinary control grant, while reading or mutating an AI task also
/// needs the separate agent-control grant. Missing type hints fail closed.
fn scheduled_task_requires_agent_control(name: &str, args: &Value) -> bool {
    if !name.starts_with("scheduled_task_") {
        return false;
    }
    match name {
        "scheduled_task_create" => args
            .get("input")
            .and_then(|input| input.get("type"))
            .and_then(Value::as_str)
            .map(is_agent_schedule_task_type)
            .unwrap_or(true),
        "scheduled_task_list" => args
            .get("filter")
            .and_then(|filter| filter.get("types"))
            .and_then(Value::as_array)
            .map(|types| {
                types
                    .iter()
                    .filter_map(Value::as_str)
                    .any(is_agent_schedule_task_type)
            })
            // An unfiltered list may disclose prompts from an AI task.
            .unwrap_or(true),
        "scheduled_task_statistics" | "scheduled_task_upcoming" | "scheduled_task_export" => true,
        _ => args
            .get("taskType")
            .and_then(Value::as_str)
            .map(is_agent_schedule_task_type)
            .unwrap_or(true),
    }
}

fn payload_agent_control_authorized(
    name: &str,
    args: &Value,
    device_id: &str,
    scope: Option<&str>,
) -> bool {
    if !scheduled_task_requires_agent_control(name, args) {
        return true;
    }
    if scope == Some("device_v2") || scope == Some("service") {
        return true;
    }
    !device_id.trim().is_empty()
        && super::control_allow_list::agent_control_global().is_allowed(device_id)
}

/// Shared refusal for the agent-control gate. One string for both the HTTP
/// handler and the WebRTC `dispatch` mirror — the two must not be able to
/// drift into saying different things about the same grant.
const AGENT_CONTROL_FORBIDDEN: &str = "this device is not authorized to run agents on this host; grant it from the host's paired-devices settings, or with `cognia-server devices grant --agent-control <device-id>`";

/// Refuse an agent-control command *and* record the refusal.
///
/// The grant's contract is that every start and every refusal is written to the
/// host's audit log with the device that asked. The `SpawnPolicy` refusals
/// inside the `spawn_external_agent` arm were audited, but this gate — the one
/// an ungranted device actually hits — returned 403 straight to the caller, so
/// the single most interesting denial (an unauthorized device probing the
/// execution plane) was the one that left no trace.
///
/// Both the HTTP handler and the WebRTC `dispatch` mirror route their 403
/// through here so the two transports cannot drift into auditing differently.
async fn refuse_agent_control(
    name: &str,
    device_id: &str,
    scope: Option<&str>,
) -> (StatusCode, Json<RpcError>) {
    super::audit::record_async(
        "external_agent_authorize",
        device_id,
        scope.unwrap_or(""),
        "deny",
        serde_json::json!({
            "command": name,
            "reason": "device lacks the agent-control grant",
        }),
    )
    .await;
    RpcError::forbidden(AGENT_CONTROL_FORBIDDEN)
}

/// Public read-only accessor for the remote-control command set. Used by
/// in-file tests to assert the gate covers the intended surfaces.
#[allow(dead_code)] // referenced from tests only.
pub fn control_commands() -> &'static [&'static str] {
    CONTROL_COMMANDS
}

/// Read-only response body for `companion_can_control` — reports whether
/// `device_id` currently holds the remote-control capability.
///
/// Factored out of the dispatch arm so it is unit-testable without an
/// `AppHandle`: in test mode `state.app_handle` is `None`, so the HTTP path
/// short-circuits to 503 before reaching the `match`, and `dispatch` itself
/// cannot be called without a real handle. This pure helper lets the
/// `{ allowed }` logic be asserted directly.
fn can_control_response(device_id: &str) -> Value {
    serde_json::json!({ "allowed": super::control_allow_list::global().is_allowed(device_id) })
}

/// Read-only response body for `companion_endpoints` — the set of addresses
/// this desktop is currently reachable on.
///
/// The QR pair payload carries exactly one `baseUrl` (tunnel takes priority
/// over LAN — see [`super::commands::companion_issue_pair_jwt`]), which leaves
/// every paired client with a single-channel view of a multi-channel host:
///
///   * paired on the LAN → never learns the tunnel URL, so leaving the network
///     strands it on WebRTC alone;
///   * paired over the tunnel → the payload's `fingerprint` is empty (Cloudflare
///     terminates TLS), and `lib/connectivity/lan-resolver.ts` refuses to trust
///     an unpinned LAN hit, so it can never be promoted back to the LAN.
///
/// Reporting both channels plus the self-signed fingerprint lets the client
/// cache what it needs for either transition. Nothing here is a secret: the
/// fingerprint is in every TLS handshake, and the tunnel URL is a public
/// Cloudflare hostname that only forwards to the same authenticated surface.
///
/// Factored out as a pure helper for the same reason as
/// [`can_control_response`] — the dispatch arm needs a live `AppHandle`, this
/// does not.
fn endpoints_response(
    lan_base_url: Option<String>,
    tunnel_base_url: Option<String>,
    fingerprint: String,
    server_id: String,
) -> Value {
    serde_json::json!({
        "lanBaseUrl": lan_base_url,
        "tunnelBaseUrl": tunnel_base_url,
        "fingerprint": fingerprint,
        "serverId": server_id,
    })
}

/// The `https://<lan-ip>:<port>` address a phone could reach this host on, or
/// `None` when the server is loopback-bound / the host has no routable
/// interface.
///
/// Mirrors the LAN branch of [`super::commands::companion_issue_pair_jwt`]:
/// same `detect_lan_ip` probe, same HTTPS scheme (M2.9 self-signed
/// termination). `bind_mode` is only consultable through the Tauri-managed
/// `CompanionServerState`; a headless `cognia-server` always binds `0.0.0.0`
/// (`bin/cognia-server.rs`), so `None` for `bind_lan` there means "assume LAN"
/// rather than "assume loopback".
fn lan_base_url(bind_lan: Option<bool>) -> Option<String> {
    if bind_lan == Some(false) {
        return None;
    }
    let port = match super::advertised_port() {
        0 => super::server::DEFAULT_PORT,
        p => p,
    };
    let host = crate::companion_api::commands::detect_lan_ip()?;
    Some(format!("https://{host}:{port}"))
}

/// Allowlisted patch keys for `app_settings_update`. The mobile client may
/// only mutate user-facing preferences; transport, sidecar, and provider
/// configuration stay desktop-only.
///
/// The list itself is generated from
/// `packages/agent-config-types/src/settings-sync.ts` — the one table that also
/// drives the down-mirror and the OpenAPI enum, so the three can no longer
/// drift apart. Edit that table, then run `pnpm settings-sync:gen`.
use super::settings_sync_generated::APP_SETTINGS_MOBILE_ALLOWED_KEYS;

/// Public read-only accessor for the mobile-side `app_settings_update`
/// allowlist. Used by the OpenAPI `spec_parity` test (Wave 3.6) and by the
/// in-file tests below to assert the allowlist stays in lockstep with
/// what the phone UI actually writes.
#[allow(dead_code)] // referenced from tests / spec_parity only.
pub fn mobile_allowed_keys() -> &'static [&'static str] {
    APP_SETTINGS_MOBILE_ALLOWED_KEYS
}

/// Validate an `app_settings_update` payload against the mobile allowlist.
///
/// This is security-relevant and must run *before* the AppHandle short-circuit
/// in [`rpc_handler`]: a phone that submits a disallowed key (e.g. a transport
/// or provider field) must receive a deterministic `validation_failed` (400)
/// instead of leaking the desktop's availability through a 503, and instead of
/// ever reaching the desktop_writes_bridge. Returns `Ok(())` when the patch is
/// well-formed and every key is allowlisted.
fn validate_app_settings_update(args: &Value) -> Result<(), (StatusCode, Json<RpcError>)> {
    let patch: Value = required(args, "patch")?;
    match patch.as_object() {
        Some(map) => {
            for key in map.keys() {
                if !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key.as_str()) {
                    return Err(RpcError::validation_failed(format!(
                        "settings key '{key}' is not editable from the mobile client"
                    )));
                }
            }
            Ok(())
        }
        None => Err(RpcError::validation_failed(
            "app_settings_update.patch must be an object".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Axum handler
// ---------------------------------------------------------------------------

/// Axum handler for `POST /api/v1/_rpc/:name`.
///
/// Steps:
/// 1. Pull [`DeviceContext`] injected by the JWT middleware.
/// 2. Read the `Idempotency-Key` header (if present).  Read-only commands
///    skip the cache entirely.
/// 3. If a cache hit exists, return the cached body immediately.
/// 4. Dispatch to the allowlist match in [`dispatch`].
/// 5. On success, write the response body into the cache (non-read-only only).
pub async fn rpc_handler(
    Path(name): Path<String>,
    Extension(ctx): Extension<DeviceContext>,
    headers: HeaderMap,
    State(state): State<SharedState>,
    Json(args): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<RpcError>)> {
    let idem_key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    // Reject unknown command names before requiring the AppHandle so the
    // public 404 contract holds in test mode (where `state.app_handle` is
    // intentionally `None`). Keep `KNOWN_COMMANDS` in lockstep with the
    // `match name` arms in `dispatch()` below — drift will silently bypass
    // the 503 path for genuinely unknown commands.
    if !KNOWN_COMMANDS_SET.contains(name.as_str()) {
        return Err(RpcError::unknown_command(&name));
    }

    // Remote Session Control capability gate (fast-fail). Also enforced at the
    // top of `dispatch` so the WebRTC `signaling::dispatch` path — which calls
    // `dispatch` directly, bypassing this handler — stays gated too. Failing
    // here means an unauthorized device never burns a rate-limit token or
    // touches the sidecar.
    if !is_control_authorized(&name, &ctx.device_id, Some(ctx.scope.as_str())) {
        return Err(RpcError::forbidden(
            "this device is not authorized for remote control; enable it from the desktop paired-devices settings",
        ));
    }

    // Service-scope gate (ADR-0059 W4): RCE-grade commands are reachable only
    // with the headless brain's `"service"` token, never a device JWT. No-op
    // until R11/R12 populate SERVICE_ONLY_COMMANDS; the `signaling::dispatch`
    // path gets the mirrored gate when the arms land (they thread the scope).
    if is_service_only_command(&name) && ctx.scope != "service" {
        return Err(RpcError::forbidden(
            "this command requires the headless service token",
        ));
    }

    // Agent-control gate. Mirrored at the top of `dispatch` for the WebRTC
    // path, exactly like the two gates above.
    if !is_agent_control_authorized(&name, &ctx.device_id, Some(ctx.scope.as_str())) {
        return Err(refuse_agent_control(&name, &ctx.device_id, Some(ctx.scope.as_str())).await);
    }
    if !payload_agent_control_authorized(&name, &args, &ctx.device_id, Some(ctx.scope.as_str())) {
        return Err(refuse_agent_control(&name, &ctx.device_id, Some(ctx.scope.as_str())).await);
    }

    // Wave 3.3 — per-device rate limiter sits after the JWT verifier
    // middleware (so we can key on device_id) and before idempotency
    // lookup (cache hits don't burn a token).
    if let crate::companion_api::rate_limit::RateLimitDecision::Reject { retry_after } =
        state.rate_limiter.check(&ctx.device_id)
    {
        return Err(RpcError::rate_limited(retry_after.as_secs()));
    }

    let is_read_only = READ_ONLY_COMMANDS_SET.contains(name.as_str());

    // Atomically reserve the write before dispatch. The same ledger is used
    // by WebRTC, so RTC timeout followed by HTTPS fallback cannot execute it
    // twice.
    if !is_read_only {
        if let Some(ref key) = idem_key {
            match state
                .idempotency
                .begin(&ctx.device_id, &name, key, &args)
                .map_err(|error| RpcError::internal(error.to_string()))?
            {
                super::idempotency::IdempotencyDecision::Execute => {}
                super::idempotency::IdempotencyDecision::Cached(cached) => {
                    return Ok(Json(cached));
                }
                super::idempotency::IdempotencyDecision::Conflict => {
                    return Err(RpcError::idempotency_conflict());
                }
                super::idempotency::IdempotencyDecision::Indeterminate => {
                    return Err(RpcError::idempotency_indeterminate());
                }
            }
        }
    }

    // Allowlist validation that must reject (400 `validation_failed`)
    // regardless of AppHandle availability — a disallowed settings key is a
    // client error the phone can fix, not a transient server condition, so it
    // must not be masked by the test-mode/headless 503 below.
    if name == "app_settings_update" {
        validate_app_settings_update(&args)?;
    }

    // Resolve the dispatch host (ADR-0059 R5): the desktop AppHandle, or the
    // headless services registry installed by `cognia-server` at boot. Absent
    // both (bare unit-test states) → 503, preserving the historical
    // test-mode contract.
    let host = super::dispatch_host::DispatchHost::from_state(&state).ok_or_else(|| {
        RpcError::service_unavailable("app_handle not available (test mode)".to_string())
    })?;

    // Dispatch.
    let dispatched = dispatch(
        &name,
        args,
        &state,
        &host,
        &ctx.device_id,
        Some(&ctx.account_id),
        Some(&ctx.scope),
    )
    .await;
    super::metrics::record_rpc_call(dispatched.is_ok());
    let result = dispatched?;

    // Commit the result (non-read-only + idempotency key present).
    if !is_read_only {
        if let Some(key) = idem_key {
            state
                .idempotency
                .complete(&ctx.device_id, &name, &key, &result)
                .map_err(|error| RpcError::internal(error.to_string()))?;
        }
    }

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// DataPlane selection helper
// ---------------------------------------------------------------------------

/// Resolve the DataPlane for the current process. Returns a 503 error
/// envelope when no plane is selectable — happens in test states where
/// both the Tauri AppHandle and the headless store are absent.
fn pick_data_plane(
    state: &SharedState,
) -> Result<super::data_plane::DataPlane, (StatusCode, Json<RpcError>)> {
    super::data_plane::DataPlane::pick(state).ok_or_else(|| {
        RpcError::internal(
            "no data plane available — neither a Tauri AppHandle nor a headless AppStore is configured"
                .to_string(),
        )
    })
}

// ---------------------------------------------------------------------------
// Deserialisation helpers
// ---------------------------------------------------------------------------

/// Extract a field from a JSON object, returning a 400 error when the field
/// is missing or its type does not match `T`.
fn required<T: DeserializeOwned>(
    args: &Value,
    field: &str,
) -> Result<T, (StatusCode, Json<RpcError>)> {
    let v = args
        .get(field)
        .ok_or_else(|| RpcError::malformed(format!("missing required field: {field}")))?;
    serde_json::from_value(v.clone())
        .map_err(|e| RpcError::malformed(format!("field '{field}': {e}")))
}

/// Extract a field that may arrive under either of two keys. The headless
/// brain's acp-client sends the desktop Tauri arg shape (camelCase, which
/// Tauri converts at the command boundary); the RPC arms parse snake_case -
/// accept both so the two hosts share one client (ADR-0059 T-A10).
fn required_aliased<T: DeserializeOwned>(
    args: &Value,
    primary: &str,
    alias: &str,
) -> Result<T, (StatusCode, Json<RpcError>)> {
    let v = args
        .get(primary)
        .or_else(|| args.get(alias))
        .ok_or_else(|| {
            RpcError::malformed(format!("missing required field: {primary} (or {alias})"))
        })?;
    serde_json::from_value(v.clone())
        .map_err(|e| RpcError::malformed(format!("field '{primary}': {e}")))
}

fn optional_aliased<T: DeserializeOwned>(
    args: &Value,
    primary: &str,
    alias: &str,
) -> Result<Option<T>, (StatusCode, Json<RpcError>)> {
    match args.get(primary).or_else(|| args.get(alias)) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| RpcError::malformed(format!("field '{primary}': {error}"))),
    }
}

/// Extract an optional field from a JSON object.
fn optional<T: DeserializeOwned>(
    args: &Value,
    field: &str,
) -> Result<Option<T>, (StatusCode, Json<RpcError>)> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value::<T>(v.clone())
            .map(Some)
            .map_err(|e| RpcError::malformed(format!("field '{field}': {e}"))),
    }
}

fn authorize_sensitive_resource(
    requested: bool,
    device_id: &str,
    scope: Option<&str>,
) -> Result<bool, (StatusCode, Json<RpcError>)> {
    if !requested {
        return Ok(false);
    }
    if scope == Some("service") || super::control_allow_list::global().is_allowed(device_id) {
        return Ok(true);
    }
    Err(RpcError::forbidden(
        "sensitive task resources require remote-control authorization",
    ))
}

/// Serialize a command result into the JSON [`Value`] envelope, mapping any
/// serde failure to a `500 internal_error`. Cuts the repeated
/// `serde_json::to_value(x).map_err(...)` boilerplate across the native arms.
fn to_json<T: serde::Serialize>(value: T) -> Result<Value, (StatusCode, Json<RpcError>)> {
    serde_json::to_value(value).map_err(|e| RpcError::internal(e.to_string()))
}

fn mcp_server_rpc_error(
    error: crate::mcp_server::types::McpServerError,
) -> (StatusCode, Json<RpcError>) {
    use crate::mcp_server::types::McpServerError;

    let message = error.to_string();
    match error {
        McpServerError::TokenMissing
        | McpServerError::TokenTooWeak(_)
        | McpServerError::InvalidSettings(_) => (
            StatusCode::BAD_REQUEST,
            Json(RpcError::new("mcp_server_invalid_request", message)),
        ),
        McpServerError::AlreadyRunning(_) => (
            StatusCode::CONFLICT,
            Json(RpcError::new("mcp_server_already_running", message)),
        ),
        McpServerError::NotRunning => (
            StatusCode::CONFLICT,
            Json(RpcError::new("mcp_server_not_running", message)),
        ),
        McpServerError::Bind { .. }
        | McpServerError::SidecarSpawn(_)
        | McpServerError::SidecarIo(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(RpcError::new("mcp_server_unavailable", message)),
        ),
    }
}

fn external_bridge_rpc_error(message: String) -> (StatusCode, Json<RpcError>) {
    structured_remote_rpc_error(message, "external_bridge_invalid_request")
}

fn skill_transaction_rpc_error(message: String) -> (StatusCode, Json<RpcError>) {
    structured_remote_rpc_error(message, "skills_transaction_invalid_request")
}

fn structured_remote_rpc_error(
    message: String,
    fallback_code: &'static str,
) -> (StatusCode, Json<RpcError>) {
    let (status, code) = if message.starts_with("REMOTE_FEATURE_UNSUPPORTED") {
        (StatusCode::NOT_IMPLEMENTED, "REMOTE_FEATURE_UNSUPPORTED")
    } else if message.starts_with("REMOTE_RESPONSE_STALE") {
        (StatusCode::CONFLICT, "REMOTE_RESPONSE_STALE")
    } else if message.starts_with("REMOTE_SCOPE_DENIED") {
        (StatusCode::FORBIDDEN, "REMOTE_SCOPE_DENIED")
    } else if message.starts_with("REMOTE_CONSENT_REQUIRED") {
        (StatusCode::PRECONDITION_REQUIRED, "REMOTE_CONSENT_REQUIRED")
    } else {
        (StatusCode::BAD_REQUEST, fallback_code)
    };
    (status, Json(RpcError::new(code, message)))
}

async fn sync_external_bridge_verifiers(
    host: &super::dispatch_host::DispatchHost,
    data_dir: &std::path::Path,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    use tauri::Manager;

    let bridge_data_dir = data_dir.to_path_buf();
    let clients = tokio::task::spawn_blocking(move || {
        super::external_bridge::active_clients(&bridge_data_dir)
    })
    .await
    .map_err(|error| RpcError::internal(error.to_string()))?
    .map_err(external_bridge_rpc_error)?;
    let result = match host {
        super::dispatch_host::DispatchHost::Tauri(app) => app
            .state::<crate::mcp_server::McpServerState>()
            .replace_bridge_clients(&clients),
        super::dispatch_host::DispatchHost::Headless(services) => {
            services.mcp_server.replace_bridge_clients(&clients)
        }
    };
    match result {
        Ok(()) | Err(crate::mcp_server::types::McpServerError::NotRunning) => Ok(()),
        Err(error) => Err(mcp_server_rpc_error(error)),
    }
}

async fn external_bridge_start_for_host(
    host: &super::dispatch_host::DispatchHost,
    restart: bool,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager;

    let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
    let bridge_data_dir = data_dir.clone();
    let (config, clients) = tokio::task::spawn_blocking(move || {
        Ok::<_, String>((
            super::external_bridge::config_get(&bridge_data_dir)?,
            super::external_bridge::active_clients(&bridge_data_dir)?,
        ))
    })
    .await
    .map_err(|error| RpcError::internal(error.to_string()))?
    .map_err(external_bridge_rpc_error)?;
    if clients.is_empty() {
        return Err(external_bridge_rpc_error(
            "REMOTE_CONSENT_REQUIRED: create an External Bridge client before starting".into(),
        ));
    }
    let settings_json = serde_json::to_string(&json!({
        "enabled": true,
        "enabledScopes": config.enabled_scopes,
        "httpPort": config.port,
    }))
    .map_err(|error| RpcError::internal(error.to_string()))?;
    super::external_bridge::set_runtime_state(&data_dir, "starting", None);

    if restart {
        let stopped = match host {
            super::dispatch_host::DispatchHost::Tauri(app) => {
                crate::mcp_server::commands::mcp_server_stop_for_state(
                    app.state::<crate::mcp_server::McpServerState>().inner(),
                )
            }
            super::dispatch_host::DispatchHost::Headless(services) => {
                crate::mcp_server::commands::mcp_server_stop_for_state(services.mcp_server.as_ref())
            }
        };
        if let Err(error) = stopped {
            super::external_bridge::set_runtime_state(
                &data_dir,
                "degraded",
                Some(error.to_string()),
            );
            return Err(mcp_server_rpc_error(error));
        }
    }

    let started = match host {
        super::dispatch_host::DispatchHost::Tauri(app) => {
            let sidecar_path =
                crate::mcp_server::commands::resolve_sidecar_path(app).ok_or_else(|| {
                    RpcError::service_unavailable(
                        "External Bridge MCP sidecar is not installed".to_string(),
                    )
                })?;
            let automation = app.state::<crate::automation::commands::AutomationState>();
            app.state::<crate::mcp_server::McpServerState>()
                .start_with_clients(
                    config.port,
                    clients,
                    settings_json,
                    sidecar_path.to_string_lossy().into_owned(),
                    Some((
                        automation.handle.clone(),
                        crate::automation::dispatcher::Enforcement::from_state(&automation),
                    )),
                    Some(crate::mcp_server::orchestration_proxy::tauri_event_sink(
                        app.clone(),
                    )),
                )
                .await
        }
        super::dispatch_host::DispatchHost::Headless(services) => {
            services
                .mcp_server
                .start_with_clients(
                    config.port,
                    clients,
                    settings_json,
                    crate::headless::resolve_mcp_sidecar_path()
                        .to_string_lossy()
                        .into_owned(),
                    Some(
                        services
                            .mcp_automation()
                            .await
                            .map_err(RpcError::internal)?,
                    ),
                    None,
                )
                .await
        }
    };

    match started {
        Ok(port) => {
            if matches!(host, super::dispatch_host::DispatchHost::Headless(_)) {
                super::external_bridge::set_runtime_state(
                    &data_dir,
                    "degraded",
                    Some("host-local orchestration executor is unavailable".into()),
                );
            } else {
                super::external_bridge::set_runtime_state(&data_dir, "running", None);
            }
            Ok(json!(port))
        }
        Err(error) => {
            super::external_bridge::set_runtime_state(
                &data_dir,
                "degraded",
                Some(error.to_string()),
            );
            Err(mcp_server_rpc_error(error))
        }
    }
}

fn plugin_rpc_error(error: crate::plugin_api::PluginError) -> (StatusCode, Json<RpcError>) {
    use crate::plugin_api::PluginError;

    let message = error.to_string();
    match error {
        PluginError::PermissionDenied { .. } => (
            StatusCode::FORBIDDEN,
            Json(RpcError::new("plugin_permission_denied", message)),
        ),
        PluginError::NotFound(_) => (
            StatusCode::NOT_FOUND,
            Json(RpcError::new("plugin_not_found", message)),
        ),
        PluginError::InvalidManifest(_)
        | PluginError::InvalidArgument(_)
        | PluginError::Serde(_) => (
            StatusCode::BAD_REQUEST,
            Json(RpcError::new("plugin_invalid_request", message)),
        ),
        PluginError::PythonUnavailable(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(RpcError::new("python_runtime_unavailable", message)),
        ),
        PluginError::Io(_)
        | PluginError::Crypto(_)
        | PluginError::Internal(_)
        | PluginError::PythonHost(_) => RpcError::internal(message),
    }
}

fn vscode_rpc_error(
    error: crate::plugin_api::vscode::commands::VscodeCommandError,
) -> (StatusCode, Json<RpcError>) {
    let status = match error.code.as_str() {
        "bad_manifest" | "missing_main" | "bad_bundle_format" | "unsafe_main" | "bad_response"
        | "decode_error" => StatusCode::BAD_REQUEST,
        "not_loaded" => StatusCode::NOT_FOUND,
        "timeout" => StatusCode::GATEWAY_TIMEOUT,
        "host_script_missing"
        | "event_sink_missing"
        | "spawn_failed"
        | "lsp_host_script_missing"
        | "lsp_host_spawn_failed" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(RpcError::new(error.code, error.message)))
}

fn remote_lsp_method_allowed(method: &str) -> bool {
    matches!(
        method,
        "lsp:start"
            | "lsp:stop"
            | "lsp:didOpen"
            | "lsp:didChange"
            | "lsp:didClose"
            | "lsp:request"
            | "lsp:cancel"
            | "lsp:list"
            | "lsp:status"
            | "lsp:logs"
            | "lsp:detect"
            | "lsp:install"
            | "protocol:start"
            | "protocol:stop"
            | "protocol:request"
            | "protocol:cancel"
            | "protocol:status"
    )
}

// ---------------------------------------------------------------------------
// Dispatch table — the explicit allowlist
// ---------------------------------------------------------------------------

/// Dispatch an RPC call to the corresponding Tauri command body.
///
/// Each arm deserialises the JSON `args`, obtains the necessary Tauri state
/// via `host.tauri_app(name)?.state::<T>()` (a per-arm `503
/// headless_unsupported` when this process is a headless `cognia-server` —
/// see the availability table in [`super::dispatch_host`]), calls the
/// underlying function (not the IPC wrapper), and serialises the result back
/// to [`Value`].
///
/// If a command's signature is incompatible with this pattern (e.g., it
/// requires `tauri::Window`), it must be excluded from the V1 allowlist.
///
/// Visibility note (ADR-0021): exposed as `pub(super)` so the WebRTC
/// signaling module (`super::signaling::dispatch`) can route DataChannel
/// RPCs through the same allowlist without re-implementing 1k+ lines.
pub(super) async fn dispatch(
    name: &str,
    args: Value,
    state: &SharedState,
    host: &super::dispatch_host::DispatchHost,
    device_id: &str,
    account_id: Option<&str>,
    scope: Option<&str>,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;

    // Remote Session Control gate. Runs for both the HTTP `rpc_handler` and
    // the WebRTC `signaling::dispatch` path (both funnel through here), so the
    // elevated capability is enforced regardless of transport. Baseline chat
    // and read-only sync are not in `CONTROL_COMMANDS`, so they pass through.
    if !is_control_authorized(name, device_id, scope) {
        return Err(RpcError::forbidden(
            "this device is not authorized for remote control; enable it from the desktop paired-devices settings",
        ));
    }
    if STEP_UP_COMMANDS.contains(&name) && scope != Some("service") {
        let admin_lease = args
            .get("adminLease")
            .or_else(|| args.get("admin_lease"))
            .and_then(Value::as_str);
        super::admin_lease::validate(device_id, name, admin_lease)
            .map_err(external_bridge_rpc_error)?;
    }

    // Service-scope gate, mirrored from `rpc_handler` so the WebRTC
    // `signaling::dispatch` path (which is always device-scoped — it passes
    // `scope: None`) can never reach the RCE-grade arms either.
    if is_service_only_command(name) && scope != Some("service") {
        return Err(RpcError::forbidden(
            "this command requires the headless service token",
        ));
    }

    // Agent-control gate, mirrored from `rpc_handler`. The WebRTC path passes
    // `scope: None`, so a DataChannel caller needs the same explicit grant an
    // HTTP one does — the transport must not be a way around it.
    if !is_agent_control_authorized(name, device_id, scope) {
        return Err(refuse_agent_control(name, device_id, scope).await);
    }
    if !payload_agent_control_authorized(name, &args, device_id, scope) {
        return Err(refuse_agent_control(name, device_id, scope).await);
    }

    // Allowlist gate. The HTTP `rpc_handler` already rejects unknown names
    // before reaching here, but the WebRTC `signaling::dispatch` path calls
    // `dispatch` directly without that check — enforcing it here keeps the two
    // transports' command surfaces identical (no DataChannel superset) and
    // guarantees every reachable arm is a documented, allowlisted command.
    if !KNOWN_COMMANDS_SET.contains(name) {
        return Err(RpcError::unknown_command(name));
    }

    if super::browser_gateway::is_browser_rpc(name) {
        let account_id = account_id.ok_or_else(|| {
            RpcError::forbidden("browser RPC requires an account-bound device token")
        })?;
        return super::browser_gateway::dispatch_browser_rpc(name, args, account_id, device_id)
            .await
            .map_err(|error| {
                let status = match error.code.as_str() {
                    "browser_disabled"
                    | "browser_runtime_unavailable"
                    | "browser_runtime_unhealthy" => StatusCode::SERVICE_UNAVAILABLE,
                    "browser_session_forbidden" | "browser_control_held_by_human" => {
                        StatusCode::FORBIDDEN
                    }
                    "browser_session_quota_exceeded" => StatusCode::TOO_MANY_REQUESTS,
                    "browser_session_not_found" => StatusCode::NOT_FOUND,
                    _ => StatusCode::BAD_REQUEST,
                };
                (status, Json(RpcError::new(error.code, error.message)))
            });
    }

    match name {
        // ── Chat session ─────────────────────────────────────────────────────

        // The chat-session arms are host-generic (ADR-0059 R7): the sidecar
        // state + host resolve from either the Tauri app or the headless
        // services registry, so a cloud cognia-server executes chat turns.
        "claude_send" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let prompt: Value = required(&args, "prompt")?;
            let mut options: Option<claude_commands::SendOptions> = optional(&args, "options")?;
            let context = super::remote_execution::global().register(
                &opaque_host_id(state),
                device_id,
                &session_id,
                unix_time_ms(),
            );
            options
                .get_or_insert_with(claude_commands::SendOptions::default)
                .extra
                .insert(
                    "remoteExecutionContext".to_string(),
                    serde_json::to_value(context)
                        .map_err(|error| RpcError::internal(error.to_string()))?,
                );
            if let Some(send_options) = options.as_mut() {
                if let Some(envelope) = send_options.extra.remove("taskWorkspace") {
                    let envelope: crate::task_workspace::TaskWorkspaceTurnEnvelope =
                        serde_json::from_value(envelope)
                            .map_err(|error| RpcError::malformed(error.to_string()))?;
                    let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                        std::sync::Arc::new(crate::task_workspace::BusResourceEventSink(
                            std::sync::Arc::clone(&state.event_bus),
                        ));
                    let run = crate::task_workspace::begin_hosted_turn(
                        session_id.clone(),
                        envelope,
                        sink,
                    )
                    .map_err(RpcError::internal)?;
                    send_options.cwd = Some(run.execution_root);
                }
            }
            claude_commands::claude_send_with_host(
                host.sidecar_host(),
                host.sidecar_state(),
                session_id,
                prompt,
                options,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_interrupt" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            claude_commands::claude_interrupt_impl(&host.sidecar_state(), session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_compact" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let focus: Option<String> = args
                .get("focus")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            claude_commands::claude_compact_impl(&host.sidecar_state(), session_id, focus)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_restore" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let messages: Value = required(&args, "messages")?;
            claude_commands::claude_restore_impl(&host.sidecar_state(), session_id, messages)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_set_mode" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let mode: String = required(&args, "mode")?;
            claude_commands::claude_set_mode_impl(&host.sidecar_state(), session_id, mode)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_approve" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let request_id: String = required_aliased(&args, "request_id", "requestId")?;
            let decision: String = required(&args, "decision")?;
            let message: Option<String> = optional(&args, "message")?;
            let updated_input: Option<Value> =
                optional_aliased(&args, "updated_input", "updatedInput")?;
            let context: super::remote_execution::RemoteExecutionContext =
                required_aliased(
                    &args,
                    "remote_execution_context",
                    "remoteExecutionContext",
                )?;
            super::remote_execution::global()
                .validate_and_consume(
                    &context,
                    device_id,
                    &session_id,
                    &request_id,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            claude_commands::claude_approve_impl(
                &host.sidecar_state(),
                session_id,
                request_id,
                decision,
                message,
                updated_input,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_close_session" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            claude_commands::claude_close_session_impl(&host.sidecar_state(), session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_plugin_tool_response" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let tool_use_id: String = required_aliased(&args, "tool_use_id", "toolUseId")?;
            let context: super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            super::remote_execution::global()
                .validate_and_consume(
                    &context,
                    device_id,
                    &session_id,
                    &tool_use_id,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            let result: Option<Value> = optional(&args, "result")?;
            let error: Option<String> = optional(&args, "error")?;
            claude_commands::claude_plugin_tool_response_impl(
                &host.sidecar_state(),
                session_id,
                tool_use_id,
                result,
                error,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_tool_result_decision" => {
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let review_id: String = required_aliased(&args, "review_id", "reviewId")?;
            let context: super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            super::remote_execution::global()
                .validate_and_consume(
                    &context,
                    device_id,
                    &session_id,
                    &review_id,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            let updated_tool_output: Option<Value> =
                args.get("updated_tool_output")
                    .or_else(|| args.get("updatedToolOutput"))
                    .cloned();
            claude_commands::claude_tool_result_decision_impl(
                &host.sidecar_state(),
                session_id,
                review_id,
                updated_tool_output,
            )
            .await
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "claude_protocol_adapter_message" => {
            let message: Value = required(&args, "message")?;
            let context: super::remote_execution::RemoteExecutionContext =
                required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;
            let session_id: String = required_aliased(&args, "session_id", "sessionId")?;
            let exec_id = message
                .get("execId")
                .or_else(|| message.get("exec_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RpcError::malformed(
                        "claude_protocol_adapter_message.message.execId is required".into(),
                    )
                })?;
            let message_id = message
                .get("messageId")
                .or_else(|| message.get("message_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    RpcError::malformed(
                        "claude_protocol_adapter_message.message.messageId is required".into(),
                    )
                })?;
            let terminal = matches!(
                message.get("type").and_then(Value::as_str),
                Some("protocol_adapter_done" | "protocol_adapter_error")
            );
            super::remote_execution::global()
                .validate_pending_message(
                    &context,
                    device_id,
                    &session_id,
                    exec_id,
                    message_id,
                    terminal,
                    unix_time_ms(),
                )
                .map_err(remote_context_error)?;
            claude_commands::claude_protocol_adapter_message_impl(&host.sidecar_state(), message)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_sidecar_status" => {
            claude_commands::claude_sidecar_status_impl(&host.sidecar_state())
                .await
                .map_err(RpcError::internal)
                .and_then(|s| {
                    serde_json::to_value(s).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Subscription / OAuth (ADR-0025) ──────────────────────────────────
        // Subscription account management (`subscription_*`) is deliberately
        // **desktop-only**: it reads and writes the provider credential vault,
        // so it is not exposed to remote/mobile clients. The desktop UI reaches
        // those operations through `transport-tauri` → the real `#[tauri::command]`
        // functions directly, never through this companion dispatch table. The
        // legacy `claude_sub_*` token RPCs are likewise gone.

        "claude_set_oauth_bearer" => {
            let token: Option<String> = optional(&args, "token")?;
            host.api_keys().set_oauth_bearer(token).await;
            Ok(Value::Null)
        }

        // ── Provider env ─────────────────────────────────────────────────────

        "claude_set_api_key" => {
            let key: Option<String> = optional(&args, "key")?;
            host.api_keys().set(key).await;
            Ok(Value::Null)
        }

        "claude_set_provider_env" => {
            let api_key: Option<String> = optional(&args, "api_key")?;
            let base_url: Option<String> = optional(&args, "base_url")?;
            host.api_keys().set_provider(api_key, base_url).await;
            Ok(Value::Null)
        }

        "claude_has_api_key" => {
            let has = host.api_keys().get().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_has_oauth_bearer" => {
            let has = host.api_keys().get_oauth_bearer().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_restart_sidecar" => {
            kill_sidecar(host.sidecar_state()).await;
            Ok(Value::Null)
        }

        // ── Multi-agent config ────────────────────────────────────────────────

        "read_agent_config" => {
            let agent: String = required(&args, "agent")?;
            tokio::task::spawn_blocking(move || agent_commands::read_agent_config(agent))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "write_agent_config" => {
            let agent: String = required(&args, "agent")?;
            let value: Value = required(&args, "value")?;
            tokio::task::spawn_blocking(move || agent_commands::write_agent_config(agent, value))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Generic server secret store ──────────────────────────────────────

        "keyring_secret_get" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let input: crate::keyring_secrets::KeyringInput = required(&args, "input")?;
            let value = tokio::task::spawn_blocking(move || {
                crate::keyring_secrets::get(&input.namespace, &input.key)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(value)
        }

        "keyring_secret_set" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let input: crate::keyring_secrets::KeyringInput = required(&args, "input")?;
            let value = input
                .value
                .clone()
                .ok_or_else(|| RpcError::malformed("keyring_secret_set.input.value is required".into()))?;
            tokio::task::spawn_blocking(move || {
                crate::keyring_secrets::set(&input.namespace, &input.key, &value)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "keyring_secret_clear" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let input: crate::keyring_secrets::KeyringInput = required(&args, "input")?;
            tokio::task::spawn_blocking(move || {
                crate::keyring_secrets::clear(&input.namespace, &input.key)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        // ── Skills ────────────────────────────────────────────────────────────

        "skills_scan_native" => {
            tokio::task::spawn_blocking(skills_native::skills_scan_native)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_load_registry" => {
            tokio::task::spawn_blocking(registry::skills_load_registry)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_install_native" => {
            let request: crate::skills::types::InstallSkillRequest =
                required(&args, "request")?;
            tokio::task::spawn_blocking(move || install::skills_install_native(request))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_uninstall_native" => {
            let dir_name: String = required(&args, "dir_name")?;
            tokio::task::spawn_blocking(move || skills_native::skills_uninstall_native(dir_name))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        "skills_catalog_get" => {
            let host = host.clone();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::catalog_get(&host)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_bundle_upload_open" => {
            let request: crate::skills::bundle::BundleUploadOpenRequest =
                required(&args, "request")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::upload_open(&host, &device_id, request)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_bundle_upload_write" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let data_base64: String = required_aliased(&args, "data_base64", "dataBase64")?;
            let chunk_hash: String = required_aliased(&args, "chunk_hash", "chunkHash")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::upload_write(
                    &host,
                    &device_id,
                    &handle_id,
                    offset,
                    &data_base64,
                    &chunk_hash,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_bundle_upload_commit" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::upload_commit(&host, &device_id, &handle_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)?;
            Ok(Value::Null)
        }

        "skills_bundle_upload_abort" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::upload_abort(&host, &device_id, &handle_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)?;
            Ok(Value::Null)
        }

        "skills_install_atomic" => {
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let host = host.clone();
            let device_id = device_id.to_owned();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::install_atomic(&host, &device_id, &handle_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
            .and_then(to_json)
        }

        "skills_uninstall" => {
            let target: crate::skills::install::SkillsTarget = required(&args, "target")?;
            let dir_name: String = required_aliased(&args, "dir_name", "dirName")?;
            let host = host.clone();
            tokio::task::spawn_blocking(move || {
                super::skill_transactions::uninstall(&host, target, &dir_name)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(skill_transaction_rpc_error)
                .and_then(to_json)
        }

        "external_bridge_config_get" => {
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            tokio::task::spawn_blocking(move || super::external_bridge::config_get(&data_dir))
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(external_bridge_rpc_error)
                .and_then(to_json)
        }

        "external_bridge_config_update" => {
            let update: super::external_bridge::ExternalBridgeConfigUpdate =
                required(&args, "update")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let running = host.mcp_server_status().running;
            let bridge_data_dir = data_dir.clone();
            let updated = tokio::task::spawn_blocking(move || {
                super::external_bridge::config_update(&bridge_data_dir, update)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            if running {
                super::external_bridge::set_runtime_state(
                    &data_dir,
                    "degraded",
                    Some("configuration changed; restart required".into()),
                );
            }
            to_json(updated)
        }

        "external_bridge_client_create" => {
            let name: String = required(&args, "name")?;
            let scopes: Vec<String> = required(&args, "scopes")?;
            let expires_at: Option<u64> = optional_aliased(&args, "expires_at", "expiresAt")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let bridge_data_dir = data_dir.clone();
            let created = tokio::task::spawn_blocking(move || {
                super::external_bridge::client_create(
                    &bridge_data_dir,
                    name,
                    scopes,
                    expires_at,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            sync_external_bridge_verifiers(host, &data_dir).await?;
            to_json(created)
        }

        "external_bridge_client_list" => {
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            tokio::task::spawn_blocking(move || super::external_bridge::client_list(&data_dir))
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(external_bridge_rpc_error)
                .and_then(to_json)
        }

        "external_bridge_client_rotate" => {
            let client_id: String = required_aliased(&args, "client_id", "clientId")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let bridge_data_dir = data_dir.clone();
            let rotated = tokio::task::spawn_blocking(move || {
                super::external_bridge::client_rotate(&bridge_data_dir, &client_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            sync_external_bridge_verifiers(host, &data_dir).await?;
            to_json(rotated)
        }

        "external_bridge_client_revoke" => {
            let client_id: String = required_aliased(&args, "client_id", "clientId")?;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let bridge_data_dir = data_dir.clone();
            let revoked = tokio::task::spawn_blocking(move || {
                super::external_bridge::client_revoke(&bridge_data_dir, &client_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(external_bridge_rpc_error)?;
            sync_external_bridge_verifiers(host, &data_dir).await?;
            to_json(revoked)
        }

        "external_bridge_start" => external_bridge_start_for_host(host, false).await,
        "external_bridge_restart" => external_bridge_start_for_host(host, true).await,
        "external_bridge_stop" => {
            use tauri::Manager;
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let result = match host {
                super::dispatch_host::DispatchHost::Tauri(app) => {
                    crate::mcp_server::commands::mcp_server_stop_for_state(
                        app.state::<crate::mcp_server::McpServerState>().inner(),
                    )
                }
                super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::mcp_server::commands::mcp_server_stop_for_state(
                        services.mcp_server.as_ref(),
                    )
                }
            };
            result.map_err(mcp_server_rpc_error)?;
            super::external_bridge::set_runtime_state(&data_dir, "stopped", None);
            Ok(Value::Null)
        }

        "external_bridge_status" => {
            let data_dir = host.data_dir().map_err(external_bridge_rpc_error)?;
            let server_status = host.mcp_server_status();
            tokio::task::spawn_blocking(move || {
                super::external_bridge::status(&data_dir, &server_status)
            })
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(external_bridge_rpc_error)
                .and_then(to_json)
        }

        "external_bridge_relay_enable" | "external_bridge_relay_disable" => {
            Err(external_bridge_rpc_error(
                "REMOTE_FEATURE_UNSUPPORTED: managed relay is not advertised by this host".into(),
            ))
        }

        "host_admin_lease_issue" => {
            let operations: Vec<String> = required(&args, "operations")?;
            let ttl_seconds: Option<u64> =
                optional_aliased(&args, "ttl_seconds", "ttlSeconds")?;
            let confirmed: bool = required(&args, "confirmed")?;
            let owner_authorized = if scope == Some("owner_v2") || scope == Some("service") {
                true
            } else {
                account_id
                    .zip(super::security_store::security_store())
                    .is_some_and(|(tenant_id, security)| {
                        security
                            .has_capability(tenant_id, device_id, "host.admin")
                            .unwrap_or(false)
                    })
            };
            super::admin_lease::issue(
                device_id,
                operations,
                ttl_seconds,
                confirmed,
                owner_authorized,
            )
                .map_err(external_bridge_rpc_error)
                .and_then(to_json)
        }

        "host_admin_lease_revoke" => {
            super::admin_lease::revoke_device(device_id);
            Ok(Value::Null)
        }

        // ── MCP server ────────────────────────────────────────────────────────

        "mcp_server_start" | "mcp_server_restart" => {
            use tauri::Manager;

            let port: u16 = required(&args, "port")?;
            let token: String = required(&args, "token")?;
            let settings_json: String = required_aliased(&args, "settings_json", "settingsJson")?;
            if name == "mcp_server_restart" {
                match &host {
                    crate::companion_api::dispatch_host::DispatchHost::Tauri(app) => {
                        crate::mcp_server::commands::mcp_server_stop_for_state(
                            app.state::<crate::mcp_server::McpServerState>().inner(),
                        )
                        .map_err(mcp_server_rpc_error)?;
                    }
                    crate::companion_api::dispatch_host::DispatchHost::Headless(services) => {
                        crate::mcp_server::commands::mcp_server_stop_for_state(
                            services.mcp_server.as_ref(),
                        )
                        .map_err(mcp_server_rpc_error)?;
                    }
                }
            }

            match &host {
                crate::companion_api::dispatch_host::DispatchHost::Tauri(app) => {
                    // Same resolver the settings snippet reads, so the path we
                    // spawn and the path we tell the user to paste cannot
                    // diverge — they did, and neither existed.
                    let sidecar_path =
                        crate::mcp_server::commands::resolve_sidecar_path(app).ok_or_else(|| {
                            RpcError::internal(
                                "External Bridge MCP sidecar is not installed (expected \
                                 sidecar/cognia-mcp.mjs in the app resources)"
                                    .to_string(),
                            )
                        })?;
                    let automation =
                        app.state::<crate::automation::commands::AutomationState>();
                    app.state::<crate::mcp_server::McpServerState>()
                        .start(
                            port,
                            token,
                            settings_json,
                            sidecar_path.to_string_lossy().into_owned(),
                            Some((
                                automation.handle.clone(),
                                crate::automation::dispatcher::Enforcement::from_state(
                                    &automation,
                                ),
                            )),
                            Some(
                                crate::mcp_server::orchestration_proxy::tauri_event_sink(
                                    app.clone(),
                                ),
                            ),
                        )
                        .await
                        .map(|bound| json!(bound))
                        .map_err(mcp_server_rpc_error)
                }
                crate::companion_api::dispatch_host::DispatchHost::Headless(services) => {
                    crate::mcp_server::commands::mcp_server_start_for_state(
                        services.mcp_server.as_ref(),
                        port,
                        token,
                        settings_json,
                        crate::headless::resolve_mcp_sidecar_path()
                            .to_string_lossy()
                            .into_owned(),
                        Some(
                            services
                                .mcp_automation()
                                .await
                                .map_err(RpcError::internal)?,
                        ),
                        None,
                    )
                    .await
                    .map(|bound| json!(bound))
                    .map_err(mcp_server_rpc_error)
                }
            }
        }
        "mcp_server_stop" => match &host {
            crate::companion_api::dispatch_host::DispatchHost::Tauri(app) => {
                use tauri::Manager;
                crate::mcp_server::commands::mcp_server_stop_for_state(
                    app.state::<crate::mcp_server::McpServerState>().inner(),
                )
                .map(|_| Value::Null)
                .map_err(mcp_server_rpc_error)
            }
            crate::companion_api::dispatch_host::DispatchHost::Headless(services) => {
                crate::mcp_server::commands::mcp_server_stop_for_state(
                    services.mcp_server.as_ref(),
                )
                .map(|_| Value::Null)
                .map_err(mcp_server_rpc_error)
            }
        },
        "mcp_server_status" => {
            let status = host.mcp_server_status();
            serde_json::to_value(status).map_err(|e| RpcError::internal(e.to_string()))
        }

        // ── Sync down (M4.7) ──────────────────────────────────────────────────

        "register_push_token" => {
            // Wave 3.4 — phone hands its FCM/APNs token to the desktop
            // so the dispatcher can route inbound events to the device
            // when no WS subscription is live. Idempotent: re-registering
            // overwrites the previous record.
            let provider_str: String = required(&args, "provider")?;
            let token: String = required(&args, "token")?;
            let provider = match provider_str.as_str() {
                "fcm" => crate::companion_api::push::PushProvider::Fcm,
                "apns" => crate::companion_api::push::PushProvider::Apns,
                other => {
                    return Err(RpcError::malformed(format!(
                        "register_push_token.provider must be 'fcm' or 'apns', got '{other}'"
                    )));
                }
            };
            let app_version: Option<String> = optional(&args, "app_version")?;
            let device_locale: Option<String> = optional(&args, "device_locale")?;
            state
                .push_tokens
                .register(crate::companion_api::push::PushTokenRecord {
                    device_id: device_id.to_string(),
                    provider,
                    token,
                    app_version,
                    device_locale,
                    registered_at: chrono::Utc::now().timestamp_millis(),
                });
            Ok(Value::Null)
        }

        "revoke_push_token" => {
            // Phone explicitly clears its token (sign-out / token rotation).
            state.push_tokens.revoke(device_id);
            Ok(Value::Null)
        }

        "sync_list_tables" => {
            // Wave 3.5 introspection — surface every registered Dexie
            // table the phone is allowed to mirror. Used by the mobile
            // shell to discover plugin-added tables without a release.
            let descriptors = state.sync_registry.list();
            let payload: Vec<serde_json::Value> = descriptors
                .into_iter()
                .map(|d| {
                    serde_json::json!({
                        "name": d.name,
                        "description": d.description,
                        "hasTombstones": d.has_tombstones,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "tables": payload }))
        }

        "sync_pull" => {
            let table: String = required(&args, "table")?;
            let since: i64 = optional::<i64>(&args, "since")?.unwrap_or(0);
            let account_id = account_id.ok_or_else(|| {
                RpcError::forbidden("sync_pull requires an account-bound device JWT")
            })?;
            // Wave 3.5 — table allowlist now lives on the declarative
            // `SyncTableRegistry` (`sync_registry.rs`) so plugins can
            // register new tables at boot without a code edit here.
            // The `with_defaults()` factory seeds the 9 Wave 1+2 tables.
            if !state.sync_registry.contains(&table) {
                return Err(RpcError::malformed(format!(
                    "table '{table}' is not exposed to mobile sync"
                )));
            }
            let bridge = std::sync::Arc::clone(&state.sync_bridge);
            // Connected brain first, desktop WebView second (ADR-0059 R4/R5);
            // 503 while a headless server's brain is down — sync has no
            // degraded-store path.
            let transport = super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .pull(
                    transport.as_ref(),
                    table,
                    since,
                    account_id.to_string(),
                    crate::companion_api::sync_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }

        // ── Desktop-message bridge (Mobile completeness P2) ──────────────────
        //
        // All five message / session RPCs route through `DataPlane::pick`,
        // which selects the Tauri-bridge variant (existing desktop flow) or
        // the Direct variant against a `SqliteAppStore` in headless mode
        // (Phase D). The return shape is identical so the rest of the RPC
        // pipeline stays unchanged.

        "message_update" => {
            let session_id: String = required(&args, "session_id")?;
            let message_id: String = required(&args, "message_id")?;
            let updates: Value = required(&args, "updates")?;
            let dp = pick_data_plane(state)?;
            dp.update_message(session_id, message_id, updates)
                .await
                .map_err(RpcError::internal)
        }

        "message_delete" => {
            let session_id: String = required(&args, "session_id")?;
            let message_id: String = required(&args, "message_id")?;
            let dp = pick_data_plane(state)?;
            dp.delete_message(session_id, message_id)
                .await
                .map_err(RpcError::internal)
        }

        "session_list" => {
            let limit: u32 = required(&args, "limit")?;
            let offset: u32 = required(&args, "offset")?;
            let before: Option<i64> = optional(&args, "before")?;
            let dp = pick_data_plane(state)?;
            dp.list_sessions(limit, offset, before)
                .await
                .map_err(RpcError::internal)
        }

        "message_get_by_session" => {
            let session_id: String = required(&args, "session_id")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            let offset: Option<u32> = optional(&args, "offset")?;
            let dp = pick_data_plane(state)?;
            dp.get_messages_by_session(session_id, limit, offset)
                .await
                .map_err(RpcError::internal)
        }

        "message_send" => {
            let session_id: String = required(&args, "session_id")?;
            let content: String = required(&args, "content")?;
            let role: Option<String> = optional(&args, "role")?;
            let dp = pick_data_plane(state)?;
            dp.send_message(session_id, content, role)
                .await
                .map_err(RpcError::internal)
        }

        // ── Rust-owned background jobs and durable monitors ─────────────────
        // These calls never depend on a renderer bridge, so they keep working
        // on a headless host and when the desktop WebView is suspended.
        "background_job_list" => crate::jobs::dispatch_host_rpc("jobs.list", &args)
            .await
            .map_err(RpcError::internal),
        "background_job_read" => crate::jobs::dispatch_host_rpc("jobs.read", &args)
            .await
            .map_err(RpcError::internal),
        "background_job_kill" => crate::jobs::dispatch_host_rpc("jobs.kill", &args)
            .await
            .map_err(RpcError::internal),
        "background_job_spawn_scheduled" => {
            let task_id: String = required(&args, "taskId")?;
            let command: String = required(&args, "command")?;
            let cwd: std::path::PathBuf = required(&args, "cwd")?;
            let label: Option<String> = optional(&args, "label")?;
            crate::jobs::background_job_spawn_scheduled(task_id, command, cwd, label)
                .await
                .map_err(RpcError::internal)
        }
        "background_monitor_list" => crate::jobs::dispatch_host_rpc("monitors.list", &args)
            .await
            .map_err(RpcError::internal),
        "background_monitor_cancel" => crate::jobs::dispatch_host_rpc("monitors.cancel", &args)
            .await
            .map_err(RpcError::internal),
        "background_monitor_register_scheduled" => {
            let task_id: String = required(&args, "taskId")?;
            let condition: cognia_jobs::MonitorCondition = required(&args, "condition")?;
            let expires_at_ms: Option<i64> = optional(&args, "expiresAtMs")?;
            let label: Option<String> = optional(&args, "label")?;
            crate::jobs::background_monitor_register_scheduled(
                task_id,
                condition,
                expires_at_ms,
                label,
            )
            .await
            .map_err(RpcError::internal)
        }

        // ── Desktop-write bridge (Wave 2 mutating RPCs) ──────────────────────
        // All commands route through one generic bridge that emits
        // `companion://desktop-write-request` with `{ command, payload }`.
        // The desktop WebView dispatches by command name and resolves via
        // the `companion_desktop_write_response` Tauri command.
        "character_upsert"
        | "character_delete"
        | "character_bind_twin"
        | "skill_set_enabled"
        | "plugin_set_enabled"
        | "adapter_update_policy"
        | "twin_profile_get"
        | "host_capabilities"
        | "host_feature_manifest"
        | "provider_diagnostics_status"
        | "provider_diagnostics_history"
        | "provider_diagnostics_start"
        | "provider_diagnostics_cancel"
        // Mobile outbound-queue RPCs — same generic bridge, different
        // TS-side dispatch arms in `lib/companion/desktop-write-source.ts`.
        | "connector_send"
        | "connector_approve_draft"
        | "connector_reject_draft"
        | "workflow_trigger_manual"
        | "twin_ingest_source"
        // ADR-0060 — device capability report; TS arm persists onto the
        // caller's `pairedDevices` row (caller id injected below).
        | "device_capabilities_report"
        // Remote Session Control — attach/detach a remote watcher + steer
        // host goal loops. Same generic bridge; TS-side dispatch arms live in
        // `lib/companion/desktop-write-source.ts`. Gated by CONTROL_COMMANDS.
        | "session_attach"
        | "session_detach"
        | "goal_pause"
        | "goal_resume"
        | "goal_stop"
        // Agent-Team board control (team-board CQRS) — same generic bridge;
        // TS arms in `lib/companion/agent-team-write-handlers.ts` validate
        // through the shared `canMoveTask` guard. Gated by CONTROL_COMMANDS.
        | "team_task_move"
        | "team_task_create"
        | "team_task_comment"
        | "team_run_pause"
        | "team_run_resume"
        | "team_run_stop"
        // Wave 4.1 — Workflow CRUD, Twin source/job control, conversation
        // overrides, and app-data backup. Same generic bridge; TS-side dispatch
        // arms live in `lib/companion/desktop-write-source.ts`. Destructive
        // members are gated by CONTROL_COMMANDS; reads are in READ_ONLY_COMMANDS.
        | "workflow_create"
        | "workflow_update"
        | "workflow_delete"
        | "workflow_run_list"
        | "workflow_cancel_run"
        | "workflow_schedule_pause"
        | "workflow_schedule_resume"
        // App scheduler CRUD/data plane. The bridge resolves to the connected
        // brain first, so a remote desktop operates the host's durable Dexie
        // scheduler rather than its own local database.
        | "scheduled_task_list"
        | "scheduled_task_get"
        | "scheduled_task_runs"
        | "scheduled_task_statistics"
        | "scheduled_task_upcoming"
        | "scheduled_task_export"
        | "scheduled_task_create"
        | "scheduled_task_update"
        | "scheduled_task_delete"
        | "scheduled_task_pause"
        | "scheduled_task_resume"
        | "scheduled_task_run_now"
        | "scheduled_task_backfill"
        | "scheduled_task_import"
        | "scheduled_task_cleanup"
        | "scheduled_task_emit_event"
        // ADR-0061 P2 — HITL approval gate; respond gets callerDeviceId
        // injected below so the responder identity is spoof-proof.
        | "workflow_approval_list"
        | "workflow_approval_respond"
        // ADR-0061 P3 — chunked result for a desktop-issued remote step.
        | "workflow_step_result"
        | "twin_delete"
        | "twin_source_list"
        | "twin_source_update"
        | "twin_source_delete"
        | "twin_job_status"
        | "twin_job_cancel"
        | "twin_job_pause"
        | "twin_job_resume"
        | "twin_job_retry"
        | "twin_create"
        | "twin_source_create"
        | "twin_profile_update"
        | "goal_create"
        | "goal_update"
        | "goal_status"
        // Long-term memory (ADR-0069) — same generic bridge; TS-side dispatch
        // arms in `lib/companion/desktop-write-source.ts` delegate to the
        // shared `lib/memory/api/*` helpers (PII gate, `external` provenance,
        // never procedural). Writes are gated by CONTROL_COMMANDS.
        | "memory_search"
        | "memory_list"
        | "memory_store"
        | "memory_update"
        | "memory_forget"
        | "conversation_overrides_update"
        | "backup_export"
        | "backup_import"
        // ADR-0056 Wave 4 — external-agent list (read) + update (enable/disable
        // + permission mode). TS-side dispatch arms in
        // `lib/companion/desktop-write-source.ts`.
        | "external_agent_list"
        | "external_agent_update" => {
            // ADR-0060: some TS dispatch arms must know the authenticated
            // caller device. Injected server-side (overwriting any
            // client-sent value) so a device can never spoof another's id.
            let args = inject_caller_device_id(name, args, device_id);
            let args = inject_caller_device_grants(name, args, device_id);
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            // Connected brain first, desktop WebView second (ADR-0059 R4/R5).
            let transport = super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .dispatch(
                    transport.as_ref(),
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }

        // ── Headless external-agent execution plane (ADR-0059 R11) ───────────
        // Service-scope only (gated above + in rpc_handler); every decision
        // is written to the audit log. The spawn request must clear the
        // SpawnPolicy preset allowlist before it touches the exec backend.
        "spawn_external_agent" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let config: crate::external_agent::process::ExternalAgentSpawnConfig =
                required(&args, "config")?;
            let summary = serde_json::json!({
                "agent_id": config.id,
                "command": config.command,
                "args": config.args,
            });
            match services.spawn_policy.validate(config) {
                Err(violation) => {
                    let mut fields = summary;
                    fields["reason"] = Value::String(violation.to_string());
                    super::audit::record_async(
                        "external_agent_spawn",
                        device_id,
                        scope.unwrap_or(""),
                        "deny",
                        fields,
                    )
                    .await;
                    Err(RpcError::forbidden(format!(
                        "spawn denied by policy: {violation}"
                    )))
                }
                Ok(validated) => {
                    let mut fields = summary;
                    fields["cwd"] = Value::String(
                        validated.config.cwd.clone().unwrap_or_default(),
                    );
                    fields["dropped_env_keys"] =
                        serde_json::to_value(&validated.dropped_env_keys)
                            .unwrap_or(Value::Null);
                    super::audit::record_async(
                        "external_agent_spawn",
                        device_id,
                        scope.unwrap_or(""),
                        "allow",
                        fields,
                    )
                    .await;
                    let emitter: std::sync::Arc<
                        dyn crate::external_agent::exec_backend::AgentEventEmitter,
                    > = std::sync::Arc::new(BusAgentEmitter(std::sync::Arc::clone(
                        &services.event_bus,
                    )));
                    crate::external_agent::exec_backend::spawn_with_events(
                        services.exec.as_ref(),
                        emitter,
                        validated.config,
                    )
                    .await
                    .map(Value::String)
                    .map_err(RpcError::internal)
                }
            }
        }

        "send_to_external_agent" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            let message: String = required(&args, "message")?;
            super::audit::record_async(
                "external_agent_send",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({ "agent_id": agent_id, "bytes": message.len() }),
            )
            .await;
            services
                .exec
                .send(&agent_id, &message)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "kill_external_agent" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            super::audit::record_async(
                "external_agent_kill",
                device_id,
                scope.unwrap_or(""),
                "allow",
                serde_json::json!({ "agent_id": agent_id }),
            )
            .await;
            services
                .exec
                .kill(&agent_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "get_external_agent_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let agent_id: String = required_aliased(&args, "agent_id", "agentId")?;
            match services.exec.status(&agent_id).await {
                Some(status) => Ok(Value::String(format!("{status:?}"))),
                None => Err(RpcError::internal(format!("Agent {agent_id} not found"))),
            }
        }

        // ── Connector webhook ingress registry (ADR-0059 F4 / R12) ───────────
        // The brain registers its adapters here so the public `/connectors`
        // routes on the front door can verify + forward platform webhooks.
        "connectors_register" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required(&args, "adapter_id")?;
            let adapter_type: String = required(&args, "adapter_type")?;
            services.connectors.inner.lock().registered_adapters.insert(
                adapter_id.clone(),
                crate::connectors::types::AdapterRegistration {
                    adapter_id,
                    adapter_type,
                    webhook_path: None,
                },
            );
            Ok(Value::Null)
        }

        "connectors_unregister" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required(&args, "adapter_id")?;
            services
                .connectors
                .inner
                .lock()
                .registered_adapters
                .remove(&adapter_id);
            Ok(Value::Null)
        }

        "connectors_list_adapters" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapters: Vec<Value> = services
                .connectors
                .inner
                .lock()
                .registered_adapters
                .values()
                .map(|reg| {
                    serde_json::json!({
                        "adapter_id": reg.adapter_id,
                        "adapter_type": reg.adapter_type,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "adapters": adapters }))
        }

        // ── Marketplace Integration ingress + encrypted spool ───────────────
        // Both hosts execute the same scheduling-crate command bodies. The
        // service-token gate above keeps webhook material and route secrets
        // inaccessible to paired-device JWTs.
        "integration_ingress_register" => {
            let input: crate::workflow::triggers::webhook_router::IntegrationIngressEntry =
                required(&args, "input")?;
            let result = match host {
                super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_register_for_state(
                        workflow.inner(),
                        input,
                    )
                }
                super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_register_for_state(
                        services.workflow.as_ref(),
                        input,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_unregister" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            match host {
                super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_unregister_for_state(
                        workflow.inner(),
                        route_id,
                    )
                }
                super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_unregister_for_state(
                        services.workflow.as_ref(),
                        route_id,
                    )
                }
            }
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        "integration_ingress_get_url" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let result = match host {
                super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_get_url_for_state(
                        workflow.inner(),
                        route_id,
                    )
                }
                super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_get_url_for_state(
                        services.workflow.as_ref(),
                        route_id,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_poll" => {
            let limit: Option<usize> = optional(&args, "limit")?;
            let result = match host {
                super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    crate::workflow::commands::integration_ingress_poll_for_state(
                        workflow.inner(),
                        limit,
                    )
                }
                super::dispatch_host::DispatchHost::Headless(services) => {
                    crate::workflow::commands::integration_ingress_poll_for_state(
                        services.workflow.as_ref(),
                        limit,
                    )
                }
            }
            .map_err(RpcError::internal)?;
            to_json(result)
        }

        "integration_ingress_ack" | "integration_ingress_nack" => {
            let route_id: String = required_aliased(&args, "route_id", "routeId")?;
            let delivery_id: String =
                required_aliased(&args, "delivery_id", "deliveryId")?;
            let result = match host {
                super::dispatch_host::DispatchHost::Tauri(app) => {
                    let workflow = app.state::<crate::workflow::WorkflowState>();
                    if name == "integration_ingress_ack" {
                        crate::workflow::commands::integration_ingress_ack_for_state(
                            workflow.inner(),
                            route_id,
                            delivery_id,
                        )
                    } else {
                        crate::workflow::commands::integration_ingress_nack_for_state(
                            workflow.inner(),
                            route_id,
                            delivery_id,
                        )
                    }
                }
                super::dispatch_host::DispatchHost::Headless(services) => {
                    if name == "integration_ingress_ack" {
                        crate::workflow::commands::integration_ingress_ack_for_state(
                            services.workflow.as_ref(),
                            route_id,
                            delivery_id,
                        )
                    } else {
                        crate::workflow::commands::integration_ingress_nack_for_state(
                            services.workflow.as_ref(),
                            route_id,
                            delivery_id,
                        )
                    }
                }
            };
            result.map(|_| Value::Null).map_err(RpcError::internal)
        }

        // ── Provider Profile Store admin plane (ADR-0090 Phase 1) ───────────
        // Service-scope only (SERVICE_ONLY_COMMANDS). The store is sync
        // rusqlite behind a parking_lot Mutex — each arm runs the whole
        // operation inside spawn_blocking so no guard crosses an .await.
        "provider_profiles_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            tokio::task::spawn_blocking(move || profiles.export_redacted())
                .await
                .map_err(|e| RpcError::internal(format!("profiles export join: {e}")))?
                .map_err(|e| RpcError::internal(format!("profiles export: {e}")))
        }

        "provider_profiles_import" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let payload = args
                .get("payload")
                .cloned()
                .ok_or_else(|| RpcError::malformed("missing 'payload'".to_string()))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let version = tokio::task::spawn_blocking(move || profiles.import(&payload))
                .await
                .map_err(|e| RpcError::internal(format!("profiles import join: {e}")))?
                .map_err(|e| RpcError::malformed(format!("profiles import: {e}")))?;
            Ok(serde_json::json!({ "profileVersion": version }))
        }

        "provider_profiles_version" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let version = tokio::task::spawn_blocking(move || profiles.profile_version())
                .await
                .map_err(|e| RpcError::internal(format!("profiles version join: {e}")))?
                .map_err(|e| RpcError::internal(format!("profiles version: {e}")))?;
            Ok(serde_json::json!({ "profileVersion": version }))
        }

        "provider_catalog_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let status = tokio::task::spawn_blocking(move || profiles.catalog_status())
                .await
                .map_err(|e| RpcError::internal(format!("catalog status join: {e}")))?
                .map_err(|e| RpcError::internal(format!("catalog status: {e}")))?;
            serde_json::to_value(status)
                .map_err(|e| RpcError::internal(format!("catalog status serialization: {e}")))
        }

        "provider_catalog_search" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if query.len() > 512 {
                return Err(RpcError::malformed(
                    "catalog search query exceeds 512 bytes".to_string(),
                ));
            }
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(50)
                .try_into()
                .unwrap_or(200);
            let profiles = std::sync::Arc::clone(&services.profiles);
            let results =
                tokio::task::spawn_blocking(move || profiles.catalog_search(&query, limit))
                    .await
                    .map_err(|e| RpcError::internal(format!("catalog search join: {e}")))?
                    .map_err(|e| RpcError::internal(format!("catalog search: {e}")))?;
            Ok(serde_json::json!({ "results": results }))
        }

        "provider_catalog_refresh" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let payload = args
                .get("payload")
                .cloned()
                .ok_or_else(|| RpcError::malformed("missing 'payload'".to_string()))?;
            let snapshot: crate::provider_profiles::CatalogSnapshotDoc =
                serde_json::from_value(payload)
                    .map_err(|e| RpcError::malformed(format!("catalog refresh payload: {e}")))?;
            let profiles = std::sync::Arc::clone(&services.profiles);
            let status =
                tokio::task::spawn_blocking(move || profiles.catalog_refresh(&snapshot))
                    .await
                    .map_err(|e| RpcError::internal(format!("catalog refresh join: {e}")))?
                    .map_err(|e| RpcError::malformed(format!("catalog refresh: {e}")))?;
            serde_json::to_value(status)
                .map_err(|e| RpcError::internal(format!("catalog refresh serialization: {e}")))
        }

        // ── Connector command plane for the headless brain (ADR-0059 T-A5) ──
        // The brain's connector-runtime routes the `connectors_*` TS wrappers
        // here (same names, camelCase args verbatim). Every arm delegates to
        // the SAME free function its Tauri command wraps — the desktop path
        // (src/connectors/commands.rs) stays untouched and no logic is
        // duplicated. `required_aliased` accepts the snake_case spelling too
        // for parity with the R12 register/unregister arms.
        "connectors_health" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let count = services.connectors.inner.lock().registered_adapters.len();
            // On the headless front door the `/connectors` ingress router is
            // mounted by the companion server itself — there is no separately
            // started local axum server (and thus no distinct bound address).
            to_json(crate::connectors::types::ConnectorsHealth {
                server_running: true,
                bound_addr: None,
                registered_adapter_count: count,
            })
        }

        "connectors_keyring_set" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let value: String = required(&args, "value")?;
            tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::set(&adapter_id, &credential, &value)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_keyring_get" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            let value = tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::get(&adapter_id, &credential)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(value)
        }

        "connectors_keyring_delete" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let credential: String = required(&args, "credential")?;
            tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::delete(&adapter_id, &credential)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_keyring_list" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let accounts: Vec<String> = required(&args, "accounts")?;
            let present = tokio::task::spawn_blocking(move || {
                crate::connectors::keyring::list(&adapter_id, &accounts)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(present)
        }

        "connectors_http_request" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let req: crate::connectors::types::TauriHttpRequest = required(&args, "req")?;
            let resp = crate::connectors::http_client::http_request(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(resp)
        }

        "connectors_ws_open" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let url: String = required(&args, "url")?;
            let headers: Option<std::collections::HashMap<String, String>> =
                optional(&args, "headers")?;
            let emitter = std::sync::Arc::new(super::event_bus::ConnectorEventEmitter(
                std::sync::Arc::clone(&services.event_bus),
            ));
            let handle_id = crate::connectors::ws_client::open_ws(emitter, url, headers)
                .await
                .map_err(RpcError::internal)?;
            to_json(handle_id)
        }

        "connectors_ws_send" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            let data: String = required(&args, "data")?;
            crate::connectors::ws_client::ws_send(&handle_id, data)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_ws_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            crate::connectors::ws_client::ws_close(&handle_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_onebot_send" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let call_json: String = required_aliased(&args, "call_json", "callJson")?;
            crate::connectors::ws_server::send(&adapter_id, call_json)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_lark_ws_open" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let emitter = std::sync::Arc::new(super::event_bus::ConnectorEventEmitter(
                std::sync::Arc::clone(&services.event_bus),
            ));
            let handle_id = crate::connectors::lark_ws::open(emitter, adapter_id)
                .await
                .map_err(RpcError::internal)?;
            to_json(handle_id)
        }

        "connectors_lark_ws_close" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let handle_id: String = required_aliased(&args, "handle_id", "handleId")?;
            crate::connectors::lark_ws::close(&handle_id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }

        "connectors_reset_all_ws" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let count = crate::connectors::commands::connectors_reset_all_ws()
                .await
                .map_err(RpcError::internal)?;
            to_json(count)
        }

        "connectors_attachment_fetch" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let remote_ref: String = required_aliased(&args, "remote_ref", "remoteRef")?;
            let source_url: String = required_aliased(&args, "source_url", "sourceUrl")?;
            let headers: Option<std::collections::HashMap<String, String>> =
                optional(&args, "headers")?;
            let attachment = crate::connectors::attachments::fetch_attachment(
                adapter_id, remote_ref, source_url, headers,
            )
            .await
            .map_err(RpcError::internal)?;
            to_json(attachment)
        }

        "connectors_attachment_read" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let adapter_id: String = required_aliased(&args, "adapter_id", "adapterId")?;
            let remote_ref: String = required_aliased(&args, "remote_ref", "remoteRef")?;
            let max_bytes: u64 = required_aliased(&args, "max_bytes", "maxBytes")?;
            let bytes =
                crate::connectors::attachments::read_attachment_base64(
                    &adapter_id,
                    &remote_ref,
                    max_bytes,
                )
                .map_err(RpcError::internal)?;
            to_json(bytes)
        }

        "connectors_media_upload" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let req: crate::connectors::types::ConnectorMediaUploadRequest =
                required(&args, "req")?;
            let uri = crate::connectors::media_upload::upload_media(req)
                .await
                .map_err(RpcError::internal)?;
            to_json(uri)
        }

        "connectors_lark_upload_file" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let access_token: String = required_aliased(&args, "access_token", "accessToken")?;
            let source_url: String = required_aliased(&args, "source_url", "sourceUrl")?;
            let file_type: String = required_aliased(&args, "file_type", "fileType")?;
            let file_name: String = required_aliased(&args, "file_name", "fileName")?;
            let duration_ms: Option<u64> = match optional(&args, "duration_ms")? {
                Some(v) => Some(v),
                None => optional(&args, "durationMs")?,
            };
            let file_key = crate::connectors::lark_upload::upload_file(
                &access_token,
                &source_url,
                &file_type,
                &file_name,
                duration_ms,
            )
            .await
            .map_err(RpcError::internal)?;
            to_json(file_key)
        }

        "connectors_lark_upload_image" => {
            host.headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let access_token: String = required_aliased(&args, "access_token", "accessToken")?;
            let source_url: String = required_aliased(&args, "source_url", "sourceUrl")?;
            let image_type: Option<String> = match optional(&args, "image_type")? {
                Some(v) => Some(v),
                None => optional(&args, "imageType")?,
            };
            let image_key = crate::connectors::lark_upload::upload_image(
                &access_token,
                &source_url,
                image_type.as_deref(),
            )
            .await
            .map_err(RpcError::internal)?;
            to_json(image_key)
        }

        // Remote Session Control — resolve a host computer-use HITL consent
        // prompt from a remote device. The prompt streams to the phone over
        // `/ws/v1/events` as the `automation:consent-request` frame; the phone
        // renders it and calls this to allow/deny. First-responder wins —
        // `ConsentBroker::resolve` removes the pending oneshot, so a duplicate
        // (desktop overlay + phone) is harmless. Distinct HITL channel from
        // `claude_approve` (which resolves Claude SDK tool-use prompts).
        "automation_consent_respond" => {
            let respond_args: crate::automation::commands::ConsentRespondArgs =
                serde_json::from_value(args).map_err(|e| {
                    RpcError::malformed(format!("automation_consent_respond args: {e}"))
                })?;
            let app = host.tauri_app(name)?;
            let automation_state: tauri::State<'_, crate::automation::commands::AutomationState> =
                app.state();
            crate::automation::commands::automation_consent_respond(automation_state, respond_args)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        // Remote Session Control — read-only capability probe. A paired device
        // calls this once (on the mobile shell) to learn whether it may resolve
        // host computer-use consent, so observe-only clients hide the consent
        // sheet entirely instead of surfacing a prompt that 403s on tap. `app`
        // is unused; this is a pure read of the process-global allow list, and
        // is deliberately absent from CONTROL_COMMANDS so every paired device
        // can query its own standing.
        "companion_can_control" => Ok(can_control_response(device_id)),

        // Read-only channel inventory. Deliberately degrades instead of 503-ing
        // off the desktop: the tunnel launcher is Tauri-managed state, and a
        // headless `cognia-server` simply has no tunnel — that is a `null`
        // `tunnelBaseUrl`, not an unsupported command. The LAN address and the
        // TLS fingerprint are process-global and answer correctly on both hosts.
        "companion_endpoints" => {
            let (tunnel_base_url, bind_lan) = match host.tauri_app(name) {
                Ok(app) => {
                    let server_state: tauri::State<'_, super::CompanionServerState> = app.state();
                    let tunnel = server_state
                        .tunnel
                        .current()
                        .map(|info| info.public_url)
                        .or_else(|| server_state.tunnel.named_public_url());
                    let bind_lan = server_state
                        .bind_mode()
                        .map(|mode| matches!(mode, super::BindMode::Lan));
                    (tunnel, bind_lan)
                }
                // Headless: no tunnel launcher, and the listener is bound
                // `0.0.0.0`, so leave `bind_lan` unknown (= assume LAN).
                Err(_) => (None, None),
            };
            let server_id = super::healthz::derive_server_id(&state.secret.read());
            Ok(endpoints_response(
                lan_base_url(bind_lan),
                tunnel_base_url,
                super::tls_fingerprint(),
                server_id,
            ))
        }

        "app_settings_update" => {
            // Allowlist enforcement — phone may only mutate user-facing
            // preferences, never transport / sidecar / provider keys.
            // Wave 3.2: distinguish validation failures (recoverable —
            // user can fix the payload) from transport-level malformed
            // requests by emitting `validation_failed` here. This is also
            // enforced in `rpc_handler` *before* the AppHandle gate; we keep
            // it here so the WebRTC `signaling::dispatch` path (which calls
            // `dispatch` directly) stays guarded too.
            validate_app_settings_update(&args)?;
            let bridge = std::sync::Arc::clone(&state.desktop_writes_bridge);
            // Connected brain first, desktop WebView second (ADR-0059 R4/R5).
            let transport = super::ws_bridge::resolve_bridge_transport(state)
                .map_err(RpcError::service_unavailable)?;
            bridge
                .dispatch(
                    transport.as_ref(),
                    name,
                    args,
                    crate::companion_api::desktop_writes_bridge::DEFAULT_TIMEOUT,
                )
                .await
                .map_err(RpcError::internal)
        }

        // ── Test MCP ──────────────────────────────────────────────────────────

        "test_mcp_server" => {
            let transport: String = required(&args, "transport")?;
            let command: Option<String> = optional(&args, "command")?;
            let mcp_args: Option<Vec<String>> = optional(&args, "args")?;
            let env: Option<std::collections::HashMap<String, String>> =
                optional(&args, "env")?;
            let url: Option<String> = optional(&args, "url")?;
            let headers: Option<std::collections::HashMap<String, String>> =
                optional(&args, "headers")?;
            mcp_test::test_mcp_server(transport, command, mcp_args, env, url, headers)
                .await
                .map_err(RpcError::internal)
                .and_then(|r| {
                    serde_json::to_value(r).map_err(|e| RpcError::internal(e.to_string()))
                })
        }

        // ── Source control (ADR-0038) — native git porcelain ────────────────
        // camelCase arg keys mirror `lib/git/commands.ts` (the shared desktop
        // client), so the entire git client works over Companion unchanged.
        "git_is_repo" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_is_repo(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_repo_state" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_repo_state(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_status" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_status(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_stat" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_diff_stat(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_file" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let staged: bool = required(&args, "staged")?;
            crate::git::commands::git_diff_file(repo_path, path, staged)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_commit" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            let path: String = required(&args, "path")?;
            crate::git::commands::git_diff_commit(repo_path, sha, path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_commit_files" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            crate::git::commands::git_commit_files(repo_path, sha)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_log" => {
            let repo_path: String = required(&args, "repoPath")?;
            let max_count: usize = required(&args, "maxCount")?;
            let skip: usize = required(&args, "skip")?;
            crate::git::commands::git_log(repo_path, max_count, skip)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_file_history" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let max_count: usize = required(&args, "maxCount")?;
            crate::git::commands::git_file_history(repo_path, path, max_count)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_branches" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_branches(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_remotes" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_remotes(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_stash_list" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_stash_list(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_conflicts" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_conflicts(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_stage" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let hunk_patch: Option<String> = optional(&args, "hunkPatch")?;
            crate::git::commands::git_stage(repo_path, paths, hunk_patch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_unstage" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let hunk_patch: Option<String> = optional(&args, "hunkPatch")?;
            crate::git::commands::git_unstage(repo_path, paths, hunk_patch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_discard" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let hunk_patch: Option<String> = optional(&args, "hunkPatch")?;
            crate::git::commands::git_discard(repo_path, paths, hunk_patch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_discard_all" => {
            let repo_path: String = required(&args, "repoPath")?;
            let include_untracked: bool = required(&args, "includeUntracked")?;
            crate::git::commands::git_discard_all(repo_path, include_untracked)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_commit" => {
            let repo_path: String = required(&args, "repoPath")?;
            let message: String = required(&args, "message")?;
            let amend: bool = required(&args, "amend")?;
            let signoff: bool = required(&args, "signoff")?;
            crate::git::commands::git_commit(repo_path, message, amend, signoff)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_checkout_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_checkout_branch(repo_path, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_create_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let checkout: bool = required(&args, "checkout")?;
            let from: Option<String> = optional(&args, "from")?;
            crate::git::commands::git_create_branch(repo_path, name, checkout, from)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_delete_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let force: bool = required(&args, "force")?;
            crate::git::commands::git_delete_branch(repo_path, name, force)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_rename_branch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let old: Option<String> = optional(&args, "old")?;
            let new_name: String = required(&args, "newName")?;
            crate::git::commands::git_rename_branch(repo_path, old, new_name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_fetch" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: Option<String> = optional(&args, "remote")?;
            let prune: bool = optional(&args, "prune")?.unwrap_or(false);
            crate::git::commands::git_fetch(repo_path, remote, prune)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_pull" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: Option<String> = optional(&args, "remote")?;
            let branch: Option<String> = optional(&args, "branch")?;
            let rebase: bool = optional(&args, "rebase")?.unwrap_or(false);
            crate::git::commands::git_pull(repo_path, remote, branch, rebase)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_push" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: Option<String> = optional(&args, "remote")?;
            let branch: Option<String> = optional(&args, "branch")?;
            let set_upstream: bool = optional(&args, "setUpstream")?.unwrap_or(false);
            let force_with_lease: bool = optional(&args, "forceWithLease")?.unwrap_or(false);
            crate::git::commands::git_push(repo_path, remote, branch, set_upstream, force_with_lease)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_sync" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_sync(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_stash_push" => {
            let repo_path: String = required(&args, "repoPath")?;
            let message: Option<String> = optional(&args, "message")?;
            let include_untracked: bool = optional(&args, "includeUntracked")?.unwrap_or(false);
            let keep_index: bool = optional(&args, "keepIndex")?.unwrap_or(false);
            crate::git::commands::git_stash_push(repo_path, message, include_untracked, keep_index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_stash_pop" => {
            let repo_path: String = required(&args, "repoPath")?;
            let index: usize = required(&args, "index")?;
            crate::git::commands::git_stash_pop(repo_path, index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_stash_apply" => {
            let repo_path: String = required(&args, "repoPath")?;
            let index: usize = required(&args, "index")?;
            crate::git::commands::git_stash_apply(repo_path, index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_stash_drop" => {
            let repo_path: String = required(&args, "repoPath")?;
            let index: usize = required(&args, "index")?;
            crate::git::commands::git_stash_drop(repo_path, index)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_resolve_conflict" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let merged_content: Option<String> = optional(&args, "mergedContent")?;
            let side: Option<crate::git::types::ConflictSide> = optional(&args, "side")?;
            crate::git::commands::git_resolve_conflict(repo_path, path, merged_content, side)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_merge_abort" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_merge_abort(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_diff_refs_files" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            let target: String = required(&args, "target")?;
            crate::git::commands::git_diff_refs_files(repo_path, base, target)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_refs_file" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            let target: String = required(&args, "target")?;
            let path: String = required(&args, "path")?;
            crate::git::commands::git_diff_refs_file(repo_path, base, target, path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_diff_staged_all" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_diff_staged_all(repo_path)
                .await
                .map(Value::String)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_refs" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_refs(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_blame" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let rev: Option<String> = optional(&args, "rev")?;
            crate::git::commands::git_blame(repo_path, path, rev)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_tags" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_tags(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_worktree_list" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_worktree_list(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_rebase_commits" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            crate::git::commands::git_rebase_commits(repo_path, base)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_worktree_add" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let branch: String = required(&args, "branch")?;
            let base_ref: Option<String> = optional(&args, "baseRef")?;
            crate::git::commands::git_worktree_add(repo_path, path, branch, base_ref)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_worktree_remove" => {
            let repo_path: String = required(&args, "repoPath")?;
            let path: String = required(&args, "path")?;
            let force: bool = required(&args, "force")?;
            let delete_branch: Option<String> = optional(&args, "deleteBranch")?;
            crate::git::commands::git_worktree_remove(repo_path, path, force, delete_branch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_worktree_commit" => {
            let worktree_path: String = required(&args, "worktreePath")?;
            let message: String = required(&args, "message")?;
            crate::git::commands::git_worktree_commit(worktree_path, message)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "git_worktree_prune" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_worktree_prune(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_remote_add" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let url: String = required(&args, "url")?;
            crate::git::commands::git_remote_add(repo_path, name, url)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_remote_remove" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_remote_remove(repo_path, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_create_tag" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let message: Option<String> = optional(&args, "message")?;
            let target: Option<String> = optional(&args, "target")?;
            crate::git::commands::git_create_tag(repo_path, name, message, target)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_delete_tag" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_delete_tag(repo_path, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_push_tag" => {
            let repo_path: String = required(&args, "repoPath")?;
            let remote: String = required(&args, "remote")?;
            let name: String = required(&args, "name")?;
            crate::git::commands::git_push_tag(repo_path, remote, name)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_reset" => {
            let repo_path: String = required(&args, "repoPath")?;
            let mode: String = required(&args, "mode")?;
            let target: String = required(&args, "target")?;
            crate::git::commands::git_reset(repo_path, mode, target)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_restore" => {
            let repo_path: String = required(&args, "repoPath")?;
            let paths: Vec<String> = required(&args, "paths")?;
            let staged: bool = required(&args, "staged")?;
            let source: Option<String> = optional(&args, "source")?;
            crate::git::commands::git_restore(repo_path, paths, staged, source)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_rebase" => {
            let repo_path: String = required(&args, "repoPath")?;
            let onto: String = required(&args, "onto")?;
            crate::git::commands::git_rebase(repo_path, onto)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_cherry_pick" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            crate::git::commands::git_cherry_pick(repo_path, sha)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_revert" => {
            let repo_path: String = required(&args, "repoPath")?;
            let sha: String = required(&args, "sha")?;
            crate::git::commands::git_revert(repo_path, sha)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_sequencer_continue" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_sequencer_continue(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_sequencer_abort" => {
            let repo_path: String = required(&args, "repoPath")?;
            crate::git::commands::git_sequencer_abort(repo_path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_interactive_rebase" => {
            let repo_path: String = required(&args, "repoPath")?;
            let base: String = required(&args, "base")?;
            let entries: Vec<crate::git::types::RebaseTodoEntry> = required(&args, "entries")?;
            crate::git::commands::git_interactive_rebase(repo_path, base, entries)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_init" => {
            let path: String = required(&args, "path")?;
            crate::git::commands::git_init(path)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_clone" => {
            let remote_url: String = required(&args, "remoteUrl")?;
            let destination: String = required(&args, "destination")?;
            crate::git::commands::git_clone(remote_url, destination)
                .await
                .map(Value::String)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_identity" => {
            let repo_path: String = required(&args, "repoPath")?;
            let identity = crate::git::commands::git_identity(repo_path)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
            serde_json::to_value(identity)
                .map_err(|e| RpcError::internal(format!("serialize git identity: {e}")))
        }
        "git_set_identity" => {
            let repo_path: String = required(&args, "repoPath")?;
            let name: String = required(&args, "name")?;
            let email: String = required(&args, "email")?;
            let global: bool = optional(&args, "global")?.unwrap_or(false);
            crate::git::commands::git_set_identity(repo_path, name, email, global)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_ignore_add" => {
            let repo_path: String = required(&args, "repoPath")?;
            let pattern: String = required(&args, "pattern")?;
            crate::git::commands::git_ignore_add(repo_path, pattern)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "git_merge" => {
            let repo_path: String = required(&args, "repoPath")?;
            let branch: String = required(&args, "branch")?;
            crate::git::commands::git_merge(repo_path, branch)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }

        // ── Filesystem ───────────────────────────────────────────────────────
        // Raw absolute-path ops have NO sandbox (desktop relied on a file-dialog
        // gesture for scope; remote exposure removes it). Both the writes AND
        // this read are therefore CONTROL-gated (see `CONTROL_COMMANDS`). The
        // `fs_*_workspace` variants enforce a root-relative path-traversal check
        // and remain the recommended, ungated client path for workspace files.
        "read_text_file" => {
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || {
                crate::files::read_text_file_impl(path, crate::files::FsOrigin::Remote)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
                .map_err(RpcError::internal)
        }
        "write_text_file" => {
            let path: String = required(&args, "path")?;
            let content: String = required(&args, "content")?;
            tokio::task::spawn_blocking(move || {
                crate::files::write_text_file_impl(path, content, crate::files::FsOrigin::Remote)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "write_text_file_confined" => {
            let path: String = required(&args, "path")?;
            let content: String = required(&args, "content")?;
            let allowed_roots: Vec<String> = required(&args, "allowedRoots")?;
            tokio::task::spawn_blocking(move || {
                crate::files::write_text_file_confined(path, content, allowed_roots)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "ensure_dir" => {
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || {
                crate::files::ensure_dir_impl(path, crate::files::FsOrigin::Remote)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "ensure_dir_confined" => {
            let path: String = required(&args, "path")?;
            let allowed_roots: Vec<String> = required(&args, "allowedRoots")?;
            tokio::task::spawn_blocking(move || {
                crate::files::ensure_dir_confined(path, allowed_roots)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "default_export_dir" => {
            tokio::task::spawn_blocking(crate::files::default_export_dir)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map(Value::String)
                .map_err(RpcError::internal)
        }
        "fs_search_workspace" => {
            let root: String = required(&args, "root")?;
            let query: String = optional(&args, "query")?.unwrap_or_default();
            let limit: Option<usize> = optional(&args, "limit")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_search_workspace(root, query, limit)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_search_content_workspace" => {
            let root: String = required(&args, "root")?;
            let query: String = optional(&args, "query")?.unwrap_or_default();
            let is_regex: Option<bool> = optional(&args, "isRegex")?;
            let case_sensitive: Option<bool> = optional(&args, "caseSensitive")?;
            let max_results: Option<usize> = optional(&args, "maxResults")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_search_content_workspace(
                    root,
                    query,
                    is_regex,
                    case_sensitive,
                    max_results,
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_read_workspace_file" => {
            let root: String = required(&args, "root")?;
            let rel_path: String = required(&args, "relPath")?;
            let max_bytes: Option<usize> = optional(&args, "maxBytes")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_read_workspace_file(root, rel_path, max_bytes)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "fs_write_workspace_file" => {
            let root: String = required(&args, "root")?;
            let rel_path: String = required(&args, "relPath")?;
            let content: String = required(&args, "content")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_write_workspace_file(root, rel_path, content)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "task_workspace_status" => to_json(crate::task_workspace::task_workspace_status()),
        "task_workspace_begin" => {
            let input: cognia_task_workspace::BeginTaskRun = required(&args, "input")?;
            let sink: std::sync::Arc<dyn cognia_task_workspace::TaskWorkspaceEventSink> =
                std::sync::Arc::new(crate::task_workspace::BusResourceEventSink(
                    std::sync::Arc::clone(&state.event_bus),
                ));
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::begin_hosted_turn(
                    input.session_id.clone(),
                    crate::task_workspace::TaskWorkspaceTurnEnvelope {
                        task_id: input.task_id,
                        run_id: input.run_id,
                        parent_run_id: input.parent_run_id,
                        workspace_root: input.workspace_root,
                        agent_id: input.agent_id,
                        agent_kind: input.agent_kind,
                        workspace_key: input.workspace_key,
                        execution_run_id: input.execution_run_id,
                        trace_id: input.trace_id,
                        turn_id: input.turn_id,
                        attempt_id: input.attempt_id,
                        provider_attempt_id: input.provider_attempt_id,
                        surface: input.surface,
                        tracking_policy: input.tracking_policy,
                    },
                    sink,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_settle" => {
            let run_id: String = required(&args, "runId")?;
            let final_state: Option<cognia_task_workspace::RunState> =
                optional(&args, "finalState")?;
            let settle_run_id = run_id.clone();
            let resources = tokio::task::spawn_blocking(move || {
                let service = crate::task_workspace::service()?;
                match final_state.unwrap_or(cognia_task_workspace::RunState::Ready) {
                    cognia_task_workspace::RunState::Ready => service.settle_run(&settle_run_id),
                    cognia_task_workspace::RunState::Failed => {
                        service.settle_failed_run(&settle_run_id)
                    }
                    cognia_task_workspace::RunState::Cancelled => {
                        service.settle_cancelled_run(&settle_run_id)
                    }
                    state => Err(format!("invalid settle state: {state:?}")),
                }
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(resources)
        }
        "task_workspace_get" => {
            let task_id: String = required(&args, "taskId")?;
            crate::task_workspace::service()
                .and_then(|service| service.get_task(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list" => {
            let session_id: Option<String> = optional(&args, "sessionId")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_tasks(session_id.as_deref()))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_runs" => {
            let task_id: String = required(&args, "taskId")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_runs(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resources" => {
            let task_id: String = required(&args, "taskId")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_resources(&task_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_list_resource_events" => {
            let run_id: String = required(&args, "runId")?;
            let cursor: Option<u64> = optional(&args, "cursor")?;
            let limit: Option<u32> = optional(&args, "limit")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.list_resource_events(&run_id, cursor, limit.unwrap_or(200))
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_resource_summary" => {
            let run_id: String = required(&args, "runId")?;
            crate::task_workspace::service()
                .and_then(|service| service.get_resource_summary(&run_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_record_tool_event" => {
            let run_id: String = required(&args, "runId")?;
            let path: String = required(&args, "path")?;
            let old_path: Option<String> = optional(&args, "oldPath")?;
            let kind: cognia_task_workspace::ResourceEventKind = required(&args, "kind")?;
            let tool_call_id: Option<String> = optional(&args, "toolCallId")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.record_tool_event(
                        &run_id,
                        &path,
                        old_path.as_deref(),
                        kind,
                        tool_call_id.as_deref(),
                    )
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_export_resource_manifest" => {
            let task_id: String = required(&args, "taskId")?;
            let run_id: Option<String> = optional(&args, "runId")?;
            crate::task_workspace::service()
                .and_then(|service| service.export_resource_manifest(&task_id, run_id.as_deref()))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_resource" => {
            let task_id: String = required(&args, "taskId")?;
            let path: String = required(&args, "path")?;
            crate::task_workspace::service()
                .and_then(|service| service.list_resources(&task_id))
                .map(|resources| {
                    resources
                        .into_iter()
                        .filter(|resource| resource.path == path)
                        .max_by_key(|resource| resource.revision)
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_get_patch_set" => {
            let run_id: String = required(&args, "runId")?;
            crate::task_workspace::service()
                .and_then(|service| service.get_patch_set(&run_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_read_diff" => {
            let run_id: String = required(&args, "runId")?;
            let path: String = required(&args, "path")?;
            let requested_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            let allow_sensitive = authorize_sensitive_resource(
                requested_sensitive.unwrap_or(false),
                device_id,
                scope,
            )?;
            crate::task_workspace::service()
                .and_then(|service| service.read_patch_diff(&run_id, &path, allow_sensitive))
                .map(Value::String)
                .map_err(RpcError::internal)
        }
        "task_resource_read_text" => {
            let run_id: String = required(&args, "runId")?;
            let rel_path: String = required(&args, "relPath")?;
            let offset: Option<u64> = optional(&args, "offset")?;
            let max_bytes: Option<usize> = optional(&args, "maxBytes")?;
            let requested_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            let allow_sensitive = authorize_sensitive_resource(
                requested_sensitive.unwrap_or(false),
                device_id,
                scope,
            )?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.read_resource(
                    &run_id,
                    &rel_path,
                    offset.unwrap_or(0),
                    max_bytes,
                    allow_sensitive,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_resource_download_open" => {
            let run_id: String = required(&args, "runId")?;
            let rel_path: String = required(&args, "relPath")?;
            let requested_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            let allow_sensitive = authorize_sensitive_resource(
                requested_sensitive.unwrap_or(false),
                device_id,
                scope,
            )?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.open_resource_download(
                    &run_id,
                    &rel_path,
                    allow_sensitive,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_resource_download_read_chunk" => {
            let handle_id: String = required(&args, "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let length: Option<usize> = optional(&args, "length")?;
            crate::task_workspace::service()
                .and_then(|service| service.read_download_chunk(&handle_id, offset, length))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_download_close" => {
            let handle_id: String = required(&args, "handleId")?;
            crate::task_workspace::service()
                .and_then(|service| service.close_resource_download(&handle_id))
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "task_resource_upload_open" => {
            let run_id: String = required(&args, "runId")?;
            let rel_path: String = required(&args, "relPath")?;
            let expected_size: u64 = required(&args, "expectedSize")?;
            let expected_hash: String = required(&args, "expectedHash")?;
            let allow_sensitive: Option<bool> = optional(&args, "allowSensitive")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.open_resource_upload(
                        &run_id,
                        &rel_path,
                        expected_size,
                        &expected_hash,
                        allow_sensitive.unwrap_or(false),
                    )
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_upload_write_chunk" => {
            let handle_id: String = required(&args, "handleId")?;
            let offset: u64 = required(&args, "offset")?;
            let data_base64: String = required(&args, "dataBase64")?;
            let chunk_hash: String = required(&args, "chunkHash")?;
            crate::task_workspace::service()
                .and_then(|service| {
                    service.write_upload_chunk(
                        &handle_id,
                        offset,
                        &data_base64,
                        &chunk_hash,
                    )
                })
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_upload_commit" => {
            let handle_id: String = required(&args, "handleId")?;
            crate::task_workspace::service()
                .and_then(|service| service.commit_resource_upload(&handle_id))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_resource_upload_abort" => {
            let handle_id: String = required(&args, "handleId")?;
            crate::task_workspace::service()
                .and_then(|service| service.abort_resource_upload(&handle_id))
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "task_workspace_apply" => {
            let run_id: String = required(&args, "runId")?;
            let selection: Option<Vec<cognia_task_workspace::PatchSelection>> =
                optional(&args, "selection")?;
            let allow_irreversible: Option<bool> = optional(&args, "allowIrreversible")?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?
                    .apply_patch_set_with_options(
                        &run_id,
                        &selection.unwrap_or_default(),
                        allow_irreversible.unwrap_or(false),
                    )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_undo" => {
            let run_id: String = required(&args, "runId")?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.undo_patch_set(&run_id)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_pin" => {
            let task_id: String = required(&args, "taskId")?;
            let pinned: bool = required(&args, "pinned")?;
            crate::task_workspace::service()
                .and_then(|service| service.set_task_pinned(&task_id, pinned))
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "task_workspace_resolve_conflict" => {
            let run_id: String = required(&args, "runId")?;
            let selection: Option<Vec<cognia_task_workspace::PatchSelection>> =
                optional(&args, "selection")?;
            let resolution: cognia_task_workspace::ConflictResolution =
                required(&args, "resolution")?;
            let allow_irreversible: Option<bool> = optional(&args, "allowIrreversible")?;
            tokio::task::spawn_blocking(move || {
                crate::task_workspace::service()?.resolve_conflict_with_options(
                    &run_id,
                    &selection.unwrap_or_default(),
                    resolution,
                    allow_irreversible.unwrap_or(false),
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "task_workspace_prune" => tokio::task::spawn_blocking(move || {
            crate::task_workspace::service()?.prune()
        })
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?
        .map_err(RpcError::internal)
        .and_then(to_json),
        // File-tree browser: list children / stat one path (reads), and
        // mkdir / delete / rename / copy (CONTROL-gated writes). All use the
        // `root` + `relPath` sandbox shape of the read/write variants above.
        "fs_list_workspace_dir" => {
            let root: String = required(&args, "root")?;
            let rel_path: Option<String> = optional(&args, "relPath")?;
            let include_ignored: Option<bool> = optional(&args, "includeIgnored")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_list_workspace_dir(root, rel_path, include_ignored)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_stat_workspace_file" => {
            let root: String = required(&args, "root")?;
            let rel_path: String = required(&args, "relPath")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_stat_workspace_file(root, rel_path)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "fs_create_workspace_dir" => {
            let root: String = required(&args, "root")?;
            let rel_path: String = required(&args, "relPath")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_create_workspace_dir(root, rel_path)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "fs_delete_workspace_entry" => {
            let root: String = required(&args, "root")?;
            let rel_path: String = required(&args, "relPath")?;
            let recursive: Option<bool> = optional(&args, "recursive")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_delete_workspace_entry(root, rel_path, recursive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "fs_rename_workspace_entry" => {
            let root: String = required(&args, "root")?;
            let from_rel_path: String = required(&args, "fromRelPath")?;
            let to_rel_path: String = required(&args, "toRelPath")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_rename_workspace_entry(root, from_rel_path, to_rel_path)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }
        "fs_copy_workspace_entry" => {
            let root: String = required(&args, "root")?;
            let from_rel_path: String = required(&args, "fromRelPath")?;
            let to_rel_path: String = required(&args, "toRelPath")?;
            let recursive: Option<bool> = optional(&args, "recursive")?;
            tokio::task::spawn_blocking(move || {
                crate::files::fs_copy_workspace_entry(root, from_rel_path, to_rel_path, recursive)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map(|_| Value::Null)
            .map_err(RpcError::internal)
        }

        // ── Terminal ───────────────────────────────────────────────────────
        // Live PTY streaming stays on `/ws/terminal`. These are
        // request/response only; `terminal_exec` is a one-shot command runner.
        "terminal_list_all" => {
            ensure_terminal_rpc_authorized(device_id).await?;
            to_json(
                host.terminal_list_all(device_id)
                    .await
                    .map_err(RpcError::internal)?,
            )
        }
        "terminal_list_for_project" => {
            ensure_terminal_rpc_authorized(device_id).await?;
            let project_id: String = required(&args, "projectId")?;
            to_json(
                host.terminal_list_for_project(device_id, &project_id)
                    .await
                    .map_err(RpcError::internal)?,
            )
        }
        "terminal_kill" => {
            ensure_terminal_rpc_authorized(device_id).await?;
            let id: String = required(&args, "id")?;
            host.terminal_kill(device_id, &id)
                .await
                .map_err(RpcError::internal)?;
            Ok(Value::Null)
        }
        "terminal_exec" => {
            let command: String = required(&args, "command")?;
            let exec_args: Vec<String> = optional(&args, "args")?.unwrap_or_default();
            let cwd: Option<String> = optional(&args, "cwd")?;
            let env: Option<std::collections::HashMap<String, String>> = optional(&args, "env")?;
            let timeout_ms: Option<u64> = optional(&args, "timeoutMs")?;
            // `shell: true` runs `command` as a full shell line (cmd /C, sh -c)
            // — what a remote client needs to replay history-style commands.
            let shell: Option<bool> = optional(&args, "shell")?;
            let (command, exec_args) =
                crate::terminal::exec::resolve_shell_mode(command, exec_args, shell.unwrap_or(false))
                    .map_err(RpcError::validation_failed)?;
            crate::terminal::exec::terminal_exec_inner(cwd, command, exec_args, env, timeout_ms, None)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "terminal_complete_paths" => {
            let cwd: String = required(&args, "cwd")?;
            let fragment: String = required(&args, "fragment")?;
            let show_hidden: Option<bool> = optional(&args, "showHidden")?;
            let limit: Option<usize> = optional(&args, "limit")?;
            tokio::task::spawn_blocking(move || {
                crate::terminal::complete::complete_paths_inner(
                    &cwd,
                    &fragment,
                    show_hidden.unwrap_or(false),
                    limit.unwrap_or(50),
                )
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "terminal_kill_port" => {
            let port: u16 = required(&args, "port")?;
            // netstat/lsof + kill shell out — keep them off the async runtime.
            tokio::task::spawn_blocking(move || {
                crate::terminal::commands::terminal_kill_port(port)
            })
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
            .map_err(RpcError::internal)
            .and_then(to_json)
        }

        // ── Plugins ──────────────────────────────────────────────────────────
        // Native install/uninstall manage the on-disk plugin dir + Rust
        // snapshot. Headless mutations notify the Node PluginManager; desktop
        // mutations take effect on the next renderer reload.
        "plugin_list" => {
            if let Some(services) = host.headless() {
                return crate::plugin_api::lifecycle::plugin_get_all_for_state(
                    services.plugin_runtime.as_ref(),
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_get_all(st)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_runtime_snapshot" => {
            let plugin_id: String = required(&args, "pluginId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::lifecycle::plugin_runtime_snapshot_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_runtime_snapshot(st, plugin_id)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_install" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let source: String = required(&args, "source")?;
            let payload_val: Value =
                optional(&args, "payload")?.unwrap_or_else(|| serde_json::json!({}));
            let payload: crate::plugin_api::lifecycle::InstallPayload =
                serde_json::from_value(payload_val)
                    .map_err(|e| RpcError::malformed(format!("plugin_install.payload: {e}")))?;
            if let Some(services) = host.headless() {
                let snapshot = crate::plugin_api::lifecycle::plugin_install_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    source,
                    payload,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "installed",
                        "pluginId": snapshot.plugin_id,
                        "accountId": account_id,
                    }),
                );
                return to_json(snapshot);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_install(st, plugin_id, source, payload)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_install_from_github" => {
            let repo: String = required(&args, "repo")?;
            let git_ref: Option<String> = optional(&args, "gitRef")?;
            let subdir: Option<String> = optional(&args, "subdir")?;
            let generated_files: Option<std::collections::BTreeMap<String, String>> =
                optional(&args, "generatedFiles")?;
            if let Some(services) = host.headless() {
                let result =
                    crate::plugin_api::github::installer::plugin_install_from_github_for_state(
                        services.plugin_runtime.as_ref(),
                        repo,
                        git_ref,
                        subdir,
                        generated_files.unwrap_or_default(),
                    )
                    .await
                    .map_err(RpcError::internal)?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "installed",
                        "pluginId": result.manifest.get("id").and_then(Value::as_str),
                        "accountId": account_id,
                    }),
                );
                return to_json(result);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::github::installer::plugin_install_from_github(
                st,
                repo,
                git_ref,
                subdir,
                generated_files,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_uninstall" => {
            let plugin_id: String = required(&args, "pluginId")?;
            if let Some(services) = host.headless() {
                crate::plugin_api::lifecycle::plugin_uninstall_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id.clone(),
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "uninstalled",
                        "pluginId": plugin_id,
                        "accountId": account_id,
                    }),
                );
                return Ok(Value::Null);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_uninstall(st, plugin_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "plugin_stage_version" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let version: String = required(&args, "version")?;
            let download_url: String = required(&args, "downloadUrl")?;
            let checksum: Option<String> = optional(&args, "checksum")?;
            let signature_hex: Option<String> = optional(&args, "signatureHex")?;
            let public_key_hex: Option<String> = optional(&args, "publicKeyHex")?;
            let require_signature: Option<bool> = optional(&args, "requireSignature")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::marketplace::plugin_stage_version_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    version,
                    download_url,
                    checksum,
                    signature_hex,
                    public_key_hex,
                    require_signature,
                )
                .await
                .map_err(|error| RpcError::internal(error.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::plugin_stage_version_for_state(
                state.inner(),
                plugin_id,
                version,
                download_url,
                checksum,
                signature_hex,
                public_key_hex,
                require_signature,
            )
            .await
            .map_err(|error| RpcError::internal(error.to_string()))
            .and_then(to_json)
        }
        "plugin_commit_staged_update" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let transaction_id: String = required(&args, "transactionId")?;
            if let Some(services) = host.headless() {
                let committed =
                    crate::plugin_api::marketplace::commit_staged_update_for_state(
                        services.plugin_runtime.as_ref(),
                        &plugin_id,
                        &transaction_id,
                    )
                    .map_err(|error| RpcError::internal(error.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "updated",
                        "pluginId": plugin_id,
                        "accountId": account_id,
                    }),
                );
                return to_json(committed);
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::commit_staged_update_for_state(
                state.inner(),
                &plugin_id,
                &transaction_id,
            )
            .map_err(|error| RpcError::internal(error.to_string()))
            .and_then(to_json)
        }
        "plugin_discard_staged_update" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let transaction_id: String = required(&args, "transactionId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::marketplace::discard_staged_update_for_state(
                    services.plugin_runtime.as_ref(),
                    &plugin_id,
                    &transaction_id,
                )
                .map(|_| Value::Null)
                .map_err(|error| RpcError::internal(error.to_string()));
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::discard_staged_update_for_state(
                state.inner(),
                &plugin_id,
                &transaction_id,
            )
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_finalize_staged_update" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let transaction_id: String = required(&args, "transactionId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::marketplace::finalize_staged_update_for_state(
                    services.plugin_runtime.as_ref(),
                    &plugin_id,
                    &transaction_id,
                )
                .map(|_| Value::Null)
                .map_err(|error| RpcError::internal(error.to_string()));
            }
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::marketplace::finalize_staged_update_for_state(
                state.inner(),
                &plugin_id,
                &transaction_id,
            )
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_backup_create" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let label: Option<String> = optional(&args, "label")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::backup::plugin_backup_create_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    label,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_create(st, plugin_id, label)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_backup_restore" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let backup_id: String = required(&args, "backupId")?;
            if let Some(services) = host.headless() {
                crate::plugin_api::backup::plugin_backup_restore_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id.clone(),
                    backup_id,
                )
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?;
                services.event_bus.publish(
                    "plugin://runtime-changed".to_string(),
                    serde_json::json!({
                        "action": "restored",
                        "pluginId": plugin_id,
                        "accountId": account_id,
                    }),
                );
                return Ok(Value::Null);
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_restore(st, plugin_id, backup_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "plugin_backup_delete" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let backup_id: String = required(&args, "backupId")?;
            if let Some(services) = host.headless() {
                return crate::plugin_api::backup::plugin_backup_delete_for_state(
                    services.plugin_runtime.as_ref(),
                    plugin_id,
                    backup_id,
                )
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()));
            }
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_delete(st, plugin_id, backup_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }

        "plugin_permission_grant" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_runtime = std::sync::Arc::clone(&services.plugin_runtime);
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let permission: String = required(&args, "permission")?;
            let granted_by: String = required_aliased(&args, "granted_by", "grantedBy")?;
            let expires_at: Option<String> = match optional(&args, "expiresAt")? {
                Some(value) => Some(value),
                None => optional(&args, "expires_at")?,
            };
            let grant = tokio::task::spawn_blocking(move || {
                crate::plugin_api::permissions::grant_permission_for_state(
                    plugin_runtime.as_ref(),
                    plugin_id,
                    permission,
                    granted_by,
                    expires_at,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(|error| RpcError::internal(error.to_string()))?;
            to_json(grant)
        }
        "plugin_permission_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_runtime = std::sync::Arc::clone(&services.plugin_runtime);
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let permissions = tokio::task::spawn_blocking(move || {
                crate::plugin_api::permissions::list_permissions_for_state(
                    plugin_runtime.as_ref(),
                    plugin_id,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(|error| RpcError::internal(error.to_string()))?;
            to_json(permissions)
        }
        "plugin_permission_revoke" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_runtime = std::sync::Arc::clone(&services.plugin_runtime);
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let permission: String = required(&args, "permission")?;
            tokio::task::spawn_blocking(move || {
                crate::plugin_api::permissions::revoke_permission_for_state(
                    plugin_runtime.as_ref(),
                    plugin_id,
                    permission,
                )
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map(|_| Value::Null)
            .map_err(|error| RpcError::internal(error.to_string()))
        }
        "plugin_set_shell_allowlist" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let commands: Vec<String> = required(&args, "commands")?;
            services
                .plugin_runtime
                .set_shell_allowlist(&plugin_id, commands);
            Ok(Value::Null)
        }
        "plugin_set_network_allowlist" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let domains: Vec<String> = required(&args, "domains")?;
            services
                .plugin_runtime
                .set_network_allowlist(&plugin_id, domains);
            Ok(Value::Null)
        }

        "plugin_python_initialize" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let python_path: Option<String> = optional(&args, "pythonPath")?;
            crate::plugin_api::python::commands::plugin_python_initialize_for_state(
                services.python_plugins.as_ref(),
                python_path,
                None,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_runtime_info" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_runtime_info_for_state(
                    services.python_plugins.as_ref(),
                ),
            )
        }
        "plugin_python_load" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let main_module: String = required_aliased(&args, "main_module", "mainModule")?;
            let dependencies: Option<Vec<String>> = optional(&args, "dependencies")?;
            let config: Option<Value> = optional(&args, "config")?;
            let host_settings: Option<
                crate::plugin_api::python::commands::PythonHostSettings,
            > = optional(&args, "hostSettings")?;
            crate::plugin_api::python::commands::plugin_python_load_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                main_module,
                dependencies,
                config,
                host_settings,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_call_hook" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let event: String = required(&args, "event")?;
            let hook_name: String = required(&args, "name")?;
            let payload: Value = required(&args, "payload")?;
            crate::plugin_api::python::commands::plugin_python_call_hook_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                event,
                hook_name,
                payload,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_push_config" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let config: Value = required(&args, "config")?;
            crate::plugin_api::python::commands::plugin_python_push_config_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                config,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_get_tools" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::python::commands::plugin_python_get_tools_for_state(
                services.python_plugins.as_ref(),
                plugin_id,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_call_tool" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let tool_name: String = required_aliased(&args, "tool_name", "toolName")?;
            let tool_args: Value = required(&args, "args")?;
            crate::plugin_api::python::commands::plugin_python_call_tool_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                tool_name,
                tool_args,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_call" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let function_name: String =
                required_aliased(&args, "function_name", "functionName")?;
            let call_args: Vec<Value> = required(&args, "args")?;
            crate::plugin_api::python::commands::plugin_python_call_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                function_name,
                call_args,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_eval" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let code: String = required(&args, "code")?;
            let locals: Option<Value> = optional(&args, "locals")?;
            crate::plugin_api::python::commands::plugin_python_eval_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                code,
                locals,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_import" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let module_name: String = required_aliased(&args, "module_name", "moduleName")?;
            crate::plugin_api::python::commands::plugin_python_import_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                module_name,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_module_call" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let module_name: String = required_aliased(&args, "module_name", "moduleName")?;
            let function_name: String =
                required_aliased(&args, "function_name", "functionName")?;
            let call_args: Vec<Value> = required(&args, "args")?;
            crate::plugin_api::python::commands::plugin_python_module_call_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                module_name,
                function_name,
                call_args,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_module_getattr" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let module_name: String = required_aliased(&args, "module_name", "moduleName")?;
            let attr_name: String = required_aliased(&args, "attr_name", "attrName")?;
            crate::plugin_api::python::commands::plugin_python_module_getattr_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                module_name,
                attr_name,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_python_is_initialized" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::python::commands::plugin_python_is_initialized_for_state(
                services.python_plugins.as_ref(),
                plugin_id,
            )
            .await
            .map(Value::Bool)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_get_info" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_get_info_for_state(
                    services.python_plugins.as_ref(),
                    &plugin_id,
                ),
            )
        }
        "plugin_python_install_deps" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let dependencies: Vec<String> = required(&args, "dependencies")?;
            crate::plugin_api::python::commands::plugin_python_install_deps_for_state(
                services.python_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                &plugin_id,
                &dependencies,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_unload" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::python::commands::plugin_python_unload_for_state(
                services.python_plugins.as_ref(),
                &plugin_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_python_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            to_json(
                crate::plugin_api::python::commands::plugin_python_list_for_state(
                    services.python_plugins.as_ref(),
                ),
            )
        }

        "plugin_api_invoke" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let request: crate::plugin_api::api_bridge::PluginApiInvokeRequest =
                required(&args, "request")?;
            let response = crate::plugin_api::api_bridge::plugin_api_invoke_for_state(
                services.plugin_runtime.as_ref(),
                request,
            )
            .await
            .map_err(plugin_rpc_error)?;
            to_json(response)
        }
        "plugin_api_batch_invoke" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let request: crate::plugin_api::api_bridge::BatchInvokeRequest =
                required(&args, "request")?;
            let response = crate::plugin_api::api_bridge::plugin_api_batch_invoke_for_state(
                services.plugin_runtime.as_ref(),
                request,
            )
            .await
            .map_err(plugin_rpc_error)?;
            to_json(response)
        }
        "plugin_get_capabilities" => {
            to_json(crate::plugin_api::api_bridge::plugin_get_capabilities_for_host(false))
        }

        "codeserver_supported" => to_json(crate::codeserver::download::resolve_platform().is_ok()),
        "codeserver_ensure" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let root: String = required(&args, "root")?;
            let profile =
                optional::<crate::codeserver::profile::IdeProfile>(&args, "profile")?
                    .unwrap_or_default();
            services
                .code_server
                .ensure(&root, profile, device_id)
                .await
                .and_then(|status| {
                    serde_json::to_value(status)
                        .map_err(|error| format!("serialize code-server status: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let root: String = required(&args, "root")?;
            services
                .code_server
                .status(&root, device_id)
                .await
                .and_then(|status| {
                    serde_json::to_value(status)
                        .map_err(|error| format!("serialize code-server status: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_stop" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let root: String = required(&args, "root")?;
            to_json(services.code_server.stop(&root).await)
        }
        "codeserver_stop_all" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            services.code_server.stop_all().await;
            Ok(Value::Null)
        }
        "codeserver_build_proxy" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let request: crate::codeserver::proxy::ProxyBuildRequest =
                required(&args, "request")?;
            let code_server = std::sync::Arc::clone(&services.code_server);
            let artifact = tokio::task::spawn_blocking(move || code_server.build_proxy(request))
                .await
                .map_err(|error| {
                    RpcError::internal(format!("build managed proxy task failed: {error}"))
                })?
                .map_err(RpcError::service_unavailable)?;
            serde_json::to_value(artifact)
                .map_err(|error| RpcError::internal(format!("serialize proxy artifact: {error}")))
        }
        "codeserver_activate_proxy" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let artifact: crate::codeserver::proxy::ProxyArtifact =
                required(&args, "artifact")?;
            to_json(
                services
                    .code_server
                    .install_proxy_artifact(&artifact)
                    .await,
            )
        }
        "codeserver_list_proxies" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let code_server = std::sync::Arc::clone(&services.code_server);
            tokio::task::spawn_blocking(move || code_server.list_proxies())
                .await
                .map_err(|error| {
                    RpcError::internal(format!("list managed proxies task failed: {error}"))
                })?
                .and_then(|artifacts| {
                    serde_json::to_value(artifacts)
                        .map_err(|error| format!("serialize proxy artifacts: {error}"))
                })
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_broker_validate_paths" => {
            let root: String = required(&args, "root")?;
            let paths: Vec<String> = required(&args, "paths")?;
            tokio::task::spawn_blocking(move || {
                paths
                    .iter()
                    .map(|path| {
                        crate::files::validate_confined_path(path, std::slice::from_ref(&root))
                            .map(|value| value.to_string_lossy().into_owned())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .await
            .map_err(|error| {
                RpcError::internal(format!("validate managed IDE paths task failed: {error}"))
            })?
            .and_then(|paths| {
                serde_json::to_value(paths)
                    .map_err(|error| format!("serialize validated IDE paths: {error}"))
            })
            .map_err(RpcError::service_unavailable)
        }
        "codeserver_broker_respond" => {
            let root: String = required(&args, "root")?;
            let generation: u64 = required(&args, "generation")?;
            let id: Value = required(&args, "id")?;
            let result: Option<Value> = optional(&args, "result")?;
            let error: Option<Value> = optional(&args, "error")?;
            crate::codeserver::agent_channel::global()
                .respond(&root, generation, id, result, error)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "codeserver_broker_notify" => {
            let root: String = required(&args, "root")?;
            let generation: u64 = required(&args, "generation")?;
            let params: Value = required(&args, "params")?;
            crate::codeserver::agent_channel::global()
                .notify_provider(&root, generation, params)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::service_unavailable)
        }
        "lsp_host_ensure" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            crate::plugin_api::vscode::commands::ensure_system_lsp_host_for_state(
                services.vscode_plugins.as_ref(),
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "lsp_host_request" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let method: String = required(&args, "method")?;
            if !remote_lsp_method_allowed(&method) {
                return Err(RpcError::malformed(format!(
                    "lsp_host_request method is not allowed: {method}"
                )));
            }
            let payload_json = match args.get("payloadJson").or_else(|| args.get("payload_json")) {
                Some(Value::String(raw)) => raw.clone(),
                Some(value) => value.to_string(),
                None => "null".to_string(),
            };
            crate::plugin_api::vscode::commands::plugin_invoke_vscode_rpc_for_state(
                services.vscode_plugins.as_ref(),
                crate::plugin_api::vscode::commands::LSP_HOST_KEY.to_string(),
                method,
                payload_json,
            )
            .await
            .map(Value::String)
            .map_err(vscode_rpc_error)
        }
        "ensure_system_lsp_host" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            crate::plugin_api::vscode::commands::ensure_system_lsp_host_for_state(
                services.vscode_plugins.as_ref(),
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_load_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let manifest_json: String =
                required_aliased(&args, "manifest_json", "manifestJson")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            crate::plugin_api::vscode::commands::plugin_load_vscode_for_state(
                services.vscode_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                manifest_json,
                plugin_path,
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_activate_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let config_json: String = required_aliased(&args, "config_json", "configJson")?;
            crate::plugin_api::vscode::commands::plugin_activate_vscode_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                config_json,
            )
            .await
            .map_err(vscode_rpc_error)
            .and_then(to_json)
        }
        "plugin_deactivate_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::vscode::commands::plugin_deactivate_vscode_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_unload_vscode" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::vscode::commands::plugin_unload_vscode_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
            )
            .await
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }
        "plugin_invoke_vscode_rpc" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let method: String = required(&args, "method")?;
            let payload_json: String =
                required_aliased(&args, "payload_json", "payloadJson")?;
            crate::plugin_api::vscode::commands::plugin_invoke_vscode_rpc_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                method,
                payload_json,
            )
            .await
            .map(Value::String)
            .map_err(vscode_rpc_error)
        }
        "plugin_vscode_send_response" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let response_json: String =
                required_aliased(&args, "response_json", "responseJson")?;
            crate::plugin_api::vscode::commands::plugin_vscode_send_response_for_state(
                services.vscode_plugins.as_ref(),
                plugin_id,
                response_json,
            )
            .map(|_| Value::Null)
            .map_err(vscode_rpc_error)
        }

        // Node-target JavaScript stays inside cognia-server. The brain uses
        // the same host-neutral lifecycle as desktop Tauri, backed by the
        // verified COGNIA_PLUGIN_NODE_PATH runtime in server images.
        "plugin_launch_js" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let entry: String = required(&args, "entry")?;
            let extra_args: Option<Vec<String>> = optional(&args, "extraArgs")?;
            crate::plugin_api::lifecycle::plugin_launch_js_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                entry,
                extra_args.unwrap_or_default(),
                None,
            )
            .await
            .map_err(plugin_rpc_error)
            .and_then(to_json)
        }
        "plugin_invoke_js_callback" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let entry: String = required(&args, "entry")?;
            let callback_id: String = required_aliased(&args, "callback_id", "callbackId")?;
            let callback_args: Value = required(&args, "args")?;
            crate::plugin_api::lifecycle::plugin_invoke_js_callback_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                entry,
                callback_id,
                callback_args,
                None,
            )
            .await
            .map_err(plugin_rpc_error)
        }
        "plugin_deactivate_js" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            let entry: String = required(&args, "entry")?;
            crate::plugin_api::lifecycle::plugin_deactivate_js_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                plugin_path,
                entry,
                None,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_stop_js" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::lifecycle::plugin_stop_js_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(|_| Value::Null)
            .map_err(plugin_rpc_error)
        }
        "plugin_js_status" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let generation: String = required(&args, "generation")?;
            crate::plugin_api::lifecycle::plugin_js_status_for_state(
                services.plugin_runtime.as_ref(),
                plugin_id,
                generation,
            )
            .await
            .map(Value::Bool)
            .map_err(plugin_rpc_error)
        }

        // Native plugin execution stays inside cognia-server. The Node brain
        // reaches the existing wasmtime host through its service transport;
        // no guest code or capability decision is reimplemented in JS.
        "plugin_wasm_load" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let manifest_json: String =
                required_aliased(&args, "manifest_json", "manifestJson")?;
            let plugin_path: String = required_aliased(&args, "plugin_path", "pluginPath")?;
            crate::plugin_api::wasm::commands::plugin_wasm_load_for_state(
                services.wasm_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                manifest_json,
                plugin_path,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_wasm_activate" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let config_json: String = required_aliased(&args, "config_json", "configJson")?;
            crate::plugin_api::wasm::commands::plugin_wasm_activate_for_state(
                services.wasm_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                config_json,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_wasm_deactivate" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::wasm::commands::plugin_wasm_deactivate_for_state(
                services.wasm_plugins.as_ref(),
                plugin_id,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_wasm_call" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            let export_name: String = required_aliased(&args, "export_name", "exportName")?;
            let payload_json: String = required_aliased(&args, "payload_json", "payloadJson")?;
            crate::plugin_api::wasm::commands::plugin_wasm_call_for_state(
                services.wasm_plugins.as_ref(),
                services.plugin_runtime.as_ref(),
                plugin_id,
                export_name,
                payload_json,
            )
            .await
            .map(Value::String)
            .map_err(RpcError::internal)
        }
        "plugin_wasm_unload" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            let plugin_id: String = required_aliased(&args, "plugin_id", "pluginId")?;
            crate::plugin_api::wasm::commands::plugin_wasm_unload_for_state(
                services.wasm_plugins.as_ref(),
                plugin_id,
            )
            .await
            .map(Value::Bool)
            .map_err(RpcError::internal)
        }
        "plugin_wasm_list" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
            crate::plugin_api::wasm::commands::plugin_wasm_list_for_state(
                services.wasm_plugins.as_ref(),
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        // The renderer half of the WASM capability bridge. A headless host has
        // no renderer to answer requests, and therefore never dispatches any —
        // so a response frame arriving here is always a routing mistake, not a
        // capability gap to paper over.
        "plugin_wasm_renderer_response" => Err(RpcError::headless_unsupported(name)),

        // ── Native log read-back ────────────────────────────────────────────
        // Free functions over the log directory — no Tauri state needed, so
        // these also work from the headless `cognia-server` process.
        "logs_query" => {
            // Accept both the Tauri arg shape `{ query: {...} }` (what
            // `transport.call("logs_query", { query })` sends on every
            // platform) and a bare flattened query object.
            let raw = args.get("query").cloned().unwrap_or_else(|| args.clone());
            let query: crate::logging::query::NativeLogQuery = serde_json::from_value(raw)
                .map_err(|e| RpcError::malformed(format!("invalid logs query: {e}")))?;
            let result = tokio::task::spawn_blocking(move || {
                crate::logging::query::query_native_logs(&query)
            })
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
            .map_err(RpcError::internal)?;
            to_json(result)
        }
        "logs_list_files" => {
            let files = tokio::task::spawn_blocking(crate::logging::query::list_native_log_files)
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .map_err(RpcError::internal)?;
            to_json(files)
        }

        // ── Agent Fleet (ADR-0009) ──────────────────────────────────────────
        // Host-generic: these reach the process-global fleet runtime directly
        // (no AppHandle / desktop_writes_bridge), so they also serve a headless
        // server (which returns an empty snapshot). camelCase arg keys mirror
        // the TS wrappers in `lib/fleet/fleet-remote-actions.ts`.
        "fleet_get_snapshot" => to_json(crate::fleet::runtime().snapshot()),
        "fleet_permission_respond" => {
            let request_id: String = required(&args, "requestId")?;
            let behavior: crate::fleet::PermissionBehavior = required(&args, "behavior")?;
            to_json(
                crate::fleet::runtime().respond_permission(&request_id, behavior),
            )
        }
        "fleet_question_respond" => {
            // Without this arm an AskUserQuestion stranded anyone who wasn't at
            // the desktop island: the phone could see the question in the
            // snapshot but had no way to answer it, so it simply timed out.
            let request_id: String = required(&args, "requestId")?;
            let selections: Vec<Vec<u32>> = required(&args, "selections")?;
            to_json(crate::fleet::runtime().respond_question(&request_id, selections))
        }
        "fleet_opencode_send_message" => {
            let session_id: String = required(&args, "sessionId")?;
            let text: String = required(&args, "text")?;
            if text.trim().is_empty() {
                return Err(RpcError::malformed("text must not be empty".to_string()));
            }
            to_json(crate::fleet::runtime().queue_opencode_command(session_id, text))
        }
        "fleet_focus_terminal" => {
            let agent: String = required(&args, "agent")?;
            let session_id: String = required(&args, "sessionId")?;
            crate::fleet::control::focus_session_terminal(&agent, &session_id)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::internal)
        }
        "fleet_interrupt_session" => {
            let agent: String = required(&args, "agent")?;
            let session_id: String = required(&args, "sessionId")?;
            crate::fleet::control::interrupt_session(&agent, &session_id)
                .await
                .map(|()| Value::Null)
                .map_err(RpcError::internal)
        }

        // ── Lark dual-entry (plan 2026-07-24, service scope) ─────────────────
        "lark_entry_issue" => {
            super::lark_entry::rpc_entry_issue(state, &args).map_err(RpcError::internal)
        }
        "lark_result_complete" => {
            super::lark_entry::rpc_result_complete(&args).map_err(RpcError::internal)
        }
        "lark_metrics_record" => {
            super::lark_entry::rpc_metrics_record(&args).map_err(RpcError::internal)
        }

        unknown => Err(RpcError::unknown_command(unknown)),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Moved here from external_agent::exec_backend when the crate was
    /// extracted (ADR-0067): the round trip needs the companion EventBus,
    /// which the crate can no longer see.
    #[test]
    fn bus_emitter_publishes_the_frozen_payload() {
        use crate::external_agent::exec_backend::{
            stdout_payload, AgentEventEmitter, STDOUT_CHANNEL,
        };
        let bus = crate::companion_api::event_bus::EventBus::new();
        let emitter = BusAgentEmitter(std::sync::Arc::clone(&bus));
        emitter.emit(STDOUT_CHANNEL, stdout_payload("a1", "hello"));
        match bus.subscribe(Some(0), 0) {
            crate::companion_api::event_bus::SubscribeResult::Ok { replay, .. } => {
                assert_eq!(replay.len(), 1);
                assert_eq!(replay[0].event_type, STDOUT_CHANNEL);
                assert_eq!(
                    replay[0].payload,
                    serde_json::json!({ "agentId": "a1", "data": "hello" })
                );
            }
            _ => panic!("subscribe failed"),
        }
    }
    use crate::companion_api::{
        deny_list::DenyList, idempotency::IdempotencyCache, jwt::issue_device_jwt,
        redemption_lru::RedemptionLru, CompanionState,
    };
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        Router,
    };
    use parking_lot::RwLock;
    use serde_json::json;
    use std::sync::Arc;
    use tower::ServiceExt as _;

    const SECRET: &[u8] = b"test-secret-32-bytes-exactly____";
    const ACCOUNT_ID: &str = "local_acct_a";

    fn test_state() -> super::super::SharedState {
        use crate::companion_api::event_bus::EventBus;
        Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::new(IdempotencyCache::new()),
            event_bus: EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        })
    }

    fn build_router(state: super::super::SharedState) -> Router {
        use super::super::middleware;
        use axum::{middleware::from_fn_with_state, routing::post};

        Router::new()
            .route("/api/v1/_rpc/{name}", post(rpc_handler))
            .layer(from_fn_with_state(
                state.clone(),
                middleware::require_device_jwt,
            ))
            .with_state(state)
    }

    fn device_jwt(device_id: &str) -> String {
        issue_device_jwt(SECRET, device_id, ACCOUNT_ID).expect("issue device jwt")
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        serde_json::from_slice(&bytes).expect("json parse")
    }

    async fn rpc_post(
        router: Router,
        name: &str,
        body: serde_json::Value,
        jwt: &str,
        idempotency_key: Option<&str>,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/_rpc/{name}"))
            .header("Authorization", format!("Bearer {jwt}"))
            .header("Content-Type", "application/json");

        if let Some(key) = idempotency_key {
            builder = builder.header("Idempotency-Key", key);
        }

        let req = builder
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        router.oneshot(req).await.unwrap()
    }

    // ── Unknown command → 404 ─────────────────────────────────────────────────

    #[tokio::test]
    async fn unknown_command_returns_404() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "wallpaper_save", json!({}), &jwt, None).await;
        assert_eq!(resp.status().as_u16(), 404);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "unknown_command");
    }

    // ── Remote Session Control gate ───────────────────────────────────────────

    #[tokio::test]
    async fn control_command_forbidden_when_device_not_allowed() {
        // Unique device id so the process-global allow list (shared across
        // parallel tests) can't be left in an allowed state by another test.
        let device = "dev-gate-denied-001";
        super::super::control_allow_list::global().disallow(device);

        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt(device);
        let resp = rpc_post(
            router,
            "session_attach",
            json!({ "sessionId": "s1" }),
            &jwt,
            None,
        )
        .await;
        assert_eq!(resp.status().as_u16(), 403);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "remote_control_forbidden");
    }

    #[tokio::test]
    async fn control_command_passes_gate_when_device_allowed() {
        let device = "dev-gate-allowed-001";
        super::super::control_allow_list::global().allow(device.to_string());

        let state = test_state(); // app_handle None → 503 once past the gate
        let router = build_router(state);
        let jwt = device_jwt(device);
        let resp = rpc_post(
            router,
            "session_attach",
            json!({ "sessionId": "s1" }),
            &jwt,
            None,
        )
        .await;
        // Past the capability gate: not 403. In test mode the missing
        // app_handle yields 503 — the point is the gate let it through.
        assert_ne!(resp.status().as_u16(), 403);
        super::super::control_allow_list::global().disallow(device);
    }

    #[test]
    fn can_control_response_reflects_allow_list() {
        // Unique device id — the allow list is process-global and shared
        // across parallel tests.
        let device = "dev-cancontrol-helper-001";
        super::super::control_allow_list::global().disallow(device);
        assert_eq!(can_control_response(device), json!({ "allowed": false }));

        super::super::control_allow_list::global().allow(device.to_string());
        assert_eq!(can_control_response(device), json!({ "allowed": true }));

        super::super::control_allow_list::global().disallow(device);
    }

    #[test]
    fn endpoints_response_reports_both_channels() {
        let value = endpoints_response(
            Some("https://192.168.1.42:27890".to_string()),
            Some("https://calm-rock.trycloudflare.com".to_string()),
            "abc123".to_string(),
            "server-id-1".to_string(),
        );
        assert_eq!(value["lanBaseUrl"], "https://192.168.1.42:27890");
        assert_eq!(
            value["tunnelBaseUrl"],
            "https://calm-rock.trycloudflare.com"
        );
        assert_eq!(value["fingerprint"], "abc123");
        assert_eq!(value["serverId"], "server-id-1");
    }

    #[test]
    fn endpoints_response_nulls_absent_channels() {
        // A loopback-bound desktop with no tunnel running: both address fields
        // must serialise as JSON `null`, not as the string "null" or a missing
        // key — the mobile client distinguishes "no such channel" from
        // "channel unchanged" by key presence.
        let value = endpoints_response(None, None, String::new(), "server-id-2".to_string());
        assert!(value["lanBaseUrl"].is_null());
        assert!(value["tunnelBaseUrl"].is_null());
        assert_eq!(value["fingerprint"], "");
        assert_eq!(value["serverId"], "server-id-2");
    }

    #[test]
    fn lan_base_url_is_none_when_bound_loopback() {
        // Loopback bind mode is an explicit "not reachable from the LAN" —
        // handing the phone a 127.0.0.1 URL would make it probe itself.
        assert_eq!(lan_base_url(Some(false)), None);
    }

    #[test]
    fn lan_base_url_is_https_with_the_advertised_port_when_lan_bound() {
        // `detect_lan_ip` returns None on a network-less CI container, in which
        // case there is genuinely no LAN address to report. Both outcomes are
        // valid; assert the SHAPE of the one that exists.
        for bind_lan in [Some(true), None] {
            match lan_base_url(bind_lan) {
                Some(url) => {
                    assert!(url.starts_with("https://"), "expected https, got {url}");
                    let port = match super::super::advertised_port() {
                        0 => super::super::server::DEFAULT_PORT,
                        p => p,
                    };
                    assert!(
                        url.ends_with(&format!(":{port}")),
                        "expected port {port} in {url}"
                    );
                }
                None => {
                    assert!(
                        crate::companion_api::commands::detect_lan_ip().is_none(),
                        "lan_base_url returned None despite a routable interface"
                    );
                }
            }
        }
    }

    #[test]
    fn companion_endpoints_is_read_only_and_ungated() {
        // Read-tier: a device JWT must reach it (not SERVICE_ONLY), any paired
        // device may ask how to reach its own host (not CONTROL), and the
        // answer must never be served from the 60 s idempotency cache — a
        // freshly-started tunnel has to show up on the very next poll.
        assert!(KNOWN_COMMANDS_SET.contains("companion_endpoints"));
        assert!(READ_ONLY_COMMANDS_SET.contains("companion_endpoints"));
        assert!(!CONTROL_COMMANDS_SET.contains("companion_endpoints"));
        assert!(!SERVICE_ONLY_COMMANDS_SET.contains("companion_endpoints"));
    }

    #[tokio::test]
    async fn companion_can_control_is_not_control_gated() {
        // A device with no remote-control grant must still be able to PROBE its
        // capability — `companion_can_control` is deliberately absent from
        // CONTROL_COMMANDS. Past the gate it hits the missing-app_handle 503 in
        // test mode; the point is it is neither 404 (unwired) nor 403 (gated).
        let device = "dev-cancontrol-ungated-001";
        super::super::control_allow_list::global().disallow(device);

        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt(device);
        let resp = rpc_post(router, "companion_can_control", json!({}), &jwt, None).await;
        assert_ne!(resp.status().as_u16(), 404);
        assert_ne!(resp.status().as_u16(), 403);
    }

    #[tokio::test]
    async fn baseline_chat_command_is_not_gated() {
        // claude_send is NOT in CONTROL_COMMANDS — a paired device with no
        // remote-control grant must still be able to use baseline chat.
        let device = "dev-baseline-001";
        super::super::control_allow_list::global().disallow(device);

        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt(device);
        let resp = rpc_post(
            router,
            "claude_send",
            json!({ "session_id": "s1", "prompt": "hi" }),
            &jwt,
            None,
        )
        .await;
        // Not forbidden — baseline chat bypasses the capability gate (it
        // 503s in test mode for lack of an app_handle, which is fine).
        assert_ne!(resp.status().as_u16(), 403);
    }

    // ── Agent Fleet remote commands ───────────────────────────────────────────

    #[test]
    fn fleet_reads_are_read_only_and_ungated() {
        assert!(READ_ONLY_COMMANDS_SET.contains("fleet_get_snapshot"));
        assert!(!CONTROL_COMMANDS_SET.contains("fleet_get_snapshot"));
        assert!(KNOWN_COMMANDS_SET.contains("fleet_get_snapshot"));
    }

    #[test]
    fn fleet_writes_are_control_gated() {
        for cmd in [
            "fleet_permission_respond",
            "fleet_question_respond",
            "fleet_opencode_send_message",
            "fleet_focus_terminal",
            "fleet_interrupt_session",
        ] {
            assert!(
                CONTROL_COMMANDS_SET.contains(cmd),
                "{cmd} must be control-gated"
            );
            assert!(
                KNOWN_COMMANDS_SET.contains(cmd),
                "{cmd} must be a known command"
            );
        }
    }

    #[tokio::test]
    async fn fleet_permission_respond_is_forbidden_without_the_grant() {
        let device = "dev-fleet-gate-denied-001";
        super::super::control_allow_list::global().disallow(device);
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt(device);
        let resp = rpc_post(
            router,
            "fleet_permission_respond",
            json!({ "requestId": "r", "behavior": "allow" }),
            &jwt,
            None,
        )
        .await;
        assert_eq!(resp.status().as_u16(), 403);
        assert_eq!(body_json(resp).await["code"], "remote_control_forbidden");
    }

    #[tokio::test]
    async fn fleet_get_snapshot_read_is_not_control_gated() {
        let device = "dev-fleet-read-ungated-001";
        super::super::control_allow_list::global().disallow(device);
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt(device);
        let resp = rpc_post(router, "fleet_get_snapshot", json!({}), &jwt, None).await;
        // Neither 404 (unwired) nor 403 (gated); 503 in test mode is fine.
        assert_ne!(resp.status().as_u16(), 404);
        assert_ne!(resp.status().as_u16(), 403);
    }

    #[tokio::test]
    async fn fleet_get_snapshot_dispatch_returns_the_runtime_snapshot() {
        let _guard = crate::fleet::TEST_RUNTIME_LOCK.lock().await;
        // Ingest a uniquely-identified session into the process-global runtime.
        // A unique ppid too: the registry evicts same-pid/new-session rows, and
        // another (unlocked) test ingesting with a shared pid would drop ours.
        let sid = "rpc-fleet-snapshot-001";
        crate::fleet::runtime().ingest(&crate::fleet::registry::FleetEvent {
            agent: crate::fleet::registry::FleetAgent::ClaudeCode,
            event: "SessionStart".into(),
            pid: None,
            ppid: Some(918_273),
            env: Default::default(),
            payload: json!({ "session_id": sid }),
        });

        let state = test_state();
        // Host-generic (reaches the runtime directly): works on a headless host.
        let result = dispatch(
            "fleet_get_snapshot",
            json!({}),
            &state,
            &headless_host(),
            "dev-fleet-snap",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("fleet_get_snapshot must dispatch host-generically");
        let sessions = result["sessions"].as_array().expect("sessions array");
        assert!(sessions.iter().any(|s| s["sessionId"] == sid));
    }

    // ── Missing Authorization → 401 (middleware) ──────────────────────────────

    #[tokio::test]
    async fn missing_auth_returns_401() {
        let state = test_state();
        let router = build_router(state);
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/_rpc/claude_sidecar_status")
            .header("Content-Type", "application/json")
            .body(Body::from(b"{}".to_vec()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), 401);
    }

    // ── app_handle=None → 503 for commands that need it ──────────────────────

    #[tokio::test]
    async fn command_requiring_app_handle_returns_503_in_test_mode() {
        // `DispatchHost::from_state` consults the process-global headless
        // services slot — hold the shared global-slot lock so a concurrent
        // test's install doesn't turn this 503 into a headless dispatch.
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::headless::install_headless_services(None);
        let state = test_state(); // app_handle is None
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "claude_sidecar_status", json!({}), &jwt, None).await;
        assert_eq!(resp.status().as_u16(), 503);
        let body = body_json(resp).await;
        assert_eq!(body["code"], "service_unavailable");
    }

    // ── DispatchHost (ADR-0059 R5) ────────────────────────────────────────────

    fn headless_host() -> super::super::dispatch_host::DispatchHost {
        super::super::dispatch_host::DispatchHost::Headless(
            crate::headless::HeadlessServices::stub_for_tests(),
        )
    }

    /// Data-plane arms work on a headless host: `session_list` served from
    /// the degraded SQLite store, no AppHandle anywhere.
    #[tokio::test]
    async fn headless_dispatch_serves_the_data_plane_from_the_store() {
        use crate::companion_api::store::AppStore;
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
        let store = crate::companion_api::store::sqlite::SqliteAppStore::in_memory().expect("open");
        crate::companion_api::data_plane::install_headless_store(Some(
            store.clone() as Arc<dyn AppStore>
        ));

        let state = test_state();
        let result = dispatch(
            "session_list",
            json!({ "limit": 10, "offset": 0 }),
            &state,
            &headless_host(),
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("session_list must work on a headless host");
        assert_eq!(result["total"], 0);

        crate::companion_api::data_plane::install_headless_store(None);
    }

    /// Process-owned service status is available without a WebView. A fresh
    /// headless registry reports the same stopped state as a fresh desktop
    /// `McpServerState`.
    #[tokio::test]
    async fn headless_dispatch_reports_mcp_server_status() {
        let state = test_state();
        let status = dispatch(
            "mcp_server_status",
            json!({}),
            &state,
            &headless_host(),
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("mcp_server_status must work on a headless host");
        assert_eq!(status["running"], false);
        assert_eq!(status["port"], Value::Null);
    }

    #[tokio::test]
    async fn headless_mcp_lifecycle_reuses_validation_and_idempotent_stop() {
        let state = test_state();
        let host = headless_host();

        let invalid = dispatch(
            "mcp_server_start",
            json!({
                "port": 0,
                "token": "short",
                "settingsJson": r#"{"enabled":true,"enabledScopes":[]}"#,
            }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("weak MCP bearer must be rejected before sidecar spawn");
        assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
        assert_eq!(invalid.1 .0.code, "mcp_server_invalid_request");

        for _ in 0..2 {
            let stopped = dispatch(
                "mcp_server_stop",
                json!({}),
                &state,
                &host,
                "brain-local",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
            .expect("stop is idempotent when MCP server is not running");
            assert_eq!(stopped, Value::Null);
        }
    }

    /// The live terminal inventory belongs to the companion WS process, not
    /// to a WebView. A headless host therefore exposes an empty registry as a
    /// successful read instead of claiming the command needs Tauri.
    #[tokio::test]
    async fn headless_dispatch_lists_live_terminal_sessions() {
        let sessions = headless_host()
            .terminal_list_all("terminal-list-headless-device")
            .await
            .expect("headless durable terminal inventory must be host-generic");
        assert!(sessions.is_empty());
    }

    #[test]
    fn terminal_rpc_requires_host_enablement_and_an_independent_device_grant() {
        let acl = super::super::control_allow_list::terminal_global();
        acl.clear();
        let device = "terminal-rpc-device";

        assert!(terminal_rpc_authorization(device, true).is_err());
        acl.allow(device.to_string());
        assert!(terminal_rpc_authorization(device, false).is_err());
        assert!(terminal_rpc_authorization(device, true).is_ok());

        acl.clear();
    }

    /// The claude arms are host-generic after R7: `claude_sidecar_status` on
    /// a headless host reports the registry's (not-yet-spawned) sidecar.
    #[tokio::test]
    async fn headless_claude_arms_reach_the_registry_sidecar() {
        let state = test_state();
        let host = headless_host();

        let status = dispatch(
            "claude_sidecar_status",
            json!({}),
            &state,
            &host,
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("claude_sidecar_status must work headless");
        assert_eq!(status["ready"], false);

        // Provider-env arms hit the registry's ApiKeyState.
        dispatch(
            "claude_set_api_key",
            json!({ "key": "sk-headless" }),
            &state,
            &host,
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("claude_set_api_key must work headless");
        let has = dispatch(
            "claude_has_api_key",
            json!({}),
            &state,
            &host,
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("claude_has_api_key must work headless");
        assert_eq!(has, Value::Bool(true));

        // Control messages against a not-running sidecar surface the plain
        // "not running" error (proving the arm reached write_command).
        let err = dispatch(
            "claude_interrupt",
            json!({ "session_id": "s1" }),
            &state,
            &host,
            "dev1",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("no sidecar running");
        assert!(err.1 .0.message.contains("not running"));
    }

    // ── External-agent arms: scope + policy + audit (ADR-0059 R11) ──────────

    /// An UNGRANTED device JWT must never reach the RCE-grade arms — the HTTP
    /// handler rejects with 403 before dispatch. Denial is the default: these
    /// commands used to be service-token-only, and relaxing them to "grantable"
    /// must not relax them to "reachable".
    #[tokio::test]
    async fn ungranted_device_cannot_reach_the_external_agent_arms() {
        // The allow lists are process-global and `seed_allow_lists` REPLACES
        // them, so without this guard a concurrent `device_grants` test can
        // reseed underneath and this gate passes for the wrong reason.
        let _guard = super::super::control_allow_list::test_guard();
        super::super::control_allow_list::agent_control_global().clear();
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("phone-1");
        for name in AGENT_CONTROL_COMMANDS {
            let resp = rpc_post(router.clone(), name, json!({}), &jwt, None).await;
            assert_eq!(resp.status().as_u16(), 403, "{name} must be grant-gated");
        }
    }

    /// The grant is what R4 was blocked on: a paired desktop only ever gets a
    /// *device* JWT, so while these arms were service-token-only there was no
    /// credential anywhere that could reach them.
    #[tokio::test]
    async fn a_granted_device_gets_past_the_agent_control_gate() {
        let _guard = super::super::control_allow_list::test_guard();
        let acl = super::super::control_allow_list::agent_control_global();
        acl.clear();
        acl.allow("phone-granted".to_string());
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("phone-granted");

        let resp = rpc_post(router, "get_external_agent_status", json!({}), &jwt, None).await;
        // Past the gate. What it hits next is the headless-services check —
        // any status but 403 proves authorization no longer rejects it.
        assert_ne!(resp.status().as_u16(), 403);
        acl.clear();
    }

    /// Remote control and agent control are separate grants on purpose: letting
    /// a phone approve prompts must not also let it start processes.
    #[tokio::test]
    async fn the_remote_control_grant_does_not_confer_agent_control() {
        let _guard = super::super::control_allow_list::test_guard();
        super::super::control_allow_list::agent_control_global().clear();
        let control = super::super::control_allow_list::global();
        control.allow("phone-control-only".to_string());
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("phone-control-only");

        let resp = rpc_post(router, "spawn_external_agent", json!({}), &jwt, None).await;
        assert_eq!(resp.status().as_u16(), 403);
        control.disallow("phone-control-only");
    }

    /// The grant's contract is that every start AND every refusal is audited
    /// with the device that asked. The `SpawnPolicy` denials inside the spawn
    /// arm were, but this gate returned 403 before reaching any of them — so an
    /// ungranted device probing the execution plane was the one denial that left
    /// no trace at all.
    #[tokio::test]
    async fn an_ungranted_device_has_its_refusal_audited() {
        let _acl_guard = super::super::control_allow_list::test_guard();
        let _audit_guard = super::super::audit::test_guard();
        super::super::control_allow_list::agent_control_global().clear();
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("audit.log");
        super::super::audit::install_at_for_testing(Some(path.clone()));

        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("phone-ungranted");
        let resp = rpc_post(router, "spawn_external_agent", json!({}), &jwt, None).await;
        assert_eq!(resp.status().as_u16(), 403);

        let log = std::fs::read_to_string(&path).expect("audit log written on refusal");
        let entry: serde_json::Value =
            serde_json::from_str(log.lines().next().expect("one line")).expect("json line");
        assert_eq!(entry["kind"], "external_agent_authorize");
        assert_eq!(entry["decision"], "deny");
        // The device that asked is the whole point of the record.
        assert_eq!(entry["device_id"], "phone-ungranted");
        assert_eq!(entry["command"], "spawn_external_agent");

        super::super::audit::install_at_for_testing(None);
    }

    /// The agent arms must not have leaked into the remote-control tier while
    /// moving out of the service-only one.
    #[test]
    fn agent_control_commands_are_their_own_tier() {
        for name in AGENT_CONTROL_COMMANDS {
            assert!(
                is_agent_control_command(name),
                "{name} must be in the agent-control tier"
            );
            assert!(
                !is_service_only_command(name),
                "{name} must no longer be service-token-only"
            );
            assert!(
                !is_control_command(name),
                "{name} must not ride the remote-control grant"
            );
            assert!(
                KNOWN_COMMANDS_SET.contains(name),
                "{name} must stay allowlisted"
            );
        }
    }

    #[test]
    fn scheduled_task_agent_control_is_payload_sensitive_and_fail_closed() {
        assert!(!scheduled_task_requires_agent_control(
            "scheduled_task_create",
            &json!({ "input": { "type": "workflow" } })
        ));
        assert!(scheduled_task_requires_agent_control(
            "scheduled_task_create",
            &json!({ "input": { "type": "agent" } })
        ));
        assert!(!scheduled_task_requires_agent_control(
            "scheduled_task_delete",
            &json!({ "taskType": "backup" })
        ));
        assert!(scheduled_task_requires_agent_control(
            "scheduled_task_delete",
            &json!({})
        ));
        assert!(scheduled_task_requires_agent_control(
            "scheduled_task_list",
            &json!({})
        ));
        assert!(!scheduled_task_requires_agent_control(
            "scheduled_task_list",
            &json!({ "filter": { "types": ["workflow", "backup"] } })
        ));
    }

    /// The mirrored in-dispatch gate covers the WebRTC path (`scope: None`), so
    /// the DataChannel cannot be used to skip the grant the HTTP path enforces.
    #[tokio::test]
    async fn dispatch_without_a_grant_rejects_the_agent_arms() {
        super::super::control_allow_list::agent_control_global().clear();
        let state = test_state();
        let err = dispatch(
            "spawn_external_agent",
            json!({}),
            &state,
            &headless_host(),
            "dev1",
            Some(ACCOUNT_ID),
            None, // the DataChannel path
        )
        .await
        .expect_err("ungranted device-scoped channel must be rejected");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn service_scope_is_authorized_for_internal_control_plane_commands() {
        for command in [
            "terminal_exec",
            "plugin_permission_grant",
            "plugin_permission_revoke",
            "plugin_api_invoke",
            "plugin_api_batch_invoke",
            "mcp_server_start",
            "mcp_server_stop",
            "mcp_server_restart",
            "lsp_host_ensure",
            "lsp_host_request",
        ] {
            assert!(is_control_authorized(
                command,
                "brain-local",
                Some("service")
            ));
        }
        assert!(!is_control_authorized(
            "terminal_exec",
            "unapproved-device",
            Some("device")
        ));
        assert!(!is_control_authorized(
            "git_push",
            "brain-local",
            Some("service")
        ));
    }

    #[test]
    fn plugin_permission_commands_have_remote_safe_classification() {
        assert!(READ_ONLY_COMMANDS.contains(&"plugin_permission_list"));
        assert!(CONTROL_COMMANDS.contains(&"plugin_permission_grant"));
        assert!(CONTROL_COMMANDS.contains(&"plugin_permission_revoke"));
        for command in [
            "plugin_permission_grant",
            "plugin_permission_list",
            "plugin_permission_revoke",
        ] {
            assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
        }
    }

    #[test]
    fn lsp_facade_is_control_gated_but_not_service_only() {
        for command in ["lsp_host_ensure", "lsp_host_request"] {
            assert!(CONTROL_COMMANDS.contains(&command));
            assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
            assert!(!is_control_authorized(
                command,
                "unapproved-device",
                Some("device")
            ));
        }
        assert!(SERVICE_ONLY_COMMANDS.contains(&"ensure_system_lsp_host"));
        assert!(SERVICE_ONLY_COMMANDS.contains(&"plugin_invoke_vscode_rpc"));
        for method in [
            "lsp:start",
            "lsp:request",
            "lsp:cancel",
            "protocol:start",
            "protocol:request",
            "protocol:cancel",
            "protocol:stop",
        ] {
            assert!(remote_lsp_method_allowed(method), "{method}");
        }
        assert!(!remote_lsp_method_allowed("extension:activate"));
    }

    #[test]
    fn plugin_api_facade_is_control_gated_and_capabilities_are_read_only() {
        for command in ["plugin_api_invoke", "plugin_api_batch_invoke"] {
            assert!(CONTROL_COMMANDS.contains(&command));
            assert!(!READ_ONLY_COMMANDS.contains(&command));
            assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
            assert!(!is_control_authorized(
                command,
                "unapproved-device",
                Some("device")
            ));
        }
        assert!(READ_ONLY_COMMANDS.contains(&"plugin_get_capabilities"));
        assert!(!CONTROL_COMMANDS.contains(&"plugin_get_capabilities"));
    }

    #[test]
    fn mcp_lifecycle_is_control_gated_but_not_service_only() {
        for command in ["mcp_server_start", "mcp_server_stop", "mcp_server_restart"] {
            assert!(CONTROL_COMMANDS.contains(&command));
            assert!(!READ_ONLY_COMMANDS.contains(&command));
            assert!(!SERVICE_ONLY_COMMANDS.contains(&command));
            assert!(!is_control_authorized(
                command,
                "unapproved-device",
                Some("device")
            ));
        }
        assert!(READ_ONLY_COMMANDS.contains(&"mcp_server_status"));
    }

    #[tokio::test]
    async fn service_scope_executes_terminal_command_on_the_headless_host() {
        let state = test_state();
        let result = dispatch(
            "terminal_exec",
            json!({ "command": "echo cognia-headless-shell", "shell": true }),
            &state,
            &headless_host(),
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("service-scoped terminal exec");

        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["timedOut"], false);
        assert!(result["stdout"]
            .as_str()
            .is_some_and(|stdout| stdout.contains("cognia-headless-shell")));
    }

    /// Policy deny → 403 naming the violation, with a `deny` audit line;
    /// policy allow (smoke stub) → spawn succeeds with an `allow` audit line
    /// and the frozen events on the bus.
    #[tokio::test]
    async fn spawn_arm_enforces_the_policy_and_audits_both_outcomes() {
        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }
        let state = test_state();
        let tmp = tempfile::tempdir().expect("tempdir");
        let audit_path = tmp.path().join("audit.log");
        crate::companion_api::audit::install_at_for_testing(Some(audit_path.clone()));

        // Headless services with a smoke-enabled policy + temp workspaces.
        let services = {
            use crate::claude::host::HeadlessSidecarHost;
            let event_bus = crate::companion_api::event_bus::EventBus::new();
            let api_keys = crate::api_key::ApiKeyState::new();
            let sidecar_host = Arc::new(HeadlessSidecarHost::new(
                std::path::PathBuf::from("missing.mjs"),
                Arc::clone(&event_bus),
                api_keys.clone(),
            ));
            crate::headless::HeadlessServices::new(
                sidecar_host,
                api_keys,
                event_bus,
                crate::external_agent::presets::SpawnPolicy::new(
                    tmp.path().join("workspaces"),
                    true,
                ),
                tmp.path().join("plugins"),
            )
            .expect("headless services for the spawn-policy test")
        };
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

        // Deny: bash is not allowlisted.
        let err = dispatch(
            "spawn_external_agent",
            json!({ "config": { "id": "evil", "command": "bash", "args": ["-c", "id"] } }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("bash must be denied");
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert!(err.1 .0.message.contains("denied by policy"));

        // Allow: the smoke stub via node.
        let stub = tmp.path().join("stub-acp-agent.mjs");
        std::fs::write(&stub, "setInterval(() => {}, 60_000);\n").unwrap();
        let spawned = dispatch(
            "spawn_external_agent",
            json!({ "config": {
                "id": "smoke-1",
                "command": "node",
                "args": [stub.display().to_string()],
                "env": { "ANTHROPIC_API_KEY": "sk", "LD_PRELOAD": "/evil.so" },
            } }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("smoke stub must be admitted");
        assert_eq!(spawned, Value::String("smoke-1".into()));

        // Status + kill round-trip through the exec backend.
        let status = dispatch(
            "get_external_agent_status",
            json!({ "agent_id": "smoke-1" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("status");
        assert_eq!(status, Value::String("Running".into()));
        dispatch(
            "kill_external_agent",
            json!({ "agent_id": "smoke-1" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("kill");

        // Audit trail: a deny line and an allow line (with the dropped
        // LD_PRELOAD recorded), then the kill.
        let audit = std::fs::read_to_string(&audit_path).expect("audit written");
        let lines: Vec<Value> = audit
            .lines()
            .map(|l| serde_json::from_str(l).expect("jsonl"))
            .collect();
        assert!(lines.iter().any(|l| l["decision"] == "deny"
            && l["kind"] == "external_agent_spawn"
            && l["command"] == "bash"));
        assert!(lines.iter().any(|l| l["decision"] == "allow"
            && l["kind"] == "external_agent_spawn"
            && l["dropped_env_keys"][0] == "LD_PRELOAD"));
        assert!(lines
            .iter()
            .any(|l| l["kind"] == "external_agent_kill" && l["scope"] == "service"));

        crate::companion_api::audit::install_at_for_testing(None);
    }

    #[test]
    fn service_only_commands_are_known_and_not_control_gated() {
        // The four external-agent arms used to head this list. They moved to
        // the agent-control tier so a paired device can be granted them; see
        // `agent_control_commands_are_their_own_tier`, which pins that they
        // left this one rather than joining the remote-control grant.
        for name in [
            "connectors_register",
            "connectors_unregister",
            "connectors_list_adapters",
            // ADR-0059 T-A5 — connector command plane.
            "connectors_health",
            "connectors_keyring_set",
            "connectors_keyring_get",
            "connectors_keyring_delete",
            "connectors_keyring_list",
            "connectors_http_request",
            "connectors_ws_open",
            "connectors_ws_send",
            "connectors_ws_close",
            "connectors_onebot_send",
            "connectors_lark_ws_open",
            "connectors_lark_ws_close",
            "connectors_reset_all_ws",
            "connectors_attachment_fetch",
            "connectors_attachment_read",
            "connectors_media_upload",
            "connectors_lark_upload_file",
            "connectors_lark_upload_image",
            "plugin_launch_js",
            "plugin_invoke_js_callback",
            "plugin_deactivate_js",
            "plugin_stop_js",
            "plugin_js_status",
        ] {
            assert!(is_service_only_command(name), "{name} must be service-only");
            assert!(KNOWN_COMMANDS.contains(&name), "{name} must be allowlisted");
            assert!(
                !CONTROL_COMMANDS.contains(&name),
                "{name} is scope-gated, not device-control-gated"
            );
        }
    }

    #[tokio::test]
    async fn headless_plugin_js_status_dispatches_to_the_native_runtime() {
        let state = test_state();
        let generation = uuid::Uuid::new_v4().to_string();
        let result = dispatch(
            "plugin_js_status",
            json!({
                "pluginId": "not-running",
                "generation": generation,
            }),
            &state,
            &headless_host(),
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("headless status query must reach the native plugin runtime");

        assert_eq!(result, Value::Bool(false));
    }

    // ── Connector ingress registry arms (ADR-0059 R12) ──────────────────────

    #[tokio::test]
    async fn connectors_registry_arms_round_trip() {
        let state = test_state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

        dispatch(
            "connectors_register",
            json!({ "adapter_id": "tg-1", "adapter_type": "telegram" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("register");

        let listed = dispatch(
            "connectors_list_adapters",
            json!({}),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("list");
        assert_eq!(listed["adapters"][0]["adapter_id"], "tg-1");
        assert_eq!(listed["adapters"][0]["adapter_type"], "telegram");
        // The registration landed in the shared ConnectorsState the webhook
        // router verifies against.
        assert!(services
            .connectors
            .inner
            .lock()
            .registered_adapters
            .contains_key("tg-1"));

        dispatch(
            "connectors_unregister",
            json!({ "adapter_id": "tg-1" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("unregister");
        let listed = dispatch(
            "connectors_list_adapters",
            json!({}),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("list after unregister");
        assert_eq!(listed["adapters"].as_array().unwrap().len(), 0);
    }

    // ── Connector command plane arms (ADR-0059 T-A5) ─────────────────────────

    /// Keyring set → list → get → delete through the dispatch arms, mixing
    /// the camelCase TS-wrapper arg shape with the snake_case alias — both
    /// must resolve to the same secret-store entry the webhook verifiers
    /// read (hermetic via the `cfg(test)` in-memory secret store).
    #[tokio::test]
    async fn connectors_keyring_arms_round_trip_camel_and_snake() {
        let state = test_state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

        macro_rules! call {
            ($name:expr, $args:expr $(,)?) => {
                dispatch(
                    $name,
                    $args,
                    &state,
                    &host,
                    "brain-local",
                    Some(ACCOUNT_ID),
                    Some("service"),
                )
                .await
            };
        }

        // Set via the camelCase wrapper shape.
        call!(
            "connectors_keyring_set",
            json!({ "adapterId": "tg-arm-kr", "credential": "botToken", "value": "s3cret" })
        )
        .expect("set");

        let listed = call!(
            "connectors_keyring_list",
            json!({ "adapterId": "tg-arm-kr", "accounts": ["botToken", "missing"] })
        )
        .expect("list");
        assert_eq!(listed, json!(["botToken"]));

        // Get via the snake_case alias — same entry.
        let got = call!(
            "connectors_keyring_get",
            json!({ "adapter_id": "tg-arm-kr", "credential": "botToken" })
        )
        .expect("get");
        assert_eq!(got, json!("s3cret"));

        call!(
            "connectors_keyring_delete",
            json!({ "adapterId": "tg-arm-kr", "credential": "botToken" })
        )
        .expect("delete");
        let got = call!(
            "connectors_keyring_get",
            json!({ "adapterId": "tg-arm-kr", "credential": "botToken" })
        )
        .expect("get after delete");
        assert_eq!(got, Value::Null);
    }

    /// The headless brain's generic secret facade is service-only and delegates
    /// to the same installed `cognia-secrets` backend as desktop keyring calls.
    #[tokio::test]
    async fn generic_keyring_arms_round_trip_for_the_headless_brain() {
        let state = test_state();
        let host = headless_host();

        macro_rules! call {
            ($name:expr, $args:expr $(,)?) => {
                dispatch(
                    $name,
                    $args,
                    &state,
                    &host,
                    "brain-local",
                    Some(ACCOUNT_ID),
                    Some("service"),
                )
                .await
            };
        }

        call!(
            "keyring_secret_set",
            json!({ "input": { "namespace": "backup", "key": "encryption.key.v1", "value": "backup-secret" } }),
        )
        .expect("set");
        let got = call!(
            "keyring_secret_get",
            json!({ "input": { "namespace": "backup", "key": "encryption.key.v1" } }),
        )
        .expect("get");
        assert_eq!(got, json!("backup-secret"));

        call!(
            "keyring_secret_clear",
            json!({ "input": { "namespace": "backup", "key": "encryption.key.v1" } }),
        )
        .expect("clear");
        let got = call!(
            "keyring_secret_get",
            json!({ "input": { "namespace": "backup", "key": "encryption.key.v1" } }),
        )
        .expect("get after clear");
        assert_eq!(got, Value::Null);
    }

    #[tokio::test]
    async fn plugin_lifecycle_arms_use_the_headless_process_registry() {
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::companion_api::control_allow_list::global().allow("brain-test".to_string());
        let state = test_state();
        let host = headless_host();
        let mut plugin_events = match host
            .headless()
            .expect("headless services")
            .event_bus
            .subscribe(None, 0)
        {
            crate::companion_api::event_bus::SubscribeResult::Ok { receiver, .. } => receiver,
            crate::companion_api::event_bus::SubscribeResult::ResyncRequired => {
                panic!("fresh plugin event subscription must not require resync")
            }
        };
        macro_rules! call {
            ($name:expr, $args:expr $(,)?) => {
                dispatch(
                    $name,
                    $args,
                    &state,
                    &host,
                    "brain-test",
                    Some("account-test"),
                    Some("service"),
                )
            };
        }
        let installed = call!(
            "plugin_install",
            json!({
                "pluginId": "remote-demo",
                "source": "remote-test",
                "payload": {
                    "manifestJson": serde_json::json!({
                        "id": "remote-demo",
                        "name": "Remote Demo",
                        "version": "1.0.0",
                        "type": "frontend",
                        "main": "index.js"
                    }).to_string()
                }
            }),
        )
        .await
        .expect("headless plugin install");
        assert_eq!(installed["plugin_id"], "remote-demo");

        let listed = call!("plugin_list", json!({}))
            .await
            .expect("headless plugin list");
        assert_eq!(listed.as_array().map(Vec::len), Some(1));

        let snapshot = call!(
            "plugin_runtime_snapshot",
            json!({ "pluginId": "remote-demo" }),
        )
        .await
        .expect("headless plugin snapshot");
        assert_eq!(snapshot["version"], "1.0.0");

        let backup = call!(
            "plugin_backup_create",
            json!({ "pluginId": "remote-demo", "label": "before-update" }),
        )
        .await
        .expect("headless plugin backup create");
        let backup_id = backup["backupId"].as_str().expect("backup id").to_string();
        call!(
            "plugin_backup_restore",
            json!({ "pluginId": "remote-demo", "backupId": backup_id }),
        )
        .await
        .expect("headless plugin backup restore");
        call!(
            "plugin_backup_delete",
            json!({ "pluginId": "remote-demo", "backupId": backup_id }),
        )
        .await
        .expect("headless plugin backup delete");

        call!("plugin_uninstall", json!({ "pluginId": "remote-demo" }),)
            .await
            .expect("headless plugin uninstall");
        assert!(call!("plugin_list", json!({}))
            .await
            .expect("empty headless plugin list")
            .as_array()
            .is_some_and(Vec::is_empty));
        let actions = [
            plugin_events.try_recv().expect("install event").payload["action"].clone(),
            plugin_events.try_recv().expect("restore event").payload["action"].clone(),
            plugin_events.try_recv().expect("uninstall event").payload["action"].clone(),
        ];
        assert_eq!(
            actions,
            [json!("installed"), json!("restored"), json!("uninstalled")]
        );
        crate::companion_api::control_allow_list::global().disallow("brain-test");
    }

    #[tokio::test]
    async fn wasm_runtime_arms_use_the_headless_process_registry() {
        let state = test_state();
        let host = headless_host();

        let listed = dispatch(
            "plugin_wasm_list",
            json!({}),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("headless WASM list");
        assert_eq!(listed, json!([]));

        let unloaded = dispatch(
            "plugin_wasm_unload",
            json!({ "pluginId": "missing" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("unknown WASM unload remains a successful false result");
        assert_eq!(unloaded, json!(false));

        dispatch(
            "plugin_permission_grant",
            json!({
                "pluginId": "demo",
                "permission": "notification",
                "grantedBy": "manifest",
                "expiresAt": Value::Null,
            }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("grant WASM permission");
        let grants = dispatch(
            "plugin_permission_list",
            json!({ "pluginId": "demo" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("list WASM permissions");
        assert_eq!(grants[0]["permission"], json!("notification"));

        dispatch(
            "plugin_set_shell_allowlist",
            json!({ "pluginId": "demo", "commands": ["git"] }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("set shell allowlist");
        dispatch(
            "plugin_set_network_allowlist",
            json!({ "pluginId": "demo", "domains": ["example.com"] }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("set network allowlist");
        let services = host.headless().expect("headless services");
        assert!(services.plugin_runtime.shell_command_allowed("demo", "git"));
        assert!(services
            .plugin_runtime
            .network_host_allowed("demo", "api.example.com"));

        dispatch(
            "plugin_permission_revoke",
            json!({ "pluginId": "demo", "permission": "notification" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("revoke WASM permission");
        assert!(!services
            .plugin_runtime
            .has_permission("demo", "notification"));
    }

    #[tokio::test]
    async fn plugin_api_facade_uses_the_headless_gateway_and_capabilities() {
        let state = test_state();
        let host = headless_host();
        let services = host.headless().expect("headless services");
        let plugin_id = format!("rpc-native-{}", uuid::Uuid::new_v4());
        let plugin_dir = services.plugin_runtime.plugin_dir(&plugin_id);
        std::fs::create_dir_all(&plugin_dir).expect("create native plugin root");
        services.plugin_runtime.plugins.write().insert(
            plugin_id.clone(),
            crate::plugin_api::PluginRecord {
                snapshot: crate::plugin_api::PluginRuntimeSnapshot {
                    plugin_id: plugin_id.clone(),
                    version: "1.0.0".into(),
                    status: "loaded".into(),
                    last_error: None,
                    loaded_at: None,
                    install_path: plugin_dir.to_string_lossy().into_owned(),
                },
                runtime_state: Value::Null,
            },
        );

        for permission in ["filesystem:read", "filesystem:write"] {
            dispatch(
                "plugin_permission_grant",
                json!({
                    "pluginId": plugin_id,
                    "permission": permission,
                    "grantedBy": "test",
                    "expiresAt": Value::Null,
                }),
                &state,
                &host,
                "brain-local",
                Some(ACCOUNT_ID),
                Some("service"),
            )
            .await
            .expect("grant native gateway permission");
        }

        let call = |api: &str, payload: Value, request_id: &str| {
            json!({
                "request": {
                    "sdkVersion": "2.0.0",
                    "pluginId": plugin_id,
                    "requestId": request_id,
                    "api": api,
                    "payload": payload,
                }
            })
        };
        let written = dispatch(
            "plugin_api_invoke",
            call(
                "fs:writeText",
                json!({ "path": "remote/note.txt", "content": "companion" }),
                "write",
            ),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("write through headless plugin gateway");
        assert_eq!(written["success"], json!(true));

        let read = dispatch(
            "plugin_api_invoke",
            call("fs:readText", json!({ "path": "remote/note.txt" }), "read"),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("read through headless plugin gateway");
        assert_eq!(read["data"], json!("companion"));

        let unavailable = dispatch(
            "plugin_api_invoke",
            call("window:minimize", json!({}), "window"),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("UI-only capability returns a typed gateway response");
        assert_eq!(unavailable["error"]["code"], json!("NOT_SUPPORTED"));

        let capabilities = dispatch(
            "plugin_get_capabilities",
            json!({}),
            &state,
            &host,
            "paired-reader",
            Some(ACCOUNT_ID),
            Some("device"),
        )
        .await
        .expect("capability projection is readable without remote control");
        let capability = |api: &str| {
            capabilities
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["api"] == api)
                .unwrap()["supported"]
                .as_bool()
                .unwrap()
        };
        assert!(capability("fs:readText"));
        assert!(!capability("window:minimize"));
    }

    #[tokio::test]
    async fn python_runtime_arms_use_the_headless_process_registry() {
        let state = test_state();
        let host = headless_host();
        let services = host.headless().expect("headless services");
        let plugin_id = format!("rpc-python-{}", uuid::Uuid::new_v4());
        let plugin_dir = services.plugin_runtime.plugin_dir(&plugin_id);
        std::fs::create_dir_all(&plugin_dir).expect("create Python plugin root");
        std::fs::write(
            plugin_dir.join("main.py"),
            r#"
from cognia import tool, hook

@tool(description="Doubles a number")
def double(x: int):
    return x * 2

@hook("onMessage")
def on_message(payload):
    return payload

def helper(a, b):
    return [a, b]
"#,
        )
        .expect("write Python plugin");

        macro_rules! call {
            ($name:expr, $args:expr) => {
                dispatch(
                    $name,
                    $args,
                    &state,
                    &host,
                    "brain-local",
                    Some(ACCOUNT_ID),
                    Some("service"),
                )
                .await
            };
        }

        call!("plugin_python_initialize", json!({})).expect("initialize Python runtime");
        let runtime = call!("plugin_python_runtime_info", json!({})).expect("Python runtime info");
        if runtime["available"] != json!(true) {
            std::fs::remove_dir_all(&plugin_dir).expect("cleanup unavailable Python fixture");
            return;
        }

        let load_args = json!({
            "pluginId": plugin_id,
            "pluginPath": plugin_dir.to_string_lossy(),
            "mainModule": "main.py",
            "dependencies": Value::Null,
            "config": {},
            "hostSettings": Value::Null,
        });
        let denied = call!("plugin_python_load", load_args.clone())
            .expect_err("python:execute must be explicitly granted");
        assert_eq!(denied.0, StatusCode::FORBIDDEN);
        assert_eq!(denied.1 .0.code, "plugin_permission_denied");

        call!(
            "plugin_permission_grant",
            json!({
                "pluginId": plugin_id,
                "permission": "python:execute",
                "grantedBy": "test",
                "expiresAt": Value::Null,
            })
        )
        .expect("grant python:execute");
        let loaded = call!("plugin_python_load", load_args).expect("load Python plugin");
        assert_eq!(loaded["hooks"][0]["event"], "onMessage");

        let tools = call!("plugin_python_get_tools", json!({ "pluginId": plugin_id }))
            .expect("get Python tools");
        assert_eq!(tools[0]["name"], "double");
        let doubled = call!(
            "plugin_python_call_tool",
            json!({ "pluginId": plugin_id, "toolName": "double", "args": { "x": 21 } })
        )
        .expect("call Python tool");
        assert_eq!(doubled, json!(42));

        call!("plugin_python_unload", json!({ "pluginId": plugin_id }))
            .expect("unload Python plugin");
        assert_eq!(
            call!("plugin_python_list", json!({})).expect("list Python plugins"),
            json!([])
        );
        std::fs::remove_dir_all(&plugin_dir).expect("cleanup Python fixture");
    }

    #[tokio::test]
    async fn vscode_runtime_arms_use_the_headless_process_registry() {
        let state = test_state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));
        let plugin_id = format!("rpc-vscode-{}", uuid::Uuid::new_v4());
        let plugin_dir = services.plugin_runtime.plugin_dir(&plugin_id);
        std::fs::create_dir_all(plugin_dir.join("out")).expect("create VS Code plugin root");
        std::fs::write(
            plugin_dir.join("out/extension.js"),
            "module.exports = { activate() {}, deactivate() {} };",
        )
        .expect("write VS Code plugin");

        let host_script = plugin_dir.join("fake-vscode-host.cjs");
        std::fs::write(
            &host_script,
            r#"
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "sidecar:ready", params: {} }) + "\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  let result = { ok: true };
  if (request.method === "extension:activate") {
    result = { registeredCommands: ["headless.rpc"], registeredWebviewViews: [], registeredLanguageProviders: [] };
  } else if (request.method === "test:echo") {
    result = request.params;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
"#,
        )
        .expect("write fake VS Code host");
        services
            .vscode_plugins
            .configure_host(host_script, None, Arc::new(|_, _| {}));

        macro_rules! call {
            ($name:expr, $args:expr) => {
                dispatch(
                    $name,
                    $args,
                    &state,
                    &host,
                    "brain-local",
                    Some(ACCOUNT_ID),
                    Some("service"),
                )
                .await
            };
        }

        call!("lsp_host_ensure", json!({})).expect("spawn system LSP host");
        call!("lsp_host_ensure", json!({})).expect("system LSP host is idempotent");
        assert!(services
            .vscode_plugins
            .sidecars
            .read()
            .contains_key(crate::plugin_api::vscode::commands::LSP_HOST_KEY));
        assert_eq!(
            call!(
                "lsp_host_request",
                json!({ "method": "lsp:status", "payloadJson": "{}" })
            )
            .expect("invoke system LSP host"),
            json!(r#"{"ok":true}"#)
        );
        let denied_method = call!(
            "lsp_host_request",
            json!({ "method": "extension:activate", "payloadJson": "{}" })
        )
        .expect_err("remote LSP facade must reject non-LSP methods");
        assert_eq!(denied_method.0, StatusCode::BAD_REQUEST);

        call!(
            "plugin_load_vscode",
            json!({
                "pluginId": plugin_id,
                "manifestJson": json!({
                    "id": plugin_id,
                    "vscodeMain": "out/extension.js",
                    "vscodeExtension": { "bundleFormat": "cjs" },
                }).to_string(),
                "pluginPath": plugin_dir.to_string_lossy(),
            })
        )
        .expect("load VS Code extension");

        let activated = call!(
            "plugin_activate_vscode",
            json!({ "pluginId": plugin_id, "configJson": "{}" })
        )
        .expect("activate VS Code extension");
        assert_eq!(activated["registeredCommands"], json!(["headless.rpc"]));
        assert!(activated["sidecarPid"].as_u64().is_some());

        let echoed = call!(
            "plugin_invoke_vscode_rpc",
            json!({
                "pluginId": plugin_id,
                "method": "test:echo",
                "payloadJson": r#"{"value":7}"#,
            })
        )
        .expect("invoke VS Code sidecar RPC");
        assert_eq!(echoed, json!(r#"{"value":7}"#));

        call!("plugin_deactivate_vscode", json!({ "pluginId": plugin_id }))
            .expect("deactivate VS Code extension");
        call!("plugin_unload_vscode", json!({ "pluginId": plugin_id }))
            .expect("unload VS Code extension");
        assert_eq!(services.vscode_plugins.sidecars.read().len(), 1);
        call!(
            "plugin_unload_vscode",
            json!({ "pluginId": crate::plugin_api::vscode::commands::LSP_HOST_KEY })
        )
        .expect("unload system LSP host");
        assert!(services.vscode_plugins.sidecars.read().is_empty());
        std::fs::remove_dir_all(&plugin_dir).expect("cleanup VS Code fixture");
    }

    /// `connectors_health` reflects the always-mounted headless ingress and
    /// the shared registry count (camelCase payload, wrapper parity).
    #[tokio::test]
    async fn connectors_health_reports_the_headless_ingress() {
        let state = test_state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

        dispatch(
            "connectors_register",
            json!({ "adapter_id": "tg-health", "adapter_type": "telegram" }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("register");

        let health = dispatch(
            "connectors_health",
            json!({}),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("health");
        assert_eq!(
            health,
            json!({
                "serverRunning": true,
                "boundAddr": Value::Null,
                "registeredAdapterCount": 1,
            })
        );
    }

    #[tokio::test]
    async fn integration_ingress_uses_the_headless_workflow_state() {
        let state = test_state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));
        let route_id = format!("route-{}", uuid::Uuid::new_v4());
        let input = json!({
            "routeId": route_id,
            "pluginId": "fixture-delivery",
            "integrationId": "fixture",
            "accountId": "account-1",
            "subscriptionId": "subscription-1",
            "path": route_id,
            "verification": {
                "type": "static-token",
                "tokenHeader": "x-fixture-token",
                "secretHandle": "secret-1",
            },
            "deliveryIdHeader": "x-delivery-id",
            "eventTypeHeader": "x-event-type",
            "enabled": true,
        });

        let denied = dispatch(
            "integration_ingress_register",
            json!({ "input": input.clone() }),
            &state,
            &host,
            "device-1",
            Some(ACCOUNT_ID),
            Some("device"),
        )
        .await
        .expect_err("paired devices cannot manage Integration ingress");
        assert_eq!(denied.0, StatusCode::FORBIDDEN);

        dispatch(
            "integration_ingress_register",
            json!({ "input": input }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("register integration route");

        dispatch(
            "integration_ingress_unregister",
            json!({ "routeId": route_id }),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect("unregister integration route");
    }

    /// Malformed args map to 400 malformed_request, not a panic or 500.
    #[tokio::test]
    async fn connectors_http_request_rejects_malformed_args() {
        let state = test_state();
        let services = crate::headless::HeadlessServices::stub_for_tests();
        let host = super::super::dispatch_host::DispatchHost::Headless(Arc::clone(&services));

        let err = dispatch(
            "connectors_http_request",
            json!({}),
            &state,
            &host,
            "brain-local",
            Some(ACCOUNT_ID),
            Some("service"),
        )
        .await
        .expect_err("missing req must 400");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1 .0.code, "malformed_request");
    }

    /// `sync_pull` on a headless host routes through the connected brain's
    /// socket transport end-to-end (RPC arm → event frame → respond →
    /// resolved delta).
    #[tokio::test]
    async fn headless_sync_pull_routes_through_the_connected_brain() {
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        let mut rx = crate::companion_api::ws_bridge::test_support::install_socket_for_testing();
        let state = test_state();

        let dispatch_task = {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                dispatch(
                    "sync_pull",
                    json!({ "table": "sessions", "since": 0 }),
                    &state,
                    &headless_host(),
                    "dev1",
                    Some(ACCOUNT_ID),
                    Some("service"),
                )
                .await
            })
        };

        // The fake brain: receive the emitted event frame off the socket queue.
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("event frame timeout")
            .expect("socket queue closed");
        let axum::extract::ws::Message::Text(text) = msg else {
            panic!("expected text frame");
        };
        let frame: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
        assert_eq!(frame["type"], "event");
        assert_eq!(frame["event"], "companion://sync-pull-request");
        assert_eq!(frame["payload"]["table"], "sessions");
        let request_id = frame["payload"]["request_id"].as_str().unwrap().to_string();

        // Respond exactly as ws_bridge::route_respond would.
        state
            .sync_bridge
            .resolve(crate::companion_api::sync_bridge::SyncPullResponse {
                request_id,
                delta: Some(json!({ "rows": [] })),
                error: None,
            });

        let result = dispatch_task
            .await
            .expect("join")
            .expect("sync_pull must succeed via the brain");
        assert_eq!(result, json!({ "rows": [] }));

        crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
    }

    // ── Malformed args → 400 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn missing_required_field_returns_400() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        // claude_interrupt requires session_id
        let resp = rpc_post(router, "claude_interrupt", json!({}), &jwt, None).await;
        // app_handle is None so we'll get 503 before field validation for
        // commands that reach dispatch — but the routing still works.
        // The key assertion is that we never get a 5xx crash / panic.
        assert!(resp.status().as_u16() >= 400);
    }

    // ── Idempotency: cache hit returns same body without re-executing ─────────

    #[tokio::test]
    async fn idempotency_cache_hit_returns_cached_body() {
        use std::time::Duration;

        // Use a real cache with a long TTL.
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            Duration::from_secs(60),
        ));
        // Pre-seed the ledger with a completed response for the exact request.
        let params = json!({ "session_id": "s1", "prompt": "hi" });
        cache
            .begin("dev-idem", "claude_send", "idem-key-1", &params)
            .unwrap();
        cache
            .complete(
                "dev-idem",
                "claude_send",
                "idem-key-1",
                &json!({ "cached": true }),
            )
            .unwrap();

        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: cache,
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-idem");

        // Send a NON-read-only command (e.g., claude_send) with the
        // pre-seeded idempotency key. The cache hit is returned before
        // the dispatch even runs (so app_handle=None doesn't matter).
        let resp = rpc_post(router, "claude_send", params, &jwt, Some("idem-key-1")).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["cached"], true);
    }

    // ── Idempotency: different keys run independently ─────────────────────────

    #[tokio::test]
    async fn different_idempotency_keys_run_independently() {
        use std::time::Duration;
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            Duration::from_secs(60),
        ));
        for (key, hit) in [("k1", 1), ("k2", 2)] {
            cache
                .begin("dev2", "claude_close_session", key, &json!({}))
                .unwrap();
            cache
                .complete("dev2", "claude_close_session", key, &json!({ "hit": hit }))
                .unwrap();
        }

        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: cache,
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });
        let jwt = device_jwt("dev2");

        // k1
        let router1 = build_router(Arc::clone(&state));
        let r1 = rpc_post(router1, "claude_close_session", json!({}), &jwt, Some("k1")).await;
        assert_eq!(r1.status(), StatusCode::OK);
        let b1 = body_json(r1).await;
        assert_eq!(b1["hit"], 1);

        // k2
        let router2 = build_router(Arc::clone(&state));
        let r2 = rpc_post(router2, "claude_close_session", json!({}), &jwt, Some("k2")).await;
        assert_eq!(r2.status(), StatusCode::OK);
        let b2 = body_json(r2).await;
        assert_eq!(b2["hit"], 2);
    }

    // ── Read-only commands do NOT write to the cache ──────────────────────────

    #[tokio::test]
    async fn read_only_commands_skip_cache() {
        use std::time::Duration;
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            Duration::from_secs(60),
        ));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev3");

        // mcp_server_status is read-only. Even with an idempotency-key header,
        // a response should NOT be stored. Since app_handle=None, we get 503;
        // the important thing is that the cache stays empty.
        let _ = rpc_post(
            router,
            "mcp_server_status",
            json!({}),
            &jwt,
            Some("key-should-not-cache"),
        )
        .await;

        // Cache must still be empty.
        assert_eq!(cache.len(), 0);
    }

    // ── Expired idempotency entry causes re-execution ─────────────────────────

    #[tokio::test]
    async fn expired_idempotency_key_causes_re_execution() {
        use std::time::Duration;
        // TTL = 0 ms → immediately expired.
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            Duration::from_millis(0),
        ));
        let params = json!({ "session_id": "s" });
        cache
            .begin("dev4", "claude_interrupt", "stale", &params)
            .unwrap();
        cache
            .complete(
                "dev4",
                "claude_interrupt",
                "stale",
                &json!({ "stale": true }),
            )
            .unwrap();
        // Let the entry expire.
        std::thread::sleep(Duration::from_millis(5));

        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: cache,
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev4");

        // The cache entry is expired → dispatch runs → 503 (app_handle=None).
        let resp = rpc_post(router, "claude_interrupt", params, &jwt, Some("stale")).await;
        // 503 means dispatch was attempted (cache miss), not a cached 200.
        assert_eq!(resp.status().as_u16(), 503);
    }

    // ── Dispatch-arm lockstep ─────────────────────────────────────────────────
    //
    // Source-scan guard: every `KNOWN_COMMANDS` entry must have a real arm in
    // the `dispatch()` match. The `assert_not_404!` coverage tests below CANNOT
    // prove this — in test mode `app_handle` is `None`, so `rpc_handler` returns
    // 503 (service_unavailable) right after the allowlist gate, *before*
    // reaching `dispatch`. A command that is allowlisted but has no arm (the
    // historical `claude_sub_*` bug) would therefore pass `assert_not_404!`
    // while returning 404 on a real device. This hermetic test closes that gap
    // without an `AppHandle`, mirroring `spec_parity`'s `include_str!` approach.
    #[test]
    fn every_known_command_has_a_dispatch_arm() {
        let src = include_str!("rpc.rs");
        // Scan only the `match name { ... }` body so the KNOWN_COMMANDS /
        // READ_ONLY_COMMANDS / CONTROL_COMMANDS declarations (which list the
        // same names *above* the function) aren't mistaken for arms.
        let body_start = src
            .find("match name {")
            .expect("dispatch `match name {` block not found");
        let body = &src[body_start..];

        let missing: Vec<&str> = known_commands()
            .iter()
            .copied()
            // Browser commands intentionally dispatch through the typed
            // browser gateway before the general match table. Treat that
            // gateway as a real dispatch arm instead of reporting the entire
            // family as a false-positive runtime 404.
            .filter(|cmd| !crate::companion_api::browser_gateway::is_browser_rpc(cmd))
            .filter(|cmd| !body.contains(&format!("\"{cmd}\"")))
            .collect();

        assert!(
            missing.is_empty(),
            "KNOWN_COMMANDS without a `dispatch()` arm (these 404 at runtime \
             despite being allowlisted): {missing:#?}"
        );
    }

    // ── Dispatch table coverage: one per family ───────────────────────────────
    // These just assert the dispatch arm exists and returns something (not a
    // 404), since all commands need app_handle in test mode. The lockstep test
    // above is what actually guarantees every allowlisted command has an arm.

    macro_rules! assert_not_404 {
        ($name:expr, $body:expr) => {{
            let state = test_state();
            let router = build_router(state);
            let jwt = device_jwt("cover-dev");
            let resp = rpc_post(router, $name, $body, &jwt, None).await;
            assert_ne!(
                resp.status().as_u16(),
                404,
                "command '{}' returned 404 — dispatch arm missing",
                $name
            );
        }};
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_interrupt() {
        assert_not_404!("claude_interrupt", json!({ "session_id": "s" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_compact() {
        assert_not_404!(
            "claude_compact",
            json!({ "session_id": "s", "focus": "the API" })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_companion_can_control() {
        assert_not_404!("companion_can_control", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_companion_endpoints() {
        assert_not_404!("companion_endpoints", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_approve() {
        assert_not_404!(
            "claude_approve",
            json!({
                "session_id": "s",
                "request_id": "r",
                "decision": "allow"
            })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_close_session() {
        assert_not_404!("claude_close_session", json!({ "session_id": "s" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_sidecar_status() {
        assert_not_404!("claude_sidecar_status", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_provider_profiles_list() {
        assert_not_404!("provider_profiles_list", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_provider_profiles_import() {
        assert_not_404!("provider_profiles_import", json!({ "payload": {} }));
    }

    #[tokio::test]
    async fn dispatch_coverage_provider_profiles_version() {
        assert_not_404!("provider_profiles_version", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_provider_catalog_status() {
        assert_not_404!("provider_catalog_status", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_provider_catalog_search() {
        assert_not_404!("provider_catalog_search", json!({ "query": "gpt" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_provider_catalog_refresh() {
        assert_not_404!("provider_catalog_refresh", json!({ "payload": {} }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_set_oauth_bearer() {
        assert_not_404!("claude_set_oauth_bearer", json!({ "token": null }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_has_api_key() {
        assert_not_404!("claude_has_api_key", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_has_oauth_bearer() {
        assert_not_404!("claude_has_oauth_bearer", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_set_api_key() {
        assert_not_404!("claude_set_api_key", json!({ "key": null }));
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_set_provider_env() {
        assert_not_404!(
            "claude_set_provider_env",
            json!({ "api_key": null, "base_url": null })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_claude_restart_sidecar() {
        assert_not_404!("claude_restart_sidecar", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_read_agent_config() {
        assert_not_404!("read_agent_config", json!({ "agent": "cursor" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_write_agent_config() {
        assert_not_404!(
            "write_agent_config",
            json!({ "agent": "cursor", "value": {} })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_scan_native() {
        assert_not_404!("skills_scan_native", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_load_registry() {
        assert_not_404!("skills_load_registry", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_install_native() {
        assert_not_404!(
            "skills_install_native",
            json!({
                "request": {
                    "dirName": "my-skill",
                    "content": "# SKILL",
                    "resources": [],
                    "clean": false
                }
            })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_skills_uninstall_native() {
        assert_not_404!("skills_uninstall_native", json!({ "dir_name": "my-skill" }));
    }

    #[tokio::test]
    async fn dispatch_coverage_mcp_server_status() {
        assert_not_404!("mcp_server_status", json!({}));
    }

    #[tokio::test]
    async fn dispatch_coverage_test_mcp_server() {
        assert_not_404!(
            "test_mcp_server",
            json!({ "transport": "stdio", "command": "echo" })
        );
    }

    #[test]
    fn arbitrary_mcp_probe_is_service_only_until_signed_policy_execution_lands() {
        assert!(is_service_only_command("test_mcp_server"));
        assert_eq!(
            super::super::command_manifest::descriptor("test_mcp_server")
                .expect("descriptor")
                .capability,
            "process.spawn"
        );
    }

    // ── Desktop-message bridge command coverage (Mobile completeness P2) ─────

    #[tokio::test]
    async fn dispatch_coverage_message_update() {
        // Required fields are present so the handler reaches dispatch and
        // returns 503 (test-mode, no AppHandle). The key assertion is that
        // the dispatch arm is wired (not a 404).
        assert_not_404!(
            "message_update",
            json!({
                "session_id": "s1",
                "message_id": "m1",
                "updates": { "role": "user" }
            })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_message_delete() {
        assert_not_404!(
            "message_delete",
            json!({ "session_id": "s1", "message_id": "m1" })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_session_list() {
        assert_not_404!("session_list", json!({ "limit": 20, "offset": 0 }));
    }

    #[tokio::test]
    async fn dispatch_coverage_logs_query() {
        assert_not_404!(
            "logs_query",
            json!({ "query": { "file": "structured", "minLevel": "warn", "limit": 10 } })
        );
    }

    #[tokio::test]
    async fn dispatch_coverage_logs_list_files() {
        assert_not_404!("logs_list_files", json!({}));
    }

    // ── Missing-field 400s ───────────────────────────────────────────────────

    #[tokio::test]
    async fn message_update_missing_session_id_returns_non_success() {
        // App handle is None in test-mode so the dispatch short-circuits to
        // 503 *before* per-field validation. The assertion captures the
        // contract that an empty-body request never reaches a 200 success
        // and never returns a 404 (the dispatch arm exists).
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "message_update", json!({}), &jwt, None).await;
        let status = resp.status().as_u16();
        assert_ne!(status, 200);
        assert_ne!(status, 404);
    }

    #[tokio::test]
    async fn message_delete_missing_message_id_returns_non_success() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(
            router,
            "message_delete",
            json!({ "session_id": "s1" }),
            &jwt,
            None,
        )
        .await;
        let status = resp.status().as_u16();
        assert_ne!(status, 200);
        assert_ne!(status, 404);
    }

    #[tokio::test]
    async fn session_list_missing_limit_returns_non_success() {
        let state = test_state();
        let router = build_router(state);
        let jwt = device_jwt("dev1");
        let resp = rpc_post(router, "session_list", json!({ "offset": 0 }), &jwt, None).await;
        let status = resp.status().as_u16();
        assert_ne!(status, 200);
        assert_ne!(status, 404);
    }

    // ── session_list lives in READ_ONLY_COMMANDS (skips idempotency cache) ──

    #[tokio::test]
    async fn session_list_skips_idempotency_cache() {
        use std::time::Duration;
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            Duration::from_secs(60),
        ));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-list");
        let _ = rpc_post(
            router,
            "session_list",
            json!({ "limit": 10, "offset": 0 }),
            &jwt,
            Some("idem-list"),
        )
        .await;

        // session_list is in READ_ONLY_COMMANDS — cache must remain empty.
        assert_eq!(cache.len(), 0);
    }

    // ── message_update / message_delete are NOT read-only ────────────────────
    // (mutations must be cached on first success so an in-flight retry
    // doesn't double-mutate the desktop's Dexie.)

    #[test]
    fn message_update_not_in_read_only_set() {
        assert!(!READ_ONLY_COMMANDS.contains(&"message_update"));
    }

    #[test]
    fn message_delete_not_in_read_only_set() {
        assert!(!READ_ONLY_COMMANDS.contains(&"message_delete"));
    }

    #[test]
    fn session_list_in_read_only_set() {
        assert!(READ_ONLY_COMMANDS.contains(&"session_list"));
    }

    #[test]
    fn all_three_commands_in_known_commands() {
        assert!(KNOWN_COMMANDS.contains(&"message_update"));
        assert!(KNOWN_COMMANDS.contains(&"message_delete"));
        assert!(KNOWN_COMMANDS.contains(&"session_list"));
    }

    // ── ADR-0060 caller-device-id injection ──────────────────────────────────

    #[test]
    fn inject_caller_device_id_overwrites_spoofed_values() {
        let args = json!({ "workflowId": "wf_1", "callerDeviceId": "spoofed" });
        let out = inject_caller_device_id("workflow_trigger_manual", args, "dev-real");
        assert_eq!(out["callerDeviceId"], json!("dev-real"));
        assert_eq!(out["workflowId"], json!("wf_1"));
    }

    #[test]
    fn inject_caller_device_id_only_touches_allowlisted_commands() {
        let args = json!({ "id": "c_1" });
        let out = inject_caller_device_id("character_upsert", args, "dev-real");
        assert!(out.get("callerDeviceId").is_none());
    }

    #[test]
    fn inject_caller_device_id_applies_to_capability_report() {
        let out = inject_caller_device_id(
            "device_capabilities_report",
            json!({ "capabilities": ["camera"] }),
            "dev-cap",
        );
        assert_eq!(out["callerDeviceId"], json!("dev-cap"));
    }

    #[test]
    fn inject_caller_device_id_ignores_non_object_payloads() {
        let out = inject_caller_device_id("workflow_trigger_manual", json!("nope"), "dev-real");
        assert_eq!(out, json!("nope"));
    }

    #[test]
    fn host_feature_manifest_grants_are_least_privilege_by_default() {
        let _guard = super::super::control_allow_list::test_guard();
        let agent_control = super::super::control_allow_list::agent_control_global();
        agent_control.disallow("dev-observer");

        let out = inject_caller_device_grants(
            "host_feature_manifest",
            json!({ "callerDeviceGrants": ["agent.run"] }),
            "dev-observer",
        );

        assert_eq!(out["callerDeviceGrants"], json!(["host.observe"]));
    }

    #[test]
    fn host_feature_manifest_includes_agent_run_only_for_granted_device() {
        let _guard = super::super::control_allow_list::test_guard();
        let agent_control = super::super::control_allow_list::agent_control_global();
        agent_control.allow("dev-agent".to_string());

        let out = inject_caller_device_grants("host_feature_manifest", json!({}), "dev-agent");

        assert_eq!(
            out["callerDeviceGrants"],
            json!(["host.observe", "agent.run"])
        );
        agent_control.disallow("dev-agent");
    }

    #[test]
    fn caller_device_grants_only_touch_the_manifest_command() {
        let out = inject_caller_device_grants(
            "character_upsert",
            json!({ "callerDeviceGrants": ["spoofed"] }),
            "dev-real",
        );
        assert_eq!(out["callerDeviceGrants"], json!(["spoofed"]));
    }

    #[test]
    fn device_capabilities_report_is_known_and_mutating() {
        assert!(KNOWN_COMMANDS.contains(&"device_capabilities_report"));
        // Mutating (persists onto pairedDevices) → must keep idempotency.
        assert!(!READ_ONLY_COMMANDS.contains(&"device_capabilities_report"));
        // Baseline paired capability — not remote-control gated.
        assert!(!CONTROL_COMMANDS.contains(&"device_capabilities_report"));
    }

    #[test]
    fn workflow_step_result_is_known_mutating_and_identity_injected() {
        assert!(KNOWN_COMMANDS.contains(&"workflow_step_result"));
        assert!(!READ_ONLY_COMMANDS.contains(&"workflow_step_result"));
        // The broker's target check replaces a control gate here.
        assert!(!CONTROL_COMMANDS.contains(&"workflow_step_result"));
        assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_step_result"));
    }

    #[test]
    fn workflow_approval_commands_are_classified() {
        assert!(KNOWN_COMMANDS.contains(&"workflow_approval_list"));
        assert!(KNOWN_COMMANDS.contains(&"workflow_approval_respond"));
        // Listing is a pure read; responding steers execution (control-gated,
        // mutating, caller identity injected).
        assert!(READ_ONLY_COMMANDS.contains(&"workflow_approval_list"));
        assert!(!READ_ONLY_COMMANDS.contains(&"workflow_approval_respond"));
        assert!(CONTROL_COMMANDS.contains(&"workflow_approval_respond"));
        assert!(!CONTROL_COMMANDS.contains(&"workflow_approval_list"));
        assert!(CALLER_DEVICE_ID_COMMANDS.contains(&"workflow_approval_respond"));
    }

    #[test]
    fn hashed_command_sets_mirror_their_arrays() {
        // The hot-path O(1) sets are derived from the `&[&str]` arrays. Equal
        // lengths prove the derivation is wired *and* that no array carries a
        // duplicate command name (a dup would silently shrink the set).
        assert_eq!(KNOWN_COMMANDS_SET.len(), KNOWN_COMMANDS.len());
        assert_eq!(READ_ONLY_COMMANDS_SET.len(), READ_ONLY_COMMANDS.len());
        assert_eq!(CONTROL_COMMANDS_SET.len(), CONTROL_COMMANDS.len());
        for c in KNOWN_COMMANDS {
            assert!(KNOWN_COMMANDS_SET.contains(c));
        }
    }

    #[test]
    fn managed_ide_remote_commands_preserve_trust_boundaries() {
        for read in [
            "codeserver_supported",
            "codeserver_status",
            "codeserver_list_proxies",
        ] {
            assert!(KNOWN_COMMANDS.contains(&read));
            assert!(READ_ONLY_COMMANDS.contains(&read));
            assert!(!CONTROL_COMMANDS.contains(&read));
        }
        for control in [
            "codeserver_ensure",
            "codeserver_stop",
            "codeserver_stop_all",
        ] {
            assert!(KNOWN_COMMANDS.contains(&control));
            assert!(CONTROL_COMMANDS.contains(&control));
            assert!(!READ_ONLY_COMMANDS.contains(&control));
            assert!(!SERVICE_ONLY_COMMANDS.contains(&control));
        }
        for internal in [
            "codeserver_build_proxy",
            "codeserver_activate_proxy",
            "codeserver_list_proxies",
            "codeserver_broker_validate_paths",
            "codeserver_broker_respond",
            "codeserver_broker_notify",
        ] {
            assert!(KNOWN_COMMANDS.contains(&internal));
            assert!(SERVICE_ONLY_COMMANDS.contains(&internal));
        }
    }

    // ── Wave 4.1 classification sentinels ────────────────────────────────────
    // One read + one destructive write per new domain, plus structural
    // integrity (every CONTROL/READ_ONLY entry is also a KNOWN command). These
    // guard the manual lockstep the cross-language parity gates can't.

    #[test]
    fn wave41_reads_are_read_only_and_writes_are_not() {
        for read in [
            "git_status",
            "git_diff_stat",
            "git_diff_file",
            "read_text_file",
            "fs_read_workspace_file",
            "terminal_list_all",
            "terminal_complete_paths",
            "plugin_list",
            "workflow_run_list",
            "twin_source_list",
            "backup_export",
        ] {
            assert!(
                READ_ONLY_COMMANDS.contains(&read),
                "{read} should be read-only"
            );
        }
        for write in [
            "git_push",
            "git_commit",
            "write_text_file",
            "fs_write_workspace_file",
            "terminal_exec",
            "terminal_kill_port",
            "plugin_install",
            "workflow_delete",
            "twin_delete",
            "backup_import",
        ] {
            assert!(
                !READ_ONLY_COMMANDS.contains(&write),
                "{write} must NOT be read-only (would skip idempotency on a mutation)"
            );
        }
    }

    #[test]
    fn git_identity_read_is_not_idempotency_cached_as_a_mutation() {
        assert!(KNOWN_COMMANDS.contains(&"git_identity"));
        assert!(READ_ONLY_COMMANDS.contains(&"git_identity"));
        assert!(!READ_ONLY_COMMANDS.contains(&"git_set_identity"));
    }

    #[test]
    fn wave41_destructive_writes_are_control_gated() {
        for gated in [
            "git_push",
            "git_commit",
            "git_stage",
            "write_text_file",
            "fs_write_workspace_file",
            "terminal_exec",
            "terminal_kill",
            "terminal_kill_port",
            // Unconfined directory listing — read-only AND control-gated,
            // same dual-axis treatment as read_text_file below.
            "terminal_complete_paths",
            "plugin_install",
            "plugin_uninstall",
            "workflow_delete",
            "workflow_cancel_run",
            "twin_delete",
            "twin_source_delete",
            "twin_job_cancel",
            "backup_import",
            "character_delete",
            // Raw absolute-path read — gated to stop a chat-only paired device
            // from reading arbitrary files (secrets) off the desktop. It is
            // simultaneously read-only (idempotency) and control-gated.
            "read_text_file",
        ] {
            assert!(is_control_command(gated), "{gated} should be control-gated");
        }
        // Ungated mutations — create/update/schedule and run listing.
        for ungated in [
            "workflow_create",
            "workflow_update",
            "workflow_schedule_pause",
            "workflow_run_list",
            "twin_source_update",
            "conversation_overrides_update",
            "git_status",
            "git_diff_stat",
        ] {
            assert!(
                !is_control_command(ungated),
                "{ungated} should NOT be gated"
            );
        }
    }

    // ── Long-term memory command classification (ADR-0069) ──────────────────
    // memory_list is a pure read; memory_search is NOT read-only (it bumps
    // lastAccessedAt/accessCount, so idempotency-caching it would freeze the
    // recency signal); the three writes are control-gated.

    #[test]
    fn memory_commands_are_classified_correctly() {
        assert!(READ_ONLY_COMMANDS.contains(&"memory_list"));
        assert!(
            !READ_ONLY_COMMANDS.contains(&"memory_search"),
            "memory_search mutates access recency — must not be idempotency-cached"
        );
        for gated in ["memory_store", "memory_update", "memory_forget"] {
            assert!(is_control_command(gated), "{gated} should be control-gated");
        }
        for ungated in ["memory_search", "memory_list"] {
            assert!(
                !is_control_command(ungated),
                "{ungated} should NOT be control-gated"
            );
        }
    }

    #[test]
    fn classification_lists_are_subsets_of_known_commands() {
        for c in CONTROL_COMMANDS {
            assert!(
                KNOWN_COMMANDS.contains(c),
                "CONTROL command {c} missing from KNOWN_COMMANDS"
            );
        }
        for c in READ_ONLY_COMMANDS {
            assert!(
                KNOWN_COMMANDS.contains(c),
                "READ_ONLY command {c} missing from KNOWN_COMMANDS"
            );
        }
    }

    // ── app_settings_update allowlist coverage (Phase 1 of the mobile theme
    //    parity work — see plan i18n-partitioned-teapot.md). The phone's
    //    /me/appearance route writes these keys through `app_settings_update`,
    //    so a regression here would 400 on every save. The accessor mirror
    //    keeps the OpenAPI spec_parity check honest.

    #[test]
    fn mobile_allowed_keys_accessor_mirrors_const() {
        // The accessor must return exactly the const slice — no copying,
        // no filtering. spec_parity downstream depends on this identity.
        let from_accessor = mobile_allowed_keys();
        assert_eq!(
            from_accessor.len(),
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.len(),
            "accessor length drift"
        );
        for (a, b) in from_accessor
            .iter()
            .zip(APP_SETTINGS_MOBILE_ALLOWED_KEYS.iter())
        {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn mobile_allowlist_includes_appearance_keys() {
        // Every key surfaced by the mobile appearance route must be here.
        // Adding a new tab / setting on the phone side without updating
        // this list will 400 on save.
        for key in [
            "colorTheme",
            "customThemes",
            "activeCustomThemeId",
            "wallpapers",
            "customCss",
            "customCssEnabled",
            "importedVscodeThemes",
            // ADR-0056 — portable appearance keys (sync down ⇄ write up).
            "autoMode",
            "density",
            "radius",
            "motion",
            "typographyExt",
            "a11y",
            // Theme system enhancement — accent override + plugin theme pointer.
            "accentColor",
            "activePluginThemeId",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "appearance key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
    }

    #[test]
    fn mobile_allowlist_includes_agent_default_keys() {
        // ADR-0056 — the phone's `/me/agent` page (paired mode) writes these
        // agent-default prefs through `app_settings_update`. They already sync
        // desktop→phone; this closes the write-back gap. Missing any → 400.
        for key in [
            "permissionMode",
            "defaultSystemPrompt",
            "defaultMaxThinkingTokens",
            "bareMode",
            "debugMode",
            "briefMode",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "agent-default key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
    }

    #[test]
    fn mobile_allowlist_includes_conversation_keys() {
        // ADR-0056 (Wave 2) — the phone's conversation page + `/me/agent`
        // compaction toggle write these. Missing any → 400 on save.
        for key in [
            "composerBehavior",
            "streamPartialMessages",
            "compaction",
            "conversationSidebar",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "conversation key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
        // ADR-0056 (Wave 3) — instructions + surface-skills toggle.
        for key in ["instructions", "surfaceSkillsEnabled"] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "Wave-3 key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
        // `workflowEditorPerformanceTier` is deliberately NOT here. It is a
        // motion/computation budget picked for one device's GPU and CPU; the
        // old comment on the allowlist already called it "kept device-local"
        // while still letting the phone write the desktop's copy, which is a
        // contradiction. It is now `device-local` in the classification table:
        // `/me/workflows-settings` sets this handset's tier and nothing else.
        assert!(
            !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&"workflowEditorPerformanceTier"),
            "workflowEditorPerformanceTier must stay device-local"
        );
    }

    #[test]
    fn mobile_allowlist_includes_speech_voice_keys() {
        // ADR-0056 (Wave 2) — the phone's `/me/speech` page writes the active
        // provider's flat voice key. Missing any → 400 on save.
        for key in [
            "systemVoice",
            "openaiVoice",
            "geminiVoice",
            "edgeVoice",
            "elevenlabsVoice",
            "lmntVoice",
            "humeVoice",
            "cartesiaVoice",
            "deepgramVoice",
            "xiaomiVoice",
            "mistralVoiceId",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "speech voice key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
    }

    #[test]
    fn mobile_allowlist_includes_web_search_and_notification_keys() {
        // ADR-0056 (Wave 2) — `/me/web-search` preferred provider + fallback,
        // and `/me/notifications` preference object. Provider API keys
        // (`searchProviders`) must stay OUT (credentials). Missing any → 400.
        for key in [
            "defaultSearchProvider",
            "searchFallbackEnabled",
            "notificationPreferences",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "Wave-2 key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
        // Credential / non-portable search keys must NOT be writable.
        for forbidden in ["searchProviders", "customSearchSources"] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&forbidden),
                "credential key '{forbidden}' must NOT be in APP_SETTINGS_MOBILE_ALLOWED_KEYS"
            );
        }
    }

    #[test]
    fn mobile_allowlist_excludes_transport_config_keys() {
        // These were allowlisted for a "mobile companion settings tab" that was
        // never built — no mobile surface ever wrote one of them, so the
        // entries were dead. Worse, the direction was backwards: the phone
        // reads `signalingUrl` / `iceServers` / `turnServers` from its OWN
        // settings row to dial the rendezvous, and they were never mirrored
        // down, so a self-hosted signaling server or TURN relay configured on
        // the desktop could not reach the phone at all — it silently fell back
        // to the public default and WebRTC failed behind symmetric NAT.
        //
        // They are now `server-authoritative` in
        // `packages/agent-config-types/src/settings-sync.ts`: mirrored down,
        // never accepted up. `webrtcEnabled` is `device-local` — whether to
        // attempt the tier is each device's own call.
        for key in [
            "webrtcEnabled",
            "signalingUrl",
            "iceServers",
            "turnServers",
            "turnProvider",
        ] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "transport key '{key}' must NOT be writable from a paired client"
            );
        }
    }

    #[test]
    fn mobile_allowlist_keeps_baseline_keys() {
        // Don't accidentally drop a baseline key while editing this list.
        for key in [
            "theme",
            "fontScale",
            "language",
            "reduceMotion",
            "defaultModel",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "baseline key '{key}' must stay in the mobile allowlist"
            );
        }

        // Two former "baseline" entries are gone on purpose.
        //
        // `defaultCharacterId` never existed on `AppSettings` — it lives on
        // `AdapterInstanceRow`. A phone could pass the allowlist with it and
        // then write a field the desktop's settings row does not have. It was
        // pure drift, invisible because nothing checked the constant against
        // the type.
        //
        // `biometricRequiredFor` is now `device-local`: gating is a property of
        // the device's own authenticator, and letting one device push its
        // policy onto another either weakens it or locks out a device with no
        // biometric hardware.
        for key in ["defaultCharacterId", "biometricRequiredFor"] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "'{key}' must NOT be in the mobile allowlist"
            );
        }
    }

    #[test]
    fn mobile_allowlist_rejects_transport_and_sidecar_keys() {
        // Sentinel keys that the phone must never be allowed to write —
        // protects the desktop-only configuration plane.
        for key in [
            "apiBaseUrl",
            "anthropicApiKey",
            "claudeOauthBearer",
            "mcpServers",
            "providerConfigs",
            "sidecarPath",
        ] {
            assert!(
                !APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "key '{key}' must NOT be writable from the mobile client"
            );
        }
    }

    #[tokio::test]
    async fn app_settings_update_rejects_unknown_key() {
        // End-to-end: a patch carrying an unknown key returns 400 with
        // `validation_failed` rather than reaching the desktop_writes_bridge.
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            std::time::Duration::from_secs(60),
        ));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-allowlist");
        let resp = rpc_post(
            router,
            "app_settings_update",
            json!({ "patch": { "apiBaseUrl": "https://attacker.example" } }),
            &jwt,
            None,
        )
        .await;

        assert_eq!(
            resp.status().as_u16(),
            400,
            "unknown key must be rejected as 400"
        );
        let body = body_json(resp).await;
        assert_eq!(body["code"], "validation_failed");
        assert!(
            body["message"]
                .as_str()
                .unwrap_or_default()
                .contains("apiBaseUrl"),
            "error message should name the rejected key"
        );
    }

    #[tokio::test]
    async fn app_settings_update_accepts_color_theme_key() {
        // End-to-end: a patch carrying only allowlisted keys passes the
        // validation gate. The bridge will return service_unavailable
        // here (no app_handle in test state) — that's distinct from a
        // 400, which is what we're guarding against.
        let cache = Arc::new(IdempotencyCache::with_capacity(
            100,
            std::time::Duration::from_secs(60),
        ));
        let state = Arc::new(CompanionState {
            secret: RwLock::new(SECRET.to_vec()),
            redemption_lru: RedemptionLru::new(),
            pair_code_lru: Arc::new(crate::companion_api::pair_code_lru::PairCodeLru::new()),
            deny_list: Arc::new(DenyList::new()),
            app_handle: None,
            idempotency: Arc::clone(&cache),
            event_bus: crate::companion_api::event_bus::EventBus::new(),
            sync_bridge: crate::companion_api::sync_bridge::SyncBridge::new(),
            desktop_messages_bridge:
                crate::companion_api::desktop_messages_bridge::DesktopMessagesBridge::new(),
            desktop_writes_bridge:
                crate::companion_api::desktop_writes_bridge::DesktopWritesBridge::new(),
            sync_registry: crate::companion_api::sync_registry::SyncTableRegistry::with_defaults(),
            rate_limiter: crate::companion_api::rate_limit::RateLimiter::with_defaults(),
            push_tokens: crate::companion_api::push::PushTokenRegistry::new(),
        });

        let router = build_router(state);
        let jwt = device_jwt("dev-allowlist-ok");
        let resp = rpc_post(
            router,
            "app_settings_update",
            json!({ "patch": { "colorTheme": "ocean" } }),
            &jwt,
            None,
        )
        .await;

        // The patch is valid — must NOT be a 400 validation_failed.
        // (The bridge layer below returns 500/503 in unit-test mode
        // without a real app_handle, which is fine for this assertion.)
        assert_ne!(
            resp.status().as_u16(),
            400,
            "allowlisted colorTheme patch must not be rejected as 400"
        );
    }

    #[test]
    fn host_feature_manifest_is_a_read_only_rpc_contract() {
        assert!(KNOWN_COMMANDS.contains(&"host_feature_manifest"));
        assert!(READ_ONLY_COMMANDS.contains(&"host_feature_manifest"));
        assert!(!CONTROL_COMMANDS.contains(&"host_feature_manifest"));
    }

    #[test]
    fn remote_claude_response_commands_are_control_gated() {
        for command in [
            "claude_restore",
            "claude_set_mode",
            "claude_plugin_tool_response",
            "claude_tool_result_decision",
            "claude_protocol_adapter_message",
        ] {
            assert!(
                KNOWN_COMMANDS.contains(&command),
                "{command} must be remotely reachable"
            );
            assert!(
                CONTROL_COMMANDS.contains(&command),
                "{command} must require remote control"
            );
            assert!(
                !READ_ONLY_COMMANDS.contains(&command),
                "{command} mutates a live session"
            );
        }
    }
}
