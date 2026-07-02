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
//! in [`READ_ONLY_COMMANDS`], a successful response is stored in the
//! per-device [`IdempotencyCache`] for 60 seconds. A second request with the
//! same `(device_id, idempotency_key)` returns the cached body immediately
//! without re-executing the command.
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
use serde_json::Value;

use crate::{
    agents::commands as agent_commands,
    api_key::ApiKeyState,
    claude::{
        commands as claude_commands, mcp_test,
        sidecar::{kill_sidecar, SidecarState},
    },
    mcp_server::McpServerState,
    skills::{install, native as skills_native, registry},
};

use super::{middleware::DeviceContext, SharedState};

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

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
    "claude_approve",
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
    "mcp_server_status",
    "test_mcp_server",
    "read_agent_config",
    "write_agent_config",
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
    // ADR-0056 Wave 4 — external-agent config (Zustand/localStorage on the
    // desktop, not Dexie). `external_agent_list` is a read-only projection;
    // `external_agent_update` (enable/disable + permission mode) round-trips
    // through the mobile outbound queue. Both via desktop_writes_bridge.
    "external_agent_list",
    "external_agent_update",
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
    // Remote Session Control — attach/detach a remote watcher + steer host
    // goal loops. All round-trip through desktop_writes_bridge. Gated by the
    // remote-control capability (see CONTROL_COMMANDS).
    "session_attach",
    "session_detach",
    "goal_pause",
    "goal_resume",
    "goal_stop",
    // Resolve a host computer-use consent prompt from a remote device.
    // Calls the automation ConsentBroker directly (not via writes-bridge).
    "automation_consent_respond",
    // Read-only capability probe — lets a paired device learn whether it holds
    // the remote-control capability without attempting (and 403-ing on) a
    // gated RPC. NOT a CONTROL_COMMAND: every paired device may query its own
    // standing.
    "companion_can_control",
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
    "fs_read_workspace_file",
    "fs_write_workspace_file",
    // ── Terminal ────────────────────────────────────────────────────────────
    // Live PTY stays on `/ws/v1/terminal`; these are request/response only.
    // `terminal_exec` is a one-shot command runner (capture stdout/stderr/exit).
    "terminal_list_all",
    "terminal_list_for_project",
    "terminal_kill",
    "terminal_exec",
    // ── Plugins ─────────────────────────────────────────────────────────────
    // Native install/uninstall manage the on-disk plugin dir + Rust snapshot.
    // A remote install takes effect on the next renderer reload (it does not
    // hot-load into the running PluginManager — see the OpenAPI note).
    "plugin_list",
    "plugin_runtime_snapshot",
    "plugin_install",
    "plugin_install_from_github",
    "plugin_uninstall",
    "plugin_backup_create",
    "plugin_backup_restore",
    "plugin_backup_delete",
    // ── Workflow CRUD (ADR-0027 Wave 4.1) ───────────────────────────────────
    // Definitions live in Dexie — round-trip through desktop_writes_bridge.
    "workflow_create",
    "workflow_update",
    "workflow_delete",
    "workflow_run_list",
    "workflow_cancel_run",
    "workflow_schedule_pause",
    "workflow_schedule_resume",
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
    // ── Settings / conversation overrides ───────────────────────────────────
    "conversation_overrides_update",
    // ── App-data backup ─────────────────────────────────────────────────────
    "backup_export",
    "backup_import",
];

/// Public read-only accessor for the dispatch allowlist. Used by the
/// `spec_parity` test (Wave 3.6) to assert that every command in this
/// list has a matching `/api/v1/_rpc/<name>` path in the OpenAPI spec.
#[allow(dead_code)] // referenced from `spec_parity::tests` only.
pub fn known_commands() -> &'static [&'static str] {
    KNOWN_COMMANDS
}

