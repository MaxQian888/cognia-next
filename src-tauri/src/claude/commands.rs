use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tracing::Instrument as _;

use super::host::{SidecarHost, TauriSidecarHost};
use super::sidecar::{spawn as spawn_sidecar, SidecarState};
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
    /// W3C parent context for renderer → Rust → sidecar trace continuity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bedrock_auth_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_access_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_arn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_session_name: Option<String>,
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
            if let Some(mode) = creds.bedrock_auth_mode.as_ref() {
                if !matches!(mode.as_str(), "api-key" | "iam" | "default-chain") {
                    return Err(format!(
                        "invalid providerCredentials.bedrockAuthMode: {mode}"
                    ));
                }
                if creds
                    .region
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
                {
                    return Err("providerCredentials.region is required for Bedrock".into());
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

// ---- Canonical agent_* command surface (ADR-0090 Phase 3) -------------------
//
// Thin wrappers over the SAME impl bodies the claude_* commands use — one
// behavior, two names during migration. Every legacy claude_* invocation
// bumps a deprecation counter (surfaced via `agent_command_telemetry`) so
// Phase 9 retires the aliases with evidence instead of guesswork.

/// Per-command deprecation counters for the legacy `claude_*` aliases.
pub static DEPRECATED_COMMAND_COUNTERS: once_cell::sync::Lazy<
    parking_lot::Mutex<std::collections::BTreeMap<&'static str, u64>>,
> = once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(std::collections::BTreeMap::new()));

pub fn bump_deprecated(command: &'static str) {
    let mut counters = DEPRECATED_COMMAND_COUNTERS.lock();
    *counters.entry(command).or_insert(0) += 1;
}

/// Old-vs-new command telemetry: quantifies the remaining migration surface
/// (plan Phase 6 验收 / Phase 9 retirement evidence).
#[tauri::command]
pub async fn agent_command_telemetry() -> Result<serde_json::Value, String> {
    let counters = DEPRECATED_COMMAND_COUNTERS.lock();
    Ok(serde_json::json!({
        "deprecatedCalls": counters.iter().map(|(k, v)| (k.to_string(), *v)).collect::<std::collections::BTreeMap<_, _>>(),
    }))
}

/// Execution-spec contract versions this host understands.
///
/// Mirrors `RESOLVED_SPEC_VERSION` in
/// `packages/agent-config-types/src/agent-execution.ts`. v1 is still accepted
/// because flag-off callers keep emitting it until the resolver is
/// default-on; v2 adds per-capability `support` verdicts.
pub const SUPPORTED_EXECUTION_SPEC_VERSION_MIN: i64 = 1;
pub const SUPPORTED_EXECUTION_SPEC_VERSION_MAX: i64 = 2;

/// Shallow skew guard for `options.execution`. Pure so it is unit-testable
/// without a running sidecar.
///
/// Deep validation stays renderer-side (`validateAgentExecutionSendSpec`).
/// This only answers "could this host have produced or understood it".
/// Rejecting an unknown future version is deliberate: a host older than the
/// renderer must fail loudly rather than forward a spec whose semantics it
/// cannot honour.
pub fn execution_spec_is_acceptable(execution: &Value) -> bool {
    matches!(
        execution.get("specVersion").and_then(|v| v.as_i64()),
        Some(SUPPORTED_EXECUTION_SPEC_VERSION_MIN..=SUPPORTED_EXECUTION_SPEC_VERSION_MAX)
    ) && execution
        .get("runtimeAdapter")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty())
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

// The `agent_*` commands accept the renderer's idempotency key; the deprecated
// `claude_*` aliases do not, because nothing that calls them stamps one.
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
    claude_send_with_host_and_id(host, state, session_id, prompt, options, None).await
}

