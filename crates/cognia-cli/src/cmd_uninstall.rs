//! `cognia plugin uninstall <plugin-id> [--purge-data]` — remove an
//! installed plugin from a running cognia desktop instance.
//!
//! Talks to the same CLI bridge as `cmd_install` — see `cli_bridge` on
//! the Tauri side.

use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::json;

use crate::http_client::{get_json, load_endpoint, post_json, EndpointFile};
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
    let endpoint = load_endpoint()?;
    run_with_endpoint(plugin_id, purge_data, &endpoint, ui)
}

/// Endpoint-injected variant; mirrors [`crate::cmd_install::run_with_endpoint`].
pub fn run_with_endpoint(
    plugin_id: String,
    purge_data: bool,
    endpoint: &EndpointFile,
    ui: &mut RuntimeUi,
) -> Result<()> {
    if plugin_id.trim().is_empty() {
        bail!("plugin_id is empty");
    }

    if purge_data {
        // Best-effort: surface the install path so the user knows what's
        // about to disappear. A failed list call doesn't block the
        // prompt — we still want a confirmation step.
        let preview = get_json::<ListInstalledResponse>(endpoint, LIST_PATH)
            .ok()
            .and_then(|list| list.plugins.into_iter().find(|p| p.plugin_id == plugin_id));
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

        let proceed = if ui.flags.yes {
            true
        } else {
            ui.prompter()
                .confirm(
                    &format!("Permanently delete {plugin_id}'s data?"),
                    false,
                    "--yes to skip this confirmation",
                )
                .map_err(|e| anyhow!("{e}"))?
        };
        if !proceed {
            bail!("uninstall --purge-data aborted: {plugin_id}'s data kept");
        }
    }

    let body = json!({ "plugin_id": plugin_id, "purge_data": purge_data });
    let resp: UninstallResponse = post_json(endpoint, PATH, &body)?;
    if !resp.ok {
        bail!(
            "uninstall rejected by cognia: {}",
            resp.error.unwrap_or_else(|| "<no error message>".into())
        );
    }
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
    Ok(())
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
}
