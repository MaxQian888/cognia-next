//! Desktop command shells for the shared sidecar command core.
use std::sync::Arc;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tracing::Instrument as _;
use super::host::TauriSidecarHost;
use super::sidecar::{spawn as spawn_sidecar, SidecarState};
pub use cognia_sidecar::commands::*;

/// Old-vs-new command telemetry: quantifies the remaining migration surface
/// (plan Phase 6 验收 / Phase 9 retirement evidence).
#[tauri::command]
pub async fn agent_command_telemetry() -> Result<serde_json::Value, String> {
    cognia_sidecar::commands::agent_command_telemetry().await
}

/// Canonical send. Requires a well-formed `options.execution` spec when one
/// is present (deep validation stays renderer-side; this guards skew).
#[tauri::command]
pub async fn agent_send(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    prompt: Value,
    options: Option<SendOptions>,
    command_id: Option<String>,
) -> Result<(), String> {
    if let Some(opts) = &options {
        if let Some(execution) = opts.extra.get("execution") {
            if !execution_spec_is_acceptable(execution) {
                return Err(
                    "agent_send: malformed execution spec (specVersion/runtimeAdapter)".into(),
                );
            }
            if execution_spec_names_external_runtime(execution) {
                return Err(
                    "agent_send: runtimeAdapter \"external\" is not served by the built-in \
                     sidecar; route this session through the external agent manager"
                        .into(),
                );
            }
        }
    }
    let span = tracing::info_span!("agent.send", session_id = %session_id);
    claude_send_with_host_and_id(
        Arc::new(TauriSidecarHost(app)),
        state.inner().clone(),
        session_id,
        prompt,
        options,
        command_id,
    )
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn agent_interrupt(
    state: State<'_, SidecarState>,
    session_id: String,
    command_id: Option<String>,
) -> Result<(), String> {
    claude_interrupt_impl_with_id(&state, session_id, command_id).await
}

#[tauri::command]
pub async fn agent_compact(
    state: State<'_, SidecarState>,
    session_id: String,
    focus: Option<String>,
    command_id: Option<String>,
) -> Result<(), String> {
    claude_compact_impl_with_id(&state, session_id, focus, command_id).await
}

#[tauri::command]
// These are stable, individually named fields in the renderer's invoke contract.
#[allow(clippy::too_many_arguments)]
pub async fn agent_resolve_permission(
    state: State<'_, SidecarState>,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
    updated_input: Option<Value>,
    command_id: Option<String>,
    // Deny only: end the turn instead of letting the model route around the
    // refusal. Absent means a plain refusal, which is the safe default.
    interrupt: Option<bool>,
) -> Result<(), String> {
    claude_approve_impl_with_id(
        &state,
        session_id,
        request_id,
        decision,
        message,
        updated_input,
        command_id,
        interrupt,
    )
    .await
}

#[tauri::command]
pub async fn agent_close_session(
    state: State<'_, SidecarState>,
    session_id: String,
    command_id: Option<String>,
) -> Result<(), String> {
    claude_close_session_impl_with_id(&state, session_id, command_id).await
}

#[tauri::command]
pub async fn agent_status(state: State<'_, SidecarState>) -> Result<SidecarStatus, String> {
    claude_sidecar_status_impl(&state).await
}

#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    state: State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    agent_start_with_host(Arc::new(TauriSidecarHost(app)), state.inner().clone()).await
}