pub async fn claude_send_with_host_and_id(
    host: Arc<dyn SidecarHost>,
    state: SidecarState,
    session_id: String,
    prompt: Value,
    options: Option<SendOptions>,
    command_id: Option<String>,
) -> Result<(), String> {
    let _perf = crate::perf::guard("claude.send");
    spawn_sidecar(Arc::clone(&host), state.clone()).await?;
    let mut opts_value = match options {
        Some(o) => {
            o.validate()?;
            serde_json::to_value(o).map_err(|e| e.to_string())?
        }
        None => Value::Object(Default::default()),
    };

    // Resolve trusted settings once and inject them into the SDK-native hook
    // pipeline. The SDK owns every built-in lifecycle event, including
    // UserPromptSubmit. Running that event here as well would execute each
    // configured handler twice because `buildAgentHooks` registers all SDK
    // lifecycle events.
    let cwd = opts_value
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(String::from);
    // Project/local hooks load only for a trusted cwd; untrusted → user scope.
    let trusted_cwd = hooks::trust::resolve_trusted_cwd(cwd.as_deref());
    let settings = hooks::load_effective_settings(trusted_cwd.as_deref());

    // Injected host-side after the trust gate, so a compromised renderer cannot
    // smuggle untrusted project hooks through `options`.
    if let Some(hooks_value) = settings.merged.hooks.clone() {
        if let Value::Object(map) = &mut opts_value {
            map.insert("hooks".to_string(), hooks_value);
        }
    }

    let msg = with_command_id(
        json!({
          "type": "send",
          "sessionId": session_id,
          "prompt": prompt,
          "options": opts_value,
        }),
        command_id,
    );
    state.write_command(&msg).await
}

// ---------------------------------------------------------------------------
// Host-generic command bodies (ADR-0059 R7)
//
// The RPC dispatch arms resolve a `SidecarState` from either the Tauri app or
// the headless services registry and call these `_impl` functions; the
// `#[tauri::command]` wrappers delegate so desktop behavior is unchanged.
// ---------------------------------------------------------------------------

/// Attach the renderer's idempotency key to an outgoing sidecar command.
///
/// The sidecar dedupes on `commandId` (`agent-host.mjs:dropDuplicateCommand`),
/// and `AgentExecutionHandle` has always stamped one — but the `agent_*`
/// commands never DECLARED the parameter, so Tauri dropped it before the
/// payload was built. Deduplication was therefore dead from the desktop
/// renderer: a retried permission response was applied twice.
///
/// Optional because legacy `claude_*` callers do not stamp one, and a command
/// with no id must still be delivered (just not deduped).
fn with_command_id(mut msg: Value, command_id: Option<String>) -> Value {
    if let (Some(obj), Some(id)) = (msg.as_object_mut(), command_id) {
        if !id.is_empty() {
            obj.insert("commandId".into(), Value::String(id));
        }
    }
    msg
}

pub async fn claude_interrupt_impl(state: &SidecarState, session_id: String) -> Result<(), String> {
    claude_interrupt_impl_with_id(state, session_id, None).await
}

pub async fn claude_interrupt_impl_with_id(
    state: &SidecarState,
    session_id: String,
    command_id: Option<String>,
) -> Result<(), String> {
    let msg = with_command_id(
        json!({ "type": "interrupt", "sessionId": session_id }),
        command_id,
    );
    state.write_command(&msg).await
}

pub async fn claude_compact_impl(
    state: &SidecarState,
    session_id: String,
    focus: Option<String>,
) -> Result<(), String> {
    claude_compact_impl_with_id(state, session_id, focus, None).await
}

