//! Feishu/Lark long-connection WebSocket client.
//!
//! Unlike Slack socket-mode / Discord gateway (plain JSON text frames over the
//! generic `ws_client.rs` passthrough), Feishu's long connection speaks a
//! **protobuf binary** framing (`pbbp2.Frame`) over ByteDance's long-conn
//! infra. The generic passthrough cannot handle it (it discards binary frames),
//! so Lark gets this dedicated client.
//!
//! Protocol (verified against `larksuite/oapi-sdk-go` `ws` package + Feishu docs):
//!   1. Handshake: `POST https://open.feishu.cn/callback/ws/endpoint` with
//!      `{"AppID","AppSecret"}` → `{code,msg,data:{URL,ClientConfig}}`. The
//!      returned `URL` already carries `device_id` / `service_id`, so we dial
//!      it verbatim.
//!   2. Each WS message is a protobuf `Frame`. `method==0` is a Control frame
//!      (server ping/pong → config update, no reply); `method==1` is a Data
//!      frame carrying an event.
//!   3. Data payloads may be chunked across frames (`sum`/`seq` headers, keyed
//!      by `message_id`); reassemble then optionally gunzip.
//!   4. After handling a complete event, ack by echoing the inbound frame with
//!      payload `{"code":200,"headers":{},"data":null}` + a `biz_rt` header,
//!      on the same socket (must land within ~3s).
//!   5. Client sends its own ping Control frame every `PingInterval`.
//!
//! Emits to the renderer:
//!   `connectors://lark-ws/<handleId>/event` — a complete event envelope (JSON string)
//!   `connectors://lark-ws/<handleId>/close` — the connection loop terminated
//!
//! A stable handle id (UUIDv4) is returned to the TS transport; `close(id)`
//! cancels the reconnect loop and drops the socket.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::{client_async_tls, tungstenite::Message};
use uuid::Uuid;

use cognia_net::proxy_config;
use cognia_net::proxy_config::wsproxy::{AsyncReadWrite, ProxyStream};

use super::axum_app::EventEmitter;

const ENDPOINT_URL: &str = "https://open.feishu.cn/callback/ws/endpoint";

// Frame.method values.
const METHOD_CONTROL: i32 = 0;
const METHOD_DATA: i32 = 1;

// Header keys (ws/const.go).
const H_TYPE: &str = "type";
const H_MESSAGE_ID: &str = "message_id";
const H_SUM: &str = "sum";
const H_SEQ: &str = "seq";
const H_BIZ_RT: &str = "biz_rt";

// `type` header values.
const T_PING: &str = "ping";
const T_EVENT: &str = "event";
const T_CARD: &str = "card";

/// 5s cap on holding incomplete chunked messages — matches the SDK's cache TTL.
const REASSEMBLY_TTL: Duration = Duration::from_secs(5);
/// Default client ping cadence when the server omits `PingInterval`.
const DEFAULT_PING_INTERVAL_MS: u64 = 120_000;

// ---------------------------------------------------------------------------
// pbbp2 protobuf frame (manual prost derive — no .proto / build.rs)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Header {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(string, tag = "2")]
    pub value: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Frame {
    #[prost(int64, tag = "1")]
    pub seqid: i64,
    // pbbp2 `logid` (tag 2) is a NUMERIC varint on the wire, not a string — the
    // string log id is a separate higher-tag field. Declaring this as `String`
    // made prost reject EVERY inbound frame with "logid: invalid wire type:
    // Varint (expected LengthDelimited)", so all events were silently dropped
    // (the decode error was logged at debug and invisible at the INFO log level).
    #[prost(uint64, tag = "2")]
    pub logid: u64,
    #[prost(int32, tag = "3")]
    pub service: i32,
    #[prost(int32, tag = "4")]
    pub method: i32,
    #[prost(message, repeated, tag = "5")]
    pub headers: Vec<Header>,
    #[prost(string, tag = "6")]
    pub payload_encoding: String,
    #[prost(string, tag = "7")]
    pub payload_type: String,
    #[prost(bytes = "vec", tag = "8")]
    pub payload: Vec<u8>,
}

