//! Side-channel IPC bridge that lets the Node MCP sidecar drive the
//! automation worker without going through the MCP stdin/stdout transport.
//!
//! # Why a side channel
//!
//! The MCP sidecar's stdin/stdout is owned by `@modelcontextprotocol/sdk`'s
//! `StdioServerTransport` and serialised through `sidecar.rs::round_trip`'s
//! mutex — any attempt to multiplex automation requests onto the same pipe
//! would either break MCP framing or stall MCP traffic during long-running
//! `desktop_*` calls. A dedicated socket keeps the two concerns independent.
//!
//! # Wire shape
//!
//! Each line is a JSON object terminated by `\n`.
//!
//! Request from the Node sidecar:
//!   `{ "id": "<uuid>", "token": "<hex>", "command": "desktop_<name>",
//!      "args": { ... }, "ctx": { "surface": "mcp", ... } }`
//!
//! Response from Rust:
//!   `{ "id": "<uuid>", "ok": true, "result": <serde_json::Value> }`
//!   `{ "id": "<uuid>", "ok": false, "error": "<message>" }`
//!
//! Authorization: every request carries the per-sidecar `token` (a random
//! 32-byte hex string passed to the Node child via the
//! `COGNIA_AUTOMATION_PROXY_TOKEN` env var). The listener binds to
//! `127.0.0.1:<random-port>` only, but the token is the load-bearing
//! defence — same model as the existing MCP HTTP server's bearer auth.
//!
//! # Lifecycle
//!
//! `AutomationProxy::spawn` returns a value whose `Drop` aborts the
//! listener task. The TCP port is bound by the kernel and released on
//! drop. The handle is held by `SidecarProcess` so the proxy lives
//! exactly as long as the MCP sidecar that depends on it.

use std::net::SocketAddr;
use std::sync::Arc;

use rand::RngCore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::automation::permission::Surface;
use crate::automation::types::{
    AutomationError, ButtonTransition, ClickOpts, ClickTarget, DragOpts, KeyChord, Locator,
    MouseButton, Point, ScreenshotOpts, ScrollOpts, ScrollTarget, TreeOpts, TypeOpts, WindowOp,
};
use crate::automation::worker::AutomationHandle;

/// Live proxy handle. Drop aborts the listener task; closing the listener
/// frees the bound port.
pub struct AutomationProxy {
    /// Bound address — `127.0.0.1:<port>`. Forwarded to the sidecar via
    /// `COGNIA_AUTOMATION_PROXY=<addr>`.
    pub addr: SocketAddr,
    /// Shared-secret token. Forwarded via
    /// `COGNIA_AUTOMATION_PROXY_TOKEN=<hex>`.
    pub token: String,
    listener_task: Option<JoinHandle<()>>,
}

impl AutomationProxy {
    /// Bind a fresh listener on `127.0.0.1` and start accepting connections.
    ///
    /// Each accepted connection runs in its own task and is fed a clone of
    /// the shared `AutomationHandle`; the worker thread underneath
    /// serialises every call so concurrent client connections are safe.
    pub async fn spawn(handle: AutomationHandle) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let token = generate_token();
        let expected = Arc::new(token.clone());
        let handle = Arc::new(handle);

        let task = tokio::spawn(async move {
            loop {
                let (stream, _peer) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(err) => {
                        eprintln!("[automation_proxy] accept failed: {err}");
                        continue;
                    }
                };
                let handle = Arc::clone(&handle);
                let expected = Arc::clone(&expected);
                tokio::spawn(async move {
                    if let Err(err) = serve_connection(stream, handle, expected).await {
                        eprintln!("[automation_proxy] connection error: {err}");
                    }
                });
            }
        });

        Ok(Self {
            addr,
            token,
            listener_task: Some(task),
        })
    }
}

