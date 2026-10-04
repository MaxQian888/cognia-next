//! The renderer ⇄ runtime bridge: what the desktop shell forwards, and how.
//!
//! - [`is_renderer_op`] is the allow-list of control ops the renderer may issue
//!   through `browser_local_rpc`. Value-carrying ops (`browser.cookies.set`,
//!   `browser.credential.fill`), the extension-set reload and
//!   `browser.download.save` (which writes to an arbitrary path) are
//!   Rust-only.
//! - [`prepare_session_create`] strips every host-owned field a renderer might
//!   smuggle into `browser.session.create` and injects the ones Rust owns.
//! - [`run_frame_poller`] polls `/v1/media/:session` and hands each 24-byte
//!   framed JPEG to a sink (the Tauri channel), acknowledging it so the
//!   runtime keeps screencasting.
//! - [`run_event_tailer`] tails `/v1/events` and turns journal entries into
//!   [`BridgeEvent`]s; `credential.submitted` is split out so its password can
//!   only go to the vault, never to the renderer.
//!
//! The loops take a [`RuntimeTransport`] so the tests drive them with a fake;
//! they stop on a [`StopSignal`], so nothing they spawn outlives its owner.

use std::future::Future;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::client::{ClientError, MediaFrame};

/// Header size of a framed media message (`FRAME_HEADER_BYTES`).
pub const FRAME_HEADER_BYTES: usize = 24;
const JPEG_CODEC: u8 = 1;

/// Ops only Rust may issue: they carry secret values (cookies, passwords),
/// decide which directories Chromium loads code from, or write a file to a
/// path (`browser.download.save`, whose target the user picks in a native
/// save dialog Rust shows).
pub const PRIVILEGED_OPS: &[&str] = &[
    "browser.cookies.set",
    "browser.credential.fill",
    "browser.extensions.reload",
    "browser.download.save",
];

/// Every op the renderer may issue through `browser_local_rpc`.
pub const RENDERER_OPS: &[&str] = &[
    "browser.session.create",
    "browser.session.close",
    "browser.profile.delete",
    "browser.navigate",
    "browser.snapshot",
    "browser.act",
    "browser.press-key",
    "browser.scroll",
    "browser.evaluate",
    "browser.console",
    "browser.network",
    "browser.network.request",
    "browser.back",
    "browser.forward",
    "browser.reload",
    "browser.stop",
    "browser.page",
    "browser.pages",
    "browser.page.create",
    "browser.page.activate",
    "browser.page.close",
    "browser.drag",
    "browser.dialog.handle",
    "browser.wait.text",
    "browser.wait.selector",
    "browser.wait.network-idle",
    "browser.wait.load",
    "browser.screenshot",
    "browser.files.set",
    // Answers a `filechooser.opened` with paths staged by
    // `browser_local_stage_upload`; the runtime confines them to the
    // session's upload roots exactly like `browser.files.set`.
    "browser.filechooser.set",
    "browser.downloads",
    "browser.download.cancel",
    "browser.download.delete",
    "browser.set-zoom",
    "browser.find",
    "browser.find.clear",
    // Element pick and Browser Adjust (ADR-0214): each runs one fixed overlay
    // function with JSON arguments, never renderer-supplied JS.
    "browser.select-mode",
    "browser.selection.drain",
    "browser.selection.clear",
    "browser.selection.for-ref",
    "browser.adjust",
    "browser.screencast.start",
    "browser.screencast.ack",
    "browser.input",
    "browser.cancel",
    "browser.extension.open",
    "browser.cookies.list",
    "browser.cookies.clear",
    "browser.forms.detect-login",
    "browser.pdf",
    "browser.emulate",
    "browser.storage.get",
    "browser.storage.set",
    "browser.storage.clear",
    "browser.tabs.finalize",
];

/// Whether the renderer may issue `op`.
pub fn is_renderer_op(op: &str) -> bool {
    !PRIVILEGED_OPS.contains(&op) && RENDERER_OPS.contains(&op)
}

/// Session fields only the host may set.
const HOST_OWNED_SESSION_FIELDS: &[&str] =
    &["cdpEndpoint", "extensionPaths", "downloadsDir", "uploadRoots"];

/// The two local session kinds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionKind {
    Local,
    UserChrome,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::UserChrome => "user-chrome",
        }
    }
}

/// Read the requested kind (`"local"` when absent).
pub fn session_kind(payload: &Value) -> Result<SessionKind, ClientError> {
    match payload.get("kind") {
        None | Some(Value::Null) => Ok(SessionKind::Local),
        Some(Value::String(kind)) if kind == "local" => Ok(SessionKind::Local),
        Some(Value::String(kind)) if kind == "user-chrome" => Ok(SessionKind::UserChrome),
        Some(other) => Err(ClientError::new(
            "invalid_session_kind",
            format!("unsupported local session kind {other}"),
        )),
    }
}

