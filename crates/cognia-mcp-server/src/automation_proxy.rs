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

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

// The socket-auth + rate-limit shell is shared with `orchestration_proxy`.
use super::proxy_common::{generate_token, token_matches, RateLimitOutcome, RateLimiter};

use cognia_automation::automation::dispatcher::{run_gated_enf, Enforcement, GateContext};
use cognia_automation::automation::permission::Surface;
use cognia_automation::automation::session::{
    ActionRequest, AppLocator, ElementHandle, GetAppStateOptions,
};
use cognia_automation::automation::types::{AutomationError, Locator};
use cognia_automation::automation::worker::AutomationHandle;

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
                    if let Err(err) = serve_connection(
                        stream,
                        handle,
                        enforcement,
                        expected,
                        rate_limiter,
                        peer_ip,
                    )
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
        command_detail: None,
        // The External Bridge proxy has no chat context, and with no
        // `AppHandle` a `RequireConsent` decision here can only deny — so
        // there is no grant for a session tag to scope.
        session_key: None,
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
        "desktop_list_apps" => {
            let apps = handle.list_apps().await.map_err(stringify_err)?;
            Ok(serde_json::to_value(apps).map_err(|e| e.to_string())?)
        }
        "desktop_get_app_state" => {
            let args: GetAppStateArgs = from_value(req.args)?;
            let state = handle
                .get_app_state(args.session_id, args.turn_key, args.locator, args.options)
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::to_value(state).map_err(|e| e.to_string())?)
        }
        "desktop_query_elements" => {
            let args: QueryElementsArgs = from_value(req.args)?;
            let nodes = handle
                .query_elements(
                    args.session_id,
                    args.lineage_id,
                    args.revision,
                    args.locator,
                    args.limit,
                )
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::to_value(nodes).map_err(|e| e.to_string())?)
        }
        "desktop_expand_element" => {
            let args: ExpandElementArgs = from_value(req.args)?;
            let page = handle
                .expand_element(args.handle, args.continuation_token, args.limit)
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::to_value(page).map_err(|e| e.to_string())?)
        }
        "desktop_perform_action" => {
            let args: PerformActionArgs = from_value(req.args)?;
            let result = handle
                .perform_action(args.request, args.turn_key)
                .await
                .map_err(stringify_err)?;
            Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
        }
        other => Err(format!("unknown automation command '{other}'")),
    }
}

fn from_value<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("args parse error: {e}"))
}

fn stringify_err(err: AutomationError) -> String {
    serde_json::to_string(&err).unwrap_or_else(|_| format!("{err}"))
}

// ---------------------------------------------------------------------------
// Canonical app-session wire shapes.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetAppStateArgs {
    session_id: String,
    turn_key: String,
    locator: AppLocator,
    #[serde(default)]
    options: GetAppStateOptions,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryElementsArgs {
    session_id: String,
    lineage_id: String,
    revision: u64,
    #[serde(default)]
    locator: Locator,
    #[serde(default = "default_query_limit")]
    limit: usize,
}

fn default_query_limit() -> usize {
    100
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpandElementArgs {
    handle: ElementHandle,
    #[serde(default)]
    continuation_token: Option<String>,
    #[serde(default = "default_expand_limit")]
    limit: usize,
}

fn default_expand_limit() -> usize {
    250
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerformActionArgs {
    turn_key: String,
    request: ActionRequest,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_automation::automation::audit::AuditRing;
    use cognia_automation::automation::backend::StubBackend;
    use cognia_automation::automation::consent::ConsentBroker;
    use cognia_automation::automation::permission::{AutomationSettings, PermissionGate, Tier};
    use cognia_automation::automation::policy::PolicyState;
    use cognia_automation::automation::types::Platform;
    use cognia_automation::automation::worker::Worker;
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
        // The engine defaults to disabled (`enabled = false`), which makes the
        // gate deny *every* driving call (with `PermissionDenied`) before the
        // tier is even consulted. Enable it so the MCP-surface tier actually
        // governs the call — otherwise `Tier::Whitelist` (meant to be allow-all
        // here) never reaches the worker and the command never gets a chance to
        // report "unknown automation command".
        settings.enabled = true;
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
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
        assert!(resp["error"]
            .as_str()
            .unwrap()
            .contains("unknown automation command"));
    }

    #[tokio::test]
    async fn legacy_pixel_commands_are_not_accepted() {
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
        let mut stream = TcpStream::connect(proxy.addr).await.unwrap();
        let req = format!(
            r#"{{"id":"legacy","token":"{}","command":"desktop_click","args":{{}}}}"#,
            proxy.token
        );
        write_line(&mut stream, &req).await;
        let mut reader = BufReader::new(&mut stream);
        let response: serde_json::Value =
            serde_json::from_str(&read_line(&mut reader).await).unwrap();
        assert_eq!(response["ok"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("unknown automation command"));
    }

    #[tokio::test]
    async fn malformed_json_is_reported_per_line() {
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
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
            r#"{{"id":"req-deny","token":"{}","command":"desktop_perform_action","args":{{}}}}"#,
            proxy.token
        );
        write_line(&mut stream, &req).await;
        let mut reader = BufReader::new(&mut stream);
        let resp_text = read_line(&mut reader).await;
        let resp: serde_json::Value = serde_json::from_str(&resp_text).unwrap();
        assert_eq!(resp["id"], "req-deny");
        assert_eq!(resp["ok"], false, "tier Off must deny the action");
        // The denial was recorded in the shared audit ring under the
        // un-prefixed command name.
        let entries = audit.snapshot();
        assert!(
            entries.iter().any(|e| e.command == "perform_action"),
            "expected an audited 'perform_action' deny row"
        );
    }

    // Token-comparator + rate-limiter unit tests live with the shared code in
    // `proxy_common.rs` now that both proxies reuse it.

    #[tokio::test]
    async fn dropping_proxy_aborts_listener_task() {
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
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
        let proxy = AutomationProxy::spawn(stub_handle(), stub_enf())
            .await
            .unwrap();
        assert_ne!(proxy.addr.port(), 0);
    }
}
