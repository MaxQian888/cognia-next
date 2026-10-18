//! Final-wire SIWC policy shared by native chat and the Codex loopback proxy.
use super::{SiwcAccessLease, SiwcManager};
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::watch;

const MAX_BODY: usize = 16 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
const MAX_UPSTREAM_CHUNK: usize = 2 * 1024 * 1024;
const IDLE_MS: i64 = 60_000;

pub type Authority = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHead {
    pub stream_id: String,
    pub status: u16,
    pub headers: HashMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseChunk {
    pub done: bool,
    pub chunk_base64: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub slug: String,
    pub display_name: String,
    pub visibility: String,
}

#[derive(Default)]
struct Terminal {
    pending: Vec<u8>,
    data: Vec<u8>,
    completed: bool,
    failure: Option<&'static str>,
}
impl Terminal {
    fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > MAX_UPSTREAM_CHUNK {
            return Err("siwc_event_too_large".into());
        }
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = line.trim_ascii_end();
            if line.is_empty() {
                self.dispatch()?;
            } else if let Some(data) = line.strip_prefix(b"data:") {
                if self.data.len() + data.len() > MAX_UPSTREAM_CHUNK {
                    return Err("siwc_event_too_large".into());
                }
                if !self.data.is_empty() {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(data);
            }
        }
        Ok(())
    }
    fn dispatch(&mut self) -> Result<(), String> {
        if self.data.is_empty() {
            return Ok(());
        }
        let data = std::mem::take(&mut self.data);
        if data.trim_ascii() == b"[DONE]" {
            return Ok(());
        }
        let value: Value = serde_json::from_slice(&data).map_err(|_| "siwc_invalid_event")?;
        match value.get("type").and_then(Value::as_str) {
            Some("response.completed") => self.completed = true,
            Some("response.incomplete") => self.failure = Some("siwc_response_incomplete"),
            Some("response.failed" | "error") => {
                self.failure = Some(
                    value
                        .pointer("/response/error/code")
                        .or_else(|| value.pointer("/error/code"))
                        .or_else(|| value.get("code"))
                        .and_then(Value::as_str)
                        .and_then(known_upstream_code)
                        .unwrap_or("siwc_response_failed"),
                )
            }
            _ => {}
        }
        Ok(())
    }
    fn finish(&self) -> Result<(), String> {
        if let Some(code) = self.failure {
            Err(code.into())
        } else if !self.completed {
            Err("siwc_response_missing_terminal".into())
        } else {
            Ok(())
        }
    }
}

struct Reader {
    response: Option<reqwest::Response>,
    pending: Vec<u8>,
    terminal: Terminal,
}
struct Request {
    connection: String,
    cancel: watch::Sender<bool>,
    last_read: AtomicI64,
    reader: tokio::sync::Mutex<Reader>,
    lease: tokio::sync::Mutex<Option<SiwcAccessLease>>,
}
#[derive(Default)]
struct Admission {
    requests: HashMap<String, Arc<Request>>,
    blocked: HashSet<String>,
    closed: bool,
    retired: HashMap<String, i64>,
}

struct RequestGuard<'a> {
    hub: &'a Responses,
    id: String,
    request: Arc<Request>,
    keep: bool,
}
impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        if !self.keep {
            self.request.cancel.send_replace(true);
            self.hub.finish(&self.id, &self.request);
        }
    }
}
/// One unlocked profile generation owns a hub. No URL, Authorization header,
/// credential or retry destination can be supplied by JavaScript or Codex.
pub struct Responses {
    manager: SiwcManager,
    authority: Authority,
    http: reqwest::Client,
    admission: Mutex<Admission>,
    base_url: String,
}

