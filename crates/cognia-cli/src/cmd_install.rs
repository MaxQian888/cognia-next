//! `cognia plugin install <bundle.zip>` — install a bundle into a
//! running cognia desktop instance.
//!
//! Talks to the desktop's CLI bridge (see `src-tauri/src/cli_bridge/`).
//! The CLI bridge is a loopback-only plain-HTTP listener that gates
//! every request on a per-launch dev token.
//!
//! The bundle path is sent as-is — the desktop reads the file directly
//! from disk rather than streaming bytes over HTTP. This keeps the
//! protocol cheap and avoids a large multipart upload for what is by
//! definition a local operation.

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;

use crate::http_client::{load_endpoint, post_json, EndpointFile};

const PATH: &str = "/api/v1/dev/plugins/install";

#[derive(Debug, Deserialize)]
struct InstallResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default, rename = "pluginId")]
    plugin_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    warnings: Vec<String>,
}

pub fn run(bundle: PathBuf) -> Result<()> {
    let endpoint = load_endpoint()?;
    run_with_endpoint(bundle, &endpoint)
}

/// Endpoint-injected variant. Used by tests so they don't race on the
/// global `COGNIA_CLI_ENDPOINT_FILE` env var, and by future callers that
/// already hold a resolved endpoint.
pub fn run_with_endpoint(bundle: PathBuf, endpoint: &EndpointFile) -> Result<()> {
    let abs = bundle
        .canonicalize()
        .with_context(|| format!("resolve {}", bundle.display()))?;
    if !abs.exists() {
        anyhow::bail!("bundle not found: {}", abs.display());
    }
    let body = json!({ "bundle_path": abs.to_string_lossy() });
    let resp: InstallResponse = post_json(endpoint, PATH, &body)?;
    if !resp.ok {
        anyhow::bail!(
            "install rejected by cognia: {}",
            resp.error.unwrap_or_else(|| "<no error message>".into())
        );
    }
    let id = resp.plugin_id.as_deref().unwrap_or("<unknown id>");
    println!("✓ installed {id} from {}", abs.display());
    for warn in &resp.warnings {
        println!("  warning: {warn}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // `Read` is needed at the trait level for `req.as_reader().read_to_string()`;
    // rustc's unused-import lint doesn't see through tiny_http's reader type.
    #[allow(unused_imports)]
    use std::io::Read as _;
    use tempfile::NamedTempFile;

    /// End-to-end: CLI sends bundle path, mock server returns ok+pluginId.
    /// Uses `run_with_endpoint` so the test doesn't race on the global
    /// `COGNIA_CLI_ENDPOINT_FILE` env var with the http_client tests.
    #[test]
    fn install_happy_path_against_mock_bridge() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<serde_json::Value>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let parsed: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                *captured_clone.lock() = Some(parsed);
                let resp = tiny_http::Response::from_string(
                    r#"{"ok":true,"pluginId":"cognia-hello"}"#,
                )
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
                let _ = req.respond(resp);
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let bundle_file = NamedTempFile::new().unwrap();
        let result = run_with_endpoint(bundle_file.path().to_path_buf(), &endpoint);
        let _ = server_thread.join();
        assert!(result.is_ok(), "install should succeed: {result:?}");

        let payload = captured.lock().clone().expect("server captured request");
        let path_str = payload["bundle_path"].as_str().unwrap();
        assert!(
            std::path::Path::new(path_str).exists(),
            "bundle path forwarded as-is to the server"
        );
    }

    #[test]
    fn install_fails_when_bundle_missing() {
        let endpoint = EndpointFile {
            base_url: "http://127.0.0.1:1".into(), // unreachable; we expect failure before contact
            dev_token: "x".into(),
        };
        let err =
            run_with_endpoint(PathBuf::from("/definitely-not-a-real-bundle.zip"), &endpoint)
                .unwrap_err();
        // The path doesn't exist, so canonicalize fails first.
        assert!(
            err.to_string().contains("resolve") || err.to_string().contains("not found"),
            "got: {err}"
        );
    }

    #[test]
    fn install_surfaces_server_error_field() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let resp = tiny_http::Response::from_string(
                    r#"{"ok":false,"error":"manifest invalid: missing id"}"#,
                )
                .with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
                let _ = req.respond(resp);
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let bundle = NamedTempFile::new().unwrap();
        let err =
            run_with_endpoint(bundle.path().to_path_buf(), &endpoint).unwrap_err();
        let _ = server_thread.join();
        assert!(
            err.to_string().contains("manifest invalid: missing id"),
            "got: {err}"
        );
    }
}