/// Ensure the sidecar is running, then push a user message to it.
///
/// `prompt` may be a string or an array of content blocks (text + image)
/// — the value is forwarded verbatim to the sidecar, which forwards it to
/// the Claude Agent SDK.
#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, SidecarState>,
    session_id: String,
    prompt: Value,
    options: Option<SendOptions>,
) -> Result<(), String> {
    bump_deprecated("claude_send");
    let span = tracing::info_span!("claude.send", session_id = %session_id);
    #[cfg(feature = "otel-export")]
    crate::telemetry::set_parent(
        &span,
        options
            .as_ref()
            .and_then(|value| value.traceparent.as_deref()),
    );
    claude_send_with_host(
        Arc::new(TauriSidecarHost(app)),
        state.inner().clone(),
        session_id,
        prompt,
        options,
    )
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn claude_interrupt(
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<(), String> {
    bump_deprecated("claude_interrupt");
    claude_interrupt_impl(&state, session_id).await
}

/// Manually compact a session's context. Mirrors `claude_interrupt` — a control
/// message the sidecar's read loop routes to the session's `requestCompact`.
/// `focus` is the optional compact-instruction argument.
#[tauri::command]
pub async fn claude_compact(
    state: State<'_, SidecarState>,
    session_id: String,
    focus: Option<String>,
) -> Result<(), String> {
    bump_deprecated("claude_compact");
    claude_compact_impl(&state, session_id, focus).await
}

/// Undo a prior compaction by restoring the pre-compaction message snapshot.
/// Mirrors `claude_compact` — a fire-and-forget control message the sidecar's
/// read loop routes to the session's `restoreConversation` (generic path only).
#[tauri::command]
pub async fn claude_restore(
    state: State<'_, SidecarState>,
    session_id: String,
    messages: Value,
) -> Result<(), String> {
    bump_deprecated("claude_restore");
    claude_restore_impl(&state, session_id, messages).await
}

#[tauri::command]
pub async fn claude_set_mode(
    state: State<'_, SidecarState>,
    session_id: String,
    mode: String,
    command_id: Option<String>,
) -> Result<(), String> {
    claude_set_mode_impl_with_id(&state, session_id, mode, command_id).await
}

#[tauri::command]
pub async fn claude_approve(
    state: State<'_, SidecarState>,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    bump_deprecated("claude_approve");
    claude_approve_impl(
        &state,
        session_id,
        request_id,
        decision,
        message,
        updated_input,
    )
    .await
}

#[tauri::command]
pub async fn claude_close_session(
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<(), String> {
    bump_deprecated("claude_close_session");
    claude_close_session_impl(&state, session_id).await
}

/// Drive a live SDK `Query` control method on a session. Fire-and-forget over
/// stdin — the sidecar replies asynchronously with a `control_response` event
/// (correlated by `request_id`) that the renderer settles via
/// `lib/claude/ipc.ts:sessionControl`. Rejects an unknown method before it can
/// reach the sidecar.
#[tauri::command]
pub async fn claude_session_control(
    state: State<'_, SidecarState>,
    session_id: String,
    request_id: String,
    method: String,
    params: Option<Value>,
    command_id: Option<String>,
) -> Result<(), String> {
    bump_deprecated("claude_session_control");
    claude_session_control_impl(&state, session_id, request_id, method, params, command_id).await
}

/// Call a session-level SDK function. Fire-and-forget over stdin — the sidecar
/// replies asynchronously with a `session_api_response` event (correlated by
/// `request_id`) that the renderer settles via `lib/claude/ipc.ts:sessionApi`.
///
/// Unlike [`claude_session_control`] this spawns the sidecar if it is not
/// already up: these calls are the only way to reach a session's transcripts,
/// and requiring a live chat first would make session management unreachable
/// from Settings on a cold start.
#[tauri::command]
pub async fn agent_session_api(
    app: AppHandle,
    state: State<'_, SidecarState>,
    request_id: String,
    method: String,
    params: Option<Value>,
    send_options: Option<Value>,
) -> Result<(), String> {
    agent_session_api_impl(
        Arc::new(TauriSidecarHost(app)),
        state.inner().clone(),
        request_id,
        method,
        params,
        send_options,
    )
    .await
}

#[tauri::command]
pub async fn claude_feature_call(
    app: AppHandle,
    state: State<'_, SidecarState>,
    request: Value,
) -> Result<(), String> {
    spawn_sidecar(Arc::new(TauriSidecarHost(app)), state.inner().clone()).await?;
    state
        .write_command(&build_feature_call_payload(request)?)
        .await
}

#[tauri::command]
pub async fn claude_feature_abort(
    state: State<'_, SidecarState>,
    request_id: String,
) -> Result<(), String> {
    if request_id.is_empty() {
        return Err("feature call requestId must not be empty".into());
    }
    state
        .write_command(&json!({ "type": "feature_call_abort", "requestId": request_id }))
        .await
}

/// Renderer → sidecar: resolve a pending plugin-tool call so the sidecar's
/// `pendingPluginToolCalls` promise settles. Mirrors `claude_approve`.
/// Renderer-only — NOT exposed via companion RPC (plugin tools execute on the
/// desktop host, never the phone).
#[tauri::command]
pub async fn claude_plugin_tool_response(
    state: State<'_, SidecarState>,
    session_id: String,
    tool_use_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    claude_plugin_tool_response_impl(&state, session_id, tool_use_id, result, error).await
}

/// Renderer → sidecar: resolve a pending `{ type: "plugin" }` lifecycle-hook
/// round-trip so the sidecar's `pendingPluginHookCalls` promise settles.
///
/// The outbound half needs no command: `plugin_hook_exec` falls through the
/// sidecar reader's default branch onto `SIDECAR_EVENT` like any other frame.
/// Only the answer needs a way back into stdin, and that mirrors
/// `claude_plugin_tool_response` exactly.
///
/// Renderer-only — plugin hooks execute in the desktop renderer, never on the
/// phone, so this is deliberately NOT exposed over companion RPC.
#[tauri::command]
pub async fn claude_plugin_hook_response(
    state: State<'_, SidecarState>,
    session_id: String,
    exec_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let payload = build_plugin_hook_response_payload(session_id, exec_id, result, error);
    state.write_command(&payload).await
}

/// Renderer → sidecar: answer a `tool_result_review` (the plugin Agent SDK's
/// PostToolUse rewrite) so the sidecar's `pendingToolResultReviews` promise
/// settles. `updated_tool_output` rewrites the output the model sees; `None`
/// leaves it unchanged. Mirrors `claude_approve`. Renderer-only — tool output
/// review runs on the desktop host, never the phone.
#[tauri::command]
pub async fn claude_tool_result_decision(
    state: State<'_, SidecarState>,
    session_id: String,
    review_id: String,
    updated_tool_output: Option<Value>,
) -> Result<(), String> {
    claude_tool_result_decision_impl(&state, session_id, review_id, updated_tool_output).await
}

/// Renderer → sidecar: answer a Router + Fusion `call_reserve_request`
/// (ADR-0188) so the sidecar's pending reservation settles. The renderer is the
/// ledger's only writer; the sidecar sends a model call only after `granted`.
/// Mirrors `claude_tool_result_decision`. Renderer-only — the ledger lives in
/// the desktop renderer's fusion database, never on a paired phone.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn claude_call_reserve_decision(
    state: State<'_, SidecarState>,
    session_id: String,
    request_id: String,
    decision: String,
    attempt_id: Option<String>,
    attempt_no: Option<u32>,
    code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    claude_call_reserve_decision_impl(
        &state, session_id, request_id, decision, attempt_id, attempt_no, code, message,
    )
    .await
}

/// Forward a `protocol_adapter_{chunk,done,error}` line to the sidecar stdin
/// (P2-E code-adapter round-trip). The renderer builds the full message; we
/// only validate the type prefix so this can't be used as a generic
/// stdin-injection vector. Renderer-only — plugin code adapters run on the
/// desktop host, never the phone.
#[tauri::command]
pub async fn claude_protocol_adapter_message(
    state: State<'_, SidecarState>,
    message: Value,
) -> Result<(), String> {
    claude_protocol_adapter_message_impl(&state, message).await
}

#[tauri::command]
pub async fn claude_sidecar_status(
    state: State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    bump_deprecated("claude_sidecar_status");
    claude_sidecar_status_impl(&state).await
}

/// ADR-0028 Phase 14 — sidecar restart counter for the Diagnostics
/// → Sidecar card. Returns the number of times `spawn_sidecar` has
/// completed since the app booted. Read-only, no side effects.
#[tauri::command]
pub async fn sidecar_restart_count(state: State<'_, SidecarState>) -> Result<u64, String> {
    Ok(state.restart_count())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn agent_start_with_host_waits_until_the_sidecar_is_ready() {
        use crate::claude::host::test_support::RecordingSidecarHost;

        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }

        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("ready-host.mjs");
        std::fs::write(
            &script,
            concat!(
                "setTimeout(() => process.stdout.write(JSON.stringify({type:'ready'})+'\\n'), 50);\n",
                "process.stdin.resume();\n",
            ),
        )
        .expect("write ready script");

        let node = crate::external_agent::command_resolver::resolve_command_path("node")
            .expect("node path after availability probe");
        let host = RecordingSidecarHost::with_script_and_node(script, node);
        let state = SidecarState::new();
        crate::proxy_config::apply_current(Default::default())
            .expect("test sidecar must start with an explicit direct proxy policy");

        let status = agent_start_with_host(host, state.clone())
            .await
            .expect("agent_start must wait for the ready frame");

        assert!(status.ready);
        assert!(state.is_ready().await);
        assert_eq!(state.restart_count(), 1);
        super::super::sidecar::kill_sidecar(state).await;
    }

    #[tokio::test]
    async fn agent_start_with_host_reports_an_exit_before_ready() {
        use crate::claude::host::test_support::RecordingSidecarHost;

        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }

        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("exiting-host.mjs");
        std::fs::write(&script, "process.exit(0);\n").expect("write exiting script");
        let node = crate::external_agent::command_resolver::resolve_command_path("node")
            .expect("node path after availability probe");
        let host = RecordingSidecarHost::with_script_and_node(script, node);
        let state = SidecarState::new();
        crate::proxy_config::apply_current(Default::default())
            .expect("test sidecar must start with an explicit direct proxy policy");

        let error = agent_start_with_host(host, state)
            .await
            .expect_err("a sidecar that exits without ready must fail startup");

        assert_eq!(error, "sidecar exited before becoming ready");
    }

    /// R7 acceptance: `claude_send_with_host` on a host-generic (recording)
    /// host spawns a real `node` echo script and the send payload round-trips
    /// through the sidecar reader back out as a host event. Skips gracefully
    /// when Node is not installed.
    #[tokio::test]
    // The synchronous guard serializes process-global wake assertions for the
    // entire asynchronous integration scenario.
    #[allow(clippy::await_holding_lock)]
    async fn claude_send_with_host_reaches_a_fake_echo_script() {
        use crate::claude::host::test_support::RecordingSidecarHost;
        use crate::power_assertion::{active_reasons, WakeReason, ASSERTION_TEST_LOCK};

        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }

        let _assertion_guard = ASSERTION_TEST_LOCK.lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("echo-host.mjs");
        std::fs::write(
            &script,
            concat!(
                "process.stdout.write(JSON.stringify({type:'ready'})+'\\n');\n",
                "process.stdin.setEncoding('utf8');\n",
                "let buf='';\n",
                "process.stdin.on('data',(d)=>{buf+=d;let i;\n",
                "  while((i=buf.indexOf('\\n'))>=0){\n",
                "    const line=buf.slice(0,i);buf=buf.slice(i+1);\n",
                "    if(!line.trim())continue;\n",
                "    process.stdout.write(JSON.stringify({type:'echo',payload:JSON.parse(line)})+'\\n');\n",
                "  }});\n",
                "process.stdin.on('end',()=>process.exit(0));\n",
            ),
        )
        .expect("write echo script");

        #[cfg(unix)]
        let (host, node_marker) = {
            use std::os::unix::fs::PermissionsExt;

            let node = crate::external_agent::command_resolver::resolve_command_path("node")
                .expect("node path after availability probe");
            let marker = tmp.path().join("bundled-node-used");
            let wrapper = tmp.path().join("bundled-node");
            let shell_quote =
                |path: &std::path::Path| path.to_string_lossy().replace('\'', "'\\''");
            std::fs::write(
                &wrapper,
                format!(
                    "#!/bin/sh\nprintf used > '{}'\nexec '{}' \"$@\"\n",
                    shell_quote(&marker),
                    shell_quote(&node)
                ),
            )
            .expect("write bundled-node wrapper");
            let mut permissions = std::fs::metadata(&wrapper)
                .expect("wrapper metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&wrapper, permissions).expect("make wrapper executable");
            (
                RecordingSidecarHost::with_script_and_node(script, wrapper),
                marker,
            )
        };
        #[cfg(not(unix))]
        let host = RecordingSidecarHost::with_script(script);
        let state = SidecarState::new();
        crate::proxy_config::apply_current(Default::default())
            .expect("test sidecar must start with an explicit direct proxy policy");
        let reason = WakeReason::ActiveRun("sess-echo".into());

        claude_send_with_host(
            host.clone(),
            state.clone(),
            "sess-echo".into(),
            json!("hello from headless"),
            None,
        )
        .await
        .expect("send must spawn + write");

        // The echo script reflects the send command back; the reader emits it
        // as a host event on the sidecar channel.
        let mut echoed = None;
        for _ in 0..100 {
            if let Some((_, payload)) = host.events().into_iter().find(|(channel, payload)| {
                channel == super::super::sidecar::SIDECAR_EVENT && payload["type"] == "echo"
            }) {
                echoed = Some(payload);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let echoed = echoed.expect("echo event must arrive via the host");
        assert_eq!(echoed["payload"]["type"], "send");
        assert_eq!(echoed["payload"]["sessionId"], "sess-echo");
        assert_eq!(echoed["payload"]["prompt"], "hello from headless");
        assert!(active_reasons().contains(&reason));
        #[cfg(unix)]
        assert!(
            node_marker.is_file(),
            "the sidecar must use the Node executable resolved by its host"
        );

        super::super::sidecar::kill_sidecar(state).await;
        for _ in 0..50 {
            if !active_reasons().contains(&reason) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            !active_reasons().contains(&reason),
            "sidecar exit must release holds for its generation"
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn claude_send_holds_the_host_awake_until_the_turn_ends() {
        use crate::claude::host::test_support::RecordingSidecarHost;
        use crate::power_assertion::{active_reasons, WakeReason, ASSERTION_TEST_LOCK};

        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }

        let _assertion_guard = ASSERTION_TEST_LOCK.lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("terminal-event-host.mjs");
        std::fs::write(
            &script,
            concat!(
                "process.stdout.write(JSON.stringify({type:'ready'})+'\\n');\n",
                "process.stdin.setEncoding('utf8');\n",
                "let buf='';\n",
                "process.stdin.on('data',(d)=>{buf+=d;let i;\n",
                "  while((i=buf.indexOf('\\n'))>=0){\n",
                "    const line=buf.slice(0,i);buf=buf.slice(i+1);\n",
                "    if(!line.trim())continue;\n",
                "    const command=JSON.parse(line);\n",
                "    if(command.type==='send'){\n",
                "      setTimeout(()=>process.stdout.write(JSON.stringify({type:'session_ended',sessionId:command.sessionId})+'\\n'),250);\n",
                "    }\n",
                "  }});\n",
                "process.stdin.on('end',()=>process.exit(0));\n",
            ),
        )
        .expect("write terminal-event script");

        let node = crate::external_agent::command_resolver::resolve_command_path("node")
            .expect("node path after availability probe");
        let host = RecordingSidecarHost::with_script_and_node(script, node);
        let state = SidecarState::new();
        crate::proxy_config::apply_current(Default::default())
            .expect("test sidecar must start with an explicit direct proxy policy");
        let reason = WakeReason::ActiveRun("sess-awake".into());

        claude_send_with_host(
            host,
            state.clone(),
            "sess-awake".into(),
            json!("keep working"),
            None,
        )
        .await
        .expect("send must spawn + write");

        let held_during_turn = active_reasons().contains(&reason);
        if !held_during_turn {
            super::super::sidecar::kill_sidecar(state).await;
            panic!("an accepted agent turn must keep the host awake");
        }

        for _ in 0..50 {
            if !active_reasons().contains(&reason) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let released_after_turn = !active_reasons().contains(&reason);
        super::super::sidecar::kill_sidecar(state).await;
        assert!(
            released_after_turn,
            "session_ended must release the agent turn's wake assertion"
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn duplicate_send_ack_releases_only_the_retry_hold() {
        use crate::claude::host::test_support::RecordingSidecarHost;
        use crate::power_assertion::{active_reasons, WakeReason, ASSERTION_TEST_LOCK};

        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }

        let _assertion_guard = ASSERTION_TEST_LOCK.lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        let script = tmp.path().join("duplicate-send-host.mjs");
        std::fs::write(
            &script,
            concat!(
                "process.stdout.write(JSON.stringify({type:'ready'})+'\\n');\n",
                "process.stdin.setEncoding('utf8');\n",
                "const seen=new Set();let buf='';\n",
                "process.stdin.on('data',(d)=>{buf+=d;let i;\n",
                "  while((i=buf.indexOf('\\n'))>=0){\n",
                "    const line=buf.slice(0,i);buf=buf.slice(i+1);\n",
                "    if(!line.trim())continue;const command=JSON.parse(line);\n",
                "    if(command.type!=='send')continue;\n",
                "    if(seen.has(command.commandId)){\n",
                "      process.stdout.write(JSON.stringify({type:'command_ack',sessionId:command.sessionId,commandId:command.commandId,duplicate:true})+'\\n');\n",
                "    }else{seen.add(command.commandId);\n",
                "      setTimeout(()=>process.stdout.write(JSON.stringify({type:'session_ended',sessionId:command.sessionId})+'\\n'),250);\n",
                "    }\n",
                "  }});\n",
                "process.stdin.on('end',()=>process.exit(0));\n",
            ),
        )
        .expect("write duplicate-send script");

        let node = crate::external_agent::command_resolver::resolve_command_path("node")
            .expect("node path after availability probe");
        let host = RecordingSidecarHost::with_script_and_node(script, node);
        let state = SidecarState::new();
        crate::proxy_config::apply_current(Default::default())
            .expect("test sidecar must start with an explicit direct proxy policy");
        let reason = WakeReason::ActiveRun("sess-retry".into());

        for _ in 0..2 {
            claude_send_with_host_and_id(
                host.clone(),
                state.clone(),
                "sess-retry".into(),
                json!("retry-safe"),
                None,
                Some("cmd-retry".into()),
            )
            .await
            .expect("both writes reach the sidecar");
        }

        for _ in 0..50 {
            if !active_reasons().contains(&reason) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let duplicate_ack_seen = host
            .events()
            .into_iter()
            .any(|(_, payload)| payload["type"] == "command_ack" && payload["duplicate"] == true);
        let released_after_original_turn = !active_reasons().contains(&reason);
        super::super::sidecar::kill_sidecar(state).await;

        assert!(duplicate_ack_seen, "the retry must exercise duplicate ack");
        assert!(
            released_after_original_turn,
            "one terminal event plus one duplicate ack must balance both holds"
        );
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn failed_send_write_rolls_back_the_wake_hold() {
        use crate::power_assertion::{active_reasons, WakeReason, ASSERTION_TEST_LOCK};

        let _assertion_guard = ASSERTION_TEST_LOCK.lock();
        let state = SidecarState::new();
        let reason = WakeReason::ActiveRun("sess-write-fails".into());
        let error = write_active_run_command(
            &state,
            &json!({ "type": "send", "sessionId": "sess-write-fails" }),
            "sess-write-fails",
            Some("cmd-write-fails"),
        )
        .await
        .expect_err("missing sidecar stdin must reject the write");

        assert_eq!(error, "sidecar not running");
        assert!(!active_reasons().contains(&reason));
    }

}