impl Responses {
    #[cfg(test)]
    pub(super) fn with_test_base_url(
        manager: SiwcManager,
        authority: Authority,
        base_url: String,
    ) -> Arc<Self> {
        cognia_net::proxy_config::ensure_crypto_provider();
        Arc::new(Self {
            manager,
            authority,
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            admission: Mutex::new(Admission::default()),
            base_url,
        })
    }
    pub fn new(manager: SiwcManager, authority: Authority) -> Result<Arc<Self>, String> {
        let base_url = "https://api.openai.com/v1".to_string();
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .user_agent("Cognia-SIWC/1");
        let http = cognia_net::proxy_config::managed_client(builder, &base_url)
            .map_err(|_| "siwc_network_unavailable")?;
        Ok(Arc::new(Self {
            manager,
            authority,
            http,
            admission: Mutex::new(Admission::default()),
            base_url,
        }))
    }

    pub fn cancel(&self, id: &str) {
        let mut admission = self.admission.lock();
        retire(&mut admission, id);
        if let Some(request) = admission.requests.remove(id) {
            request.cancel.send_replace(true);
        }
    }
    pub fn cancel_connection(&self, id: &str) {
        let mut admission = self.admission.lock();
        admission.blocked.insert(id.into());
        admission.requests.retain(|_, request| {
            if request.connection == id {
                request.cancel.send_replace(true);
                false
            } else {
                true
            }
        });
    }
    pub fn allow_connection(&self, id: &str) {
        self.admission.lock().blocked.remove(id);
    }
    pub fn check_connection(&self, id: &str) -> Result<(), String> {
        (self.authority)()?;
        let admission = self.admission.lock();
        if admission.closed || admission.blocked.contains(id) {
            Err("siwc_connection_revoked".into())
        } else {
            Ok(())
        }
    }
    pub fn cancel_all(&self) {
        let mut admission = self.admission.lock();
        admission.closed = true;
        for (_, request) in admission.requests.drain() {
            request.cancel.send_replace(true);
        }
    }
    fn finish(&self, id: &str, request: &Arc<Request>) {
        let mut admission = self.admission.lock();
        let requests = &mut admission.requests;
        if requests
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, request))
        {
            requests.remove(id);
            retire(&mut admission, id);
        }
    }

    fn admit(&self, connection: &str, request_id: &str) -> Result<Arc<Request>, String> {
        self.check_connection(connection)?;
        let (cancel, _) = watch::channel(false);
        let request = Arc::new(Request {
            connection: connection.into(),
            cancel,
            last_read: AtomicI64::new(super::now_ms()),
            reader: tokio::sync::Mutex::new(Reader {
                response: None,
                pending: Vec::new(),
                terminal: Terminal::default(),
            }),
            lease: tokio::sync::Mutex::new(None),
        });
        {
            let mut admission = self.admission.lock();
            admission
                .retired
                .retain(|_, deadline| *deadline > super::now_ms());
            if admission.retired.contains_key(request_id) {
                return Err("siwc_cancelled".into());
            }
            if admission.closed || admission.blocked.contains(connection) {
                return Err("siwc_connection_revoked".into());
            }
            let requests = &mut admission.requests;
            requests.retain(|_, r| {
                if super::now_ms() - r.last_read.load(Ordering::Relaxed) > IDLE_MS {
                    r.cancel.send_replace(true);
                    false
                } else {
                    true
                }
            });
            if requests.len() >= 32 || requests.contains_key(request_id) {
                return Err("siwc_busy".into());
            }
            requests.insert(request_id.into(), request.clone());
        }
        Ok(request)
    }

    pub async fn open(
        self: &Arc<Self>,
        connection: &str,
        request_id: &str,
        body: &str,
    ) -> Result<ResponseHead, String> {
        self.check_connection(connection)?;
        if body.len() > MAX_BODY {
            return Err("siwc_request_too_large".into());
        }
        if uuid::Uuid::parse_str(request_id).is_err() {
            return Err("siwc_invalid_request_id".into());
        }
        // Omitted storage is a privacy default, never an inferred user limit.
        let mut value: Value = serde_json::from_str(body).map_err(|_| "siwc_invalid_request")?;
        if value.get("store").is_none() {
            value
                .as_object_mut()
                .ok_or("siwc_invalid_request")?
                .insert("store".into(), Value::Bool(false));
        }
        // Namespaces preserve function names and are the documented SIWC wire
        // form. No tool is removed or granted a different implementation.
        if let Some(tools) = value.get_mut("tools").and_then(Value::as_array_mut) {
            let mut local = Vec::new();
            tools.retain(|tool| {
                if matches!(
                    tool.get("type").and_then(Value::as_str),
                    Some("function" | "custom")
                ) {
                    local.push(tool.clone());
                    false
                } else {
                    true
                }
            });
            if !local.is_empty() {
                tools.push(serde_json::json!({"type":"namespace","name":"functions","description":"Cognia tools","tools":local}));
            }
        }
        let body = serde_json::to_string(&value).map_err(|_| "siwc_invalid_request")?;
        validate_body(&body)?;
        let request = self.admit(connection, request_id)?;
        let mut guard = RequestGuard {
            hub: self,
            id: request_id.into(),
            request: request.clone(),
            keep: false,
        };
        let weak = Arc::downgrade(self);
        let weak_request = Arc::downgrade(&request);
        let id = request_id.to_owned();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let (Some(hub), Some(request)) = (weak.upgrade(), weak_request.upgrade()) else {
                    return;
                };
                if super::now_ms() - request.last_read.load(Ordering::Relaxed) > IDLE_MS {
                    request.cancel.send_replace(true);
                    hub.finish(&id, &request);
                    return;
                }
                if *request.cancel.borrow() {
                    return;
                }
            }
        });
        let mut cancelled = request.cancel.subscribe();
        if *cancelled.borrow() {
            self.finish(request_id, &request);
            return Err("siwc_cancelled".into());
        }
        let operation = async {
            let lease = self.manager.acquire_access(connection, false).await?;
            self.check_connection(connection)?;
            self.manager.validate_lease(&lease).await?;
            let response = self
                .http
                .post(format!("{}/responses", self.base_url))
                .bearer_auth(&lease.access_token)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .body(body)
                .send()
                .await
                .map_err(|_| "siwc_network_error")?;
            (self.authority)()?;
            self.manager.validate_lease(&lease).await?;
            if !response.status().is_success() {
                return Err(upstream_error(response).await);
            }
            if !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.starts_with("text/event-stream"))
            {
                return Err("siwc_invalid_stream".into());
            }
            let status = response.status().as_u16();
            *request.lease.lock().await = Some(lease);
            request.reader.lock().await.response = Some(response);
            Ok(ResponseHead {
                stream_id: request_id.into(),
                status,
                headers: HashMap::from([("content-type".into(), "text/event-stream".into())]),
            })
        };
        let result = tokio::select! {
            biased;
            _=cancelled.changed()=>Err("siwc_cancelled".into()),
            result=tokio::time::timeout(Duration::from_secs(45),operation)=>result.map_err(|_|"siwc_request_timeout".to_string()).and_then(|r|r),
        };
        if result.is_err() {
            self.finish(request_id, &request);
            request.cancel.send_replace(true);
        }
        guard.keep = result.is_ok();
        result
    }

    pub async fn read(&self, id: &str) -> Result<ResponseChunk, String> {
        (self.authority)()?;
        let request = self
            .admission
            .lock()
            .requests
            .get(id)
            .cloned()
            .ok_or("siwc_stream_missing")?;
        let mut guard = RequestGuard {
            hub: self,
            id: id.into(),
            request: request.clone(),
            keep: false,
        };
        let mut cancelled = request.cancel.subscribe();
        if *cancelled.borrow() {
            return Err("siwc_cancelled".into());
        }
        request.last_read.store(super::now_ms(), Ordering::Relaxed);
        let operation = async {
            let lease = request.lease.lock().await;
            self.manager
                .validate_lease(lease.as_ref().ok_or("siwc_stream_not_ready")?)
                .await?;
            drop(lease);
            let mut reader = request.reader.lock().await;
            if reader.pending.is_empty() {
                let bytes = reader
                    .response
                    .as_mut()
                    .ok_or("siwc_stream_not_ready")?
                    .chunk()
                    .await
                    .map_err(|_| "siwc_stream_interrupted")?;
                (self.authority)()?;
                {
                    let lease = request.lease.lock().await;
                    self.manager
                        .validate_lease(lease.as_ref().ok_or("siwc_stream_not_ready")?)
                        .await?;
                }
                match bytes {
                    Some(bytes) => {
                        if bytes.len() > MAX_UPSTREAM_CHUNK {
                            return Err("siwc_event_too_large".into());
                        }
                        reader.terminal.push(&bytes)?;
                        reader.pending = bytes.to_vec();
                    }
                    None => {
                        reader.terminal.finish()?;
                        return Ok(ResponseChunk {
                            done: true,
                            chunk_base64: None,
                        });
                    }
                }
            }
            let count = CHUNK.min(reader.pending.len());
            let bytes: Vec<_> = reader.pending.drain(..count).collect();
            Ok(ResponseChunk {
                done: false,
                chunk_base64: Some(STANDARD.encode(bytes)),
            })
        };
        let result = tokio::select! {
            biased;
            _=cancelled.changed()=>Err("siwc_cancelled".into()),
            result=tokio::time::timeout(Duration::from_secs(60),operation)=>result.map_err(|_|"siwc_stream_timeout".to_string()).and_then(|r|r),
        };
        if !matches!(&result,Ok(chunk) if !chunk.done) {
            self.finish(id, &request);
            request.cancel.send_replace(true);
        }
        guard.keep = matches!(&result,Ok(chunk) if !chunk.done);
        result
    }

    pub async fn models(&self, connection: &str) -> Result<Vec<Model>, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let request = self.admit(connection, &id)?;
        let _guard = RequestGuard {
            hub: self,
            id,
            request: request.clone(),
            keep: false,
        };
        let mut cancelled = request.cancel.subscribe();
        if *cancelled.borrow() {
            return Err("siwc_cancelled".into());
        }
        tokio::select! {
            biased;
            _=cancelled.changed()=>Err("siwc_cancelled".into()),
            result=tokio::time::timeout(Duration::from_secs(45),self.fetch_models(connection))=>result.map_err(|_|"siwc_request_timeout".to_string()).and_then(|r|r),
        }
    }

    async fn fetch_models(&self, connection: &str) -> Result<Vec<Model>, String> {
        self.check_connection(connection)?;
        let lease = self.manager.acquire_access(connection, false).await?;
        (self.authority)()?;
        let mut response = self
            .http
            .get(format!("{}/models", self.base_url))
            .bearer_auth(&lease.access_token)
            .send()
            .await
            .map_err(|_| "siwc_network_error")?;
        if !response.status().is_success() {
            return Err(upstream_error(response).await);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "siwc_network_error")? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("siwc_catalog_invalid".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        (self.authority)()?;
        self.manager.validate_lease(&lease).await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "siwc_catalog_invalid")?;
        value
            .get("models")
            .and_then(Value::as_array)
            .ok_or("siwc_catalog_invalid")?
            .iter()
            .map(|item| {
                let slug = item
                    .get("slug")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("siwc_catalog_invalid")?;
                let visibility = item
                    .get("visibility")
                    .and_then(Value::as_str)
                    .ok_or("siwc_catalog_invalid")?;
                Ok(Model {
                    slug: slug.into(),
                    display_name: item
                        .get("display_name")
                        .and_then(Value::as_str)
                        .unwrap_or(slug)
                        .into(),
                    visibility: visibility.into(),
                })
            })
            .collect()
    }
}

