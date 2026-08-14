//! CLI Bridge — loopback-only HTTP server for `cognia-cli` to drive a
//! running cognia desktop instance.
//!
//! # Why a separate listener?
//!
//! The companion_api (default port 27890) is designed for paired mobile devices:
//! HTTPS, JWT-protected, LAN-accessible. The CLI bridge is for the
//! developer's own machine: loopback-only, plain HTTP, dev-token gated.
//! Keeping them on separate ports lets each carry the auth model
//! appropriate to its threat model without leaking semantics into the
//! other.
//!
//! # Endpoints
//!
//! - `POST /api/dev/plugins/install`   — install a `.zip` bundle from disk
//! - `POST /api/dev/plugins/install-directory`
//!                                          — install an unpacked plugin dir
//! - `POST /api/dev/plugins/uninstall` — remove a plugin by id
//! - `POST /api/dev/plugins/reload`    — re-install (if bundle/source dir
//!                                          path given) or emit a hot-reload event
//! - `GET  /api/dev/health`            — liveness probe
//! - `POST /api/dev/acp/ticket`         — mint a single-use Companion socket ticket
//!                                          for the `cognia acp` stdio bridge
//!
//! # Discovery
//!
//! On server startup we write `<config_dir>/cognia/cli-endpoint.json`
//! containing the bound base URL and the per-launch dev token. The CLI
//! reads this to find us. The file is rewritten every launch (token
//! rotates), so a lingering file from a previous run can't authenticate
//! against a new instance.
//!
//! # Auth
//!
//! Two-layer check:
//!   1. `ConnectInfo<SocketAddr>` confirms the request originates from
//!      127.0.0.1 / ::1 — anything else gets 403.
//!   2. `X-Cognia-Dev-Token` header must equal the per-launch token.
//!      Mismatch → 401.
//!
//! The dev token never crosses the network for any other reason (we
//! never echo it back, never log it). It's effectively a session-bound
//! HMAC for the bridge's lifetime.

pub mod detect;
pub mod download;
pub mod handlers;
pub mod release_key;
pub mod renderer_bridge;
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub mod server;

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
use ::anyhow::Context;
use ::anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use std::net::SocketAddr;
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{broadcast, watch};

/// Path inside the cognia config dir for the endpoint discovery file.
pub const ENDPOINT_FILE_REL: &str = "cognia/cli-endpoint.json";

/// How many published HostState events stay replayable. One entry per applied
/// action, so this covers a poller that was away for a long burst.
const HOST_STATE_EVENT_LOG_CAPACITY: usize = 1024;
const AGENT_EVENT_LOG_CAPACITY: usize = 1024;

