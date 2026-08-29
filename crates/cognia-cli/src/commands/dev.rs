//! `cognia plugin dev [--reload-url URL]` — watch + rebuild + optionally
//! notify a running cognia.
//!
//! Listens for changes to source files (`src/`, `wit/`, `Cargo.toml`,
//! `plugin.json`). On each event it debounces 250 ms, then runs the
//! per-type build. If `--reload-url` is passed (or the CLI auto-discovers
//! a running cognia from the endpoint file), the latest bundle is POSTed
//! to the CLI bridge so the host hot-reloads in place.
//!
//! Phase 4 rewires the user-visible surface:
//!   * **Sticky status panel** (TTY only): four `indicatif` lines pinned
//!     to the bottom of the terminal while cargo output scrolls above.
//!     Shows Status / Endpoint / Last build (duration + outcome + clock)
//!     / Rebuilds count.
//!   * **Smart degradation**: on a non-TTY (CI, redirected stdout), the
//!     panel collapses to per-event `println!` lines so logs stay grep
//!     friendly.
//!   * **Graceful Ctrl+C**: one interrupt cancels an in-flight build, emits a
//!     terminal session event, and exits with the conventional code 130.

use anyhow::{bail, Context, Result};
use chrono::Local;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::engine::bridge_client::{
    load_endpoint, post_json, post_json_with_timeout, EndpointFile,
};
use crate::shared::{
    clear_process_interrupt, read_plugin_manifest, request_process_interrupt, ProcessInterrupted,
};
use crate::ui::{style, RuntimeUi};

const DEBOUNCE: Duration = Duration::from_millis(250);
static DEV_PROJECT_DISPLAY_NAME: OnceLock<String> = OnceLock::new();

/// Quit-state values driven by the Ctrl+C handler. Atomic so the handler
/// stays signal-safe.
const QUIT_RUNNING: u8 = 0;
const QUIT_STOP_REQUESTED: u8 = 1;

#[derive(Debug)]
pub(crate) struct DevInterruptedExit;

impl std::fmt::Display for DevInterruptedExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("plugin development session interrupted")
    }
}

impl std::error::Error for DevInterruptedExit {}

