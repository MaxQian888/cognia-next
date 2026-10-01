//! Bounded Chat Completions transport; outbound content fails closed on PII.
use crate::config::{Auth, Config, Model, ToolConfig, ToolProfile};
use crate::tools::validate_call;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use tokio::sync::watch;

pub struct ModelClient {
    client: reqwest::Client,
    endpoint: url::Url,
    model: String,
    key: String,
    response_limit: usize,
    secrets: Vec<String>,
    options: Model,
    tools: ToolConfig,
    headers: reqwest::header::HeaderMap,
}
pub struct Reply {
    pub message: Value,
    pub calls: Vec<Call>,
    pub text: String,
}
pub struct Call {
    pub id: String,
    pub name: String,
    pub args: Value,
}
/// Display events are emitted only after the complete reply passes all guards.
pub enum ModelEvent {
    Text(String),
    Thinking(String),
}

pub fn guard(text: &str, key: &str) -> Result<(), &'static str> {
    if (!key.is_empty()
        && (text.contains(key)
            || cognia_net::outbound_pii::normalize_for_redaction(text).contains(key)))
        || !cognia_net::outbound_pii::has_no_leaking_pii(text)
    {
        Err("outbound-pii-blocked")
    } else {
        Ok(())
    }
}

fn tool_schema(config: &ToolConfig) -> Value {
    let mut tools = Vec::new();
    if config.shell {
        let name = if config.profile == ToolProfile::Dsh {
            "bash"
        } else {
            "shell"
        };
        let timeout = "timeoutSecs";
        tools.push(json!({"type":"function","function":{"name":name,"description":"Execute a command in the persistent workspace shell; directory, environment and functions persist.","parameters":{"type":"object","properties":{"command":{"type":"string"},timeout:{"type":"integer","minimum":1}},"required":["command"],"additionalProperties":false}}}));
    }
    if config.editor {
        if config.profile == ToolProfile::Dsh {
            tools.push(json!({"type":"function","function":{"name":"str_replace_editor","description":"Read or edit a UTF-8 workspace file or view a directory. view_range is inclusive and one-based; -1 means the final line. insert_line inserts after the zero-based boundary (0 prepends). str_replace requires a unique exact old_str.","parameters":{"type":"object","properties":{"command":{"type":"string","enum":["view","create","str_replace","insert"]},"path":{"type":"string"},"file_text":{"type":["string","null"]},"old_str":{"type":["string","null"]},"new_str":{"type":["string","null"]},"insert_line":{"type":["integer","null"],"minimum":0},"view_range":{"type":["array","null"],"items":{"type":"integer"},"minItems":2,"maxItems":2}},"required":["command","path"],"additionalProperties":false}}}));
        } else {
            tools.push(json!({"type":"function","function":{"name":"editor","description":"Read or edit a UTF-8 workspace file. view supports inclusive startLine/endLine; create makes a new file with content; replace requires a unique exact oldText; insert adds newText before the one-based line.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["view","create","replace","insert"]},"path":{"type":"string"},"content":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"line":{"type":"integer","minimum":1},"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1}},"required":["action","path"],"additionalProperties":false}}}));
        }
    }
    json!(tools)
}