pub async fn claude_compact_impl_with_id(
    state: &SidecarState,
    session_id: String,
    focus: Option<String>,
    command_id: Option<String>,
) -> Result<(), String> {
    let msg = with_command_id(
        json!({ "type": "compact", "sessionId": session_id, "focus": focus }),
        command_id,
    );
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
    claude_approve_impl_with_id(
        state,
        session_id,
        request_id,
        decision,
        message,
        updated_input,
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn claude_approve_impl_with_id(
    state: &SidecarState,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
    updated_input: Option<Value>,
    command_id: Option<String>,
    interrupt: Option<bool>,
) -> Result<(), String> {
    let valid = matches!(decision.as_str(), "allow" | "allow_always" | "deny");
    if !valid {
        return Err(format!("invalid decision: {decision}"));
    }
    let payload = with_command_id(
        json!({
          "type": "permission_response",
          "sessionId": session_id,
          "requestId": request_id,
          "decision": decision,
          "message": message,
          "updatedInput": updated_input,
          "interrupt": interrupt,
        }),
        command_id,
    );
    state.write_command(&payload).await
}

pub async fn claude_close_session_impl(
    state: &SidecarState,
    session_id: String,
) -> Result<(), String> {
    claude_close_session_impl_with_id(state, session_id, None).await
}

pub async fn claude_close_session_impl_with_id(
    state: &SidecarState,
    session_id: String,
    command_id: Option<String>,
) -> Result<(), String> {
    let msg = with_command_id(
        json!({ "type": "close", "sessionId": session_id }),
        command_id,
    );
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

pub async fn claude_restore_impl(
    state: &SidecarState,
    session_id: String,
    messages: Value,
) -> Result<(), String> {
    let msg = json!({ "type": "restore", "sessionId": session_id, "messages": messages });
    state.write_command(&msg).await
}

fn build_set_mode_payload(
    session_id: String,
    mode: String,
    command_id: Option<String>,
) -> Result<Value, String> {
    if !matches!(
        mode.as_str(),
        "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto"
    ) {
        return Err(format!("unsupported permission mode: {mode}"));
    }
    Ok(with_command_id(
        json!({ "type": "set_mode", "sessionId": session_id, "mode": mode }),
        command_id,
    ))
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

pub async fn claude_set_mode_impl(
    state: &SidecarState,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    claude_set_mode_impl_with_id(state, session_id, mode, None).await
}

pub async fn claude_set_mode_impl_with_id(
    state: &SidecarState,
    session_id: String,
    mode: String,
    command_id: Option<String>,
) -> Result<(), String> {
    state
        .write_command(&build_set_mode_payload(session_id, mode, command_id)?)
        .await
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

/// Allowlisted Claude Agent SDK `Query` control methods the renderer may drive
/// on a live session (streaming-input-only methods — see `sidecar/dispatch/
/// control.mjs`). Defense-in-depth: the same allowlist is enforced in the
/// sidecar, but rejecting here too means a bad `method` never reaches stdin.
pub fn is_allowed_control_method(method: &str) -> bool {
    matches!(
        method,
        "accountInfo"
            | "applyFlagSettings"
            | "backgroundTasks"
            | "getContextUsage"
            | "initializationResult"
            | "mcpServerStatus"
            | "readFile"
            | "reconnectMcpServer"
            | "reinitialize"
            | "reloadPlugins"
            | "reloadSkills"
            | "rewindFiles"
            | "seedReadState"
            | "setMaxThinkingTokens"
            | "setMcpPermissionModeOverride"
            | "setMcpServers"
            | "setModel"
            | "steer"
            | "stopTask"
            | "supportedAgents"
            | "supportedCommands"
            | "supportedModels"
            | "toggleMcpServer"
    )
}

/// Build the `control` JSON line written to the sidecar stdin. Pure so it is
/// unit-testable without a running sidecar.
fn build_session_control_payload(
    session_id: String,
    request_id: String,
    method: String,
    params: Option<Value>,
    command_id: Option<String>,
) -> Value {
    with_command_id(
        json!({
            "type": "control",
            "sessionId": session_id,
            "requestId": request_id,
            "method": method,
            "params": params,
        }),
        command_id,
    )
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
    if !is_allowed_control_method(&method) {
        return Err(format!("unsupported control method: {method}"));
    }
    let payload = build_session_control_payload(session_id, request_id, method, params, command_id);
    state.write_command(&payload).await
}

/// Allowlisted session-level Claude Agent SDK functions the renderer may drive
/// (see `sidecar/dispatch/session-api.mjs`). Kept separate from
/// [`is_allowed_control_method`] because these are module-level SDK exports
/// that operate on transcripts with no live session — five of them MUTATE a
/// user's session files, so an over-broad allowlist here deletes data rather
/// than merely erroring.
pub fn is_allowed_session_api_method(method: &str) -> bool {
    matches!(
        method,
        "deleteSession"
            | "forkSession"
            | "getSessionInfo"
            | "getSessionMessages"
            | "getSubagentMessages"
            | "importSessionToStore"
            | "listSessions"
            | "listSubagents"
            | "renameSession"
            | "resolveSettings"
            | "tagSession"
    )
}

/// Build the `session_api` JSON line written to the sidecar stdin. Pure so it
/// is unit-testable without a running sidecar.
fn build_session_api_payload(
    request_id: String,
    method: String,
    params: Option<Value>,
    send_options: Option<Value>,
) -> Value {
    json!({
        "type": "session_api",
        "requestId": request_id,
        "method": method,
        "params": params,
        // Names the SessionStore backend for this call. The sidecar resolves it
        // to a live store; it never accepts a store from the renderer.
        "sendOptions": send_options,
    })
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
    if request_id.is_empty() {
        return Err("agent_session_api: requestId must not be empty".into());
    }
    if !is_allowed_session_api_method(&method) {
        return Err(format!("unsupported session api method: {method}"));
    }
    spawn_sidecar(Arc::new(TauriSidecarHost(app)), state.inner().clone()).await?;
    let payload = build_session_api_payload(request_id, method, params, send_options);
    state.write_command(&payload).await
}

fn build_feature_call_payload(mut request: Value) -> Result<Value, String> {
    let object = request
        .as_object_mut()
        .ok_or_else(|| "feature call request must be an object".to_string())?;
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_id.is_empty() {
        return Err("feature call requestId must not be empty".into());
    }
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        operation,
        "language-generate"
            | "language-stream"
            | "embedding"
            | "bedrock-discover"
            | "opencode-v2-discover"
            | "mcp-discover"
    ) {
        return Err(format!("unsupported feature call operation: {operation}"));
    }
    object.insert("type".into(), Value::String("feature_call".into()));
    Ok(request)
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
    claude_plugin_tool_response_impl(&state, session_id, tool_use_id, result, error).await
}

pub async fn claude_plugin_tool_response_impl(
    state: &SidecarState,
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
    claude_tool_result_decision_impl(&state, session_id, review_id, updated_tool_output).await
}

pub async fn claude_tool_result_decision_impl(
    state: &SidecarState,
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
    claude_protocol_adapter_message_impl(&state, message).await
}

pub async fn claude_protocol_adapter_message_impl(
    state: &SidecarState,
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
        #[cfg(unix)]
        assert!(
            node_marker.is_file(),
            "the sidecar must use the Node executable resolved by its host"
        );

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
    fn attaches_the_renderer_idempotency_key_when_one_was_sent() {
        let msg = with_command_id(
            json!({ "type": "close", "sessionId": "s1" }),
            Some("cmd-7-abc".into()),
        );
        assert_eq!(msg["commandId"], "cmd-7-abc");
        assert_eq!(msg["type"], "close");
    }

    #[test]
    fn omits_the_key_entirely_when_absent_or_empty() {
        // The sidecar's dedupe is keyed on presence; an empty string would be a
        // key every command shares, collapsing unrelated commands into one.
        for id in [None, Some(String::new())] {
            let msg = with_command_id(json!({ "type": "interrupt", "sessionId": "s1" }), id);
            assert!(msg.get("commandId").is_none());
        }
    }

    #[test]
    fn leaves_a_non_object_payload_untouched() {
        let msg = with_command_id(json!("not-an-object"), Some("cmd-1".into()));
        assert_eq!(msg, json!("not-an-object"));
    }

    #[test]
    fn accepts_every_live_execution_spec_version() {
        for version in SUPPORTED_EXECUTION_SPEC_VERSION_MIN..=SUPPORTED_EXECUTION_SPEC_VERSION_MAX {
            let spec = json!({ "specVersion": version, "runtimeAdapter": "claude-agent-sdk" });
            assert!(
                execution_spec_is_acceptable(&spec),
                "specVersion {version} must be accepted"
            );
        }
    }

    #[test]
    fn rejects_an_unknown_future_execution_spec_version() {
        // A renderer newer than this host must not have its spec forwarded on
        // a shrug: the host would pass through semantics it cannot honour.
        let spec = json!({
            "specVersion": SUPPORTED_EXECUTION_SPEC_VERSION_MAX + 1,
            "runtimeAdapter": "claude-agent-sdk",
        });
        assert!(!execution_spec_is_acceptable(&spec));
    }

    #[test]
    fn rejects_execution_specs_missing_a_runtime_adapter() {
        assert!(!execution_spec_is_acceptable(&json!({ "specVersion": 2 })));
        assert!(!execution_spec_is_acceptable(
            &json!({ "specVersion": 2, "runtimeAdapter": "" })
        ));
        assert!(!execution_spec_is_acceptable(
            &json!({ "specVersion": 2, "runtimeAdapter": 7 })
        ));
        assert!(!execution_spec_is_acceptable(
            &json!({ "runtimeAdapter": "ai-sdk" })
        ));
    }

    #[test]
    fn allows_only_known_control_methods() {
        for m in [
            "accountInfo",
            "applyFlagSettings",
            "backgroundTasks",
            "getContextUsage",
            "initializationResult",
            "mcpServerStatus",
            "readFile",
            "reconnectMcpServer",
            "reinitialize",
            "reloadPlugins",
            "reloadSkills",
            "rewindFiles",
            "seedReadState",
            "setMaxThinkingTokens",
            "setMcpPermissionModeOverride",
            "setMcpServers",
            "setModel",
            "steer",
            "stopTask",
            "supportedAgents",
            "supportedCommands",
            "supportedModels",
            "toggleMcpServer",
        ] {
            assert!(is_allowed_control_method(m), "{m} should be allowed");
        }
        for m in [
            // `close` and `interrupt` are real Query methods reached through
            // their own commands; admitting them here would give the control
            // frame a second, unaudited way to end a session.
            "close",
            "interrupt",
            "setPermissionMode",
            // Declared `not-exposed` in protocol/agent-control-methods.json.
            "streamInput",
            "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
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
            Some("cmd-1".into()),
        );
        assert_eq!(p["type"], "control");
        assert_eq!(p["sessionId"], "s1");
        assert_eq!(p["requestId"], "req1");
        assert_eq!(p["method"], "setModel");
        assert_eq!(p["params"]["model"], "claude-opus-4-8");
        assert_eq!(p["commandId"], "cmd-1");
    }

    #[test]
    fn attaches_command_id_to_canonical_send_payload() {
        let payload = with_command_id(
            json!({
                "type": "send",
                "sessionId": "s1",
                "prompt": "hello",
                "options": {},
            }),
            Some("action-1".into()),
        );
        assert_eq!(payload["commandId"], "action-1");
    }

    #[test]
    fn builds_session_control_payload_without_params() {
        let p = build_session_control_payload(
            "s1".into(),
            "req2".into(),
            "getContextUsage".into(),
            None,
            None,
        );
        assert_eq!(p["method"], "getContextUsage");
        assert!(p["params"].is_null());
    }

    #[test]
    fn allows_only_known_session_api_methods() {
        for m in [
            "deleteSession",
            "forkSession",
            "getSessionInfo",
            "getSessionMessages",
            "getSubagentMessages",
            "importSessionToStore",
            "listSessions",
            "listSubagents",
            "renameSession",
            "resolveSettings",
            "tagSession",
        ] {
            assert!(is_allowed_session_api_method(m), "{m} should be allowed");
        }
        for m in [
            // Control methods travel on the `control` frame; letting them in
            // here would be a second, unaudited route to a live query.
            "setModel",
            "steer",
            "interrupt",
            // Not SDK session functions at all.
            "query",
            "startup",
            "__proto__",
            "",
            "deleteSessions",
        ] {
            assert!(!is_allowed_session_api_method(m), "{m} should be rejected");
        }
    }

    #[test]
    fn builds_session_api_payload_carrying_params_and_send_options() {
        let p = build_session_api_payload(
            "req9".into(),
            "renameSession".into(),
            Some(json!({ "sessionId": "s1", "title": "New" })),
            Some(json!({ "cwd": "/w" })),
        );
        assert_eq!(p["type"], "session_api");
        assert_eq!(p["requestId"], "req9");
        assert_eq!(p["method"], "renameSession");
        assert_eq!(p["params"]["title"], "New");
        // The frame names the store BACKEND via sendOptions; the sidecar
        // resolves it. A `sessionId` on the frame itself would be meaningless —
        // these calls run without a live session.
        assert_eq!(p["sendOptions"]["cwd"], "/w");
        assert!(p.get("sessionId").is_none());
    }

    #[test]
    fn builds_session_api_payload_without_params_or_send_options() {
        let p = build_session_api_payload("req10".into(), "listSessions".into(), None, None);
        assert_eq!(p["method"], "listSessions");
        assert!(p["params"].is_null());
        assert!(p["sendOptions"].is_null());
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
    fn set_mode_payload_accepts_supported_modes_and_rejects_unknown_values() {
        let payload =
            build_set_mode_payload("s1".into(), "dontAsk".into(), Some("cmd-1".into())).unwrap();
        assert_eq!(payload["type"], "set_mode");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["mode"], "dontAsk");
        assert_eq!(payload["commandId"], "cmd-1");

        let error = build_set_mode_payload("s1".into(), "owner".into(), None).unwrap_err();
        assert!(error.contains("unsupported permission mode"));
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

    #[test]
    fn feature_call_payload_is_correlated_and_allowlisted() {
        let payload = build_feature_call_payload(json!({
            "requestId": "request-1",
            "operation": "language-stream",
            "model": "us.amazon.nova-lite-v1:0"
        }))
        .expect("valid payload");
        assert_eq!(payload["type"], "feature_call");
        assert_eq!(payload["requestId"], "request-1");
        assert!(build_feature_call_payload(json!({
            "requestId": "request-2",
            "operation": "shell"
        }))
        .is_err());
        assert!(build_feature_call_payload(json!({
            "requestId": "request-3",
            "operation": "opencode-v2-discover"
        }))
        .is_ok());
        assert!(build_feature_call_payload(json!({
            "requestId": "request-4",
            "operation": "mcp-discover"
        }))
        .is_ok());
    }

    #[test]
    fn deprecated_counters_accumulate_per_command() {
        // Counters are process-global; assert deltas, not absolutes.
        let before = DEPRECATED_COMMAND_COUNTERS
            .lock()
            .get("claude_compact")
            .copied()
            .unwrap_or(0);
        bump_deprecated("claude_compact");
        bump_deprecated("claude_compact");
        let after = DEPRECATED_COMMAND_COUNTERS
            .lock()
            .get("claude_compact")
            .copied()
            .unwrap_or(0);
        assert_eq!(after - before, 2);
    }

    #[tokio::test]
    async fn agent_command_telemetry_reports_the_deprecation_map() {
        bump_deprecated("claude_send");
        let payload = agent_command_telemetry().await.expect("telemetry");
        let calls = payload
            .get("deprecatedCalls")
            .and_then(|v| v.as_object())
            .expect("deprecatedCalls object");
        assert!(calls
            .get("claude_send")
            .and_then(|v| v.as_u64())
            .is_some_and(|n| n >= 1));
        // Secret-free by construction: names + counts only.
        assert!(!payload.to_string().to_lowercase().contains("api"));
    }
}
