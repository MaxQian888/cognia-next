//! CLI Bridge — loopback-only HTTP server for `cognia-cli` to drive a
//! running cognia desktop instance.
//!
//! # Why a separate listener?
//!
//! The companion_api (port 7890) is designed for paired mobile devices:
//! HTTPS, JWT-protected, LAN-accessible. The CLI bridge is for the
//! developer's own machine: loopback-only, plain HTTP, dev-token gated.
//! Keeping them on separate ports lets each carry the auth model
//! appropriate to its threat model without leaking semantics into the
//! other.
//!
//! # Endpoints
//!
//! - `POST /api/v1/dev/plugins/install`   — install a `.zip` bundle from disk
//! - `POST /api/v1/dev/plugins/uninstall` — remove a plugin by id
//! - `POST /api/v1/dev/plugins/reload`    — re-install (if bundle path given)
//!                                          or emit a hot-reload event
//! - `GET  /api/v1/dev/health`            — liveness probe
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

pub mod handlers;
pub mod server;

use ::anyhow::{Context, Result};
use parking_lot::Mutex;
use rand::RngCore;
use serde::Serialize;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::watch;

/// Path inside the cognia config dir for the endpoint discovery file.
pub const ENDPOINT_FILE_REL: &str = "cognia/cli-endpoint.json";

/// Per-launch state for the CLI bridge. Cloned into every axum handler
/// via `Arc`.
pub struct CliBridgeState {
    /// Random per-launch dev token (hex). Compared against the
    /// `X-Cognia-Dev-Token` header on every request.
    pub dev_token: String,
    /// AppHandle so handlers can reach into `PluginRuntimeState` and
    /// emit refresh events to the TS plugin manager.
    pub app_handle: tauri::AppHandle,
}

pub type SharedState = Arc<CliBridgeState>;

/// Tauri-managed wrapper for the running bridge so `lib.rs::run` can
/// keep it alive for the app's lifetime.
pub struct CliBridgeServerState {
    inner: Mutex<Option<RunningBridge>>,
}

struct RunningBridge {
    bound_port: u16,
    shutdown: watch::Sender<()>,
}

impl Default for CliBridgeServerState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
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
}

/// Generate a fresh random hex dev token (32 bytes → 64 hex chars).
pub fn generate_dev_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Compute the endpoint-file path under the user's config directory.
pub fn endpoint_file_path() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.config_dir().join(ENDPOINT_FILE_REL))
}

/// Write `cli-endpoint.json` so the CLI can discover us. Best-effort —
/// failure is logged but does not abort app startup.
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
pub async fn init(
    app_handle: tauri::AppHandle,
    state: &CliBridgeServerState,
) -> Result<u16> {
    let dev_token = generate_dev_token();
    let shared = Arc::new(CliBridgeState {
        dev_token: dev_token.clone(),
        app_handle: app_handle.clone(),
    });
    let (bound_port, shutdown) =
        server::spawn(shared).await.context("spawn cli_bridge axum server")?;
    let base_url = format!("http://127.0.0.1:{bound_port}");
    if let Some(path) = endpoint_file_path() {
        if let Err(e) = write_endpoint_file(&path, &base_url, &dev_token) {
            log::warn!("cli_bridge endpoint file write failed: {e:#}");
        } else {
            log::info!("cli_bridge ready at {base_url} (token persisted to {})", path.display());
        }
    }
    {
        let mut guard = state.inner.lock();
        *guard = Some(RunningBridge { bound_port, shutdown });
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
    fn write_endpoint_file_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("cli-endpoint.json");
        write_endpoint_file(&path, "http://127.0.0.1:42", "abc123").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["baseUrl"], serde_json::Value::String("http://127.0.0.1:42".into()));
        assert_eq!(parsed["devToken"], serde_json::Value::String("abc123".into()));
    }

    #[test]
    fn write_endpoint_file_creates_parent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("dir").join("cli-endpoint.json");
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
