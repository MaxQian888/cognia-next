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
use serde_json::{json, Value};
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
    /// Shared cancel handle for whichever first-run download is in flight.
    /// One per app rather than per root: the install is version-global, and
    /// `operation_lock` already serializes downloads, so there is only ever one
    /// to cancel.
    download_cancel: Arc<download::DownloadCancel>,
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

        let info = download::ensure_code_server(app, Some(self.download_cancel.clone()))
            .await
            .map_err(|e| format!("install code-server: {e:#}"))?;

        let user_data_dir = state_subdir(app, "user-data")?;
        let extensions_dir = state_subdir(app, "extensions")?;
        let port = pick_free_loopback_port()?;
        let args = code_server_args(&canonical, port, &user_data_dir, &extensions_dir);

        // Side-load the agent-bridge extension (best-effort, once per version) BEFORE
        // the child starts so it activates on this launch. A missing/failed install
        // only degrades the Pro IDE agent-drive features, never the spawn itself.
        install_agent_extension(app, &info.binary_path, &extensions_dir, &user_data_dir).await;

        // Same deal for the display-language pack: VS Code ships English only, so a
        // non-English `locale` in argv.json needs the matching MS-CEINTL pack present
        // at startup. Read from disk rather than taken as an argument because the
        // locale is written by the renderer's sync and must survive an app restart
        // that never touches it again. Best-effort; failure just leaves the UI English.
        let locale = tokio::fs::read_to_string(runtime_args_path(app)?)
            .await
            .ok()
            .and_then(|raw| locale_from_runtime_args(&raw));
        if let Some(locale) = locale.as_deref() {
            install_language_pack(&info.binary_path, &extensions_dir, &user_data_dir, locale).await;
        }

        // Register this instance with the agent control channel BEFORE spawn so the
        // agent-channel port + per-instance token can be injected into the child's
        // env — the companion extension reads them on activate to dial back. Any
        // failure after this must deregister so a leaked token can't address a dead
        // editor.
        let channel = super::agent_channel::global();
        // Hand over the app handle before the extension can connect, so the very
        // first pushed editor event has somewhere to go.
        channel.attach_app(app);
        let (agent_port, agent_token) = channel.register_instance(&canonical).await?;
        let agent_envs = [
            ("COGNIA_CS_AGENT_PORT", agent_port.to_string()),
            ("COGNIA_CS_AGENT_TOKEN", agent_token),
        ];

        let child = match spawn_child(&info.binary_path, &args, &agent_envs) {
            Ok(child) => child,
            Err(e) => {
                super::agent_channel::global().deregister(&canonical);
                return Err(e);
            }
        };
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
        download::ensure_code_server(app, Some(self.download_cancel.clone()))
            .await
            .map_err(|e| format!("{e:#}"))
    }

    /// Abort an in-flight first-run download. No-op when none is running, so
    /// the UI can fire it without first asking whether it is worth firing.
    pub fn cancel_download(&self) {
        self.download_cancel.cancel();
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
            super::agent_channel::global().deregister(&canonical);
            true
        } else {
            false
        }
    }

    /// Kill every running instance (app teardown / kill-switch).
    pub async fn stop_all(&self) {
        let mut map = self.instances.lock().await;
        for (root, mut inst) in map.drain() {
            inst.retire();
            super::agent_channel::global().deregister(&root);
        }
    }

    /// Open + reveal an absolute file in this root's live code-server through the
    /// companion extension (Pro IDE Phase 2). Errors when no extension is connected
    /// so the caller can fall back to the CLI `open_file`.
    pub async fn agent_open(
        &self,
        root: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String> {
        let canonical = canonicalize_root(root)?;
        let params = json!({ "path": path, "line": line, "column": column });
        super::agent_channel::global()
            .send(&canonical, "openFile", params)
            .await
            .map(|_| ())
    }

    /// Reflect an agent's on-disk write as an undo-able edit in the live editor.
    /// The extension reconciles from disk (source of truth), so only the path (plus
    /// an optional reveal position) crosses the channel.
    pub async fn agent_apply_edit(
        &self,
        root: &str,
        path: &str,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), String> {
        let canonical = canonicalize_root(root)?;
        let params = json!({ "path": path, "line": line, "column": column });
        super::agent_channel::global()
            .send(&canonical, "applyEdit", params)
            .await
            .map(|_| ())
    }

    /// Read the live active-editor context back from code-server. The raw payload
    /// is returned to the renderer, which PII-gates it before it reaches the model.
    pub async fn agent_read_active(&self, root: &str) -> Result<Value, String> {
        let canonical = canonicalize_root(root)?;
        super::agent_channel::global()
            .send(&canonical, "readActive", json!({}))
            .await
    }

    /// Flush dirty editor buffers to disk, optionally just one absolute `path`.
    ///
    /// The agent's file tools read the filesystem, not the editor, so an unsaved
    /// buffer is invisible to them: without this a turn reads stale content and then
    /// overwrites the user's unsaved work. Returns the extension's
    /// `{ saved, failed }` report so the caller can tell the user which files it
    /// could not make trustworthy.
    pub async fn agent_save_all(&self, root: &str, path: Option<&str>) -> Result<Value, String> {
        let canonical = canonicalize_root(root)?;
        super::agent_channel::global()
            .send(&canonical, "saveAll", json!({ "path": path }))
            .await
    }

    /// Show a native diff between `path` on disk and a proposed revision, so a
    /// change can be reviewed before it lands. The proposal never touches disk.
    pub async fn agent_show_diff(
        &self,
        root: &str,
        path: &str,
        content: &str,
        title: Option<&str>,
    ) -> Result<Value, String> {
        let canonical = canonicalize_root(root)?;
        let params = json!({ "path": path, "content": content, "title": title });
        super::agent_channel::global()
            .send(&canonical, "showDiff", params)
            .await
    }

    /// Reveal an absolute path in the editor's file explorer.
    pub async fn agent_reveal(&self, root: &str, path: &str) -> Result<Value, String> {
        let canonical = canonicalize_root(root)?;
        super::agent_channel::global()
            .send(&canonical, "revealInExplorer", json!({ "path": path }))
            .await
    }

    /// Run a command in the editor's integrated terminal.
    ///
    /// Show-the-user, not collect-the-output: the extension host cannot read a
    /// terminal's output back, and the agent has its own shell tool for that.
    pub async fn agent_run_in_terminal(
        &self,
        root: &str,
        command: &str,
        cwd: Option<&str>,
        name: Option<&str>,
    ) -> Result<Value, String> {
        let canonical = canonicalize_root(root)?;
        let params = json!({ "command": command, "cwd": cwd, "name": name });
        super::agent_channel::global()
            .send(&canonical, "runInTerminal", params)
            .await
    }

    /// Surface an app-side message inside the editor.
    pub async fn agent_notify(
        &self,
        root: &str,
        message: &str,
        kind: Option<&str>,
    ) -> Result<Value, String> {
        let canonical = canonicalize_root(root)?;
        let params = json!({ "message": message, "kind": kind });
        super::agent_channel::global()
            .send(&canonical, "notify", params)
            .await
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

/// `<user-data>/User/argv.json` — VS Code's *runtime* configuration file, which
/// is where the display language lives (`{"locale": "zh-cn"}`). Deliberately not
/// `settings.json`: VS Code reads `locale` from argv.json only, and only at
/// startup, so changing it also requires restarting the instance.
///
/// Same directory as {@link user_settings_path}, which is the one
/// `--user-data-dir` points code-server at.
pub fn runtime_args_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = state_subdir(app, "user-data")?.join("User");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join("argv.json"))
}

