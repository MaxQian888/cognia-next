// Health-check / tool-discovery probe for MCP servers. Spawns the configured
// server (stdio) or opens a streamable-HTTP / SSE connection (sse, http),
// walks the JSON-RPC handshake (`initialize` → `notifications/initialized`
// → `tools/list`), captures the tool list, and tears the process / stream
// down. Used by the settings UI's "Test" button so users find out *now*
// that their command or endpoint is wrong, instead of mid-conversation.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

const HANDSHAKE_TIMEOUT_SECS: u64 = 10;
const PROTOCOL_VERSION: &str = "2024-11-05";

/// Total probe attempts for the settings "Test" button. A cold server (npx
/// still downloading its package, a remote endpoint waking from idle) routinely
/// fails its FIRST handshake; one automatic retry turns that into a pass
/// instead of a false "broken config" toast.
const PROBE_ATTEMPTS: u32 = 2;
const PROBE_RETRY_DELAY_MS: u64 = 500;

/// Run `probe` up to `attempts` times, sleeping `delay_ms` before each retry.
/// Returns the first `Ok`, or the LAST error once the budget is spent.
async fn retry_probe<F, Fut>(
    attempts: u32,
    delay_ms: u64,
    mut probe: F,
) -> Result<Vec<McpToolInfo>, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<McpToolInfo>, String>>,
{
    let mut last_err = String::from("no probe attempts");
    for attempt in 0..attempts.max(1) {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
        match probe().await {
            Ok(tools) => return Ok(tools),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpTestResult {
    pub ok: bool,
    pub tool_count: usize,
    pub tools: Vec<McpToolInfo>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
}

/// Probe an MCP server. The transport string mirrors what's stored in the DB:
/// `stdio`, `sse`, or `http`. For stdio the caller passes `command` + `args`
/// (and optionally `env`); for sse/http, `url` (+ `headers`).
#[tauri::command]
pub async fn test_mcp_server(
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
) -> Result<McpTestResult, String> {
    let start = std::time::Instant::now();
    // Config errors (missing command/url, unknown transport) keep rejecting the
    // invoke immediately — only the runtime handshake is retried.
    let result = match transport.as_str() {
        "stdio" => {
            let cmd = command.ok_or_else(|| "stdio transport requires `command`".to_string())?;
            let args = args.unwrap_or_default();
            let env = env.unwrap_or_default();
            retry_probe(PROBE_ATTEMPTS, PROBE_RETRY_DELAY_MS, || {
                test_stdio(&cmd, args.clone(), env.clone())
            })
            .await
        }
        "http" => {
            let endpoint = url.ok_or_else(|| "http transport requires `url`".to_string())?;
            let headers = headers.unwrap_or_default();
            retry_probe(PROBE_ATTEMPTS, PROBE_RETRY_DELAY_MS, || {
                test_streamable_http(&endpoint, headers.clone())
            })
            .await
        }
        "sse" => {
            let endpoint = url.ok_or_else(|| "sse transport requires `url`".to_string())?;
            let headers = headers.unwrap_or_default();
            retry_probe(PROBE_ATTEMPTS, PROBE_RETRY_DELAY_MS, || {
                test_sse(&endpoint, headers.clone())
            })
            .await
        }
        other => Err(format!("unknown transport: {}", other)),
    };
    let duration_ms = start.elapsed().as_millis() as u64;
    Ok(match result {
        Ok(tools) => McpTestResult {
            ok: true,
            tool_count: tools.len(),
            tools,
            error: None,
            duration_ms,
        },
        Err(e) => McpTestResult {
            ok: false,
            tool_count: 0,
            tools: vec![],
            error: Some(e),
            duration_ms,
        },
    })
}

async fn test_stdio(
    command: &str,
    args: Vec<String>,
    env: HashMap<String, String>,
) -> Result<Vec<McpToolInfo>, String> {
    let mut cmd = Command::new(command);
    cmd.args(&args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Inherit the user's PATH/HOME so installed tools resolve correctly. The
    // call site passes overrides via `env`.

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {}: {}", command, e))?;
    let stdin = child.stdin.take().ok_or("no stdin pipe".to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout pipe".to_string())?;

    let handshake = async move {
        let mut writer = stdin;
        let mut reader = BufReader::new(stdout);

        write_jsonrpc(
            &mut writer,
            &serde_json::json!({
              "jsonrpc": "2.0",
              "id": 1,
              "method": "initialize",
              "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "cognia", "version": "0.1"}
              }
            }),
        )
        .await?;
        let init_resp = read_jsonrpc_response(&mut reader, 1).await?;
        if let Some(err) = init_resp.get("error") {
            return Err(format!("server error during initialize: {}", err));
        }

        write_jsonrpc(
            &mut writer,
            &serde_json::json!({
              "jsonrpc": "2.0",
              "method": "notifications/initialized"
            }),
        )
        .await?;

        write_jsonrpc(
            &mut writer,
            &serde_json::json!({
              "jsonrpc": "2.0",
              "id": 2,
              "method": "tools/list"
            }),
        )
        .await?;
        let list_resp = read_jsonrpc_response(&mut reader, 2).await?;
        if let Some(err) = list_resp.get("error") {
            return Err(format!("server error during tools/list: {}", err));
        }

        let tools = list_resp
            .pointer("/result/tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|t| McpToolInfo {
                        name: t
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string(),
                        description: t
                            .get("description")
                            .and_then(|d| d.as_str())
                            .map(|s| s.to_string()),
                    })
                    .filter(|t| !t.name.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok::<Vec<McpToolInfo>, String>(tools)
    };

    let outcome = match timeout(Duration::from_secs(HANDSHAKE_TIMEOUT_SECS), handshake).await {
        Ok(Ok(tools)) => Ok(tools),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!(
            "no response within {}s — check the command starts cleanly",
            HANDSHAKE_TIMEOUT_SECS
        )),
    };

    // Always tear down. Errors here are best-effort.
    let _ = child.kill().await;
    let _ = child.wait().await;

    outcome
}

async fn write_jsonrpc<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    msg: &serde_json::Value,
) -> Result<(), String> {
    let mut line = msg.to_string();
    line.push('\n');
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write {}: {}", msg["method"], e))?;
    writer.flush().await.map_err(|e| format!("flush: {}", e))?;
    Ok(())
}

/// Read newline-delimited JSON from `reader` until we get a JSON-RPC response
/// with `id == expected_id`. Skips notifications and unrelated responses.
async fn read_jsonrpc_response<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    expected_id: u64,
) -> Result<serde_json::Value, String> {
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = reader
            .read_line(&mut buf)
            .await
            .map_err(|e| format!("read line: {}", e))?;
        if n == 0 {
            return Err("server closed stream without responding".into());
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // server may print non-JSON banners on startup
        };
        if value.get("id").and_then(|x| x.as_u64()) == Some(expected_id) {
            return Ok(value);
        }
        // Otherwise it's a notification or other id — keep reading.
    }
}