impl Frame {
    fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    fn set_header(&mut self, key: &str, value: String) {
        if let Some(h) = self.headers.iter_mut().find(|h| h.key == key) {
            h.value = value;
        } else {
            self.headers.push(Header {
                key: key.to_string(),
                value,
            });
        }
    }
}

/// Build the client's keepalive ping (a Control frame with `type=ping`).
fn ping_frame(service: i32) -> Frame {
    Frame {
        service,
        method: METHOD_CONTROL,
        headers: vec![Header {
            key: H_TYPE.to_string(),
            value: T_PING.to_string(),
        }],
        ..Default::default()
    }
}

/// Turn an inbound DATA frame into its ack: echo the frame with the 200
/// Response payload + a `biz_rt` header. The SDK keeps the same `seqid` by
/// mutating the original frame, which is what we do here.
fn build_ack(mut frame: Frame, biz_rt_ms: i64) -> Frame {
    frame.set_header(H_BIZ_RT, biz_rt_ms.to_string());
    let resp = serde_json::json!({ "code": 200, "headers": {}, "data": null });
    frame.payload = serde_json::to_vec(&resp).unwrap_or_default();
    frame.payload_encoding = String::new();
    frame.payload_type = String::new();
    frame
}

/// Inflate a gzip payload when the frame says so; pass through otherwise.
fn maybe_inflate(encoding: &str, payload: Vec<u8>) -> Vec<u8> {
    if encoding.eq_ignore_ascii_case("gzip") {
        use std::io::Read;
        let mut decoder = flate2::read::GzDecoder::new(payload.as_slice());
        let mut out = Vec::new();
        if decoder.read_to_end(&mut out).is_ok() {
            return out;
        }
    }
    payload
}

// ---------------------------------------------------------------------------
// Chunk reassembly
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Reassembler {
    parts: HashMap<String, PartialMessage>,
}

type PartialMessage = (Instant, Vec<Option<Vec<u8>>>);

impl Reassembler {
    /// Add one chunk; returns the concatenated payload once all `sum` chunks
    /// for `msg_id` have arrived, else `None`. Drops entries older than the TTL.
    fn combine(&mut self, msg_id: &str, seq: usize, sum: usize, data: Vec<u8>) -> Option<Vec<u8>> {
        let now = Instant::now();
        self.parts
            .retain(|_, (t, _)| now.duration_since(*t) < REASSEMBLY_TTL);

        let entry = self
            .parts
            .entry(msg_id.to_string())
            .or_insert_with(|| (now, vec![None; sum.max(1)]));
        if seq < entry.1.len() {
            entry.1[seq] = Some(data);
        }
        if entry.1.iter().all(|p| p.is_some()) {
            let (_, chunks) = self.parts.remove(msg_id).unwrap();
            Some(chunks.into_iter().flatten().flatten().collect())
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct EndpointResp {
    code: i32,
    #[serde(default)]
    msg: String,
    data: Option<EndpointData>,
}

#[derive(Deserialize)]
struct EndpointData {
    #[serde(rename = "URL")]
    url: Option<String>,
    #[serde(rename = "ClientConfig")]
    client_config: Option<ClientConfig>,
}

#[derive(Deserialize, Clone)]
#[serde(default)]
struct ClientConfig {
    #[serde(rename = "PingInterval")]
    ping_interval: i32,
    #[serde(rename = "ReconnectCount")]
    reconnect_count: i32,
    #[serde(rename = "ReconnectInterval")]
    reconnect_interval: i32,
    #[serde(rename = "ReconnectNonce")]
    reconnect_nonce: i32,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            ping_interval: 120,
            reconnect_count: -1,
            reconnect_interval: 120,
            reconnect_nonce: 30,
        }
    }
}

impl ClientConfig {
    fn can_reconnect(&self, attempts: u32) -> bool {
        self.reconnect_count < 0 || attempts < self.reconnect_count as u32
    }