/// What the host injects into a `browser.session.create`.
#[derive(Clone, Debug, Default)]
pub struct SessionCreateContext {
    pub downloads_dir: String,
    /// Enabled extensions (local sessions only).
    pub extension_paths: Vec<String>,
    /// The user's Chrome endpoint (user-chrome sessions only), resolved in Rust.
    pub cdp_endpoint: Option<String>,
    /// Directories uploads may come from (both kinds): only
    /// `<app_data>/browser/uploads`, where Rust stages the files the user
    /// picked in a native file picker.
    pub upload_roots: Vec<String>,
}

/// Rewrite a renderer `browser.session.create` payload: drop host-owned
/// fields, then set `kind`, `downloadsDir`, `uploadRoots`, and per kind `profileId` +
/// `extensionPaths` (local) or `cdpEndpoint` (user-chrome).
pub fn prepare_session_create(
    payload: Value,
    context: &SessionCreateContext,
) -> Result<Value, ClientError> {
    let kind = session_kind(&payload)?;
    let mut object: Map<String, Value> = match payload {
        Value::Object(object) => object,
        Value::Null => Map::new(),
        _ => {
            return Err(ClientError::new(
                "invalid_payload",
                "browser.session.create expects an object payload",
            ))
        }
    };
    for field in HOST_OWNED_SESSION_FIELDS {
        object.remove(*field);
    }
    object.insert("kind".into(), Value::String(kind.as_str().into()));
    object.insert(
        "downloadsDir".into(),
        Value::String(context.downloads_dir.clone()),
    );
    object.insert(
        "uploadRoots".into(),
        Value::Array(
            context
                .upload_roots
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    match kind {
        SessionKind::Local => {
            let profile = object
                .get("profileId")
                .and_then(Value::as_str)
                .filter(|profile| !profile.is_empty())
                .unwrap_or("default")
                .to_string();
            object.insert("profileId".into(), Value::String(profile));
            object.insert(
                "extensionPaths".into(),
                Value::Array(
                    context
                        .extension_paths
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
        SessionKind::UserChrome => {
            let endpoint = context.cdp_endpoint.clone().ok_or_else(|| {
                ClientError::new(
                    "remote_debugging_disabled",
                    "the chosen browser has no remote debugging endpoint",
                )
            })?;
            object.insert("cdpEndpoint".into(), Value::String(endpoint));
        }
    }
    Ok(Value::Object(object))
}

/// The session id a create call produced (the result's `id` / `sessionId`, or
/// the id the caller asked for).
pub fn created_session_id(request: &Value, result: &Value) -> Option<String> {
    [
        result.get("id"),
        result.get("sessionId"),
        result.get("session").and_then(|session| session.get("id")),
        request.get("id"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| value.as_str().map(str::to_string))
}

/// A decoded frame header (`decodeMediaFrame` without the payload copy).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub sequence: u32,
    pub width: u16,
    pub height: u16,
    pub timestamp: u64,
    pub payload_bytes: u32,
}

/// Validate a framed JPEG exactly like `decodeMediaFrame` does.
pub fn parse_frame_header(frame: &[u8]) -> Result<FrameHeader, ClientError> {
    let invalid = |message: &str| ClientError::new("invalid_media_frame", message);
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(invalid("media frame header is truncated"));
    }
    if frame[0] as u64 != crate::client::PRIVATE_PROTOCOL_VERSION {
        return Err(invalid("unsupported media protocol version"));
    }
    if frame[1] != JPEG_CODEC {
        return Err(invalid("unsupported media codec"));
    }
    let header_bytes = u16::from_be_bytes([frame[2], frame[3]]) as usize;
    let payload_bytes = u32::from_be_bytes([frame[20], frame[21], frame[22], frame[23]]);
    if header_bytes != FRAME_HEADER_BYTES || frame.len() != header_bytes + payload_bytes as usize
    {
        return Err(invalid("invalid media frame length"));
    }
    let mut timestamp = [0u8; 8];
    timestamp.copy_from_slice(&frame[12..20]);
    Ok(FrameHeader {
        sequence: u32::from_be_bytes([frame[4], frame[5], frame[6], frame[7]]),
        width: u16::from_be_bytes([frame[8], frame[9]]),
        height: u16::from_be_bytes([frame[10], frame[11]]),
        timestamp: u64::from_be_bytes(timestamp),
        payload_bytes,
    })
}

/// What the loops need from the runtime. `generation` is `None` while no
/// process runs; a change means every sequence and session is gone.
pub trait RuntimeTransport: Send + Sync {
    fn generation(&self) -> Option<u64>;
    fn control(
        &self,
        operation: &str,
        payload: Value,
    ) -> impl Future<Output = Result<Value, ClientError>> + Send;
    fn media(
        &self,
        session_id: &str,
        after: u64,
    ) -> impl Future<Output = Result<Option<MediaFrame>, ClientError>> + Send;
    fn events(&self, after: u64) -> impl Future<Output = Result<Vec<Value>, ClientError>> + Send;
}

/// The live transport: the supervised process's current endpoint, looked up
/// per call so a restart is picked up (and reported through `generation`).
#[derive(Clone, Debug)]
pub struct SupervisedTransport {
    client: crate::client::RuntimeClient,
    supervisor: std::sync::Arc<crate::supervisor::Supervisor>,
}

impl SupervisedTransport {
    pub fn new(
        client: crate::client::RuntimeClient,
        supervisor: std::sync::Arc<crate::supervisor::Supervisor>,
    ) -> Self {
        Self { client, supervisor }
    }

    fn endpoint(&self) -> Result<crate::client::RuntimeEndpoint, ClientError> {
        self.supervisor.endpoint().ok_or_else(|| {
            ClientError::new(
                "runtime_not_running",
                "the local browser runtime is not running",
            )
        })
    }
}

impl RuntimeTransport for SupervisedTransport {
    fn generation(&self) -> Option<u64> {
        self.supervisor.generation()
    }

    async fn control(&self, operation: &str, payload: Value) -> Result<Value, ClientError> {
        let endpoint = self.endpoint()?;
        self.client.control(&endpoint, operation, payload).await
    }

    async fn media(&self, session_id: &str, after: u64) -> Result<Option<MediaFrame>, ClientError> {
        let endpoint = self.endpoint()?;
        self.client.media(&endpoint, session_id, after).await
    }

    async fn events(&self, after: u64) -> Result<Vec<Value>, ClientError> {
        let endpoint = self.endpoint()?;
        self.client.events(&endpoint, after).await
    }
}

/// A one-shot stop flag both loops watch.
#[derive(Clone, Debug)]
pub struct StopSignal(tokio::sync::watch::Receiver<bool>);

/// The owner's half: dropping it also stops the loop.
#[derive(Debug)]
pub struct StopHandle(tokio::sync::watch::Sender<bool>);

impl StopHandle {
    pub fn stop(&self) {
        let _ = self.0.send(true);
    }
}

impl Drop for StopHandle {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

pub fn stop_pair() -> (StopHandle, StopSignal) {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    (StopHandle(sender), StopSignal(receiver))
}

impl StopSignal {
    pub fn is_stopped(&self) -> bool {
        *self.0.borrow()
    }

    /// Sleep for `duration`; `true` when the stop fired first.
    pub async fn sleep_or_stop(&mut self, duration: Duration) -> bool {
        if self.is_stopped() {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(duration) => self.is_stopped(),
            // A dropped sender also counts as a stop.
            _ = self.0.changed() => true,
        }
    }
}

/// Why a frame poller ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FramePollEnd {
    Stopped,
    SinkClosed,
    RuntimeRestarted,
    RuntimeFailed(String),
}

/// Frame poll cadence and failure budget.
#[derive(Clone, Copy, Debug)]
pub struct FramePollConfig {
    pub idle_interval: Duration,
    pub error_interval: Duration,
    pub max_consecutive_errors: u32,
}

impl Default for FramePollConfig {
    fn default() -> Self {
        Self {
            idle_interval: Duration::from_millis(25),
            error_interval: Duration::from_millis(150),
            max_consecutive_errors: 5,
        }
    }
}

/// Poll frames for `session_id` until stopped, the sink refuses a frame, the
/// runtime restarts, or it keeps failing. `sink` returns `false` once its
/// receiver is gone.
pub async fn run_frame_poller<T, F>(
    transport: &T,
    session_id: &str,
    mut sink: F,
    mut stop: StopSignal,
    config: FramePollConfig,
) -> FramePollEnd
where
    T: RuntimeTransport,
    F: FnMut(Vec<u8>) -> bool + Send,
{
    let start_generation = transport.generation();
    let mut cursor = 0u64;
    let mut failures = 0u32;
    loop {
        if stop.is_stopped() {
            return FramePollEnd::Stopped;
        }
        if transport.generation() != start_generation {
            return FramePollEnd::RuntimeRestarted;
        }
        let polled = tokio::select! {
            polled = transport.media(session_id, cursor) => polled,
            _ = stop.0.changed() => return FramePollEnd::Stopped,
        };
        match polled {
            Ok(Some(frame)) => {
                failures = 0;
                cursor = frame.sequence;
                let header = match parse_frame_header(&frame.bytes) {
                    Ok(header) => header,
                    Err(error) => {
                        tracing::warn!(session_id, %error, "dropping malformed media frame");
                        continue;
                    }
                };
                if !sink(frame.bytes) {
                    return FramePollEnd::SinkClosed;
                }
                // Ack the screencast frame (the header's own sequence) so the
                // runtime asks Chromium for the next one.
                if let Err(error) = transport
                    .control(
                        "browser.screencast.ack",
                        json!({ "sessionId": session_id, "sequence": header.sequence }),
                    )
                    .await
                {
                    tracing::debug!(session_id, %error, "screencast ack failed");
                }
            }
            Ok(None) => {
                if stop.sleep_or_stop(config.idle_interval).await {
                    return FramePollEnd::Stopped;
                }
            }
            Err(error) => {
                failures += 1;
                if failures >= config.max_consecutive_errors {
                    return FramePollEnd::RuntimeFailed(error.to_string());
                }
                if stop.sleep_or_stop(config.error_interval).await {
                    return FramePollEnd::Stopped;
                }
            }
        }
    }
}

/// Event types forwarded to the renderer.
pub const FORWARDED_EVENT_TYPES: &[&str] = &[
    "pages.changed",
    "download.updated",
    "dialog.opened",
    "session.closed",
    "credential.submitted",
    "extensions.changed",
    "filechooser.opened",
    // The overlay's pick signal: `{pageId, count, generation}`, no page data.
    "element.selected",
];

/// A journal entry the shell acts on.
#[derive(Clone, PartialEq, Eq)]
pub enum BridgeEvent {
    /// Forward as-is to `browser-local://event` (already has `type` and
    /// `sessionId`; `sequence` / `kind` removed).
    Forward(Value),
    /// A submitted login form. The password goes to the vault only.
    CredentialSubmitted {
        session_id: Option<String>,
        page_id: Option<String>,
        origin: String,
        username: String,
        password: String,
    },
}

/// Written by hand so the password never reaches a log line.
impl std::fmt::Debug for BridgeEvent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Forward(value) => formatter.debug_tuple("Forward").field(value).finish(),
            Self::CredentialSubmitted {
                session_id,
                page_id,
                origin,
                username,
                ..
            } => formatter
                .debug_struct("CredentialSubmitted")
                .field("session_id", session_id)
                .field("page_id", page_id)
                .field("origin", origin)
                .field("username", username)
                .field("password", &"<redacted>")
                .finish(),
        }
    }
}

/// The journal marks browser events `kind: "browser.event"`; audit records
/// (`runtime.operation`) and agent-supervisor events never reach the renderer.
pub const BROWSER_EVENT_KIND: &str = "browser.event";

fn event_type(raw: &Value) -> Option<&str> {
    let kind = raw.get("kind").and_then(Value::as_str);
    if kind.is_some_and(|kind| kind != BROWSER_EVENT_KIND) {
        return None;
    }
    raw.get("type")
        .and_then(Value::as_str)
        .filter(|kind| FORWARDED_EVENT_TYPES.contains(kind))
}

/// Map one journal entry; `None` for entries the renderer never sees (audit
/// records, agent-supervisor events, anything unknown).
pub fn map_event(raw: &Value) -> Option<BridgeEvent> {
    let kind = event_type(raw)?.to_string();
    let object = raw.as_object()?;
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    if kind == "credential.submitted" {
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_string);
        return Some(BridgeEvent::CredentialSubmitted {
            session_id,
            page_id: text("pageId"),
            origin: text("origin")?,
            username: text("username").unwrap_or_default(),
            password: text("password")?,
        });
    }
    let mut forwarded = Map::new();
    for (key, value) in object {
        if matches!(key.as_str(), "sequence" | "kind" | "type" | "password") {
            continue;
        }
        forwarded.insert(key.clone(), value.clone());
    }
    forwarded.insert("type".into(), Value::String(kind));
    forwarded
        .entry("sessionId")
        .or_insert(session_id.map(Value::String).unwrap_or(Value::Null));
    Some(BridgeEvent::Forward(Value::Object(forwarded)))
}

