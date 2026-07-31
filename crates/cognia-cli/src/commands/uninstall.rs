//! `cognia plugin uninstall <plugin-id> [--purge-data]` — remove an
//! installed plugin from a running cognia desktop instance.
//!
//! Talks to the same CLI bridge as `install` — see `cli_bridge` on
//! the Tauri side.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::engine::bridge_client::{get_json, load_endpoint, post_json, EndpointFile};
use crate::ui::{style, RuntimeUi};

const PATH: &str = "/api/v1/dev/plugins/uninstall";
const LIST_PATH: &str = "/api/v1/dev/plugins/installed";

#[derive(Debug, Deserialize)]
struct UninstallResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListInstalledResponse {
    #[serde(default)]
    plugins: Vec<InstalledPluginEntry>,
}

#[derive(Debug, Deserialize)]
struct InstalledPluginEntry {
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(default)]
    version: String,
    #[serde(default, rename = "installPath")]
    install_path: String,
}

/// `cognia plugin uninstall <id> [--purge-data]` —
///
/// Phase 5 behaviors:
///   * `--purge-data` triggers a confirm prompt (default N). `--yes`
///     skips. The prompt shows the install path and the purge flag so
///     the user knows what's about to disappear.
///   * The plain `uninstall` flow (without `--purge-data`) just runs —
///     uninstall is reversible (re-install the same bundle), so we don't
///     prompt for it. Only the irreversible data wipe is gated.
pub fn run(plugin_id: String, purge_data: bool, ui: &mut RuntimeUi) -> Result<()> {
    if plugin_id.trim().is_empty() {
        if ui.flags.json {
            return emit_json_failure(
                "input",
                plugin_id,
                purge_data,
                "plugin_id is empty".to_string(),
            );
        }
        bail!("plugin_id is empty");
    }

    let endpoint = match load_endpoint() {
        Ok(endpoint) => endpoint,
        Err(err) if ui.flags.json => {
            return emit_json_failure("endpoint", plugin_id, purge_data, err.to_string());
        }
        Err(err) => return Err(err),
    };
    run_with_endpoint(plugin_id, purge_data, &endpoint, ui)
}

/// Endpoint-injected variant; mirrors [`crate::commands::install::run_with_endpoint`].
pub fn run_with_endpoint(
    plugin_id: String,
    purge_data: bool,
    endpoint: &EndpointFile,
    ui: &mut RuntimeUi,
) -> Result<()> {
    if plugin_id.trim().is_empty() {
        if ui.flags.json {
            return emit_json_failure(
                "input",
                plugin_id,
                purge_data,
                "plugin_id is empty".to_string(),
            );
        }
        bail!("plugin_id is empty");
    }

    if purge_data {
        // Best-effort: surface the install path so the user knows what's
        // about to disappear. A failed list call doesn't block the
        // prompt — we still want a confirmation step.
        let preview = get_json::<ListInstalledResponse>(endpoint, LIST_PATH)
            .ok()
            .and_then(|list| list.plugins.into_iter().find(|p| p.plugin_id == plugin_id));
        if !ui.flags.json && !ui.flags.quiet {
            println!(
                "{}{} will be uninstalled and its data {}.",
                style::warn_prefix(),
                style::bold(&plugin_id),
                style::error("PERMANENTLY DELETED")
            );
            if let Some(p) = &preview {
                if !p.version.is_empty() {
                    println!("  version:      {}", p.version);
                }
                if !p.install_path.is_empty() {
                    println!("  install dir:  {}", style::dim(&p.install_path));
                }
            }
            println!("  data scope:   plugin Dexie tables + plugin keyring entries");
            println!(
                "  reversible:   {}",
                style::error("no — Dexie wipe is one-way")
            );
        }

        let proceed = if ui.flags.yes {
            true
        } else {
            match ui.prompter().confirm(
                &format!("Permanently delete {plugin_id}'s data?"),
                false,
                "--yes to skip this confirmation",
            ) {
                Ok(proceed) => proceed,
                Err(err) if ui.flags.json => {
                    return emit_json_failure("confirm", plugin_id, purge_data, err.to_string());
                }
                Err(err) => return Err(anyhow!("{err}")),
            }
        };
        if !proceed {
            if ui.flags.json {
                return emit_json_failure(
                    "confirm",
                    plugin_id.clone(),
                    purge_data,
                    format!("uninstall --purge-data aborted: {plugin_id}'s data kept"),
                );
            }
            bail!("uninstall --purge-data aborted: {plugin_id}'s data kept");
        }
    }

    let body = json!({ "plugin_id": plugin_id, "purge_data": purge_data });
    let resp: UninstallResponse = match post_json(endpoint, PATH, &body) {
        Ok(resp) => resp,
        Err(err) if ui.flags.json => {
            return emit_json_failure("bridge", plugin_id, purge_data, err.to_string());
        }
        Err(err) => return Err(err),
    };
    if !resp.ok {
        let error = resp.error.unwrap_or_else(|| "<no error message>".into());
        if ui.flags.json {
            let payload = UninstallFailureJsonPayload {
                schema_version: 1,
                ok: false,
                action: "uninstall",
                stage: "bridge",
                plugin_id,
                purge_data,
                error,
            };
            println!("{}", serde_json::to_string_pretty(&payload)?);
            return Err(crate::shared::JsonFailureExit.into());
        }
        bail!("uninstall rejected by cognia: {}", error);
    }
    if ui.flags.json {
        let payload = UninstallJsonPayload {
            schema_version: 1,
            ok: true,
            action: "uninstall",
            plugin_id,
            purge_data,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!(
            "{}{} {}{}",
            style::success_prefix(),
            style::ok("uninstalled"),
            style::bold(&plugin_id),
            if purge_data {
                format!(" {}", style::dim("(data purged)"))
            } else {
                String::new()
            }
        );
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct UninstallJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(rename = "purgeData")]
    purge_data: bool,
}

#[derive(Debug, Serialize)]
struct UninstallFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(rename = "purgeData")]
    purge_data: bool,
    error: String,
}

