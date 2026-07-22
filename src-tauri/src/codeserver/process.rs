//! code-server process lifecycle for the optional desktop "Pro IDE" mode.
//!
//! One code-server child per canonical project root, bound to a loopback
//! ephemeral port with auth disabled (only reachable from this machine). The
//! child is health-polled on `/healthz` before we report a port, so the
//! frontend never navigates the embedded webview at a not-yet-serving port.
//!
//! `CodeServerState` is a Tauri managed state; its children are `kill_on_drop`,
//! so app exit tears them down even without an explicit stop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::download;

/// Emitted when a healthy instance stops answering `/healthz`, so the pane can
/// leave `ready` instead of sitting on a dead page.
pub const CODESERVER_EXITED_EVENT: &str = "codeserver://instance-exited";

/// How often the watchdog probes a healthy instance.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
/// Consecutive probe failures before we declare the instance gone.
const WATCHDOG_FAILURES: u8 = 2;

/// Payload of [`CODESERVER_EXITED_EVENT`]. `port` is the match key the frontend
/// uses — it already knows the port it navigated to, whereas its `root` string
/// may not be spelled the same way as our canonicalized one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerExited {
    pub root: String,
    pub port: u16,
}

/// A live code-server instance for one project root.
struct RunningInstance {
    port: u16,
    child: Child,
    binary_path: String,
    user_data_dir: PathBuf,
    extensions_dir: PathBuf,
    /// Set by the health watchdog once this instance has stopped answering
    /// `/healthz`. Shared with the watchdog task so it can report without
    /// holding a reference back to [`CodeServerState`].
    unhealthy: Arc<AtomicBool>,
    /// Health watchdog for this instance. Always aborted when the instance is
    /// retired: a detached poll loop would outlive its process and hang
    /// `cargo test`.
    watchdog: Option<tokio::task::JoinHandle<()>>,
}

impl RunningInstance {
    /// Whether the child is still running (has not exited).
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Whether this instance may still be handed out to a caller.
    ///
    /// Liveness alone is not enough. The failure mode the watchdog exists to
    /// catch is a child that is *alive but no longer serving* — the "dead page".
    /// Re-adopting that child is what made the pane's retry button useless: it
    /// asked for a port, got the hung instance's port back, and flipped straight
    /// to `ready` over the same dead page. Once the watchdog has given up on an
    /// instance it is never reusable again, so every entry point (retry, a fresh
    /// pane mount, the second host, agent file-open) tears it down and respawns.
    fn is_reusable(&mut self) -> bool {
        self.is_alive() && !self.unhealthy.load(Ordering::Relaxed)
    }

    /// Stop supervising this instance (does not kill the child).
    fn stop_watchdog(&mut self) {
        if let Some(handle) = self.watchdog.take() {
            handle.abort();
        }
    }

    /// Stop supervising **and** kill the child. The single teardown primitive:
    /// explicit stop, kill-switch, and the unhealthy-instance eviction below all
    /// go through it so there is only one way an instance dies.
    fn retire(&mut self) {
        self.stop_watchdog();
        let _ = self.child.start_kill();
    }
}

/// Tauri managed state: the registry of running code-server instances plus an
/// operation lock that serializes installs, spawns, downloads, and uninstalls.
/// All four touch the same pinned install tree, so none may race another.
#[derive(Default)]
pub struct CodeServerState {
    instances: Mutex<HashMap<String, RunningInstance>>,
    operation_lock: Mutex<()>,
}