/// Read the `locale` out of an `argv.json` document.
///
/// Tolerates the JSONC that VS Code's own "Configure Runtime Arguments" command
/// writes (the file it generates is comment-heavy), and a blank / absent locale,
/// both of which mean "no display-language pack needed".
pub fn locale_from_runtime_args(raw: &str) -> Option<String> {
    let cleaned = crate::agents::io::strip_jsonc(raw);
    let value: serde_json::Value = serde_json::from_str(&cleaned).ok()?;
    let locale = value.get("locale")?.as_str()?.trim();
    if locale.is_empty() {
        return None;
    }
    Some(locale.to_string())
}

/// The Open VSX extension id of the MS-CEINTL language pack for a VS Code locale.
///
/// VS Code ships English only; every other display language needs a language-pack
/// extension, and code-server resolves `--install-extension <id>` against Open VSX
/// (which carries the MS-CEINTL packs). `None` means "no pack needed or none
/// published" — English, and any locale we have not verified is available. Pure so
/// the mapping is unit-tested without a network.
pub fn language_pack_extension_id(locale: &str) -> Option<&'static str> {
    match locale.trim().to_ascii_lowercase().as_str() {
        // English is the built-in display language; installing a pack for it is a
        // pointless download.
        "" | "en" | "en-us" | "en-gb" => None,
        "zh-cn" | "zh-hans" => Some("MS-CEINTL.vscode-language-pack-zh-hans"),
        "zh-tw" | "zh-hant" => Some("MS-CEINTL.vscode-language-pack-zh-hant"),
        "ja" => Some("MS-CEINTL.vscode-language-pack-ja"),
        "ko" => Some("MS-CEINTL.vscode-language-pack-ko"),
        "fr" => Some("MS-CEINTL.vscode-language-pack-fr"),
        "de" => Some("MS-CEINTL.vscode-language-pack-de"),
        "es" => Some("MS-CEINTL.vscode-language-pack-es"),
        "pt-br" => Some("MS-CEINTL.vscode-language-pack-pt-BR"),
        "ru" => Some("MS-CEINTL.vscode-language-pack-ru"),
        "it" => Some("MS-CEINTL.vscode-language-pack-it"),
        "tr" => Some("MS-CEINTL.vscode-language-pack-tr"),
        "pl" => Some("MS-CEINTL.vscode-language-pack-pl"),
        "cs" => Some("MS-CEINTL.vscode-language-pack-cs"),
        _ => None,
    }
}

