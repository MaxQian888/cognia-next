//! The broker host for the managed Pro IDE's real-binary E2E.
//!
//! Runs the same headless code path a companion host runs —
//! `RemoteCodeServerState::ensure`, the managed broker, proxy builds and
//! installs, the `/ide/relay/{id}` front door — against a real code-server, and
//! hands the renderer's half to whoever drives it over stdio. The driver
//! (`lib/plugin/ide/real-code-server.e2e.test.ts`) plays the renderer with the
//! real broker runtime, so between the two the whole chain runs for real.
//!
//! Built only with `--features e2e-host`; nothing ships it.
//!
//! ```text
//! codeserver-e2e-host --data-dir <dir> --root <workspace>
//! ```
//!
//! code-server and the broker extension come from `COGNIA_CODE_SERVER_BIN` and
//! `COGNIA_CODE_SERVER_AGENT_VSIX`, exactly as on a companion host. The
//! extension host inherits this process's environment, so the driver sets
//! `COGNIA_CS_TEST_PROBE=1` here to enable the extension's test probe.
//!
//! Stdout carries one JSON object per line: `{"type":"ready",…}` once the
//! workbench is healthy, `{"type":"event","event":…,"payload":…}` for every
//! broker frame the renderer would receive, and `{"type":"reply","id":…}` for
//! each command. Stdin carries commands, one JSON object per line; see
//! [`Command`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use cognia_codeserver::agent_channel;
use cognia_codeserver::host::{CodeServerHost, HOST};
use cognia_codeserver::profile::IdeProfile;
use cognia_codeserver::proxy::{ProxyArtifact, ProxyBuildRequest};
use cognia_codeserver::remote::{self, RemoteCodeServerState};
use cognia_companion_bus::event_bus::{EventBus, SubscribeResult};
use cognia_companion_security::principal::DeviceContext;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

/// The one paired device this harness plays.
const DEVICE: &str = "e2e-device";