impl CodeServerState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Status for a project root: `(running, port)`.
    pub async fn status(&self, root: &str) -> (bool, Option<u16>) {
        let canonical = canonicalize_root(root).unwrap_or_else(|_| root.to_string());
        let mut map = self.instances.lock().await;
        if let Some(inst) = map.get_mut(&canonical) {
            if inst.is_reusable() {
                return (true, Some(inst.port));
            }
            inst.retire();
            map.remove(&canonical);
        }
        (false, None)
    }

    /// Ensure a healthy code-server is serving `root`, returning its loopback
    /// port. Downloads + installs code-server on first use.
    pub async fn ensure(&self, app: &tauri::AppHandle, root: &str) -> Result<u16, String> {
        let canonical = canonicalize_root(root)?;

        // Fast path: an already-healthy instance for this root.
        if let Some(port) = self.live_port(&canonical).await {
            return Ok(port);
        }

        // Serialize install + spawn across all roots.
        let _guard = self.operation_lock.lock().await;
        // Re-check under the lock — another caller may have just spawned it.
        if let Some(port) = self.live_port(&canonical).await {
            return Ok(port);
        }

        let info = download::ensure_code_server(app)
            .await
            .map_err(|e| format!("install code-server: {e:#}"))?;

        let user_data_dir = state_subdir(app, "user-data")?;
        let extensions_dir = state_subdir(app, "extensions")?;
        let port = pick_free_loopback_port()?;
        let args = code_server_args(&canonical, port, &user_data_dir, &extensions_dir);

        let child = spawn_child(&info.binary_path, &args)?;
        // Track it immediately so kill_on_drop / stop cover a child that never
        // becomes healthy.
        {
            let mut map = self.instances.lock().await;
            map.insert(
                canonical.clone(),
                RunningInstance {
                    port,
                    child,
                    binary_path: info.binary_path,
                    user_data_dir,
                    extensions_dir,
                    unhealthy: Arc::new(AtomicBool::new(false)),
                    watchdog: None,
                },
            );
        }

        match wait_healthy(port, Duration::from_secs(30)).await {
            Ok(()) => {
                // Supervise only once healthy — before that `wait_healthy` owns
                // the liveness question.
                let mut map = self.instances.lock().await;
                if let Some(inst) = map.get_mut(&canonical) {
                    inst.stop_watchdog();
                    let flag = inst.unhealthy.clone();
                    inst.watchdog =
                        Some(spawn_watchdog(app.clone(), canonical.clone(), port, flag));
                }
                Ok(port)
            }
            Err(e) => {
                self.stop(&canonical).await;
                Err(e)
            }
        }
    }

    /// Liveness snapshot for the unified managed-process registry
    /// (`crate::process_registry`). Dead children are pruned on the way past so
    /// the perf panel never lists a code-server that already exited.
    pub async fn managed_snapshot(&self) -> Vec<CodeServerManagedInfo> {
        let mut map = self.instances.lock().await;
        map.retain(|_, inst| {
            if inst.is_reusable() {
                return true;
            }
            inst.retire();
            false
        });
        map.iter()
            .map(|(root, inst)| CodeServerManagedInfo {
                root: root.clone(),
                port: inst.port,
                pid: inst.child.id(),
            })
            .collect()
    }

    /// Install the pinned code-server without spawning it. Serialized with
    /// ensure/uninstall so the shared partial archive and install tree cannot
    /// be concurrently replaced or deleted.
    pub async fn download(&self, app: &tauri::AppHandle) -> Result<download::InstallInfo, String> {
        let _guard = self.operation_lock.lock().await;
        download::ensure_code_server(app)
            .await
            .map_err(|e| format!("{e:#}"))
    }

    /// Stop all children and reclaim code-server files as one serialized
    /// operation. Holding the lock through deletion prevents an overlapping
    /// ensure/download from recreating or reading a half-removed tree.
    pub async fn uninstall(&self, app: tauri::AppHandle, everything: bool) -> Result<u64, String> {
        let _guard = self.operation_lock.lock().await;
        self.stop_all().await;
        tokio::task::spawn_blocking(move || {
            download::uninstall(&app, everything).map_err(|e| format!("{e:#}"))
        })
        .await
        .map_err(|e| format!("code-server uninstall task: {e}"))?
    }

    /// Kill + forget the instance for a root (canonical or raw). No-op if none.
    pub async fn stop(&self, root: &str) -> bool {
        let canonical = canonicalize_root(root).unwrap_or_else(|_| root.to_string());
        let mut map = self.instances.lock().await;
        if let Some(mut inst) = map.remove(&canonical) {
            inst.retire();
            true
        } else {
            false
        }
    }

    /// Kill every running instance (app teardown / kill-switch).
    pub async fn stop_all(&self) {
        let mut map = self.instances.lock().await;
        for (_, mut inst) in map.drain() {
            inst.retire();
        }
    }

    /// Open and reveal a project-relative file in this root's existing browser
    /// VS Code window through code-server's own session-socket CLI bridge.
    pub async fn open_file(
        &self,
        root: &str,
        relative_path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String> {
        let root = root.to_string();
        let relative_path = relative_path.to_string();
        let (canonical, target) = tokio::task::spawn_blocking(move || {
            let canonical = canonicalize_root(&root)?;
            let target = resolve_open_target(Path::new(&canonical), &relative_path, line, column)?;
            Ok::<_, String>((canonical, target))
        })
        .await
        .map_err(|e| format!("resolve code-server file task: {e}"))??;
        let (binary_path, user_data_dir, extensions_dir) = {
            let mut map = self.instances.lock().await;
            let Some(instance) = map.get_mut(&canonical) else {
                return Err("code-server is not running for this project root".to_string());
            };
            if !instance.is_reusable() {
                instance.retire();
                map.remove(&canonical);
                return Err("code-server exited before the file could be opened".to_string());
            }
            (
                instance.binary_path.clone(),
                instance.user_data_dir.clone(),
                instance.extensions_dir.clone(),
            )
        };

        let args = open_file_args(&user_data_dir, &extensions_dir, &target);
        let mut command = Command::new(&binary_path);
        command.args(args).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| "code-server file navigation timed out".to_string())?
            .map_err(|e| format!("launch code-server file navigation: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "code-server file navigation failed: {}",
            stderr.trim()
        ))
    }

    async fn live_port(&self, canonical: &str) -> Option<u16> {
        let mut map = self.instances.lock().await;
        match map.get_mut(canonical) {
            Some(inst) => {
                if inst.is_reusable() {
                    return Some(inst.port);
                }
                // Dead — or alive but past its health check, in which case the
                // child is still holding the port and has to be killed here, or
                // the respawn below would collide with a zombie workbench.
                inst.retire();
            }
            None => return None,
        }
        // Drop it so the next ensure spawns a fresh instance.
        map.remove(canonical);
        None
    }
}

