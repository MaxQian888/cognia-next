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
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::download;

/// A live code-server instance for one project root.
struct RunningInstance {
    port: u16,
    child: Child,
    binary_path: String,
    user_data_dir: PathBuf,
    extensions_dir: PathBuf,
}

impl RunningInstance {
    /// Whether the child is still running (has not exited).
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// Tauri managed state: the registry of running code-server instances plus a
/// spawn lock that serializes installs/spawns (a first-run download is a shared,
/// single-version resource, so concurrent spawns must not race the tarball).
#[derive(Default)]
pub struct CodeServerState {
    instances: Mutex<HashMap<String, RunningInstance>>,
    spawn_lock: Mutex<()>,
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
            if inst.is_alive() {
                return (true, Some(inst.port));
            }
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
        let _guard = self.spawn_lock.lock().await;
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
                },
            );
        }

        match wait_healthy(port, Duration::from_secs(30)).await {
            Ok(()) => Ok(port),
            Err(e) => {
                self.stop(&canonical).await;
                Err(e)
            }
        }
    }

    /// Kill + forget the instance for a root (canonical or raw). No-op if none.
    pub async fn stop(&self, root: &str) -> bool {
        let canonical = canonicalize_root(root).unwrap_or_else(|_| root.to_string());
        let mut map = self.instances.lock().await;
        if let Some(mut inst) = map.remove(&canonical) {
            let _ = inst.child.start_kill();
            true
        } else {
            false
        }
    }

    /// Kill every running instance (app teardown / kill-switch).
    pub async fn stop_all(&self) {
        let mut map = self.instances.lock().await;
        for (_, mut inst) in map.drain() {
            let _ = inst.child.start_kill();
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
            if !instance.is_alive() {
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
        if let Some(inst) = map.get_mut(canonical) {
            if inst.is_alive() {
                return Some(inst.port);
            }
        } else {
            return None;
        }
        // Dead child — drop it so the next ensure respawns.
        map.remove(canonical);
        None
    }
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
}
