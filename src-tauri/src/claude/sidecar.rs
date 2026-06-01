use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::api_key::ApiKeyState;
use crate::hooks;

/// Tauri event channel name. The frontend subscribes via
/// `listen("claude://message", ...)`.
pub const SIDECAR_EVENT: &str = "claude://message";

/// Dedicated event channel for A2UI dispatches (createSurface,
/// updateComponents, dataModelUpdate, deleteSurface). Kept separate from
/// `SIDECAR_EVENT` so the a2ui store can subscribe without sifting through
/// every sidecar message.
pub const A2UI_EVENT: &str = "a2ui://dispatch";

/// Shared, mutable state. Cloned cheaply via `Arc`.
#[derive(Clone, Default)]
pub struct SidecarState {
    inner: Arc<Mutex<Inner>>,
    /// ADR-0028 Phase 14 — incremented every time `spawn` succeeds after
    /// boot. Surfaced through `sidecar_restart_count` for the Diagnostics
    /// → Sidecar card so users can see how often the sidecar has
    /// recovered without restarting the app. `AtomicU64` keeps the
    /// counter lock-free.
    restart_count: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    ready: bool,
    /// Per-session hook context: the send-time cwd (for project/local scope
    /// resolution) and the in-flight tool_use map used to correlate a
    /// `tool_result` back to the tool name/input that produced it (PostToolUse).
    sessions: HashMap<String, SessionHookCtx>,
}

#[derive(Default)]
struct SessionHookCtx {
    cwd: Option<String>,
    /// tool_use_id → (tool_name, input), pending until the matching tool_result.
    pending_tools: HashMap<String, (String, Value)>,
}

impl SidecarState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of times the sidecar has been spawned (re-spawned counts).
    /// The first boot returns 1; each `kill_sidecar` + subsequent `spawn`
    /// increments the counter.
    pub fn restart_count(&self) -> u64 {
        self.restart_count.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Increment the restart counter — called by `spawn` after the child
    /// process is in the map.
    pub(crate) fn bump_restart_count(&self) {
        self.restart_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// Send one JSON-line command to the running sidecar.
    pub async fn write_command(&self, msg: &Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        let mut guard = self.inner.lock().await;
        let stdin = guard
            .stdin
            .as_mut()
            .ok_or_else(|| "sidecar not running".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn is_ready(&self) -> bool {
        self.inner.lock().await.ready
    }

    /// Record the send-time cwd for a session so the hook observer can resolve
    /// project/local-scope settings (trust-gated). Called from `claude_send`.
    pub async fn register_session_cwd(&self, session_id: &str, cwd: Option<String>) {
        let mut guard = self.inner.lock().await;
        guard.sessions.entry(session_id.to_string()).or_default().cwd = cwd;
    }

    /// The send-time cwd for a session, if known.
    async fn session_cwd(&self, session_id: &str) -> Option<String> {
        self.inner
            .lock()
            .await
            .sessions
            .get(session_id)
            .and_then(|s| s.cwd.clone())
    }

    /// Remember in-flight tool_use blocks so a later tool_result can resolve its
    /// tool name + input for the PostToolUse payload. Called INLINE from the
    /// sequential reader (not the spawned observer) so the assistant message is
    /// always recorded before its tool_result task runs — otherwise concurrent
    /// observer tasks could `take` before the `record` and drop the tool name.
    async fn record_tool_uses_from_message(&self, value: &Value) {
        let Some(evt) = value.get("event") else { return };
        let uses = hooks::extract_tool_uses(evt);
        if uses.is_empty() {
            return;
        }
        let session_id = value
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let mut guard = self.inner.lock().await;
        let ctx = guard.sessions.entry(session_id).or_default();
        for (id, name, input) in uses {
            ctx.pending_tools.insert(id, (name, input));
        }
    }

    /// Remove and return the `(tool_name, input)` recorded for `tool_use_id`.
    async fn take_tool(&self, session_id: &str, tool_use_id: &str) -> Option<(String, Value)> {
        self.inner
            .lock()
            .await
            .sessions
            .get_mut(session_id)
            .and_then(|s| s.pending_tools.remove(tool_use_id))
    }

    /// Drop all per-session hook state when a session ends.
    async fn clear_session(&self, session_id: &str) {
        self.inner.lock().await.sessions.remove(session_id);
    }
}

/// Resolve the absolute path to the bundled `sidecar/` directory in both
/// dev and release builds. Used by:
///   - `resolve_sidecar_script` to locate `claude-host.mjs`
///   - `a2ui_bridge::commands::a2ui_bridge_runtime_paths` so external-agent
///     MCP configs can spawn `node ${sidecarDir}/a2ui-mcp.mjs` with an
///     absolute argv.
pub fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Release: bundled resources directory.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("sidecar");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    // Dev: walk up from the Cargo manifest dir to the repo root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest
        .parent()
        .map(|p| p.join("sidecar"))
        .ok_or_else(|| "could not locate project root".to_string())?;
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar directory not found at {}",
        candidate.display()
    ))
}