/// One live code-server instance as seen by the managed-process registry. The
/// canonical `root` doubles as the control-routing key for kill / restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeServerManagedInfo {
    pub root: String,
    pub port: u16,
    pub pid: Option<u32>,
}

/// Serializable status for the IPC layer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub version: String,
}

/// Canonicalize a project root so the same folder maps to one instance
/// regardless of how it's spelled. Requires the path to exist.
fn canonicalize_root(root: &str) -> Result<String, String> {
    let p = Path::new(root);
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("resolve project root {root}: {e}"))?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// `<app_data>/cognia/code-server/<name>` — isolated code-server state dirs so
/// user-data / extensions don't leak into `~/.local/share/code-server`.
fn state_subdir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = download::code_server_root(app)
        .map_err(|e| format!("resolve code-server root: {e:#}"))?
        .join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// `<user-data>/User/settings.json` — the file VS Code hot-watches, and so the
/// only channel that can repaint a *running* workbench. Creating the directory
/// here is safe: it is the same one `--user-data-dir` points code-server at.
pub fn user_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = state_subdir(app, "user-data")?.join("User");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

/// Build the code-server argv. Pure so the flag set is unit-tested. Loopback
/// bind + `--auth none` keep it reachable only from this machine; workspace
/// trust and telemetry are disabled so the agent isn't blocked by prompts.
fn code_server_args(
    root: &str,
    port: u16,
    user_data_dir: &Path,
    extensions_dir: &Path,
) -> Vec<String> {
    vec![
        "--bind-addr".to_string(),
        format!("127.0.0.1:{port}"),
        "--auth".to_string(),
        "none".to_string(),
        "--disable-telemetry".to_string(),
        "--disable-update-check".to_string(),
        "--disable-workspace-trust".to_string(),
        "--user-data-dir".to_string(),
        user_data_dir.to_string_lossy().into_owned(),
        "--extensions-dir".to_string(),
        extensions_dir.to_string_lossy().into_owned(),
        root.to_string(),
    ]
}

/// Build a second code-server CLI invocation that talks to the already-running
/// instance through the session socket derived from the shared user-data dir.
fn open_file_args(user_data_dir: &Path, extensions_dir: &Path, target: &str) -> Vec<String> {
    vec![
        "--user-data-dir".to_string(),
        user_data_dir.to_string_lossy().into_owned(),
        "--extensions-dir".to_string(),
        extensions_dir.to_string_lossy().into_owned(),
        "--reuse-window".to_string(),
        target.to_string(),
    ]
}

fn resolve_open_target(
    root: &Path,
    relative_path: &str,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<String, String> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err("code-server file path must be project-relative".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("resolve project root {}: {e}", root.display()))?;
    let target = canonical_root
        .join(relative)
        .canonicalize()
        .map_err(|e| format!("resolve code-server file {relative_path}: {e}"))?;
    if !target.starts_with(&canonical_root) || !target.is_file() {
        return Err(format!(
            "code-server file is outside the project root: {}",
            target.display()
        ));
    }

    let path = target.to_string_lossy();
    Ok(match line {
        Some(line) => match column {
            Some(column) => format!("{path}:{}:{}", line.max(1), column.max(1)),
            None => format!("{path}:{}", line.max(1)),
        },
        None => path.into_owned(),
    })
}

