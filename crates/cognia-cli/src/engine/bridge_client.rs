//! HTTP client for talking to a running cognia desktop's CLI bridge.
//!
//! Used by `cognia plugin install`, `cognia plugin uninstall`, and
//! `cognia plugin dev --reload-url`. The CLI is sync and small — we use
//! `ureq` rather than `reqwest` to avoid pulling tokio in.
//!
//! # Discovery
//!
//! The cognia desktop writes its CLI-bridge base URL + dev token to
//! `<config_dir>/cognia/cli-endpoint.json` at server startup. The CLI
//! reads this file to find a running instance:
//!
//! ```json
//! { "baseUrl": "http://127.0.0.1:7891", "devToken": "<hex>" }
//! ```
//!
//! # Auth
//!
//! Every request carries the dev token in the `X-Cognia-Dev-Token`
//! header. The server-side handler also enforces that the request
//! originates from `127.0.0.1`; together these gate access without
//! exposing the bridge beyond the developer's own machine.
//!
//! # Why plain HTTP?
//!
//! The CLI bridge listens on loopback only. TLS would force every CLI
//! invocation to wrestle with self-signed cert verification for no
//! security gain — the network path is the kernel's loopback driver.
//! The HTTPS-secured companion-API stays untouched for the mobile
//! pairing flow.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const ENDPOINT_FILE_NAME: &str = "cli-endpoint.json";

/// Persisted by the cognia desktop at startup so the CLI can find it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointFile {
    /// Base URL including scheme, host, port. e.g. `http://127.0.0.1:7891`.
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    /// Hex-encoded random token. Owner-only file permission on the
    /// desktop side; the CLI inherits the same access by virtue of
    /// reading from the user's own config directory.
    #[serde(rename = "devToken")]
    pub dev_token: String,
}

/// Compute the canonical endpoint-file path: `<config_dir>/cognia/cli-endpoint.json`.
///
/// Honors `COGNIA_CLI_ENDPOINT_FILE` if set so tests can point at a
/// tempfile without touching the real config dir.
pub fn endpoint_file_path() -> Result<PathBuf> {
    if let Ok(override_path) = std::env::var("COGNIA_CLI_ENDPOINT_FILE") {
        return Ok(PathBuf::from(override_path));
    }
    let dirs = directories::BaseDirs::new()
        .ok_or_else(|| anyhow!("could not determine user home directory"))?;
    Ok(dirs.config_dir().join("cognia").join(ENDPOINT_FILE_NAME))
}

/// Load the endpoint file. Errors with an actionable message if the file
/// is missing — meaning no cognia is running, or the user hasn't enabled
/// the CLI bridge in Settings yet.
pub fn load_endpoint() -> Result<EndpointFile> {
    let path = endpoint_file_path()?;
    if !path.exists() {
        bail!(
            "no running cognia detected: expected {} to exist.\n\
             Start the cognia desktop app (it writes this file on launch),\n\
             or enable the CLI bridge in Settings → Plugins → Developer.",
            path.display()
        );
    }
    let bytes = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let endpoint: EndpointFile = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {} as JSON", path.display()))?;
    if endpoint.base_url.is_empty() || endpoint.dev_token.is_empty() {
        bail!(
            "{} is present but missing baseUrl / devToken — re-launch cognia to refresh.",
            path.display()
        );
    }
    Ok(endpoint)
}

