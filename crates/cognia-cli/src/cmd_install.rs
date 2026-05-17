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

use crate::http_client::{load_endpoint, post_json};

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
    let abs = bundle
        .canonicalize()
        .with_context(|| format!("resolve {}", bundle.display()))?;
    if !abs.exists() {
        anyhow::bail!("bundle not found: {}", abs.display());
    }
    let endpoint = load_endpoint()?;
    let body = json!({ "bundle_path": abs.to_string_lossy() });
    let resp: InstallResponse = post_json(&endpoint, PATH, &body)?;
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
    use std::io::{Read, Write};
    use tempfile::NamedTempFile;

    /// End-to-end: CLI sends bundle path, mock server returns ok+pluginId.
    #[test]
    fn install_happy_path_against_mock_bridge() {
        // 1. Mock CLI bridge.
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

        // 2. Endpoint file pointing at the mock.
        let mut ep_file = NamedTempFile::new().unwrap();
        write!(
            ep_file,
            r#"{{"baseUrl": "http://127.0.0.1:{port}", "devToken": "tok"}}"#
        )
        .unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", ep_file.path());

        // 3. Real bundle file on disk (content irrelevant — the mock
        //    server doesn't read it; only the path is forwarded).
        let bundle_file = NamedTempFile::new().unwrap();

        // 4. Run.
        let result = run(bundle_file.path().to_path_buf());
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        let _ = server_thread.join();
        assert!(result.is_ok(), "install should succeed: {result:?}");

        // 5. Confirm payload shape.
        let payload = captured.lock().clone().expect("server captured request");
        let path_str = payload["bundle_path"].as_str().unwrap();
        assert!(
            std::path::Path::new(path_str).exists(),
            "bundle path forwarded as-is to the server"
        );
    }

    #[test]
    fn install_fails_when_bundle_missing() {
        std::env::set_var(
            "COGNIA_CLI_ENDPOINT_FILE",
            "/nowhere/that/should/never/exist.json",
        );
        let err = run(PathBuf::from("/definitely-not-a-real-bundle.zip")).unwrap_err();
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
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

        let mut ep_file = NamedTempFile::new().unwrap();
        write!(
            ep_file,
            r#"{{"baseUrl": "http://127.0.0.1:{port}", "devToken": "tok"}}"#
        )
        .unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", ep_file.path());

        let bundle = NamedTempFile::new().unwrap();
        let err = run(bundle.path().to_path_buf()).unwrap_err();
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        let _ = server_thread.join();
        assert!(
            err.to_string().contains("manifest invalid: missing id"),
            "got: {err}"
        );
    }
}
