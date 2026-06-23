//! Integration tests for the diagnostic HTTP endpoints exposed by the
//! signaling rendezvous: `/healthz` (JSON, fly.io / k8s readiness) and
//! `/metrics` (Prometheus text exposition).
//!
//! Both endpoints are intentionally cheap so a probe loop can hammer them
//! without affecting room throughput — these tests boot a real server
//! with `serve_for_test()` and curl the routes with plain `tokio`-friendly
//! `hyper` to verify content shape + headers.

use std::time::Duration;

use cognia_signaling_server::serve_for_test;

#[tokio::test]
async fn healthz_returns_json_with_uptime() {
    let (addr, _handle) = serve_for_test().await.expect("server boots");
    let url = format!("http://{addr}/healthz");
    let body = http_get_body(&url).await;
    // Parse without bringing in serde_json — small, ad-hoc.
    assert!(body.contains("\"ok\":true"), "body was: {body}");
    assert!(body.contains("\"rooms\":0"), "body was: {body}");
    assert!(body.contains("\"peers\":0"), "body was: {body}");
    assert!(body.contains("\"uptimeSeconds\":"), "body was: {body}");
    assert!(body.contains("\"version\":"), "body was: {body}");
}

#[tokio::test]
async fn metrics_returns_prometheus_text_exposition() {
    let (addr, _handle) = serve_for_test().await.expect("server boots");
    let url = format!("http://{addr}/metrics");
    let (body, content_type) = http_get_body_and_header(&url, "content-type").await;
    assert!(
        content_type.starts_with("text/plain"),
        "content-type was: {content_type}"
    );
    // Spot-check a stable subset of lines so this test catches drift in
    // metric naming without being brittle to the exposition order.
    assert!(
        body.contains("# HELP signaling_frames_in_total"),
        "body: {body}"
    );
    assert!(
        body.contains("# TYPE signaling_frames_in_total counter"),
        "body: {body}"
    );
    assert!(body.contains("signaling_frames_in_total 0"), "body: {body}");
    assert!(
        body.contains("signaling_frames_rejected_total{reason=\"replay\"} 0"),
        "body: {body}"
    );
    assert!(body.contains("signaling_rooms_active 0"), "body: {body}");
    assert!(body.contains("signaling_uptime_seconds"), "body: {body}");
}

#[tokio::test]
async fn per_ip_cap_rejects_overflow_websocket_upgrades() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    // Cap=2 so we only need 3 sockets to provoke the limit.
    let (addr, _handle) = cognia_signaling_server::serve_for_test_with(2)
        .await
        .expect("server boots");

    // Open two long-lived raw TCP sockets and request the WS upgrade so
    // the per-IP counter increments. We don't speak the WS frame
    // protocol — just hold the connection so the server's `Acquired`
    // guard stays alive.
    async fn open_ws(addr: std::net::SocketAddr) -> TcpStream {
        let mut s = TcpStream::connect(addr).await.expect("connect");
        let req = format!(
            "GET /v1/signaling HTTP/1.1\r\n\
             Host: {addr}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        s.write_all(req.as_bytes()).await.expect("write upgrade");
        // Read enough of the response to be sure the upgrade landed
        // (server has emitted "HTTP/1.1 101 Switching Protocols").
        let mut buf = [0u8; 256];
        let _n = s.read(&mut buf).await.expect("read upgrade response");
        s
    }

    let _a = open_ws(addr).await;
    let _b = open_ws(addr).await;
    // Third upgrade must be rejected with 429.
    let mut c = TcpStream::connect(addr).await.expect("connect 3");
    let req = format!(
        "GET /v1/signaling HTTP/1.1\r\n\
         Host: {addr}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    c.write_all(req.as_bytes()).await.expect("write");
    let mut response = String::new();
    let mut buf = vec![0u8; 1024];
    loop {
        let n = c.read(&mut buf).await.expect("read");
        if n == 0 {
            break;
        }
        response.push_str(std::str::from_utf8(&buf[..n]).unwrap_or(""));
        if response.contains("\r\n\r\n") {
            break;
        }
    }
    assert!(
        response.starts_with("HTTP/1.1 429"),
        "expected 429 Too Many Requests, got:\n{response}"
    );
}

#[tokio::test]
async fn healthz_is_fast_under_a_short_timeout() {
    let (addr, _handle) = serve_for_test().await.expect("server boots");
    let url = format!("http://{addr}/healthz");
    // The healthz endpoint must finish well within an aggressive timeout
    // to be usable as a fly.io/k8s readiness probe.
    let res = tokio::time::timeout(Duration::from_millis(500), http_get_body(&url)).await;
    assert!(res.is_ok(), "healthz did not respond within 500 ms");
}

// ---------------------------------------------------------------------------
// Tiny HTTP helpers — local to this test crate so we don't pull in a real
// HTTP client dependency just for two endpoints.
// ---------------------------------------------------------------------------

async fn http_get_body(url: &str) -> String {
    http_get_body_and_header(url, "content-length").await.0
}

async fn http_get_body_and_header(url: &str, header_name: &str) -> (String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    // Parse the URL minimally — only `http://host:port/path` is expected here.
    let stripped = url.strip_prefix("http://").expect("http:// prefix");
    let (host_port, path) = match stripped.find('/') {
        Some(i) => (&stripped[..i], &stripped[i..]),
        None => (stripped, "/"),
    };

    let mut stream = TcpStream::connect(host_port)
        .await
        .expect("connect to local server");
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .expect("write request");

    let mut buf = Vec::with_capacity(2048);
    stream.read_to_end(&mut buf).await.expect("read response");

    let response = String::from_utf8_lossy(&buf).into_owned();
    let mut parts = response.splitn(2, "\r\n\r\n");
    let headers = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("");

    // Tolerate `Transfer-Encoding: chunked` by stripping hex-prefix chunks.
    // axum on `Connection: close` should return content-length, but we
    // fall back defensively.
    let body = if headers
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        strip_chunked(body)
    } else {
        body.to_string()
    };

    let header_value = headers
        .lines()
        .find_map(|line| {
            let mut split = line.splitn(2, ':');
            let name = split.next()?.trim().to_ascii_lowercase();
            let value = split.next()?.trim().to_string();
            if name == header_name.to_ascii_lowercase() {
                Some(value)
            } else {
                None
            }
        })
        .unwrap_or_default();

    (body, header_value)
}

fn strip_chunked(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut remaining = body;
    while let Some(crlf) = remaining.find("\r\n") {
        let (size_line, _rest) = remaining.split_at(crlf);
        let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let chunk_start = crlf + 2;
        let chunk_end = chunk_start + size;
        if chunk_end > remaining.len() {
            break;
        }
        out.push_str(&remaining[chunk_start..chunk_end]);
        // Skip the trailing CRLF after the chunk.
        let next = chunk_end + 2;
        if next >= remaining.len() {
            break;
        }
        remaining = &remaining[next..];
    }
    out
}