/// Resolve the absolute path to `sidecar/claude-host.mjs`, in both dev and
/// release builds.
fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = sidecar_dir(app)?;
    let candidate = dir.join("claude-host.mjs");
    if candidate.exists() {
        return Ok(candidate);
    }
    Err(format!(
        "sidecar script not found at {}",
        candidate.display()
    ))
}

/// Spawn the Node sidecar and start pumping its stdout into Tauri events.
///
/// Safe to call multiple times — subsequent calls become no-ops while the
/// child is alive.
pub async fn spawn(app: AppHandle, state: SidecarState) -> Result<(), String> {
    {
        let guard = state.inner.lock().await;
        if guard.child.is_some() {
            return Ok(());
        }
    }

    let script = resolve_sidecar_script(&app)?;
    let cwd = script
        .parent()
        .ok_or_else(|| "sidecar script has no parent dir".to_string())?
        .to_path_buf();

    // On Windows, `node` is typically `node.exe` and discoverable via PATH.
    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Inject the user-supplied Anthropic provider env, if any. Auth precedence:
    //   1. OAuth bearer (CLAUDE_CODE_OAUTH_TOKEN) — when the user has signed in
    //      with their Pro/Max subscription. The `@anthropic-ai/claude-agent-sdk`
    //      reads this var and sends `Authorization: Bearer ...` plus the
    //      `oauth-2025-04-20` beta header automatically. We deliberately do
    //      not also send ANTHROPIC_API_KEY in this case — mixing modes is
    //      undefined behavior on the SDK side.
    //   2. ANTHROPIC_API_KEY — legacy + CCSwitch flow.
    // ANTHROPIC_BASE_URL is orthogonal to auth mode and forwarded whenever set.
    if let Some(api_key_state) = app.try_state::<ApiKeyState>() {
        if let Some(token) = api_key_state.get_oauth_bearer().await {
            cmd.env("CLAUDE_CODE_OAUTH_TOKEN", token);
            // Defensive: ensure no stale API key from the parent process leaks
            // through to the sidecar when OAuth is the chosen mode.
            cmd.env_remove("ANTHROPIC_API_KEY");
        } else if let Some(key) = api_key_state.get().await {
            cmd.env("ANTHROPIC_API_KEY", key);
        }
        if let Some(url) = api_key_state.get_base_url().await {
            cmd.env("ANTHROPIC_BASE_URL", url);
        }
    }

    // Inject the user's network proxy config so the Node sidecar's outbound
    // HTTP (Anthropic SDK + any provider relays) routes through the same
    // proxy as the rest of the app. The interceptor at
    // `sidecar/fetch-interceptor.mjs` reads HTTPS_PROXY at boot and wraps
    // the global undici dispatcher.
    let proxy_cfg = crate::proxy_config::current();
    for (k, v) in proxy_cfg.env_vars() {
        cmd.env(k, v);
    }
    if !proxy_cfg.is_active() {
        // Defensive: clear any inherited proxy env so the sidecar doesn't
        // route through a stale parent-process value when the user just
        // disabled the proxy.
        for key in &[
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "NO_PROXY",
            "no_proxy",
        ] {
            cmd.env_remove(key);
        }
    }

    // On Windows, prevent a console window from popping up when the parent app
    // has no console (e.g. a release build). tokio::process::Command exposes
    // `creation_flags` directly on Windows, so no extra import is needed.
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar (is Node >= 20 on PATH?): {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child has no stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child has no stderr".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child has no stdin".to_string())?;

    {
        let mut guard = state.inner.lock().await;
        guard.child = Some(child);
        guard.stdin = Some(stdin);
        guard.ready = false;
    }
    // ADR-0028 Phase 14 — surface the spawn so Diagnostics can show
    // "Sidecar restarted N times this session".
    state.bump_restart_count();

    // Pipe stdout: each line is one JSON event we forward to the frontend.
    {
        let app = app.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => {
                                // Track the sidecar's "ready" announcement so we can short-circuit
                                // status checks before it has fully booted.
                                if value.get("type").and_then(|t| t.as_str()) == Some("ready") {
                                    state.inner.lock().await.ready = true;
                                }
                                // PreToolUse hook: when the sidecar emits a permission_request
                                // we may need to short-circuit it with an automatic deny.
                                // Spawn the hook eval as a task so the reader keeps draining
                                // — concurrent permission_request events are evaluated in
                                // parallel.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("permission_request")
                                {
                                    let app = app.clone();
                                    let state = state.clone();
                                    tokio::spawn(async move {
                                        handle_permission_request(app, state, value).await;
                                    });
                                    continue;
                                }
                                // A2UI bridge dispatches go on a dedicated channel so the
                                // a2ui store can listen without filtering every sidecar event.
                                if value.get("type").and_then(|t| t.as_str())
                                    == Some("a2ui_dispatch")
                                {
                                    if let Err(e) = app.emit(A2UI_EVENT, &value) {
                                        log::error!("failed to emit a2ui dispatch: {e}");
                                    }
                                    continue;
                                }
                                // Lifecycle hooks: observe the SDK event stream
                                // and fire the matching settings.json hooks
                                // (PostToolUse, Stop, SessionStart/End, …). Spawn
                                // so the reader keeps draining; skip the
                                // stream-event flood via the cheap predicate.
                                if hooks::classify::is_hook_relevant(&value) {
                                    // Record tool_use blocks synchronously so a
                                    // later tool_result observer can always
                                    // resolve the tool name despite task concurrency.
                                    state.record_tool_uses_from_message(&value).await;
                                    let app = app.clone();
                                    let state = state.clone();
                                    let observed = value.clone();
                                    tokio::spawn(async move {
                                        observe_hooks(app, state, observed).await;
                                    });
                                }
                                if let Err(e) = app.emit(SIDECAR_EVENT, &value) {
                                    log::error!("failed to emit sidecar event: {e}");
                                }
                            }
                            Err(e) => {
                                log::warn!("sidecar emitted non-JSON line: {e}: {trimmed}");
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::error!("sidecar stdout read error: {e}");
                        break;
                    }
                }
            }
            // The sidecar exited. Clear state so the next command tries to respawn.
            let mut guard = state.inner.lock().await;
            guard.child = None;
            guard.stdin = None;
            guard.ready = false;
            log::warn!("sidecar process ended");
            let _ = app.emit(
                SIDECAR_EVENT,
                serde_json::json!({ "type": "sidecar_exited" }),
            );
        });
    }

    // Forward stderr to the parent log so users can debug install issues.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("[sidecar.stderr] {line}");
        }
    });

    Ok(())
}

