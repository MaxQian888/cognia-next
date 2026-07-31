//! Per-plugin virtualenv management.
//!
//! Layout: `<python_dir>/venvs/<plugin_id>/` holding a standard venv plus a
//! `.cognia-venv.json` marker (creation metadata + installed deps). A venv
//! is created lazily by `plugin_python_install_deps` (consent-gated on the
//! renderer side); once present it becomes the plugin's interpreter in
//! `load_inner`, isolating its packages from the system Python and from
//! other plugins.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::discover::Interpreter;
use super::events::{EventSink, PythonEvent};
use crate::{PluginError, Result};

/// Marker file proving the venv was created (and finished) by us.
pub const VENV_MARKER: &str = ".cognia-venv.json";

/// `<python_dir>/venvs/<plugin_id>`
pub fn venv_dir(python_dir: &Path, plugin_id: &str) -> PathBuf {
    python_dir.join("venvs").join(plugin_id)
}

/// The venv's interpreter binary (`Scripts\python.exe` on Windows,
/// `bin/python` elsewhere).
pub fn venv_python(venv: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        venv.join("Scripts").join("python.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        venv.join("bin").join("python")
    }
}

/// Resolve a plugin's venv as an [`Interpreter`] — `Some` only when both the
/// marker and the python binary exist (a half-created venv is ignored).
pub fn venv_interpreter(python_dir: &Path, plugin_id: &str) -> Option<Interpreter> {
    let dir = venv_dir(python_dir, plugin_id);
    let python = venv_python(&dir);
    if !python.is_file() || !dir.join(VENV_MARKER).is_file() {
        return None;
    }
    let version = std::fs::read_to_string(dir.join(VENV_MARKER))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|marker| {
            marker
                .get("version")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "venv".to_string());
    Some(Interpreter {
        argv_prefix: vec![python.to_string_lossy().into_owned()],
        version,
    })
}

fn emit_progress(sink: &Option<EventSink>, plugin_id: &str, phase: &str, line: String) {
    if let Some(sink) = sink {
        sink(PythonEvent {
            plugin_id: plugin_id.to_string(),
            kind: "progress".into(),
            call_id: None,
            data: json!({ "phase": phase, "message": line }),
        });
    }
}

/// Run a command streaming every stdout/stderr line as a `progress` event.
/// Returns the collected tail (last lines) for error reporting.
async fn run_streaming(
    mut cmd: Command,
    plugin_id: &str,
    phase: &str,
    sink: &Option<EventSink>,
) -> Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| PluginError::PythonHost(format!("failed to spawn {phase}: {e}")))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut tail: Vec<String> = Vec::new();

    // Drain both pipes concurrently so a chatty pip can't deadlock on a
    // full pipe buffer; collect a bounded tail for the error message.
    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(tokio::spawn(read_lines(stdout)));
    }
    if let Some(stderr) = stderr {
        readers.push(tokio::spawn(read_lines(stderr)));
    }
    for handle in readers {
        if let Ok(lines) = handle.await {
            for line in lines {
                emit_progress(sink, plugin_id, phase, line.clone());
                log::info!("[python.{plugin_id}] {phase}: {line}");
                tail.push(line);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| PluginError::PythonHost(format!("{phase} did not exit cleanly: {e}")))?;
    if !status.success() {
        return Err(PluginError::PythonHost(format!(
            "{phase} failed (exit {}): {}",
            status.code().map_or_else(|| "?".into(), |c| c.to_string()),
            tail.join(" | ")
        )));
    }
    Ok(())
}

async fn read_lines<R: tokio::io::AsyncRead + Unpin>(reader: R) -> Vec<String> {
    let mut lines = BufReader::new(reader).lines();
    let mut collected = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        collected.push(line);
    }
    collected
}

/// Create the plugin's venv if missing. Idempotent: an existing, complete
/// venv returns immediately.
pub async fn ensure_venv(
    base: &Interpreter,
    python_dir: &Path,
    plugin_id: &str,
    sink: &Option<EventSink>,
) -> Result<PathBuf> {
    let dir = venv_dir(python_dir, plugin_id);
    let python = venv_python(&dir);
    if python.is_file() && dir.join(VENV_MARKER).is_file() {
        return Ok(dir);
    }

    let (program, args) = base
        .argv_prefix
        .split_first()
        .ok_or_else(|| PluginError::PythonHost("empty interpreter argv".into()))?;
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    emit_progress(
        sink,
        plugin_id,
        "venv",
        format!("creating venv at {}", dir.display()),
    );

    let mut cmd = Command::new(program);
    cmd.args(args).arg("-m").arg("venv").arg(&dir);
    run_streaming(cmd, plugin_id, "venv", sink).await?;

    if !python.is_file() {
        return Err(PluginError::PythonHost(format!(
            "venv creation finished but {} is missing",
            python.display()
        )));
    }
    std::fs::write(
        dir.join(VENV_MARKER),
        serde_json::to_string_pretty(&json!({
            "createdAt": chrono::Utc::now().to_rfc3339(),
            "baseInterpreter": base.argv_prefix,
            "version": base.version,
            "deps": [],
        }))?,
    )?;
    Ok(dir)
}

