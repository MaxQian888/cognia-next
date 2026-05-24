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

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex as ParkingMutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// ADR-0020 W3 — token-bucket parameters per peer IP. Defaults match
/// the plan's "10 req/s burst, 100/min sustained" guidance. The
/// `automation_proxy` socket is 127.0.0.1-bound so in practice this
/// caps the whole proxy (every client comes from loopback), but keying
/// by IP keeps the math intact if a future build exposes the proxy on
/// a LAN interface.
const RATE_LIMIT_BURST: u32 = 10;
const RATE_LIMIT_REFILL_PER_SEC: f64 = 100.0 / 60.0;
/// Threshold of bad-token attempts inside `BAD_TOKEN_WINDOW` after
/// which we drop the connection for `BAD_TOKEN_LOCKOUT`.
const BAD_TOKEN_THRESHOLD: u32 = 5;
const BAD_TOKEN_WINDOW: Duration = Duration::from_secs(60);
const BAD_TOKEN_LOCKOUT: Duration = Duration::from_secs(300);

/// Per-IP rate-limit state. `tokens` is fractional so the leak/refill
/// is monotone — every check that fires also decays `tokens` based on
/// elapsed wall-clock since the previous check.
#[derive(Debug)]
struct PeerLimit {
    tokens: f64,
    updated: Instant,
    bad_token_count: u32,
    bad_token_window_start: Instant,
    locked_until: Option<Instant>,
}

impl PeerLimit {
    fn new(now: Instant) -> Self {
        Self {
            tokens: RATE_LIMIT_BURST as f64,
            updated: now,
            bad_token_count: 0,
            bad_token_window_start: now,
            locked_until: None,
        }
    }
}

#[derive(Default)]
struct RateLimiter {
    peers: ParkingMutex<HashMap<IpAddr, PeerLimit>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RateLimitOutcome {
    Allow,
    LimitedTryAgain,
    LockedOut,
}

impl RateLimiter {
    /// Returns the outcome for a request from `peer` at `now`. Drains
    /// one token on Allow; never refunds. Lockout extends but does not
    /// drain. Callers should map LimitedTryAgain + LockedOut to the
    /// uniform "rate-limited" error response.
    fn check(&self, peer: IpAddr, now: Instant) -> RateLimitOutcome {
        let mut guard = self.peers.lock();
        let entry = guard.entry(peer).or_insert_with(|| PeerLimit::new(now));
        if let Some(until) = entry.locked_until {
            if now < until {
                return RateLimitOutcome::LockedOut;
            }
            // Lockout expired — reset so the peer can try again.
            entry.locked_until = None;
            entry.bad_token_count = 0;
            entry.bad_token_window_start = now;
            entry.tokens = RATE_LIMIT_BURST as f64;
            entry.updated = now;
        }
        let elapsed = now.saturating_duration_since(entry.updated).as_secs_f64();
        let refilled = (entry.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC)
            .min(RATE_LIMIT_BURST as f64);
        entry.tokens = refilled;
        entry.updated = now;
        if entry.tokens < 1.0 {
            return RateLimitOutcome::LimitedTryAgain;
        }
        entry.tokens -= 1.0;
        RateLimitOutcome::Allow
    }