/// Broker frames the renderer would receive.
const FORWARDED_EVENTS: [&str; 5] = [
    agent_channel::CODESERVER_BROKER_REQUEST_EVENT,
    agent_channel::CODESERVER_BROKER_NOTIFICATION_EVENT,
    agent_channel::CODESERVER_EDITOR_EVENT,
    agent_channel::CODESERVER_BROKER_ISSUE_EVENT,
    "codeserver://instance-exited",
];

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Command {
    /// Answer a `codeserver://broker-request`, as `codeserver_broker_respond`.
    Respond {
        root: String,
        generation: u64,
        #[serde(rename = "requestId")]
        request_id: Value,
        result: Option<Value>,
        error: Option<Value>,
    },
    /// Send a provider event, as `codeserver_broker_notify`.
    Notify {
        root: String,
        generation: u64,
        params: Value,
    },
    /// Drive the extension: a host → extension request (an editor verb).
    Request {
        root: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
    BuildProxy {
        request: ProxyBuildRequest,
    },
    InstallProxy {
        artifact: ProxyArtifact,
    },
    ListProxies,
    #[serde(rename_all = "camelCase")]
    CreateContent {
        root: String,
        generation: u64,
        plugin_id: String,
        provider_id: String,
        permission: Option<String>,
        media_type: String,
        bytes: Vec<u8>,
    },
    #[serde(rename_all = "camelCase")]
    RedeemContent {
        root: String,
        generation: u64,
        plugin_id: String,
        provider_id: String,
        permission: Option<String>,
        handle_id: String,
    },
    ValidatePaths {
        root: String,
        paths: Vec<String>,
    },
    /// Restart the extension host the way a proxy update does, and answer
    /// with the generation that reconnected.
    RestartExtensionHost {
        root: String,
    },
    Shutdown,
}

#[derive(Debug, Deserialize)]
struct Envelope {
    id: u64,
    #[serde(flatten)]
    command: Value,
}

/// Plays the companion's policy for exactly one device.
struct E2eHost {
    state: Arc<RemoteCodeServerState>,
}

#[async_trait::async_trait]
impl CodeServerHost for E2eHost {
    fn remote_state(&self) -> Option<Arc<RemoteCodeServerState>> {
        Some(Arc::clone(&self.state))
    }
    fn device_can_control(&self, device_id: &str) -> bool {
        device_id == DEVICE
    }
    async fn port_allowed(&self, _: &str, _: &str, _: u16) -> Result<bool, String> {
        Ok(false)
    }
    async fn local_relay(&self, _: String, _: String, _: u16, _: Request) -> Response {
        axum::http::StatusCode::NOT_FOUND.into_response()
    }
}

/// The crate's warnings, on stderr: the driver keeps them for a failure report.
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!(
                "[{}] {}: {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }
    fn flush(&self) {}
}

fn emit(value: Value) {
    // One write per line, so a frame is never interleaved with another.
    println!("{value}");
}

/// Stand in for `require_device_access`: every relayed request is the device.
async fn as_device(mut request: Request, next: Next) -> Response {
    request.extensions_mut().insert(DeviceContext {
        device_id: DEVICE.to_string(),
        tenant_id: "e2e".to_string(),
        scope: "device".to_string(),
        granted_scopes: Vec::new(),
        authorization_capabilities: None,
    });
    next.run(request).await
}

/// Canonicalize each path and refuse one outside `root`, as the desktop's
/// `codeserver_broker_validate_paths` does.
fn validate_paths(root: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let root = std::fs::canonicalize(root).map_err(|error| format!("{root}: {error}"))?;
    paths
        .iter()
        .map(|path| {
            let path = PathBuf::from(path);
            let mut existing = path.as_path();
            let mut rest = Vec::new();
            while !existing.exists() {
                let orphan = || "path has no existing ancestor".to_string();
                rest.push(existing.file_name().ok_or_else(orphan)?);
                existing = existing.parent().ok_or_else(orphan)?;
            }
            let mut canonical =
                std::fs::canonicalize(existing).map_err(|error| error.to_string())?;
            for part in rest.into_iter().rev() {
                canonical.push(part);
            }
            if !canonical.starts_with(&root) {
                return Err(format!("{} is outside the workspace", path.display()));
            }
            Ok(canonical.to_string_lossy().into_owned())
        })
        .collect()
}

async fn run(command: Command, state: &Arc<RemoteCodeServerState>) -> Result<Value, String> {
    let channel = agent_channel::global();
    match command {
        Command::Respond {
            root,
            generation,
            request_id,
            result,
            error,
        } => channel
            .respond(&root, generation, request_id, result, error)
            .await
            .map(|()| Value::Null),
        Command::Notify {
            root,
            generation,
            params,
        } => channel
            .notify_provider(&root, generation, params)
            .await
            .map(|()| Value::Null),
        Command::Request {
            root,
            method,
            params,
        } => channel.send(&root, &method, params).await,
        Command::BuildProxy { request } => state
            .build_proxy(request)
            .and_then(|artifact| serde_json::to_value(artifact).map_err(|e| e.to_string())),
        Command::InstallProxy { artifact } => state
            .install_proxy_artifact(&artifact)
            .await
            .map(Value::Bool),
        Command::ListProxies => state
            .list_proxies()
            .and_then(|list| serde_json::to_value(list).map_err(|e| e.to_string())),
        Command::CreateContent {
            root,
            generation,
            plugin_id,
            provider_id,
            permission,
            media_type,
            bytes,
        } => channel
            .create_content_handle(
                &root,
                generation,
                &plugin_id,
                &provider_id,
                permission,
                media_type,
                bytes,
            )
            .and_then(|handle| serde_json::to_value(handle).map_err(|e| e.to_string())),
        Command::RedeemContent {
            root,
            generation,
            plugin_id,
            provider_id,
            permission,
            handle_id,
        } => channel
            .redeem_content_handle(
                &root,
                generation,
                &plugin_id,
                &provider_id,
                permission.as_deref(),
                &handle_id,
            )
            .map(|bytes| json!(bytes)),
        Command::ValidatePaths { root, paths } => validate_paths(&root, &paths).map(|v| json!(v)),
        Command::RestartExtensionHost { root } => {
            let previous = channel
                .connection_generation(&root)
                .ok_or_else(|| "managed extension host is disconnected".to_string())?;
            channel.restart_extension_host(&root).await?;
            channel
                .wait_for_new_generation(&root, previous, Duration::from_secs(30))
                .await
                .map(|generation| json!({ "previous": previous, "generation": generation }))
        }
        Command::Shutdown => {
            state.stop_all().await;
            std::process::exit(0);
        }
    }
}

fn argument(args: &[String], name: &str) -> Result<String, String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1).cloned())
        .ok_or_else(|| format!("missing {name} <value>"))
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    // The real hosts install this at startup; reqwest refuses to build without it.
    cognia_net::proxy_config::ensure_crypto_provider();
    if log::set_logger(&StderrLogger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let data_dir = PathBuf::from(argument(&args, "--data-dir")?);
    let root = argument(&args, "--root")?;

    let bus = EventBus::new();
    agent_channel::global().attach_event_bus(Arc::clone(&bus));
    let SubscribeResult::Ok { mut receiver, .. } = bus.subscribe(None, 0) else {
        return Err("subscribe to the broker event bus".to_string());
    };
    tokio::spawn(async move {
        while let Ok(frame) = receiver.recv().await {
            if FORWARDED_EVENTS.contains(&frame.event_type.as_str()) {
                emit(
                    json!({ "type": "event", "event": frame.event_type, "payload": frame.payload }),
                );
            }
        }
    });

    let state = RemoteCodeServerState::new(data_dir);
    HOST.set(Arc::new(E2eHost {
        state: Arc::clone(&state),
    }));

    let relay = Router::new()
        .route("/ide/relay/{relay_id}", any(remote::relay_root_handler))
        .route("/ide/relay/{relay_id}/", any(remote::relay_root_handler))
        .route("/ide/relay/{relay_id}/{*tail}", any(remote::relay_handler))
        .layer(axum::middleware::from_fn(as_device));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("bind relay: {error}"))?;
    let relay_origin = format!(
        "http://{}",
        listener.local_addr().map_err(|error| error.to_string())?
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, relay).await;
    });

    let started = Instant::now();
    let status = state.ensure(&root, IdeProfile::Managed, DEVICE).await?;
    let ensure_ms = started.elapsed().as_millis() as u64;
    let canonical = std::fs::canonicalize(&root)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    let port = state.loopback_port(&canonical, DEVICE).await;
    emit(json!({
        "type": "ready",
        "hostId": state.host_id(),
        "root": canonical,
        "port": port,
        "relayPath": status.relay_path,
        "relayOrigin": relay_origin,
        "ensureMs": ensure_ms,
    }));

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(envelope) = serde_json::from_str::<Envelope>(&line) else {
            emit(
                json!({ "type": "reply", "id": null, "ok": false, "error": "unparseable command" }),
            );
            continue;
        };
        let id = envelope.id;
        let command = match serde_json::from_value::<Command>(envelope.command) {
            Ok(command) => command,
            Err(error) => {
                emit(json!({ "type": "reply", "id": id, "ok": false, "error": error.to_string() }));
                continue;
            }
        };
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            match run(command, &state).await {
                Ok(result) => {
                    emit(json!({ "type": "reply", "id": id, "ok": true, "result": result }))
                }
                Err(error) => {
                    emit(json!({ "type": "reply", "id": id, "ok": false, "error": error }))
                }
            }
        });
    }
    state.stop_all().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_parse_from_the_driver_s_wire_shape() {
        let envelope: Envelope = serde_json::from_str(
            r#"{"id":4,"op":"respond","root":"/w","generation":2,"requestId":"proxy:7","result":{"ok":true}}"#,
        )
        .unwrap();
        assert_eq!(envelope.id, 4);
        let Command::Respond {
            root,
            generation,
            request_id,
            result,
            error,
        } = serde_json::from_value::<Command>(envelope.command).unwrap()
        else {
            panic!("a respond command");
        };
        assert_eq!((root.as_str(), generation), ("/w", 2));
        assert_eq!(request_id, json!("proxy:7"));
        assert_eq!(result, Some(json!({ "ok": true })));
        assert_eq!(error, None);
        let redeem: Command = serde_json::from_value(json!({
            "op": "redeemContent", "root": "/w", "generation": 1, "pluginId": "p",
            "providerId": "q", "handleId": "h"
        }))
        .unwrap();
        assert!(matches!(
            redeem,
            Command::RedeemContent {
                permission: None,
                ..
            }
        ));
        assert!(matches!(
            serde_json::from_value::<Command>(json!({ "op": "restartExtensionHost", "root": "/w" })),
            Ok(Command::RestartExtensionHost { root }) if root == "/w"
        ));
        assert!(serde_json::from_value::<Command>(json!({ "op": "format-disk" })).is_err());
    }

    #[test]
    fn paths_are_confined_to_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_string_lossy().into_owned();
        let inside = workspace
            .path()
            .join("new/file.txt")
            .to_string_lossy()
            .into_owned();
        let [validated] = &validate_paths(&root, &[inside]).unwrap()[..] else {
            panic!("one path");
        };
        assert!(validated.ends_with("new/file.txt"));
        assert!(validate_paths(&root, &["/etc/hosts".into()]).is_err());
        let escape = workspace
            .path()
            .join("../escape")
            .to_string_lossy()
            .into_owned();
        assert!(validate_paths(&root, &[escape]).is_err());
    }

    #[test]
    fn the_device_is_the_only_one_with_control() {
        let state = RemoteCodeServerState::new(std::env::temp_dir().join("cognia-e2e-unused"));
        let host = E2eHost { state };
        assert!(host.device_can_control(DEVICE));
        assert!(!host.device_can_control("someone-else"));
    }
}