/// Pick an ephemeral loopback port by binding :0 and releasing it. A tiny
/// TOCTOU window exists before code-server grabs it, acceptable on loopback.
fn pick_free_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("reserve loopback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("read reserved port: {e}"))?
        .port();
    Ok(port)
}

fn spawn_child(binary: &str, args: &[String]) -> Result<Child, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Prevent a console window on Windows (defensive; the feature is gated off
    // there because there's no standalone binary, but keep spawn parity).
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn code-server: {e}"))?;

    // Drain stdout/stderr so a full pipe buffer can't block code-server. These
    // tasks end when the child dies (pipes close → next_line yields None).
    drain_pipe(child.stdout.take(), "code-server");
    drain_pipe(child.stderr.take(), "code-server[err]");
    Ok(child)
}

fn drain_pipe<R>(pipe: Option<R>, tag: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    if let Some(pipe) = pipe {
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt as _;
            let mut lines = tokio::io::BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("{tag}: {line}");
            }
        });
    }
}

/// Supervise a healthy instance: probe `/healthz` on an interval and, after
/// [`WATCHDOG_FAILURES`] consecutive misses, flag the instance unhealthy,
/// announce that it is gone, and stop.
///
/// The task deliberately does **not** touch `CodeServerState` (that would need a
/// self-reference); it flips the shared `unhealthy` flag instead, which is what
/// makes the prune paths — `live_port`, `status`, `open_file` — retire the
/// instance rather than hand it out again to a caller that is retrying.
fn spawn_watchdog(
    app: tauri::AppHandle,
    root: String,
    port: u16,
    unhealthy: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use tauri::Emitter as _;
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        else {
            return;
        };
        let url = format!("http://127.0.0.1:{port}/healthz");
        let mut failures: u8 = 0;
        loop {
            tokio::time::sleep(WATCHDOG_INTERVAL).await;
            let healthy = matches!(client.get(&url).send().await, Ok(r) if r.status().is_success());
            if healthy {
                failures = 0;
                continue;
            }
            failures += 1;
            if failures < WATCHDOG_FAILURES {
                continue;
            }
            log::warn!("code-server on port {port} stopped responding; reporting exit");
            // Flag before emitting: the renderer's retry lands on `ensure`, and
            // that must already see the instance as unusable.
            unhealthy.store(true, Ordering::Relaxed);
            let _ = app.emit(
                CODESERVER_EXITED_EVENT,
                CodeServerExited {
                    root: root.clone(),
                    port,
                },
            );
            return;
        }
    })
}

