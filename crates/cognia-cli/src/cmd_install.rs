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

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::io::Read;
use std::path::PathBuf;

use crate::http_client::{get_json, load_endpoint, post_json, EndpointFile};
use crate::ui::{style, RuntimeUi};

const PATH: &str = "/api/v1/dev/plugins/install";
const LIST_PATH: &str = "/api/v1/dev/plugins/installed";

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
}

/// `cognia plugin install` — install a bundle into a running cognia.
///
/// Phase 5 adds the preflight check: read the bundle's manifest, ask the
/// bridge for the currently installed plugins, and if our id is already
/// loaded, surface "X v1.0 → v1.1" and prompt for replace. `--yes` skips.
pub fn run(bundle: PathBuf, ui: &mut RuntimeUi) -> Result<()> {
    let endpoint = load_endpoint()?;
    run_with_endpoint(bundle, &endpoint, ui)
}

/// Endpoint-injected variant. Used by tests so they don't race on the
/// global `COGNIA_CLI_ENDPOINT_FILE` env var, and by future callers that
/// already hold a resolved endpoint.
pub fn run_with_endpoint(
    bundle: PathBuf,
    endpoint: &EndpointFile,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let abs = bundle
        .canonicalize()
        .with_context(|| format!("resolve {}", bundle.display()))?;
    if !abs.exists() {
        bail!("bundle not found: {}", abs.display());
    }
    // ── Preflight: peek manifest, ask bridge for installed list ─────
    let (incoming_id, incoming_version) = match read_bundle_id_version(&abs) {
        Ok(v) => v,
        Err(e) => {
            // Non-fatal — the bridge will reject the malformed bundle
            // later with a clearer message. Print a hint and continue.
            eprintln!(
                "{}could not pre-read bundle manifest: {e}",
                style::warn_prefix()
            );
            (String::new(), String::new())
        }
    };
    if !incoming_id.is_empty() {
        if let Ok(list) = get_json::<ListInstalledResponse>(endpoint, LIST_PATH) {
            if let Some(existing) = list
                .plugins
                .iter()
                .find(|p| p.plugin_id == incoming_id)
            {
                let from = if existing.version.is_empty() {
                    "<unknown>".to_string()
                } else {
                    existing.version.clone()
                };
                let to = if incoming_version.is_empty() {
                    "<unknown>".to_string()
                } else {
                    incoming_version.clone()
                };
                println!(
                    "{}{} is already installed (v{from} → v{to}).",
                    style::warn_prefix(),
                    style::bold(&incoming_id)
                );
                let proceed = if ui.flags.yes {
                    true
                } else {
                    ui.prompter()
                        .confirm(
                            &format!(
                                "Replace existing {incoming_id} v{from} with v{to}?"
                            ),
                            false,
                            "--yes to replace without prompting",
                        )
                        .map_err(|e| anyhow!("{e}"))?
                };
                if !proceed {
                    bail!(
                        "install aborted: {incoming_id} v{from} kept (no changes made)"
                    );
                }
            }
        }
        // Note: a failed list request is non-fatal — we proceed and let
        // the bridge enforce whatever idempotency policy it has.
    }

    let body = json!({ "bundle_path": abs.to_string_lossy() });
    let resp: InstallResponse = post_json(endpoint, PATH, &body)?;
    if !resp.ok {
        bail!(
            "install rejected by cognia: {}",
            resp.error.unwrap_or_else(|| "<no error message>".into())
        );
    }
    let id = resp.plugin_id.as_deref().unwrap_or("<unknown id>");
    println!(
        "{}{} {} from {}",
        style::success_prefix(),
        style::ok("installed"),
        style::bold(id),
        style::dim(abs.display().to_string())
    );
    for warn in &resp.warnings {
        println!(
            "  {}{}",
            style::warn_prefix(),
            warn
        );
    }
    Ok(())
}

/// Best-effort: read `plugin.json` from the zip to extract id + version
/// so the preflight prompt can show "v1.0 → v1.1". Returns empty strings
/// on parse failure — callers treat that as "skip preflight".
fn read_bundle_id_version(bundle: &std::path::Path) -> Result<(String, String)> {
    let bytes = std::fs::read(bundle)
        .with_context(|| format!("read {}", bundle.display()))?;
    let reader = std::io::Cursor::new(&bytes);
    let mut archive = zip::ZipArchive::new(reader).context("open bundle as zip")?;
    let mut entry = archive
        .by_name("plugin.json")
        .map_err(|e| anyhow!("plugin.json not found: {e}"))?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf)?;
    let v: serde_json::Value = serde_json::from_str(&buf).context("parse plugin.json")?;
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Ok((id, version))
}

#[cfg(test)]
mod tests {
    use super::*;
    // `Read` is needed at the trait level for `req.as_reader().read_to_string()`;
    // rustc's unused-import lint doesn't see through tiny_http's reader type.
    #[allow(unused_imports)]
    use std::io::Read as _;

    use std::io::Write;

    fn ui_default() -> RuntimeUi {
        RuntimeUi::new(crate::ui::runtime::UiFlags::default())
    }

