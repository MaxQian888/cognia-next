//! `cognia plugin uninstall <plugin-id> [--purge-data]` — remove an
//! installed plugin from a running cognia desktop instance.
//!
//! Talks to the same CLI bridge as `cmd_install` — see `cli_bridge` on
//! the Tauri side.

use anyhow::Result;
use serde::Deserialize;
use serde_json::json;

use crate::http_client::{load_endpoint, post_json, EndpointFile};

const PATH: &str = "/api/v1/dev/plugins/uninstall";

#[derive(Debug, Deserialize)]
struct UninstallResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

pub fn run(plugin_id: String, purge_data: bool) -> Result<()> {
    let endpoint = load_endpoint()?;
    run_with_endpoint(plugin_id, purge_data, &endpoint)
}

/// Endpoint-injected variant; mirrors [`crate::cmd_install::run_with_endpoint`].
pub fn run_with_endpoint(
    plugin_id: String,
    purge_data: bool,
    endpoint: &EndpointFile,
) -> Result<()> {
    if plugin_id.trim().is_empty() {
        anyhow::bail!("plugin_id is empty");
    }
    let body = json!({ "plugin_id": plugin_id, "purge_data": purge_data });
    let resp: UninstallResponse = post_json(endpoint, PATH, &body)?;
    if !resp.ok {
        anyhow::bail!(
            "uninstall rejected by cognia: {}",
            resp.error.unwrap_or_else(|| "<no error message>".into())
        );
    }
    println!(
        "✓ uninstalled {plugin_id}{}",
        if purge_data { " (data purged)" } else { "" }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_happy_path() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<serde_json::Value>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                let parsed: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                *captured_clone.lock() = Some(parsed);
                let resp = tiny_http::Response::from_string(r#"{"ok":true}"#).with_header(
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
        let result = run_with_endpoint("cognia-hello".into(), true, &endpoint);
        let _ = server_thread.join();
        assert!(result.is_ok(), "{result:?}");

        let payload = captured.lock().clone().expect("server captured request");
        assert_eq!(payload["plugin_id"], serde_json::Value::String("cognia-hello".into()));
        assert_eq!(payload["purge_data"], serde_json::Value::Bool(true));
    }

    #[test]
    fn uninstall_rejects_empty_id() {
        let endpoint = EndpointFile {
            base_url: "http://127.0.0.1:1".into(),
            dev_token: "x".into(),
        };
        let err = run_with_endpoint("".into(), false, &endpoint).unwrap_err();
        assert!(err.to_string().contains("plugin_id is empty"));
    }

    #[test]
    fn uninstall_surfaces_server_error() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                let resp = tiny_http::Response::from_string(
                    r#"{"ok":false,"error":"plugin not installed"}"#,
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
        let err = run_with_endpoint("missing".into(), false, &endpoint).unwrap_err();
        let _ = server_thread.join();
        assert!(err.to_string().contains("plugin not installed"));
    }
}