/// Install the display-language pack for `locale`, at most once per locale.
///
/// Best-effort in exactly the way {@link install_agent_extension} is: the display
/// language is a nicety, and a failed or unavailable pack must never stop a
/// code-server from spawning. Returns whether a pack is now believed installed, so
/// the caller can tell the user why the UI is still English.
pub async fn install_language_pack(
    binary: &str,
    extensions_dir: &Path,
    user_data_dir: &Path,
    locale: &str,
) -> bool {
    let Some(extension_id) = language_pack_extension_id(locale) else {
        return false;
    };
    let marker = extensions_dir.join(".cognia-language-pack");
    if tokio::fs::read_to_string(&marker).await.ok().as_deref() == Some(extension_id) {
        return true;
    }

    let mut command = Command::new(binary);
    command
        .arg("--install-extension")
        .arg(extension_id)
        .arg("--extensions-dir")
        .arg(extensions_dir)
        .arg("--user-data-dir")
        .arg(user_data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Longer than the bundled-vsix install: this one reaches Open VSX.
    match tokio::time::timeout(Duration::from_secs(120), command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            if let Err(e) = tokio::fs::write(&marker, extension_id).await {
                log::warn!("code-server language pack: write install marker: {e}");
            }
            true
        }
        Ok(Ok(output)) => {
            log::warn!(
                "code-server language pack {extension_id} install failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            false
        }
        Ok(Err(e)) => {
            log::warn!("code-server language pack {extension_id} install: {e}");
            false
        }
        Err(_) => {
            log::warn!("code-server language pack {extension_id} install timed out");
            false
        }
    }
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

/// Version of the bundled agent-bridge extension. Bump in lockstep with
/// `sidecar/codeserver-agent-ext/package.json` `version` so an upgrade triggers a
/// reinstall (the marker below stores the installed version).
const AGENT_EXT_VERSION: &str = "0.2.0";
/// Stable filename of the bundled `.vsix` (see the extension's `build.mjs`).
const AGENT_EXT_VSIX: &str = "cognia-agent-bridge.vsix";

/// Whether a stored install-marker value means the current extension version is
/// already installed (so the reinstall can be skipped). Pure, so the version-gate
/// contract is unit-tested without spawning code-server.
fn agent_ext_install_up_to_date(marker: Option<&str>) -> bool {
    marker == Some(AGENT_EXT_VERSION)
}

/// Side-load the Cognia agent-bridge extension into `extensions_dir`, at most once
/// per version. Best-effort: a missing vsix or a failed install only degrades the
/// Pro IDE agent-drive features (open/reveal falls back to the CLI, edits to a disk
/// reload) — it must never block a code-server spawn, so every failure just logs.
async fn install_agent_extension(
    app: &tauri::AppHandle,
    binary: &str,
    extensions_dir: &Path,
    user_data_dir: &Path,
) {
    let marker = extensions_dir.join(".cognia-agent-ext-version");
    // Async I/O on the runtime thread (this runs under `ensure`'s operation_lock);
    // matches the spawn_blocking-avoidance the sibling settings commands use.
    let existing = tokio::fs::read_to_string(&marker).await.ok();
    if agent_ext_install_up_to_date(existing.as_deref()) {
        return;
    }
    let vsix = match crate::claude::sidecar::sidecar_dir(app) {
        Ok(dir) => dir.join("codeserver-agent-ext").join(AGENT_EXT_VSIX),
        Err(e) => {
            log::warn!("code-server agent ext: sidecar dir unresolved: {e}");
            return;
        }
    };
    if !vsix.exists() {
        log::warn!(
            "code-server agent ext: vsix not found at {} (Pro IDE agent-drive disabled)",
            vsix.display()
        );
        return;
    }

    let mut command = Command::new(binary);
    command
        .arg("--install-extension")
        .arg(&vsix)
        .arg("--extensions-dir")
        .arg(extensions_dir)
        .arg("--user-data-dir")
        .arg(user_data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    match tokio::time::timeout(Duration::from_secs(60), command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            if let Err(e) = tokio::fs::write(&marker, AGENT_EXT_VERSION).await {
                log::warn!("code-server agent ext: write install marker: {e}");
            }
        }
        Ok(Ok(output)) => log::warn!(
            "code-server agent ext install failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Ok(Err(e)) => log::warn!("code-server agent ext install: {e}"),
        Err(_) => log::warn!("code-server agent ext install timed out"),
    }
}

fn spawn_child(binary: &str, args: &[String], envs: &[(&str, String)]) -> Result<Child, String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in envs {
        cmd.env(key, value);
    }
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
    fn locale_is_read_out_of_argv_json() {
        assert_eq!(
            locale_from_runtime_args(r#"{"locale":"zh-cn"}"#).as_deref(),
            Some("zh-cn")
        );
    }

    #[test]
    fn locale_tolerates_the_jsonc_vs_code_writes() {
        // This is close to what "Configure Runtime Arguments" actually generates.
        let raw = r#"
        // This configuration file allows you to pass permanent command line
        // arguments to VS Code.
        {
            // Display language
            "locale": "ja",
            /* trailing comma below is legal here */
            "enable-crash-reporter": false,
        }
        "#;
        assert_eq!(locale_from_runtime_args(raw).as_deref(), Some("ja"));
    }

    #[test]
    fn locale_is_absent_for_missing_blank_or_broken_documents() {
        assert_eq!(locale_from_runtime_args(""), None);
        assert_eq!(locale_from_runtime_args("{}"), None);
        assert_eq!(locale_from_runtime_args(r#"{"locale":""}"#), None);
        assert_eq!(locale_from_runtime_args(r#"{"locale":"  "}"#), None);
        // Wrong type, and outright malformed — both mean "no pack", not a panic.
        assert_eq!(locale_from_runtime_args(r#"{"locale":42}"#), None);
        assert_eq!(locale_from_runtime_args("{ not json"), None);
    }

    #[test]
    fn english_needs_no_language_pack() {
        // Installing a pack for the built-in display language is a pointless
        // download, so this must stay None.
        for locale in ["en", "en-US", "EN-gb", ""] {
            assert_eq!(language_pack_extension_id(locale), None, "{locale}");
        }
    }

    #[test]
    fn language_pack_ids_use_the_published_open_vsx_names() {
        assert_eq!(
            language_pack_extension_id("zh-cn"),
            Some("MS-CEINTL.vscode-language-pack-zh-hans")
        );
        // The app's own tag spelling and VS Code's differ in case; both resolve.
        assert_eq!(
            language_pack_extension_id("zh-CN"),
            Some("MS-CEINTL.vscode-language-pack-zh-hans")
        );
        assert_eq!(
            language_pack_extension_id("zh-hant"),
            Some("MS-CEINTL.vscode-language-pack-zh-hant")
        );
        // Open VSX publishes pt-BR with that exact casing in the extension name.
        assert_eq!(
            language_pack_extension_id("pt-br"),
            Some("MS-CEINTL.vscode-language-pack-pt-BR")
        );
        assert_eq!(
            language_pack_extension_id("  ja  "),
            Some("MS-CEINTL.vscode-language-pack-ja")
        );
    }

    #[test]
    fn unknown_locales_report_no_pack_rather_than_guessing_an_id() {
        // Guessing would produce a 120s Open VSX round-trip that always fails.
        assert_eq!(language_pack_extension_id("kl-GL"), None);
        assert_eq!(language_pack_extension_id("nonsense"), None);
    }

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
    fn agent_ext_marker_gates_reinstall_on_version() {
        // Same version → skip; different or absent marker → (re)install.
        assert!(agent_ext_install_up_to_date(Some(AGENT_EXT_VERSION)));
        assert!(!agent_ext_install_up_to_date(Some("0.0.1")));
        assert!(!agent_ext_install_up_to_date(None));
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
