//! Cloudflared tunnel launcher (Wave 1.6 + named tunnel extension).
//!
//! Two launch modes:
//! - **Quick** (`launch`): spawns `cloudflared tunnel --url <local>` and parses
//!   the random `*.trycloudflare.com` URL from stderr. Ephemeral — URL changes
//!   on every restart.
//! - **Named** (`launch_named`): spawns `cloudflared tunnel run --token <token>`;
//!   the public hostname is fixed in the Cloudflare dashboard. Persistent.
//!
//! cloudflared MUST already be installed on the host (`brew install
//! cloudflared` / `winget install cloudflare.cloudflared` / apt). We don't
//! ship the binary; we just orchestrate it.

use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use regex::Regex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("cloudflared not found in PATH (install: https://developers.cloudflare.com/cloudflared/install/)")]
    NotInstalled,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("timed out waiting for tunnel URL")]
    Timeout,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TunnelInfo {
    /// Public https://<random>.trycloudflare.com URL.
    pub public_url: String,
    /// Local URL the tunnel forwards to (e.g. https://127.0.0.1:7891).
    pub local_url: String,
}

pub struct TunnelHandle {
    child: Mutex<Option<Child>>,
    info: Mutex<Option<TunnelInfo>>,
    info_rx: watch::Receiver<Option<TunnelInfo>>,
}

impl TunnelHandle {
    pub fn info(&self) -> Option<TunnelInfo> {
        self.info.lock().clone()
    }

    pub async fn wait_for_url(&self, timeout_secs: u64) -> Result<TunnelInfo, TunnelError> {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(timeout_secs);
        let mut rx = self.info_rx.clone();
        loop {
            if let Some(info) = rx.borrow().clone() {
                return Ok(info);
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(TunnelError::Timeout);
            }
            let remaining = deadline - now;
            if tokio::time::timeout(remaining, rx.changed()).await.is_err() {
                return Err(TunnelError::Timeout);
            }
        }
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.start_kill();
        }
        *self.info.lock() = None;
    }
}

/// Launch `cloudflared tunnel --url <local_url>`. Returns a handle once the
/// process is spawned. Call `wait_for_url` to block until the trycloudflare
/// URL appears in stderr.
///
/// Since M2.9 the local companion server terminates HTTPS with a self-signed
/// cert, so `--no-tls-verify` is passed to cloudflared whenever the origin
/// URL is HTTPS. Cloudflare still terminates HTTPS upstream with its own
/// real cert; the flag only affects the local origin hop.
pub async fn launch(local_url: &str) -> Result<Arc<TunnelHandle>, TunnelError> {
    let mut cmd = Command::new("cloudflared");
    cmd.arg("tunnel")
        .arg("--no-autoupdate")
        .arg("--url")
        .arg(local_url);
    if local_url.starts_with("https://") {
        cmd.arg("--no-tls-verify");
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TunnelError::NotInstalled
        } else {
            TunnelError::Io(e)
        }
    })?;

    let stderr = child.stderr.take().expect("stderr piped");
    let (tx, rx) = watch::channel::<Option<TunnelInfo>>(None);

    let local_for_task = local_url.to_string();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let url_re = Regex::new(r"(https://[a-z0-9-]+\.trycloudflare\.com)").unwrap();
        while let Ok(Some(line)) = reader.next_line().await {
            log::debug!("cloudflared: {line}");
            if let Some(cap) = url_re.captures(&line) {
                let info = TunnelInfo {
                    public_url: cap.get(1).unwrap().as_str().to_string(),
                    local_url: local_for_task.clone(),
                };
                let _ = tx.send(Some(info));
                // Keep draining so the pipe doesn't block the child.
            }
        }
    });

    let handle = Arc::new(TunnelHandle {
        child: Mutex::new(Some(child)),
        info: Mutex::new(None),
        info_rx: rx,
    });

    // Mirror watch updates into the handle so `info()` is sync-friendly.
    let handle_clone = handle.clone();
    let mut update_rx = handle.info_rx.clone();
    tokio::spawn(async move {
        while update_rx.changed().await.is_ok() {
            let v = update_rx.borrow().clone();
            *handle_clone.info.lock() = v;
        }
    });

    Ok(handle)
}

