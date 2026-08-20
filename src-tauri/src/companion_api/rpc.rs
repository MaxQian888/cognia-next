//! RPC dispatch for `POST /internal/_rpc/:name`.
//!
//! # Request shape
//!
//! ```text
//! POST /internal/_rpc/<command_name>
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

mod chat;
mod codex_app;
mod data_sync;
mod diagnostics;
mod filesystem;
mod host_state;
mod native_tools;
mod plugins;
mod service_plane;
mod source_control;
mod terminal;

use std::collections::HashSet;

#[cfg(test)]
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Extension,
};
use axum::{http::StatusCode, Json};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    agents::commands as agent_commands,
    claude::{commands as claude_commands, sidecar::kill_sidecar},
    mcp_server::orchestration_proxy::OrchestrationEventSink,
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
/// `/ws/events` subscriber (the brain's acp-client, phones) receives the
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
    /// Whether the caller may safely repeat this request unchanged.
    ///
    /// `CommandError` (crates/cognia-core) exists to carry exactly this, but
    /// the RPC envelope dropped it, so `transport-companion.ts` re-derived it
    /// from the HTTP status — which cannot distinguish "the host is booting,
    /// try again" from "this host will never serve that command", both 503.
    /// Each constructor below states the answer instead of leaving it to be
    /// guessed downstream.
    pub retryable: bool,
}

