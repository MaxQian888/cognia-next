//! Side-channel IPC bridge that lets the Node MCP (External Bridge) sidecar
//! drive Cognia's RENDERER-resident orchestration entry points
//! (`agent_dispatch` / `team_run` / `plugin_tool_invoke`).
//!
//! # Why a renderer round-trip
//!
//! Unlike `automation_proxy` (which dispatches to a native Rust
//! `AutomationHandle`), the orchestration entry points — `executeAgent`,
//! `agentTeamManager`, `invokePluginTool` — live in the renderer JS, not in
//! Rust and not in the Node sidecar. So this proxy executes nothing itself: it
//! forwards each request to the renderer over a Tauri event, parks a `oneshot`
//! keyed by request id, and the renderer posts the result back through the
//! `orchestration_proxy_response` Tauri command, which fires the oneshot.
//!
//! The transport-security shell (token auth + per-peer rate limit) is shared
//! with `automation_proxy` via `proxy_common`; only the dispatch target differs.
//!
//! # Wire shape (sidecar ⇄ Rust)
//!   request:  `{ "id", "token", "command", "args" }`
//!   response: `{ "id", "ok": true, "result": <value> }`
//!             `{ "id", "ok": false, "error": "<message>" }`
//!
//! # Renderer round-trip (Rust ⇄ renderer)
//!   emit `orchestration-proxy:exec`  `{ "id", "command", "args" }`
//!   recv command `orchestration_proxy_response`  `{ id, ok, result?, error? }`
//!
//! # PII boundary
//!
//! Redaction happens in the renderer handler (`orchestration.ts` `*Core`)
//! BEFORE the result crosses back over the socket, so Rust only ever sees
//! already-redacted text. Rust treats `result` as opaque and never logs it.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::proxy_common::{generate_token, token_matches, RateLimitOutcome, RateLimiter};

/// Tauri event the renderer dispatch provider listens on.
const EXEC_EVENT: &str = "orchestration-proxy:exec";

/// How long Rust waits for the renderer to answer before giving up.
/// Orchestration runs (agent_dispatch / team_run) can be long, so this is
/// generous; on timeout the parked oneshot is dropped so it can't leak.
const RENDERER_TIMEOUT: Duration = Duration::from_secs(600);

/// Reply the renderer posts back via `orchestration_proxy_response`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationReply {
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Parked replies keyed by request id.
type PendingMap = ParkingMutex<HashMap<String, oneshot::Sender<OrchestrationReply>>>;

/// Live proxy handle. Drop aborts the listener task; closing the listener frees
/// the bound port.
pub struct OrchestrationProxy {
    /// Bound address — `127.0.0.1:<port>`. Forwarded via `COGNIA_ORCH_PROXY`.
    pub addr: SocketAddr,
    /// Shared-secret token. Forwarded via `COGNIA_ORCH_PROXY_TOKEN`.
    pub token: String,
    pending: Arc<PendingMap>,
    listener_task: Option<JoinHandle<()>>,
}

impl OrchestrationProxy {
    /// Bind a fresh listener on `127.0.0.1` and start accepting connections.
    pub async fn spawn(app: AppHandle) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let token = generate_token();
        let expected = Arc::new(token.clone());
        let pending: Arc<PendingMap> = Arc::new(ParkingMutex::new(HashMap::new()));
        let rate_limiter = Arc::new(RateLimiter::default());
        let app = Arc::new(app);

        let task = {
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                loop {
                    let (stream, peer_addr) = match listener.accept().await {
                        Ok(pair) => pair,
                        Err(err) => {
                            eprintln!("[orchestration_proxy] accept failed: {err}");
                            continue;
                        }
                    };
                    let expected = Arc::clone(&expected);
                    let rate_limiter = Arc::clone(&rate_limiter);
                    let pending = Arc::clone(&pending);
                    let app = Arc::clone(&app);
                    let peer_ip = peer_addr.ip();
                    tokio::spawn(async move {
                        if let Err(err) =
                            serve_connection(stream, expected, rate_limiter, pending, app, peer_ip)
                                .await
                        {
                            eprintln!("[orchestration_proxy] connection error: {err}");
                        }
                    });
                }
            })
        };

        Ok(Self {
            addr,
            token,
            pending,
            listener_task: Some(task),
        })
    }

    /// Fire the parked oneshot for `id` with the renderer's reply.
    ///
    /// Idempotent: an unknown / already-resolved id is a no-op, so a second
    /// renderer window answering the same exec event can't double-resolve
    /// (first reply wins).
    pub fn resolve(&self, id: &str, reply: OrchestrationReply) {
        resolve_pending(&self.pending, id, reply);
    }
}

