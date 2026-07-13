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
use tauri::Emitter;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::{client_async_tls, tungstenite::Message};
use uuid::Uuid;

use cognia_net::proxy_config;
use cognia_net::proxy_config::wsproxy::{AsyncReadWrite, ProxyStream};

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
    #[prost(string, tag = "2")]
    pub logid: String,
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
fn ping_frame() -> Frame {
    Frame {
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
    parts: HashMap<String, (Instant, Vec<Option<Vec<u8>>>)>,
}

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

#[derive(Deserialize, Clone, Default)]
struct ClientConfig {
    #[serde(rename = "PingInterval", default)]
    ping_interval: i32,
}

async fn fetch_endpoint(app_id: &str, app_secret: &str) -> Result<(String, ClientConfig), String> {
    let proxy_cfg = proxy_config::current();
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
    if proxy_cfg.is_active() && !proxy_cfg.should_bypass(ENDPOINT_URL) {
        if let Some(proxy) = proxy_cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;

    let resp = client
        .post(ENDPOINT_URL)
        .json(&serde_json::json!({ "AppID": app_id, "AppSecret": app_secret }))
        .send()
        .await
        .map_err(|e| format!("ws endpoint request failed: {e}"))?;
    let body = resp
        .text()
        .await
        .map_err(|e| format!("ws endpoint body read failed: {e}"))?;

    let parsed: EndpointResp = serde_json::from_str(&body)
        .map_err(|e| format!("ws endpoint parse failed: {e}: {body}"))?;
    if parsed.code != 0 {
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
pub async fn open(app: tauri::AppHandle, adapter_id: String) -> Result<String, String> {
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
        let mut attempts: u32 = 0;
        while is_live(&hid) {
            match connect_and_run(&app, &hid, &app_id, &app_secret, &cancel).await {
                Ok(()) => {
                    // Clean shutdown via cancel — loop guard below stops us.
                    attempts = 0;
                }
                Err(e) => {
                    log::warn!("[lark-ws] {hid} connection ended: {e}");
                    attempts = attempts.saturating_add(1);
                }
            }
            if !is_live(&hid) {
                break;
            }
            let backoff = (1000u64 * 2u64.pow(attempts.min(5))).min(32_000);
            let sleep = tokio::time::sleep(Duration::from_millis(backoff));
            tokio::select! {
                _ = cancel.notified() => break,
                _ = sleep => {}
            }
        }
        let _ = app.emit(&format!("connectors://lark-ws/{hid}/close"), ());
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
    app: &tauri::AppHandle,
    handle_id: &str,
    app_id: &str,
    app_secret: &str,
    cancel: &Notify,
) -> Result<(), String> {
    let (url, cfg) = fetch_endpoint(app_id, app_secret).await?;
    log::info!("[lark-ws] {handle_id} endpoint resolved, dialing");

    // Dial (proxy-aware) — mirrors `ws_client::open_ws`.
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("invalid WS URL: {e}"))?;
    let proxy_cfg = proxy_config::current();
    let use_proxy =
        proxy_cfg.is_active() && proxy_cfg.proxy_websockets && !proxy_cfg.should_bypass(&url);
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
    let (ws_stream, _) = client_async_tls(request, raw)
        .await
        .map_err(|e| format!("WS handshake failed: {e}"))?;
    log::info!("[lark-ws] {handle_id} connected (ws handshake ok), entering read loop");
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

    // Keepalive ping timer.
    let ping_ms = if cfg.ping_interval > 0 {
        cfg.ping_interval as u64 * 1000
    } else {
        DEFAULT_PING_INTERVAL_MS
    };
    let tx_ping = tx.clone();
    let ping = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(ping_ms));
        interval.tick().await; // fire immediately-elapsed first tick
        loop {
            interval.tick().await;
            let frame = ping_frame();
            if tx_ping
                .send(Message::Binary(frame.encode_to_vec().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let mut reasm = Reassembler::default();
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);

    let result = loop {
        tokio::select! {
            _ = &mut cancelled => break Ok(()),
            item = stream.next() => {
                match item {
                    Some(Ok(Message::Binary(bytes))) => {
                        match Frame::decode(bytes.as_ref()) {
                            Ok(frame) => handle_frame(app, handle_id, frame, &mut reasm, &tx).await,
                            Err(e) => log::debug!("[lark-ws] {handle_id} frame decode failed: {e}"),
                        }
                    }
                    // WS-level control ping (distinct from Feishu's app-level
                    // ping Frame) — answer to keep tungstenite's state happy.
                    Some(Ok(Message::Ping(p))) => {
                        let _ = tx.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) => break Err("ws closed by server".to_string()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Err(format!("ws read error: {e}")),
                    None => break Err("ws stream ended".to_string()),
                }
            }
        }
    };

    ping.abort();
    drop(tx);
    let _ = pump.await;
    result
}

/// Decode + dispatch one inbound frame: control frames update nothing we act
/// on (server ping); data frames are reassembled, emitted, and acked.
async fn handle_frame(
    app: &tauri::AppHandle,
    handle_id: &str,
    frame: Frame,
    reasm: &mut Reassembler,
    tx: &mpsc::Sender<Message>,
) {
    if frame.method == METHOD_CONTROL {
        // Server ping/pong — the SDK only reads config out of these and never
        // replies. We keepalive on our own timer, so nothing to do.
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
                let _ = app.emit(&format!("connectors://lark-ws/{handle_id}/event"), json);
            }
        }
        let ack = build_ack(frame, started.elapsed().as_millis() as i64);
        let _ = tx.send(Message::Binary(ack.encode_to_vec().into())).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_preserves_fields() {
        let frame = Frame {
            seqid: 42,
            logid: "log-1".into(),
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
    fn ping_frame_is_control_with_ping_type() {
        let f = ping_frame();
        assert_eq!(f.method, METHOD_CONTROL);
        assert_eq!(f.header(H_TYPE), Some(T_PING));
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