// ---- Streamable HTTP probe ------------------------------------------------

/// Walk the streamable-HTTP MCP handshake (initialize → tools/list). The
/// server may answer either with `Content-Type: application/json` (single
/// response) or `Content-Type: text/event-stream` (response wrapped in a
/// single SSE `message` event); we handle both.
///
/// Servers that issue an `mcp-session-id` response header on `initialize`
/// require us to echo it back on subsequent requests — we do.
async fn test_streamable_http(
    url: &str,
    headers: HashMap<String, String>,
) -> Result<Vec<McpToolInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HANDSHAKE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("build http client: {}", e))?;

    let work = async {
        let init = serde_json::json!({
          "jsonrpc": "2.0",
          "id": 1,
          "method": "initialize",
          "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "cognia", "version": "0.1" }
          }
        });
        let resp = http_post_jsonrpc(&client, url, &headers, None, &init).await?;
        let session_id = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let init_resp = read_http_jsonrpc(resp, 1).await?;
        if let Some(err) = init_resp.get("error") {
            return Err(format!("server error during initialize: {}", err));
        }

        let notif = serde_json::json!({
          "jsonrpc": "2.0",
          "method": "notifications/initialized"
        });
        // Notifications get no response; we don't read the body.
        let _ = http_post_jsonrpc(&client, url, &headers, session_id.as_deref(), &notif).await?;

        let list = serde_json::json!({
          "jsonrpc": "2.0",
          "id": 2,
          "method": "tools/list"
        });
        let resp = http_post_jsonrpc(&client, url, &headers, session_id.as_deref(), &list).await?;
        let list_resp = read_http_jsonrpc(resp, 2).await?;
        if let Some(err) = list_resp.get("error") {
            return Err(format!("server error during tools/list: {}", err));
        }
        Ok(extract_tools(&list_resp))
    };

    match timeout(Duration::from_secs(HANDSHAKE_TIMEOUT_SECS), work).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "no response within {}s — check the endpoint URL",
            HANDSHAKE_TIMEOUT_SECS
        )),
    }
}