impl ModelClient {
    pub fn from_config(config: &Config) -> Result<Self, &'static str> {
        let key = if config.model.auth == Auth::None {
            String::new()
        } else {
            std::env::var(&config.model.api_key_env).map_err(|_| "missing-credential")?
        };
        Self::new(config, key)
    }
    pub fn new(config: &Config, key: String) -> Result<Self, &'static str> {
        config.validate()?;
        if config.model.auth != Auth::None
            && (key.trim().is_empty() || key.chars().any(char::is_control) || key.len() > 8192)
        {
            return Err("missing-credential");
        }
        let endpoint = config.endpoint()?;
        initialize_network()?;
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(
                config.model.request_timeout_secs,
            ));
        let client = cognia_net::proxy_config::managed_client(builder, endpoint.as_str())
            .map_err(|_| "network-initialization-failed")?;
        let mut headers = reqwest::header::HeaderMap::new();
        let mut secrets: Vec<String> = config
            .secret_env
            .iter()
            .chain(config.model.headers_env.values())
            .chain(std::iter::once(&config.model.api_key_env))
            .filter_map(|name| std::env::var(name).ok())
            .filter(|value| !value.is_empty())
            .collect();
        for (name, value) in &config.model.headers {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "invalid-model-headers")?,
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| "invalid-model-headers")?,
            );
        }
        for (name, env) in &config.model.headers_env {
            let value = std::env::var(env).map_err(|_| "missing-credential")?;
            if value.trim().is_empty() || value.len() > 8192 {
                return Err("missing-credential");
            }
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "invalid-model-headers")?,
                reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|_| "invalid-model-headers")?,
            );
            secrets.push(value);
        }
        if config.model.auth == Auth::Header {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(
                    config
                        .model
                        .api_key_header
                        .as_deref()
                        .ok_or("invalid-model-headers")?
                        .as_bytes(),
                )
                .map_err(|_| "invalid-model-headers")?,
                reqwest::header::HeaderValue::from_str(&key).map_err(|_| "missing-credential")?,
            );
        }
        Ok(Self {
            client,
            endpoint,
            model: config.model.model.clone(),
            key,
            response_limit: config.limits.max_response_bytes,
            secrets,
            options: config.model.clone(),
            tools: config.tools.clone(),
            headers,
        })
    }
    fn guard_content(&self, text: &str) -> Result<(), &'static str> {
        if !cognia_net::outbound_pii::has_no_leaking_pii(text) {
            return Err("outbound-pii-blocked");
        }
        let normalized = cognia_net::outbound_pii::normalize_for_redaction(text);
        for secret in std::iter::once(&self.key).chain(&self.secrets) {
            if !secret.is_empty() && (text.contains(secret) || normalized.contains(secret)) {
                return Err("outbound-pii-blocked");
            }
        }
        Ok(())
    }
    fn guard_json(&self, value: &Value, encoded_depth: usize) -> Result<(), &'static str> {
        match value {
            Value::String(text) => {
                self.guard_content(text)?;
                if let Ok(nested) = serde_json::from_str::<Value>(text) {
                    if encoded_depth >= 8 {
                        return Err("outbound-pii-blocked");
                    }
                    self.guard_json(&nested, encoded_depth + 1)?;
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.guard_json(value, encoded_depth)?;
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    self.guard_content(key)?;
                    self.guard_json(value, encoded_depth)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    pub fn guard_messages(&self, messages: &[Value]) -> Result<(), &'static str> {
        self.guard_json(&json!(messages), 0)
    }
    fn body(&self, messages: &[Value], summary_tokens: Option<u64>) -> Value {
        let mut body = json!(self.options.extra_body);
        body["model"] = json!(self.model);
        body["messages"] = json!(messages);
        body["stream"] = json!(self.options.stream);
        let schema = tool_schema(&self.tools);
        if summary_tokens.is_none() && schema.as_array().is_some_and(|v| !v.is_empty()) {
            body["tools"] = schema;
            body["tool_choice"] = json!("auto");
        }
        if let Some(n) = summary_tokens.or(self.options.max_tokens) {
            body["max_tokens"] = json!(n);
        }
        if let Some(n) = self.options.temperature {
            body["temperature"] = json!(n);
        }
        if let Some(n) = self.options.top_p {
            body["top_p"] = json!(n);
        }
        if let Some(n) = self.options.seed {
            body["seed"] = json!(n);
        }
        if let Some(n) = &self.options.reasoning_effort {
            body["reasoning_effort"] = json!(n);
        }
        if let Some(n) = &self.options.thinking {
            body["thinking"] = n.clone();
        }
        body
    }
    pub async fn complete(
        &self,
        messages: &[Value],
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Reply, &'static str> {
        self.request(messages, None, cancel).await
    }
    pub async fn complete_with_observer(
        &self,
        messages: &[Value],
        cancel: &mut watch::Receiver<bool>,
        observer: &mut impl FnMut(ModelEvent),
    ) -> Result<Reply, &'static str> {
        let reply = self.complete(messages, cancel).await?;
        if self.options.show_thinking {
            if let Some(thinking) = reply
                .message
                .get("reasoning_content")
                .and_then(Value::as_str)
            {
                observer(ModelEvent::Thinking(thinking.to_owned()));
            }
        }
        if !reply.text.is_empty() {
            observer(ModelEvent::Text(reply.text.clone()));
        }
        Ok(reply)
    }
    pub async fn summarize(
        &self,
        messages: &[Value],
        max_tokens: u64,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<String, &'static str> {
        if !(1..=1_048_576).contains(&max_tokens) {
            return Err("invalid-context-options");
        }
        let reply = self.request(messages, Some(max_tokens), cancel).await?;
        if !reply.calls.is_empty() {
            return Err("invalid-model-response");
        }
        Ok(reply.text)
    }
    async fn request(
        &self,
        messages: &[Value],
        summary_tokens: Option<u64>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<Reply, &'static str> {
        let body = self.body(messages, summary_tokens);
        self.guard_content(&body.to_string())?;
        self.guard_json(&body, 0)?;
        for value in self.options.headers.values() {
            self.guard_content(value)?;
        }
        for attempt in 0..3 {
            if *cancel.borrow() {
                return Err("cancelled");
            }
            let request = async {
                let mut request = self
                    .client
                    .post(self.endpoint.clone())
                    .headers(self.headers.clone())
                    .json(&body);
                if self.options.stream {
                    request = request.header(reqwest::header::ACCEPT, "text/event-stream");
                }
                if self.options.auth == Auth::Bearer {
                    request = request.bearer_auth(&self.key);
                }
                let mut response = request.send().await.map_err(|_| "model-network-error")?;
                let status = response.status();
                if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                    return Err("model-retryable-error");
                }
                if !status.is_success() {
                    let mut bytes = Vec::new();
                    while let Some(chunk) =
                        response.chunk().await.map_err(|_| "model-network-error")?
                    {
                        if chunk.len() > self.response_limit.saturating_sub(bytes.len()) {
                            return Err("model-http-error");
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    return Err(
                        if matches!(status.as_u16(), 400 | 413 | 422) && context_overflow(&bytes) {
                            "model-context-overflow"
                        } else {
                            "model-http-error"
                        },
                    );
                }
                if response
                    .content_length()
                    .is_some_and(|n| n > self.response_limit as u64)
                {
                    return Err("model-response-too-large");
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(|_| "model-network-error")? {
                    if chunk.len() > self.response_limit.saturating_sub(bytes.len()) {
                        return Err("model-response-too-large");
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let reply = if self.options.stream {
                    parse_stream(&bytes)?
                } else {
                    parse_reply(&bytes)?
                };
                for call in &reply.calls {
                    let shell = matches!(call.name.as_str(), "shell" | "bash");
                    let editor = matches!(call.name.as_str(), "editor" | "str_replace_editor");
                    let expected = match self.tools.profile {
                        ToolProfile::Native => matches!(call.name.as_str(), "shell" | "editor"),
                        ToolProfile::Dsh => {
                            matches!(call.name.as_str(), "bash" | "str_replace_editor")
                        }
                    };
                    if !expected || (shell && !self.tools.shell) || (editor && !self.tools.editor) {
                        return Err("invalid-tool-call");
                    }
                }
                if summary_tokens.is_some() && !reply.calls.is_empty() {
                    return Err("invalid-model-response");
                }
                self.guard_content(&reply.message.to_string())?;
                self.guard_json(&reply.message, 0)?;
                Ok(reply)
            };
            let result = tokio::select! { biased; _ = cancellation(cancel) => Err("cancelled"), result = request => result };
            if !matches!(result, Err("model-retryable-error")) || attempt == 2 {
                return result;
            }
            tokio::select! { biased; _ = cancellation(cancel) => return Err("cancelled"), _ = tokio::time::sleep(std::time::Duration::from_millis(250 * (1 << attempt))) => {} }
        }
        Err("model-retryable-error")
    }
}

fn context_overflow(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let error = value.get("error").unwrap_or(&value);
    let code = error.get("code").and_then(Value::as_str).unwrap_or("");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        code,
        "context_length_exceeded"
            | "context_window_exceeded"
            | "max_context_length_exceeded"
            | "context-window-overflowed"
    ) || [
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "token limit",
        "input is too long for this model",
        "request too large for model context",
        "input exceeds the model context",
        "prompt exceeds the model context",
        "messages exceed the model context",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// Parse bounded SSE only after all bytes arrive, so fragmented UTF-8 and secrets
/// cannot become partially validated terminal output. Incomplete streams fail closed.
fn parse_stream(bytes: &[u8]) -> Result<Reply, &'static str> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "invalid-model-response")?
        .replace("\r\n", "\n");
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut calls: BTreeMap<usize, Value> = BTreeMap::new();
    let mut finish: Option<String> = None;
    let mut done = false;

    for event in text.split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .map(|v| v.strip_prefix(' ').unwrap_or(v))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        if done {
            return Err("invalid-model-response");
        }
        if data == "[DONE]" {
            done = true;
            continue;
        }
        let value: Value = serde_json::from_str(&data).map_err(|_| "invalid-model-response")?;
        if value.get("error").is_some() {
            return Err(if context_overflow(data.as_bytes()) {
                "model-context-overflow"
            } else {
                "model-http-error"
            });
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or("invalid-model-response")?;
        if choices.is_empty() && value.get("usage").is_some() {
            continue;
        }
        if choices.len() != 1 || choices[0].get("index").and_then(Value::as_u64).unwrap_or(0) != 0 {
            return Err("invalid-model-response");
        }
        let choice = &choices[0];
        let delta = choice
            .get("delta")
            .and_then(Value::as_object)
            .ok_or("invalid-model-response")?;
        if let Some(role) = delta.get("role") {
            if role.as_str() != Some("assistant") {
                return Err("invalid-model-response");
            }
        }
        let mut has_delta = false;
        for (name, output) in [
            ("content", &mut content),
            ("reasoning_content", &mut reasoning),
        ] {
            match delta.get(name) {
                Some(Value::String(value)) => {
                    has_delta |= !value.is_empty();
                    output.push_str(value);
                }
                None | Some(Value::Null) => {}
                _ => return Err("invalid-model-response"),
            }
        }
        if let Some(tool_calls) = delta.get("tool_calls") {
            for call in tool_calls.as_array().ok_or("invalid-tool-call")? {
                has_delta = true;
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .filter(|n| *n < 256)
                    .ok_or("invalid-tool-call")? as usize;
                let entry = calls.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                if let Some(kind) = call.get("type") {
                    if kind.as_str() != Some("function") {
                        return Err("invalid-tool-call");
                    }
                }
                if let Some(id) = call.get("id") {
                    append_fragment(&mut entry["id"], id)?;
                }
                if let Some(function) = call.get("function") {
                    if !function.is_object() {
                        return Err("invalid-tool-call");
                    }
                    for name in ["name", "arguments"] {
                        if let Some(fragment) = function.get(name) {
                            append_fragment(&mut entry["function"][name], fragment)?;
                        }
                    }
                }
            }
        }
        if finish.is_some() && has_delta {
            return Err("invalid-model-response");
        }
        match choice.get("finish_reason") {
            Some(Value::String(value)) if finish.is_none() => finish = Some(value.clone()),
            None | Some(Value::Null) => {}
            _ => return Err("invalid-model-response"),
        }
    }
    if !done || finish.is_none() || !calls.keys().copied().eq(0..calls.len()) {
        return Err("incomplete-model-response");
    }
    let mut message = json!({"role":"assistant","content":content});
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls.into_values().collect::<Vec<_>>());
    }
    parse_reply(
        json!({"choices":[{"finish_reason":finish,"message":message}]})
            .to_string()
            .as_bytes(),
    )
}
fn append_fragment(target: &mut Value, fragment: &Value) -> Result<(), &'static str> {
    let value = fragment.as_str().ok_or("invalid-tool-call")?;
    target.as_str().ok_or("invalid-tool-call")?;
    let mut text = target.as_str().unwrap_or("").to_owned();
    text.push_str(value);
    *target = json!(text);
    Ok(())
}

pub async fn cancellation(cancel: &mut watch::Receiver<bool>) {
    while !*cancel.borrow() {
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

/// Standalone startup adopts ambient routing only when no host policy exists.
fn initialize_network() -> Result<(), &'static str> {
    static STARTUP: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = STARTUP
        .lock()
        .map_err(|_| "network-initialization-failed")?;
    if cognia_net::proxy_config::runtime_status().state == "uninitialized" {
        let config = cognia_net::proxy_config::ProxyConfig::from_environment(|name| {
            std::env::var(name).ok()
        })
        .map_err(|_| "network-initialization-failed")?
        .unwrap_or_default();
        cognia_net::proxy_config::apply_current(config)
            .map_err(|_| "network-initialization-failed")?;
    }
    Ok(())
}

pub fn parse_reply(bytes: &[u8]) -> Result<Reply, &'static str> {
    let response: Value = serde_json::from_slice(bytes).map_err(|_| "invalid-model-response")?;
    let choices = response
        .get("choices")
        .and_then(Value::as_array)
        .filter(|v| v.len() == 1)
        .ok_or("invalid-model-response")?;
    let choice = &choices[0];
    let original = choice.get("message").ok_or("invalid-model-response")?;
    if original.get("role").and_then(Value::as_str) != Some("assistant") {
        return Err("invalid-model-response");
    }
    let text = match original.get("content") {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        _ => return Err("invalid-model-response"),
    };
    let mut calls = Vec::new();
    let mut ids = HashSet::new();
    if let Some(value) = original.get("tool_calls") {
        let raw = value
            .as_array()
            .filter(|v| v.len() <= 256)
            .ok_or("invalid-tool-call")?;
        for call in raw {
            if call.get("type").and_then(Value::as_str) != Some("function") {
                return Err("invalid-tool-call");
            }
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
                .ok_or("invalid-tool-call")?
                .to_owned();
            if !ids.insert(id.clone()) {
                return Err("invalid-tool-call");
            }
            let function = call.get("function").ok_or("invalid-tool-call")?;
            let name = function
                .get("name")
                .and_then(Value::as_str)
                .ok_or("invalid-tool-call")?
                .to_owned();
            let args: Value = serde_json::from_str(
                function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .ok_or("invalid-tool-call")?,
            )
            .map_err(|_| "invalid-tool-call")?;
            validate_call(&name, &args).map_err(|_| "invalid-tool-call")?;
            calls.push(Call { id, name, args });
        }
    }
    let finish = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .ok_or("invalid-model-response")?;
    if (calls.is_empty() && (finish != "stop" || text.trim().is_empty()))
        || (!calls.is_empty() && finish != "tool_calls")
    {
        return Err("incomplete-model-response");
    }
    // Forward only protocol fields; provider metadata is never persisted or echoed.
    let mut message = json!({"role":"assistant","content":text});
    match original.get("reasoning_content") {
        Some(Value::String(reasoning)) => {
            message["reasoning_content"] = json!(reasoning);
        }
        None | Some(Value::Null) => {}
        _ => return Err("invalid-model-response"),
    }
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls.iter().map(|c| json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.args.to_string()}})).collect::<Vec<_>>());
    }
    Ok(Reply {
        message,
        calls,
        text,
    })
}