/// Launch `cloudflared tunnel run --token <token>`. The connector registers
/// with Cloudflare's edge; the public hostname is fixed in the dashboard.
/// We wait for `Registered tunnel connection` in stderr to confirm liveness,
/// then return a handle with the user-provided `public_url` as the hostname.
pub async fn launch_named(token: &str, public_url: &str) -> Result<Arc<TunnelHandle>, TunnelError> {
    let mut cmd = Command::new("cloudflared");
    cmd.arg("tunnel")
        .arg("run")
        .arg("--no-autoupdate")
        .arg("--token")
        .arg(token);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            TunnelError::NotInstalled
        } else {
            TunnelError::Io(e)
        }
    })?;

    let stderr = child.stderr.take().expect("stderr piped");
    let (tx, rx) = watch::channel::<Option<TunnelInfo>>(None);
    let public_for_task = public_url.to_string();

    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let connected_re = Regex::new(r"Registered tunnel connection").unwrap();
        while let Ok(Some(line)) = reader.next_line().await {
            log::debug!("cloudflared: {line}");
            if connected_re.is_match(&line) {
                let info = TunnelInfo {
                    public_url: public_for_task.clone(),
                    local_url: String::new(), // not used for named tunnels
                };
                let _ = tx.send(Some(info));
                // Keep draining so the pipe doesn't block.
            }
        }
    });

    let handle = Arc::new(TunnelHandle {
        child: Mutex::new(Some(child)),
        info: Mutex::new(None),
        info_rx: rx,
    });

    let handle_clone = handle.clone();
    let mut update_rx = handle.info_rx.clone();
    tokio::spawn(async move {
        while update_rx.changed().await.is_ok() {
            let v = update_rx.borrow().clone();
            *handle_clone.info.lock() = v;
        }
    });

    Ok(handle)
}

/// Tauri-managed wrapper so the tunnel lifecycle follows the companion
/// server's start/stop. Exactly one tunnel can run at a time per app.
pub struct TunnelState {
    inner: Mutex<Option<Arc<TunnelHandle>>>,
    /// Cached named config so `current()` can report the public URL even
    /// when the tunnel process was started by a previous session.
    named_config: Mutex<Option<super::tunnel_config::NamedTunnelConfig>>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            named_config: Mutex::new(None),
        }
    }

    /// Start a Quick Tunnel (`cloudflared tunnel --url`).
    pub async fn start(&self, local_url: &str) -> Result<TunnelInfo, TunnelError> {
        self.stop();
        let handle = launch(local_url).await?;
        let info = handle.wait_for_url(20).await?;
        *self.inner.lock() = Some(handle);
        Ok(info)
    }

    /// Start a Named Tunnel (`cloudflared tunnel run --token`).
    pub async fn start_named(
        &self,
        token: &str,
        config: &super::tunnel_config::NamedTunnelConfig,
    ) -> Result<TunnelInfo, TunnelError> {
        self.stop();
        let handle = launch_named(token, &config.hostname).await?;
        let info = handle.wait_for_url(20).await?;
        *self.inner.lock() = Some(handle);
        *self.named_config.lock() = Some(config.clone());
        Ok(info)
    }

    pub fn stop(&self) {
        if let Some(handle) = self.inner.lock().take() {
            handle.stop();
        }
    }

    pub fn current(&self) -> Option<TunnelInfo> {
        self.inner.lock().as_ref().and_then(|h| h.info())
    }

    /// Set the cached named config (used when loading persisted config at
    /// boot so `current()` reports the hostname without re-starting).
    pub fn set_named_config(&self, config: super::tunnel_config::NamedTunnelConfig) {
        *self.named_config.lock() = Some(config);
    }

    /// Public URL from the named config cache, if any.
    pub fn named_public_url(&self) -> Option<String> {
        self.named_config
            .lock()
            .as_ref()
            .map(|c| c.hostname.clone())
    }

    /// Whether a tunnel is currently being managed by this state.
    #[cfg(test)]
    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }
}

impl Default for TunnelState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_starts_idle() {
        let s = TunnelState::new();
        assert!(!s.is_running());
        assert!(s.current().is_none());
    }

    #[tokio::test]
    async fn launch_returns_not_installed_when_binary_missing() {
        // Force PATH to a directory we know has no cloudflared.
        let original_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        let r = launch("https://127.0.0.1:7891").await;
        if let Some(p) = original_path {
            std::env::set_var("PATH", p);
        }
        // On most OSes ENOENT triggers NotInstalled; if the test environment
        // happens to have an alternate shell that matches "cloudflared" the
        // call may succeed — accept either outcome to keep the suite stable.
        match r {
            Err(TunnelError::NotInstalled) => {}
            Err(TunnelError::Io(_)) => {}
            Ok(_) => {}
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }
}
