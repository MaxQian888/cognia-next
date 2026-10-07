use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::host::SidecarHost;
use super::supervisor::{spawn as spawn_sidecar, SidecarState};
use cognia_hooks as hooks;

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
    /// `baseURL` on the wire, as the renderer and the sidecar spell it. The
    /// camelCase rename alone yields `baseUrl`, which made serde drop every
    /// base URL here and send a relay's key to its client's default host.
    #[serde(
        rename = "baseURL",
        alias = "baseUrl",
        skip_serializing_if = "Option::is_none"
    )]
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

/// The one adapter family the Node sidecar does not serve. External agents
/// (ACP, Codex app-server, OpenCode, Pi, A2A, ...) run behind
/// `ExternalAgentManager` with their own process and transport boundary; the
/// sidecar's dispatcher throws on this id by design, so a send that carries it
/// must be refused HERE, before it reaches a process that would die on it.
pub fn execution_spec_names_external_runtime(execution: &Value) -> bool {
    execution
        .get("runtimeAdapter")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s == "external")
}

// The `agent_*` commands accept the renderer's idempotency key; the deprecated
// `claude_*` aliases do not, because nothing that calls them stamps one.

/// Start the Agent Host without sending model work and resolve only after its
/// ready handshake. Recovery uses this explicit lifecycle command before its
/// read-only status probe; ordinary send paths retain their lazy spawn.
pub async fn agent_start_with_host(
    host: Arc<dyn SidecarHost>,
    state: SidecarState,
) -> Result<SidecarStatus, String> {
    spawn_sidecar(host, state.clone()).await?;
    state.wait_until_ready().await?;
    Ok(SidecarStatus { ready: true })
}

/// Host-generic body of `claude_send` (ADR-0059 R6). The desktop command
/// wraps the `AppHandle` in a `TauriSidecarHost`; the headless RPC arm (R7)
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
    let _perf = cognia_instrument::guard("claude.send");
    validate_send_request(&session_id, &prompt)?;
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

    let active_command_id = command_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let msg = with_command_id(
        json!({
          "type": "send",
          "sessionId": session_id,
          "prompt": prompt,
          "options": opts_value,
        }),
        command_id,
    );
    write_active_run_command(&state, &msg, &session_id, active_command_id.as_deref()).await
}

fn validate_send_request(session_id: &str, prompt: &Value) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("send: sessionId required".into());
    }
    if !prompt.is_string() && !prompt.is_array() {
        return Err("send: prompt must be string or content-block array".into());
    }
    Ok(())
}