fn retire(admission: &mut Admission, id: &str) {
    admission
        .retired
        .retain(|_, deadline| *deadline > super::now_ms());
    if admission.retired.len() >= 1024 {
        if let Some(oldest) = admission
            .retired
            .iter()
            .min_by_key(|(_, deadline)| **deadline)
            .map(|(id, _)| id.clone())
        {
            admission.retired.remove(&oldest);
        }
    }
    admission
        .retired
        .insert(id.into(), super::now_ms() + 300000);
}

fn known_upstream_code(code: &str) -> Option<&'static str> {
    match code {
        "subscription_sharing_user_not_eligible" => Some("subscription_sharing_user_not_eligible"),
        "subscription_sharing_usage_limit_exceeded" => {
            Some("subscription_sharing_usage_limit_exceeded")
        }
        "subscription_sharing_usage_unavailable" => Some("subscription_sharing_usage_unavailable"),
        "subscription_sharing_unsupported_capability" => {
            Some("subscription_sharing_unsupported_capability")
        }
        "subscription_sharing_route_not_supported" => {
            Some("subscription_sharing_route_not_supported")
        }
        "subscription_sharing_invalid_user" => Some("subscription_sharing_invalid_user"),
        "chatpass_v2_scope_not_authorized" => Some("chatpass_v2_scope_not_authorized"),
        "chatpass_v2_invalid_authorization_context" => {
            Some("chatpass_v2_invalid_authorization_context")
        }
        "subscription_sharing_user_unavailable" => Some("subscription_sharing_user_unavailable"),
        _ => None,
    }
}

