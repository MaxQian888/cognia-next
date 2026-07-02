//! `cognia acp` — stdio ⇄ WebSocket bridge for the cognia ACP server.
//!
//! ACP clients (Zed, Neovim, JetBrains) speak the Agent Client Protocol to a
//! child process over stdin/stdout (newline-delimited JSON-RPC). cognia's ACP
//! server lives on the companion API as a WebSocket (`/ws/v1/acp`, one
//! JSON-RPC message per text frame). This subcommand is the shim between the
//! two: editors configure `{"command": "cognia", "args": ["acp"]}` and get a
//! full cognia agent.
//!
//! # Connection resolution
//!
//! 1. `COGNIA_ACP_URL` + `COGNIA_ACP_TOKEN` env vars, when both set —
//!    headless / manual override.
//! 2. Otherwise: discover the running desktop via the CLI bridge
//!    (`cli-endpoint.json`), then `POST /api/v1/dev/acp/token` to mint a
//!    device-scope JWT and learn the `wss://` URL.
//!
//! # TLS
//!
//! The companion API terminates HTTPS with a self-signed certificate whose
//! trust is pinned out-of-band (mobile pairing QR). For this bridge the
//! connection target is loopback — the network path is the kernel's loopback
//! driver — so certificate verification is skipped, exactly the trust model
//! of the plain-HTTP CLI bridge next door. Non-loopback URLs are refused
//! unless explicitly supplied via `COGNIA_ACP_URL` (the user's own choice).

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::io::{BufRead, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::{Connector, Message, WebSocket};

use crate::http_client;

/// How long the poll loop sleeps in the underlying socket read before
/// checking the stdin channel again.
const READ_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Broker response from `POST /api/v1/dev/acp/token`.
#[derive(Debug, Deserialize)]
struct AcpTokenResponse {
    ok: bool,
    #[serde(default, rename = "wsUrl")]
    ws_url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    error: Option<String>,
}

/// Resolved connection target.
#[derive(Debug, PartialEq)]
pub(crate) struct ConnectionTarget {
    pub ws_url: String,
    pub token: String,
}

/// Resolve the WS URL + token: env override first, broker second.
pub(crate) fn resolve_target() -> Result<ConnectionTarget> {
    let env_url = std::env::var("COGNIA_ACP_URL").ok().filter(|s| !s.is_empty());
    let env_token = std::env::var("COGNIA_ACP_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    match (env_url, env_token) {
        (Some(ws_url), Some(token)) => return Ok(ConnectionTarget { ws_url, token }),
        (Some(_), None) => {
            bail!("COGNIA_ACP_URL is set but COGNIA_ACP_TOKEN is missing — set both, or neither")
        }
        _ => {}
    }

    let endpoint = http_client::load_endpoint()?;
    let response: AcpTokenResponse = http_client::post_json(
        &endpoint,
        "/api/v1/dev/acp/token",
        &serde_json::json!({}),
    )?;
    if !response.ok {
        bail!(
            "ACP token broker refused: {}",
            response.error.unwrap_or_else(|| "unknown error".into())
        );
    }
    if response.ws_url.is_empty() || response.token.is_empty() {
        bail!("ACP token broker returned an incomplete response — update the cognia desktop app");
    }
    Ok(ConnectionTarget {
        ws_url: response.ws_url,
        token: response.token,
    })
}

/// Append the `?token=` query parameter (the companion JWT middleware accepts
/// tokens via query string on WS upgrades, where headers are awkward for
/// some clients).
pub(crate) fn url_with_token(ws_url: &str, token: &str) -> String {
    let sep = if ws_url.contains('?') { '&' } else { '?' };
    format!("{ws_url}{sep}token={token}")
}

/// Parse `host:port` out of a `ws://` / `wss://` URL. Returns
/// `(host, port, is_tls)`.
pub(crate) fn parse_ws_host(ws_url: &str) -> Result<(String, u16, bool)> {
    let (is_tls, rest) = if let Some(rest) = ws_url.strip_prefix("wss://") {
        (true, rest)
    } else if let Some(rest) = ws_url.strip_prefix("ws://") {
        (false, rest)
    } else {
        bail!("ACP URL must start with ws:// or wss:// (got {ws_url})");
    };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let (host, port_str) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => (authority, if is_tls { "443" } else { "80" }),
    };
    if host.is_empty() {
        bail!("ACP URL has no host (got {ws_url})");
    }
    let port: u16 = port_str
        .parse()
        .map_err(|_| anyhow!("invalid port in ACP URL {ws_url}"))?;
    Ok((host.to_string(), port, is_tls))
}