async fn http_post_jsonrpc(
    client: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    session_id: Option<&str>,
    body: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    if let Some(sid) = session_id {
        req = req.header("mcp-session-id", sid);
    }
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .json(body)
        .send()
        .await
        .map_err(|e| format!("http send: {}", e))?;
    if !resp.status().is_success() && resp.status().as_u16() != 202 {
        let status = resp.status();
        let snippet = resp.text().await.unwrap_or_default();
        return Err(format!(
            "http {}: {}",
            status,
            snippet.chars().take(200).collect::<String>()
        ));
    }
    Ok(resp)
}

/// Read a single JSON-RPC response with `id == expected_id` from a streamable
/// HTTP response — either as `application/json` or wrapped in an SSE event.
async fn read_http_jsonrpc(
    resp: reqwest::Response,
    expected_id: u64,
) -> Result<serde_json::Value, String> {
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    if content_type.contains("text/event-stream") {
        // SSE-wrapped response. Stream events until we find the matching id.
        let mut buf = String::new();
        let mut bytes = resp.bytes_stream();
        while let Some(chunk) = bytes.next().await {
            let chunk = chunk.map_err(|e| format!("read sse chunk: {}", e))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = find_event_boundary(&buf) {
                let block = buf[..pos].to_string();
                buf.drain(..pos + 2 /* the boundary itself */);
                if let Some(value) = parse_sse_event_data(&block) {
                    if value.get("id").and_then(|x| x.as_u64()) == Some(expected_id) {
                        return Ok(value);
                    }
                }
            }
        }
        Err("sse stream ended without a matching response".into())
    } else {
        // Plain JSON body.
        let value: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("parse json body: {}", e))?;
        if value.get("id").and_then(|x| x.as_u64()) == Some(expected_id) {
            Ok(value)
        } else {
            Err(format!(
                "expected id {}, got {:?}",
                expected_id,
                value.get("id")
            ))
        }
    }
}

// ---- SSE (legacy) probe ---------------------------------------------------

/// Probe an MCP server over the legacy SSE transport. The server first
/// announces its messages POST endpoint via an `endpoint` event on the SSE
/// stream; we then POST initialize / tools/list to that endpoint and read
/// the responses back from the original SSE connection.
async fn test_sse(url: &str, headers: HashMap<String, String>) -> Result<Vec<McpToolInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HANDSHAKE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("build http client: {}", e))?;

    let work = async {
        let mut req = client.get(url).header("Accept", "text/event-stream");
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        let resp = req.send().await.map_err(|e| format!("sse get: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("sse get http {}", resp.status()));
        }
        let mut buf = String::new();
        let mut bytes = resp.bytes_stream();

        // Read events until we get `endpoint`, then start the JSON-RPC dance.
        let messages_url = loop {
            let chunk = match bytes.next().await {
                Some(r) => r.map_err(|e| format!("read sse chunk: {}", e))?,
                None => return Err("sse stream closed before endpoint event".into()),
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            let mut found: Option<String> = None;
            while let Some(pos) = find_event_boundary(&buf) {
                let block = buf[..pos].to_string();
                buf.drain(..pos + 2);
                let mut event_name = "message".to_string();
                let mut data = String::new();
                for line in block.lines() {
                    if let Some(rest) = line.strip_prefix("event:") {
                        event_name = rest.trim().to_string();
                    } else if let Some(rest) = line.strip_prefix("data:") {
                        if !data.is_empty() {
                            data.push('\n');
                        }
                        data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
                    }
                }
                if event_name == "endpoint" {
                    found = Some(data);
                    break;
                }
            }
            if let Some(p) = found {
                break absolute_url(url, &p)?;
            }
        };

        let init = serde_json::json!({
          "jsonrpc": "2.0",
          "id": 1,
          "method": "initialize",
          "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "cognia", "version": "0.1" }
          }
        });
        sse_post(&client, &messages_url, &headers, &init).await?;
        let init_resp = read_next_response(&mut buf, &mut bytes, 1).await?;
        if let Some(err) = init_resp.get("error") {
            return Err(format!("server error during initialize: {}", err));
        }

        let notif = serde_json::json!({
          "jsonrpc": "2.0",
          "method": "notifications/initialized"
        });
        sse_post(&client, &messages_url, &headers, &notif).await?;

        let list = serde_json::json!({
          "jsonrpc": "2.0",
          "id": 2,
          "method": "tools/list"
        });
        sse_post(&client, &messages_url, &headers, &list).await?;
        let list_resp = read_next_response(&mut buf, &mut bytes, 2).await?;
        if let Some(err) = list_resp.get("error") {
            return Err(format!("server error during tools/list: {}", err));
        }
        Ok(extract_tools(&list_resp))
    };

    match timeout(Duration::from_secs(HANDSHAKE_TIMEOUT_SECS), work).await {
        Ok(r) => r,
        Err(_) => Err(format!(
            "no response within {}s — check the SSE endpoint",
            HANDSHAKE_TIMEOUT_SECS
        )),
    }
}

