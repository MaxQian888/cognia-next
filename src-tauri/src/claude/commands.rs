use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::host::{SidecarHost, TauriSidecarHost};
use super::sidecar::{emit_hook_fire, spawn as spawn_sidecar, SidecarState};
use crate::hooks;

/// Options the frontend can pass per-send. Mirrors a subset of the SDK's
/// `Options` shape — anything we don't recognise is forwarded verbatim.
///
/// All fields are skipped on serialization when `None` so the sidecar (and
/// downstream SDK) sees `undefined`/missing rather than `null`. Passing
/// `null` for `systemPrompt` etc. trips a `Cannot read properties of null`
/// crash inside the SDK's option parser.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Dynamic system-prompt tail. The sidecar folds this together with
    /// `system_prompt` (the stable base) into the SDK's typed
    /// `systemPrompt: string | string[]` shape, so the two can be set together.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_directories: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    /// Per-name MCP server config map, forwarded verbatim to the SDK.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<std::collections::HashMap<String, Value>>,
    /// Hard cap on agentic turns inside a single SDK invocation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// Forward partial-message stream events (requires SDK streaming mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_partial_messages: Option<bool>,
    /// Which on-disk settings sources the SDK loads — subset of
    /// `["user", "project", "local"]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting_sources: Option<Vec<String>>,
    /// Dynamic subagent definitions keyed by name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agents: Option<std::collections::HashMap<String, Value>>,
    /// When true, only `mcp_servers` from this options blob are loaded; the SDK
    /// does not auto-discover others from settings.json.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict_mcp_config: Option<bool>,
    /// SDK effort level (`low|medium|high|xhigh|max`). Forwarded verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Resume an existing SDK session by id. Mutually exclusive with
    /// `fork_from_session_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    /// Fork a new branch from an existing SDK session id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_from_session_id: Option<String>,

    // ---- Provider routing (multi-provider port) -----------------------------
    /// Provider id this turn dispatches against. `None` (or `"anthropic"`)
    /// keeps the legacy Claude Agent SDK path; any other value flows through
    /// `sidecar/dispatch/ai-sdk.mjs` (P2). Built-ins: `anthropic`, `openai`,
    /// `google`, `mistral`, `cohere`, `openrouter`. Custom provider ids also
    /// accepted (their AI SDK protocol arrives in `provider_credentials`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Per-call credentials. Travels with the request so the sidecar never
    /// reads keys from disk. `protocol` is the AI SDK family for non-built-in
    /// provider ids (`"openai"|"anthropic"|"google"|"mistral"|"cohere"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_credentials: Option<ProviderCredentials>,
    /// Alias resolution metadata. Sidecar ignores this — it's surfaced for
    /// renderer-side fallback retries + the routing-decision badge in
    /// message metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_resolution: Option<Value>,
    /// Routing strategy + reason. Sidecar passes verbatim back to the renderer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_decision: Option<Value>,

    /// Catch-all for forward-compatibility: any extra fields are merged into
    /// the JSON payload sent to the sidecar.
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, Value>,
}

/// Per-call provider credentials. Sent inline with the request rather than
/// looked up from disk so the sidecar can stay credential-free.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentials {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// AI SDK protocol family: one of `"openai"`, `"anthropic"`, `"google"`,
    /// `"mistral"`, `"cohere"`. Required when `provider` is a custom id; for
    /// built-in providers the sidecar derives the protocol from the id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// Explicit OpenAI endpoint family: `"auto"` | `"responses"` | `"chat"`.
    /// Overrides the sidecar's host heuristic so the Responses API can be used
    /// on Azure OpenAI, on compatible gateways that proxy `/responses`, and on
    /// custom base URLs. Like `headers`, it MUST round-trip this strictly-typed
    /// boundary or the sidecar's `decideOpenAiEndpointFlavor` never sees it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_flavor: Option<String>,
    /// Extra default headers forwarded to the provider client. Used by the
    /// Codex ChatGPT-login path (`ChatGPT-Account-Id`, `OpenAI-Beta`,
    /// `originator`, `OAI-Product-Sku`). Must round-trip the boundary so the
    /// sidecar can attach them — a strictly-typed struct would otherwise drop
    /// them silently.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