impl RpcError {
    /// Non-retryable by default: most RPC failures are contract or capability
    /// problems that repeating verbatim cannot fix. Transient cases opt in.
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    fn retryable(mut self) -> Self {
        self.retryable = true;
        self
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
            Json(Self::new("service_unavailable", detail).retryable()),
        )
    }

    fn upgrade_required(detail: String) -> (StatusCode, Json<Self>) {
        (
            StatusCode::UPGRADE_REQUIRED,
            Json(Self::new("upgrade_required", detail)),
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

    /// The mirror image of [`Self::headless_unsupported`]: the command is
    /// implemented by the headless service container and this process is a
    /// desktop-hosted companion server, which has none.
    ///
    /// These two were the same error for a long time, and 99 arms — every
    /// `host.headless().ok_or_else(...)` — reported the desktop case with the
    /// headless case's message, telling operators to "use the desktop app"
    /// while running on the desktop app. Only one command is genuinely
    /// desktop-only (`companion_endpoints`), so the reversed message was the
    /// overwhelmingly common one.
    pub(super) fn headless_host_required(name: &str) -> (StatusCode, Json<Self>) {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Self::new(
                "headless_host_required",
                format!(
                    "RPC command '{name}' is served by the headless host services and this process \
                     is a desktop-hosted companion server (run it against a `cognia-server` host)"
                ),
            )),
        )
    }

    fn internal(detail: String) -> (StatusCode, Json<Self>) {
        if detail.starts_with("brain bridge disconnected")
            || detail.starts_with("brain bridge overloaded")
        {
            return Self::service_unavailable(detail);
        }
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(Self::new("internal_error", detail)),
        )
    }

    #[cfg(test)]
    fn idempotency_conflict() -> (StatusCode, Json<Self>) {
        (
            StatusCode::CONFLICT,
            Json(Self::new(
                "idempotency_conflict",
                "the idempotency key was already used with different parameters",
            )),
        )
    }

    #[cfg(test)]
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
    #[cfg(test)]
    fn rate_limited(retry_after_secs: u64) -> (StatusCode, Json<Self>) {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(
                Self::new(
                    "rate_limited",
                    format!(
                    "device exceeded the per-minute quota; retry_after_seconds={retry_after_secs}"
                ),
                )
                .retryable(),
            ),
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

const TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL: &str = "[TWIN_DRAFT_REVIEW_CONFLICT]";

fn map_desktop_write_bridge_error(command: &str, detail: String) -> (StatusCode, Json<RpcError>) {
    if command == "twin_draft_review" && detail.starts_with(TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL) {
        return (
            StatusCode::CONFLICT,
            Json(RpcError::new(
                "twin_draft_review_conflict",
                detail
                    .trim_start_matches(TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL)
                    .trim(),
            )),
        );
    }
    RpcError::internal(detail)
}

pub(super) fn terminal_rpc_authorization(
    device_id: &str,
    host_remote_access_enabled: bool,
    has_terminal_capability: bool,
) -> Result<(), (StatusCode, Json<RpcError>)> {
    if !host_remote_access_enabled {
        return Err(RpcError::forbidden(
            "remote terminal access is disabled on this host",
        ));
    }
    if device_id.trim().is_empty() || !has_terminal_capability {
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
        canonical_device_has_capability(device_id, "terminal.open"),
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
    "codex_app_runtime_status",
    "codex_app_task_list",
    "codex_app_task_read",
    "codex_app_task_create",
    "codex_app_task_send",
    "codex_app_task_interrupt",
    "codex_app_task_open",
    "codex_app_inventory",
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
    "mcp_oauth_authenticate",
    "mcp_oauth_status",
    "mcp_oauth_load_entry",
    "mcp_oauth_refresh",
    "mcp_oauth_clear",
    "read_agent_config",
    "write_agent_config",
    // Generic encrypted secret-store facade for the headless brain. The
    // keyring names are deprecated compatibility aliases.
    "secret_store_get",
    "secret_store_set",
    "secret_store_delete",
    "keyring_secret_get",
    "keyring_secret_set",
    "keyring_secret_clear",
    "ocr_extract_native",
    "ocr_list_native_backends",
    "ocr_list_available_backends",
    "ocr_model_status",
    "ocr_download_model",
    "ocr_cancel_model_download",
    "sync_pull",
    "sync_list_tables",
    "register_push_token",
    "revoke_push_token",
    "remote_notification_publish",
    "message_update",
    "message_delete",
    "session_list",
    "message_get_by_session",
    "transcript_capabilities",
    "session_timeline",
    "session_turn_messages",
    "message_send",
    // Wave 2 mutating RPCs — round-trip through desktop_writes_bridge.
    "character_upsert",
    "character_delete",
    "character_bind_twin",
    "skill_set_enabled",
    "plugin_set_enabled",
    "mcp_set_enabled",
    "mcp_set_tool_rules",
    "adapter_update_policy",
    "app_settings_update",
    // Wave 2 read-only projection routed through desktop_writes_bridge.
    "twin_profile_get",
    // ADR-0097 — what this host can do, answered by the host's own TS layer
    // (renderer on desktop, brain on headless) so the capability vocabulary
    // stays single-sourced in `lib/platform/capabilities.ts`.
    "host_capabilities",
    "host_feature_manifest",
    "host_state_snapshot",
    "host_state_submit",
    "host_state_status",
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
    // a public device principal can never reach these.
    "spawn_external_agent",
    "send_to_external_agent",
    "kill_external_agent",
    "get_external_agent_status",
    // ADR-0059 R12 — service-scope management of the public `/connectors`
    // webhook ingress registry on the headless front door.
    "connectors_register",
    "connectors_unregister",
    "connectors_list_adapters",
    "connectors_runtime_lease_acquire",
    "connectors_runtime_lease_renew",
    "connectors_runtime_lease_release",
    // Marketplace Integration ingress uses the same host-owned workflow
    // router and encrypted spool on desktop and headless deployments.
    "integration_ingress_register",
    "integration_ingress_unregister",
    "integration_ingress_get_url",
    "integration_ingress_poll",
    "integration_ingress_ack",
    "integration_ingress_nack",
    "integration_ingress_deadletters",
    "integration_ingress_deadletter",
    "integration_ingress_requeue",
    // Host-owned Issue Loop workspace operations. These carry repository
    // credentials and can write to GitHub, so only the co-located brain may
    // dispatch them on headless hosts.
    "github_workspace_clone",
    "github_workspace_commit_and_push",
    "github_workspace_remove",
    "github_workspace_stat",
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
    "connectors_matrix_crypto_init",
    "connectors_matrix_crypto_close",
    "connectors_matrix_crypto_outgoing_requests",
    "connectors_matrix_crypto_mark_request_sent",
    "connectors_matrix_crypto_receive_sync_changes",
    "connectors_matrix_crypto_decrypt_event",
    "connectors_matrix_crypto_encrypt_event",
    "connectors_matrix_crypto_share_room_key",
    "connectors_matrix_crypto_update_tracked_users",
    "connectors_matrix_crypto_get_missing_sessions",
    "connectors_matrix_encrypted_media_upload",
    "connectors_matrix_encrypted_media_fetch",
    "connectors_lark_upload_file",
    "connectors_lark_upload_image",
    // Mobile outbound-queue RPCs — round-trip through desktop_writes_bridge.
    // Mirror `MOBILE_OUTBOUND_COMMANDS` in `lib/db/mobile-outbound-types.ts`.
    // Spec-parity test (`spec_parity.rs`) asserts these stay in lockstep
    // with the OpenAPI spec; the in-file `mobile_queue_commands_are_known`
    // test below asserts they stay in lockstep with the TS enum.
    "connector_send",
    // ADR-0131 cross-shell relay: the real "enqueue an outbound job"
    // command. `connector_send` only appends a local user message and is
    // kept for older clients.
    "connector_enqueue_outbound",
    "connector_approve_draft",
    "connector_reject_draft",
    // ADR-0131: moved off the client plane so a headless brain can run them.
    "connectors_discord_upload",
    "connectors_onebot_probe",
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
    // Single-Agent task board control. Metadata mirrors over the agentTasks
    // sync tables; these live commands are validated by the desktop runtime.
    "agent_task_start",
    "agent_task_pause",
    "agent_task_resume",
    "agent_task_cancel",
    "agent_task_comment",
    "agent_task_move",
    // Resolve a host computer-use consent prompt from a remote device.
    // Calls the automation ConsentBroker directly (not via writes-bridge).
    "automation_consent_respond",
    "automation_consent_pending",
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
    // Capability-driven selected-host performance diagnostics. Legacy
    // start/set/stop/reset commands remain local-only and are intentionally
    // absent from this public command list.
    "perf_close_lease",
    "perf_hotspots",
    "perf_lease_snapshot",
    "perf_list_traces",
    "perf_open_lease",
    "perf_read_observations",
    "perf_renew_lease",
    "perf_trace_close",
    "perf_trace_open",
    "perf_trace_read_chunk",
    "perf_system_details",
    // ── Source control (ADR-0038) ───────────────────────────────────────────
    // Native git porcelain over a repo path. Reads are ungated; writes /
    // network ops require the remote-control capability (see CONTROL_COMMANDS).
    // The desktop client wrappers in `lib/git/commands.ts` already speak this
    // surface — exposing the arms here makes the entire git client work over
    // the Companion transport with no client changes. Args use the **camelCase**
    // keys those wrappers send (`repoPath`, `hunkPatch`, …), which Tauri
    // converts to snake_case on the desktop path and we read verbatim here.
    "git_is_repo",
    "git_workspace_list",
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
    "project_environment_execute",
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
    // Terminal-host administration. The desktop drives these through the local
    // `terminal_host_service` command, which no remote client can reach — so a
    // browser's terminal settings used to write a local mirror and nothing
    // else, and its profiles never reached the host at all (a remote spawn
    // names a profile and nothing else, so every one came back "unknown
    // terminal profile"). `provision` has no remote arm on purpose: minting a
    // host descriptor for a device key stays a decision made at the host.
    "terminal_host_status",
    "terminal_host_configure",
    "terminal_host_sync_profiles",
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
    "plugin_set_status",
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
    // Pending approvals live in the host-owned workflow SQLite mirror, so
    // list/respond remain available while the renderer is suspended.
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
    "twin_draft_review",
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
    "retrieval_profile_dek_export",
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
    "fleet_worker_enrollment_create",
    "fleet_worker_list",
    "fleet_worker_set",
    "fleet_project_managed_session",
    "fleet_project_worker_load",
    "fleet_remove_managed_session",
    "fleet_permission_respond",
    "fleet_question_respond",
    "fleet_question_reject",
    "fleet_opencode_send_message",
    "fleet_focus_terminal",
    "fleet_interrupt_session",
    // ADR-0085 — host-neutral shared browser session and tool contract.
    "browser_session_ensure",
    "browser_session_get",
    "browser_capability",
    "browser_runtime_status",
    "browser_session_close",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "browser_drag",
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
    "browser_handle_dialog",
    "browser_pages",
    "browser_new_page",
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
/// list has a matching `/internal/_rpc/<name>` path in the OpenAPI spec.
#[allow(dead_code)] // referenced from `spec_parity::tests` only.
pub fn known_commands() -> &'static [&'static str] {
    KNOWN_COMMANDS
}

/// Commands in this list skip the idempotency cache entirely.
/// They are cheap to re-run and structurally idempotent.
#[cfg(test)]
const READ_ONLY_COMMANDS: &[&str] = &[
    "codex_app_runtime_status",
    "codex_app_task_list",
    "codex_app_task_read",
    "codex_app_inventory",
    "browser_capability",
    "browser_runtime_status",
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
    "mcp_oauth_status",
    "mcp_oauth_load_entry",
    "read_agent_config",
    "keyring_secret_get",
    "secret_store_get",
    "ocr_list_native_backends",
    "ocr_list_available_backends",
    "ocr_model_status",
    "automation_consent_pending",
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
    "transcript_capabilities",
    "session_timeline",
    "session_turn_messages",
    // Wave 2 read-only twin profile projection.
    "twin_profile_get",
    "host_capabilities",
    "host_feature_manifest",
    "host_state_snapshot",
    "host_state_status",
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
    "integration_ingress_deadletters",
    "integration_ingress_deadletter",
    // Read-only remote-control capability probe (drives the mobile
    // computer-use consent sheet). Pure read of the process-global allow list.
    "companion_can_control",
    // Read-only channel inventory (LAN / tunnel base URLs + TLS fingerprint).
    // Polled by the mobile transport on connect, so caching it behind the 60 s
    // idempotency TTL would hand back a stale tunnel URL right after the user
    // started one.
    "companion_endpoints",
    "perf_hotspots",
    "perf_lease_snapshot",
    "perf_list_traces",
    "perf_read_observations",
    "perf_trace_read_chunk",
    "perf_system_details",
    // Source-control reads — same (repoPath, …) returns the same snapshot.
    "git_is_repo",
    "git_workspace_list",
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
    "retrieval_profile_dek_export",
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
/// device must hold the capabilities
/// [`super::device_grants::GrantKind::Control`] maps onto, checked against the
/// SecurityStore by [`super::remote_execution::authorize_capability`]. These
/// attach to and steer host-owned agent sessions, control host goal loops, or
/// resolve host computer-use consent.
///
/// Baseline paired chat (`claude_send` / `claude_interrupt` /
/// `claude_approve`) is deliberately **absent**: that is the phone's own chat
/// path and predates this capability, so gating it would break existing
/// mobile clients. Read-only sync/observe is likewise ungated.
///
/// Command arms are added by their respective milestones; the gate fires for a
/// name as soon as it appears here (it runs before the dispatch `match`).
#[cfg(test)]
const CONTROL_COMMANDS: &[&str] = &[
    "provider_diagnostics_start",
    "provider_diagnostics_cancel",
    "claude_restore",
    "claude_set_mode",
    "claude_plugin_tool_response",
    "claude_tool_result_decision",
    "claude_protocol_adapter_message",
    "codex_app_task_create",
    "codex_app_task_send",
    "codex_app_task_interrupt",
    "codex_app_task_open",
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
    "browser_drag",
    "browser_press_key",
    "browser_scroll",
    "browser_evaluate",
    "browser_back",
    "browser_forward",
    "browser_reload",
    "browser_stop",
    "browser_handle_dialog",
    "browser_switch_page",
    "browser_close_page",
    "browser_new_page",
    "browser_set_files",
    "browser_set_zoom",
    "session_attach",
    "host_state_submit",
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
    "agent_task_start",
    "agent_task_pause",
    "agent_task_resume",
    "agent_task_cancel",
    "agent_task_comment",
    "agent_task_move",
    "automation_consent_respond",
    "automation_consent_pending",
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
    "project_environment_execute",
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
    // Rewrites the host's terminal limits and its remote-access switch, and
    // decides which shells a device can name — every one of them decides what
    // a later `terminal.open` can do.
    "terminal_host_configure",
    "terminal_host_sync_profiles",
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
    "fleet_question_reject",
    "fleet_opencode_send_message",
    "fleet_focus_terminal",
    "fleet_interrupt_session",
];

/// O(1) membership mirrors used on the request hot path. Command existence
/// and idempotency now come from the shared protocol manifest; the remaining
/// legacy policy arrays are retained temporarily only for parity assertions.
static KNOWN_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| known_commands().iter().copied().collect());
#[cfg(test)]
static READ_ONLY_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| {
        super::command_manifest::commands()
            .iter()
            .filter(|command| command.operation == super::command_manifest::CommandOperation::Read)
            .map(|command| command.name.as_str())
            .collect()
    });
#[cfg(test)]
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
#[cfg(test)]
fn is_control_command(name: &str) -> bool {
    CONTROL_COMMANDS_SET.contains(name)
}

#[cfg(test)]
fn is_control_authorized(name: &str, device_id: &str, scope: Option<&str>) -> bool {
    !is_control_command(name)
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
        || canonical_device_capability(device_id, name)
}

#[cfg(test)]
fn canonical_device_capability(device_id: &str, command: &str) -> bool {
    let Some(descriptor) = super::command_manifest::descriptor(command) else {
        return false;
    };
    canonical_device_has_capability(device_id, &descriptor.capability)
}

fn canonical_device_has_capability(device_id: &str, capability: &str) -> bool {
    if device_id.trim().is_empty() {
        return false;
    }
    let Some(store) = super::security_store::security_store() else {
        return false;
    };
    let Ok(Some(tenant_id)) = store.active_device_tenant(device_id) else {
        return false;
    };
    store
        .has_capability(&tenant_id, device_id, capability)
        .unwrap_or(false)
}

/// Revalidate the paired-device control grant on non-RPC streams such as the
/// managed IDE relay. Revocation therefore closes authority immediately rather
/// than only when a new code-server session is requested.
pub(crate) fn device_can_control(device_id: &str) -> bool {
    let Some(store) = super::security_store::security_store() else {
        return false;
    };
    let Ok(Some(tenant_id)) = store.active_device_tenant(device_id) else {
        return false;
    };
    store
        .has_capability(&tenant_id, device_id, "workspace.write")
        .unwrap_or(false)
}

/// Commands whose TS dispatch arm needs the authenticated caller's device id
/// (ADR-0060). The bridge arm injects `callerDeviceId` into the payload for
/// exactly these names — see [`inject_caller_device_id`].
const CALLER_DEVICE_ID_COMMANDS: &[&str] = &[
    // ADR-0131 cross-shell inbox relay — the host stamps the audit row /
    // assignment trail with `device:<callerDeviceId>` so a phone-originated
    // reply or override is attributable to the device that sent it.
    "connector_enqueue_outbound",
    "connector_approve_draft",
    "connector_reject_draft",
    "conversation_overrides_update",
    "provider_diagnostics_status",
    "provider_diagnostics_history",
    "provider_diagnostics_start",
    "provider_diagnostics_cancel",
    "workflow_trigger_manual",
    "device_capabilities_report",
    "workflow_approval_respond",
    "workflow_step_result",
    "perf_close_lease",
    "perf_hotspots",
    "perf_lease_snapshot",
    "perf_list_traces",
    "perf_open_lease",
    "perf_read_observations",
    "perf_renew_lease",
    "perf_trace_close",
    "perf_trace_open",
    "perf_trace_read_chunk",
    "perf_system_details",
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
fn inject_caller_device_grants(
    name: &str,
    mut args: Value,
    state: &SharedState,
    device_id: &str,
    account_id: Option<&str>,
) -> Value {
    if name == "host_feature_manifest" {
        if let Value::Object(map) = &mut args {
            map.insert(
                "authoritativeHostId".to_string(),
                Value::String(opaque_host_id(state)),
            );
            let grants = account_id
                .and_then(|tenant_id| {
                    super::security_store::security_store().map(|store| (tenant_id, store))
                })
                .and_then(|(tenant_id, store)| {
                    store
                        .capability_snapshot(tenant_id, device_id)
                        .ok()
                        .flatten()
                })
                .unwrap_or_default()
                .into_iter()
                .map(Value::String)
                .collect();
            map.insert("callerDeviceGrants".to_string(), Value::Array(grants));
        }
    }
    args
}

/// RCE-grade commands that ONLY the headless brain's service token may call
/// (ADR-0059 W4/D6). A public device principal presenting one is rejected with
/// 403. The external-agent arms are remote code execution by construction —
/// every decision is also written to the audit log. R12 adds the
/// `connectors_*` management arms.
#[cfg(test)]
const SERVICE_ONLY_COMMANDS: &[&str] = &[
    // ADR-0059 R12 — the brain manages the public webhook ingress registry.
    // The runtime-lease arms are deliberately NOT here: the lease arbitrates
    // between every runtime attached to this companion, so a desktop webview
    // (which holds a device JWT, never a service token) has to be able to
    // contend for it. See `agent.run` in the command manifest.
    "connectors_register",
    "connectors_unregister",
    "connectors_list_adapters",
    "integration_ingress_register",
    "integration_ingress_unregister",
    "integration_ingress_get_url",
    "integration_ingress_poll",
    "integration_ingress_ack",
    "integration_ingress_nack",
    "integration_ingress_deadletters",
    "integration_ingress_deadletter",
    "integration_ingress_requeue",
    "github_workspace_clone",
    "github_workspace_commit_and_push",
    "github_workspace_remove",
    "github_workspace_stat",
    "fleet_project_managed_session",
    "fleet_project_worker_load",
    "fleet_remove_managed_session",
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
    "connectors_matrix_crypto_init",
    "connectors_matrix_crypto_close",
    "connectors_matrix_crypto_outgoing_requests",
    "connectors_matrix_crypto_mark_request_sent",
    "connectors_matrix_crypto_receive_sync_changes",
    "connectors_matrix_crypto_decrypt_event",
    "connectors_matrix_crypto_encrypt_event",
    "connectors_matrix_crypto_share_room_key",
    "connectors_matrix_crypto_update_tracked_users",
    "connectors_matrix_crypto_get_missing_sessions",
    "connectors_matrix_encrypted_media_upload",
    "connectors_matrix_encrypted_media_fetch",
    "connectors_lark_upload_file",
    "connectors_lark_upload_image",
    // The brain may persist non-connector secrets (backup auto-key, WebDAV,
    // future runtime credentials) in the already-installed server store.
    "secret_store_get",
    "secret_store_set",
    "secret_store_delete",
    "keyring_secret_get",
    "keyring_secret_set",
    "keyring_secret_clear",
    "ocr_extract_native",
    "ocr_list_native_backends",
    "ocr_list_available_backends",
    "ocr_model_status",
    "ocr_download_model",
    "ocr_cancel_model_download",
    "remote_notification_publish",
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
    "plugin_set_status",
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
/// the command manifest and the device's current SecurityStore snapshot.
///
/// The safety floor does not move: every spawn still has to clear the
/// `SpawnPolicy` preset allowlist (bare binary from a fixed list, cwd under the
/// workspaces root, default-deny env) and every allow/deny is audited. That
/// check runs on the value, not on the caller, so it applies identically to the
/// service token and to a granted device.
#[cfg(test)]
const AGENT_CONTROL_COMMANDS: &[&str] = &[
    "spawn_external_agent",
    "send_to_external_agent",
    "kill_external_agent",
    "get_external_agent_status",
];

#[cfg(test)]
static AGENT_CONTROL_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| AGENT_CONTROL_COMMANDS.iter().copied().collect());

/// True when `name` needs the agent-control grant (or a service token).
#[cfg(test)]
fn is_agent_control_command(name: &str) -> bool {
    AGENT_CONTROL_COMMANDS_SET.contains(name)
}

/// Whether this caller may run agents on this host.
///
/// The brain keeps its existing access through the service scope; a paired
/// device needs an explicit grant, which on a desktop host comes from the
/// paired-devices toggle and on a headless host from
/// `cognia-server devices grant --agent-control`.
#[cfg(test)]
fn is_agent_control_authorized(name: &str, device_id: &str, scope: Option<&str>) -> bool {
    if !is_agent_control_command(name) {
        return true;
    }
    if scope == Some("service") {
        return true;
    }
    canonical_device_capability(device_id, name)
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

pub(super) fn payload_required_capability(name: &str, args: &Value) -> Option<&'static str> {
    scheduled_task_requires_agent_control(name, args).then_some("process.spawn")
}

/// Public read-only accessor for the remote-control command set. Used by
/// in-file tests to assert the gate covers the intended surfaces.
#[cfg(test)]
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
    can_control_response_value(device_can_control(device_id))
}

fn can_control_response_value(allowed: bool) -> Value {
    serde_json::json!({ "allowed": allowed })
}

/// Read-only response body for `companion_endpoints` — the set of addresses
/// this desktop is currently reachable on.
///
/// The QR pair payload carries exactly one `baseUrl` (tunnel takes priority
/// over LAN — see [`super::commands::companion_create_owner_invitation`]), which leaves
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
/// Mirrors the LAN branch of [`super::commands::companion_create_owner_invitation`]:
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

/// Axum handler for `POST /internal/_rpc/:name`.
///
/// Steps:
/// 1. Pull [`DeviceContext`] injected by the JWT middleware.
/// 2. Read the `Idempotency-Key` header (if present).  Read-only commands
///    skip the cache entirely.
/// 3. If a cache hit exists, return the cached body immediately.
/// 4. Dispatch to the allowlist match in [`dispatch`].
/// 5. On success, write the response body into the cache (non-read-only only).
#[cfg(test)]
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
    // Wave 3.3 — paired devices are rate-limited per device. The headless
    // service principal is loopback-only and performs a large deterministic
    // bootstrap burst, so charging it against a 10-request device bucket
    // leaves runtimes half-initialized.
    if ctx.scope != "service" {
        if let crate::companion_api::rate_limit::RateLimitDecision::Reject { retry_after } =
            state.rate_limiter.check(&ctx.device_id)
        {
            return Err(RpcError::rate_limited(retry_after.as_secs()));
        }
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

/// Execute a command after the canonical remote execution module has completed
/// authentication, capability, approval, transport, and durable-idempotency
/// checks. This is intentionally the only non-HTTP entry into the dispatch
/// table; protocol adapters must call `remote_execution::execute` instead.
pub(super) async fn dispatch_canonical(
    name: &str,
    args: Value,
    state: &SharedState,
    ctx: &DeviceContext,
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    if name == "app_settings_update" {
        validate_app_settings_update(&args)?;
    }
    let host = super::dispatch_host::DispatchHost::from_state(state).ok_or_else(|| {
        RpcError::service_unavailable("app_handle not available (test mode)".to_string())
    })?;
    let result = dispatch(
        name,
        args,
        state,
        &host,
        &ctx.device_id,
        Some(&ctx.account_id),
        Some(&ctx.scope),
    )
    .await;
    super::metrics::record_rpc_call(result.is_ok());
    result
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

async fn publish_direct_transcript_revision(
    state: &SharedState,
    data_plane: &super::data_plane::DataPlane,
    session_id: &str,
) {
    let Some(revision) = data_plane.direct_transcript_revision(session_id).await else {
        return;
    };
    state.event_bus.publish(
        "transcript://revision".to_string(),
        json!({ "sessionId": session_id, "revision": revision }),
    );
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

fn authorize_workspace_root(
    host: &crate::companion_api::dispatch_host::DispatchHost,
    requested: String,
) -> Result<String, (StatusCode, Json<RpcError>)> {
    if let Some(services) = host.headless() {
        return services
            .spawn_policy
            .validate_workspace_root(&requested)
            .map_err(|error| RpcError::forbidden(format!("workspace root denied: {error}")));
    }
    if !crate::files::is_remote_workspace_path_allowed(&requested) {
        return Err(RpcError::forbidden(
            "workspace root is not registered by the active desktop project",
        ));
    }
    std::path::Path::new(&requested)
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| RpcError::malformed(format!("workspace root does not resolve: {error}")))
}

fn authorize_sensitive_resource(
    requested: bool,
    device_id: &str,
    scope: Option<&str>,
) -> Result<bool, (StatusCode, Json<RpcError>)> {
    if !requested {
        return Ok(false);
    }
    if scope == Some("service") || canonical_device_has_capability(device_id, "workspace.write") {
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

fn headless_orchestration_event_sink() -> OrchestrationEventSink {
    use super::bridge_transport::BridgeTransport;

    std::sync::Arc::new(move |event| {
        let payload = serde_json::to_value(event).map_err(|error| error.to_string())?;
        let bridge = super::ws_bridge::socket_bridge_transport()
            .ok_or_else(|| "headless Brain bridge is disconnected".to_string())?;
        bridge.emit(crate::mcp_server::orchestration_proxy::EXEC_EVENT, payload)
    })
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
                    None,
                    Some(headless_orchestration_event_sink()),
                )
                .await
        }
    };

    match started {
        Ok(port) => {
            super::external_bridge::set_runtime_state(&data_dir, "running", None);
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
    // Remote Session Control gate. Runs for both the HTTP `rpc_handler` and
    // the WebRTC `signaling::dispatch` path (both funnel through here), so the
    // elevated capability is enforced regardless of transport. Baseline chat
    // and read-only sync are not in `CONTROL_COMMANDS`, so they pass through.
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

    if chat::COMMANDS.contains(&name) {
        return chat::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if codex_app::COMMANDS.contains(&name) {
        return codex_app::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if native_tools::COMMANDS.contains(&name) {
        return native_tools::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if data_sync::COMMANDS.contains(&name) {
        return data_sync::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if service_plane::COMMANDS.contains(&name) {
        return service_plane::dispatch(name, args, state, host, device_id, account_id, scope)
            .await;
    }

    if source_control::COMMANDS.contains(&name) {
        return source_control::dispatch(name, args, state, host, device_id, account_id, scope)
            .await;
    }

    if filesystem::COMMANDS.contains(&name) {
        return filesystem::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if terminal::COMMANDS.contains(&name) {
        return terminal::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if plugins::COMMANDS.contains(&name) {
        return plugins::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    if diagnostics::COMMANDS.contains(&name) {
        return diagnostics::dispatch(name, args, state, host, device_id, account_id, scope).await;
    }

    Err(RpcError::unknown_command(name))
}

#[cfg(test)]
mod tests;