async fn upstream_error(response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let value: Value = super::oidc::bounded_document(response)
        .await
        .unwrap_or_default();
    value
        .pointer("/error/code")
        .and_then(Value::as_str)
        .and_then(known_upstream_code)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("siwc_upstream_status_{status}"))
}

/// Preserve caller semantics: reject unsupported options instead of dropping
/// generation limits, tools, or history and silently running a different turn.
pub fn validate_body(body: &str) -> Result<(), String> {
    if body.len() > MAX_BODY {
        return Err("siwc_request_too_large".into());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "siwc_invalid_request")?;
    let object = value.as_object().ok_or("siwc_invalid_request")?;
    const ALLOWED: &[&str] = &[
        "model",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "include",
        "text",
        "store",
        "stream",
        "prompt_cache_key",
        "stream_options",
        "service_tier",
    ];
    if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("siwc_unsupported_option".into());
    }
    if object
        .get("service_tier")
        .filter(|v| !v.is_null())
        .is_some_and(|v| !matches!(v.as_str(), Some("auto" | "default" | "flex" | "priority")))
    {
        return Err("siwc_unsupported_option".into());
    }
    if object.get("store") != Some(&Value::Bool(false))
        || object.get("stream") != Some(&Value::Bool(true))
        || !object.get("input").is_some_and(Value::is_array)
        || !object
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
    {
        return Err("siwc_invalid_request".into());
    }
    for field in [
        "previous_response_id",
        "conversation",
        "background",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
    ] {
        if object.get(field).is_some_and(|v| !v.is_null()) {
            return Err("siwc_unsupported_option".into());
        }
    }
    if object["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item.get("role").and_then(Value::as_str) == Some("system"))
    {
        return Err("siwc_system_input_unsupported".into());
    }
    if let Some(tools) = object.get("tools") {
        validate_tools(tools, true)?;
    }
    for item in object["input"].as_array().ok_or("siwc_invalid_request")? {
        validate_input(item)?;
    }
    if let Some(options) = object.get("stream_options").filter(|v| !v.is_null()) {
        let options = options.as_object().ok_or("siwc_unsupported_option")?;
        if options
            .iter()
            .any(|(key, value)| key != "include_obfuscation" || !value.is_boolean())
        {
            return Err("siwc_unsupported_option".into());
        }
    }
    if let Some(include) = object.get("include").filter(|v| !v.is_null()) {
        if !include.as_array().is_some_and(|values| {
            values.iter().all(|value| {
                matches!(
                    value.as_str(),
                    Some("reasoning.encrypted_content" | "web_search_call.action.sources")
                )
            })
        }) {
            return Err("siwc_unsupported_option".into());
        }
    }
    fn safe(value: &Value) -> bool {
        match value {
            Value::String(text) => cognia_net::outbound_pii::has_no_leaking_pii(text),
            Value::Array(values) => values.iter().all(safe),
            Value::Object(values) => values.iter().all(|(key, value)| {
                cognia_net::outbound_pii::has_no_leaking_pii(key) && safe(value)
            }),
            _ => true,
        }
    }
    if !safe(&value) {
        return Err("siwc_pii_blocked".into());
    }
    Ok(())
}