    /// Build a real zip bundle with the given manifest so `read_bundle_id_version`
    /// can pre-read id+version for the preflight tests.
    fn make_real_bundle(dir: &std::path::Path, id: &str, version: &str) -> PathBuf {
        let path = dir.join(format!("{id}-{version}.zip"));
        let f = std::fs::File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        w.start_file("plugin.json", opts).unwrap();
        let manifest = format!(
            r#"{{"id":"{id}","name":"x","version":"{version}","type":"frontend","capabilities":[]}}"#
        );
        w.write_all(manifest.as_bytes()).unwrap();
        w.finish().unwrap();
        path
    }

    /// End-to-end: CLI sends bundle path, mock server returns ok+pluginId.
    /// Uses `run_with_endpoint` so the test doesn't race on the global
    /// `COGNIA_CLI_ENDPOINT_FILE` env var with the http_client tests.
    #[test]
    fn install_happy_path_against_mock_bridge() {
        // tiny_http handles one request per recv() — but our run path
        // does a GET /installed first (preflight) then POST /install.
        // Drive both from one thread, in order.
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let captured = std::sync::Arc::new(parking_lot::Mutex::new(None::<serde_json::Value>));
        let captured_clone = captured.clone();
        let server_thread = std::thread::spawn(move || {
            // Round 1: GET /installed → empty list (no collision).
            if let Ok(req) = server.recv() {
                let body = r#"{"ok":true,"plugins":[]}"#;
                let resp = tiny_http::Response::from_string(body).with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
                let _ = req.respond(resp);
            }
            // Round 2: POST /install → ok.
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
        let tmp = tempfile::tempdir().unwrap();
        let bundle = make_real_bundle(tmp.path(), "cognia-hello", "0.1.0");
        let mut ui = ui_default();
        let result = run_with_endpoint(bundle, &endpoint, &mut ui);
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
        let mut ui = ui_default();
        let err = run_with_endpoint(
            PathBuf::from("/definitely-not-a-real-bundle.zip"),
            &endpoint,
            &mut ui,
        )
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
            // Preflight call first (empty list).
            if let Ok(req) = server.recv() {
                let resp =
                    tiny_http::Response::from_string(r#"{"ok":true,"plugins":[]}"#)
                        .with_header(
                            tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"application/json"[..],
                            )
                            .unwrap(),
                        );
                let _ = req.respond(resp);
            }
            // Then the install rejection.
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
        let tmp = tempfile::tempdir().unwrap();
        let bundle = make_real_bundle(tmp.path(), "rejected", "0.1.0");
        let mut ui = ui_default();
        let err = run_with_endpoint(bundle, &endpoint, &mut ui).unwrap_err();
        let _ = server_thread.join();
        assert!(
            err.to_string().contains("manifest invalid: missing id"),
            "got: {err}"
        );
    }

    #[test]
    fn install_preflight_prompts_when_same_id_already_installed() {
        use crate::ui::prompter::{Answer, MockPrompter};
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            // GET /installed → returns same id at v0.0.9.
            if let Ok(req) = server.recv() {
                let body =
                    r#"{"ok":true,"plugins":[{"pluginId":"hello","version":"0.0.9","status":"installed","installPath":"/x"}]}"#;
                let resp = tiny_http::Response::from_string(body).with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
                let _ = req.respond(resp);
            }
            // POST should NOT happen because user declines.
        });

        let endpoint = EndpointFile {
            base_url: format!("http://127.0.0.1:{port}"),
            dev_token: "tok".into(),
        };
        let tmp = tempfile::tempdir().unwrap();
        let bundle = make_real_bundle(tmp.path(), "hello", "1.0.0");
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default())
            .with_prompter(Box::new(MockPrompter::with_answers([Answer::Confirm(false)])));
        let err = run_with_endpoint(bundle, &endpoint, &mut ui).unwrap_err();
        let _ = server_thread.join();
        assert!(
            err.to_string().contains("install aborted"),
            "got: {err}"
        );
    }

    #[test]
    fn install_preflight_proceeds_when_yes_flag_set() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let server_thread = std::thread::spawn(move || {
            // GET /installed
            if let Ok(req) = server.recv() {
                let body =
                    r#"{"ok":true,"plugins":[{"pluginId":"hello","version":"0.0.9","status":"installed","installPath":"/x"}]}"#;
                let resp = tiny_http::Response::from_string(body).with_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/json"[..],
                    )
                    .unwrap(),
                );
                let _ = req.respond(resp);
            }
            // POST /install → ok
            if let Ok(req) = server.recv() {
                let resp =
                    tiny_http::Response::from_string(r#"{"ok":true,"pluginId":"hello"}"#)
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
        let tmp = tempfile::tempdir().unwrap();
        let bundle = make_real_bundle(tmp.path(), "hello", "1.0.0");
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            yes: true,
            ..crate::ui::runtime::UiFlags::default()
        });
        let result = run_with_endpoint(bundle, &endpoint, &mut ui);
        let _ = server_thread.join();
        assert!(result.is_ok(), "install with --yes should proceed: {result:?}");
    }

    #[test]
    fn read_bundle_id_version_extracts_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let path = make_real_bundle(tmp.path(), "my-plug", "2.3.4");
        let (id, ver) = read_bundle_id_version(&path).unwrap();
        assert_eq!(id, "my-plug");
        assert_eq!(ver, "2.3.4");
    }
}