/// GET JSON from `<base_url><path>` with the dev token header. Returns
/// the parsed JSON response (or an error if status != 2xx).
///
/// Used by `cognia plugin install` to preflight a same-id collision via
/// `GET /api/dev/plugins/installed`.
pub fn get_json<R: for<'de> Deserialize<'de>>(endpoint: &EndpointFile, path: &str) -> Result<R> {
    let url = format!("{}{}", endpoint.base_url.trim_end_matches('/'), path);
    let agent = ureq::Agent::new();
    let response = agent
        .get(&url)
        .set("X-Cognia-Dev-Token", &endpoint.dev_token)
        .call();
    match response {
        Ok(resp) => {
            let parsed: R = resp.into_json().context("decode response JSON body")?;
            Ok(parsed)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(anyhow!(
                "GET {} → HTTP {}\nresponse: {}",
                url,
                code,
                body.lines().take(20).collect::<Vec<_>>().join("\n")
            ))
        }
        // A non-Status error is a transport failure (connection refused,
        // DNS, timeout). For our loopback bridge the overwhelmingly common
        // cause is a *stale* endpoint file left behind by a cognia that has
        // since exited — translate it into the same actionable guidance the
        // missing-file path gives instead of a raw OS error string.
        Err(other) => Err(unreachable_bridge_error(&endpoint.base_url, other)),
    }
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    ok: bool,
}

/// Probe the bridge liveness endpoint. This is intentionally stricter than
/// "HTTP 200 means reachable": the bridge contract is `{"ok": true}`.
pub fn probe_health(endpoint: &EndpointFile) -> Result<()> {
    let response: HealthResponse = get_json(endpoint, "/api/dev/health")?;
    if !response.ok {
        bail!("health probe returned ok=false");
    }
    Ok(())
}

/// Build the actionable error shown when the bridge URL is unreachable.
/// Distinct from the missing-file case (`load_endpoint`): here the endpoint
/// file exists but nothing is listening — almost always a stale file from a
/// previous launch.
fn unreachable_bridge_error(base_url: &str, err: ureq::Error) -> anyhow::Error {
    let stale_hint = match endpoint_file_path() {
        Ok(p) => format!(
            "\nThe endpoint file {} may be stale (left over from a previous run).",
            p.display()
        ),
        Err(_) => String::new(),
    };
    anyhow!(
        "could not reach the cognia CLI bridge at {base_url} — is the desktop app running?{stale_hint}\n\
         Start the cognia desktop app (or enable the CLI bridge in Settings → Plugins → Developer) and retry.\n\
         (transport error: {err})"
    )
}

