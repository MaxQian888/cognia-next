use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Appended to the SDK's default system prompt rather than replacing it.
    /// Mutually exclusive with `system_prompt`.
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
}

impl SendOptions {
    /// Validate field combinations the SDK will reject anyway. Surfacing the
    /// error here gives a clean message instead of a parser crash inside Node.
    fn validate(&self) -> Result<(), String> {
        if self.system_prompt.is_some() && self.append_system_prompt.is_some() {
            return Err("systemPrompt and appendSystemPrompt are mutually exclusive".into());
        }
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
                    "openai" | "anthropic" | "google" | "mistral" | "cohere"
                ) {
                    return Err(format!("invalid providerCredentials.protocol: {proto}"));
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
    spawn_sidecar(app, state.inner().clone()).await?;
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
    let prompt_text = extract_prompt_text(&prompt);
    let mut prompt = prompt;
    if !prompt_text.is_empty() {
        let settings = hooks::load_effective_settings(cwd.as_deref());
        let decision =
            hooks::run_user_prompt_submit(&settings, &session_id, cwd.as_deref(), &prompt_text)
                .await;
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

#[tauri::command]
pub async fn claude_interrupt(
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<(), String> {
    let msg = json!({ "type": "interrupt", "sessionId": session_id });
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

#[tauri::command]
pub async fn claude_close_session(
    state: State<'_, SidecarState>,
    session_id: String,
) -> Result<(), String> {
    let msg = json!({ "type": "close", "sessionId": session_id });
    state.write_command(&msg).await
}

#[tauri::command]
pub async fn claude_sidecar_status(
    state: State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    Ok(SidecarStatus {
        ready: state.is_ready().await,
    })
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
    fn existing_validation_rules_still_work() {
        let dual_prompt = parse(
            r#"{ "systemPrompt": "a", "appendSystemPrompt": "b" }"#,
        );
        assert!(dual_prompt.validate().is_err());

        let dual_session = parse(
            r#"{ "resumeSessionId": "x", "forkFromSessionId": "y" }"#,
        );
        assert!(dual_session.validate().is_err());

        let bad_turns = parse(r#"{ "maxTurns": 0 }"#);
        assert!(bad_turns.validate().is_err());

        let bad_source = parse(r#"{ "settingSources": ["user", "globe"] }"#);
        assert!(bad_source.validate().is_err());
    }
}