/// Poll `http://127.0.0.1:<port>/healthz` until it answers 200 or `budget`
/// elapses. code-server exposes `/healthz` once its HTTP server is up.
async fn wait_healthy(port: u16, budget: Duration) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("build health client: {e}"))?;
    let deadline = Instant::now() + budget;
    loop {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "code-server did not become healthy on port {port} within {}s",
                budget.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_bind_loopback_and_disable_prompts() {
        let args = code_server_args(
            "/work/proj",
            43117,
            Path::new("/data/ud"),
            Path::new("/data/ext"),
        );
        // Loopback bind with the chosen port.
        let bind_idx = args.iter().position(|a| a == "--bind-addr").unwrap();
        assert_eq!(args[bind_idx + 1], "127.0.0.1:43117");
        // Auth disabled (loopback-only).
        let auth_idx = args.iter().position(|a| a == "--auth").unwrap();
        assert_eq!(args[auth_idx + 1], "none");
        // Prompt-free for the agent.
        assert!(args.iter().any(|a| a == "--disable-workspace-trust"));
        assert!(args.iter().any(|a| a == "--disable-telemetry"));
        // Isolated state dirs.
        assert!(args.iter().any(|a| a == "/data/ud"));
        assert!(args.iter().any(|a| a == "/data/ext"));
        // The project root is the trailing positional arg.
        assert_eq!(args.last().unwrap(), "/work/proj");
    }

    #[test]
    fn open_file_args_reuse_the_running_window_and_session() {
        let args = open_file_args(
            Path::new("/data/ud"),
            Path::new("/data/ext"),
            "/work/proj/src/main.ts:42:7",
        );
        assert_eq!(
            args,
            vec![
                "--user-data-dir",
                "/data/ud",
                "--extensions-dir",
                "/data/ext",
                "--reuse-window",
                "/work/proj/src/main.ts:42:7",
            ]
        );
    }

    #[test]
    fn open_target_is_canonical_scoped_and_line_addressed() {
        let root = tempfile::tempdir().unwrap();
        let source_dir = root.path().join("src");
        std::fs::create_dir(&source_dir).unwrap();
        std::fs::write(source_dir.join("main.ts"), "export {}\n").unwrap();

        let target = resolve_open_target(root.path(), "src/main.ts", Some(42), Some(7)).unwrap();

        assert_eq!(
            target,
            format!(
                "{}:42:7",
                source_dir.join("main.ts").canonicalize().unwrap().display()
            )
        );
    }

    #[test]
    fn open_target_rejects_absolute_traversal_and_missing_files() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(parent.path().join("outside.ts"), "outside\n").unwrap();

        assert!(resolve_open_target(&root, "../outside.ts", None, None).is_err());
        assert!(resolve_open_target(&root, "/tmp/outside.ts", None, None).is_err());
        assert!(resolve_open_target(&root, "missing.ts", None, None).is_err());
    }

    #[test]
    fn pick_free_loopback_port_is_nonzero() {
        let p = pick_free_loopback_port().unwrap();
        assert!(p > 0);
    }

    #[test]
    fn canonicalize_root_errors_for_missing_path() {
        assert!(canonicalize_root("/definitely/not/a/real/path/xyzzy").is_err());
    }

    #[tokio::test]
    async fn wait_healthy_times_out_on_dead_port() {
        // Nothing is listening on this port → should time out quickly, not hang.
        let port = pick_free_loopback_port().unwrap();
        let r = wait_healthy(port, Duration::from_millis(300)).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn status_is_false_for_unknown_root() {
        let state = CodeServerState::new();
        let (running, port) = state.status("/tmp").await;
        assert!(!running);
        assert!(port.is_none());
    }

    #[tokio::test]
    async fn stop_unknown_root_is_noop() {
        let state = CodeServerState::new();
        assert!(!state.stop("/tmp/nope").await);
    }

    /// Register a long-lived stand-in child under `root` so the reuse rules can
    /// be exercised without a real code-server install.
    #[cfg(unix)]
    async fn insert_fake_instance(
        state: &CodeServerState,
        root: &str,
        port: u16,
    ) -> Arc<AtomicBool> {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn stand-in child");
        let unhealthy = Arc::new(AtomicBool::new(false));
        state.instances.lock().await.insert(
            root.to_string(),
            RunningInstance {
                port,
                child,
                binary_path: "/bin/code-server".to_string(),
                user_data_dir: PathBuf::from("/tmp/ud"),
                extensions_dir: PathBuf::from("/tmp/ext"),
                unhealthy: unhealthy.clone(),
                watchdog: None,
            },
        );
        unhealthy
    }

    /// The retry regression: the watchdog fires while the child is still alive,
    /// so liveness alone would hand the hung instance straight back and the pane
    /// would flip to `ready` over the same dead page.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_instance_that_failed_its_health_check_is_never_handed_out_again() {
        let state = CodeServerState::new();
        let unhealthy = insert_fake_instance(&state, "/work/proj", 43117).await;

        // Alive and healthy → reused.
        assert_eq!(state.live_port("/work/proj").await, Some(43117));

        unhealthy.store(true, Ordering::Relaxed);

        // Still alive, but no longer serving: refused, killed and forgotten so
        // the next `ensure` spawns a fresh one.
        assert_eq!(state.live_port("/work/proj").await, None);
        assert!(state.instances.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn status_stops_reporting_an_instance_that_failed_its_health_check() {
        let state = CodeServerState::new();
        let unhealthy = insert_fake_instance(&state, "/work/proj", 43118).await;
        assert_eq!(state.status("/work/proj").await, (true, Some(43118)));

        unhealthy.store(true, Ordering::Relaxed);

        assert_eq!(state.status("/work/proj").await, (false, None));
        assert!(state.instances.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn managed_snapshot_retires_unhealthy_live_children() {
        let state = CodeServerState::new();
        let unhealthy = insert_fake_instance(&state, "/work/proj", 43120).await;
        assert_eq!(state.managed_snapshot().await.len(), 1);

        unhealthy.store(true, Ordering::Relaxed);

        assert!(state.managed_snapshot().await.is_empty());
        assert!(state.instances.lock().await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_file_refuses_an_instance_that_failed_its_health_check() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.ts"), "export {}\n").unwrap();
        let canonical = root.path().canonicalize().unwrap();
        let state = CodeServerState::new();
        let unhealthy = insert_fake_instance(&state, &canonical.to_string_lossy(), 43119).await;

        unhealthy.store(true, Ordering::Relaxed);

        let err = state
            .open_file(&canonical.to_string_lossy(), "main.ts", None, None)
            .await
            .unwrap_err();
        assert!(err.contains("code-server"));
        assert!(state.instances.lock().await.is_empty());
    }
}