/// `pip install` the declared dependencies into the venv, streaming pip's
/// output as progress events. Empty dep lists are a no-op.
pub async fn install_deps(
    venv_python_bin: &Path,
    deps: &[String],
    plugin_id: &str,
    sink: &Option<EventSink>,
) -> Result<()> {
    if deps.is_empty() {
        return Ok(());
    }
    let mut cmd = Command::new(venv_python_bin);
    cmd.arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-input")
        .args(deps);
    run_streaming(cmd, plugin_id, "pip", sink).await?;

    // Record what we installed in the marker (best-effort bookkeeping).
    if let Some(dir) = venv_python_bin.parent().and_then(Path::parent) {
        let marker_path = dir.join(VENV_MARKER);
        if let Ok(raw) = std::fs::read_to_string(&marker_path) {
            if let Ok(mut marker) = serde_json::from_str::<serde_json::Value>(&raw) {
                marker["deps"] = json!(deps);
                let _ = std::fs::write(
                    &marker_path,
                    serde_json::to_string_pretty(&marker).unwrap_or(raw),
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::python::discover::discover_interpreter;
    use parking_lot::Mutex;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn collector() -> (EventSink, Arc<Mutex<Vec<PythonEvent>>>) {
        let collected: Arc<Mutex<Vec<PythonEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&collected);
        let sink: EventSink = Arc::new(move |event| target.lock().push(event));
        (sink, collected)
    }

    #[test]
    fn venv_paths_are_plugin_scoped() {
        let dir = venv_dir(Path::new("/data/python"), "com.example.demo");
        assert!(dir.ends_with(Path::new("venvs").join("com.example.demo")));
        let python = venv_python(&dir);
        #[cfg(target_os = "windows")]
        assert!(python.ends_with(Path::new("Scripts").join("python.exe")));
        #[cfg(not(target_os = "windows"))]
        assert!(python.ends_with(Path::new("bin").join("python")));
    }

    #[test]
    fn venv_interpreter_requires_marker_and_binary() {
        let tmp = TempDir::new().unwrap();
        // Nothing there.
        assert!(venv_interpreter(tmp.path(), "demo").is_none());
        // Binary without marker (half-created venv) is ignored.
        let dir = venv_dir(tmp.path(), "demo");
        let python = venv_python(&dir);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        assert!(venv_interpreter(tmp.path(), "demo").is_none());
        // Marker completes the pair.
        std::fs::write(dir.join(VENV_MARKER), r#"{"version":"3.12.0"}"#).unwrap();
        let interp = venv_interpreter(tmp.path(), "demo").unwrap();
        assert_eq!(interp.version, "3.12.0");
        assert!(interp.argv_prefix[0].contains("demo"));
    }

    #[tokio::test]
    async fn install_deps_empty_is_noop_and_bogus_python_errors() {
        install_deps(Path::new("definitely-missing-python"), &[], "demo", &None)
            .await
            .unwrap();
        let err = install_deps(
            Path::new("definitely-missing-python"),
            &["requests".into()],
            "demo",
            &None,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PluginError::PythonHost(_)));
    }

    /// run_streaming forwards output lines as progress events and fails on
    /// non-zero exits with the output tail in the message.
    #[tokio::test]
    async fn run_streaming_emits_progress_and_reports_failures() {
        let Some(interp) = discover_interpreter(None) else {
            eprintln!("skipping run_streaming test: no python interpreter found");
            return;
        };
        let (program, args) = interp.argv_prefix.split_first().unwrap();

        // Success path: a line on stdout becomes a progress event.
        let (sink, collected) = collector();
        let mut cmd = Command::new(program);
        cmd.args(args).arg("-c").arg("print('hello-progress')");
        run_streaming(cmd, "demo", "pip", &Some(sink))
            .await
            .unwrap();
        assert!(collected.lock().iter().any(|e| {
            e.kind == "progress"
                && e.data["phase"] == "pip"
                && e.data["message"] == "hello-progress"
        }));

        // Failure path: exit code + stderr tail surface in the error.
        let mut cmd = Command::new(program);
        cmd.args(args)
            .arg("-c")
            .arg("import sys; print('boom', file=sys.stderr); sys.exit(3)");
        let err = run_streaming(cmd, "demo", "pip", &None).await.unwrap_err();
        let message = err.to_string();
        assert!(message.contains("exit 3"));
        assert!(message.contains("boom"));
    }

    /// Real venv creation: slow (seconds) but proves the full path on the
    /// machines/CI runners that have Python.
    #[tokio::test]
    async fn ensure_venv_creates_marker_and_interpreter() {
        let Some(interp) = discover_interpreter(None) else {
            eprintln!("skipping ensure_venv test: no python interpreter found");
            return;
        };
        let tmp = TempDir::new().unwrap();
        let (sink, collected) = collector();
        let sink = Some(sink);

        let dir = ensure_venv(&interp, tmp.path(), "demo", &sink)
            .await
            .unwrap();
        assert!(venv_python(&dir).is_file());
        let marker: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(VENV_MARKER)).unwrap()).unwrap();
        assert_eq!(marker["version"], interp.version.as_str());
        assert!(collected.lock().iter().any(|e| e.data["phase"] == "venv"));

        // Resolves as the plugin interpreter now.
        let venv_interp = venv_interpreter(tmp.path(), "demo").unwrap();
        assert_eq!(venv_interp.version, interp.version);

        // Idempotent: second call returns instantly without re-creating.
        let again = ensure_venv(&interp, tmp.path(), "demo", &None)
            .await
            .unwrap();
        assert_eq!(again, dir);
    }
}