pub async fn write_active_run_command(
    state: &SidecarState,
    message: &Value,
    session_id: &str,
    command_id: Option<&str>,
) -> Result<(), String> {
    let token = state.begin_active_run(session_id, command_id);
    if let Err(error) = state.write_command(message).await {
        state.cancel_active_run(token);
        return Err(error);
    }
    Ok(())
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
            | "runtimeStatus"
            | "reloadOutputStyles"
            | "reloadPlugins"
            | "reloadSkills"
            | "rewindFiles"
            | "seedReadState"
            | "setMaxThinkingTokens"
            | "setMcpPermissionModeOverride"
            | "setMcpServers"
            | "setModel"
            | "setPermissionMode"
            | "steer"
            | "stopTask"
            | "supportedAgents"
            | "supportedCommands"
            | "supportedModels"
            | "toggleMcpServer"
            | "updateSettings"
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

/// The body behind [`claude_session_control`], shared with the companion RPC
/// arm so a paired phone drives the same allowlist and the same stdin frame
/// as the desktop webview (`rpc/chat.rs`). The `control_response` the sidecar
/// answers with rides `claude://message`, which every host publishes to the
/// companion event bus, so the round-trip closes remotely without any extra
/// plumbing here.
pub async fn claude_session_control_impl(
    state: &SidecarState,
    session_id: String,
    request_id: String,
    method: String,
    params: Option<Value>,
    command_id: Option<String>,
) -> Result<(), String> {
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

/// The body behind [`agent_session_api`], shared with the companion RPC arm.
/// `host` names the sidecar supervisor for whichever process serves the call
/// (the Tauri app or `cognia-server`'s registry), exactly as
/// [`claude_send_with_host_and_id`] takes it, so the cold-start spawn works
/// on both.
pub async fn agent_session_api_impl(
    host: Arc<dyn SidecarHost>,
    state: SidecarState,
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
    spawn_sidecar(host, state.clone()).await?;
    let payload = build_session_api_payload(request_id, method, params, send_options);
    state.write_command(&payload).await
}

pub fn build_feature_call_payload(mut request: Value) -> Result<Value, String> {
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
            | "tool-host-start"
            | "tool-host-stop"
            | "tool-host-reply"
    ) {
        return Err(format!("unsupported feature call operation: {operation}"));
    }
    object.insert("type".into(), Value::String("feature_call".into()));
    Ok(request)
}

/// Narrow remote entry point: no provider credentials or general feature calls.
/// Lease ids are namespaced by the authenticated device, so another paired
/// device cannot renew, replace, answer, or close its tool host.
pub fn build_remote_tool_host_payload(
    request: Value,
    device_id: &str,
    remote_context: Value,
) -> Result<Value, String> {
    let object = request
        .as_object()
        .ok_or("tool host request must be an object")?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "requestId" | "operation" | "toolHost" | "credentials"
        )
    }) || object
        .get("credentials")
        .is_some_and(|value| value != &json!({}))
    {
        return Err("remote tool host accepts only lease controls".into());
    }
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        operation,
        "tool-host-start" | "tool-host-stop" | "tool-host-reply"
    ) {
        return Err("unsupported remote tool host operation".into());
    }
    let mut tool_host = object
        .get("toolHost")
        .and_then(Value::as_object)
        .cloned()
        .ok_or("tool host control must be an object")?;
    if tool_host.keys().any(|key| {
        !matches!(
            key.as_str(),
            "leaseId"
                | "sandboxAgentId"
                | "deferSandbox"
                | "ownerSessionId"
                | "sendOptions"
                | "renew"
                | "pause"
                | "kind"
                | "id"
                | "result"
                | "generation"
                | "remoteExecutionContext"
        )
    }) {
        return Err("unsupported remote tool host control field".into());
    }
    if let Some(options) = tool_host.get_mut("sendOptions") {
        let options = options
            .as_object_mut()
            .ok_or("tool host sendOptions must be an object")?;
        if options.keys().any(|key| {
            !matches!(
                key.as_str(),
                "pluginTools"
                    | "permissionMode"
                    | "permissionRuleset"
                    | "allowedTools"
                    | "disallowedTools"
                    | "toolResultReviewEnabled"
            )
        }) {
            return Err("remote tool host supports plugin tools only; Host builtins and credentials are not accepted".into());
        }
        options.insert("builtinTools".into(), json!({}));
        options.insert("planTools".into(), json!(false));
    }
    let lease_id = tool_host
        .get("leaseId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let prefix = format!("remote-tool-host:{device_id}:");
    if device_id.is_empty()
        || !device_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || !lease_id.starts_with(&prefix)
        || lease_id.len() > 256
        || lease_id.len() <= prefix.len()
    {
        return Err("remote tool host lease belongs to another device".into());
    }
    let owner = tool_host
        .get("ownerSessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if owner.is_empty() || owner.len() > 256 {
        return Err("remote tool host requires an owner session".into());
    }
    if tool_host.get("sandboxAgentId").is_some_and(|value| {
        !value
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 256)
    }) {
        return Err("Invalid sandbox agent identity".into());
    }
    if tool_host.get("deferSandbox").is_some_and(|value| {
        !value.is_boolean()
            || value == &Value::Bool(true) && !tool_host.contains_key("sandboxAgentId")
    }) {
        return Err("Invalid deferred sandbox tool host".into());
    }
    // Never accept caller-authored origin metadata.
    tool_host.insert("remoteExecutionContext".into(), remote_context.clone());
    let mut payload = build_feature_call_payload(json!({
        "requestId": object.get("requestId"), "operation": operation,
        "credentials": {}, "toolHost": tool_host,
    }))?;
    payload["remoteExecutionContext"] = remote_context;
    Ok(payload)
}