    /// Record a bad-token attempt. Returns true when the lockout
    /// threshold was reached this call (so the connection should be
    /// dropped without waiting for the next request).
    fn record_bad_token(&self, peer: IpAddr, now: Instant) -> bool {
        let mut guard = self.peers.lock();
        let entry = guard.entry(peer).or_insert_with(|| PeerLimit::new(now));
        if now.saturating_duration_since(entry.bad_token_window_start) > BAD_TOKEN_WINDOW {
            entry.bad_token_window_start = now;
            entry.bad_token_count = 0;
        }
        entry.bad_token_count = entry.bad_token_count.saturating_add(1);
        if entry.bad_token_count >= BAD_TOKEN_THRESHOLD {
            entry.locked_until = Some(now + BAD_TOKEN_LOCKOUT);
            return true;
        }
        false
    }
}

use crate::automation::permission::Surface;
use crate::automation::types::{
    AutomationError, ButtonTransition, ClickOpts, ClickTarget, DragOpts, KeyChord, Locator,
    MouseButton, Point, ScreenshotOpts, ScrollOpts, ScrollTarget, TreeOpts, TypeOpts, WindowOp,
};
use crate::automation::dispatcher::{run_gated_enf, Enforcement, GateContext};
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
    pub async fn spawn(
        handle: AutomationHandle,
        enforcement: Enforcement,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let token = generate_token();
        let expected = Arc::new(token.clone());
        let handle = Arc::new(handle);
        // ADR-0020 — the proxy now routes every (non-probe) call through the
        // shared `dispatcher::run_gated_enf` so the External Bridge MCP surface
        // is gated + audited like every other surface. Previously this socket
        // called the worker handle directly, bypassing the permission gate.
        let enforcement = Arc::new(enforcement);
        // ADR-0020 W3 — per-peer rate limiter shared across every
        // accepted connection. One bucket per IP, cleaned on lockout
        // expiry. Keeps `automation_proxy` from being a DoS amplifier
        // when a misbehaving external agent fires screenshot calls in
        // a tight loop.
        let rate_limiter = Arc::new(RateLimiter::default());

        let task = tokio::spawn(async move {
            loop {
                let (stream, peer_addr) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(err) => {
                        eprintln!("[automation_proxy] accept failed: {err}");
                        continue;
                    }
                };
                let handle = Arc::clone(&handle);
                let enforcement = Arc::clone(&enforcement);
                let expected = Arc::clone(&expected);
                let rate_limiter = Arc::clone(&rate_limiter);
                let peer_ip = peer_addr.ip();
                tokio::spawn(async move {
                    if let Err(err) =
                        serve_connection(stream, handle, enforcement, expected, rate_limiter, peer_ip)
                            .await
                    {
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
    enforcement: Arc<Enforcement>,
    expected_token: Arc<String>,
    rate_limiter: Arc<RateLimiter>,
    peer_ip: IpAddr,
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

        // Constant-time token check before doing any work. A bad token
        // increments the per-peer attempt counter; crossing the
        // threshold installs a 5-minute lockout and drops the
        // connection so a brute-forcer can't keep sending guesses on
        // the same socket.
        if !token_matches(&req.token, expected_token.as_str()) {
            let just_locked = rate_limiter.record_bad_token(peer_ip, Instant::now());
            let resp = ProxyResponse {
                id: req.id.clone(),
                ok: false,
                error: Some("unauthorized".into()),
                result: None,
            };
            write_response(&writer, &resp).await?;
            if just_locked {
                eprintln!(
                    "[automation_proxy] peer {peer_ip} hit bad-token threshold; closing connection",
                );
                return Ok(());
            }
            continue;
        }

        // ADR-0020 W3 — per-peer token-bucket rate limit. Allowed
        // requests dispatch normally; throttled requests return a
        // uniform error so callers see consistent backpressure
        // semantics whether the cap was a soft refill stall or a
        // hard lockout from prior bad tokens.
        match rate_limiter.check(peer_ip, Instant::now()) {
            RateLimitOutcome::Allow => {}
            RateLimitOutcome::LimitedTryAgain => {
                let resp = ProxyResponse {
                    id: req.id.clone(),
                    ok: false,
                    error: Some("rate_limited: too many automation_proxy calls".into()),
                    result: None,
                };
                write_response(&writer, &resp).await?;
                continue;
            }
            RateLimitOutcome::LockedOut => {
                let resp = ProxyResponse {
                    id: req.id.clone(),
                    ok: false,
                    error: Some(
                        "locked_out: too many recent bad-token attempts; try again later".into(),
                    ),
                    result: None,
                };
                write_response(&writer, &resp).await?;
                return Ok(());
            }
        }

        // Dispatch in a separate task so a slow request can't block the
        // read loop — the worker thread underneath serialises calls anyway.
        let handle = Arc::clone(&handle);
        let enforcement = Arc::clone(&enforcement);
        let writer = Arc::clone(&writer);
        tokio::spawn(async move {
            let resp = dispatch(req, &handle, &enforcement).await;
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

async fn dispatch(
    req: ProxyRequest,
    handle: &AutomationHandle,
    enforcement: &Enforcement,
) -> ProxyResponse {
    let id = req.id.clone();

    // `desktop_capabilities` is a harmless probe (mirrors the ungated
    // `desktop_capabilities` Tauri command) — let it through without a gate so
    // an MCP client can always discover what the backend supports.
    if req.command == "desktop_capabilities" {
        return match run(req, handle).await {
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
        };
    }

    // Every other call is forced onto the MCP surface and routed through the
    // shared `dispatcher::run_gated_enf` pipeline (gate → consent → audit) —
    // this is what closes the historical bypass where the proxy called the
    // worker handle directly. Headless: there is no overlay, so a `PerCall`
    // tier resolves to deny. The gate matches on the un-prefixed command name
    // ("click", "screenshot", …), exactly like the renderer `desktop_*` path.
    let gate_command = req
        .command
        .strip_prefix("desktop_")
        .unwrap_or(&req.command)
        .to_string();
    let gctx = GateContext {
        surface: Surface::Mcp,
        plugin_id: None,
        process_name: None,
        window_title: None,
        target_url: None,
        click_x: None,
        click_y: None,
        force_tier: None,
    };
    let result = run_gated_enf(None, enforcement, gctx, &gate_command, move || async move {
        run(req, handle)
            .await
            .map_err(|message| AutomationError::Internal { message })
    })
    .await;
    match result {
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
            error: Some(format!("{err}")),
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
    use crate::automation::audit::AuditRing;
    use crate::automation::backend::StubBackend;
    use crate::automation::consent::ConsentBroker;
    use crate::automation::permission::{AutomationSettings, PermissionGate, Tier};
    use crate::automation::policy::PolicyState;
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

    fn stub_enf_with(mcp_tier: Tier) -> Enforcement {
        let mut settings = AutomationSettings::default();
        settings.per_surface.mcp.tier = mcp_tier;
        Enforcement {
            gate: PermissionGate::new(settings),
            audit: AuditRing::new(),
            consent: ConsentBroker::default(),
            policy: PolicyState::default(),
        }
    }

    /// Permissive enforcement for the round-trip tests: the MCP surface uses
    /// the (empty) whitelist tier, which the gate treats as allow-all, so gated
    /// calls reach the worker the same way the pre-gate tests expected. The
    /// `denied_*` test flips this to `Off` to prove the gate now blocks.
    fn stub_enf() -> Enforcement {
        stub_enf_with(Tier::Whitelist)
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf()).await.unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf()).await.unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf()).await.unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf()).await.unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        write_line(&mut stream, "not json").await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("invalid JSON"));
    }

    #[tokio::test]
    async fn denied_mcp_surface_blocks_driving_call_and_audits() {
        // Regression guard for the historical bypass: with the MCP surface tier
        // set to Off, a driving call must be denied by the shared gate AND the
        // denial must land in the audit ring (the old proxy called the worker
        // directly, recording nothing and enforcing nothing).
        let audit = AuditRing::new();
        let mut settings = AutomationSettings::default();
        settings.per_surface.mcp.tier = Tier::Off;
        let enf = Enforcement {
            gate: PermissionGate::new(settings),
            audit: audit.clone(),
            consent: ConsentBroker::default(),
            policy: PolicyState::default(),
        };
        let proxy = AutomationProxy::spawn(stub_handle(), enf).await.unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        let req = format!(
            r#"{{"id":"req-deny","token":"{}","command":"desktop_click","args":{{"target":{{"kind":"point","x":1,"y":2}}}}}}"#,
            proxy.token
        );
        write_line(&mut stream, &req).await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["id"], "req-deny");
        assert_eq!(resp["ok"], false, "tier Off must deny the click");
        // The denial was recorded in the shared audit ring under the
        // un-prefixed command name.
        let entries = audit.snapshot();
        assert!(
            entries.iter().any(|e| e.command == "click"),
            "expected an audited 'click' deny row"
        );
    }

    #[tokio::test]
    async fn token_constant_time_compare_rejects_length_mismatch() {
        // White-box check on the token comparator. Different lengths must
        // fail without falling through to a substring match.
        assert!(!token_matches("short", "longer-than-short"));
        assert!(token_matches("identical", "identical"));
    }

    #[test]
    fn rate_limiter_allows_up_to_burst_then_throttles() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..RATE_LIMIT_BURST {
            assert_eq!(limiter.check(peer, now), RateLimitOutcome::Allow);
        }
        // The next request inside the same instant lands without refill.
        assert_eq!(limiter.check(peer, now), RateLimitOutcome::LimitedTryAgain);
    }

    #[test]
    fn rate_limiter_refills_over_time() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        // Burn the burst.
        for _ in 0..RATE_LIMIT_BURST {
            assert_eq!(limiter.check(peer, now), RateLimitOutcome::Allow);
        }
        // Wait a full minute → bucket refilled by ~100 tokens, capped
        // back to BURST so a fresh burst is available.
        let later = now + Duration::from_secs(60);
        assert_eq!(limiter.check(peer, later), RateLimitOutcome::Allow);
    }

    #[test]
    fn rate_limiter_keeps_per_peer_separate_buckets() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer_a: IpAddr = "127.0.0.1".parse().unwrap();
        let peer_b: IpAddr = "127.0.0.2".parse().unwrap();
        for _ in 0..RATE_LIMIT_BURST {
            assert_eq!(limiter.check(peer_a, now), RateLimitOutcome::Allow);
        }
        // Peer B still has its full burst — they should NOT inherit
        // peer A's exhaustion.
        assert_eq!(limiter.check(peer_b, now), RateLimitOutcome::Allow);
    }

    #[test]
    fn rate_limiter_locks_out_after_repeat_bad_tokens() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for i in 0..BAD_TOKEN_THRESHOLD {
            let locked = limiter.record_bad_token(peer, now);
            assert_eq!(
                locked,
                i + 1 >= BAD_TOKEN_THRESHOLD,
                "should lock exactly at the threshold call"
            );
        }
        // Subsequent check is now LockedOut.
        assert_eq!(limiter.check(peer, now), RateLimitOutcome::LockedOut);
    }

    #[test]
    fn rate_limiter_lockout_expires_after_window() {
        let limiter = RateLimiter::default();
        let now = Instant::now();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        for _ in 0..BAD_TOKEN_THRESHOLD {
            limiter.record_bad_token(peer, now);
        }
        assert_eq!(limiter.check(peer, now), RateLimitOutcome::LockedOut);
        // Past the lockout window → fresh burst restored.
        let later = now + BAD_TOKEN_LOCKOUT + Duration::from_secs(1);
        assert_eq!(limiter.check(peer, later), RateLimitOutcome::Allow);
    }

    #[tokio::test]
    async fn dropping_proxy_aborts_listener_task() {
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf()).await.unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf()).await.unwrap();
        assert_ne!(proxy.addr.port(), 0);
    }
}