/// Commands in this list skip the idempotency cache entirely.
/// They are cheap to re-run and structurally idempotent.
const READ_ONLY_COMMANDS: &[&str] = &[
    "claude_sidecar_status",
    "claude_has_api_key",
    "claude_has_oauth_bearer",
    "skills_load_registry",
    "skills_scan_native",
    "mcp_server_status",
    "read_agent_config",
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
    // ADR-0056 Wave 4 — read-only external-agent list projection.
    "external_agent_list",
    // Read-only remote-control capability probe (drives the mobile
    // computer-use consent sheet). Pure read of the process-global allow list.
    "companion_can_control",
    // Source-control reads — same (repoPath, …) returns the same snapshot.
    "git_is_repo",
    "git_repo_state",
    "git_status",
    "git_diff_file",
    "git_diff_commit",
    "git_commit_files",
    "git_log",
    "git_file_history",
    "git_branches",
    "git_remotes",
    "git_stash_list",
    "git_conflicts",
    // Filesystem reads.
    "read_text_file",
    "default_export_dir",
    "fs_search_workspace",
    "fs_read_workspace_file",
    // Terminal session listings.
    "terminal_list_all",
    "terminal_list_for_project",
    // Plugin registry reads.
    "plugin_list",
    "plugin_runtime_snapshot",
    // Workflow run listing.
    "workflow_run_list",
    // Twin reads.
    "twin_source_list",
    "twin_job_status",
    // Goal status is a pure read (same goalId/sessionId returns current state).
    "goal_status",
    // App-data backup export is a pure read (snapshots current state).
    "backup_export",
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
    "session_attach",
    "session_detach",
    "goal_pause",
    "goal_resume",
    "goal_stop",
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
    // Filesystem writes (raw absolute + sandboxed).
    "write_text_file",
    "write_text_file_confined",
    "ensure_dir",
    "ensure_dir_confined",
    "fs_write_workspace_file",
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
    // Plugin install/uninstall/backup-restore — modify the on-disk plugin set.
    "plugin_install",
    "plugin_install_from_github",
    "plugin_uninstall",
    "plugin_backup_create",
    "plugin_backup_restore",
    "plugin_backup_delete",
    // Workflow destructive ops.
    "workflow_delete",
    "workflow_cancel_run",
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
    // App-data restore overwrites local state.
    "backup_import",
];

/// O(1) membership mirrors of the command allowlists above. The `&[&str]`
/// arrays stay the source of truth (the spec-parity and source-scan tests
/// iterate them), while these hashed sets are consulted on the per-request
/// hot path — classifying a command no longer linear-scans ~200 entries up
/// to three times per RPC.
static KNOWN_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| KNOWN_COMMANDS.iter().copied().collect());
static READ_ONLY_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| READ_ONLY_COMMANDS.iter().copied().collect());
static CONTROL_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| CONTROL_COMMANDS.iter().copied().collect());

/// True when `name` requires the remote-control capability.
fn is_control_command(name: &str) -> bool {
    CONTROL_COMMANDS_SET.contains(name)
}

/// RCE-grade commands that ONLY the headless brain's service token may call
/// (ADR-0059 W4/D6). A device JWT presenting one of these is rejected with 403
/// `service_scope_required`. Populated with the `*_external_agent` +
/// `connectors_*_adapter` arms in R11/R12; empty until then, so the gate is a
/// no-op on today's surface.
const SERVICE_ONLY_COMMANDS: &[&str] = &[];

static SERVICE_ONLY_COMMANDS_SET: once_cell::sync::Lazy<HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| SERVICE_ONLY_COMMANDS.iter().copied().collect());