async fn sse_post(
    client: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    body: &serde_json::Value,
) -> Result<(), String> {
    let mut req = client.post(url).header("Content-Type", "application/json");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let resp = req
        .json(body)
        .send()
        .await
        .map_err(|e| format!("sse post: {}", e))?;
    if !resp.status().is_success() && resp.status().as_u16() != 202 {
        return Err(format!("sse post http {}", resp.status()));
    }
    Ok(())
}

async fn read_next_response<S>(
    buf: &mut String,
    stream: &mut S,
    expected_id: u64,
) -> Result<serde_json::Value, String>
where
    S: StreamExt<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
{
    loop {
        while let Some(pos) = find_event_boundary(buf) {
            let block = buf[..pos].to_string();
            buf.drain(..pos + 2);
            if let Some(value) = parse_sse_event_data(&block) {
                if value.get("id").and_then(|x| x.as_u64()) == Some(expected_id) {
                    return Ok(value);
                }
            }
        }
        let chunk = match stream.next().await {
            Some(r) => r.map_err(|e| format!("read sse chunk: {}", e))?,
            None => return Err("sse stream ended unexpectedly".into()),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
    }
}

// ---- Shared helpers -------------------------------------------------------

fn extract_tools(resp: &serde_json::Value) -> Vec<McpToolInfo> {
    resp.pointer("/result/tools")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| McpToolInfo {
                    name: t
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string(),
                    description: t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .map(|s| s.to_string()),
                })
                .filter(|t| !t.name.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// Find the first `\n\n` (or `\r\n\r\n`) in `buf`, returning the byte index
/// of the first newline of the boundary. The caller drains `pos + 2` to
/// skip past `\n\n`. Mixed CRLF chunks aren't tolerated — most servers we
/// care about use `\n\n` after each event.
fn find_event_boundary(buf: &str) -> Option<usize> {
    buf.find("\n\n")
}

fn parse_sse_event_data(block: &str) -> Option<serde_json::Value> {
    let mut data = String::new();
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data).ok()
}

fn absolute_url(base: &str, target: &str) -> Result<String, String> {
    if target.starts_with("http://") || target.starts_with("https://") {
        return Ok(target.to_string());
    }
    // Relative — resolve against the SSE GET URL by stripping the path and
    // joining. We use a simple approach since reqwest doesn't expose Url
    // directly here.
    let parsed = reqwest::Url::parse(base).map_err(|e| format!("parse base url: {}", e))?;
    let joined = parsed
        .join(target)
        .map_err(|e| format!("join url: {}", e))?;
    Ok(joined.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn retry_probe_returns_first_ok_without_retrying() {
        let calls = AtomicU32::new(0);
        let res = retry_probe(2, 0, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(vec![]) }
        })
        .await;
        assert!(res.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_probe_recovers_after_a_cold_first_attempt() {
        let calls = AtomicU32::new(0);
        let res = retry_probe(2, 0, || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 0 {
                    Err("cold start".to_string())
                } else {
                    Ok(vec![McpToolInfo {
                        name: "t".into(),
                        description: None,
                    }])
                }
            }
        })
        .await;
        assert_eq!(res.unwrap().len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retry_probe_surfaces_the_last_error_when_exhausted() {
        let calls = AtomicU32::new(0);
        let res = retry_probe(2, 0, || {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move { Err(format!("attempt {}", n)) }
        })
        .await;
        assert_eq!(res.unwrap_err(), "attempt 1");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retry_probe_clamps_zero_attempts_to_one() {
        let calls = AtomicU32::new(0);
        let res = retry_probe(0, 0, || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err("down".to_string()) }
        })
        .await;
        assert!(res.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