fn emit_json_failure(
    stage: &'static str,
    plugin_id: String,
    purge_data: bool,
    error: String,
) -> Result<()> {
    let payload = UninstallFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "uninstall",
        stage,
        plugin_id,
        purge_data,
        error,
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ui_default() -> RuntimeUi {
        RuntimeUi::new(crate::ui::runtime::UiFlags::default())
    }

    fn ui_with_yes() -> RuntimeUi {
        RuntimeUi::new(crate::ui::runtime::UiFlags {
            yes: true,
            ..crate::ui::runtime::UiFlags::default()
        })
    }

    /// Plain (no `--purge-data`) uninstall does NOT preflight `/installed`
    /// and does NOT prompt — uninstall is reversible (re-install the
    /// bundle). Only the POST /uninstall hits the wire.
    #[test]
    fn uninstall_happy_path_plain() {
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
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(resp);
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let mut ui = ui_default();
        let result = run_with_endpoint("cognia-hello".into(), false, &endpoint, &mut ui);
        let _ = server_thread.join();
        assert!(result.is_ok(), "{result:?}");

        let payload = captured.lock().clone().expect("server captured request");
        assert_eq!(
            payload["plugin_id"],
            serde_json::Value::String("cognia-hello".into())
        );
        assert_eq!(payload["purge_data"], serde_json::Value::Bool(false));
    }

    /// `--purge-data` with `--yes` should ALSO not prompt, but it WILL
    /// hit `/installed` first to gather the preview info.
    #[test]
    fn uninstall_purge_with_yes_skips_prompt() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            // GET /installed
            if let Ok(req) = server.recv() {
                let body = r#"{"ok":true,"plugins":[{"pluginId":"x","version":"1.0.0","status":"installed","installPath":"/p"}]}"#;
                let _ = req.respond(
                    tiny_http::Response::from_string(body).with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    ),
                );
            }
            // POST /uninstall
            if let Ok(req) = server.recv() {
                let _ = req.respond(tiny_http::Response::from_string(r#"{"ok":true}"#));
            }
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let mut ui = ui_with_yes();
        let result = run_with_endpoint("x".into(), true, &endpoint, &mut ui);
        let _ = server_thread.join();
        assert!(result.is_ok(), "{result:?}");
    }

    /// `--purge-data` without `--yes`: declines → bail with "aborted".
    #[test]
    fn uninstall_purge_aborts_when_user_declines() {
        use crate::ui::prompter::{Answer, MockPrompter};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            // GET /installed
            if let Ok(req) = server.recv() {
                let _ = req.respond(
                    tiny_http::Response::from_string(r#"{"ok":true,"plugins":[]}"#).with_header(
                        tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json"[..],
                        )
                        .unwrap(),
                    ),
                );
            }
            // POST /uninstall should NOT happen.
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default()).with_prompter(
            Box::new(MockPrompter::with_answers([Answer::Confirm(false)])),
        );
        let err = run_with_endpoint("x".into(), true, &endpoint, &mut ui).unwrap_err();
        let _ = server_thread.join();
        assert!(err.to_string().contains("aborted"), "got: {err}");
    }

    #[test]
    fn uninstall_rejects_empty_id() {
        let endpoint = EndpointFile {
            base_url: "http://127.0.0.1:1".into(),
            dev_token: "x".into(),
        };
        let mut ui = ui_default();
        let err = run_with_endpoint("".into(), false, &endpoint, &mut ui).unwrap_err();
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
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                        .unwrap(),
                );
                let _ = req.respond(resp);
            }
        });
        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let mut ui = ui_default();
        let err = run_with_endpoint("missing".into(), false, &endpoint, &mut ui).unwrap_err();
        let _ = server_thread.join();
        assert!(err.to_string().contains("plugin not installed"));
    }

    #[test]
    fn uninstall_json_payload_is_schema_versioned() {
        let payload = UninstallJsonPayload {
            schema_version: 1,
            ok: true,
            action: "uninstall",
            plugin_id: "demo".into(),
            purge_data: true,
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "uninstall");
        assert_eq!(json["pluginId"], "demo");
        assert_eq!(json["purgeData"], true);
    }

    #[test]
    fn uninstall_failure_json_payload_carries_bridge_error() {
        let payload = UninstallFailureJsonPayload {
            schema_version: 1,
            ok: false,
            action: "uninstall",
            stage: "bridge",
            plugin_id: "missing".into(),
            purge_data: false,
            error: "plugin not installed".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["action"], "uninstall");
        assert_eq!(json["stage"], "bridge");
        assert_eq!(json["pluginId"], "missing");
        assert_eq!(json["purgeData"], false);
        assert_eq!(json["error"], "plugin not installed");
    }
}