/// `hostSeq` carried by a published HostState event (0 when absent).
pub fn event_host_seq(event: &serde_json::Value) -> u64 {
    event
        .get("hostSeq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

/// Extract the canonical Agent RPC envelope from the sidecar's Tauri wrapper.
pub fn canonical_agent_envelope(payload: &serde_json::Value) -> Option<serde_json::Value> {
    payload.get("envelope").cloned()
}

/// Bounded replay log sitting in front of the broadcast fan-out.
///
/// `broadcast` only reaches receivers that already exist when `send` runs, so a
/// long poll that subscribes inside the request misses everything published
/// between two polls — the CLI would skip those actions with no way to notice.
/// The ring lets a reconnecting poller collect them, and [`oldest_host_seq`]
/// lets it detect having fallen off the back of the ring entirely.
///
/// [`oldest_host_seq`]: HostStateEventLog::oldest_host_seq
pub struct HostStateEventLog {
    sender: broadcast::Sender<serde_json::Value>,
    recent: Mutex<std::collections::VecDeque<serde_json::Value>>,
}

impl Default for HostStateEventLog {
    fn default() -> Self {
        Self::new()
    }
}

impl HostStateEventLog {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(HOST_STATE_EVENT_LOG_CAPACITY);
        Self {
            sender,
            recent: Mutex::new(std::collections::VecDeque::new()),
        }
    }

    /// Retain then fan out. Ordering matters: a poller that subscribes between
    /// these two steps still finds the event in the ring.
    pub fn publish(&self, event: serde_json::Value) {
        {
            let mut recent = self.recent.lock();
            if recent.len() >= HOST_STATE_EVENT_LOG_CAPACITY {
                recent.pop_front();
            }
            recent.push_back(event.clone());
        }
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<serde_json::Value> {
        self.sender.subscribe()
    }

    /// Retained events with `hostSeq > after`, oldest first.
    pub fn replay_after(&self, after: u64) -> Vec<serde_json::Value> {
        self.recent
            .lock()
            .iter()
            .filter(|event| event_host_seq(event) > after)
            .cloned()
            .collect()
    }

    /// Oldest retained `hostSeq`; `None` when nothing has been published yet.
    pub fn oldest_host_seq(&self) -> Option<u64> {
        self.recent.lock().front().map(event_host_seq)
    }
}

#[derive(Clone)]
pub struct AgentEventRecord {
    pub cursor: u64,
    pub event: serde_json::Value,
}

struct AgentEventLogState {
    next_cursor: u64,
    recent: std::collections::VecDeque<AgentEventRecord>,
}

/// Bounded replay log for canonical Agent RPC envelopes.
///
/// Agent envelopes do not carry the HostState `hostSeq`, so the bridge assigns
/// a transport-local cursor. This prevents the CLI long-poll handoff from
/// losing bursts published between consecutive HTTP requests.
pub struct AgentEventLog {
    sender: broadcast::Sender<AgentEventRecord>,
    state: Mutex<AgentEventLogState>,
}

impl Default for AgentEventLog {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentEventLog {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(AGENT_EVENT_LOG_CAPACITY);
        Self {
            sender,
            state: Mutex::new(AgentEventLogState {
                next_cursor: 1,
                recent: std::collections::VecDeque::new(),
            }),
        }
    }

    pub fn publish(&self, event: serde_json::Value) -> u64 {
        let record = {
            let mut state = self.state.lock();
            let record = AgentEventRecord {
                cursor: state.next_cursor,
                event,
            };
            state.next_cursor = state.next_cursor.saturating_add(1);
            if state.recent.len() >= AGENT_EVENT_LOG_CAPACITY {
                state.recent.pop_front();
            }
            state.recent.push_back(record.clone());
            record
        };
        let _ = self.sender.send(record.clone());
        record.cursor
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEventRecord> {
        self.sender.subscribe()
    }

    pub fn replay_after(&self, after: u64) -> Vec<AgentEventRecord> {
        self.state
            .lock()
            .recent
            .iter()
            .filter(|record| record.cursor > after)
            .cloned()
            .collect()
    }

    pub fn oldest_cursor(&self) -> Option<u64> {
        self.state.lock().recent.front().map(|record| record.cursor)
    }
}

/// Per-launch state for the CLI bridge. Cloned into every axum handler
/// via `Arc`.
pub struct CliBridgeState {
    /// Random per-launch dev token (hex). Compared against the
    /// `X-Cognia-Dev-Token` header on every request.
    pub dev_token: String,
    /// AppHandle so handlers can reach into `PluginRuntimeState` and
    /// emit refresh events to the TS plugin manager.
    pub app_handle: tauri::AppHandle,
    /// Round-trip bridge for renderer-backed routes (twin context, agent
    /// teams). Shared with `CliBridgeServerState` so the
    /// `cli_bridge_renderer_response` Tauri command can resolve pending
    /// requests without reaching into the axum task.
    pub renderer: Arc<renderer_bridge::RendererBridge>,
    pub host_state_events: Arc<HostStateEventLog>,
    pub agent_events: Arc<AgentEventLog>,
}

pub type SharedState = Arc<CliBridgeState>;

/// Tauri-managed wrapper for the running bridge so `lib.rs::run` can
/// keep it alive for the app's lifetime.
pub struct CliBridgeServerState {
    inner: Mutex<Option<RunningBridge>>,
    /// Created eagerly (before `init`) so the `cli_bridge_renderer_response`
    /// command always has a target, even if the axum spawn failed.
    renderer: Arc<renderer_bridge::RendererBridge>,
    host_state_events: Arc<HostStateEventLog>,
    agent_events: Arc<AgentEventLog>,
}

struct RunningBridge {
    bound_port: u16,
    shutdown: watch::Sender<()>,
}

impl Default for CliBridgeServerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            renderer: renderer_bridge::RendererBridge::new(),
            host_state_events: Arc::new(HostStateEventLog::new()),
            agent_events: Arc::new(AgentEventLog::new()),
        }
    }
}

impl CliBridgeServerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bound_port(&self) -> Option<u16> {
        self.inner.lock().as_ref().map(|r| r.bound_port)
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }

    pub fn stop(&self) {
        if let Some(running) = self.inner.lock().take() {
            let _ = running.shutdown.send(());
        }
    }

    pub fn renderer(&self) -> Arc<renderer_bridge::RendererBridge> {
        self.renderer.clone()
    }

    pub fn host_state_events(&self) -> Arc<HostStateEventLog> {
        self.host_state_events.clone()
    }

    pub fn agent_events(&self) -> Arc<AgentEventLog> {
        self.agent_events.clone()
    }
}