    fn ping_duration(&self) -> Duration {
        if self.ping_interval > 0 {
            Duration::from_secs(self.ping_interval as u64)
        } else {
            Duration::from_millis(DEFAULT_PING_INTERVAL_MS)
        }
    }
}

#[derive(Default)]
struct ConnectionPolicy {
    config: ClientConfig,
    reconnect_attempts: u32,
    fatal_error: bool,
}

fn endpoint_service_id(endpoint: &str) -> Result<i32, String> {
    let parsed = url::Url::parse(endpoint).map_err(|e| format!("invalid WS URL: {e}"))?;
    parsed
        .query_pairs()
        .find(|(key, _)| key == "service_id")
        .ok_or_else(|| "WS URL missing service_id".to_string())?
        .1
        .parse()
        .map_err(|_| "WS URL invalid service_id".to_string())
}

fn apply_control_config(frame: &Frame, config: &mut ClientConfig) -> Result<bool, String> {
    if frame.method != METHOD_CONTROL
        || frame.header(H_TYPE) != Some("pong")
        || frame.payload.is_empty()
    {
        return Ok(false);
    }
    let next = serde_json::from_slice(&frame.payload)
        .map_err(|e| format!("invalid PONG ClientConfig: {e}"))?;
    *config = next;
    Ok(true)
}

// Mirrors the official SDK's distinction between ClientException (terminal)
// and ServerException (retryable), including the WS connection-limit code.
fn endpoint_error_is_fatal(http_status: u16, code: i32) -> bool {
    http_status == 200 && !matches!(code, 0 | 1 | 1000040343)
}

fn handshake_error_is_fatal(status: Option<&str>, auth_code: Option<&str>) -> bool {
    status == Some("403") || (status == Some("514") && auth_code == Some("1000040350"))
}

async fn fetch_endpoint(
    app_id: &str,
    app_secret: &str,
    fatal_error: &mut bool,
) -> Result<(String, ClientConfig), String> {
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
    let (builder, _) = proxy_config::apply_reqwest_policy(builder, ENDPOINT_URL)
        .map_err(|error| error.to_string())?;
    let client = builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;

    let resp = client
        .post(ENDPOINT_URL)
        .json(&serde_json::json!({ "AppID": app_id, "AppSecret": app_secret }))
        .send()
        .await
        .map_err(|e| format!("ws endpoint request failed: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("ws endpoint body read failed: {e}"))?;

    if status != 200 {
        return Err(format!("ws endpoint HTTP {status}"));
    }
    let parsed: EndpointResp = serde_json::from_str(&body)
        .map_err(|e| format!("ws endpoint parse failed: {e}: {body}"))?;
    if parsed.code != 0 {
        *fatal_error = endpoint_error_is_fatal(status, parsed.code);
        return Err(format!("ws endpoint code {}: {}", parsed.code, parsed.msg));
    }
    let data = parsed.data.ok_or("ws endpoint missing data")?;
    let url = data.url.ok_or("ws endpoint missing URL")?;
    Ok((url, data.client_config.unwrap_or_default()))
}

// ---------------------------------------------------------------------------
// Handle registry
// ---------------------------------------------------------------------------

static HANDLES: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();

fn handles() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_live(handle_id: &str) -> bool {
    handles().lock().unwrap().contains_key(handle_id)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Open a Lark long connection for `adapter_id` (credentials read from the OS
/// keyring). Returns a stable handle id. The connection self-reconnects with
/// back-off until `close(id)` is called.
pub async fn open(emitter: Arc<dyn EventEmitter>, adapter_id: String) -> Result<String, String> {
    let app_id = super::keyring::get(&adapter_id, "appId")?.unwrap_or_default();
    let app_secret = super::keyring::get(&adapter_id, "appSecret")?.unwrap_or_default();
    if app_id.is_empty() || app_secret.is_empty() {
        log::warn!(
            "[lark-ws] open aborted: appId/appSecret not in keyring for adapter {adapter_id}"
        );
        return Err("Lark appId/appSecret not configured in keyring".into());
    }

    let handle_id = Uuid::new_v4().to_string();
    log::info!("[lark-ws] open requested adapter={adapter_id} handle={handle_id}");
    let cancel = Arc::new(Notify::new());
    handles()
        .lock()
        .unwrap()
        .insert(handle_id.clone(), cancel.clone());

    let hid = handle_id.clone();
    tokio::spawn(async move {
        let mut policy = ConnectionPolicy::default();
        while is_live(&hid) {
            let result = tokio::select! {
                _ = cancel.notified() => break,
                result = connect_and_run(emitter.as_ref(), &hid, &app_id, &app_secret, &cancel, &mut policy) => result,
            };
            if let Err(e) = result {
                log::warn!("[lark-ws] {hid} connection ended: {e}");
            }
            if !is_live(&hid)
                || policy.fatal_error
                || !policy.config.can_reconnect(policy.reconnect_attempts)
            {
                break;
            }
            // The endpoint (and subsequent PONGs) controls retry policy.
            // Jitter precedes the first retry; subsequent failures use the
            // configured fixed interval, as in the official SDK.
            let delay = if policy.reconnect_attempts == 0 {
                Duration::from_secs_f64(
                    rand::random::<f64>() * policy.config.reconnect_nonce.max(0) as f64,
                )
            } else {
                Duration::from_secs(policy.config.reconnect_interval.max(0) as u64)
            };
            tokio::select! {
                _ = cancel.notified() => break,
                _ = tokio::time::sleep(delay) => {}
            }
            policy.reconnect_attempts = policy.reconnect_attempts.saturating_add(1);
        }
        emitter.emit(
            &format!("connectors://lark-ws/{hid}/close"),
            serde_json::Value::Null,
        );
        handles().lock().unwrap().remove(&hid);
    });

    Ok(handle_id)
}

/// Cancel the reconnect loop and drop the socket for `handle_id`.
pub async fn close(handle_id: &str) -> Result<(), String> {
    if let Some(cancel) = handles().lock().unwrap().remove(handle_id) {
        cancel.notify_waiters();
    }
    Ok(())
}

/// Cancel **every** live Lark long-connection and return how many were closed.
///
/// The bootstrap counterpart to [`ws_client::close_all`](super::ws_client::close_all):
/// Feishu's reconnect loop self-heals forever until an explicit `close`, so a
/// webview hard reload (whose JS cleanup never fires the per-handle close)
/// otherwise leaks a self-reconnecting connection per reload. Mirrors
/// [`close`]'s drain-then-`notify_waiters` semantics for the whole registry.
pub fn close_all() -> usize {
    let cancels: Vec<Arc<Notify>> = {
        let mut map = handles().lock().unwrap();
        map.drain().map(|(_, c)| c).collect()
    };
    let count = cancels.len();
    for cancel in cancels {
        cancel.notify_waiters();
    }
    count
}

/// One connect → read-until-close cycle. Returns `Ok(())` on a cancel-driven
/// shutdown, `Err` on a transport failure (so the caller backs off + retries).
async fn connect_and_run(
    emitter: &dyn EventEmitter,
    handle_id: &str,
    app_id: &str,
    app_secret: &str,
    cancel: &Notify,
    policy: &mut ConnectionPolicy,
) -> Result<(), String> {
    policy.fatal_error = false;
    let (url, cfg) = fetch_endpoint(app_id, app_secret, &mut policy.fatal_error).await?;
    policy.config = cfg;
    let service_id = endpoint_service_id(&url)?;
    log::info!("[lark-ws] {handle_id} endpoint resolved, dialing");

    // Dial (proxy-aware) — mirrors `ws_client::open_ws`.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("invalid WS URL: {e}"))?;
    let proxy_cfg = proxy_config::current().map_err(|error| error.to_string())?;
    let route = proxy_cfg
        .websocket_route_for(&url)
        .map_err(|error| error.to_string())?;
    let use_proxy = matches!(route, proxy_config::ProxyRouteSummary::Proxy { .. });
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid WS URL: {e}"))?;
    let host = parsed.host_str().ok_or("WS URL missing host")?.to_string();
    let secure = parsed.scheme() == "wss";
    let port = parsed
        .port_or_known_default()
        .unwrap_or(if secure { 443 } else { 80 });
    let raw: ProxyStream = if use_proxy {
        proxy_config::wsproxy::connect_via_proxy(&proxy_cfg, &host, port)
            .await
            .map_err(|e| format!("WS proxy tunnel failed: {e}"))?
    } else {
        let tcp = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("WS connect failed: {e}"))?;
        let boxed: Box<dyn AsyncReadWrite + Send + Unpin> = Box::new(tcp);
        boxed
    };
    let (ws_stream, _) = client_async_tls(request, raw).await.map_err(|e| {
        if let tokio_tungstenite::tungstenite::Error::Http(response) = &e {
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
            };
            policy.fatal_error = handshake_error_is_fatal(
                header("handshake-status"),
                header("handshake-autherrcode"),
            );
        }
        format!("WS handshake failed: {e}")
    })?;
    log::info!("[lark-ws] {handle_id} connected (ws handshake ok), entering read loop");
    policy.reconnect_attempts = 0;
    let (mut sink, mut stream) = ws_stream.split();

    // Single outbound pump (pings + acks). Mirrors `ws_client`'s mpsc pattern.
    let (tx, mut rx) = mpsc::channel::<Message>(64);
    let pump = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Cancellation may drop this entire connection future while dialing or
    // reading. Ensure its outbound task cannot outlive the connection.
    struct AbortPumpOnDrop(tokio::task::AbortHandle);
    impl Drop for AbortPumpOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _pump_guard = AbortPumpOnDrop(pump.abort_handle());

    // Poll the ping timer with inbound frames so PONG configuration changes
    // take effect immediately instead of leaving a detached timer stale.
    let ping = tokio::time::sleep(Duration::ZERO);
    tokio::pin!(ping);

    let mut reasm = Reassembler::default();
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);

    let result = loop {
        tokio::select! {
            _ = &mut cancelled => break Ok(()),
            _ = &mut ping => {
                if tx.send(Message::Binary(ping_frame(service_id).encode_to_vec().into())).await.is_err() {
                    break Err("ws writer stopped".to_string());
                }
                ping.as_mut().reset(tokio::time::Instant::now() + policy.config.ping_duration());
            },
            item = stream.next() => {
                match item {
                    Some(Ok(Message::Binary(bytes))) => {
                        match Frame::decode(bytes.as_ref()) {
                            Ok(frame) => {
                                match apply_control_config(&frame, &mut policy.config) {
                                    Ok(true) => ping.as_mut().reset(tokio::time::Instant::now() + policy.config.ping_duration()),
                                    Ok(false) => {},
                                    Err(e) => log::warn!("[lark-ws] {handle_id} {e}"),
                                }
                                handle_frame(emitter, handle_id, frame, &mut reasm, &tx).await;
                            },
                            Err(e) => {
                                // Elevated from debug: a decode failure on a real
                                // inbound frame is the silent drop we must see. The
                                // hex head lets us reverse the wire layout when the
                                // hand-rolled pbbp2 tags disagree with the server.
                                let head: String = bytes
                                    .iter()
                                    .take(64)
                                    .map(|b| format!("{b:02x}"))
                                    .collect();
                                log::warn!(
                                    "[lark-ws] {handle_id} frame decode FAILED ({} bytes): {e}; head={head}",
                                    bytes.len()
                                );
                            }
                        }
                    }
                    // WS-level control ping (distinct from Feishu's app-level
                    // ping Frame) — answer to keep tungstenite's state happy.
                    Some(Ok(Message::Ping(p))) => {
                        let _ = tx.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(c))) => {
                        log::warn!("[lark-ws] {handle_id} ws closed by server: {c:?}");
                        break Err("ws closed by server".to_string());
                    }
                    Some(Ok(Message::Text(t))) => {
                        log::warn!(
                            "[lark-ws] {handle_id} recv unexpected TEXT frame ({} bytes) — events are protobuf Binary, not Text",
                            t.len()
                        );
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Err(format!("ws read error: {e}")),
                    None => break Err("ws stream ended".to_string()),
                }
            }
        }
    };

    drop(tx);
    pump.abort();
    let _ = pump.await;
    result
}

/// Dispatch data frames after the connection loop has applied control configuration.
async fn handle_frame(
    emitter: &dyn EventEmitter,
    handle_id: &str,
    frame: Frame,
    reasm: &mut Reassembler,
    tx: &mpsc::Sender<Message>,
) {
    // Per-frame trace (debug): method + headers of every decoded frame. Kept at
    // debug so it is available when diagnosing (a data event with an unexpected
    // `type`, or headers that misparse to an empty `type`) without spamming the
    // INFO log. A genuine decode FAILURE is logged at WARN in the read loop.
    log::debug!(
        "[lark-ws] {handle_id} frame recv: method={} type={:?} msg_id={:?} sum={:?} seq={:?} enc={:?}",
        frame.method,
        frame.header(H_TYPE),
        frame.header(H_MESSAGE_ID),
        frame.header(H_SUM),
        frame.header(H_SEQ),
        frame.payload_encoding,
    );
    if frame.method == METHOD_CONTROL {
        // PONG configuration is applied by the connection loop before dispatch.
        return;
    }
    if frame.method != METHOD_DATA {
        return;
    }

    let started = Instant::now();
    let msg_type = frame.header(H_TYPE).unwrap_or("").to_string();
    let message_id = frame.header(H_MESSAGE_ID).unwrap_or("").to_string();
    let sum: usize = frame
        .header(H_SUM)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let seq: usize = frame
        .header(H_SEQ)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let full = if sum <= 1 {
        Some(frame.payload.clone())
    } else {
        reasm.combine(&message_id, seq, sum, frame.payload.clone())
    };

    // Only emit + ack once the whole message has arrived (matches the SDK,
    // which runs the handler and acks on completion, not per chunk).
    if let Some(payload) = full {
        let payload = maybe_inflate(&frame.payload_encoding, payload);
        if msg_type == T_EVENT || msg_type == T_CARD {
            if let Ok(json) = String::from_utf8(payload) {
                log::info!(
                    "[lark-ws] {handle_id} event frame received (type={msg_type}) → emitting"
                );
                emitter.emit(
                    &format!("connectors://lark-ws/{handle_id}/event"),
                    serde_json::Value::String(json),
                );
            }
        }
        let ack = build_ack(frame, started.elapsed().as_millis() as i64);
        let _ = tx.send(Message::Binary(ack.encode_to_vec().into())).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::axum_app::EventEmitter;
    use parking_lot::Mutex as ParkingMutex;

    #[derive(Default)]
    struct RecordingEmitter {
        events: ParkingMutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventEmitter for RecordingEmitter {
        fn emit(&self, topic: &str, payload: serde_json::Value) {
            self.events.lock().push((topic.to_string(), payload));
        }
    }

    #[tokio::test]
    async fn data_frame_preserves_event_topic_and_string_payload() {
        let emitter = RecordingEmitter::default();
        let mut reassembler = Reassembler::default();
        let (tx, mut rx) = mpsc::channel(1);
        let frame = Frame {
            seqid: 1,
            logid: 2,
            service: 3,
            method: METHOD_DATA,
            headers: vec![
                Header {
                    key: H_TYPE.into(),
                    value: T_EVENT.into(),
                },
                Header {
                    key: H_MESSAGE_ID.into(),
                    value: "message-1".into(),
                },
            ],
            payload_encoding: String::new(),
            payload_type: "json".into(),
            payload: br#"{"event":"message"}"#.to_vec(),
        };

        handle_frame(&emitter, "handle-1", frame, &mut reassembler, &tx).await;

        assert_eq!(
            emitter.events.lock().as_slice(),
            &[(
                "connectors://lark-ws/handle-1/event".to_string(),
                serde_json::Value::String(r#"{"event":"message"}"#.to_string()),
            )]
        );
        assert!(
            rx.recv().await.is_some(),
            "data frame must still be acknowledged"
        );
    }

    #[test]
    fn frame_roundtrip_preserves_fields() {
        let frame = Frame {
            seqid: 42,
            logid: 9_876_543_210,
            service: 7,
            method: METHOD_DATA,
            headers: vec![
                Header {
                    key: H_TYPE.into(),
                    value: T_EVENT.into(),
                },
                Header {
                    key: H_MESSAGE_ID.into(),
                    value: "msg-9".into(),
                },
            ],
            payload_encoding: String::new(),
            payload_type: "json".into(),
            payload: b"{\"hello\":1}".to_vec(),
        };
        let bytes = frame.encode_to_vec();
        let decoded = Frame::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded, frame);
        assert_eq!(decoded.header(H_TYPE), Some(T_EVENT));
        assert_eq!(decoded.header(H_MESSAGE_ID), Some("msg-9"));
    }

    #[test]
    fn decodes_wire_frame_with_numeric_logid() {
        // Regression: the live server sends `logid` (tag 2) as a VARINT, not a
        // string. When this field was declared `String`, prost rejected every
        // real frame ("logid: invalid wire type: Varint (expected
        // LengthDelimited)") and all events were silently dropped. Hand-encoded
        // wire bytes (tag 2 = varint) that must now decode with headers intact.
        let bytes: &[u8] = &[
            0x08, 0x01, // tag1 seqid = 1 (varint)
            0x10, 0x01, // tag2 logid = 1 (VARINT — used to be String → decode err)
            0x20, 0x01, // tag4 method = 1 (DATA)
            0x2a, 0x0d, // tag5 headers, length 13
            0x0a, 0x04, b't', b'y', b'p', b'e', // Header.key = "type"
            0x12, 0x05, b'e', b'v', b'e', b'n', b't', // Header.value = "event"
            0x42, 0x02, b'{', b'}', // tag8 payload = "{}"
        ];
        let frame = Frame::decode(bytes).expect("wire frame with numeric logid must decode");
        assert_eq!(frame.method, METHOD_DATA);
        assert_eq!(frame.logid, 1);
        assert_eq!(frame.header(H_TYPE), Some(T_EVENT));
        assert_eq!(frame.payload, b"{}");
    }

    #[test]
    fn ping_frame_is_control_with_ping_type() {
        let f = ping_frame(42);
        assert_eq!(f.method, METHOD_CONTROL);
        assert_eq!(f.header(H_TYPE), Some(T_PING));
    }

    #[test]
    fn server_errors_retry_but_client_errors_stop_reconnecting() {
        assert!(endpoint_error_is_fatal(200, 1000040344));
        assert!(endpoint_error_is_fatal(200, 403));
        assert!(!endpoint_error_is_fatal(200, 1));
        assert!(!endpoint_error_is_fatal(200, 1000040343));
        assert!(!endpoint_error_is_fatal(503, 403));
        assert!(handshake_error_is_fatal(Some("403"), None));
        assert!(handshake_error_is_fatal(Some("514"), Some("1000040350")));
        assert!(!handshake_error_is_fatal(Some("514"), Some("other")));
        assert!(!handshake_error_is_fatal(None, None));
    }

    #[test]
    fn endpoint_service_id_is_used_in_ping() {
        let service =
            endpoint_service_id("wss://example.com/ws?device_id=d&service_id=42").unwrap();
        assert_eq!(ping_frame(service).service, 42);
        assert!(endpoint_service_id("wss://example.com/ws").is_err());
        assert!(endpoint_service_id("wss://example.com/ws?service_id=bad").is_err());
    }

    #[test]
    fn pong_updates_server_reconnect_and_ping_policy() {
        let mut cfg = ClientConfig::default();
        let frame = Frame {
            method: METHOD_CONTROL,
            headers: vec![Header { key: H_TYPE.into(), value: "pong".into() }],
            payload: br#"{"PingInterval":30,"ReconnectCount":2,"ReconnectInterval":7,"ReconnectNonce":0}"#.to_vec(),
            ..Default::default()
        };
        assert!(apply_control_config(&frame, &mut cfg).unwrap());
        assert_eq!(cfg.ping_interval, 30);
        assert_eq!(cfg.reconnect_interval, 7);
        assert_eq!(cfg.reconnect_nonce, 0);
        assert!(cfg.can_reconnect(1));
        assert!(!cfg.can_reconnect(2));
        let mut malformed = frame;
        malformed.payload = b"bad".to_vec();
        assert!(apply_control_config(&malformed, &mut cfg).is_err());
        assert_eq!(cfg.ping_interval, 30);
    }

    #[test]
    fn control_config_ignores_ping_empty_pong_and_data() {
        let mut cfg = ClientConfig::default();
        for (method, kind, payload) in [
            (METHOD_CONTROL, "ping", b"bad".as_slice()),
            (METHOD_CONTROL, "pong", b"".as_slice()),
            (METHOD_DATA, "pong", b"bad".as_slice()),
        ] {
            let frame = Frame {
                method,
                headers: vec![Header {
                    key: H_TYPE.into(),
                    value: kind.into(),
                }],
                payload: payload.to_vec(),
                ..Default::default()
            };
            assert!(!apply_control_config(&frame, &mut cfg).unwrap());
        }
        assert_eq!(cfg.ping_duration(), Duration::from_secs(120));
    }

    #[test]
    fn zero_reconnect_count_stops_and_invalid_ping_uses_default() {
        let cfg: ClientConfig =
            serde_json::from_str(r#"{"ReconnectCount":0,"PingInterval":0}"#).unwrap();
        assert!(!cfg.can_reconnect(0));
        assert_eq!(cfg.ping_duration(), Duration::from_secs(120));
        assert!(endpoint_service_id("not a URL").is_err());
    }

    #[test]
    fn config_defaults_do_not_disable_reconnect() {
        let cfg: ClientConfig = serde_json::from_str("{}").unwrap();
        assert!(cfg.can_reconnect(u32::MAX));
        assert_eq!(cfg.ping_interval, 120);
        assert_eq!(cfg.reconnect_interval, 120);
        assert_eq!(cfg.reconnect_nonce, 30);
    }

    #[test]
    fn build_ack_sets_200_and_biz_rt_keeping_seqid() {
        let inbound = Frame {
            seqid: 1234,
            method: METHOD_DATA,
            headers: vec![Header {
                key: H_MESSAGE_ID.into(),
                value: "m1".into(),
            }],
            payload: b"original".to_vec(),
            payload_encoding: "gzip".into(),
            ..Default::default()
        };
        let ack = build_ack(inbound, 5);
        assert_eq!(ack.seqid, 1234);
        assert_eq!(ack.header(H_BIZ_RT), Some("5"));
        assert_eq!(ack.payload_encoding, "");
        let v: serde_json::Value = serde_json::from_slice(&ack.payload).unwrap();
        assert_eq!(v["code"], 200);
    }

    #[test]
    fn reassembler_single_chunk_is_immediate_via_handler_path() {
        // sum<=1 is handled inline in handle_frame; verify combine handles the
        // sum==1 edge too (used when a server still sets sum=1 explicitly).
        let mut r = Reassembler::default();
        assert_eq!(r.combine("m", 0, 1, b"abc".to_vec()), Some(b"abc".to_vec()));
    }

    #[test]
    fn reassembler_concatenates_in_seq_order_regardless_of_arrival() {
        let mut r = Reassembler::default();
        assert_eq!(r.combine("m", 2, 3, b"C".to_vec()), None);
        assert_eq!(r.combine("m", 0, 3, b"A".to_vec()), None);
        assert_eq!(r.combine("m", 1, 3, b"B".to_vec()), Some(b"ABC".to_vec()));
    }

    #[test]
    fn reassembler_keeps_distinct_messages_separate() {
        let mut r = Reassembler::default();
        assert_eq!(r.combine("a", 0, 2, b"a0".to_vec()), None);
        assert_eq!(r.combine("b", 0, 1, b"b0".to_vec()), Some(b"b0".to_vec()));
        assert_eq!(r.combine("a", 1, 2, b"a1".to_vec()), Some(b"a0a1".to_vec()));
    }

    #[test]
    fn maybe_inflate_roundtrips_gzip_and_passes_through_plain() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(b"payload-body").unwrap();
        let gz = enc.finish().unwrap();
        assert_eq!(maybe_inflate("gzip", gz), b"payload-body".to_vec());
        assert_eq!(maybe_inflate("", b"raw".to_vec()), b"raw".to_vec());
    }

    #[test]
    fn close_all_cancels_every_connection() {
        // Reap any residue so the count is deterministic under shared statics.
        close_all();
        {
            let mut map = handles().lock().unwrap();
            map.insert("h1".into(), Arc::new(Notify::new()));
            map.insert("h2".into(), Arc::new(Notify::new()));
        }
        assert!(is_live("h1"));
        let closed = close_all();
        assert_eq!(closed, 2);
        assert!(!is_live("h1"));
        assert!(!is_live("h2"));
        assert!(handles().lock().unwrap().is_empty());
    }

    #[test]
    fn endpoint_resp_parses_feishu_shape() {
        let body = r#"{"code":0,"msg":"ok","data":{"URL":"wss://x/y?device_id=d&service_id=s","ClientConfig":{"PingInterval":120}}}"#;
        let parsed: EndpointResp = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.code, 0);
        let data = parsed.data.unwrap();
        assert_eq!(
            data.url.as_deref(),
            Some("wss://x/y?device_id=d&service_id=s")
        );
        assert_eq!(data.client_config.unwrap().ping_interval, 120);
    }
}