/// POST JSON to `<base_url><path>` with the dev token header. Returns
/// the parsed JSON response (or an error if status != 2xx).
pub fn post_json<R: for<'de> Deserialize<'de>>(
    endpoint: &EndpointFile,
    path: &str,
    body: &serde_json::Value,
) -> Result<R> {
    let url = format!("{}{}", endpoint.base_url.trim_end_matches('/'), path);
    let agent = ureq::Agent::new();
    let response = agent
        .post(&url)
        .set("X-Cognia-Dev-Token", &endpoint.dev_token)
        .set("Content-Type", "application/json")
        .send_json(body.clone());
    match response {
        Ok(resp) => {
            let parsed: R = resp.into_json().context("decode response JSON body")?;
            Ok(parsed)
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(anyhow!(
                "POST {} → HTTP {}\nresponse: {}",
                url,
                code,
                body.lines().take(20).collect::<Vec<_>>().join("\n")
            ))
        }
        Err(other) => Err(unreachable_bridge_error(&endpoint.base_url, other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    // `Read` is needed at the trait level for `req.as_reader().read_to_string()`;
    // rustc's unused-import lint doesn't see through tiny_http's reader type.
    #[allow(unused_imports)]
    use std::io::{Read, Write};
    use tempfile::NamedTempFile;

    #[test]
    fn endpoint_file_path_honors_env_override() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        let tmp = NamedTempFile::new().unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());
        let path = endpoint_file_path().unwrap();
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        assert_eq!(path, tmp.path());
    }

    #[test]
    fn load_endpoint_reads_valid_file() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        let mut tmp = NamedTempFile::new().unwrap();
        let payload =
            json!({ "baseUrl": "http://127.0.0.1:1234", "devToken": "deadbeef" }).to_string();
        write!(tmp, "{payload}").unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());
        let ep = load_endpoint().unwrap();
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        assert_eq!(ep.base_url, "http://127.0.0.1:1234");
        assert_eq!(ep.dev_token, "deadbeef");
    }

    #[test]
    fn load_endpoint_errors_on_missing_file() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        std::env::set_var(
            "COGNIA_CLI_ENDPOINT_FILE",
            "/definitely/does/not/exist.json",
        );
        let err = load_endpoint().unwrap_err();
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        let msg = err.to_string();
        assert!(msg.contains("no running cognia detected"), "got: {msg}");
    }

    #[test]
    fn load_endpoint_rejects_empty_fields() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        let mut tmp = NamedTempFile::new().unwrap();
        write!(tmp, r#"{{"baseUrl": "", "devToken": ""}}"#).unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());
        let err = load_endpoint().unwrap_err();
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        assert!(err.to_string().contains("missing baseUrl / devToken"));
    }

    /// End-to-end smoke against a `tiny_http` mock: confirms header is sent
    /// and JSON body is round-tripped. The real handler in
    /// `src-tauri/src/cli_bridge/` is tested separately.
    #[test]
    fn post_json_sends_token_header_and_parses_response() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<String>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let token = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("X-Cognia-Dev-Token"))
                    .map(|h| h.value.as_str().to_string());
                *captured_clone.lock() = token;
                let response =
                    tiny_http::Response::from_string(r#"{"ok":true,"pluginId":"hello"}"#)
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"application/json"[..],
                            )
                            .unwrap(),
                        );
                let _ = req.respond(response);
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "the-token".into(),
        };
        let resp: serde_json::Value = post_json(
            &endpoint,
            "/api/dev/plugins/install",
            &json!({"bundle_path": "x"}),
        )
        .unwrap();
        assert_eq!(resp["ok"], serde_json::Value::Bool(true));
        assert_eq!(resp["pluginId"], serde_json::Value::String("hello".into()));
        let _ = server_thread.join();
        let header = captured.lock().clone();
        assert_eq!(header.as_deref(), Some("the-token"));
    }

    #[test]
    fn probe_health_sends_token_header_and_requires_ok() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<String>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                assert_eq!(req.method(), &tiny_http::Method::Get);
                assert_eq!(req.url(), "/api/dev/health");
                let token = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("X-Cognia-Dev-Token"))
                    .map(|h| h.value.as_str().to_string());
                *captured_clone.lock() = token;
                let response = tiny_http::Response::from_string(r#"{"ok":true}"#).with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(response);
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "the-token".into(),
        };
        probe_health(&endpoint).unwrap();
        let _ = server_thread.join();
        let header = captured.lock().clone();
        assert_eq!(header.as_deref(), Some("the-token"));
    }

    /// A connection-refused (transport) failure must surface the actionable
    /// "is the desktop app running? / endpoint file may be stale" guidance,
    /// not a raw OS error. Binds a port, drops the listener, then POSTs to it
    /// so the connection is refused deterministically.
    #[test]
    fn post_json_translates_unreachable_bridge_to_actionable_hint() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        drop(server); // free the port → connections now refused
        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let err = post_json::<serde_json::Value>(
            &endpoint,
            "/api/dev/plugins/install",
            &json!({"bundle_path": "x"}),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("is the desktop app running?"),
            "expected actionable hint, got: {msg}"
        );
        assert!(
            msg.contains("Start the cognia desktop app"),
            "expected start hint, got: {msg}"
        );
    }

    #[test]
    fn post_json_surfaces_server_error_body() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let response = tiny_http::Response::from_string("plugin missing manifest.json")
                    .with_status_code(422);
                let _ = req.respond(response);
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let err = post_json::<serde_json::Value>(
            &endpoint,
            "/api/dev/plugins/install",
            &json!({"bundle_path": "x"}),
        )
        .unwrap_err();
        let _ = server_thread.join();
        let msg = err.to_string();
        assert!(msg.contains("HTTP 422"), "got: {msg}");
        assert!(msg.contains("plugin missing manifest.json"), "got: {msg}");
    }
}