fn validate_tools(tools: &Value, grouped: bool) -> Result<(), String> {
    for tool in tools.as_array().ok_or("siwc_unsupported_tool")? {
        match tool.get("type").and_then(Value::as_str) {
            Some("namespace") if grouped => {
                if !tool
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                {
                    return Err("siwc_unsupported_tool".into());
                }
                validate_tools(tool.get("tools").ok_or("siwc_unsupported_tool")?, false)?;
            }
            Some("function" | "custom") => {
                if grouped
                    || !tool
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty())
                {
                    return Err("siwc_unsupported_tool".into());
                }
            }
            Some("web_search" | "web_search_preview") if grouped => {}
            _ => return Err("siwc_unsupported_tool".into()),
        }
    }
    Ok(())
}

fn validate_input(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("siwc_unsupported_input")?;
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if !matches!(
            kind,
            "message"
                | "additional_tools"
                | "function_call"
                | "function_call_output"
                | "custom_tool_call"
                | "custom_tool_call_output"
                | "reasoning"
                | "compaction"
                | "web_search_call"
        ) {
            return Err("siwc_unsupported_input".into());
        }
    }
    if matches!(
        object.get("type").and_then(Value::as_str),
        Some("additional_tools")
    ) {
        // The preview also accepts local function/custom definitions in an
        // additional_tools item; hosted execution remains prohibited.
        let tools = object.get("tools").ok_or("siwc_unsupported_tool")?;
        for tool in tools.as_array().ok_or("siwc_unsupported_tool")? {
            if !matches!(
                tool.get("type").and_then(Value::as_str),
                Some("function" | "custom" | "namespace")
            ) {
                return Err("siwc_unsupported_tool".into());
            }
            if tool.get("type").and_then(Value::as_str) == Some("namespace") {
                validate_tools(&serde_json::json!([tool]), true)?;
            }
        }
        return Ok(());
    }
    fn visit(value: &Value) -> bool {
        match value {
            Value::Object(object) => {
                if object
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| {
                        kind.contains("audio")
                            || kind.contains("video")
                            || matches!(
                                kind,
                                "item_reference"
                                    | "computer_call"
                                    | "computer_call_output"
                                    | "tool_search_call"
                                    | "tool_search_output"
                            )
                    })
                {
                    return false;
                }
                if object.get("file_id").is_some() {
                    return false;
                }
                if object.get("file_url").is_some() {
                    return false;
                }
                if let Some(value) = object.get("image_url") {
                    let Some(url) = value.as_str() else {
                        return false;
                    };
                    if ![
                        "data:image/png;base64,",
                        "data:image/jpeg;base64,",
                        "data:image/webp;base64,",
                        "data:image/gif;base64,",
                    ]
                    .iter()
                    .any(|prefix| url.starts_with(prefix))
                    {
                        return false;
                    }
                }
                if let Some(value) = object.get("file_data") {
                    let Some(data) = value.as_str() else {
                        return false;
                    };
                    let encoded = if data.starts_with("data:") {
                        let Some((mime, encoded)) = data.split_once(',') else {
                            return false;
                        };
                        if !mime.starts_with("data:text/") || !mime.ends_with(";base64") {
                            return false;
                        }
                        encoded
                    } else {
                        data
                    };
                    let Ok(bytes) = STANDARD.decode(encoded) else {
                        return false;
                    };
                    let Ok(text) = std::str::from_utf8(&bytes) else {
                        return false;
                    };
                    if !cognia_net::outbound_pii::has_no_leaking_pii(text) {
                        return false;
                    }
                }
                object.values().all(visit)
            }
            Value::Array(values) => values.iter().all(visit),
            _ => true,
        }
    }
    if !visit(value) {
        return Err("siwc_unsupported_input".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body() -> Value {
        serde_json::json!({"model":"fixture-model","store":false,"stream":true,"input":[{"role":"developer","content":"Use the tool result."},{"type":"function_call_output","call_id":"call-test","output":"safe result"}]})
    }
    #[test]
    fn accepts_full_history_and_developer_context() {
        assert!(validate_body(&body().to_string()).is_ok());
    }
    #[test]
    fn blocks_pii_in_final_tool_output_and_escaped_json() {
        let mut value = body();
        value["input"][1]["output"] = Value::String("person@example.com".into());
        assert_eq!(
            validate_body(&value.to_string()).unwrap_err(),
            "siwc_pii_blocked"
        );
        assert_eq!(
            validate_body(&value.to_string().replace('@', "\\u0040")).unwrap_err(),
            "siwc_pii_blocked"
        );
    }
    #[test]
    fn refuses_history_shortcuts_and_unsupported_user_constraints() {
        for (field, value) in [
            ("max_output_tokens", serde_json::json!(20)),
            ("temperature", serde_json::json!(0.5)),
            ("previous_response_id", serde_json::json!("old")),
            ("metadata", serde_json::json!({"x":"y"})),
        ] {
            let mut request = body();
            request[field] = value;
            assert_eq!(
                validate_body(&request.to_string()).unwrap_err(),
                "siwc_unsupported_option"
            );
        }
    }
    #[test]
    fn rejects_hosted_tools_system_messages_and_nonstreaming_storage() {
        let mut request = body();
        request["tools"] = serde_json::json!([{"type":"mcp"}]);
        assert!(validate_body(&request.to_string()).is_err());
        let mut request = body();
        request["input"][0]["role"] = serde_json::json!("system");
        assert!(validate_body(&request.to_string()).is_err());
        for field in ["store", "stream"] {
            let mut request = body();
            request[field] = serde_json::json!(field == "store");
            assert!(validate_body(&request.to_string()).is_err());
        }
    }

    #[test]
    fn rejects_unknown_fields_nested_hosted_tools_and_encoded_pii_files() {
        let mut request = body();
        request["future_unsafe_option"] = Value::Bool(true);
        assert!(validate_body(&request.to_string()).is_err());
        let mut request = body();
        request["tools"] = serde_json::json!([{"type":"namespace","name":"bad","tools":[{"type":"mcp","server_url":"https://invalid.example"}]}]);
        assert!(validate_body(&request.to_string()).is_err());
        let mut request = body();
        request["input"] = serde_json::json!([{"role":"user","content":[{"type":"input_file","filename":"contact.txt","file_data":"data:text/plain;base64,cGVyc29uQGV4YW1wbGUuY29t"}]}]);
        assert!(validate_body(&request.to_string()).is_err());
        request["input"][0]["content"][0]["file_data"] =
            Value::String("data:text/plain;base64,c2FmZSBmaXh0dXJl".into());
        assert!(validate_body(&request.to_string()).is_ok());
        request["input"][0]["content"][0]["file_data"] =
            Value::String("data:application/pdf;base64,c2FmZSBmaXh0dXJl".into());
        assert!(validate_body(&request.to_string()).is_err());
        request["input"] = serde_json::json!([{"role":"user","content":[{"type":"input_image","image_url":"https://invalid.example/private-image"}]}]);
        assert!(validate_body(&request.to_string()).is_err());
    }

    #[test]
    fn terminal_parser_handles_split_events_and_incomplete_distinctly() {
        let mut terminal = Terminal::default();
        terminal.push(b"data: {\"type\":\"response.com").unwrap();
        terminal.push(b"pleted\"}\r\n\r\n").unwrap();
        assert!(terminal.finish().is_ok());
        let mut terminal = Terminal::default();
        terminal
            .push(b"data: {\"type\":\"response.incomplete\"}\n\n")
            .unwrap();
        assert_eq!(terminal.finish().unwrap_err(), "siwc_response_incomplete");
        let mut terminal = Terminal::default();
        terminal.push(b"data: not-json\n\n").unwrap_err();
    }
}