/// True when `name` may be invoked only with a `"service"`-scope JWT.
fn is_service_only_command(name: &str) -> bool {
    SERVICE_ONLY_COMMANDS_SET.contains(name)
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

/// Allowlisted patch keys for `app_settings_update`. The mobile client may
/// only mutate user-facing preferences; transport, sidecar, and provider
/// configuration stay desktop-only. Mirror this with the OpenAPI spec.
const APP_SETTINGS_MOBILE_ALLOWED_KEYS: &[&str] = &[
    "theme",
    "fontScale",
    "language",
    "reduceMotion",
    "defaultModel",
    "defaultCharacterId",
    "biometricRequiredFor",
    // Mobile `/me/computer-use` master toggle (ADR-0020 follow-up). When
    // false, mobile-initiated turns refuse computer-use regardless of the
    // per-character flag.
    "mobileComputerUseEnabled",
    // Appearance — mobile `/me/appearance` route writes these through the
    // same allowlist. The matching field types live in
    // `lib/claude/types.ts` (`colorTheme`, `customThemes`,
    // `activeCustomThemeId`, `wallpapers`, `customCss`, `customCssEnabled`,
    // `importedVscodeThemes`).
    "colorTheme",
    "customThemes",
    "activeCustomThemeId",
    "wallpapers",
    "customCss",
    "customCssEnabled",
    "importedVscodeThemes",
    // ADR-0021 — WebRTC WAN transport configuration. Mobile clients toggle
    // the feature and configure ICE/TURN/signaling endpoints from the
    // Mobile companion settings tab.
    "webrtcEnabled",
    "signalingUrl",
    "iceServers",
    "turnServers",
    "turnProvider",
    // Wave 4.1 — broader user-facing preference surface so the mobile shell can
    // mirror the desktop settings it already renders. All are non-credential,
    // non-transport preference fields on `AppSettings` (`lib/claude/types.ts`).
    "telemetryEnabled",
    "sttLanguage",
    "selectedMicId",
    "pinnedWorkflowIds",
    "pinnedMeRowIds",
    "sidebarLayout",
    "lastInboxViewedAt",
    "conversationTitle",
    "conversationTimeline",
    "searchEnabled",
    "searchMaxResults",
    "ttsEnabled",
    "ttsProvider",
    "ttsRate",
    "ttsPitch",
    "ttsVolume",
    "ttsAutoPlay",
    // ADR-0056 (mobile settings parity) — the remaining "portable" appearance
    // keys that already sync desktop→phone (`CROSS_PLATFORM_SETTING_KEYS`) but
    // were not yet writable back, so the embedded `<AppearanceSection/>` on
    // `/me/appearance` silently 400'd on those tabs. All are non-credential
    // presentation prefs.
    "autoMode",
    "density",
    "radius",
    "motion",
    "typographyExt",
    "a11y",
    // ADR-0056 — agent-default preferences. Editable from the phone's
    // `/me/agent` page only in PAIRED mode (the standalone engine has no agent
    // loop). `permissionMode` escalations are additionally biometric-gated on
    // the client (decision D4); the server still only checks allowlist
    // membership here. None are credentials or transport config.
    "permissionMode",
    "defaultSystemPrompt",
    "defaultMaxThinkingTokens",
    "bareMode",
    "debugMode",
    "briefMode",
    // ADR-0056 (Wave 2) — conversation completeness. `composerBehavior` and
    // `streamPartialMessages` are phone-composer / render prefs; `compaction`
    // is agent-execution config edited from `/me/agent` (paired). None are
    // credentials or transport config.
    "composerBehavior",
    "streamPartialMessages",
    "compaction",
    // ADR-0056 (Wave 3) — project instruction loading config (CLAUDE.md /
    // AGENTS.md discovery on the paired desktop). Remote-edited from
    // `/me/instructions`. The globalPath / extraPaths it carries are desktop
    // filesystem paths, but the value is config, not a credential.
    "instructions",
    // ADR-0056 (Wave 3) — master toggle for built-in surface-skill auto-
    // injection (flows into `resolveSendOptions`). Edited from `/me/agent`.
    "surfaceSkillsEnabled",
    // ADR-0056 — visual workflow editor performance tier. Edited from
    // `/me/workflows-settings` (both modes). A per-device motion/computation
    // knob, not a credential or transport field; it is intentionally NOT
    // mirrored desktop→phone (kept device-local) but is writable up so a
    // paired desktop's tier can be set from the phone.
    "workflowEditorPerformanceTier",
    // ADR-0056 (Wave 2) — per-provider TTS voice selection. The phone's
    // `/me/speech` page writes the active provider's flat voice-id key
    // (matching the desktop `provider-config.tsx` field names). All are
    // non-credential preference strings; API keys are NOT here.
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
    // ADR-0056 (Wave 2) — web-search completeness. Preferred provider +
    // cloud→system fallback edited from `/me/web-search`. Provider API keys
    // stay device-local (`searchProviders` is deliberately NOT allowlisted).
    "defaultSearchProvider",
    "searchFallbackEnabled",
    // ADR-0056 (Wave 2) — Notification Center preferences (one JSON object).
    // The phone's `/me/notifications` page edits channels / level gates / quiet
    // hours / behaviour / per-source mute / retention. The OS push permission
    // itself stays a native, device-local grant (not part of this value).
    "notificationPreferences",
];

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
    if is_control_command(&name) && !super::control_allow_list::global().is_allowed(&ctx.device_id)
    {
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

    // Wave 3.3 — per-device rate limiter sits after the JWT verifier
    // middleware (so we can key on device_id) and before idempotency
    // lookup (cache hits don't burn a token).
    if let crate::companion_api::rate_limit::RateLimitDecision::Reject { retry_after } =
        state.rate_limiter.check(&ctx.device_id)
    {
        return Err(RpcError::rate_limited(retry_after.as_secs()));
    }

    let is_read_only = READ_ONLY_COMMANDS_SET.contains(name.as_str());

    // Cache look-up (non-read-only commands only).
    if !is_read_only {
        if let Some(ref key) = idem_key {
            if let Some(cached) = state.idempotency.get(&ctx.device_id, key) {
                return Ok(Json(cached));
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
    let result = dispatch(
        &name,
        args,
        &state,
        &host,
        &ctx.device_id,
        Some(&ctx.account_id),
    )
    .await?;

    // Cache the result (non-read-only + idempotency key present).
    if !is_read_only {
        if let Some(key) = idem_key {
            state
                .idempotency
                .put(ctx.device_id.clone(), key, result.clone());
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

/// Serialize a command result into the JSON [`Value`] envelope, mapping any
/// serde failure to a `500 internal_error`. Cuts the repeated
/// `serde_json::to_value(x).map_err(...)` boilerplate across the native arms.
fn to_json<T: serde::Serialize>(value: T) -> Result<Value, (StatusCode, Json<RpcError>)> {
    serde_json::to_value(value).map_err(|e| RpcError::internal(e.to_string()))
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
) -> Result<Value, (StatusCode, Json<RpcError>)> {
    use tauri::Manager as _;

    // Remote Session Control gate. Runs for both the HTTP `rpc_handler` and
    // the WebRTC `signaling::dispatch` path (both funnel through here), so the
    // elevated capability is enforced regardless of transport. Baseline chat
    // and read-only sync are not in `CONTROL_COMMANDS`, so they pass through.
    if is_control_command(name) && !super::control_allow_list::global().is_allowed(device_id) {
        return Err(RpcError::forbidden(
            "this device is not authorized for remote control; enable it from the desktop paired-devices settings",
        ));
    }

    // Allowlist gate. The HTTP `rpc_handler` already rejects unknown names
    // before reaching here, but the WebRTC `signaling::dispatch` path calls
    // `dispatch` directly without that check — enforcing it here keeps the two
    // transports' command surfaces identical (no DataChannel superset) and
    // guarantees every reachable arm is a documented, allowlisted command.
    if !KNOWN_COMMANDS_SET.contains(name) {
        return Err(RpcError::unknown_command(name));
    }

    match name {
        // ── Chat session ─────────────────────────────────────────────────────

        "claude_send" => {
            let session_id: String = required(&args, "session_id")?;
            let prompt: Value = required(&args, "prompt")?;
            let options: Option<claude_commands::SendOptions> = optional(&args, "options")?;
            let app = host.tauri_app(name)?;
            let sidecar_state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_send(app.clone(), sidecar_state, session_id, prompt, options)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_interrupt" => {
            let session_id: String = required(&args, "session_id")?;
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_interrupt(state, session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_compact" => {
            let session_id: String = required(&args, "session_id")?;
            let focus: Option<String> = args
                .get("focus")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_compact(state, session_id, focus)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_approve" => {
            let session_id: String = required(&args, "session_id")?;
            let request_id: String = required(&args, "request_id")?;
            let decision: String = required(&args, "decision")?;
            let message: Option<String> = optional(&args, "message")?;
            let updated_input: Option<Value> = optional(&args, "updated_input")?;
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_approve(
                state,
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
            let session_id: String = required(&args, "session_id")?;
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_close_session(state, session_id)
                .await
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }

        "claude_sidecar_status" => {
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, SidecarState> = app.state();
            claude_commands::claude_sidecar_status(state)
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
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            state.set_oauth_bearer(token).await;
            Ok(Value::Null)
        }

        // ── Provider env ─────────────────────────────────────────────────────

        "claude_set_api_key" => {
            let key: Option<String> = optional(&args, "key")?;
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            state.set(key).await;
            Ok(Value::Null)
        }

        "claude_set_provider_env" => {
            let api_key: Option<String> = optional(&args, "api_key")?;
            let base_url: Option<String> = optional(&args, "base_url")?;
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            state.set_provider(api_key, base_url).await;
            Ok(Value::Null)
        }

        "claude_has_api_key" => {
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            let has = state.get().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_has_oauth_bearer" => {
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, ApiKeyState> = app.state();
            let has = state.get_oauth_bearer().await.is_some();
            Ok(Value::Bool(has))
        }

        "claude_restart_sidecar" => {
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, SidecarState> = app.state();
            kill_sidecar(state.inner().clone()).await;
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

        // ── MCP server ────────────────────────────────────────────────────────

        "mcp_server_status" => {
            let app = host.tauri_app(name)?;
            let state: tauri::State<'_, McpServerState> = app.state();
            let status = state.status();
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
        // Mobile outbound-queue RPCs — same generic bridge, different
        // TS-side dispatch arms in `lib/companion/desktop-write-source.ts`.
        | "connector_send"
        | "connector_approve_draft"
        | "connector_reject_draft"
        | "workflow_trigger_manual"
        | "twin_ingest_source"
        // Remote Session Control — attach/detach a remote watcher + steer
        // host goal loops. Same generic bridge; TS-side dispatch arms live in
        // `lib/companion/desktop-write-source.ts`. Gated by CONTROL_COMMANDS.
        | "session_attach"
        | "session_detach"
        | "goal_pause"
        | "goal_resume"
        | "goal_stop"
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
        | "conversation_overrides_update"
        | "backup_export"
        | "backup_import"
        // ADR-0056 Wave 4 — external-agent list (read) + update (enable/disable
        // + permission mode). TS-side dispatch arms in
        // `lib/companion/desktop-write-source.ts`.
        | "external_agent_list"
        | "external_agent_update" => {
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

        // ── Filesystem ───────────────────────────────────────────────────────
        // Raw absolute-path ops have NO sandbox (desktop relied on a file-dialog
        // gesture for scope; remote exposure removes it). Both the writes AND
        // this read are therefore CONTROL-gated (see `CONTROL_COMMANDS`). The
        // `fs_*_workspace` variants enforce a root-relative path-traversal check
        // and remain the recommended, ungated client path for workspace files.
        "read_text_file" => {
            let path: String = required(&args, "path")?;
            tokio::task::spawn_blocking(move || crate::files::read_text_file_impl(path))
                .await
                .map_err(|e| RpcError::internal(e.to_string()))?
                .map(Value::String)
                .map_err(RpcError::internal)
        }
        "write_text_file" => {
            let path: String = required(&args, "path")?;
            let content: String = required(&args, "content")?;
            tokio::task::spawn_blocking(move || crate::files::write_text_file_impl(path, content))
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
            tokio::task::spawn_blocking(move || crate::files::ensure_dir_impl(path))
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

        // ── Terminal ───────────────────────────────────────────────────────
        // Live PTY streaming stays on `/ws/v1/terminal`. These are
        // request/response only; `terminal_exec` is a one-shot command runner.
        "terminal_list_all" => {
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::terminal::TerminalState> = app.state();
            crate::terminal::commands::terminal_list_all(st)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "terminal_list_for_project" => {
            let project_id: String = required(&args, "projectId")?;
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::terminal::TerminalState> = app.state();
            crate::terminal::commands::terminal_list_for_project(st, project_id)
                .map_err(RpcError::internal)
                .and_then(to_json)
        }
        "terminal_kill" => {
            let id: String = required(&args, "id")?;
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::terminal::TerminalState> = app.state();
            crate::terminal::commands::terminal_kill(st, id)
                .map(|_| Value::Null)
                .map_err(RpcError::internal)
        }
        "terminal_exec" => {
            let command: String = required(&args, "command")?;
            let exec_args: Vec<String> = optional(&args, "args")?.unwrap_or_default();
            let cwd: Option<String> = optional(&args, "cwd")?;
            let env: Option<std::collections::HashMap<String, String>> = optional(&args, "env")?;
            let timeout_ms: Option<u64> = optional(&args, "timeoutMs")?;
            crate::terminal::exec::terminal_exec_inner(cwd, command, exec_args, env, timeout_ms, None)
                .await
                .map_err(RpcError::internal)
                .and_then(to_json)
        }

        // ── Plugins ──────────────────────────────────────────────────────────
        // Native install/uninstall manage the on-disk plugin dir + Rust
        // snapshot; a remote install takes effect on the next renderer reload
        // (it does not hot-load into the running TS PluginManager).
        "plugin_list" => {
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_get_all(st)
                .await
                .map_err(|e| RpcError::internal(e.to_string()))
                .and_then(to_json)
        }
        "plugin_runtime_snapshot" => {
            let plugin_id: String = required(&args, "pluginId")?;
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
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::github::installer::plugin_install_from_github(
                st, repo, git_ref, subdir,
            )
            .await
            .map_err(RpcError::internal)
            .and_then(to_json)
        }
        "plugin_uninstall" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::lifecycle::plugin_uninstall(st, plugin_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
        }
        "plugin_backup_create" => {
            let plugin_id: String = required(&args, "pluginId")?;
            let label: Option<String> = optional(&args, "label")?;
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
            let app = host.tauri_app(name)?;
            let st: tauri::State<'_, crate::plugin_api::PluginRuntimeState> = app.state();
            crate::plugin_api::backup::plugin_backup_delete(st, plugin_id, backup_id)
                .await
                .map(|_| Value::Null)
                .map_err(|e| RpcError::internal(e.to_string()))
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
        super::super::dispatch_host::DispatchHost::Headless(crate::headless::HeadlessServices::new())
    }

    /// Data-plane arms work on a headless host: `session_list` served from
    /// the degraded SQLite store, no AppHandle anywhere.
    #[tokio::test]
    async fn headless_dispatch_serves_the_data_plane_from_the_store() {
        use crate::companion_api::store::AppStore;
        let _guard = crate::companion_api::ws_bridge::test_support::lock_slot().await;
        crate::companion_api::ws_bridge::test_support::clear_socket_for_testing();
        let store =
            crate::companion_api::store::sqlite::SqliteAppStore::in_memory().expect("open");
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
        )
        .await
        .expect("session_list must work on a headless host");
        assert_eq!(result["total"], 0);

        crate::companion_api::data_plane::install_headless_store(None);
    }

    /// Desktop-only arms reply with the per-arm 503 `headless_unsupported`
    /// naming the command — not a generic service_unavailable.
    #[tokio::test]
    async fn headless_dispatch_rejects_desktop_only_arms() {
        let state = test_state();
        let err = dispatch(
            "claude_sidecar_status",
            json!({}),
            &state,
            &headless_host(),
            "dev1",
            Some(ACCOUNT_ID),
        )
        .await
        .expect_err("desktop-only arm must 503 on a headless host");
        assert_eq!(err.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.1 .0.code, "headless_unsupported");
        assert!(err.1 .0.message.contains("claude_sidecar_status"));
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
        // Pre-seed the cache with a known response for device "dev-idem".
        cache.put(
            "dev-idem".into(),
            "idem-key-1".into(),
            json!({ "cached": true }),
        );

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
        let resp = rpc_post(
            router,
            "claude_send",
            json!({ "session_id": "s1", "prompt": "hi" }),
            &jwt,
            Some("idem-key-1"),
        )
        .await;
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
        cache.put("dev2".into(), "k1".into(), json!({ "hit": 1 }));
        cache.put("dev2".into(), "k2".into(), json!({ "hit": 2 }));

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
        cache.put("dev4".into(), "stale".into(), json!({ "stale": true }));
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
        let resp = rpc_post(
            router,
            "claude_interrupt",
            json!({ "session_id": "s" }),
            &jwt,
            Some("stale"),
        )
        .await;
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

    // ── Wave 4.1 classification sentinels ────────────────────────────────────
    // One read + one destructive write per new domain, plus structural
    // integrity (every CONTROL/READ_ONLY entry is also a KNOWN command). These
    // guard the manual lockstep the cross-language parity gates can't.

    #[test]
    fn wave41_reads_are_read_only_and_writes_are_not() {
        for read in [
            "git_status",
            "git_diff_file",
            "read_text_file",
            "fs_read_workspace_file",
            "terminal_list_all",
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
    fn wave41_destructive_writes_are_control_gated() {
        for gated in [
            "git_push",
            "git_commit",
            "git_stage",
            "write_text_file",
            "fs_write_workspace_file",
            "terminal_exec",
            "terminal_kill",
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
        ] {
            assert!(
                !is_control_command(ungated),
                "{ungated} should NOT be gated"
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
        for key in ["composerBehavior", "streamPartialMessages", "compaction"] {
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
        // ADR-0056 — workflow editor performance tier, written from
        // `/me/workflows-settings`. Missing → 400 on save.
        assert!(
            APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&"workflowEditorPerformanceTier"),
            "workflowEditorPerformanceTier missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
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
    fn mobile_allowlist_includes_webrtc_keys() {
        // ADR-0021 — the WebRTC settings card writes these from the mobile
        // companion tab; `turnProvider` (ephemeral-TURN provisioning) joined
        // the original four. Missing any → 400 on save.
        for key in [
            "webrtcEnabled",
            "signalingUrl",
            "iceServers",
            "turnServers",
            "turnProvider",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "WebRTC key '{key}' missing from APP_SETTINGS_MOBILE_ALLOWED_KEYS"
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
            "defaultCharacterId",
            "biometricRequiredFor",
        ] {
            assert!(
                APP_SETTINGS_MOBILE_ALLOWED_KEYS.contains(&key),
                "baseline key '{key}' must stay in the mobile allowlist"
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
}