pub async fn remote_tool_host_control_impl(
    host: Arc<dyn SidecarHost>,
    state: SidecarState,
    request: Value,
    device_id: &str,
    remote_context: Value,
) -> Result<(), String> {
    let payload = build_remote_tool_host_payload(request, device_id, remote_context)?;
    spawn_sidecar(host, state.clone()).await?;
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

/// Build the `plugin_hook_response` JSON line written to the sidecar stdin.
/// Pure so it is unit-testable without a running sidecar.
pub fn build_plugin_hook_response_payload(
    session_id: String,
    exec_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Value {
    json!({
      "type": "plugin_hook_response",
      "sessionId": session_id,
      "execId": exec_id,
      "result": result,
      "error": error,
    })
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

pub async fn claude_tool_result_decision_impl(
    state: &SidecarState,
    session_id: String,
    review_id: String,
    updated_tool_output: Option<Value>,
) -> Result<(), String> {
    let payload = build_tool_result_decision_payload(session_id, review_id, updated_tool_output);
    state.write_command(&payload).await
}

/// Build the `call_reserve_decision` JSON line written to the sidecar stdin.
/// Pure so it is unit-testable without a running sidecar. `decision` is
/// validated: anything but `granted` / `refused` / `bypass` is rejected so the
/// command cannot be used to inject another frame type.
fn build_call_reserve_decision_payload(
    session_id: String,
    request_id: String,
    decision: String,
    attempt_id: Option<String>,
    attempt_no: Option<u32>,
    code: Option<String>,
    message: Option<String>,
) -> Result<Value, String> {
    if !matches!(decision.as_str(), "granted" | "refused" | "bypass") {
        return Err(format!("unexpected call reserve decision: {decision}"));
    }
    let mut object = serde_json::Map::new();
    object.insert("type".into(), Value::String("call_reserve_decision".into()));
    object.insert("sessionId".into(), Value::String(session_id));
    object.insert("requestId".into(), Value::String(request_id));
    object.insert("decision".into(), Value::String(decision));
    if let Some(attempt_id) = attempt_id {
        object.insert("attemptId".into(), Value::String(attempt_id));
    }
    if let Some(attempt_no) = attempt_no {
        object.insert("attemptNo".into(), Value::from(attempt_no));
    }
    if let Some(code) = code {
        object.insert("code".into(), Value::String(code));
    }
    if let Some(message) = message {
        object.insert("message".into(), Value::String(message));
    }
    Ok(Value::Object(object))
}

/// The body of `claude_call_reserve_decision`, shared with the companion
/// RPC's `claude_call_reserve_respond` arm (ADR-0188 D25): a web or mobile
/// companion whose renderer started the turn answers the reservation through
/// the paired host, which writes the same frame to its own sidecar.
#[allow(clippy::too_many_arguments)]
pub async fn claude_call_reserve_decision_impl(
    state: &SidecarState,
    session_id: String,
    request_id: String,
    decision: String,
    attempt_id: Option<String>,
    attempt_no: Option<u32>,
    code: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    let payload = build_call_reserve_decision_payload(
        session_id, request_id, decision, attempt_id, attempt_no, code, message,
    )?;
    state.write_command(&payload).await
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

// =============================================================================
// Tests
// =============================================================================

/// Old-vs-new command telemetry: quantifies the remaining migration surface
/// (plan Phase 6 验收 / Phase 9 retirement evidence).
pub async fn agent_command_telemetry() -> Result<serde_json::Value, String> {
    let counters = DEPRECATED_COMMAND_COUNTERS.lock();
    Ok(serde_json::json!({
        "deprecatedCalls": counters.iter().map(|(k, v)| (k.to_string(), *v)).collect::<std::collections::BTreeMap<_, _>>(),
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn deferred_remote_tools_require_a_sandbox_identity_and_keep_host_targets_private() {
        let context = serde_json::json!({"originDeviceId":"device-a"});
        let request = serde_json::json!({"requestId":"request-1", "operation":"tool-host-start", "credentials":{}, "toolHost":{"leaseId":"remote-tool-host:device-a:lease-1", "ownerSessionId":"chat-1", "sandboxAgentId":"unspawned-parent", "deferSandbox":true}});
        let prepared =
            super::build_remote_tool_host_payload(request.clone(), "device-a", context.clone())
                .unwrap();
        assert_eq!(prepared["toolHost"]["deferSandbox"], true);
        for bad in [serde_json::json!("true"), serde_json::json!(0)] {
            let mut input = request.clone();
            input["toolHost"]["deferSandbox"] = bad;
            assert!(
                super::build_remote_tool_host_payload(input, "device-a", context.clone()).is_err()
            );
        }
        let mut missing = request.clone();
        missing["toolHost"]
            .as_object_mut()
            .unwrap()
            .remove("sandboxAgentId");
        assert!(
            super::build_remote_tool_host_payload(missing, "device-a", context.clone()).is_err()
        );
        for key in ["port", "host", "sandboxToolHostLeaseId"] {
            let mut input = request.clone();
            input["toolHost"][key] = serde_json::json!("forged");
            assert!(
                super::build_remote_tool_host_payload(input, "device-a", context.clone()).is_err()
            );
        }
    }

    #[test]
    fn remote_tool_host_is_device_bound_and_operation_scoped() {
        let context = serde_json::json!({"originDeviceId":"device-a"});
        let request = serde_json::json!({"requestId":"request-1", "operation":"tool-host-start", "credentials":{}, "toolHost":{"leaseId":"remote-tool-host:device-a:lease-1", "ownerSessionId":"chat-1", "remoteExecutionContext":{"originDeviceId":"forged"}}});
        let payload =
            super::build_remote_tool_host_payload(request.clone(), "device-a", context.clone())
                .unwrap();
        assert_eq!(payload["remoteExecutionContext"], context);
        assert_eq!(payload["toolHost"]["remoteExecutionContext"], context);
        assert!(super::build_remote_tool_host_payload(
            request.clone(),
            "device-b",
            context.clone()
        )
        .is_err());
        let mut bad = request.clone();
        bad["operation"] = serde_json::json!("language-generate");
        assert!(super::build_remote_tool_host_payload(bad, "device-a", context.clone()).is_err());
        let mut bad = request.clone();
        bad["credentials"] = serde_json::json!({"apiKey":"secret"});
        assert!(super::build_remote_tool_host_payload(bad, "device-a", context.clone()).is_err());
        for key in [
            "cwd",
            "builtinTools",
            "builtinProcessSandbox",
            "providerCredentials",
            "env",
        ] {
            let mut bad = request.clone();
            bad["toolHost"]["sendOptions"] = json!({ (key): {} });
            assert!(
                super::build_remote_tool_host_payload(bad, "device-a", context.clone()).is_err()
            );
        }
        let mut plugin = request.clone();
        plugin["toolHost"]["sendOptions"] = json!({ "pluginTools": [] });
        let payload = super::build_remote_tool_host_payload(plugin, "device-a", context).unwrap();
        assert_eq!(
            payload["toolHost"]["sendOptions"]["builtinTools"],
            json!({})
        );
        assert_eq!(payload["toolHost"]["sendOptions"]["planTools"], false);
    }
    use super::*;

    /// `claude_sidecar_status` answers this struct over the companion RPC, and
    /// its declared output contract is the `{ "ready": bool }` object
    /// `remote_execution`'s contract test validates.
    #[test]
    fn sidecar_status_serializes_as_the_ready_object() {
        assert_eq!(
            serde_json::to_value(SidecarStatus { ready: true }).unwrap(),
            serde_json::json!({ "ready": true })
        );
    }

    fn parse(json_str: &str) -> SendOptions {
        serde_json::from_str(json_str).expect("valid SendOptions JSON")
    }

    #[test]
    fn send_request_validation_rejects_untrackable_inputs() {
        assert_eq!(
            validate_send_request("", &json!("hello")).unwrap_err(),
            "send: sessionId required"
        );
        assert_eq!(
            validate_send_request("s1", &json!({ "text": "hello" })).unwrap_err(),
            "send: prompt must be string or content-block array"
        );
        assert!(validate_send_request("s1", &json!("hello")).is_ok());
        assert!(validate_send_request("s1", &json!([{ "type": "text" }])).is_ok());
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
    fn an_external_runtime_adapter_is_well_formed_but_not_served_here() {
        // Well-formed (the renderer can legitimately resolve it) ...
        let spec = json!({ "specVersion": 2, "runtimeAdapter": "external" });
        assert!(execution_spec_is_acceptable(&spec));
        // ... but it names the one family the sidecar refuses by throwing, so
        // `agent_send` must turn it away before the process sees it.
        assert!(execution_spec_names_external_runtime(&spec));
        assert!(!execution_spec_names_external_runtime(
            &json!({ "specVersion": 2, "runtimeAdapter": "claude-agent-sdk" })
        ));
        assert!(!execution_spec_names_external_runtime(
            &json!({ "specVersion": 2, "runtimeAdapter": "ai-sdk" })
        ));
        assert!(!execution_spec_names_external_runtime(
            &json!({ "specVersion": 2 })
        ));
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
            "runtimeStatus",
            "reloadOutputStyles",
            "reloadPlugins",
            "reloadSkills",
            "rewindFiles",
            "seedReadState",
            "setMaxThinkingTokens",
            "setMcpPermissionModeOverride",
            "setMcpServers",
            "setModel",
            "setPermissionMode",
            "steer",
            "stopTask",
            "supportedAgents",
            "supportedCommands",
            "supportedModels",
            "toggleMcpServer",
            "updateSettings",
        ] {
            assert!(is_allowed_control_method(m), "{m} should be allowed");
        }
        for m in [
            // `close` and `interrupt` are real Query methods reached through
            // their own commands; admitting them here would give the control
            // frame a second, unaudited way to end a session.
            "close",
            "interrupt",
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
            "setPermissionMode",
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
    fn builds_call_reserve_decision_payloads_and_omits_absent_fields() {
        let granted = build_call_reserve_decision_payload(
            "s1".into(),
            "req-1".into(),
            "granted".into(),
            Some("att-1".into()),
            Some(2),
            None,
            None,
        )
        .unwrap();
        assert_eq!(granted["type"], "call_reserve_decision");
        assert_eq!(granted["sessionId"], "s1");
        assert_eq!(granted["requestId"], "req-1");
        assert_eq!(granted["decision"], "granted");
        assert_eq!(granted["attemptId"], "att-1");
        assert_eq!(granted["attemptNo"], 2);
        assert!(granted.get("code").is_none());

        let refused = build_call_reserve_decision_payload(
            "s1".into(),
            "req-2".into(),
            "refused".into(),
            None,
            None,
            Some("RUN_BUDGET_EXHAUSTED".into()),
            Some("cap".into()),
        )
        .unwrap();
        assert_eq!(refused["code"], "RUN_BUDGET_EXHAUSTED");
        assert_eq!(refused["message"], "cap");
        assert!(refused.get("attemptId").is_none());

        // The sidecar reads `code` as the reason it continues unledgered.
        let bypass = build_call_reserve_decision_payload(
            "s1".into(),
            "req-3".into(),
            "bypass".into(),
            None,
            None,
            Some("db_unavailable".into()),
            None,
        )
        .unwrap();
        assert_eq!(bypass["decision"], "bypass");
        assert_eq!(bypass["code"], "db_unavailable");
        assert!(bypass.get("message").is_none());
        assert!(bypass.get("attemptNo").is_none());
    }

    #[test]
    fn call_reserve_decision_rejects_an_unknown_decision() {
        let err = build_call_reserve_decision_payload(
            "s1".into(),
            "req".into(),
            "interrupt".into(),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("unexpected call reserve decision"));
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
    fn provider_credentials_base_url_keeps_the_renderer_wire_name() {
        // The renderer and the sidecar both spell it `baseURL`. Under the
        // struct's camelCase rename it was `baseUrl`, so serde dropped every
        // base URL at this boundary: a relay's key then went to the client's
        // default host (an openai-protocol provider's to api.openai.com).
        let opts = parse(
            r#"{
                "provider": "deepseek-anthropic",
                "model": "deepseek-v4-flash",
                "providerCredentials": {
                    "apiKey": "relay-key",
                    "baseURL": "https://api.deepseek.com/anthropic",
                    "protocol": "anthropic"
                }
            }"#,
        );
        let creds = opts.provider_credentials.as_ref().expect("creds present");
        assert_eq!(
            creds.base_url.as_deref(),
            Some("https://api.deepseek.com/anthropic")
        );
        let json = serde_json::to_value(&opts).expect("serialise");
        assert_eq!(
            json["providerCredentials"]["baseURL"],
            "https://api.deepseek.com/anthropic"
        );
        assert!(json["providerCredentials"].get("baseUrl").is_none());
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
        for operation in ["tool-host-start", "tool-host-stop", "tool-host-reply"] {
            let payload = build_feature_call_payload(json!({
                "requestId": "tools-1", "operation": operation,
                "toolHost": { "leaseId": "lease-1", "ownerSessionId": "session-1" }
            }))
            .expect("tool host uses the existing feature transport");
            assert_eq!(payload["toolHost"]["ownerSessionId"], "session-1");
        }
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