/// Run PreToolUse hooks against a `permission_request` event from the
/// sidecar. If any hook blocks, write a `permission_response` (deny) back to
/// the sidecar without involving the frontend. Otherwise forward the event
/// onward as usual so the user / approval store handles it.
async fn handle_permission_request(app: AppHandle, state: SidecarState, value: Value) {
    let session_id = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let request_id = value
        .get("requestId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let tool_name = value
        .get("toolName")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_default();
    let input = value.get("input").cloned().unwrap_or(Value::Null);

    // Hook config: read fresh per request so the user can edit settings without
    // restarting the sidecar. Read is cheap (one or two small JSON files).
    // Project/local-scope hooks load only for the session's trusted cwd.
    let raw_cwd = state.session_cwd(&session_id).await;
    let cwd = hooks::trust::resolve_trusted_cwd(raw_cwd.as_deref());
    let settings = hooks::load_effective_settings(cwd.as_deref());

    // PermissionRequest is the observational sibling of PreToolUse — fire it so
    // plugins/hooks can audit every gate, regardless of the allow/deny outcome.
    let pr = hooks::run_tool_scoped(
        &settings,
        hooks::HookEvent::PermissionRequest,
        &session_id,
        cwd.as_deref(),
        &tool_name,
        json!({ "tool_name": tool_name, "tool_input": input }),
    )
    .await;
    emit_hook_diagnostics(&app, hooks::HookEvent::PermissionRequest, &pr);

    let decision =
        hooks::run_pre_tool_use(&settings, &session_id, cwd.as_deref(), &tool_name, &input).await;

    for w in &decision.warnings {
        log::warn!("PreToolUse[{tool_name}]: {w}");
    }

    if let Some(reason) = decision.block {
        let payload = json!({
          "type": "permission_response",
          "sessionId": session_id,
          "requestId": request_id,
          "decision": "deny",
          "message": format!("hook denied: {reason}"),
        });
        if let Err(e) = state.write_command(&payload).await {
            log::error!("failed to write hook deny: {e}");
        }
        // Emit a compact log to the frontend so the user sees that a tool was
        // blocked silently — they would otherwise see no UI at all.
        let _ = app.emit(
            SIDECAR_EVENT,
            &json!({
              "type": "log",
              "level": "info",
              "message": format!("PreToolUse hook denied {tool_name}: {reason}"),
            }),
        );
        // PermissionDenied fires after a hook-driven deny.
        let denied = hooks::run_tool_scoped(
            &settings,
            hooks::HookEvent::PermissionDenied,
            &session_id,
            cwd.as_deref(),
            &tool_name,
            json!({ "tool_name": tool_name, "reason": reason }),
        )
        .await;
        emit_hook_diagnostics(&app, hooks::HookEvent::PermissionDenied, &denied);
        return;
    }

    // No block — forward to the frontend so the normal approval flow can run.
    if let Err(e) = app.emit(SIDECAR_EVENT, &value) {
        log::error!("failed to emit permission_request: {e}");
    }
}

/// Log a hook's warnings and surface any `additionalContext` it contributed as
/// a compact frontend log line. Observational lifecycle hooks can't re-inject
/// context mid-stream, so this is how the user sees a hook did something.
fn emit_hook_diagnostics(app: &AppHandle, event: hooks::HookEvent, decision: &hooks::HookDecision) {
    let name = hooks::hook_event_name(event);
    for w in &decision.warnings {
        log::warn!("{name}: {w}");
    }
    if let Some(ctx) = &decision.additional_context {
        let _ = app.emit(
            SIDECAR_EVENT,
            &json!({
              "type": "log",
              "level": "info",
              "message": format!("{name} hook context: {ctx}"),
            }),
        );
    }
}

/// Observe one SDK-stream message and fire the matching settings.json lifecycle
/// hooks for the built-in agent. Records in-flight tool_use blocks, correlates
/// tool_result → PostToolUse(/Failure), then fires the stateless lifecycle
/// hooks (SessionStart/End, Stop, SubagentStop, Notification, PostCompact,
/// Task*). All firing is observational — blocking stays on the permission path.
async fn observe_hooks(app: AppHandle, state: SidecarState, value: Value) {
    let session_id = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    // tool_use blocks were already recorded inline by the reader (see
    // `record_tool_uses_from_message`) so the take below resolves reliably.

    // Resolve the session's trusted cwd once for every fire below.
    let raw_cwd = state.session_cwd(&session_id).await;
    let cwd = hooks::trust::resolve_trusted_cwd(raw_cwd.as_deref());

    // PostToolUse / PostToolUseFailure from tool_result blocks.
    if let Some(evt) = value.get("event") {
        let results = hooks::extract_tool_results(evt);
        for (tool_use_id, is_error, result) in results {
            let Some((tool_name, input)) = state.take_tool(&session_id, &tool_use_id).await else {
                continue; // No recorded tool_use (e.g. resumed session) — skip.
            };
            let event = if is_error {
                hooks::HookEvent::PostToolUseFailure
            } else {
                hooks::HookEvent::PostToolUse
            };
            let settings = hooks::load_effective_settings(cwd.as_deref());
            let fields = json!({
                "tool_name": tool_name,
                "tool_input": input,
                "tool_response": result,
                "is_error": is_error,
            });
            let decision = hooks::run_tool_scoped(
                &settings,
                event,
                &session_id,
                cwd.as_deref(),
                &tool_name,
                fields,
            )
            .await;
            emit_hook_diagnostics(&app, event, &decision);
        }
    }

    // Stateless lifecycle hooks.
    let classified = hooks::classify_sidecar_message(&value);
    if !classified.is_empty() {
        let settings = hooks::load_effective_settings(cwd.as_deref());
        for ch in classified {
            let decision = hooks::run_session_scoped(
                &settings,
                ch.event,
                &session_id,
                cwd.as_deref(),
                ch.fields,
            )
            .await;
            emit_hook_diagnostics(&app, ch.event, &decision);
        }
    }

    // Tear down per-session hook state when the session ends.
    if value.get("type").and_then(|v| v.as_str()) == Some("session_ended") {
        state.clear_session(&session_id).await;
    }
}

/// Stop the running sidecar (drop stdin, kill the child). The next
/// `claude_send` will respawn it. Safe to call when no sidecar is running.
pub async fn kill_sidecar(state: SidecarState) {
    let mut guard = state.inner.lock().await;
    // Closing stdin first lets the sidecar exit cleanly (its stdin EOF handler
    // tears down active sessions). If that doesn't work, kill_on_drop handles
    // the rest when we drop the Child below.
    guard.stdin.take();
    if let Some(mut child) = guard.child.take() {
        if let Err(e) = child.start_kill() {
            log::warn!("kill sidecar failed: {e}");
        }
        // Don't wait — the stdout reader task will observe EOF and clean up.
    }
    guard.ready = false;
}