/// `cognia plugin dev` — runs the watch/rebuild loop until one Ctrl+C
/// requests a graceful stop (or stdin EOF).
pub fn run(
    path: PathBuf,
    reload_url: Option<String>,
    session_id: Option<String>,
    once: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    if ui.flags.json && !once {
        return emit_json_input_failure(
            &path,
            once,
            "`cognia plugin dev --json` requires `--once` so stdout stays parseable".to_string(),
        );
    }

    let crate_root = match path.canonicalize() {
        Ok(root) => root,
        Err(err) if ui.flags.json => {
            return emit_json_input_failure(
                &path,
                once,
                format!("resolve {}: {err}", path.display()),
            );
        }
        Err(err) => return Err(err).with_context(|| format!("resolve {}", path.display())),
    };
    let _ = DEV_PROJECT_DISPLAY_NAME.set(
        crate_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("plugin")
            .chars()
            .take(128)
            .collect(),
    );
    if !crate_root.join("plugin.json").exists() {
        if ui.flags.json {
            return emit_json_input_failure(
                &crate_root,
                once,
                format!("plugin.json not found under {}", crate_root.display()),
            );
        }
        bail!("plugin.json not found under {}", crate_root.display());
    }
    let (manifest, _) = match read_plugin_manifest(&crate_root) {
        Ok(manifest) => manifest,
        Err(err) if ui.flags.json => {
            return emit_json_input_failure(&crate_root, once, err.to_string());
        }
        Err(err) => return Err(err),
    };

    let reload_endpoint = resolve_reload_endpoint(reload_url.as_deref());
    let session_id = match session_id {
        Some(value) => uuid::Uuid::parse_str(&value)
            .map_err(|_| anyhow::anyhow!("--session-id must be a UUID"))?
            .to_string(),
        None => uuid::Uuid::new_v4().to_string(),
    };

    if once {
        return run_once(&crate_root, reload_endpoint.as_ref(), &session_id, ui);
    }

    // Install the Ctrl+C handler exactly once per process. Tests skip
    // this entirely; production runs install before the watcher to make
    // sure the handler is wired before any fs noise can fire.
    let quit_state = Arc::new(AtomicU8::new(QUIT_RUNNING));
    let build_active = Arc::new(AtomicBool::new(false));
    clear_process_interrupt();
    install_quit_handler(quit_state.clone(), build_active.clone())?;

    let panel = StatusPanel::new(ui, &crate_root, reload_endpoint.as_ref());
    panel.set_status("Watching");

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .context("create filesystem watcher")?;
    for p in watch_paths_for(&crate_root, &manifest) {
        if p.exists() {
            let mode = if p.is_dir() {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };
            watcher
                .watch(&p, mode)
                .with_context(|| format!("watch {}", p.display()))?;
        }
    }

    send_session_event(
        reload_endpoint.as_ref(),
        &session_id,
        0,
        "session_started",
        None,
        None,
    );
    let mut heartbeat = HeartbeatGuard::start(reload_endpoint.as_ref(), &session_id);

    let mut attempt = 1_u64;
    panel.set_status("Building initial plugin");
    let started = Instant::now();
    build_active.store(true, Ordering::SeqCst);
    let initial_outcome = rebuild_and_reload(
        &crate_root,
        reload_endpoint.as_ref(),
        &session_id,
        attempt,
        ui,
    );
    build_active.store(false, Ordering::SeqCst);
    panel.record_build(&initial_outcome, started.elapsed());
    if let Err(error) = &initial_outcome {
        panel.println_above(format!(
            "{}initial build failed: {error:#}",
            style::error_prefix()
        ));
    }
    attempt += 1;
    panel.set_status("Watching");

    let mut pending = false;
    let mut last_change = Instant::now() - DEBOUNCE * 2;
    loop {
        if quit_state.load(Ordering::SeqCst) == QUIT_STOP_REQUESTED {
            panel.println_above(format!(
                "{}stopping development session",
                style::warn_prefix()
            ));
            break;
        }
        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(event)) => {
                if should_rebuild(&event) {
                    pending = true;
                    last_change = Instant::now();
                    panel.set_status("Change detected, debouncing");
                    send_session_event(
                        reload_endpoint.as_ref(),
                        &session_id,
                        attempt,
                        "change_detected",
                        None,
                        None,
                    );
                }
            }
            Ok(Err(e)) => {
                panel.println_above(format!("{}watch error: {e}", style::warn_prefix()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending && last_change.elapsed() >= DEBOUNCE {
                    pending = false;
                    panel.set_status("Building");
                    let started = Instant::now();
                    // Suppress build's own spinners while the panel
                    // owns the bottom of the screen — cargo's native
                    // output still streams.
                    let prior_quiet = ui.flags.quiet;
                    ui.flags.quiet = true;
                    build_active.store(true, Ordering::SeqCst);
                    let outcome = rebuild_and_reload(
                        &crate_root,
                        reload_endpoint.as_ref(),
                        &session_id,
                        attempt,
                        ui,
                    );
                    build_active.store(false, Ordering::SeqCst);
                    ui.flags.quiet = prior_quiet;
                    let elapsed = started.elapsed();
                    panel.record_build(&outcome, elapsed);
                    if outcome
                        .as_ref()
                        .is_err_and(|error| error.downcast_ref::<ProcessInterrupted>().is_some())
                    {
                        panel.println_above(format!("{}build interrupted", style::warn_prefix()));
                    } else if let Err(e) = outcome {
                        panel.println_above(format!(
                            "{}rebuild failed: {e:#}",
                            style::error_prefix()
                        ));
                    }
                    panel.set_status("Watching");
                    attempt += 1;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    heartbeat.stop();
    send_session_event(
        reload_endpoint.as_ref(),
        &session_id,
        attempt.saturating_sub(1),
        "session_stopping",
        None,
        None,
    );
    send_session_event(
        reload_endpoint.as_ref(),
        &session_id,
        attempt.saturating_sub(1),
        "session_stopped",
        None,
        None,
    );
    panel.finish();
    if quit_state.load(Ordering::SeqCst) == QUIT_STOP_REQUESTED {
        Err(DevInterruptedExit.into())
    } else {
        Ok(())
    }
}

fn run_once(
    crate_root: &Path,
    reload_endpoint: Option<&EndpointFile>,
    session_id: &str,
    ui: &mut RuntimeUi,
) -> Result<()> {
    send_session_event(
        reload_endpoint,
        session_id,
        0,
        "session_started",
        None,
        None,
    );
    send_session_event(reload_endpoint, session_id, 1, "build_started", None, None);
    let build_started = Instant::now();
    let outcome = match build_once(crate_root, ui) {
        Ok(outcome) => outcome,
        Err(err) if ui.flags.json => {
            let error = dev_build_error_message(&err);
            send_session_event(
                reload_endpoint,
                session_id,
                1,
                "build_failed",
                Some(&error),
                Some(build_started.elapsed()),
            );
            send_session_event(
                reload_endpoint,
                session_id,
                1,
                "session_stopped",
                None,
                None,
            );
            let payload = DevBuildFailureJsonPayload {
                schema_version: 1,
                ok: false,
                action: "dev",
                mode: "once",
                stage: "build",
                path: crate_root.display().to_string(),
                error,
            };
            println!("{}", serde_json::to_string_pretty(&payload)?);
            return Err(crate::shared::JsonFailureExit.into());
        }
        Err(err) => {
            let message = dev_build_error_message(&err);
            send_session_event(
                reload_endpoint,
                session_id,
                1,
                "build_failed",
                Some(&message),
                Some(build_started.elapsed()),
            );
            send_session_event(
                reload_endpoint,
                session_id,
                1,
                "session_stopped",
                None,
                None,
            );
            return Err(err);
        }
    };
    send_session_event(
        reload_endpoint,
        session_id,
        1,
        "build_succeeded",
        None,
        Some(build_started.elapsed()),
    );
    let reload = match reload_bundle(
        crate_root,
        reload_endpoint,
        &outcome.bundle_path,
        session_id,
        1,
    ) {
        Ok(reload) => reload,
        Err(err) if ui.flags.json => {
            let (reload_outcome, structured_error) = reload_failure_payload(&err);
            let payload = DevOnceFailureJsonPayload {
                schema_version: 1,
                ok: false,
                action: "dev",
                mode: "once",
                stage: "reload",
                plugin_id: outcome.plugin_id,
                version: outcome.version,
                plugin_type: outcome.plugin_type,
                bundle: outcome.bundle_path.display().to_string(),
                reload: DevReloadJsonPayload {
                    attempted: true,
                    ok: Some(false),
                    endpoint: reload_endpoint.map(|endpoint| endpoint.base_url.clone()),
                    skipped_reason: None,
                    outcome: Some(reload_outcome),
                    activation_proof: None,
                },
                error: structured_error,
            };
            println!("{}", serde_json::to_string_pretty(&payload)?);
            send_session_event(
                reload_endpoint,
                session_id,
                1,
                "session_stopped",
                None,
                None,
            );
            return Err(crate::shared::JsonFailureExit.into());
        }
        Err(err) => {
            send_session_event(
                reload_endpoint,
                session_id,
                1,
                "session_stopped",
                None,
                None,
            );
            return Err(err);
        }
    };

    let verified = reload.ok == Some(true);

    if ui.flags.json {
        let payload = DevOnceJsonPayload {
            schema_version: 1,
            ok: verified,
            action: "dev",
            mode: "once",
            plugin_id: outcome.plugin_id,
            version: outcome.version,
            plugin_type: outcome.plugin_type,
            bundle: outcome.bundle_path.display().to_string(),
            reload,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!(
            "{}Built {} v{} → {}",
            style::success_prefix(),
            style::bold(&outcome.plugin_id),
            style::bold(&outcome.version),
            style::dim(outcome.bundle_path.display().to_string())
        );
        match reload {
            DevReloadJsonPayload {
                attempted: true,
                ok: Some(true),
                ..
            } => println!(
                "{}Reloaded {}",
                style::success_prefix(),
                style::bold(&outcome.plugin_id)
            ),
            DevReloadJsonPayload {
                attempted: false,
                skipped_reason: Some(reason),
                ..
            } => println!("{}reload skipped: {reason}", style::warn_prefix()),
            _ => {}
        }
    }
    send_session_event(
        reload_endpoint,
        session_id,
        1,
        "session_stopped",
        None,
        None,
    );
    if verified {
        Ok(())
    } else if ui.flags.json {
        Err(crate::shared::JsonFailureExit.into())
    } else {
        bail!("host_unverified: the build succeeded but no runtime activation was proven")
    }
}

fn build_once(
    crate_root: &Path,
    ui: &mut RuntimeUi,
) -> Result<crate::commands::build::BuildOutcome> {
    let prior_quiet = ui.flags.quiet;
    let prior_json = ui.flags.json;
    ui.flags.quiet = true;
    let result = crate::commands::build::build_quiet(crate_root.to_path_buf(), None, false, ui);
    ui.flags.quiet = prior_quiet;
    ui.flags.json = prior_json;
    result
}

fn dev_build_error_message(err: &anyhow::Error) -> String {
    if let Some(lint) = err.downcast_ref::<crate::commands::lint::LintError>() {
        // LintError's Display already reads "manifest lint failed: …" — surface
        // it verbatim (don't double the prefix); other build errors surface as-is.
        return lint.to_string();
    }
    err.to_string()
}

fn should_rebuild(event: &notify::Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn watch_paths_for(crate_root: &Path, manifest: &serde_json::Value) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for rel in [
        "src",
        "wit",
        "dist",
        "Cargo.toml",
        "package.json",
        "plugin.json",
    ] {
        push_watch_path(&mut paths, crate_root.join(rel));
    }
    for field in ["main", "pythonMain", "vscodeMain", "styles"] {
        if let Some(rel_path) = manifest.get(field).and_then(|value| value.as_str()) {
            push_manifest_watch_path(&mut paths, crate_root, rel_path);
        }
    }
    if let Some(items) = manifest
        .get("bundle_include")
        .and_then(|value| value.as_array())
    {
        for item in items.iter().filter_map(|value| value.as_str()) {
            push_manifest_watch_path(&mut paths, crate_root, item);
        }
    }
    paths
}

fn push_manifest_watch_path(paths: &mut Vec<PathBuf>, crate_root: &Path, rel_path: &str) {
    let path = Path::new(rel_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return;
    }
    let watch_path = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => crate_root.join(parent),
        _ => crate_root.join(path),
    };
    push_watch_path(paths, watch_path);
}

fn push_watch_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn rebuild_and_reload(
    crate_root: &std::path::Path,
    reload_endpoint: Option<&EndpointFile>,
    session_id: &str,
    attempt: u64,
    ui: &mut RuntimeUi,
) -> Result<()> {
    send_session_event(
        reload_endpoint,
        session_id,
        attempt,
        "build_started",
        None,
        None,
    );
    let started = Instant::now();
    let outcome = match crate::commands::build::build(crate_root.to_path_buf(), None, false, ui) {
        Ok(outcome) => outcome,
        Err(error) => {
            send_session_event(
                reload_endpoint,
                session_id,
                attempt,
                "build_failed",
                Some(&dev_build_error_message(&error)),
                Some(started.elapsed()),
            );
            return Err(error);
        }
    };
    send_session_event(
        reload_endpoint,
        session_id,
        attempt,
        "build_succeeded",
        None,
        Some(started.elapsed()),
    );

    reload_bundle(
        crate_root,
        reload_endpoint,
        &outcome.bundle_path,
        session_id,
        attempt,
    )?;
    Ok(())
}

fn reload_bundle(
    crate_root: &Path,
    reload_endpoint: Option<&EndpointFile>,
    bundle: &Path,
    session_id: &str,
    attempt: u64,
) -> Result<DevReloadJsonPayload> {
    let Some(endpoint) = reload_endpoint else {
        return Ok(DevReloadJsonPayload::skipped("no-endpoint"));
    };
    let (manifest, _) = read_plugin_manifest(crate_root)?;
    let id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if !bundle.exists() {
        return Ok(DevReloadJsonPayload::skipped("bundle-missing"));
    }
    let response: DevReloadResponse = post_json(
        endpoint,
        "/api/dev/plugins/reload",
        &json!({
            "schema_version": 1,
            "session_id": session_id,
            "attempt": attempt,
            "activate": true,
            "bundle_path": bundle.to_string_lossy(),
            "plugin_id": id,
        }),
    )
    .context("reload endpoint POST failed")?;
    validate_reload_response(response, &endpoint.base_url)
}

fn send_session_event(
    endpoint: Option<&EndpointFile>,
    session_id: &str,
    attempt: u64,
    event: &str,
    summary: Option<&str>,
    duration: Option<Duration>,
) {
    let Some(endpoint) = endpoint else {
        return;
    };
    let summary = summary.map(sanitize_event_summary);
    let stage = match event {
        "session_started" => "starting",
        "heartbeat" => "watching",
        "change_detected" => "detected",
        "build_started" => "building",
        "build_succeeded" => "installing",
        "build_failed" => "build_failed",
        "session_stopping" => "stopping",
        "session_stopped" => "stopped",
        _ => "watching",
    };
    let _: Result<serde_json::Value> = post_json_with_timeout(
        endpoint,
        "/api/dev/plugins/session-events",
        &json!({
            "schema_version": 1,
            "session_id": session_id,
            "attempt": attempt,
            "event": event,
            "project_name": DEV_PROJECT_DISPLAY_NAME.get(),
            "stage": stage,
            "occurred_at": chrono::Utc::now().to_rfc3339(),
            "summary": summary,
            "duration_ms": duration.map(|value| value.as_millis() as u64),
        }),
        Duration::from_secs(2),
    );
}

struct HeartbeatGuard {
    stop: Option<mpsc::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl HeartbeatGuard {
    fn start(endpoint: Option<&EndpointFile>, session_id: &str) -> Self {
        let Some(endpoint) = endpoint.cloned() else {
            return Self {
                stop: None,
                worker: None,
            };
        };
        let session_id = session_id.to_string();
        let (stop_tx, stop_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || loop {
            match stop_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    send_session_event(Some(&endpoint), &session_id, 0, "heartbeat", None, None);
                }
            }
        });
        Self {
            stop: Some(stop_tx),
            worker: Some(worker),
        }
    }

    fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

fn sanitize_event_summary(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            let windows_absolute = token.as_bytes().get(1) == Some(&b':')
                && token
                    .as_bytes()
                    .get(2)
                    .is_some_and(|byte| *byte == b'/' || *byte == b'\\');
            if token.starts_with('/') || windows_absolute {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1024)
        .collect()
}

#[derive(Debug, Serialize)]
struct DevOnceJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    mode: &'static str,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    version: String,
    #[serde(rename = "pluginType")]
    plugin_type: String,
    bundle: String,
    reload: DevReloadJsonPayload,
}

#[derive(Debug, Serialize)]
struct DevOnceFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    mode: &'static str,
    stage: &'static str,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    version: String,
    #[serde(rename = "pluginType")]
    plugin_type: String,
    bundle: String,
    reload: DevReloadJsonPayload,
    error: DevReloadError,
}

#[derive(Debug, Serialize)]
struct DevBuildFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    mode: &'static str,
    stage: &'static str,
    path: String,
    error: String,
}

#[derive(Debug, Serialize)]
struct DevReloadJsonPayload {
    attempted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    #[serde(rename = "skippedReason", skip_serializing_if = "Option::is_none")]
    skipped_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(rename = "activationProof", skip_serializing_if = "Option::is_none")]
    activation_proof: Option<DevActivationProof>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevActivationProof {
    previous_generation: u64,
    generation: u64,
    actual_state: String,
    package_version: String,
    artifact_revision: String,
    reload_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevReloadResponse {
    schema_version: Option<u32>,
    ok: bool,
    outcome: Option<String>,
    activation_proof: Option<DevActivationProof>,
    error: Option<DevReloadError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct DevReloadError {
    code: String,
    message: String,
    action: Option<String>,
    #[serde(default)]
    retriable: bool,
}

#[derive(Debug)]
struct DevReloadFailure {
    outcome: String,
    error: DevReloadError,
}

impl std::fmt::Display for DevReloadFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.error.code, self.error.message)
    }
}

