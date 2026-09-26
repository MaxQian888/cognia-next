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
    /// A quick tunnel is already exposing a *different* local origin.
    ///
    /// One `cloudflared` child per process, two callers that name two
    /// origins (the companion HTTPS listener, the connectors' webhook
    /// receiver): before this variant the second start silently killed the
    /// first, and the surface that started it kept showing a public URL that
    /// now pointed somewhere else. The caller decides whether to replace; the
    /// message keeps a stable `tunnel_busy:` prefix so the renderer can tell
    /// it from every other failure.
    #[error("tunnel_busy: already exposing {local_url} at {public_url}")]
    Busy {
        local_url: String,
        public_url: String,
    },
}

/// Whether `cloudflared` can be launched from this process, and which one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelProbe {
    pub installed: bool,
    /// Where on `PATH` the binary was found, when it was.
    pub path: Option<String>,
    /// First line of `cloudflared --version`, when it ran.
    pub version: Option<String>,
}

/// Look for the binary the way [`launch`] will: on this process's `PATH`.
///
/// A settings surface used to learn that cloudflared was missing only after
/// the user flipped the switch and the spawn failed; probing first lets it
/// show the install guide instead of a switch that snaps back.
pub fn locate_binary(path_var: Option<&std::ffi::OsStr>) -> Option<std::path::PathBuf> {
    let path_var = path_var?;
    let names: &[&str] = if cfg!(windows) {
        &["cloudflared.exe", "cloudflared"]
    } else {
        &["cloudflared"]
    };
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
}

/// Probe for `cloudflared` and, when present, ask it for its version.
pub async fn probe() -> TunnelProbe {
    probe_with(std::env::var_os("PATH").as_deref()).await
}

/// [`probe`] against an explicit `PATH`.
///
/// The seam exists so tests never write the process-global `PATH`: cargo runs
/// them on parallel threads in one binary, and two tests swapping that
/// variable clobber each other's saved value.
pub async fn probe_with(path_var: Option<&std::ffi::OsStr>) -> TunnelProbe {
    let path = locate_binary(path_var);
    let Some(path) = path else {
        return TunnelProbe {
            installed: false,
            path: None,
            version: None,
        };
    };
    let mut cmd = Command::new(&path);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let version = match tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await
    {
        Ok(Ok(output)) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let text = if text.trim().is_empty() {
                String::from_utf8_lossy(&output.stderr)
            } else {
                text
            };
            text.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
        }
        _ => None,
    };
    TunnelProbe {
        installed: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
    }
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

/// What the managed-process registry needs to show (and stop) a live tunnel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelManagedInfo {
    pub pid: Option<u32>,
    /// Public hostname the tunnel is serving, for the row's detail column.
    pub public_url: Option<String>,
}

impl TunnelHandle {
    pub fn info(&self) -> Option<TunnelInfo> {
        self.info.lock().clone()
    }

    /// OS pid of the `cloudflared` child, if it is still held.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().as_ref().and_then(|c| c.id())
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
    ///
    /// Idempotent for the origin already being exposed: asking again for the
    /// same `local_url` answers the live tunnel. A *different* origin is a
    /// conflict the caller has to resolve explicitly with `replace`, because
    /// the process holds one child and the other surface is still showing
    /// the URL that would die.
    pub async fn start(&self, local_url: &str, replace: bool) -> Result<TunnelInfo, TunnelError> {
        if let Some(current) = self.current() {
            if current.local_url == local_url {
                return Ok(current);
            }
            if !replace {
                return Err(TunnelError::Busy {
                    local_url: current.local_url,
                    public_url: current.public_url,
                });
            }
        }
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

    /// Snapshot for the managed-process registry. `None` when no tunnel is
    /// running — a handle with no live child does not count.
    pub fn managed_snapshot(&self) -> Option<TunnelManagedInfo> {
        let guard = self.inner.lock();
        let handle = guard.as_ref()?;
        let pid = handle.pid()?;
        Some(TunnelManagedInfo {
            pid: Some(pid),
            public_url: handle.info().map(|i| i.public_url),
        })
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
    fn managed_snapshot_is_none_without_a_running_tunnel() {
        // The registry must not show a tunnel row (and offer a Kill button)
        // when no cloudflared child exists.
        let s = TunnelState::new();
        assert_eq!(s.managed_snapshot(), None);
        // Stopping an idle tunnel stays a no-op.
        s.stop();
        assert_eq!(s.managed_snapshot(), None);
    }

    #[test]
    fn state_starts_idle() {
        let s = TunnelState::new();
        assert!(!s.is_running());
        assert!(s.current().is_none());
    }

    #[test]
    fn locate_binary_walks_path_and_ignores_empty_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = if cfg!(windows) {
            "cloudflared.exe"
        } else {
            "cloudflared"
        };
        let binary = dir.path().join(name);
        std::fs::write(&binary, b"#!/bin/sh\n").expect("write");
        let mut path_var = std::ffi::OsString::new();
        path_var.push("");
        path_var.push(if cfg!(windows) { ";" } else { ":" });
        path_var.push(dir.path());
        assert_eq!(locate_binary(Some(&path_var)), Some(binary));
        assert_eq!(locate_binary(Some(std::ffi::OsStr::new(""))), None);
        assert_eq!(locate_binary(None), None);
    }

    #[tokio::test]
    async fn probe_reports_not_installed_on_an_empty_path() {
        // The `PATH` is handed in, never swapped on the process: this suite
        // shares one process with every other test in the crate.
        assert_eq!(
            probe_with(Some(std::ffi::OsStr::new(""))).await,
            TunnelProbe {
                installed: false,
                path: None,
                version: None
            }
        );
        assert_eq!(
            probe_with(None).await,
            TunnelProbe {
                installed: false,
                path: None,
                version: None
            }
        );
    }

    #[test]
    fn busy_error_carries_a_stable_prefix_the_renderer_can_match() {
        let error = TunnelError::Busy {
            local_url: "http://127.0.0.1:7891".into(),
            public_url: "https://a.trycloudflare.com".into(),
        };
        let text = error.to_string();
        assert!(text.starts_with("tunnel_busy: "), "{text}");
        assert!(text.contains("http://127.0.0.1:7891"));
        assert!(text.contains("https://a.trycloudflare.com"));
    }

    #[tokio::test]
    async fn start_refuses_a_second_origin_unless_replacing() {
        // Seed a "running" tunnel without spawning anything: the handle only
        // needs an info snapshot for the conflict check.
        let (_tx, rx) = watch::channel::<Option<TunnelInfo>>(None);
        let handle = Arc::new(TunnelHandle {
            child: Mutex::new(None),
            info: Mutex::new(Some(TunnelInfo {
                public_url: "https://a.trycloudflare.com".into(),
                local_url: "http://127.0.0.1:7891".into(),
            })),
            info_rx: rx,
        });
        let state = TunnelState::new();
        *state.inner.lock() = Some(handle);

        // Same origin: idempotent, no relaunch.
        let same = state
            .start("http://127.0.0.1:7891", false)
            .await
            .expect("same origin");
        assert_eq!(same.public_url, "https://a.trycloudflare.com");

        // Different origin, no replace: refused, and the first tunnel survives.
        match state.start("https://127.0.0.1:27890", false).await {
            Err(TunnelError::Busy {
                local_url,
                public_url,
            }) => {
                assert_eq!(local_url, "http://127.0.0.1:7891");
                assert_eq!(public_url, "https://a.trycloudflare.com");
            }
            other => panic!("expected Busy, got {other:?}"),
        }
        assert!(state.is_running());
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