/// Whole exchanges are pruned together; the original task/system remain anchored.
#[cfg(test)]
pub fn bounded_history(
    base: &[Value],
    exchanges: &mut Vec<Vec<Value>>,
    limit: usize,
) -> Result<Vec<Value>, &'static str> {
    loop {
        let history: Vec<Value> = base
            .iter()
            .cloned()
            .chain(exchanges.iter().flatten().cloned())
            .collect();
        if serde_json::to_vec(&history)
            .map_err(|_| "invalid-context")?
            .len()
            <= limit
        {
            return Ok(history);
        }
        if exchanges.len() <= 1 {
            return Err("context-budget-exhausted");
        }
        exchanges.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sse(events: &[Value], done: bool) -> Vec<u8> {
        let mut text = events
            .iter()
            .map(|v| format!("data: {}\r\n\r\n", v))
            .collect::<String>();
        if done {
            text.push_str("data: [DONE]\r\n\r\n");
        }
        text.into_bytes()
    }
    #[test]
    fn sse_reassembles_text_reasoning_and_tool_arguments() {
        let events = vec![
            json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"你","reasoning_content":"Inspect "},"finish_reason":null}]}),
            json!({"choices":[{"index":0,"delta":{"content":"好","reasoning_content":"workspace.","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"shell","arguments":"{\"command\":"}}]},"finish_reason":null}]}),
            json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"total_tokens":20}}),
        ];
        let reply = parse_stream(&sse(&events, true)).unwrap();
        assert_eq!(reply.text, "你好");
        assert_eq!(reply.message["reasoning_content"], "Inspect workspace.");
        assert_eq!(reply.calls[0].args["command"], "pwd");
        assert_eq!(
            parse_stream(&sse(&events, false)).err(),
            Some("incomplete-model-response")
        );
    }
    #[test]
    fn sse_rejects_invalid_calls_and_post_finish_deltas() {
        for events in [
            vec![
                json!({"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}),
                json!({"choices":[{"delta":{"content":"extra"},"finish_reason":null}]}),
            ],
            vec![
                json!({"choices":[{"delta":{"tool_calls":[{"index":256,"function":{"name":"shell","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}),
            ],
            vec![
                json!({"choices":[{"delta":{"tool_calls":[{"index":1,"id":"a","function":{"name":"shell","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}),
            ],
        ] {
            assert!(parse_stream(&sse(&events, true)).is_err());
        }
    }
    #[test]
    fn sse_context_overflow_supports_recovery_without_raw_diagnostics() {
        let events = [
            json!({"error":{"code":"context-window-overflowed","message":"private raw diagnostic"}}),
        ];
        assert_eq!(
            parse_stream(&sse(&events, true)).err(),
            Some("model-context-overflow")
        );
        let events = [json!({"error":{"message":"private ordinary error"}})];
        assert_eq!(
            parse_stream(&sse(&events, true)).err(),
            Some("model-http-error")
        );
    }
    #[tokio::test]
    async fn unauthenticated_provider_still_guards_declared_ambient_key() {
        let server = wiremock::MockServer::start().await;
        let name = format!("COGNIA_BOOTSTRAP_TEST_{}", uuid::Uuid::new_v4().simple());
        std::env::set_var(&name, "synthetic-ambient-key-opaque");
        let config = Config::parse(&json!({"version":1,"task":"prepare","model":{"baseUrl":server.uri(),"model":"local","auth":"none","apiKeyEnv":name}}).to_string()).unwrap();
        let client = ModelClient::from_config(&config).unwrap();
        assert_eq!(
            client
                .guard_messages(&[json!({"role":"user","content":"synthetic-ambient-key-opaque"})]),
            Err("outbound-pii-blocked")
        );
        let (_sender, mut cancel) = watch::channel(false);
        assert_eq!(
            client
                .complete(
                    &[json!({"role":"user","content":"synthetic-ambient-key-opaque"})],
                    &mut cancel
                )
                .await
                .err(),
            Some("outbound-pii-blocked")
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 0);
        std::env::remove_var(name);
    }
    #[tokio::test]
    async fn custom_transport_summary_and_streaming_are_guarded() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let config = Config::parse(&json!({"version":1,"task":"prepare","model":{"baseUrl":server.uri(),"endpointPath":"custom/completions","model":"custom","auth":"header","apiKeyHeader":"x-model-key","stream":true,"showThinking":true,"maxTokens":256,"temperature":0.5,"headers":{"x-project":"project"},"extraBody":{"parallel_tool_calls":false}},"tools":{"shell":false,"editor":false}}).to_string()).unwrap();
        let events = [
            json!({"choices":[{"delta":{"role":"assistant","content":"ready","reasoning_content":"safe thought"},"finish_reason":"stop"}]}),
        ];
        Mock::given(method("POST"))
            .and(path("/custom/completions"))
            .and(header("x-model-key", "synthetic-key"))
            .and(header("x-project", "project"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("Content-Type", "text/event-stream")
                    .set_body_bytes(sse(&events, true)),
            )
            .mount(&server)
            .await;
        let client = ModelClient::new(&config, "synthetic-key".into()).unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let messages = [json!({"role":"user","content":"prepare"})];
        let mut displayed = Vec::new();
        client
            .complete_with_observer(&messages, &mut cancel, &mut |event| match event {
                ModelEvent::Text(s) | ModelEvent::Thinking(s) => displayed.push(s),
            })
            .await
            .unwrap();
        assert_eq!(displayed, ["safe thought", "ready"]);
        assert_eq!(
            client.summarize(&messages, 32, &mut cancel).await.unwrap(),
            "ready"
        );
        let requests = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(body["max_tokens"], 32);
        assert!(body.get("tools").is_none());
        assert_eq!(body["parallel_tool_calls"], false);
        assert!(requests[0].headers.get("authorization").is_none());
        assert!(client
            .guard_messages(&[json!({"content":"synthetic-key"})])
            .is_err());
    }
    #[tokio::test]
    async fn fragmented_stream_and_secret_never_emit_partial_output() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let config = Config::parse(&json!({"version":1,"task":"prepare","model":{"baseUrl":server.uri(),"model":"test","stream":true,"auth":"none"}}).to_string()).unwrap();
        let events = [
            json!({"choices":[{"delta":{"content":"synthetic-"},"finish_reason":null}]}),
            json!({"choices":[{"delta":{"content":"credential"},"finish_reason":"stop"}]}),
        ];
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(sse(&events, true)))
            .mount(&server)
            .await;
        let client = ModelClient::new(&config, "synthetic-credential".into()).unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let mut emitted = false;
        assert_eq!(
            client
                .complete_with_observer(
                    &[json!({"role":"user","content":"prepare"})],
                    &mut cancel,
                    &mut |_| emitted = true
                )
                .await
                .err(),
            Some("outbound-pii-blocked")
        );
        assert!(!emitted);
    }
    #[tokio::test]
    async fn chunked_http_fragments_utf8_events_and_cancels_mid_stream() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for cancel_mid_stream in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let events = [
                json!({"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":"stop"}]}),
            ];
            let bytes = sse(&events, true);
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    let size = socket.read(&mut buffer).await.unwrap();
                    if size == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..size]);
                    if let Some(header_end) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..header_end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= header_end + 4 + length {
                            break;
                        }
                    }
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
                if cancel_mid_stream {
                    socket.write_all(b"1\r\nd\r\n").await.unwrap();
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    return;
                }
                for byte in bytes {
                    socket
                        .write_all(&[b'1', b'\r', b'\n', byte, b'\r', b'\n'])
                        .await
                        .unwrap();
                }
                socket.write_all(b"0\r\n\r\n").await.unwrap();
            });
            let config=Config::parse(&json!({"version":1,"task":"prepare","model":{"baseUrl":format!("http://{address}"),"model":"local","auth":"none","stream":true}}).to_string()).unwrap();
            let client = ModelClient::from_config(&config).unwrap();
            let (sender, mut cancel) = watch::channel(false);
            let cancel_task = if cancel_mid_stream {
                Some(tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let _ = sender.send(true);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }))
            } else {
                None
            };
            let result = client
                .complete(&[json!({"role":"user","content":"prepare"})], &mut cancel)
                .await;
            if cancel_mid_stream {
                assert_eq!(result.err(), Some("cancelled"));
                server.abort();
            } else {
                assert_eq!(result.unwrap().text, "你好");
                server.await.unwrap();
            }
            if let Some(task) = cancel_task {
                task.abort();
            }
        }
    }
    #[tokio::test]
    async fn context_overflow_has_sanitized_error_code() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let config=Config::parse(&json!({"version":1,"task":"prepare","model":{"baseUrl":server.uri(),"model":"test","auth":"none"}}).to_string()).unwrap();
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(400).set_body_json(json!({"error":{"code":"context_length_exceeded","message":"secret raw diagnostic"}}))).mount(&server).await;
        let client = ModelClient::from_config(&config).unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        assert_eq!(
            client
                .complete(&[json!({"role":"user","content":"prepare"})], &mut cancel)
                .await
                .err(),
            Some("model-context-overflow")
        );
    }
    #[test]
    fn dsh_schema_keeps_provider_parameters_explicit() {
        let config=Config::parse(r#"{"version":1,"task":"prepare","model":{"baseUrl":"https://example.org","model":"test","reasoningEffort":"none","thinking":{"type":"disabled"}},"tools":{"profile":"dsh"}}"#).unwrap();
        let client = ModelClient::new(&config, "synthetic-key".into()).unwrap();
        let body = client.body(&[], None);
        assert_eq!(body["thinking"]["type"], "disabled");
        assert_eq!(body["reasoning_effort"], "none");
        assert_eq!(body["tools"][0]["function"]["name"], "bash");
        assert_eq!(body["tools"][1]["function"]["name"], "str_replace_editor");
    }
    #[test]
    fn gate_blocks_secret_and_pii() {
        assert!(guard("contact user@example.org", "").is_err());
        assert!(guard("secret-test-value", "secret-test-value").is_err());
        assert!(guard("prepare project", "secret-test-value").is_ok());
    }
    #[test]
    fn validates_all_calls_before_dispatch() {
        let v = json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"a","type":"function","function":{"name":"shell","arguments":"{\"command\":\"touch marker\"}"}},{"id":"b","type":"function","function":{"name":"unknown","arguments":"{}"}}]}}]});
        assert!(parse_reply(v.to_string().as_bytes()).is_err());
    }
    #[test]
    fn rejects_truncated_responses() {
        let v = json!({"choices":[{"finish_reason":"length","message":{"role":"assistant","content":"ready"}}]});
        assert!(parse_reply(v.to_string().as_bytes()).is_err());
    }
    #[test]
    fn preserves_validated_reasoning_content_with_complete_tool_exchange() {
        let mut value = json!({"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"reasoning_content":"Inspect the workspace before acting.","tool_calls":[{"id":"a","type":"function","function":{"name":"shell","arguments":"{\"command\":\"pwd\"}"}}]}}]});
        let reply = parse_reply(value.to_string().as_bytes()).unwrap();
        assert_eq!(
            reply.message["reasoning_content"],
            "Inspect the workspace before acting."
        );
        let exchange = vec![
            reply.message,
            json!({"role":"tool","tool_call_id":"a","content":"workspace"}),
        ];
        let history = bounded_history(&[], &mut vec![exchange.clone()], 4096).unwrap();
        assert_eq!(history, exchange);
        value["choices"][0]["message"]["reasoning_content"] = json!({"invalid":"object"});
        assert_eq!(
            parse_reply(value.to_string().as_bytes()).err(),
            Some("invalid-model-response")
        );
    }
    #[test]
    fn prunes_complete_exchange() {
        let base = vec![json!({"role":"user","content":"task"})];
        let newest = vec![
            json!({"role":"assistant","tool_calls":[{"id":"b"}]}),
            json!({"role":"tool","tool_call_id":"b","content":"ok"}),
        ];
        let mut exchanges = vec![vec![json!({"content":"x".repeat(1000)})], newest.clone()];
        let history = bounded_history(&base, &mut exchanges, 500).unwrap();
        assert_eq!(&history[1..], &newest);
        assert_eq!(exchanges.len(), 1);
    }
    #[test]
    fn parses_proxy_environment_without_real_environment_changes() {
        let config = cognia_net::proxy_config::ProxyConfig::from_environment(|name| match name {
            "HTTPS_PROXY" => Some("http://127.0.0.1:9999".into()),
            "NO_PROXY" => Some("local.example".into()),
            _ => None,
        })
        .unwrap()
        .unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 9999);
        assert!(config.bypass.iter().any(|host| host == "local.example"));
        assert!(
            cognia_net::proxy_config::ProxyConfig::from_environment(|_| None)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn decoded_json_and_terminal_controls_cannot_hide_exact_credentials() {
        cognia_net::proxy_config::ensure_crypto_provider();
        let client = ModelClient {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            endpoint: url::Url::parse("https://example.org").unwrap(),
            model: "test".into(),
            key: "a\"short\\key".into(),
            response_limit: 1024,
            secrets: vec!["custom-value".into()],
            options: Config::parse(r#"{"version":1,"task":"x","model":{"baseUrl":"https://example.org","model":"test"}}"#).unwrap().model,
            tools: ToolConfig::default(),
            headers: reqwest::header::HeaderMap::new(),
        };
        let content = json!({"output":"a\"short\\key"}).to_string();
        assert!(client.guard_json(&json!({"content":content}), 0).is_err());
        assert!(client.guard_content("custom-\u{1b}[31mvalue").is_err());
        assert!(client
            .guard_json(&json!({"user\u{1b}[31m@example.org":"value"}), 0)
            .is_err());
        let mut object = serde_json::Map::new();
        object.insert(client.key.clone(), json!("safe-value"));
        assert!(client.guard_json(&Value::Object(object), 0).is_err());
    }
    #[tokio::test]
    async fn retries_only_transient_status_and_caps_body_and_redirects() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        for (status, attempts, expected) in [
            (429, 3, "model-retryable-error"),
            (503, 3, "model-retryable-error"),
            (401, 1, "model-http-error"),
            (302, 1, "model-http-error"),
            (200, 1, "model-response-too-large"),
        ] {
            let server = MockServer::start().await;
            let c = Config::parse(&json!({"version":1,"task":"prepare","model":{"baseUrl":format!("{}/v1",server.uri()),"model":"test"},"limits":{"maxResponseBytes":1024}}).to_string()).unwrap();
            let response = ResponseTemplate::new(status)
                .insert_header("Location", format!("{}/other", server.uri()))
                .set_body_string("x".repeat(2048));
            Mock::given(method("POST"))
                .respond_with(response)
                .mount(&server)
                .await;
            let client = ModelClient::new(&c, "synthetic-model-key".into()).unwrap();
            let (_sender, mut cancel) = watch::channel(false);
            let result = client
                .complete(&[json!({"role":"user","content":"prepare"})], &mut cancel)
                .await;
            assert_eq!(result.err(), Some(expected));
            assert_eq!(server.received_requests().await.unwrap().len(), attempts);
        }
    }
}