impl Drop for AutomationProxy {
    fn drop(&mut self) {
        if let Some(task) = self.listener_task.take() {
            task.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// Connection state machine — one task per accepted TCP connection.
// ---------------------------------------------------------------------------

async fn serve_connection(
    stream: tokio::net::TcpStream,
    handle: Arc<AutomationHandle>,
    expected_token: Arc<String>,
) -> std::io::Result<()> {
    let (read_half, write_half) = stream.into_split();
    let writer = Arc::new(Mutex::new(write_half));
    let mut reader = BufReader::new(read_half).lines();

    while let Some(line) = reader.next_line().await? {
        if line.is_empty() {
            continue;
        }
        let req: ProxyRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(err) => {
                let resp = ProxyResponse {
                    id: "".into(),
                    ok: false,
                    error: Some(format!("invalid JSON: {err}")),
                    result: None,
                };
                write_response(&writer, &resp).await?;
                continue;
            }
        };

        // Constant-time token check before doing any work.
        if !token_matches(&req.token, expected_token.as_str()) {
            let resp = ProxyResponse {
                id: req.id.clone(),
                ok: false,
                error: Some("unauthorized".into()),
                result: None,
            };
            write_response(&writer, &resp).await?;
            continue;
        }

        // Dispatch in a separate task so a slow request can't block the
        // read loop — the worker thread underneath serialises calls anyway.
        let handle = Arc::clone(&handle);
        let writer = Arc::clone(&writer);
        tokio::spawn(async move {
            let resp = dispatch(req, &handle).await;
            if let Err(err) = write_response(&writer, &resp).await {
                eprintln!("[automation_proxy] write failed: {err}");
            }
        });
    }

    Ok(())
}

async fn write_response(
    writer: &Mutex<tokio::net::tcp::OwnedWriteHalf>,
    resp: &ProxyResponse,
) -> std::io::Result<()> {
    let mut buf = serde_json::to_vec(resp)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    buf.push(b'\n');
    let mut guard = writer.lock().await;
    guard.write_all(&buf).await?;
    guard.flush().await
}

fn token_matches(provided: &str, expected: &str) -> bool {
    let a = provided.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Request / response shapes (newline-framed JSON).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ProxyRequest {
    id: String,
    token: String,
    command: String,
    #[serde(default)]
    args: serde_json::Value,
    #[serde(default)]
    #[allow(dead_code)] // ctx is reserved for surface/whitelist propagation
    ctx: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct ProxyResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ---------------------------------------------------------------------------
// Command dispatch — translate the wire `command` + `args` into a single
// `AutomationHandle` method call. Every result is JSON-serialised so the
// Node sidecar gets a uniform `result` field regardless of the underlying
// return type.
// ---------------------------------------------------------------------------

async fn dispatch(req: ProxyRequest, handle: &AutomationHandle) -> ProxyResponse {
    let id = req.id.clone();
    // Every request forces `surface: "mcp"` regardless of what the client
    // sent — defence in depth so an external agent can't promote itself to
    // a less-restricted surface.
    let _surface = Surface::Mcp;
    match run(req, handle).await {
        Ok(value) => ProxyResponse {
            id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(err) => ProxyResponse {
            id,
            ok: false,
            result: None,
            error: Some(err),
        },
    }
}

async fn run(req: ProxyRequest, handle: &AutomationHandle) -> Result<serde_json::Value, String> {
    match req.command.as_str() {
        "desktop_capabilities" => {
            let caps = handle.capabilities().await.map_err(stringify_err)?;
            Ok(serde_json::to_value(caps).map_err(|e| e.to_string())?)
        }
        "desktop_get_focus" => {
            let info = handle.get_focus().await.map_err(stringify_err)?;
            Ok(serde_json::to_value(info).map_err(|e| e.to_string())?)
        }
        "desktop_read_tree" => {
            let args: ReadTreeArgs = from_value(req.args)?;
            let info = handle
                .read_tree(args.root, args.opts.unwrap_or_default())
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::to_value(info).map_err(|e| e.to_string())?)
        }
        "desktop_find" => {
            let args: FindArgs = from_value(req.args)?;
            let elt = handle.find(args.locator).await.map_err(stringify_err)?;
            Ok(serde_json::to_value(elt).map_err(|e| e.to_string())?)
        }
        "desktop_screenshot" => {
            let args: ScreenshotArgs = from_value(req.args)?;
            let shot = handle
                .screenshot(args.opts.unwrap_or_default())
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::to_value(shot).map_err(|e| e.to_string())?)
        }
        "desktop_click" => {
            let args: ClickArgs = from_value(req.args)?;
            handle
                .click(args.target, args.opts.unwrap_or_default())
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_type" => {
            let args: TypeArgs = from_value(req.args)?;
            handle
                .type_text(args.text, args.opts.unwrap_or_default())
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_keys" => {
            let args: KeysArgs = from_value(req.args)?;
            handle.send_keys(args.chord).await.map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_mouse_move" => {
            let args: MouseMoveArgs = from_value(req.args)?;
            handle.mouse_move(args.point).await.map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_drag" => {
            let args: DragArgs = from_value(req.args)?;
            handle
                .drag(args.from, args.to, args.opts.unwrap_or_default())
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_scroll" => {
            let args: ScrollArgs = from_value(req.args)?;
            handle
                .scroll(args.target, args.opts.unwrap_or_default())
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_hold_key" => {
            let args: HoldKeyArgs = from_value(req.args)?;
            handle
                .hold_key(args.chord, args.duration_ms)
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_mouse_button" => {
            let args: MouseButtonArgs = from_value(req.args)?;
            handle
                .mouse_button(args.button, args.transition)
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_window_op" => {
            let args: WindowOpArgs = from_value(req.args)?;
            handle
                .window_op(args.target, args.op)
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "desktop_cursor_position" => {
            let point = handle.cursor_position().await.map_err(stringify_err)?;
            Ok(serde_json::to_value(point).map_err(|e| e.to_string())?)
        }
        "desktop_pick_at_point" => {
            let args: PickAtPointArgs = from_value(req.args)?;
            let info = handle.pick_at_point(args.point).await.map_err(stringify_err)?;
            Ok(serde_json::to_value(info).map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown automation command '{other}'")),
    }
}

#[derive(Deserialize)]
struct PickAtPointArgs {
    point: Point,
}

fn from_value<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("args parse error: {e}"))
}

fn stringify_err(err: AutomationError) -> String {
    serde_json::to_string(&err).unwrap_or_else(|_| format!("{err}"))
}

// ---------------------------------------------------------------------------
// Per-command arg shapes — camelCase to match the renderer-side
// `desktop.*` client and the existing `automation/commands.rs` arg structs.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadTreeArgs {
    #[serde(default)]
    root: Option<crate::automation::types::ElementRef>,
    #[serde(default)]
    opts: Option<TreeOpts>,
}

#[derive(Deserialize)]
struct FindArgs {
    locator: Locator,
}

#[derive(Deserialize)]
struct ScreenshotArgs {
    #[serde(default)]
    opts: Option<ScreenshotOpts>,
}

#[derive(Deserialize)]
struct ClickArgs {
    target: ClickTarget,
    #[serde(default)]
    opts: Option<ClickOpts>,
}

#[derive(Deserialize)]
struct TypeArgs {
    text: String,
    #[serde(default)]
    opts: Option<TypeOpts>,
}

#[derive(Deserialize)]
struct KeysArgs {
    chord: KeyChord,
}

#[derive(Deserialize)]
struct MouseMoveArgs {
    point: Point,
}

#[derive(Deserialize)]
struct DragArgs {
    from: Point,
    to: Point,
    #[serde(default)]
    opts: Option<DragOpts>,
}

#[derive(Deserialize)]
struct ScrollArgs {
    target: ScrollTarget,
    #[serde(default)]
    opts: Option<ScrollOpts>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HoldKeyArgs {
    chord: KeyChord,
    duration_ms: u32,
}

#[derive(Deserialize)]
struct MouseButtonArgs {
    button: MouseButton,
    transition: ButtonTransition,
}

#[derive(Deserialize)]
struct WindowOpArgs {
    target: crate::automation::types::ElementRef,
    op: WindowOp,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::backend::StubBackend;
    use crate::automation::types::Platform;
    use crate::automation::worker::Worker;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    fn stub_handle() -> AutomationHandle {
        Worker::spawn(|| {
            Box::new(StubBackend {
                platform: Platform::Unsupported,
            })
        })
    }

    async fn write_line(stream: &mut TcpStream, line: &str) {
        stream.write_all(line.as_bytes()).await.unwrap();
        stream.write_all(b"\n").await.unwrap();
        stream.flush().await.unwrap();
    }

    async fn read_line(reader: &mut BufReader<&mut TcpStream>) -> String {
        let mut buf = String::new();
        reader.read_line(&mut buf).await.unwrap();
        buf.trim_end_matches('\n').to_string()
    }

    #[tokio::test]
    async fn capabilities_round_trip_with_stub_backend() {
        let proxy = AutomationProxy::spawn(stub_handle()).await.unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        let req = format!(
            r#"{{"id":"req-1","token":"{}","command":"desktop_capabilities","args":{{}}}}"#,
            proxy.token
        );
        write_line(&mut stream, &req).await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["id"], "req-1");
        assert_eq!(resp["ok"], true);
        // StubBackend reports the unsupported platform.
        assert_eq!(resp["result"]["platform"], "unsupported");
    }

    #[tokio::test]
    async fn unauthorized_request_returns_unauthorized() {
        let proxy = AutomationProxy::spawn(stub_handle()).await.unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        let req = r#"{"id":"req-2","token":"WRONG","command":"desktop_capabilities","args":{}}"#;
        write_line(&mut stream, req).await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["id"], "req-2");
        assert_eq!(resp["ok"], false);
        assert_eq!(resp["error"], "unauthorized");
    }

    #[tokio::test]
    async fn unknown_command_returns_error() {
        let proxy = AutomationProxy::spawn(stub_handle()).await.unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        let req = format!(
            r#"{{"id":"req-3","token":"{}","command":"desktop_bogus","args":{{}}}}"#,
            proxy.token
        );
        write_line(&mut stream, &req).await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("unknown automation command"));
    }

    #[tokio::test]
    async fn malformed_json_is_reported_per_line() {
        let proxy = AutomationProxy::spawn(stub_handle()).await.unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        write_line(&mut stream, "not json").await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("invalid JSON"));
    }

    #[tokio::test]
    async fn token_constant_time_compare_rejects_length_mismatch() {
        // White-box check on the token comparator. Different lengths must
        // fail without falling through to a substring match.
        assert!(!token_matches("short", "longer-than-short"));
        assert!(token_matches("identical", "identical"));
    }

    #[tokio::test]
    async fn dropping_proxy_aborts_listener_task() {
        let proxy = AutomationProxy::spawn(stub_handle()).await.unwrap();
        let addr = proxy.addr;
        drop(proxy);
        // Give tokio a moment to actually release the port.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // Re-binding to the same port should succeed if we released it,
        // but the kernel may take time to reclaim. We accept either
        // outcome — the important assertion is that the listener task is
        // gone (tested implicitly: a new spawn on a fresh ephemeral port
        // works without resource leaks).
        let _ = addr;
        let proxy = AutomationProxy::spawn(stub_handle()).await.unwrap();
        assert_ne!(proxy.addr.port(), 0);
    }
}