/// Highest journal sequence in a batch.
fn max_sequence(events: &[Value]) -> Option<u64> {
    events
        .iter()
        .filter_map(|event| event.get("sequence").and_then(Value::as_u64))
        .max()
}

/// Event tail cadence.
#[derive(Clone, Copy, Debug)]
pub struct EventTailConfig {
    pub interval: Duration,
    pub idle_interval: Duration,
}

impl Default for EventTailConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(250),
            idle_interval: Duration::from_millis(1000),
        }
    }
}

/// Tail the journal until stopped. The cursor resets whenever the runtime's
/// generation changes (a new process restarts its journal at 1).
pub async fn run_event_tailer<T, F>(
    transport: &T,
    mut on_event: F,
    mut stop: StopSignal,
    config: EventTailConfig,
) where
    T: RuntimeTransport,
    F: FnMut(BridgeEvent) + Send,
{
    let mut generation = None;
    let mut cursor = 0u64;
    loop {
        if stop.is_stopped() {
            return;
        }
        let current = transport.generation();
        if current != generation {
            generation = current;
            cursor = 0;
        }
        if current.is_none() {
            if stop.sleep_or_stop(config.idle_interval).await {
                return;
            }
            continue;
        }
        let polled = tokio::select! {
            polled = transport.events(cursor) => polled,
            _ = stop.0.changed() => return,
        };
        match polled {
            Ok(events) => {
                if transport.generation() != generation {
                    continue;
                }
                if let Some(sequence) = max_sequence(&events) {
                    cursor = cursor.max(sequence);
                }
                for event in events.iter().filter_map(map_event) {
                    on_event(event);
                }
            }
            Err(error) => tracing::debug!(%error, "local browser event poll failed"),
        }
        if stop.sleep_or_stop(config.interval).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    fn frame(sequence: u32, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
        bytes.push(1);
        bytes.push(JPEG_CODEC);
        bytes.extend_from_slice(&(FRAME_HEADER_BYTES as u16).to_be_bytes());
        bytes.extend_from_slice(&sequence.to_be_bytes());
        bytes.extend_from_slice(&1280u16.to_be_bytes());
        bytes.extend_from_slice(&720u16.to_be_bytes());
        bytes.extend_from_slice(&1_700_000_000_000u64.to_be_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[derive(Default)]
    struct FakeTransport {
        generation: AtomicU64,
        media: Mutex<VecDeque<Result<Option<MediaFrame>, ClientError>>>,
        events: Mutex<VecDeque<Result<Vec<Value>, ClientError>>>,
        controls: Mutex<Vec<(String, Value)>>,
        media_cursors: Mutex<Vec<u64>>,
        event_cursors: Mutex<Vec<u64>>,
    }

    impl FakeTransport {
        fn running(generation: u64) -> Self {
            let fake = Self::default();
            fake.generation.store(generation, Ordering::SeqCst);
            fake
        }
    }

    impl RuntimeTransport for FakeTransport {
        fn generation(&self) -> Option<u64> {
            match self.generation.load(Ordering::SeqCst) {
                0 => None,
                value => Some(value),
            }
        }

        async fn control(&self, operation: &str, payload: Value) -> Result<Value, ClientError> {
            self.controls
                .lock()
                .unwrap()
                .push((operation.to_string(), payload));
            Ok(json!(true))
        }

        async fn media(
            &self,
            _session_id: &str,
            after: u64,
        ) -> Result<Option<MediaFrame>, ClientError> {
            self.media_cursors.lock().unwrap().push(after);
            self.media.lock().unwrap().pop_front().unwrap_or(Ok(None))
        }

        async fn events(&self, after: u64) -> Result<Vec<Value>, ClientError> {
            self.event_cursors.lock().unwrap().push(after);
            self.events
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(Vec::new()))
        }
    }

    #[test]
    fn allow_list_excludes_privileged_ops() {
        assert!(is_renderer_op("browser.navigate"));
        assert!(is_renderer_op("browser.session.create"));
        assert!(is_renderer_op("browser.tabs.finalize"));
        assert!(is_renderer_op("browser.filechooser.set"));
        for op in [
            "browser.select-mode",
            "browser.selection.drain",
            "browser.selection.clear",
            "browser.selection.for-ref",
            "browser.adjust",
        ] {
            assert!(is_renderer_op(op), "{op}");
        }
        assert!(!is_renderer_op("browser.cookies.set"));
        assert!(!is_renderer_op("browser.credential.fill"));
        assert!(!is_renderer_op("browser.extensions.reload"));
        assert!(!is_renderer_op("browser.download.save"));
        assert!(is_renderer_op("browser.download.cancel"));
        assert!(!is_renderer_op("agent.spawn"));
        assert!(!is_renderer_op("browser.unknown"));
        for op in PRIVILEGED_OPS {
            assert!(!RENDERER_OPS.contains(op), "{op} must not be renderer-callable");
        }
    }

    #[test]
    fn session_create_strips_and_injects_for_local() {
        let context = SessionCreateContext {
            downloads_dir: "/Users/u/Downloads".into(),
            extension_paths: vec!["/ext/a".into()],
            cdp_endpoint: Some("ws://127.0.0.1:9222/devtools/browser/x".into()),
            upload_roots: vec!["/Users/u".into(), "/data/browser/uploads".into()],
        };
        let prepared = prepare_session_create(
            json!({
                "id": "s1",
                "headless": false,
                "cdpEndpoint": "ws://evil",
                "extensionPaths": ["/tmp/evil"],
                "downloadsDir": "/tmp",
                "uploadRoots": ["/"],
            }),
            &context,
        )
        .unwrap();
        assert_eq!(
            prepared,
            json!({
                "id": "s1",
                "headless": false,
                "kind": "local",
                "downloadsDir": "/Users/u/Downloads",
                "uploadRoots": ["/Users/u", "/data/browser/uploads"],
                "profileId": "default",
                "extensionPaths": ["/ext/a"],
            })
        );
    }

    #[test]
    fn session_create_keeps_a_named_profile() {
        let prepared = prepare_session_create(
            json!({"kind": "local", "profileId": "work"}),
            &SessionCreateContext::default(),
        )
        .unwrap();
        assert_eq!(prepared["profileId"], "work");
        let empty = prepare_session_create(Value::Null, &SessionCreateContext::default()).unwrap();
        assert_eq!(empty["profileId"], "default");
        assert_eq!(empty["kind"], "local");
    }

    #[test]
    fn session_create_for_user_chrome_uses_the_resolved_endpoint() {
        let context = SessionCreateContext {
            downloads_dir: "/d".into(),
            extension_paths: vec!["/ext/a".into()],
            cdp_endpoint: Some("ws://127.0.0.1:9222/devtools/browser/x".into()),
            upload_roots: vec!["/home/u".into()],
        };
        let prepared = prepare_session_create(
            json!({"kind": "user-chrome", "browser": "chrome", "cdpEndpoint": "ws://evil"}),
            &context,
        )
        .unwrap();
        assert_eq!(
            prepared["cdpEndpoint"],
            "ws://127.0.0.1:9222/devtools/browser/x"
        );
        assert!(prepared.get("extensionPaths").is_none());
        assert!(prepared.get("profileId").is_none());
        assert_eq!(prepared["uploadRoots"], json!(["/home/u"]));

        let missing = prepare_session_create(
            json!({"kind": "user-chrome"}),
            &SessionCreateContext::default(),
        )
        .unwrap_err();
        assert_eq!(missing.code, "remote_debugging_disabled");

        let bad = prepare_session_create(json!({"kind": "cloud"}), &context).unwrap_err();
        assert_eq!(bad.code, "invalid_session_kind");
        let not_object = prepare_session_create(json!([1]), &context).unwrap_err();
        assert_eq!(not_object.code, "invalid_payload");
    }

    #[test]
    fn created_session_id_prefers_the_result() {
        assert_eq!(
            created_session_id(&json!({"id": "asked"}), &json!({"id": "got"})).as_deref(),
            Some("got")
        );
        assert_eq!(
            created_session_id(&json!({}), &json!({"session": {"id": "nested"}})).as_deref(),
            Some("nested")
        );
        assert_eq!(
            created_session_id(&json!({"id": "asked"}), &json!(null)).as_deref(),
            Some("asked")
        );
        assert_eq!(created_session_id(&json!({}), &json!({})), None);
    }

    #[test]
    fn frame_header_matches_the_runtime_encoding() {
        let bytes = frame(42, b"jpeg");
        let header = parse_frame_header(&bytes).unwrap();
        assert_eq!(header.sequence, 42);
        assert_eq!(header.width, 1280);
        assert_eq!(header.height, 720);
        assert_eq!(header.timestamp, 1_700_000_000_000);
        assert_eq!(header.payload_bytes, 4);

        assert!(parse_frame_header(&bytes[..10]).is_err());
        let mut wrong_version = bytes.clone();
        wrong_version[0] = 2;
        assert!(parse_frame_header(&wrong_version).is_err());
        let mut wrong_codec = bytes.clone();
        wrong_codec[1] = 9;
        assert!(parse_frame_header(&wrong_codec).is_err());
        let mut truncated = bytes.clone();
        truncated.pop();
        assert!(parse_frame_header(&truncated).is_err());
    }

    #[test]
    fn events_are_mapped_and_filtered() {
        assert_eq!(
            map_event(&json!({"sequence": 1, "type": "pages.changed", "sessionId": "s1", "pages": []})),
            Some(BridgeEvent::Forward(json!({"type": "pages.changed", "sessionId": "s1", "pages": []})))
        );
        // The runtime's `kind: "browser.event"` marker is accepted and
        // stripped; a missing session id becomes null.
        assert_eq!(
            map_event(&json!({"sequence": 2, "timestamp": 5, "kind": "browser.event", "type": "extensions.changed"})),
            Some(BridgeEvent::Forward(json!({"type": "extensions.changed", "timestamp": 5, "sessionId": null})))
        );
        // Any other kind is not a browser event, whatever its type says.
        assert_eq!(
            map_event(&json!({"sequence": 4, "kind": "runtime.operation", "type": "pages.changed"})),
            None
        );
        assert_eq!(
            map_event(&json!({"sequence": 3, "kind": "runtime.operation", "operation": "browser.navigate"})),
            None
        );
        assert_eq!(map_event(&json!({"type": "stdout", "agentId": "a"})), None);
        assert_eq!(map_event(&json!("pages.changed")), None);
        // The pick signal reaches the pane showing that page.
        assert_eq!(
            map_event(&json!({
                "sequence": 5,
                "kind": "browser.event",
                "type": "element.selected",
                "sessionId": "s1",
                "pageId": "p2",
                "count": 1,
                "generation": 3
            })),
            Some(BridgeEvent::Forward(json!({
                "type": "element.selected",
                "sessionId": "s1",
                "pageId": "p2",
                "count": 1,
                "generation": 3
            })))
        );
    }

    #[test]
    fn credential_events_keep_the_password_out_of_forwarding() {
        let event = map_event(&json!({
            "sequence": 9,
            "kind": "browser.event",
            "type": "credential.submitted",
            "sessionId": "s1",
            "pageId": "p2",
            "origin": "https://example.com",
            "username": "ada",
            "password": "hunter2",
        }))
        .unwrap();
        match &event {
            BridgeEvent::CredentialSubmitted {
                session_id,
                page_id,
                origin,
                username,
                password,
            } => {
                assert_eq!(session_id.as_deref(), Some("s1"));
                assert_eq!(page_id.as_deref(), Some("p2"));
                assert_eq!(origin, "https://example.com");
                assert_eq!(username, "ada");
                assert_eq!(password, "hunter2");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(!format!("{event:?}").contains("hunter2"));
        // No password → nothing to stash.
        assert_eq!(
            map_event(&json!({"type": "credential.submitted", "origin": "https://a"})),
            None
        );
        // A page's file chooser reaches the renderer, which stages the user's pick.
        let chooser = map_event(&json!({
            "kind": "browser.event",
            "type": "filechooser.opened",
            "sessionId": "s1",
            "pageId": "p1",
            "chooserId": "c1",
            "multiple": true,
            "sequence": 4,
        }))
        .unwrap();
        assert_eq!(
            chooser,
            BridgeEvent::Forward(json!({
                "type": "filechooser.opened",
                "sessionId": "s1",
                "pageId": "p1",
                "chooserId": "c1",
                "multiple": true,
            }))
        );
        // A password field on any other event is dropped.
        let forwarded = map_event(&json!({"type": "dialog.opened", "password": "x"})).unwrap();
        assert!(!format!("{forwarded:?}").contains("\"x\""));
    }

    #[tokio::test]
    async fn frame_poller_forwards_acks_and_stops_on_closed_sink() {
        let transport = FakeTransport::running(1);
        transport.media.lock().unwrap().extend([
            Ok(Some(MediaFrame {
                sequence: 1,
                bytes: frame(10, b"a"),
            })),
            Ok(None),
            Ok(Some(MediaFrame {
                sequence: 2,
                bytes: vec![0, 1, 2],
            })),
            Ok(Some(MediaFrame {
                sequence: 3,
                bytes: frame(11, b"b"),
            })),
        ]);
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink_received = Arc::clone(&received);
        let (_handle, stop) = stop_pair();
        let end = run_frame_poller(
            &transport,
            "s1",
            move |bytes| {
                let mut received = sink_received.lock().unwrap();
                received.push(bytes);
                received.len() < 2
            },
            stop,
            FramePollConfig {
                idle_interval: Duration::from_millis(1),
                ..FramePollConfig::default()
            },
        )
        .await;
        assert_eq!(end, FramePollEnd::SinkClosed);
        let received = received.lock().unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(parse_frame_header(&received[1]).unwrap().sequence, 11);
        let controls = transport.controls.lock().unwrap();
        assert_eq!(controls.len(), 1, "only the first frame is acked before close");
        assert_eq!(controls[0].0, "browser.screencast.ack");
        assert_eq!(controls[0].1, json!({"sessionId": "s1", "sequence": 10}));
        assert_eq!(*transport.media_cursors.lock().unwrap(), vec![0, 1, 1, 2]);
    }

    #[tokio::test]
    async fn frame_poller_ends_on_stop_restart_and_errors() {
        let transport = FakeTransport::running(1);
        let (handle, stop) = stop_pair();
        handle.stop();
        let end = run_frame_poller(&transport, "s", |_| true, stop, FramePollConfig::default()).await;
        assert_eq!(end, FramePollEnd::Stopped);

        let transport = FakeTransport::running(1);
        let (_handle, stop) = stop_pair();
        let restarting = &transport;
        let end = run_frame_poller(
            restarting,
            "s",
            |_| true,
            stop,
            FramePollConfig {
                idle_interval: Duration::from_millis(1),
                ..FramePollConfig::default()
            },
        );
        let bump = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            restarting.generation.store(2, Ordering::SeqCst);
        };
        let (end, ()) = tokio::join!(end, bump);
        assert_eq!(end, FramePollEnd::RuntimeRestarted);

        let transport = FakeTransport::running(1);
        transport.media.lock().unwrap().extend(
            (0..3).map(|_| Err(ClientError::new("runtime_unreachable", "down"))),
        );
        let (_handle, stop) = stop_pair();
        let end = run_frame_poller(
            &transport,
            "s",
            |_| true,
            stop,
            FramePollConfig {
                idle_interval: Duration::from_millis(1),
                error_interval: Duration::from_millis(1),
                max_consecutive_errors: 3,
            },
        )
        .await;
        assert!(matches!(end, FramePollEnd::RuntimeFailed(message) if message.contains("down")));
    }

    #[tokio::test]
    async fn dropping_the_handle_stops_the_poller() {
        let transport = FakeTransport::running(1);
        let (handle, stop) = stop_pair();
        let poll = run_frame_poller(
            &transport,
            "s",
            |_| true,
            stop,
            FramePollConfig {
                idle_interval: Duration::from_secs(60),
                ..FramePollConfig::default()
            },
        );
        let drop_later = async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            drop(handle);
        };
        let (end, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(poll, drop_later)
        })
        .await
        .expect("the poller must stop promptly");
        assert_eq!(end, FramePollEnd::Stopped);
    }

    #[tokio::test]
    async fn event_tailer_advances_the_cursor_and_resets_on_restart() {
        let transport = FakeTransport::running(1);
        transport.events.lock().unwrap().extend([
            Ok(vec![
                json!({"sequence": 4, "type": "pages.changed", "sessionId": "s1"}),
                json!({"sequence": 5, "kind": "runtime.operation"}),
            ]),
            Ok(vec![json!({"sequence": 6, "type": "session.closed", "sessionId": "s1"})]),
        ]);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let (handle, stop) = stop_pair();
        let tail = run_event_tailer(
            &transport,
            move |event| sink.lock().unwrap().push(event),
            stop,
            EventTailConfig {
                interval: Duration::from_millis(1),
                idle_interval: Duration::from_millis(1),
            },
        );
        let drive = async {
            // Wait for both batches, restart, then let one more poll run.
            for _ in 0..500 {
                if seen.lock().unwrap().len() == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            transport.generation.store(2, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(30)).await;
            handle.stop();
        };
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(tail, drive) })
            .await
            .expect("the tailer must stop");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        let cursors = transport.event_cursors.lock().unwrap();
        // The second poll resumes after the first batch's highest sequence.
        assert_eq!(&cursors[..2], &[0, 5]);
        assert!(cursors.iter().all(|cursor| [0, 5, 6].contains(cursor)));
        assert_eq!(*cursors.last().unwrap(), 0, "a new generation restarts at 0");
    }

    #[tokio::test]
    async fn supervised_transport_reports_a_stopped_runtime() {
        let root = tempfile::tempdir().unwrap();
        let supervisor = crate::supervisor::Supervisor::new(
            crate::supervisor::SupervisorConfig::new(
                std::path::PathBuf::from("node"),
                root.path().join("rt"),
                root.path(),
            ),
            |_| {},
        );
        let transport =
            SupervisedTransport::new(crate::client::RuntimeClient::new().unwrap(), supervisor);
        assert_eq!(transport.generation(), None);
        assert_eq!(
            transport.control("browser.pages", json!({})).await.unwrap_err().code,
            "runtime_not_running"
        );
        assert_eq!(
            transport.media("s", 0).await.unwrap_err().code,
            "runtime_not_running"
        );
        assert_eq!(transport.events(0).await.unwrap_err().code, "runtime_not_running");
    }

    #[tokio::test]
    async fn event_tailer_idles_while_the_runtime_is_down() {
        let transport = FakeTransport::default();
        let (handle, stop) = stop_pair();
        let tail = run_event_tailer(
            &transport,
            |_| {},
            stop,
            EventTailConfig {
                interval: Duration::from_millis(1),
                idle_interval: Duration::from_millis(1),
            },
        );
        let drive = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            handle.stop();
        };
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(tail, drive) })
            .await
            .unwrap();
        assert!(transport.event_cursors.lock().unwrap().is_empty());
    }
}