impl SendOptions {
    /// Validate field combinations the SDK will reject anyway. Surfacing the
    /// error here gives a clean message instead of a parser crash inside Node.
    fn validate(&self) -> Result<(), String> {
        // NOTE: `system_prompt` + `append_system_prompt` are NOT mutually
        // exclusive. The Agent SDK 0.3.183 migration dropped the top-level
        // `appendSystemPrompt` option, so the sidecar now folds the two into the
        // typed `systemPrompt: string | string[]` form (`foldSystemPrompt` on the
        // anthropic path, concatenation on the ai-sdk path). `resolveSendOptions`
        // routinely sets both — a base/character/twin system prompt plus a
        // dynamic appended section (brief/plan mode, output style, A2UI, sandbox
        // hint, goal/branch context seed) — so rejecting both-set broke every
        // such turn at this boundary before it could reach the sidecar.
        if self.resume_session_id.is_some() && self.fork_from_session_id.is_some() {
            return Err("resumeSessionId and forkFromSessionId are mutually exclusive".into());
        }
        if let Some(turns) = self.max_turns {
            if turns == 0 || turns > 100 {
                return Err("maxTurns must be in 1..=100".into());
            }
        }
        if let Some(sources) = self.setting_sources.as_ref() {
            for s in sources {
                if !matches!(s.as_str(), "user" | "project" | "local") {
                    return Err(format!("invalid settingSources entry: {s}"));
                }
            }
        }
        // Provider id is otherwise free-form (custom providers are allowed)
        // but an empty string is always wrong.
        if let Some(p) = self.provider.as_ref() {
            if p.is_empty() {
                return Err("provider must not be empty".into());
            }
        }
        // The AI SDK protocol field, when present, must name a family the
        // sidecar's dispatch table knows about.
        if let Some(creds) = self.provider_credentials.as_ref() {
            if let Some(proto) = creds.protocol.as_ref() {
                if !matches!(
                    proto.as_str(),
                    "openai" | "anthropic" | "google" | "mistral" | "cohere" | "azure" | "bedrock"
                ) {
                    return Err(format!("invalid providerCredentials.protocol: {proto}"));
                }
            }
            if let Some(flavor) = creds.api_flavor.as_ref() {
                if !matches!(flavor.as_str(), "auto" | "responses" | "chat") {
                    return Err(format!("invalid providerCredentials.apiFlavor: {flavor}"));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct SidecarStatus {
    pub ready: bool,
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
    claude_send_with_host(
        Arc::new(TauriSidecarHost(app)),
        state.inner().clone(),
        session_id,
        prompt,
        options,
    )
    .await
}

/// Host-generic body of [`claude_send`] (ADR-0059 R6). The desktop command
/// wraps the `AppHandle` in a [`TauriSidecarHost`]; the headless RPC arm (R7)
/// passes the `HeadlessSidecarHost` from the services registry.
pub async fn claude_send_with_host(
    host: Arc<dyn SidecarHost>,
    state: SidecarState,
    session_id: String,
    prompt: Value,
    options: Option<SendOptions>,
) -> Result<(), String> {
    let _perf = crate::perf::guard("claude.send");
    spawn_sidecar(Arc::clone(&host), state.clone()).await?;
    let opts_value = match options {
        Some(o) => {
            o.validate()?;
            serde_json::to_value(o).map_err(|e| e.to_string())?
        }
        None => Value::Object(Default::default()),
    };

    // ---- UserPromptSubmit hooks ---------------------------------------------
    // Run before the prompt reaches the SDK so a hook can short-circuit the
    // turn entirely. The hook receives the raw prompt + cwd; if it blocks, we
    // surface the reason as the IPC error. AdditionalContext is appended via
    // an `appendSystemPrompt`-style merge — it lands in front of the user
    // message rather than the system prompt because that matches the CLI's
    // documented semantics for UserPromptSubmit.
    let cwd = opts_value
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(String::from);
    // Remember the send-time cwd so the sidecar's lifecycle-hook observer can
    // resolve project/local-scope settings for this session's later events.
    state.register_session_cwd(&session_id, cwd.clone()).await;
    let prompt_text = extract_prompt_text(&prompt);
    let mut prompt = prompt;
    if !prompt_text.is_empty() {
        // Project/local hooks load only for a trusted cwd; untrusted → user scope.
        let trusted_cwd = hooks::trust::resolve_trusted_cwd(cwd.as_deref());
        let settings = hooks::load_effective_settings(trusted_cwd.as_deref());
        let decision = hooks::run_user_prompt_submit(
            &settings,
            &session_id,
            trusted_cwd.as_deref(),
            &prompt_text,
        )
        .await;
        // Surface a consequential UserPromptSubmit fire as a hook row before the
        // decision fields are consumed below (block short-circuits the turn,
        // additional_context is folded into the prompt).
        emit_hook_fire(
            host.as_ref(),
            &session_id,
            &hooks::hook_event_name(hooks::HookEvent::UserPromptSubmit),
            None,
            &decision,
        );
        if let Some(reason) = decision.block {
            return Err(format!("hook blocked: {reason}"));
        }
        if let Some(extra) = decision.additional_context {
            prompt = prepend_context_to_prompt(&prompt, &extra);
        }
        for w in decision.warnings {
            log::warn!("UserPromptSubmit: {w}");
        }
    }

    let msg = json!({
      "type": "send",
      "sessionId": session_id,
      "prompt": prompt,
      "options": opts_value,
    });
    state.write_command(&msg).await
}

/// Extract a flat text representation of `prompt` for hook payloads. Strings
/// pass through; arrays of content blocks are joined on the `text` blocks.
fn extract_prompt_text(prompt: &Value) -> String {
    if let Some(s) = prompt.as_str() {
        return s.to_string();
    }
    if let Some(arr) = prompt.as_array() {
        let mut buf = String::new();
        for block in arr {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t);
                }
            }
        }
        return buf;
    }
    String::new()
}

/// Prepend hook-supplied additional context to a prompt. For string prompts
/// we wrap the context in an `<additional-context>` block so the model can
/// treat it as a system-style insertion. For multimodal prompts we insert a
/// new text block at index 0.
fn prepend_context_to_prompt(prompt: &Value, extra: &str) -> Value {
    let wrapped = format!("<additional-context>\n{}\n</additional-context>\n\n", extra);
    if let Some(s) = prompt.as_str() {
        return Value::String(format!("{wrapped}{s}"));
    }
    if let Some(arr) = prompt.as_array() {
        let mut blocks: Vec<Value> = vec![json!({
          "type": "text",
          "text": wrapped.trim_end().to_string(),
        })];
        blocks.extend(arr.iter().cloned());
        return Value::Array(blocks);
    }
    prompt.clone()
}

// ---------------------------------------------------------------------------
// Host-generic command bodies (ADR-0059 R7)
//
// The RPC dispatch arms resolve a `SidecarState` from either the Tauri app or
// the headless services registry and call these `_impl` functions; the
// `#[tauri::command]` wrappers delegate so desktop behavior is unchanged.
// ---------------------------------------------------------------------------

pub async fn claude_interrupt_impl(state: &SidecarState, session_id: String) -> Result<(), String> {
    let msg = json!({ "type": "interrupt", "sessionId": session_id });
    state.write_command(&msg).await
}

pub async fn claude_compact_impl(
    state: &SidecarState,
    session_id: String,
    focus: Option<String>,
) -> Result<(), String> {
    let msg = json!({ "type": "compact", "sessionId": session_id, "focus": focus });
    state.write_command(&msg).await
}

pub async fn claude_approve_impl(
    state: &SidecarState,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    let valid = matches!(decision.as_str(), "allow" | "allow_always" | "deny");
    if !valid {
        return Err(format!("invalid decision: {decision}"));
    }
    let payload = json!({
      "type": "permission_response",
      "sessionId": session_id,
      "requestId": request_id,
      "decision": decision,
      "message": message,
      "updatedInput": updated_input,
    });
    state.write_command(&payload).await
}

pub async fn claude_close_session_impl(
    state: &SidecarState,
    session_id: String,
) -> Result<(), String> {
    let msg = json!({ "type": "close", "sessionId": session_id });
    state.write_command(&msg).await
}

pub async fn claude_sidecar_status_impl(state: &SidecarState) -> Result<SidecarStatus, String> {
    Ok(SidecarStatus {
        ready: state.is_ready().await,
    })
}

#[tauri::command]
pub async fn claude_interrupt(
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<(), String> {
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
    let msg = json!({ "type": "restore", "sessionId": session_id, "messages": messages });
    state.write_command(&msg).await
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
    claude_close_session_impl(&state, session_id).await
}

/// Allowlisted Claude Agent SDK `Query` control methods the renderer may drive
/// on a live session (streaming-input-only methods — see `sidecar/dispatch/
/// control.mjs`). Defense-in-depth: the same allowlist is enforced in the
/// sidecar, but rejecting here too means a bad `method` never reaches stdin.
pub fn is_allowed_control_method(method: &str) -> bool {
    matches!(
        method,
        "getContextUsage"
            | "mcpServerStatus"
            | "reconnectMcpServer"
            | "toggleMcpServer"
            | "supportedModels"
            | "supportedCommands"
            | "setModel"
    )
}

/// Build the `control` JSON line written to the sidecar stdin. Pure so it is
/// unit-testable without a running sidecar.
fn build_session_control_payload(
    session_id: String,
    request_id: String,
    method: String,
    params: Option<Value>,
) -> Value {
    json!({
        "type": "control",
        "sessionId": session_id,
        "requestId": request_id,
        "method": method,
        "params": params,
    })
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
) -> Result<(), String> {
    if !is_allowed_control_method(&method) {
        return Err(format!("unsupported control method: {method}"));
    }
    let payload = build_session_control_payload(session_id, request_id, method, params);
    state.write_command(&payload).await
}

/// Build the `plugin_tool_response` JSON line written to the sidecar stdin.
/// Pure so it is unit-testable without a running sidecar.
fn build_plugin_tool_response_payload(
    session_id: String,
    tool_use_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Value {
    json!({
      "type": "plugin_tool_response",
      "sessionId": session_id,
      "toolUseId": tool_use_id,
      "result": result,
      "error": error,
    })
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
    let payload = build_plugin_tool_response_payload(session_id, tool_use_id, result, error);
    state.write_command(&payload).await
}

/// Build the `tool_result_decision` JSON line written to the sidecar stdin.
/// Pure so it is unit-testable without a running sidecar.
fn build_tool_result_decision_payload(
    session_id: String,
    review_id: String,
    updated_tool_output: Option<Value>,
) -> Value {
    json!({
      "type": "tool_result_decision",
      "sessionId": session_id,
      "reviewId": review_id,
      "updatedToolOutput": updated_tool_output,
    })
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
    let payload = build_tool_result_decision_payload(session_id, review_id, updated_tool_output);
    state.write_command(&payload).await
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
    let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        kind,
        "protocol_adapter_chunk" | "protocol_adapter_done" | "protocol_adapter_error"
    ) {
        return Err(format!("unexpected protocol adapter message type: {kind}"));
    }
    state.write_command(&message).await
}

#[tauri::command]
pub async fn claude_sidecar_status(
    state: State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    claude_sidecar_status_impl(&state).await
}

/// ADR-0028 Phase 14 — sidecar restart counter for the Diagnostics
/// → Sidecar card. Returns the number of times `spawn_sidecar` has
/// completed since the app booted. Read-only, no side effects.
#[tauri::command]
pub async fn sidecar_restart_count(state: State<'_, SidecarState>) -> Result<u64, String> {
    Ok(state.restart_count())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json_str: &str) -> SendOptions {
        serde_json::from_str(json_str).expect("valid SendOptions JSON")
    }

    /// R7 acceptance: `claude_send_with_host` on a host-generic (recording)
    /// host spawns a real `node` echo script and the send payload round-trips
    /// through the sidecar reader back out as a host event. Skips gracefully
    /// when Node is not installed.
    #[tokio::test]
    async fn claude_send_with_host_reaches_a_fake_echo_script() {
        use crate::claude::host::test_support::RecordingSidecarHost;

        if !crate::external_agent::command_resolver::check_command_exists("node") {
            eprintln!("skip: node not on PATH");
            return;
        }

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

        let host = RecordingSidecarHost::with_script(script);
        let state = SidecarState::new();

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
            if let Some((_, payload)) = host
                .events()
                .into_iter()
                .find(|(channel, payload)| {
                    channel == super::super::sidecar::SIDECAR_EVENT && payload["type"] == "echo"
                })
            {
                echoed = Some(payload);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let echoed = echoed.expect("echo event must arrive via the host");
        assert_eq!(echoed["payload"]["type"], "send");
        assert_eq!(echoed["payload"]["sessionId"], "sess-echo");
        assert_eq!(echoed["payload"]["prompt"], "hello from headless");

        super::super::sidecar::kill_sidecar(state).await;
    }

    #[test]
    fn builds_plugin_tool_response_payload_with_result() {
        let p =
            build_plugin_tool_response_payload("s1".into(), "t1".into(), Some(json!("ok")), None);
        assert_eq!(p["type"], "plugin_tool_response");
        assert_eq!(p["sessionId"], "s1");
        assert_eq!(p["toolUseId"], "t1");
        assert_eq!(p["result"], json!("ok"));
        assert!(p["error"].is_null());
    }

    #[test]
    fn builds_plugin_tool_response_payload_with_error() {
        let p =
            build_plugin_tool_response_payload("s1".into(), "t1".into(), None, Some("boom".into()));
        assert_eq!(p["error"], "boom");
        assert!(p["result"].is_null());
    }

    #[test]
    fn allows_only_known_control_methods() {
        for m in [
            "getContextUsage",
            "mcpServerStatus",
            "reconnectMcpServer",
            "toggleMcpServer",
            "supportedModels",
            "supportedCommands",
            "setModel",
        ] {
            assert!(is_allowed_control_method(m), "{m} should be allowed");
        }
        for m in [
            "close",
            "interrupt",
            "evalSync",
            "__proto__",
            "",
            "setModelX",
        ] {
            assert!(!is_allowed_control_method(m), "{m} should be rejected");
        }
    }

    #[test]
    fn builds_session_control_payload_with_params() {
        let p = build_session_control_payload(
            "s1".into(),
            "req1".into(),
            "setModel".into(),
            Some(json!({ "model": "claude-opus-4-8" })),
        );
        assert_eq!(p["type"], "control");
        assert_eq!(p["sessionId"], "s1");
        assert_eq!(p["requestId"], "req1");
        assert_eq!(p["method"], "setModel");
        assert_eq!(p["params"]["model"], "claude-opus-4-8");
    }

    #[test]
    fn builds_session_control_payload_without_params() {
        let p = build_session_control_payload(
            "s1".into(),
            "req2".into(),
            "getContextUsage".into(),
            None,
        );
        assert_eq!(p["method"], "getContextUsage");
        assert!(p["params"].is_null());
    }

    #[test]
    fn builds_tool_result_decision_payload_with_rewrite() {
        let p = build_tool_result_decision_payload(
            "s1".into(),
            "rev1".into(),
            Some(json!("CLEAN OUTPUT")),
        );
        assert_eq!(p["type"], "tool_result_decision");
        assert_eq!(p["sessionId"], "s1");
        assert_eq!(p["reviewId"], "rev1");
        assert_eq!(p["updatedToolOutput"], json!("CLEAN OUTPUT"));
    }

    #[test]
    fn builds_tool_result_decision_payload_without_rewrite() {
        let p = build_tool_result_decision_payload("s1".into(), "rev1".into(), None);
        assert_eq!(p["type"], "tool_result_decision");
        assert!(p["updatedToolOutput"].is_null());
    }

    #[test]
    fn validate_accepts_anthropic_provider_with_credentials() {
        let opts = parse(
            r#"{
                "provider": "anthropic",
                "providerCredentials": { "apiKey": "sk-test", "baseURL": "https://api.anthropic.com" }
            }"#,
        );
        assert!(opts.validate().is_ok());
    }

    #[test]
    fn validate_accepts_openai_provider_with_protocol() {
        let opts = parse(
            r#"{
                "provider": "openai",
                "providerCredentials": { "apiKey": "sk-foo", "protocol": "openai" }
            }"#,
        );
        assert!(opts.validate().is_ok());
    }

    #[test]
    fn validate_accepts_custom_provider_with_explicit_protocol() {
        let opts = parse(
            r#"{
                "provider": "my-self-hosted",
                "providerCredentials": {
                    "apiKey": "x",
                    "baseURL": "https://example.test/v1",
                    "protocol": "openai"
                }
            }"#,
        );
        assert!(opts.validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_provider_string() {
        let opts = parse(r#"{ "provider": "" }"#);
        let err = opts.validate().expect_err("empty provider should fail");
        assert!(err.contains("provider"));
    }

    #[test]
    fn corefiles_and_tool_rules_round_trip_through_the_flatten_catchall() {
        // The coreFiles suite (sidecar builtin category) and the merged
        // per-tool permission ruleset are NOT named struct fields — they ride
        // the `#[serde(flatten)] extra` map. Both the desktop invoke path and
        // the mobile companion RPC deserialize into this struct, so a dropped
        // or reshaped field here would silently strip the new tools on BOTH
        // platforms. Assert byte-faithful round-trip.
        let input = json!({
            "cwd": "D:/work",
            "builtinTools": {
                "coreFiles": true,
                "coreFilesOnAnthropic": false,
                "git": true
            },
            "permissionRuleset": {
                "Bash": { "git *": "allow", "rm *": "deny" },
                "edit": { "**/*.env": "deny" },
                "grep": "allow"
            },
            "disallowedTools": ["bash", "mcp__cognia-tools__write"]
        });
        let opts: SendOptions =
            serde_json::from_value(input.clone()).expect("valid SendOptions JSON");
        assert_eq!(opts.extra.get("builtinTools"), input.get("builtinTools"));
        assert_eq!(
            opts.extra.get("permissionRuleset"),
            input.get("permissionRuleset")
        );
        assert_eq!(
            opts.disallowed_tools.as_deref(),
            Some(&["bash".to_string(), "mcp__cognia-tools__write".to_string()][..])
        );
        // Re-serialization keeps the same shapes (what the sidecar receives).
        let out = serde_json::to_value(&opts).expect("serializable");
        assert_eq!(out.get("builtinTools"), input.get("builtinTools"));
        assert_eq!(out.get("permissionRuleset"), input.get("permissionRuleset"));
    }

    #[test]
    fn agent_field_rides_the_flatten_catchall_to_the_sidecar() {
        // `@agent` single-turn routing: `resolveSendOptions` sets a top-level
        // `agent` field that is NOT a named struct field here — it must ride the
        // `extra` flatten map untouched (renderer → Rust → sidecar), where the
        // anthropic dispatcher reads `sendOptions.agent`. A dropped/renamed field
        // would silently disable routing on the desktop path.
        let input = json!({
            "cwd": "/w",
            "agent": "template:my-reviewer",
            "agents": { "template:my-reviewer": { "prompt": "you review" } }
        });
        let opts: SendOptions =
            serde_json::from_value(input.clone()).expect("valid SendOptions JSON");
        assert_eq!(opts.extra.get("agent"), input.get("agent"));
        let out = serde_json::to_value(&opts).expect("serializable");
        assert_eq!(out.get("agent"), input.get("agent"));
        assert_eq!(out.get("agents"), input.get("agents"));
    }

    #[test]
    fn validate_rejects_unknown_protocol() {
        let opts = parse(
            r#"{
                "provider": "openai",
                "providerCredentials": { "protocol": "voodoo" }
            }"#,
        );
        let err = opts.validate().expect_err("bad protocol should fail");
        assert!(err.contains("protocol"));
    }

    #[test]
    fn provider_credentials_headers_round_trip() {
        // Codex ChatGPT-login headers must survive deserialize → re-serialize
        // across the renderer→Rust→sidecar boundary, or the backend rejects the
        // request. A strictly-typed struct without this field would drop them.
        let opts = parse(
            r#"{
                "provider": "codex",
                "model": "gpt-5.2-codex",
                "providerCredentials": {
                    "apiKey": "chatgpt-bearer",
                    "baseURL": "https://chatgpt.com/backend-api/codex",
                    "protocol": "openai",
                    "headers": {
                        "ChatGPT-Account-Id": "acct_123",
                        "OAI-Product-Sku": "codex"
                    }
                }
            }"#,
        );
        assert!(opts.validate().is_ok());
        let creds = opts.provider_credentials.as_ref().expect("creds present");
        let headers = creds.headers.as_ref().expect("headers present");
        assert_eq!(
            headers.get("ChatGPT-Account-Id").map(String::as_str),
            Some("acct_123")
        );
        // Re-serialization preserves them for the sidecar.
        let json = serde_json::to_value(&opts).expect("serialise");
        assert_eq!(
            json["providerCredentials"]["headers"]["OAI-Product-Sku"],
            "codex"
        );
    }

    #[test]
    fn provider_credentials_api_flavor_round_trips() {
        // apiFlavor must survive deserialize → re-serialize across the
        // renderer→Rust→sidecar boundary, or the sidecar's
        // decideOpenAiEndpointFlavor never sees the user's Responses/Chat choice
        // (the same drop trap as `headers`). It also unlocks the Responses API
        // on Azure / compatible gateways / custom base URLs.
        let opts = parse(
            r#"{
                "provider": "azure",
                "model": "gpt-5",
                "providerCredentials": {
                    "apiKey": "az-key",
                    "baseURL": "https://x.openai.azure.com",
                    "protocol": "azure",
                    "apiFlavor": "responses"
                }
            }"#,
        );
        assert!(opts.validate().is_ok());
        let creds = opts.provider_credentials.as_ref().expect("creds present");
        assert_eq!(creds.api_flavor.as_deref(), Some("responses"));
        let json = serde_json::to_value(&opts).expect("serialise");
        assert_eq!(json["providerCredentials"]["apiFlavor"], "responses");
    }