/// Generate a fresh random hex dev token (32 bytes → 64 hex chars).
pub fn generate_dev_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    hex::encode(bytes)
}

/// Compute the endpoint-file path under the user's config directory.
pub fn endpoint_file_path() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.config_dir().join(ENDPOINT_FILE_REL))
}

/// Write `cli-endpoint.json` so the CLI can discover us. Best-effort —
/// failure is logged but does not abort app startup.
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub fn write_endpoint_file(path: &Path, base_url: &str, dev_token: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create dir {}", parent.display()))?;
    }
    let payload = serde_json::json!({
        "baseUrl": base_url,
        "devToken": dev_token,
    });
    let pretty = serde_json::to_vec_pretty(&payload)?;
    std::fs::write(path, &pretty).with_context(|| format!("write {}", path.display()))?;
    // Best-effort owner-only permissions on unix; on windows the ACL is
    // already restricted to the user's own profile directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        let _ = std::fs::set_permissions(path, perms);
    }
    Ok(())
}

/// Public entry called from `lib.rs::run`. Spawns the bridge on an
/// ephemeral loopback port, writes the endpoint file, and stores the
/// running handle in the state.
///
/// Failure to spawn is non-fatal — the rest of cognia continues to
/// boot. The CLI will simply return "no running cognia detected" until
/// the next launch.
#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
pub async fn init(app_handle: tauri::AppHandle, state: &CliBridgeServerState) -> Result<u16> {
    // Dev convenience: in debug builds, make a locally-built `cognia`
    // (dropped into the shared workspace target dir by `cargo build -p
    // cognia-cli`) detectable without a `cargo install`. No-op in release.
    detect::register_dev_build_dir();

    let dev_token = generate_dev_token();
    let shared = Arc::new(CliBridgeState {
        dev_token: dev_token.clone(),
        app_handle: app_handle.clone(),
        renderer: state.renderer(),
        host_state_events: state.host_state_events(),
        agent_events: state.agent_events(),
    });
    let (bound_port, shutdown) = server::spawn(shared)
        .await
        .context("spawn cli_bridge axum server")?;
    let base_url = format!("http://127.0.0.1:{bound_port}");
    if let Some(path) = endpoint_file_path() {
        if let Err(e) = write_endpoint_file(&path, &base_url, &dev_token) {
            log::warn!("cli_bridge endpoint file write failed: {e:#}");
        } else {
            log::info!(
                "cli_bridge ready at {base_url} (token persisted to {})",
                path.display()
            );
        }
    }
    {
        let mut guard = state.inner.lock();
        *guard = Some(RunningBridge {
            bound_port,
            shutdown,
        });
    }
    Ok(bound_port)
}

/// Check whether an incoming address is on the loopback interface.
pub fn is_loopback(addr: &SocketAddr) -> bool {
    addr.ip().is_loopback()
}

/// Diagnostic snapshot returned by [`cli_bridge_status`]. Mirrors the shape
/// the dev tooling and the Plugin DevTools panel render so a TS caller can
/// confirm the bridge is alive before assuming `cli-endpoint.json` is fresh.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBridgeStatus {
    pub running: bool,
    pub bound_port: Option<u16>,
    /// Absolute path of the discovery file when [`endpoint_file_path`] could
    /// be computed. The CLI uses the same path; we surface it for parity.
    pub endpoint_file: Option<String>,
}

/// IPC surface — return the current bridge state to the renderer.
/// Always available (even on mobile); on mobile the bridge is never spawned
/// so the response is `running: false`.
#[tauri::command]
pub fn cli_bridge_status(state: tauri::State<'_, CliBridgeServerState>) -> CliBridgeStatus {
    CliBridgeStatus {
        running: state.is_running(),
        bound_port: state.bound_port(),
        endpoint_file: endpoint_file_path().map(|p| p.display().to_string()),
    }
}

#[cfg(test)]
mod event_log_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_event_log_replays_bursts_after_cursor() {
        let log = AgentEventLog::new();
        assert_eq!(log.publish(json!({ "eventId": "a" })), 1);
        assert_eq!(log.publish(json!({ "eventId": "b" })), 2);

