//! `cognia plugin reload` - ask the running desktop bridge to hot-reload a plugin.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::path::{Path, PathBuf};

use crate::http_client::{load_endpoint, post_json, EndpointFile};
use crate::ui::{style, RuntimeUi};

const RELOAD_PATH: &str = "/api/v1/dev/plugins/reload";

#[derive(Debug, Deserialize)]
struct ReloadResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default, rename = "pluginId")]
    plugin_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    warnings: Vec<String>,
}

pub fn run(bundle: Option<PathBuf>, plugin_id: Option<String>, ui: &mut RuntimeUi) -> Result<()> {
    let endpoint = load_endpoint()?;
    run_with_endpoint(bundle, plugin_id, &endpoint, ui)
}

pub fn run_with_endpoint(
    bundle: Option<PathBuf>,
    plugin_id: Option<String>,
    endpoint: &EndpointFile,
    _ui: &mut RuntimeUi,
) -> Result<()> {
    let plugin_id = plugin_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if bundle.is_none() && plugin_id.is_none() {
        bail!("plugin reload requires --plugin-id, --bundle, or --path");
    }

    let reload_input = match bundle {
        Some(path) => {
            let abs = path
                .canonicalize()
                .with_context(|| format!("resolve {}", path.display()))?;
            let kind = reload_input_kind(&abs)?;
            Some((abs.to_string_lossy().into_owned(), kind))
        }
        None => None,
    };

    let mut body = serde_json::Map::new();
    if let Some((path, kind)) = &reload_input {
        match kind {
            ReloadInputKind::Bundle => body.insert("bundle_path".into(), json!(path)),
            ReloadInputKind::Directory => body.insert("source_dir".into(), json!(path)),
        };
    }
    if let Some(id) = &plugin_id {
        body.insert("plugin_id".into(), json!(id));
    }

    let resp: ReloadResponse = post_json(endpoint, RELOAD_PATH, &serde_json::Value::Object(body))?;
    if !resp.ok {
        bail!(
            "reload rejected by cognia: {}",
            resp.error.unwrap_or_else(|| "<no error message>".into())
        );
    }

    let id = resp
        .plugin_id
        .as_deref()
        .or(plugin_id.as_deref())
        .unwrap_or("<unknown id>");
    println!(
        "{}{} {}",
        style::success_prefix(),
        style::ok("reloaded"),
        style::bold(id)
    );
    if let Some((path, kind)) = reload_input {
        println!("  {}: {}", kind.label(), style::dim(path));
    }
    for warning in resp.warnings {
        println!("  {}{}", style::warn_prefix(), warning);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReloadInputKind {
    Bundle,
    Directory,
}

impl ReloadInputKind {
    fn label(self) -> &'static str {
        match self {
            Self::Bundle => "bundle",
            Self::Directory => "directory",
        }
    }
}

fn reload_input_kind(path: &Path) -> Result<ReloadInputKind> {
    let metadata = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    if metadata.is_dir() {
        return Ok(ReloadInputKind::Directory);
    }
    if metadata.is_file() {
        return Ok(ReloadInputKind::Bundle);
    }
    bail!(
        "reload path is neither a file bundle nor a plugin directory: {}",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_with_plugin_id_posts_expected_payload() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<serde_json::Value>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                assert_eq!(req.method(), &tiny_http::Method::Post);
                assert_eq!(req.url(), "/api/v1/dev/plugins/reload");
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                *captured_clone.lock() = Some(serde_json::from_str(&body).unwrap());
                let response = tiny_http::Response::from_string(
                    r#"{"ok":true,"pluginId":"demo","warnings":[]}"#,
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(response);
            }
        });

        let endpoint = crate::http_client::EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let mut ui = crate::ui::RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run_with_endpoint(None, Some("demo".into()), &endpoint, &mut ui).unwrap();
        let _ = server_thread.join();

        let body = captured.lock().clone().expect("request body captured");
        assert_eq!(body["plugin_id"], "demo");
        assert!(body.get("bundle_path").is_none());
    }

    #[test]
    fn reload_rejects_missing_id_and_bundle() {
        let endpoint = crate::http_client::EndpointFile {
            base_url: "http://127.0.0.1:1".into(),
            dev_token: "tok".into(),
        };
        let mut ui = crate::ui::RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let err = run_with_endpoint(None, None, &endpoint, &mut ui).unwrap_err();
        assert!(err
            .to_string()
            .contains("requires --plugin-id, --bundle, or --path"));
    }

    #[test]
    fn reload_with_directory_posts_source_dir_to_reload_endpoint() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("plugin.json"),
            r#"{"id":"demo","name":"Demo","version":"0.1.0","type":"frontend"}"#,
        )
        .unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<serde_json::Value>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                assert_eq!(req.method(), &tiny_http::Method::Post);
                assert_eq!(req.url(), "/api/v1/dev/plugins/reload");
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                *captured_clone.lock() = Some(serde_json::from_str(&body).unwrap());
                let response = tiny_http::Response::from_string(
                    r#"{"ok":true,"pluginId":"demo","warnings":[]}"#,
                )
                .with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(response);
            }
        });

        let endpoint = crate::http_client::EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let mut ui = crate::ui::RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run_with_endpoint(Some(tmp.path().to_path_buf()), None, &endpoint, &mut ui).unwrap();
        let _ = server_thread.join();

        let body = captured.lock().clone().expect("request body captured");
        assert!(body.get("bundle_path").is_none(), "got: {body}");
        assert_eq!(
            body["source_dir"],
            tmp.path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
    }
}