/// Whether a host string names the loopback interface.
pub(crate) fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

pub fn run() -> Result<()> {
    let target = resolve_target()?;
    let (host, port, is_tls) = parse_ws_host(&target.ws_url)?;

    // Certificate verification is skipped below, which is only sound on the
    // loopback path. A broker-issued URL is always loopback; an env-supplied
    // remote URL is the user's own explicit decision.
    let env_override = std::env::var("COGNIA_ACP_URL").is_ok();
    if !is_loopback_host(&host) && !env_override {
        bail!("refusing non-loopback ACP endpoint {host} (set COGNIA_ACP_URL to override)");
    }

    let stream = TcpStream::connect((host.as_str(), port))
        .with_context(|| format!("connect to cognia ACP endpoint {host}:{port}"))?;
    stream
        .set_read_timeout(Some(READ_POLL_INTERVAL))
        .context("set socket read timeout")?;

    let request = url_with_token(&target.ws_url, &target.token)
        .into_client_request()
        .context("build WS upgrade request")?;

    let connector = if is_tls {
        let tls = native_tls::TlsConnector::builder()
            // Self-signed companion cert on loopback — see module docs.
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .context("build TLS connector")?;
        Connector::NativeTls(tls)
    } else {
        Connector::Plain
    };

    let (socket, _response) =
        tungstenite::client_tls_with_config(request, stream, None, Some(connector))
            .context("WebSocket upgrade to the cognia ACP endpoint failed")?;
    // stdout belongs to the JSON-RPC stream — status goes to stderr only.
    eprintln!("cognia acp: connected to {host}:{port}; bridging stdio");

    pump(socket)
}