        let replay = log.replay_after(1);
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].cursor, 2);
        assert_eq!(replay[0].event["eventId"], "b");
    }

    #[test]
    fn extracts_only_the_canonical_agent_envelope() {
        let payload = json!({
            "type": "agent_event",
            "sessionId": "session-a",
            "envelope": { "eventId": "event-a" }
        });
        assert_eq!(
            canonical_agent_envelope(&payload),
            Some(json!({ "eventId": "event-a" }))
        );
        assert_eq!(
            canonical_agent_envelope(&json!({ "type": "agent_event" })),
            None
        );
    }
}

/// IPC surface — resolve a pending renderer-backed CLI bridge request. The
/// renderer's `cli-bridge://renderer-request` listener calls this with the
/// request id + result/error; unknown ids are a no-op (the request may have
/// timed out on the Rust side already).
#[tauri::command]
pub fn cli_bridge_renderer_response(
    state: tauri::State<'_, CliBridgeServerState>,
    response: renderer_bridge::RendererResponse,
) {
    state.renderer.resolve(response);
}

#[tauri::command]
pub fn cli_bridge_host_state_publish(
    state: tauri::State<'_, CliBridgeServerState>,
    event: serde_json::Value,
) {
    state.host_state_events.publish(event);
}

/// IPC surface — resolve the cognia CLI home (`$COGNIA_HOME` or `~/.cognia`)
/// as an absolute string so the renderer's desktop→CLI push writers target
/// the exact directory the standalone CLI reads. `None` when no home dir is
/// resolvable (and on web/Capacitor, where this command isn't reachable).
#[tauri::command]
pub fn resolve_cli_home() -> Option<String> {
    crate::agents::paths::cognia_home().map(|p| p.to_string_lossy().into_owned())
}

/// Validate that `file_name` is a bare filename (no separators / `..`) so a
/// CLI-home write can never escape the home directory.
fn is_safe_cli_file_name(file_name: &str) -> bool {
    !file_name.is_empty()
        && !file_name.contains('/')
        && !file_name.contains('\\')
        && !file_name.contains("..")
}

/// IPC surface — write a file directly into the cognia CLI home
/// (`<home>/<file_name>`), creating the home dir if absent. Only a bare
/// filename is accepted, so the write is structurally confined to the home —
/// no `..` / absolute-path escape is possible. When `secret` is true the file
/// is given owner-only (0600) perms on unix (the same posture the CLI uses for
/// `credentials.json`; a no-op on Windows, where the profile ACL already
/// restricts access). Used by the desktop→CLI config / credentials / history
/// push.
#[tauri::command]
pub fn write_cli_home_file(file_name: String, content: String, secret: bool) -> Result<(), String> {
    if !is_safe_cli_file_name(&file_name) {
        return Err(format!("invalid CLI file name: {file_name}"));
    }
    let home =
        crate::agents::paths::cognia_home().ok_or_else(|| "cannot resolve CLI home".to_string())?;
    std::fs::create_dir_all(&home).map_err(|e| format!("mkdir cli home: {e}"))?;
    let target = home.join(&file_name);
    std::fs::write(&target, content.as_bytes())
        .map_err(|e| format!("write {}: {e}", target.display()))?;
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&target) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = std::fs::set_permissions(&target, perms);
        }
    }
    let _ = secret;
    Ok(())
}

/// Receipt returned to the renderer after a successful "Load unpacked"
/// install. Mirrors the shape of the bridge's HTTP `OkResponse` so the
/// TS layer can use one envelope across both surfaces.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallReceipt {
    pub plugin_id: String,
    pub warnings: Vec<String>,
}

/// IPC surface — read and parse `plugin.json` at `<source>/plugin.json`
/// without installing it. Used by the "Load unpacked" UI to preview the
/// permissions and capabilities before the user approves the install,
/// and by the offline manifest validator panel.
#[tauri::command]
pub async fn preview_local_manifest(source_dir: String) -> Result<serde_json::Value, String> {
    use std::path::PathBuf;
    let source = PathBuf::from(&source_dir);
    if !source.is_absolute() {
        return Err("source_dir must be absolute".to_string());
    }
    if !source.exists() {
        return Err(format!(
            "source directory not found at {}",
            source.display()
        ));
    }
    let manifest_path = if source.is_dir() {
        source.join("plugin.json")
    } else {
        // Allow passing the plugin.json directly (the validator panel
        // surface lets the user drop a single file in).
        source.clone()
    };
    if !manifest_path.exists() {
        return Err(format!(
            "plugin.json not found at {}",
            manifest_path.display()
        ));
    }
    let bytes = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid plugin.json: {e}"))?;
    Ok(parsed)
}