impl std::error::Error for DevReloadFailure {}

#[derive(Debug, Serialize)]
struct DevFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    mode: &'static str,
    path: String,
    error: String,
}

fn emit_json_input_failure(path: &Path, once: bool, error: String) -> Result<()> {
    let payload = DevFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "dev",
        stage: "input",
        mode: if once { "once" } else { "watch" },
        path: path.display().to_string(),
        error,
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

impl DevReloadJsonPayload {
    fn skipped(reason: &'static str) -> Self {
        Self {
            attempted: false,
            ok: None,
            endpoint: None,
            skipped_reason: Some(reason),
            outcome: None,
            activation_proof: None,
        }
    }
}

fn validate_reload_response(
    response: DevReloadResponse,
    endpoint: &str,
) -> Result<DevReloadJsonPayload> {
    let Some(proof) = response.activation_proof else {
        let error = response.error.unwrap_or_else(|| DevReloadError {
            code: "host_unverified".into(),
            message: "the host returned no activation proof".into(),
            action: Some("Upgrade Cognia Desktop and retry".into()),
            retriable: false,
        });
        return Err(DevReloadFailure {
            outcome: response.outcome.unwrap_or_else(|| "failed".into()),
            error,
        }
        .into());
    };
    if response.schema_version != Some(1)
        || !response.ok
        || response.outcome.as_deref() != Some("activated")
        || proof.actual_state != "active"
        || proof.generation <= proof.previous_generation
        || proof.artifact_revision.trim().is_empty()
    {
        let error = response.error.unwrap_or_else(|| DevReloadError {
            code: "reload_not_activated".into(),
            message: "activation proof did not confirm a new active generation".into(),
            action: Some("Inspect runtime diagnostics and retry".into()),
            retriable: true,
        });
        return Err(DevReloadFailure {
            outcome: response.outcome.unwrap_or_else(|| "failed".into()),
            error,
        }
        .into());
    }
    Ok(DevReloadJsonPayload {
        attempted: true,
        ok: Some(true),
        endpoint: Some(endpoint.to_string()),
        skipped_reason: None,
        outcome: response.outcome,
        activation_proof: Some(proof),
    })
}

fn reload_failure_payload(error: &anyhow::Error) -> (String, DevReloadError) {
    if let Some(failure) = error.downcast_ref::<DevReloadFailure>() {
        return (failure.outcome.clone(), failure.error.clone());
    }
    (
        "failed".into(),
        DevReloadError {
            code: "bridge_error".into(),
            message: error.to_string(),
            action: Some("Verify the Cognia Desktop bridge and retry".into()),
            retriable: true,
        },
    )
}

fn request_graceful_stop(state: &AtomicU8) {
    state.store(QUIT_STOP_REQUESTED, Ordering::SeqCst);
}

/// Resolve the reload endpoint. If `--reload-url` is supplied we try to
/// honor it (with the token from the endpoint file if available); else
/// we fall back to the endpoint file alone.
fn resolve_reload_endpoint(override_url: Option<&str>) -> Option<EndpointFile> {
    match (override_url, load_endpoint().ok()) {
        (Some(url), Some(ep)) => Some(EndpointFile {
            base_url: url.into(),
            dev_token: ep.dev_token,
        }),
        (Some(url), None) => Some(EndpointFile {
            base_url: url.into(),
            dev_token: String::new(),
        }),
        (None, Some(ep)) => Some(ep),
        (None, None) => None,
    }
}

/// Install a process-wide Ctrl+C handler that requests a graceful stop.
/// `set_handler` errors only when called twice in the same process —
/// production runs are once per `dev`, so that's a programmer bug;
/// surface it loudly. Tests skip this entirely.
fn install_quit_handler(state: Arc<AtomicU8>, build_active: Arc<AtomicBool>) -> Result<()> {
    let result = ctrlc::set_handler(move || {
        request_graceful_stop(&state);
        if build_active.load(Ordering::SeqCst) {
            request_process_interrupt();
        }
    });
    // Re-installing in the same process is fine — we treat it as idempotent.
    match result {
        Ok(()) => Ok(()),
        Err(ctrlc::Error::MultipleHandlers) => Ok(()),
        Err(e) => Err(anyhow::anyhow!("install Ctrl+C handler: {e}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status panel
// ─────────────────────────────────────────────────────────────────────────────

/// Sticky 4-line `indicatif` panel for the dev loop, or a no-op trio of
/// `println!` calls on non-TTY.
struct StatusPanel {
    inner: PanelInner,
}

enum PanelInner {
    Sticky {
        mp: MultiProgress,
        status_pb: ProgressBar,
        endpoint_pb: ProgressBar,
        last_build_pb: ProgressBar,
        rebuilds_pb: ProgressBar,
        rebuilds: std::cell::Cell<u64>,
    },
    Plain {
        rebuilds: std::cell::Cell<u64>,
        quiet: bool,
    },
}

impl StatusPanel {
    fn new(ui: &RuntimeUi, crate_root: &std::path::Path, endpoint: Option<&EndpointFile>) -> Self {
        let endpoint_label = match endpoint {
            Some(ep) if !ep.base_url.is_empty() => ep.base_url.clone(),
            _ => "<none — rebuild only>".to_string(),
        };
        if ui.flags.quiet {
            return Self {
                inner: PanelInner::Plain {
                    rebuilds: std::cell::Cell::new(0),
                    quiet: true,
                },
            };
        }
        if !ui.is_tty {
            println!(
                "Watching {} for changes…",
                style::bold(crate_root.display().to_string())
            );
            println!("Reload endpoint: {endpoint_label}");
            return Self {
                inner: PanelInner::Plain {
                    rebuilds: std::cell::Cell::new(0),
                    quiet: false,
                },
            };
        }
        let mp = MultiProgress::new();
        let style_line =
            ProgressStyle::with_template("{msg}").unwrap_or_else(|_| ProgressStyle::default_bar());
        let title_pb = mp.add(ProgressBar::new(0));
        title_pb.set_style(style_line.clone());
        title_pb.set_message(format!(
            "{}{}",
            style::bold("cognia plugin dev "),
            style::dim(crate_root.display().to_string())
        ));
        let status_pb = mp.add(ProgressBar::new(0));
        status_pb.set_style(style_line.clone());
        let endpoint_pb = mp.add(ProgressBar::new(0));
        endpoint_pb.set_style(style_line.clone());
        endpoint_pb.set_message(format!(
            "  {} {}",
            style::dim("Endpoint   "),
            endpoint_label
        ));
        let last_build_pb = mp.add(ProgressBar::new(0));
        last_build_pb.set_style(style_line.clone());
        last_build_pb.set_message(format!(
            "  {} {}",
            style::dim("Last build "),
            style::dim("<no builds yet>")
        ));
        let rebuilds_pb = mp.add(ProgressBar::new(0));
        rebuilds_pb.set_style(style_line);
        rebuilds_pb.set_message(format!("  {} {}", style::dim("Rebuilds   "), "0"));
        Self {
            inner: PanelInner::Sticky {
                mp,
                status_pb,
                endpoint_pb,
                last_build_pb,
                rebuilds_pb,
                rebuilds: std::cell::Cell::new(0),
            },
        }
    }

    fn set_status(&self, label: &str) {
        match &self.inner {
            PanelInner::Sticky { status_pb, .. } => {
                status_pb.set_message(format!(
                    "  {} {}",
                    style::dim("Status     "),
                    style::bold(label)
                ));
            }
            PanelInner::Plain { .. } => {
                // Plain mode only prints state transitions for builds —
                // status flicker between "Watching" and "Change detected"
                // would be noise in non-TTY logs.
            }
        }
    }

    /// Record the outcome of a rebuild attempt: increment the counter,
    /// update the "Last build" line with elapsed time / outcome / clock.
    fn record_build(&self, outcome: &Result<()>, elapsed: Duration) {
        let now = Local::now().format("%H:%M:%S").to_string();
        let secs = elapsed.as_secs_f64();
        let outcome_tag = match outcome {
            Ok(_) => style::ok("ok"),
            Err(_) => style::error("fail"),
        };
        match &self.inner {
            PanelInner::Sticky {
                last_build_pb,
                rebuilds_pb,
                rebuilds,
                ..
            } => {
                let n = rebuilds.get() + 1;
                rebuilds.set(n);
                last_build_pb.set_message(format!(
                    "  {} {:.2}s @{} {}",
                    style::dim("Last build "),
                    secs,
                    style::dim(now),
                    outcome_tag
                ));
                rebuilds_pb.set_message(format!("  {} {}", style::dim("Rebuilds   "), n));
            }
            PanelInner::Plain {
                rebuilds,
                quiet: false,
            } => {
                let n = rebuilds.get() + 1;
                rebuilds.set(n);
                println!(
                    "[{now}] rebuild #{n} {} in {secs:.2}s",
                    match outcome {
                        Ok(_) => "ok",
                        Err(_) => "FAILED",
                    }
                );
            }
            PanelInner::Plain { rebuilds, .. } => {
                rebuilds.set(rebuilds.get() + 1);
            }
        }
    }

    /// Print a message that scrolls *above* the sticky panel (so cargo
    /// output and warning lines don't get clobbered).
    fn println_above(&self, msg: String) {
        match &self.inner {
            PanelInner::Sticky { mp, .. } => {
                let _ = mp.println(msg);
            }
            PanelInner::Plain { quiet: false, .. } => {
                println!("{msg}");
            }
            PanelInner::Plain { .. } => {}
        }
    }

    fn finish(&self) {
        if let PanelInner::Sticky {
            status_pb,
            endpoint_pb,
            last_build_pb,
            rebuilds_pb,
            ..
        } = &self.inner
        {
            status_pb.finish_and_clear();
            endpoint_pb.finish_and_clear();
            last_build_pb.finish_and_clear();
            rebuilds_pb.finish_and_clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn should_rebuild_classifies_change_events() {
        let create = notify::Event::new(EventKind::Create(CreateKind::File));
        let modify = notify::Event::new(EventKind::Modify(ModifyKind::Any));
        let remove = notify::Event::new(EventKind::Remove(RemoveKind::File));
        let access = notify::Event::new(EventKind::Access(notify::event::AccessKind::Open(
            notify::event::AccessMode::Any,
        )));
        assert!(should_rebuild(&create));
        assert!(should_rebuild(&modify));
        assert!(should_rebuild(&remove));
        assert!(!should_rebuild(&access));
    }

    #[test]
    fn resolve_reload_endpoint_combines_override_with_token() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        use std::io::Write;
        write!(
            tmp,
            r#"{{"baseUrl":"http://127.0.0.1:9999","devToken":"realtoken"}}"#
        )
        .unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());
        let ep = resolve_reload_endpoint(Some("http://localhost:1234"));
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        let ep = ep.expect("endpoint should resolve");
        assert_eq!(ep.base_url, "http://localhost:1234");
        assert_eq!(ep.dev_token, "realtoken");
    }

    #[test]
    fn resolve_reload_endpoint_returns_none_when_neither_source() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", "/definitely/no/such/file.json");
        let ep = resolve_reload_endpoint(None);
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        assert!(ep.is_none());
    }

    #[test]
    fn resolve_reload_endpoint_uses_override_with_empty_token() {
        let _guard = crate::shared::test_env::lock();
        let prior_endpoint = std::env::var_os("COGNIA_CLI_ENDPOINT_FILE");
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", "/definitely/no/such/file.json");
        let ep = resolve_reload_endpoint(Some("http://localhost:4321"));
        crate::shared::test_env::restore("COGNIA_CLI_ENDPOINT_FILE", prior_endpoint);
        let ep = ep.expect("override alone should resolve");
        assert_eq!(ep.base_url, "http://localhost:4321");
        assert_eq!(ep.dev_token, "");
    }

    #[test]
    fn one_interrupt_requests_a_graceful_stop() {
        let press = |s: &Arc<AtomicU8>| request_graceful_stop(s);
        let s = Arc::new(AtomicU8::new(QUIT_RUNNING));
        press(&s);
        assert_eq!(s.load(Ordering::SeqCst), QUIT_STOP_REQUESTED);
    }

    #[test]
    fn session_event_summary_redacts_absolute_paths_and_is_bounded() {
        let summary = format!(
            "failed at /Users/author/secret.ts C:\\plugin\\main.py {}",
            "x".repeat(2_000)
        );
        let sanitized = sanitize_event_summary(&summary);
        assert!(!sanitized.contains("/Users/author"));
        assert!(!sanitized.contains("C:\\plugin"));
        assert!(sanitized.chars().count() <= 1024);
    }

    #[test]
    fn status_panel_plain_records_rebuild_count() {
        // We can't easily assert printed output but we can confirm the
        // counter increments across record_build calls.
        let ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            quiet: true, // forces Plain branch
            ..crate::ui::runtime::UiFlags::default()
        });
        let panel = StatusPanel::new(&ui, std::path::Path::new("."), None);
        panel.record_build(&Ok(()), Duration::from_millis(100));
        panel.record_build(&Err(anyhow::anyhow!("boom")), Duration::from_millis(200));
        if let PanelInner::Plain { rebuilds, .. } = &panel.inner {
            assert_eq!(rebuilds.get(), 2);
        } else {
            panic!("expected Plain inner");
        }
    }

    #[test]
    fn status_panel_sticky_increments_counter() {
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        // Force sticky branch even on a non-TTY test runner.
        ui.is_tty = true;
        ui.flags.quiet = false;
        let panel = StatusPanel::new(&ui, std::path::Path::new("."), None);
        panel.set_status("Building");
        panel.record_build(&Ok(()), Duration::from_millis(50));
        panel.record_build(&Ok(()), Duration::from_millis(75));
        if let PanelInner::Sticky { rebuilds, .. } = &panel.inner {
            assert_eq!(rebuilds.get(), 2);
        } else {
            panic!("expected Sticky inner");
        }
        panel.finish();
    }

    #[test]
    fn dev_once_json_payload_is_schema_versioned() {
        let payload = DevOnceJsonPayload {
            schema_version: 1,
            ok: false,
            action: "dev",
            mode: "once",
            plugin_id: "demo".into(),
            version: "0.1.0".into(),
            plugin_type: "python".into(),
            bundle: "target/cognia/demo-0.1.0.zip".into(),
            reload: DevReloadJsonPayload::skipped("no-endpoint"),
        };

        let json = serde_json::to_value(payload).unwrap();

        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["action"], "dev");
        assert_eq!(json["mode"], "once");
        assert_eq!(json["pluginId"], "demo");
        assert_eq!(json["reload"]["attempted"], false);
        assert_eq!(json["reload"]["skippedReason"], "no-endpoint");
    }

    #[test]
    fn reload_response_requires_a_generation_backed_activation_proof() {
        let response = DevReloadResponse {
            schema_version: Some(1),
            ok: true,
            outcome: Some("activated".into()),
            activation_proof: Some(DevActivationProof {
                previous_generation: 2,
                generation: 3,
                actual_state: "active".into(),
                package_version: "1.0.0".into(),
                artifact_revision: "sha256:abc".into(),
                reload_mode: "hot".into(),
            }),
            error: None,
        };

        let payload = validate_reload_response(response, "http://127.0.0.1:7891").unwrap();
        assert_eq!(payload.ok, Some(true));
        assert_eq!(payload.outcome.as_deref(), Some("activated"));
        assert_eq!(payload.activation_proof.unwrap().generation, 3);
    }

    #[test]
    fn reload_response_from_an_unverified_old_host_is_rejected() {
        let response = DevReloadResponse {
            schema_version: None,
            ok: true,
            outcome: None,
            activation_proof: None,
            error: None,
        };

        let error = validate_reload_response(response, "http://127.0.0.1:7891").unwrap_err();
        assert!(error.to_string().contains("host_unverified"));
    }

    #[test]
    fn dev_once_failure_json_payload_is_schema_versioned() {
        let payload = DevOnceFailureJsonPayload {
            schema_version: 1,
            ok: false,
            action: "dev",
            mode: "once",
            stage: "reload",
            plugin_id: "demo".into(),
            version: "0.1.0".into(),
            plugin_type: "python".into(),
            bundle: "target/cognia/demo-0.1.0.zip".into(),
            reload: DevReloadJsonPayload {
                attempted: true,
                ok: Some(false),
                endpoint: Some("http://127.0.0.1:7891".into()),
                skipped_reason: None,
                outcome: Some("failed".into()),
                activation_proof: None,
            },
            error: DevReloadError {
                code: "plugin_not_found".into(),
                message: "reload target not installed".into(),
                action: Some("Install the plugin".into()),
                retriable: true,
            },
        };

        let json = serde_json::to_value(payload).unwrap();

        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["action"], "dev");
        assert_eq!(json["stage"], "reload");
        assert_eq!(json["pluginId"], "demo");
        assert_eq!(json["reload"]["attempted"], true);
        assert_eq!(json["reload"]["ok"], false);
        assert_eq!(json["error"]["code"], "plugin_not_found");
        assert_eq!(json["error"]["message"], "reload target not installed");
        assert_eq!(json["error"]["retriable"], true);
    }

    #[test]
    fn dev_build_error_message_labels_lint_errors() {
        let report = crate::commands::lint::LintReport {
            schema_version: 2,
            ok: false,
            action: "lint",
            stage: "validate",
            valid: false,
            manifest_path: PathBuf::from("plugin.json"),
            diagnostics: Vec::new(),
        };
        let err: anyhow::Error = crate::commands::lint::LintError { report }.into();

        assert!(dev_build_error_message(&err).contains("manifest lint failed"));
    }

    #[test]
    fn watch_paths_include_python_entry_file() {
        let root = std::path::Path::new("plugin");
        let manifest = serde_json::json!({
            "type": "python",
            "pythonMain": "main.py"
        });

        let paths = watch_paths_for(root, &manifest);

        assert!(paths.iter().any(|path| path == &root.join("main.py")));
    }

    #[test]
    fn watch_paths_include_hybrid_declared_entries() {
        let root = std::path::Path::new("plugin");
        let manifest = serde_json::json!({
            "type": "hybrid",
            "main": "frontend/index.js",
            "pythonMain": "backend/main.py",
            "styles": "styles.css"
        });

        let paths = watch_paths_for(root, &manifest);

        assert!(paths.iter().any(|path| path == &root.join("frontend")));
        assert!(paths.iter().any(|path| path == &root.join("backend")));
        assert!(paths.iter().any(|path| path == &root.join("styles.css")));
    }

    #[test]
    fn watch_paths_include_vscode_extension_entry_directory() {
        let root = std::path::Path::new("plugin");
        let manifest = serde_json::json!({
            "type": "vscode-extension",
            "vscodeMain": "extension/out/extension.js",
            "styles": "styles.css"
        });

        let paths = watch_paths_for(root, &manifest);

        assert!(paths
            .iter()
            .any(|path| path == &root.join("extension").join("out")));
        assert!(paths.iter().any(|path| path == &root.join("styles.css")));
    }

    #[test]
    fn watch_paths_ignore_absolute_and_parent_dir_manifest_paths() {
        let root = std::path::Path::new("plugin");
        let manifest = serde_json::json!({
            "main": "../outside.js",
            "pythonMain": "/tmp/outside.py",
            "bundle_include": ["assets/icon.svg", "../secret.txt"]
        });

        let paths = watch_paths_for(root, &manifest);

        assert!(!paths.iter().any(|path| path.ends_with("outside.js")));
        assert!(!paths.iter().any(|path| path.ends_with("outside.py")));
        assert!(!paths.iter().any(|path| path.ends_with("secret.txt")));
        assert!(paths.iter().any(|path| path == &root.join("assets")));
    }
}
