//! `cognia plugin list` - list plugins from the running desktop bridge.

use anyhow::Result;
use comfy_table::{presets::UTF8_FULL, ContentArrangement, Table};
use serde::{Deserialize, Serialize};

use crate::engine::bridge_client::{get_json, load_endpoint, EndpointFile};
use crate::ui::{style, RuntimeUi};

const LIST_PATH: &str = "/api/v1/dev/plugins/installed";

#[derive(Debug, Deserialize)]
struct ListInstalledResponse {
    #[serde(default)]
    plugins: Vec<InstalledPluginEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct InstalledPluginEntry {
    #[serde(rename = "pluginId")]
    pub(crate) plugin_id: String,
    #[serde(default)]
    pub(crate) version: String,
    #[serde(default)]
    pub(crate) status: String,
    #[serde(default, rename = "installPath")]
    pub(crate) install_path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ListJsonPayload {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    pub(crate) ok: bool,
    pub(crate) action: &'static str,
    pub(crate) plugins: Vec<InstalledPluginEntry>,
}

#[derive(Debug, Serialize)]
struct ListFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    error: String,
}

pub fn run(json: bool, ui: &mut RuntimeUi) -> Result<()> {
    let endpoint = match load_endpoint() {
        Ok(endpoint) => endpoint,
        Err(err) if json => return emit_json_failure("endpoint", err),
        Err(err) => return Err(err),
    };
    run_with_endpoint(json, &endpoint, ui)
}

pub fn run_with_endpoint(json: bool, endpoint: &EndpointFile, ui: &mut RuntimeUi) -> Result<()> {
    let plugins = match fetch_installed_plugins(endpoint) {
        Ok(plugins) => plugins,
        Err(err) if json => return emit_json_failure("bridge", err),
        Err(err) => return Err(err),
    };
    if json {
        let payload = ListJsonPayload {
            schema_version: 1,
            ok: true,
            action: "list",
            plugins,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        print_human(&plugins);
    }
    Ok(())
}

pub(crate) fn fetch_installed_plugins(
    endpoint: &EndpointFile,
) -> Result<Vec<InstalledPluginEntry>> {
    let response: ListInstalledResponse = get_json(endpoint, LIST_PATH)?;
    Ok(response.plugins)
}

fn emit_json_failure(stage: &'static str, err: anyhow::Error) -> Result<()> {
    let payload = ListFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "list",
        stage,
        error: err.to_string(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

fn print_human(plugins: &[InstalledPluginEntry]) {
    if plugins.is_empty() {
        println!(
            "{}No plugins installed in the running desktop.",
            style::warn_prefix()
        );
        return;
    }

    let mut table = Table::new();
    table
        .load_preset(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(vec!["Plugin", "Version", "Status", "Install path"]);
    for plugin in plugins {
        table.add_row(vec![
            style::bold(&plugin.plugin_id),
            blank_as_dash(&plugin.version),
            blank_as_dash(&plugin.status),
            style::dim(blank_as_dash(&plugin.install_path)),
        ]);
    }
    println!("{table}");
}

fn blank_as_dash(value: &str) -> String {
    if value.trim().is_empty() {
        "-".to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_installed_plugins_reads_bridge_response() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            if let Ok(req) = server.recv() {
                assert_eq!(req.method(), &tiny_http::Method::Get);
                assert_eq!(req.url(), "/api/v1/dev/plugins/installed");
                let token = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("X-Cognia-Dev-Token"))
                    .map(|h| h.value.as_str().to_string());
                assert_eq!(token.as_deref(), Some("tok"));
                let body = r#"{"ok":true,"plugins":[{"pluginId":"demo","version":"1.2.3","status":"enabled","installPath":"C:/plugins/demo"}]}"#;
                let response = tiny_http::Response::from_string(body).with_header(
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
        let plugins = fetch_installed_plugins(&endpoint).unwrap();
        let _ = server_thread.join();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].plugin_id, "demo");
        assert_eq!(plugins[0].version, "1.2.3");
        assert_eq!(plugins[0].status, "enabled");
        assert_eq!(plugins[0].install_path, "C:/plugins/demo");
    }

    #[test]
    fn json_payload_is_schema_versioned() {
        let payload = ListJsonPayload {
            schema_version: 1,
            ok: true,
            action: "list",
            plugins: vec![InstalledPluginEntry {
                plugin_id: "demo".into(),
                version: "1.2.3".into(),
                status: "installed".into(),
                install_path: "/plugins/demo".into(),
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], serde_json::Value::Number(1.into()));
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "list");
        assert_eq!(json["plugins"][0]["pluginId"], "demo");
        assert_eq!(json["plugins"][0]["installPath"], "/plugins/demo");
    }

    #[test]
    fn list_failure_json_payload_carries_bridge_error() {
        let payload = ListFailureJsonPayload {
            schema_version: 1,
            ok: false,
            action: "list",
            stage: "bridge",
            error: "GET http://127.0.0.1:7891/api/v1/dev/plugins/installed -> HTTP 500".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["action"], "list");
        assert_eq!(json["stage"], "bridge");
        assert!(json["error"].as_str().unwrap().contains("HTTP 500"));
    }
}
