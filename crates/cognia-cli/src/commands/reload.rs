//! `cognia plugin reload` - ask the running desktop bridge to hot-reload a plugin.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};

use crate::engine::bridge_client::{load_endpoint, post_json, EndpointFile};
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
    let prepared = match prepare_reload_request(bundle.clone(), plugin_id.clone()) {
        Ok(prepared) => prepared,
        Err(err) if ui.flags.json => {
            return emit_json_input_failure(bundle.as_ref(), plugin_id.as_ref(), err.to_string());
        }
        Err(err) => return Err(err),
    };
    let endpoint = match load_endpoint() {
        Ok(endpoint) => endpoint,
        Err(err) if ui.flags.json => {
            return emit_json_failure("endpoint", &prepared, err.to_string(), Vec::new());
        }
        Err(err) => return Err(err),
    };
    run_prepared_with_endpoint(prepared, &endpoint, ui)
}

#[cfg(test)]
pub fn run_with_endpoint(
    bundle: Option<PathBuf>,
    plugin_id: Option<String>,
    endpoint: &EndpointFile,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let prepared = prepare_reload_request(bundle, plugin_id)?;
    run_prepared_with_endpoint(prepared, endpoint, ui)
}

fn run_prepared_with_endpoint(
    prepared: PreparedReloadRequest,
    endpoint: &EndpointFile,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(input) = &prepared.reload_input {
        match input.kind {
            ReloadInputKind::Bundle => body.insert("bundle_path".into(), json!(input.path)),
            ReloadInputKind::Directory => body.insert("source_dir".into(), json!(input.path)),
        };
    }
    if let Some(id) = &prepared.plugin_id {
        body.insert("plugin_id".into(), json!(id));
    }

    let resp: ReloadResponse =
        match post_json(endpoint, RELOAD_PATH, &serde_json::Value::Object(body)) {
            Ok(resp) => resp,
            Err(err) if ui.flags.json => {
                return emit_json_failure("bridge", &prepared, err.to_string(), Vec::new());
            }
            Err(err) => return Err(err),
        };
    if !resp.ok {
        let error = resp.error.unwrap_or_else(|| "<no error message>".into());
        if ui.flags.json {
            return emit_json_failure("bridge", &prepared, error, resp.warnings);
        }
        bail!("reload rejected by cognia: {}", error);
    }

    let id = resp
        .plugin_id
        .as_deref()
        .or(prepared.plugin_id.as_deref())
        .unwrap_or("<unknown id>");
    if ui.flags.json {
        let (path, input_kind) = prepared.reload_input_payload_fields();
        let payload = ReloadJsonPayload {
            schema_version: 1,
            ok: true,
            action: "reload",
            plugin_id: id.to_string(),
            input_kind,
            path,
            warnings: resp.warnings,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!(
            "{}{} {}",
            style::success_prefix(),
            style::ok("reloaded"),
            style::bold(id)
        );
        if let Some(input) = &prepared.reload_input {
            println!("  {}: {}", input.kind.label(), style::dim(&input.path));
        }
        for warning in resp.warnings {
            println!("  {}{}", style::warn_prefix(), warning);
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct PreparedReloadRequest {
    reload_input: Option<PreparedReloadInput>,
    plugin_id: Option<String>,
}

impl PreparedReloadRequest {
    fn reload_input_payload_fields(&self) -> (Option<String>, Option<&'static str>) {
        match &self.reload_input {
            Some(input) => (Some(input.path.clone()), Some(input.kind.label())),
            None => (None, None),
        }
    }
}

#[derive(Debug, Clone)]
struct PreparedReloadInput {
    path: String,
    kind: ReloadInputKind,
}

fn prepare_reload_request(
    bundle: Option<PathBuf>,
    plugin_id: Option<String>,
) -> Result<PreparedReloadRequest> {
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
            Some(PreparedReloadInput {
                path: abs.to_string_lossy().into_owned(),
                kind,
            })
        }
        None => None,
    };

    Ok(PreparedReloadRequest {
        reload_input,
        plugin_id,
    })
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

#[derive(Debug, Serialize)]
struct ReloadJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(rename = "inputKind", skip_serializing_if = "Option::is_none")]
    input_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
struct ReloadFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    #[serde(rename = "pluginId", skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>,
    #[serde(rename = "inputKind", skip_serializing_if = "Option::is_none")]
    input_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    error: String,
    warnings: Vec<String>,
}

fn emit_json_failure(
    stage: &'static str,
    prepared: &PreparedReloadRequest,
    error: String,
    warnings: Vec<String>,
) -> Result<()> {
    let (path, input_kind) = prepared.reload_input_payload_fields();
    let payload = ReloadFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "reload",
        stage,
        plugin_id: prepared.plugin_id.clone(),
        input_kind,
        path,
        error,
        warnings,
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

fn emit_json_input_failure(
    bundle: Option<&PathBuf>,
    plugin_id: Option<&String>,
    error: String,
) -> Result<()> {
    let payload = ReloadFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "reload",
        stage: "input",
        plugin_id: plugin_id
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty()),
        input_kind: None,
        path: bundle.map(|path| path.display().to_string()),
        error,
        warnings: Vec::new(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
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

        let endpoint = crate::engine::bridge_client::EndpointFile {
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
        let endpoint = crate::engine::bridge_client::EndpointFile {
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

        let endpoint = crate::engine::bridge_client::EndpointFile {
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

    #[test]
    fn reload_json_payload_is_schema_versioned() {
        let payload = ReloadJsonPayload {
            schema_version: 1,
            ok: true,
            action: "reload",
            plugin_id: "demo".into(),
            input_kind: Some("bundle"),
            path: Some("C:/plugins/demo.zip".into()),
            warnings: vec!["hot reload complete".into()],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "reload");
        assert_eq!(json["pluginId"], "demo");
        assert_eq!(json["inputKind"], "bundle");
        assert_eq!(json["path"], "C:/plugins/demo.zip");
        assert_eq!(json["warnings"][0], "hot reload complete");
    }

    #[test]
    fn reload_json_payload_omits_absent_input() {
        let payload = ReloadJsonPayload {
            schema_version: 1,
            ok: true,
            action: "reload",
            plugin_id: "demo".into(),
            input_kind: None,
            path: None,
            warnings: Vec::new(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert!(json.get("inputKind").is_none(), "got: {json}");
        assert!(json.get("path").is_none(), "got: {json}");
    }

    #[test]
    fn reload_failure_json_payload_omits_absent_input() {
        let payload = ReloadFailureJsonPayload {
            schema_version: 1,
            ok: false,
            action: "reload",
            stage: "bridge",
            plugin_id: Some("missing".into()),
            input_kind: None,
            path: None,
            error: "plugin not installed".into(),
            warnings: Vec::new(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["action"], "reload");
        assert_eq!(json["stage"], "bridge");
        assert_eq!(json["pluginId"], "missing");
        assert_eq!(json["error"], "plugin not installed");
        assert!(json.get("inputKind").is_none(), "got: {json}");
        assert!(json.get("path").is_none(), "got: {json}");
    }
}