/// Drive the two pumps: a reader thread feeds stdin lines into a channel;
/// the main loop alternates between draining that channel into the socket
/// and polling the socket (bounded by the read timeout) for frames to print.
fn pump<S>(mut socket: WebSocket<S>) -> Result<()>
where
    S: std::io::Read + std::io::Write,
{
    let (stdin_tx, stdin_rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) => {
                    if stdin_tx.send(Some(line)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        // EOF — editor closed our stdin; signal shutdown.
        let _ = stdin_tx.send(None);
    });

    let mut stdout = std::io::stdout();
    loop {
        // 1. Drain pending stdin lines → socket.
        loop {
            match stdin_rx.try_recv() {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    socket
                        .send(Message::Text(trimmed.to_string().into()))
                        .context("forward stdin message to cognia")?;
                }
                Ok(None) => {
                    // stdin EOF → close the socket gracefully and stop.
                    let _ = socket.close(None);
                    let _ = socket.flush();
                    return Ok(());
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = socket.close(None);
                    return Ok(());
                }
            }
        }

        // 2. Poll the socket (returns within READ_POLL_INTERVAL on silence).
        match socket.read() {
            Ok(Message::Text(text)) => {
                stdout
                    .write_all(text.as_bytes())
                    .and_then(|_| stdout.write_all(b"\n"))
                    .and_then(|_| stdout.flush())
                    .context("write frame to stdout")?;
            }
            // tungstenite answers pings internally on the next read/write;
            // nothing to do for control frames.
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Binary(_))
            | Ok(Message::Frame(_)) => {}
            Ok(Message::Close(_)) => return Ok(()),
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                // Read-timeout tick — loop back to drain stdin.
            }
            Err(tungstenite::Error::ConnectionClosed)
            | Err(tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(e) => return Err(anyhow!("ACP WebSocket read failed: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;

    // ── URL helpers ─────────────────────────────────────────────────────

    #[test]
    fn url_with_token_appends_query() {
        assert_eq!(
            url_with_token("wss://127.0.0.1:7890/ws/v1/acp", "abc"),
            "wss://127.0.0.1:7890/ws/v1/acp?token=abc"
        );
        assert_eq!(
            url_with_token("wss://127.0.0.1:7890/ws/v1/acp?x=1", "abc"),
            "wss://127.0.0.1:7890/ws/v1/acp?x=1&token=abc"
        );
    }

    #[test]
    fn parse_ws_host_handles_schemes_and_defaults() {
        assert_eq!(
            parse_ws_host("wss://127.0.0.1:7890/ws/v1/acp").unwrap(),
            ("127.0.0.1".to_string(), 7890, true)
        );
        assert_eq!(
            parse_ws_host("ws://localhost:8080").unwrap(),
            ("localhost".to_string(), 8080, false)
        );
        assert_eq!(
            parse_ws_host("wss://example.com/path").unwrap(),
            ("example.com".to_string(), 443, true)
        );
        assert!(parse_ws_host("https://x").is_err());
        assert!(parse_ws_host("wss://:123").is_err());
        assert!(parse_ws_host("wss://h:notaport/x").is_err());
    }

    #[test]
    fn loopback_host_detection() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LOCALHOST"));
        assert!(!is_loopback_host("192.168.1.5"));
        assert!(!is_loopback_host("example.com"));
    }

    // ── Target resolution ───────────────────────────────────────────────
    //
    // Env-var tests mutate process state; each restores what it changes.
    // They run under `cargo test` in one process, so keep the mutations
    // scoped to unique var pairs.

    #[test]
    fn resolve_target_prefers_env_override() {
        std::env::set_var("COGNIA_ACP_URL", "wss://127.0.0.1:1/ws/v1/acp");
        std::env::set_var("COGNIA_ACP_TOKEN", "tok");
        let target = resolve_target().unwrap();
        std::env::remove_var("COGNIA_ACP_URL");
        std::env::remove_var("COGNIA_ACP_TOKEN");
        assert_eq!(
            target,
            ConnectionTarget {
                ws_url: "wss://127.0.0.1:1/ws/v1/acp".into(),
                token: "tok".into(),
            }
        );
    }

    #[test]
    fn resolve_target_rejects_url_without_token() {
        std::env::set_var("COGNIA_ACP_URL", "wss://127.0.0.1:1/ws/v1/acp");
        std::env::remove_var("COGNIA_ACP_TOKEN");
        let err = resolve_target().unwrap_err();
        std::env::remove_var("COGNIA_ACP_URL");
        assert!(err.to_string().contains("COGNIA_ACP_TOKEN"));
    }

    #[test]
    fn resolve_target_uses_broker_via_cli_bridge() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                assert_eq!(req.url(), "/api/v1/dev/acp/token");
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let response = tiny_http::Response::from_string(
                    json!({
                        "ok": true,
                        "wsUrl": "wss://127.0.0.1:7890/ws/v1/acp",
                        "token": "jwt-abc",
                        "tlsFingerprint": "AA",
                    })
                    .to_string(),
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(response);
            }
        });

        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        let payload = json!({
            "baseUrl": format!("http://127.0.0.1:{port}"),
            "devToken": "dev-tok",
        })
        .to_string();
        std::io::Write::write_all(&mut tmp, payload.as_bytes()).unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());
        std::env::remove_var("COGNIA_ACP_URL");
        std::env::remove_var("COGNIA_ACP_TOKEN");

        let target = resolve_target().unwrap();
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        let _ = server_thread.join();

        assert_eq!(target.ws_url, "wss://127.0.0.1:7890/ws/v1/acp");
        assert_eq!(target.token, "jwt-abc");
    }

    #[test]
    fn resolve_target_surfaces_broker_refusal() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let response = tiny_http::Response::from_string(
                    json!({ "ok": false, "error": "companion API server is not running" })
                        .to_string(),
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(response);
            }
        });

        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        let payload = json!({
            "baseUrl": format!("http://127.0.0.1:{port}"),
            "devToken": "dev-tok",
        })
        .to_string();
        std::io::Write::write_all(&mut tmp, payload.as_bytes()).unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());

        let err = resolve_target().unwrap_err();
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        let _ = server_thread.join();
        assert!(
            err.to_string().contains("not running"),
            "got: {err}"
        );
    }

    // ── Pump: exercised over an in-memory duplex stream ─────────────────
    //
    // The pump is generic over `Read + Write`, so a loopback TCP pair with a
    // tungstenite server on the other end gives an end-to-end test without
    // TLS or a real companion server.

    #[test]
    fn pump_forwards_server_frames_to_stdout_until_close() {
        // A plain-TCP tungstenite server that sends two frames then closes.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            ws.send(Message::Text(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into()))
                .unwrap();
            ws.send(Message::Close(None)).unwrap();
            // Drain until the close handshake completes.
            loop {
                match ws.read() {
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
        });

        let stream = TcpStream::connect(addr).unwrap();
        stream.set_read_timeout(Some(READ_POLL_INTERVAL)).unwrap();
        let request = format!("ws://{addr}/").into_client_request().unwrap();
        let (socket, _) =
            tungstenite::client_tls_with_config(request, stream, None, Some(Connector::Plain))
                .unwrap();

        // stdin is the test harness's — the reader thread will block on it
        // and never produce a line, which is fine: the server close ends the
        // pump first.
        pump(socket).unwrap();
        let _ = server_thread.join();
    }
}