/// IPC surface — install a plugin from an on-disk directory containing
/// `plugin.json`. Used by the "Load unpacked" UI in DevTools. Emits the
/// same `cli-bridge:plugin-installed` event as the loopback HTTP bridge
/// so the renderer's bridge-events hook picks it up without branching.
#[tauri::command]
pub async fn plugin_install_from_directory(
    app: tauri::AppHandle,
    source_dir: String,
) -> Result<PluginInstallReceipt, String> {
    use tauri::Emitter;
    match handlers::install_from_directory_inner(&app, &source_dir).await {
        Ok((plugin_id, warnings)) => {
            let _ = app.emit(
                "cli-bridge:plugin-installed",
                serde_json::json!({ "plugin_id": plugin_id }),
            );
            Ok(PluginInstallReceipt {
                plugin_id,
                warnings,
            })
        }
        Err(err) => {
            log::warn!("plugin_install_from_directory failed: {err:#}");
            Err(err.to_string())
        }
    }
}

/// Trigger a graceful shutdown of the axum task. Idempotent — safe to call
/// from the `RunEvent::Exit` hook in `lib.rs::run` so the listener releases
/// its socket before the process tears down its tokio runtime.
pub fn shutdown(state: &CliBridgeServerState) {
    state.stop();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn generate_dev_token_is_64_hex_chars() {
        let t = generate_dev_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn two_tokens_differ() {
        let a = generate_dev_token();
        let b = generate_dev_token();
        assert_ne!(a, b);
    }

    #[test]
    fn is_loopback_matches_ipv4_and_ipv6_localhost() {
        let v4 = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 7890);
        let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 7890);
        let public = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 53);
        assert!(is_loopback(&v4));
        assert!(is_loopback(&v6));
        assert!(!is_loopback(&public));
    }

    #[test]
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    fn write_endpoint_file_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cli-endpoint.json");
        write_endpoint_file(&path, "http://127.0.0.1:42", "abc123").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            parsed["baseUrl"],
            serde_json::Value::String("http://127.0.0.1:42".into())
        );
        assert_eq!(
            parsed["devToken"],
            serde_json::Value::String("abc123".into())
        );
    }

    #[test]
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    fn write_endpoint_file_creates_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp
            .path()
            .join("nested")
            .join("dir")
            .join("cli-endpoint.json");
        write_endpoint_file(&path, "http://x", "tok").unwrap();
        assert!(path.exists());
    }

    #[test]
    fn endpoint_file_path_includes_cognia_subdir() {
        if let Some(p) = endpoint_file_path() {
            let s = p.to_string_lossy().to_string();
            assert!(s.contains("cognia"));
            assert!(s.ends_with("cli-endpoint.json"));
        }
        // BaseDirs may legitimately be None on some CI; not an error.
    }

    #[test]
    fn bridge_server_state_starts_empty() {
        let st = CliBridgeServerState::new();
        assert!(!st.is_running());
        assert_eq!(st.bound_port(), None);
    }

    #[test]
    fn shutdown_on_empty_state_is_noop() {
        // `shutdown` must be safe to call even when the bridge was never
        // started — used by the RunEvent::Exit hook regardless of whether
        // the spawn task succeeded.
        let st = CliBridgeServerState::new();
        shutdown(&st);
        assert!(!st.is_running());
    }

    #[test]
    fn safe_cli_file_name_accepts_bare_names() {
        assert!(is_safe_cli_file_name("credentials.json"));
        assert!(is_safe_cli_file_name("config.json"));
        assert!(is_safe_cli_file_name("history.json"));
    }

    #[test]
    fn safe_cli_file_name_rejects_separators_and_traversal() {
        assert!(!is_safe_cli_file_name(""));
        assert!(!is_safe_cli_file_name("../escape.json"));
        assert!(!is_safe_cli_file_name("sub/dir.json"));
        assert!(!is_safe_cli_file_name("sub\\dir.json"));
        assert!(!is_safe_cli_file_name(".."));
    }

    #[test]
    fn cli_bridge_status_reports_idle_state() {
        // Verify the shape of the snapshot returned to the renderer before
        // `init` runs. `endpoint_file` may be `None` in CI containers that
        // lack a config dir; either branch is acceptable.
        let st = CliBridgeServerState::new();
        let snap = CliBridgeStatus {
            running: st.is_running(),
            bound_port: st.bound_port(),
            endpoint_file: endpoint_file_path().map(|p| p.display().to_string()),
        };
        assert!(!snap.running);
        assert_eq!(snap.bound_port, None);
    }
}