impl Drop for OrchestrationProxy {
    fn drop(&mut self) {
        if let Some(task) = self.listener_task.take() {
            task.abort();
        }
    }
}

/// Remove + fire the parked oneshot for `id`. First reply wins; later replies
/// for the same id are dropped.
fn resolve_pending(pending: &PendingMap, id: &str, reply: OrchestrationReply) {
    let sender = pending.lock().remove(id);
    if let Some(tx) = sender {
        let _ = tx.send(reply);
    }
}

// ---------------------------------------------------------------------------
// Connection state machine — one task per accepted TCP connection.
// ---------------------------------------------------------------------------

async fn serve_connection(
    stream: tokio::net::TcpStream,
    expected_token: Arc<String>,
    rate_limiter: Arc<RateLimiter>,
    pending: Arc<PendingMap>,
    app: Arc<AppHandle>,
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
                write_response(
                    &writer,
                    &ProxyResponse::error("", format!("invalid JSON: {err}")),
                )
                .await?;
                continue;
            }
        };

        // Constant-time token check before any work.
        if !token_matches(&req.token, expected_token.as_str()) {
            let just_locked = rate_limiter.record_bad_token(peer_ip, Instant::now());
            write_response(
                &writer,
                &ProxyResponse::error(&req.id, "unauthorized".into()),
            )
            .await?;
            if just_locked {
                eprintln!(
                    "[orchestration_proxy] peer {peer_ip} hit bad-token threshold; closing connection",
                );
                return Ok(());
            }
            continue;
        }

        // Per-peer token-bucket rate limit.
        match rate_limiter.check(peer_ip, Instant::now()) {
            RateLimitOutcome::Allow => {}
            RateLimitOutcome::LimitedTryAgain => {
                write_response(
                    &writer,
                    &ProxyResponse::error(
                        &req.id,
                        "rate_limited: too many orchestration_proxy calls".into(),
                    ),
                )
                .await?;
                continue;
            }
            RateLimitOutcome::LockedOut => {
                write_response(
                    &writer,
                    &ProxyResponse::error(
                        &req.id,
                        "locked_out: too many recent bad-token attempts; try again later".into(),
                    ),
                )
                .await?;
                return Ok(());
            }
        }

        // Dispatch the renderer round-trip in its own task so a long-running
        // orchestration call can't block the read loop on this socket.
        let writer = Arc::clone(&writer);
        let pending = Arc::clone(&pending);
        let app = Arc::clone(&app);
        tokio::spawn(async move {
            let resp = dispatch(req, &pending, &app).await;
            if let Err(err) = write_response(&writer, &resp).await {
                eprintln!("[orchestration_proxy] write failed: {err}");
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
// Dispatch — emit to the renderer and await its reply.
// ---------------------------------------------------------------------------

async fn dispatch(req: ProxyRequest, pending: &PendingMap, app: &AppHandle) -> ProxyResponse {
    dispatch_with_emit(req, pending, RENDERER_TIMEOUT, |ev| {
        app.emit(EXEC_EVENT, ev).map_err(|e| e.to_string())
    })
    .await
}

/// Core dispatch, generic over the emit sink so the renderer round-trip is
/// unit-testable without a real `AppHandle`. Parks a oneshot keyed by `id`,
/// emits the exec event, then awaits the renderer's reply (bounded by
/// `timeout`). On emit failure or timeout the parked entry is cleaned up.
async fn dispatch_with_emit<F>(
    req: ProxyRequest,
    pending: &PendingMap,
    timeout: Duration,
    emit: F,
) -> ProxyResponse
where
    F: FnOnce(ExecEvent) -> Result<(), String>,
{
    let id = req.id.clone();
    let (tx, rx) = oneshot::channel();
    pending.lock().insert(id.clone(), tx);

    let ev = ExecEvent {
        id: id.clone(),
        command: req.command,
        args: req.args,
    };
    if let Err(err) = emit(ev) {
        pending.lock().remove(&id);
        return ProxyResponse::error(&id, format!("failed to reach renderer: {err}"));
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(reply)) => {
            if reply.ok {
                ProxyResponse {
                    id,
                    ok: true,
                    result: reply.result,
                    error: None,
                }
            } else {
                ProxyResponse::error(
                    &id,
                    reply.error.unwrap_or_else(|| "orchestration failed".into()),
                )
            }
        }
        // Sender dropped without sending (e.g. proxy torn down mid-flight).
        Ok(Err(_canceled)) => ProxyResponse::error(&id, "renderer reply channel closed".into()),
        Err(_elapsed) => {
            pending.lock().remove(&id);
            ProxyResponse::error(&id, "orchestration_proxy: renderer timeout".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ProxyRequest {
    id: String,
    token: String,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
struct ProxyResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ProxyResponse {
    fn error(id: &str, message: String) -> Self {
        Self {
            id: id.to_string(),
            ok: false,
            result: None,
            error: Some(message),
        }
    }
}

/// Payload emitted to the renderer for one orchestration request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecEvent {
    id: String,
    command: String,
    args: Value,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(id: &str, command: &str) -> ProxyRequest {
        ProxyRequest {
            id: id.to_string(),
            token: String::new(),
            command: command.to_string(),
            args: json!({}),
        }
    }

    #[tokio::test]
    async fn round_trip_returns_renderer_result() {
        let pending: PendingMap = ParkingMutex::new(HashMap::new());
        let resp = dispatch_with_emit(
            req("r1", "agent_dispatch"),
            &pending,
            Duration::from_secs(5),
            |ev| {
                assert_eq!(ev.command, "agent_dispatch");
                // Simulate the renderer answering immediately (send-before-recv
                // is valid for a oneshot).
                resolve_pending(
                    &pending,
                    &ev.id,
                    OrchestrationReply {
                        ok: true,
                        result: Some(json!({ "text": "hi" })),
                        error: None,
                    },
                );
                Ok(())
            },
        )
        .await;
        assert_eq!(resp.id, "r1");
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap()["text"], "hi");
        assert!(pending.lock().is_empty(), "pending entry must be drained");
    }

    #[tokio::test]
    async fn renderer_failure_reply_becomes_error_response() {
        let pending: PendingMap = ParkingMutex::new(HashMap::new());
        let resp = dispatch_with_emit(
            req("r2", "team_run"),
            &pending,
            Duration::from_secs(5),
            |ev| {
                resolve_pending(
                    &pending,
                    &ev.id,
                    OrchestrationReply {
                        ok: false,
                        result: None,
                        error: Some("scope denied".into()),
                    },
                );
                Ok(())
            },
        )
        .await;
        assert!(!resp.ok);
        assert_eq!(resp.error.as_deref(), Some("scope denied"));
    }

    #[tokio::test]
    async fn emit_failure_cleans_up_and_reports() {
        let pending: PendingMap = ParkingMutex::new(HashMap::new());
        let resp = dispatch_with_emit(
            req("r3", "plugin_tool_invoke"),
            &pending,
            Duration::from_secs(5),
            |_ev| Err("no main window".into()),
        )
        .await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("failed to reach renderer"));
        assert!(
            pending.lock().is_empty(),
            "pending entry must be cleaned up"
        );
    }

    #[tokio::test]
    async fn renderer_timeout_returns_error_and_cleans_up() {
        let pending: PendingMap = ParkingMutex::new(HashMap::new());
        // Emit succeeds but the renderer never answers → timeout fires fast.
        let resp = dispatch_with_emit(
            req("r4", "agent_dispatch"),
            &pending,
            Duration::from_millis(20),
            |_ev| Ok(()),
        )
        .await;
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("renderer timeout"));
        assert!(
            pending.lock().is_empty(),
            "timed-out entry must be cleaned up"
        );
    }

    #[test]
    fn resolve_pending_is_idempotent() {
        let pending: PendingMap = ParkingMutex::new(HashMap::new());
        let (tx, rx) = oneshot::channel();
        pending.lock().insert("x".to_string(), tx);
        resolve_pending(
            &pending,
            "x",
            OrchestrationReply {
                ok: true,
                result: None,
                error: None,
            },
        );
        assert!(rx.blocking_recv().is_ok(), "first resolve delivers");
        // Second resolve for the same id is a no-op (already removed).
        resolve_pending(
            &pending,
            "x",
            OrchestrationReply {
                ok: false,
                result: None,
                error: Some("late".into()),
            },
        );
        assert!(pending.lock().is_empty());
    }

    #[test]
    fn proxy_response_error_shape() {
        let e = ProxyResponse::error("id1", "boom".into());
        assert_eq!(e.id, "id1");
        assert!(!e.ok);
        assert_eq!(e.error.as_deref(), Some("boom"));
        assert!(e.result.is_none());
    }
}