    #[test]
    fn provider_credentials_rejects_bad_api_flavor() {
        let opts = parse(
            r#"{
                "provider": "openai",
                "model": "gpt-5",
                "providerCredentials": { "apiFlavor": "streaming" }
            }"#,
        );
        let err = opts.validate().expect_err("bad apiFlavor should fail");
        assert!(err.contains("apiFlavor"));
    }

    #[test]
    fn provider_credentials_omitted_when_none() {
        let opts = SendOptions::default();
        let json = serde_json::to_value(&opts).expect("serialise");
        assert!(json.get("providerCredentials").is_none());
        assert!(json.get("provider").is_none());
        assert!(json.get("aliasResolution").is_none());
    }

    #[test]
    fn alias_resolution_round_trips_as_opaque_value() {
        let opts = parse(
            r#"{
                "provider": "openai",
                "model": "gpt-4o-mini",
                "aliasResolution": {
                    "alias": "fast",
                    "resolvedTo": { "providerId": "openai", "modelId": "gpt-4o-mini" },
                    "fallbackEntries": [
                        { "providerId": "anthropic", "modelId": "claude-3-5-haiku" }
                    ]
                },
                "routingDecision": { "strategy": "cost", "reason": "cheapest in chain" }
            }"#,
        );
        assert!(opts.validate().is_ok());
        let alias = opts.alias_resolution.as_ref().expect("alias present");
        assert_eq!(alias["alias"], "fast");
        let decision = opts.routing_decision.as_ref().expect("decision present");
        assert_eq!(decision["strategy"], "cost");
    }

    #[test]
    fn back_compat_validates_with_no_provider_fields() {
        // Existing (pre-port) Anthropic-only chats must keep working with no
        // provider field at all.
        let opts = parse(r#"{ "model": "claude-3-5-sonnet-20241022" }"#);
        assert!(opts.validate().is_ok());
        assert!(opts.provider.is_none());
        assert!(opts.provider_credentials.is_none());
    }

    #[test]
    fn validate_accepts_system_prompt_with_append() {
        // Since the Agent SDK 0.3.183 migration the sidecar FOLDS
        // `systemPrompt` + `appendSystemPrompt` (anthropic via `foldSystemPrompt`,
        // ai-sdk via concatenation), so both being set is the supported state —
        // `resolveSendOptions` routinely sets the base prompt AND appends a
        // dynamic section (brief/plan mode, output style, A2UI, sandbox hint,
        // goal/branch context seed). They are no longer mutually exclusive.
        let both = parse(r#"{ "systemPrompt": "a", "appendSystemPrompt": "b" }"#);
        assert!(both.validate().is_ok());
    }

    #[test]
    fn existing_validation_rules_still_work() {
        let dual_session = parse(r#"{ "resumeSessionId": "x", "forkFromSessionId": "y" }"#);
        assert!(dual_session.validate().is_err());

        let bad_turns = parse(r#"{ "maxTurns": 0 }"#);
        assert!(bad_turns.validate().is_err());

        let bad_source = parse(r#"{ "settingSources": ["user", "globe"] }"#);
        assert!(bad_source.validate().is_err());
    }
}
