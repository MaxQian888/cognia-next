//! Per-plugin and shared virtualenv management.
//!
//! Two layouts, chosen per plugin:
//!
//!   * **isolated** — `<python_dir>/venvs/<plugin_id>/`, the original shape.
//!     Nothing this plugin installs can be seen by, or broken by, another.
//!   * **shared** — `<python_dir>/venvs/_shared/`, one environment several
//!     plugins draw on. Cheaper on disk and much faster to provision, but only
//!     safe while every contributor's constraints still solve together.
//!
//! A shared install is therefore *solved before it is performed*: the union of
//! every contributor's requirements plus the newcomer's is resolved as a dry
//! run, and only a solution that holds is installed. When it does not hold the
//! newcomer is given its own isolated environment and told why. The invariant
//! that buys is the important one — **a new plugin can never break a plugin
//! that already works**.
//!
//! Installers are pluggable: `uv` when it is on PATH (an order of magnitude
//! faster, and its resolver makes the dry run cheap), `pip` otherwise, or a
//! caller-supplied program driven by argv templates. A custom installer never
//! gets the shared environment, because sharing requires a dry run this crate
//! cannot express in someone else's CLI.
//!
//! Every marker records which installer built the environment. Switching
//! installers does not delete anything; the next install notices the mismatch
//! and rebuilds, which is why a switch is safe to make while offline.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::discover::Interpreter;
use super::events::{EventSink, PythonEvent};
use crate::{PluginError, Result};

/// Marker file proving the venv was created (and finished) by us.
pub const VENV_MARKER: &str = ".cognia-venv.json";

/// Directory name of the environment shared between plugins.
///
/// Not a legal plugin id (`sanitize_plugin_id` never produces a leading
/// underscore from a manifest id), so it cannot collide with an isolated one.
pub const SHARED_VENV_DIR: &str = "_shared";

/// Which environment a plugin's dependencies live in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VenvScope {
    Shared,
    Isolated,
}

impl VenvScope {
    pub fn as_str(self) -> &'static str {
        match self {
            VenvScope::Shared => "shared",
            VenvScope::Isolated => "isolated",
        }
    }

    /// Parse a manifest / settings value. Unknown values read as `Shared`,
    /// matching the default, because refusing to load a plugin over a typo in
    /// an optional field would be a worse failure than sharing.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw {
            Some("isolated") => VenvScope::Isolated,
            _ => VenvScope::Shared,
        }
    }
}

/// Caller's installer choice, straight off `PythonHostSettings`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstallerPreference {
    /// `auto` (default) | `uv` | `pip` | `custom`.
    pub kind: Option<String>,
    /// Explicit executable for `uv` / `custom`. Skips the PATH probe.
    pub path: Option<String>,
    /// `custom` only: argv after the program to create an environment.
    /// `{python}` and `{venv}` are substituted.
    pub create_args: Vec<String>,
    /// `custom` only: argv after the program to install. `{venvPython}` is
    /// substituted and `{specs}` expands to one argument per requirement.
    pub install_args: Vec<String>,
}

/// A resolved installer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Installer {
    Uv(String),
    Pip,
    Custom {
        program: String,
        create_args: Vec<String>,
        install_args: Vec<String>,
    },
}

impl Installer {
    /// Name recorded in the marker; a change here forces a rebuild.
    pub fn name(&self) -> &'static str {
        match self {
            Installer::Uv(_) => "uv",
            Installer::Pip => "pip",
            Installer::Custom { .. } => "custom",
        }
    }

    /// Whether this installer can resolve a candidate set without installing
    /// it. Sharing depends on that: without a dry run the first conflicting
    /// requirement would be discovered by breaking a plugin that worked.
    pub fn supports_shared(&self) -> bool {
        matches!(self, Installer::Uv(_) | Installer::Pip)
    }
}

/// Locate `uv`, preferring an explicit path. Validated by running it, the same
/// way the interpreter probe validates a python.
pub fn discover_uv(explicit: Option<&str>) -> Option<String> {
    if let Some(path) = explicit.map(str::trim).filter(|p| !p.is_empty()) {
        return uv_version(path).map(|_| path.to_string());
    }
    let candidate = "uv";
    uv_version(candidate).map(|_| candidate.to_string())
}

/// Public probe: `uv --version` output, or `None` when it will not run.
pub fn uv_version_of(program: &str) -> Option<String> {
    uv_version(program)
}

fn uv_version(program: &str) -> Option<String> {
    let output = std::process::Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resolve a preference into a concrete installer.
///
/// `auto` prefers `uv` and falls back to `pip`; an explicit `uv` that cannot be
/// found is an error rather than a silent downgrade, because a caller who named
/// it is relying on its resolver.
pub fn resolve_installer(pref: &InstallerPreference) -> Result<Installer> {
    match pref.kind.as_deref().unwrap_or("auto") {
        "pip" => Ok(Installer::Pip),
        "uv" => discover_uv(pref.path.as_deref())
            .map(Installer::Uv)
            .ok_or_else(|| {
                PluginError::PythonHost(
                    "uv was requested but is not installed. Install it with \
                 `python -m pip install uv`, or switch the installer to pip."
                        .into(),
                )
            }),
        "custom" => {
            let program = pref
                .path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| {
                    PluginError::PythonHost("a custom installer needs an executable path".into())
                })?;
            if pref.install_args.is_empty() {
                return Err(PluginError::PythonHost(
                    "a custom installer needs an install command template".into(),
                ));
            }
            Ok(Installer::Custom {
                program: program.to_string(),
                create_args: pref.create_args.clone(),
                install_args: pref.install_args.clone(),
            })
        }
        _ => Ok(discover_uv(pref.path.as_deref())
            .map(Installer::Uv)
            .unwrap_or(Installer::Pip)),
    }
}

/// Install `uv` using the base interpreter's pip, streaming progress.
///
/// Returns the version string it reports afterwards, so the caller can prove
/// the install took rather than assuming a zero exit meant success.
pub async fn install_uv(base: &Interpreter, sink: &Option<EventSink>) -> Result<String> {
    let (program, args) = base
        .argv_prefix
        .split_first()
        .ok_or_else(|| PluginError::PythonHost("empty interpreter argv".into()))?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--no-input")
        .arg("--upgrade")
        .arg("uv");
    run_streaming(cmd, "runtime", "uv", sink).await?;
    discover_uv(None)
        .and_then(|program| uv_version(&program))
        .ok_or_else(|| {
            PluginError::PythonHost(
                "uv installed but is not on PATH — the interpreter's scripts \
                 directory may not be in PATH for this process"
                    .into(),
            )
        })
}

/// `<python_dir>/venvs/<plugin_id>` — the isolated environment.
pub fn venv_dir(python_dir: &Path, plugin_id: &str) -> PathBuf {
    python_dir.join("venvs").join(plugin_id)
}

/// `<python_dir>/venvs/_shared` — the environment plugins share.
pub fn shared_venv_dir(python_dir: &Path) -> PathBuf {
    python_dir.join("venvs").join(SHARED_VENV_DIR)
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

/// What we know about an environment we created.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VenvMarker {
    pub created_at: String,
    pub base_interpreter: Vec<String>,
    /// Base interpreter version. A change rebuilds: a 3.11 environment is not
    /// a 3.12 one, and its `site-packages` will not import.
    pub version: String,
    /// Installer that built it. A change rebuilds — packages laid down by two
    /// different resolvers in one prefix is the shape of an unreproducible bug.
    pub installer: String,
    pub scope: String,
    /// Isolated environments: the requirements installed here.
    pub deps: Vec<String>,
    /// Shared environments: plugin id → the requirements it contributed.
    /// Sorted so the file is stable across writes.
    pub contributors: BTreeMap<String, Vec<String>>,
}

impl VenvMarker {
    /// Every requirement the environment must satisfy.
    pub fn all_requirements(&self) -> Vec<String> {
        if self.contributors.is_empty() {
            return self.deps.clone();
        }
        let mut out: Vec<String> = self
            .contributors
            .values()
            .flat_map(|deps| deps.iter().cloned())
            .collect();
        out.sort();
        out.dedup();
        out
    }
}

fn read_marker(venv: &Path) -> Option<VenvMarker> {
    let raw = std::fs::read_to_string(venv.join(VENV_MARKER)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_marker(venv: &Path, marker: &VenvMarker) -> Result<()> {
    std::fs::write(
        venv.join(VENV_MARKER),
        serde_json::to_string_pretty(marker)?,
    )?;
    Ok(())
}

/// Resolve a plugin's venv as an [`Interpreter`].
///
/// Checks the isolated environment first — a plugin that was downgraded out of
/// the shared one must keep using its own — then the shared one, and only when
/// this plugin is actually recorded as a contributor. A shared environment
/// someone else populated is not this plugin's interpreter.
pub fn venv_interpreter(python_dir: &Path, plugin_id: &str) -> Option<Interpreter> {
    if let Some(interpreter) = complete_venv(&venv_dir(python_dir, plugin_id)) {
        return Some(interpreter);
    }
    let shared = shared_venv_dir(python_dir);
    let marker = read_marker(&shared)?;
    if !marker.contributors.contains_key(plugin_id) {
        return None;
    }
    complete_venv(&shared)
}

/// `Some` only when both the marker and the python binary exist (a
/// half-created venv is ignored).
fn complete_venv(dir: &Path) -> Option<Interpreter> {
    let python = venv_python(dir);
    if !python.is_file() || !dir.join(VENV_MARKER).is_file() {
        return None;
    }
    let version = read_marker(dir)
        .map(|marker| marker.version)
        .filter(|v| !v.is_empty())
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
            generation: "installation".into(),
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
    run_streaming_collecting(&mut cmd, plugin_id, phase, sink)
        .await
        .map(|_| ())
}

/// As [`run_streaming`], but hands back the output tail on success too — the
/// dry run needs to distinguish "resolved" from "this pip is too old".
async fn run_streaming_collecting(
    cmd: &mut Command,
    plugin_id: &str,
    phase: &str,
    sink: &Option<EventSink>,
) -> Result<Vec<String>> {
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
    Ok(tail)
}

async fn read_lines<R: tokio::io::AsyncRead + Unpin>(reader: R) -> Vec<String> {
    let mut lines = BufReader::new(reader).lines();
    let mut collected = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        collected.push(line);
    }
    collected
}

/// Substitute `{...}` placeholders in a custom installer's argv template.
fn expand_template(args: &[String], vars: &[(&str, &str)], specs: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    for arg in args {
        if arg == "{specs}" {
            out.extend(specs.iter().cloned());
            continue;
        }
        let mut value = arg.clone();
        for (key, replacement) in vars {
            value = value.replace(&format!("{{{key}}}"), replacement);
        }
        out.push(value);
    }
    out
}

/// Create the environment at `dir` if it is missing, stale, or was built by a
/// different installer or interpreter version.
///
/// Idempotent, and never silently reuses an environment whose provenance no
/// longer matches — a stale reuse is the failure that produces "it works on my
/// machine" for one user and an unimportable module for the next.
pub async fn ensure_venv_at(
    base: &Interpreter,
    dir: &Path,
    plugin_id: &str,
    installer: &Installer,
    sink: &Option<EventSink>,
) -> Result<VenvMarker> {
    let python = venv_python(dir);
    if python.is_file() {
        if let Some(marker) = read_marker(dir) {
            let compatible = marker.installer == installer.name() && marker.version == base.version;
            if compatible {
                return Ok(marker);
            }
            emit_progress(
                sink,
                plugin_id,
                "venv",
                format!(
                    "rebuilding {}: built with {} on {}, now using {} on {}",
                    dir.display(),
                    if marker.installer.is_empty() {
                        "an unknown installer"
                    } else {
                        &marker.installer
                    },
                    if marker.version.is_empty() {
                        "an unknown interpreter"
                    } else {
                        &marker.version
                    },
                    installer.name(),
                    base.version,
                ),
            );
        }
        // Missing marker or a mismatch: start clean rather than layering.
        std::fs::remove_dir_all(dir).ok();
    }

    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    emit_progress(
        sink,
        plugin_id,
        "venv",
        format!(
            "creating venv at {} with {}",
            dir.display(),
            installer.name()
        ),
    );

    let (program, args) = base
        .argv_prefix
        .split_first()
        .ok_or_else(|| PluginError::PythonHost("empty interpreter argv".into()))?;

    let cmd = match installer {
        Installer::Uv(uv) => {
            let mut cmd = Command::new(uv);
            cmd.arg("venv").arg("--python").arg(program).arg(dir);
            cmd
        }
        Installer::Pip => {
            let mut cmd = Command::new(program);
            cmd.args(args).arg("-m").arg("venv").arg(dir);
            cmd
        }
        Installer::Custom {
            program: custom,
            create_args,
            ..
        } => {
            if create_args.is_empty() {
                // No create template: fall back to the stdlib module, which is
                // what almost every tool wraps anyway.
                let mut cmd = Command::new(program);
                cmd.args(args).arg("-m").arg("venv").arg(dir);
                cmd
            } else {
                let mut cmd = Command::new(custom);
                cmd.args(expand_template(
                    create_args,
                    &[("python", program), ("venv", &dir.to_string_lossy())],
                    &[],
                ));
                cmd
            }
        }
    };
    run_streaming(cmd, plugin_id, "venv", sink).await?;

    if !python.is_file() {
        return Err(PluginError::PythonHost(format!(
            "venv creation finished but {} is missing",
            python.display()
        )));
    }
    let marker = VenvMarker {
        created_at: chrono::Utc::now().to_rfc3339(),
        base_interpreter: base.argv_prefix.clone(),
        version: base.version.clone(),
        installer: installer.name().to_string(),
        scope: String::new(),
        deps: Vec::new(),
        contributors: BTreeMap::new(),
    };
    write_marker(dir, &marker)?;
    Ok(marker)
}

/// Backwards-compatible wrapper: create a plugin's isolated environment with
/// the default installer. Retained because it is the shape the existing tests
/// and the simple path both use.
pub async fn ensure_venv(
    base: &Interpreter,
    python_dir: &Path,
    plugin_id: &str,
    sink: &Option<EventSink>,
) -> Result<PathBuf> {
    let dir = venv_dir(python_dir, plugin_id);
    let installer = resolve_installer(&InstallerPreference::default())?;
    ensure_venv_at(base, &dir, plugin_id, &installer, sink).await?;
    Ok(dir)
}

/// Resolve `specs` against `venv` without installing anything.
///
/// `Ok(())` means the set has a solution. `Err` means it does not — or that
/// the installer could not tell us, which is treated the same way on purpose:
/// the caller uses this to decide whether sharing is safe, and "I don't know"
/// must not read as "yes".
pub async fn dry_run_resolve(
    installer: &Installer,
    venv: &Path,
    specs: &[String],
    plugin_id: &str,
    sink: &Option<EventSink>,
) -> Result<()> {
    if specs.is_empty() {
        return Ok(());
    }
    let python = venv_python(venv);
    let mut cmd = match installer {
        Installer::Uv(uv) => {
            let mut cmd = Command::new(uv);
            cmd.arg("pip")
                .arg("install")
                .arg("--dry-run")
                .arg("--python")
                .arg(&python)
                .args(specs);
            cmd
        }
        Installer::Pip => {
            let mut cmd = Command::new(&python);
            cmd.arg("-m")
                .arg("pip")
                .arg("install")
                .arg("--dry-run")
                .arg("--no-input")
                .args(specs);
            cmd
        }
        Installer::Custom { .. } => {
            return Err(PluginError::PythonHost(
                "a custom installer cannot resolve without installing".into(),
            ))
        }
    };
    let tail = run_streaming_collecting(&mut cmd, plugin_id, "resolve", sink).await?;
    // pip gained `--dry-run` in 22.2. An older one exits non-zero on the
    // unknown flag and is caught above; a *newer* pip that ignores it would
    // have installed, which we would rather notice here than in production.
    if tail.iter().any(|line| line.contains("no such option")) {
        return Err(PluginError::PythonHost(
            "this pip is too old to resolve without installing (needs 22.2+)".into(),
        ));
    }
    Ok(())
}

/// `pip install` / `uv pip install` the given requirements into `venv`.
pub async fn install_into(
    installer: &Installer,
    venv: &Path,
    specs: &[String],
    plugin_id: &str,
    sink: &Option<EventSink>,
) -> Result<()> {
    if specs.is_empty() {
        return Ok(());
    }
    let python = venv_python(venv);
    let cmd = match installer {
        Installer::Uv(uv) => {
            let mut cmd = Command::new(uv);
            cmd.arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&python)
                .args(specs);
            cmd
        }
        Installer::Pip => {
            let mut cmd = Command::new(&python);
            cmd.arg("-m")
                .arg("pip")
                .arg("install")
                .arg("--no-input")
                .args(specs);
            cmd
        }
        Installer::Custom {
            program,
            install_args,
            ..
        } => {
            let mut cmd = Command::new(program);
            cmd.args(expand_template(
                install_args,
                &[
                    ("venvPython", &python.to_string_lossy()),
                    ("venv", &venv.to_string_lossy()),
                ],
                specs,
            ));
            cmd
        }
    };
    run_streaming(cmd, plugin_id, "install", sink).await
}

/// Legacy entry point: install into an environment identified by its python.
/// Kept for the callers (and tests) that already hold that path.
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

    if let Some(dir) = venv_python_bin.parent().and_then(Path::parent) {
        let mut marker = read_marker(dir).unwrap_or_default();
        marker.deps = deps.to_vec();
        let _ = write_marker(dir, &marker);
    }
    Ok(())
}

/// Where a plugin's dependencies ended up, and why.
#[derive(Debug, Clone)]
pub struct ProvisionOutcome {
    pub venv_dir: PathBuf,
    pub scope: VenvScope,
    pub installer: String,
    /// Set when a shared install was requested and could not be honoured.
    /// Surfaced to the user rather than swallowed: "my plugin has its own
    /// 400 MB environment" deserves an explanation.
    pub downgraded_reason: Option<String>,
}

/// Provision `dependencies` for one plugin, sharing when it is safe to.
pub async fn provision_dependencies(
    base: &Interpreter,
    python_dir: &Path,
    plugin_id: &str,
    dependencies: &[String],
    requested: VenvScope,
    installer: &Installer,
    sink: &Option<EventSink>,
) -> Result<ProvisionOutcome> {
    let mut downgraded_reason: Option<String> = None;

    if requested == VenvScope::Shared {
        if !installer.supports_shared() {
            downgraded_reason = Some(format!(
                "the {} installer cannot resolve without installing, so it cannot \
                 share an environment safely",
                installer.name()
            ));
        } else {
            match try_shared(base, python_dir, plugin_id, dependencies, installer, sink).await {
                Ok(outcome) => return Ok(outcome),
                Err(reason) => downgraded_reason = Some(reason),
            }
        }
    }

    // Isolated: also evict this plugin from the shared environment, so a
    // downgrade does not leave it resolving against packages it no longer
    // contributes to.
    forget_shared_contributor(python_dir, plugin_id);

    let dir = venv_dir(python_dir, plugin_id);
    let mut marker = ensure_venv_at(base, &dir, plugin_id, installer, sink).await?;
    install_into(installer, &dir, dependencies, plugin_id, sink).await?;
    marker.scope = VenvScope::Isolated.as_str().to_string();
    marker.deps = dependencies.to_vec();
    marker.contributors.clear();
    write_marker(&dir, &marker)?;

    Ok(ProvisionOutcome {
        venv_dir: dir,
        scope: VenvScope::Isolated,
        installer: installer.name().to_string(),
        downgraded_reason,
    })
}

/// Try the shared environment. `Err(reason)` means "use an isolated one", and
/// the shared environment is left exactly as it was.
async fn try_shared(
    base: &Interpreter,
    python_dir: &Path,
    plugin_id: &str,
    dependencies: &[String],
    installer: &Installer,
    sink: &Option<EventSink>,
) -> std::result::Result<ProvisionOutcome, String> {
    let dir = shared_venv_dir(python_dir);
    let mut marker = ensure_venv_at(base, &dir, plugin_id, installer, sink)
        .await
        .map_err(|error| format!("could not prepare the shared environment: {error}"))?;

    // Solve the whole set, not just the newcomer: a requirement that is fine
    // alone can still be unsatisfiable beside what is already installed.
    let mut candidate = marker.contributors.clone();
    candidate.insert(plugin_id.to_string(), dependencies.to_vec());
    let mut union: Vec<String> = candidate.values().flat_map(|d| d.iter().cloned()).collect();
    union.sort();
    union.dedup();

    if let Err(error) = dry_run_resolve(installer, &dir, &union, plugin_id, sink).await {
        return Err(format!(
            "its requirements do not resolve alongside the other plugins sharing \
             this environment ({error})"
        ));
    }

    install_into(installer, &dir, dependencies, plugin_id, sink)
        .await
        .map_err(|error| format!("installing into the shared environment failed: {error}"))?;

    marker.scope = VenvScope::Shared.as_str().to_string();
    marker.contributors = candidate;
    marker.deps.clear();
    write_marker(&dir, &marker)
        .map_err(|error| format!("could not record the shared environment: {error}"))?;

    Ok(ProvisionOutcome {
        venv_dir: dir,
        scope: VenvScope::Shared,
        installer: installer.name().to_string(),
        downgraded_reason: None,
    })
}

/// Drop a plugin from the shared environment's contributor list.
///
/// The packages stay: removing them could break another contributor that came
/// to depend on a transitive one, and disk is cheaper than that.
pub fn forget_shared_contributor(python_dir: &Path, plugin_id: &str) {
    let dir = shared_venv_dir(python_dir);
    let Some(mut marker) = read_marker(&dir) else {
        return;
    };
    if marker.contributors.remove(plugin_id).is_some() {
        let _ = write_marker(&dir, &marker);
    }
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

    fn fake_interpreter() -> Interpreter {
        Interpreter {
            argv_prefix: vec!["python3".into()],
            version: "3.12.0".into(),
        }
    }

    fn seed_venv(dir: &Path, marker: &VenvMarker) {
        let python = venv_python(dir);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        write_marker(dir, marker).unwrap();
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
    fn shared_dir_cannot_collide_with_a_plugin_id() {
        // `sanitize_plugin_id` never yields a leading underscore, so the
        // shared directory name is unreachable as an isolated one.
        let shared = shared_venv_dir(Path::new("/data/python"));
        assert!(shared.ends_with(Path::new("venvs").join(SHARED_VENV_DIR)));
        assert_ne!(shared, venv_dir(Path::new("/data/python"), "shared"));
    }

    #[test]
    fn venv_interpreter_requires_marker_and_binary() {
        let tmp = TempDir::new().unwrap();
        assert!(venv_interpreter(tmp.path(), "demo").is_none());
        let dir = venv_dir(tmp.path(), "demo");
        let python = venv_python(&dir);
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "").unwrap();
        assert!(venv_interpreter(tmp.path(), "demo").is_none());
        std::fs::write(dir.join(VENV_MARKER), r#"{"version":"3.12.0"}"#).unwrap();
        let interp = venv_interpreter(tmp.path(), "demo").unwrap();
        assert_eq!(interp.version, "3.12.0");
        assert!(interp.argv_prefix[0].contains("demo"));
    }

    #[test]
    fn venv_interpreter_uses_the_shared_env_only_for_its_contributors() {
        let tmp = TempDir::new().unwrap();
        let mut marker = VenvMarker {
            version: "3.12.0".into(),
            installer: "uv".into(),
            scope: "shared".into(),
            ..Default::default()
        };
        marker
            .contributors
            .insert("sharer".into(), vec!["requests".into()]);
        seed_venv(&shared_venv_dir(tmp.path()), &marker);

        let shared = venv_interpreter(tmp.path(), "sharer").unwrap();
        assert!(shared.argv_prefix[0].contains(SHARED_VENV_DIR));
        // A plugin that never contributed must not inherit someone else's
        // packages just because the directory exists.
        assert!(venv_interpreter(tmp.path(), "stranger").is_none());
    }

    #[test]
    fn an_isolated_env_wins_over_the_shared_one() {
        // The order matters for a plugin that was downgraded out of sharing:
        // it must keep resolving against its own environment.
        let tmp = TempDir::new().unwrap();
        let mut shared_marker = VenvMarker {
            version: "3.12.0".into(),
            ..Default::default()
        };
        shared_marker
            .contributors
            .insert("demo".into(), vec!["a".into()]);
        seed_venv(&shared_venv_dir(tmp.path()), &shared_marker);
        seed_venv(
            &venv_dir(tmp.path(), "demo"),
            &VenvMarker {
                version: "3.12.0".into(),
                scope: "isolated".into(),
                ..Default::default()
            },
        );

        let interp = venv_interpreter(tmp.path(), "demo").unwrap();
        assert!(interp.argv_prefix[0].contains("demo"));
        assert!(!interp.argv_prefix[0].contains(SHARED_VENV_DIR));
    }

    #[test]
    fn marker_reports_every_requirement_for_both_layouts() {
        let isolated = VenvMarker {
            deps: vec!["b".into(), "a".into()],
            ..Default::default()
        };
        assert_eq!(isolated.all_requirements(), vec!["b", "a"]);

        let mut shared = VenvMarker::default();
        shared.contributors.insert("one".into(), vec!["a".into()]);
        shared
            .contributors
            .insert("two".into(), vec!["b".into(), "a".into()]);
        assert_eq!(shared.all_requirements(), vec!["a", "b"]);
    }

    #[test]
    fn installer_preference_resolves_and_reports_a_missing_uv() {
        assert_eq!(
            resolve_installer(&InstallerPreference {
                kind: Some("pip".into()),
                ..Default::default()
            })
            .unwrap(),
            Installer::Pip
        );

        // An explicitly requested uv that is absent is an error, not a silent
        // downgrade: the caller asked for its resolver.
        let missing = resolve_installer(&InstallerPreference {
            kind: Some("uv".into()),
            path: Some("definitely-not-uv-anywhere".into()),
            ..Default::default()
        })
        .unwrap_err()
        .to_string();
        assert!(missing.contains("pip install uv"), "{missing}");

        // Auto never fails: it falls back to pip.
        assert!(resolve_installer(&InstallerPreference::default()).is_ok());
    }

    #[test]
    fn a_custom_installer_needs_a_program_and_an_install_template() {
        assert!(resolve_installer(&InstallerPreference {
            kind: Some("custom".into()),
            ..Default::default()
        })
        .is_err());
        assert!(resolve_installer(&InstallerPreference {
            kind: Some("custom".into()),
            path: Some("/usr/bin/poetry".into()),
            ..Default::default()
        })
        .is_err());
        let ok = resolve_installer(&InstallerPreference {
            kind: Some("custom".into()),
            path: Some("/usr/bin/poetry".into()),
            install_args: vec!["add".into(), "{specs}".into()],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(ok.name(), "custom");
        // And it can never take the shared environment.
        assert!(!ok.supports_shared());
        assert!(Installer::Pip.supports_shared());
    }

    #[test]
    fn custom_templates_expand_placeholders_and_fan_out_specs() {
        let args = expand_template(
            &[
                "install".into(),
                "--python".into(),
                "{venvPython}".into(),
                "{specs}".into(),
            ],
            &[("venvPython", "/v/bin/python")],
            &["a==1".into(), "b".into()],
        );
        assert_eq!(args, ["install", "--python", "/v/bin/python", "a==1", "b"]);
    }

    #[tokio::test]
    async fn ensure_venv_rebuilds_when_the_installer_or_interpreter_changed() {
        let tmp = TempDir::new().unwrap();
        let dir = venv_dir(tmp.path(), "demo");
        seed_venv(
            &dir,
            &VenvMarker {
                version: "3.12.0".into(),
                installer: "pip".into(),
                ..Default::default()
            },
        );
        let (sink, collected) = collector();
        let sink = Some(sink);

        // Same installer + version: reused, no rebuild, no subprocess.
        let marker = ensure_venv_at(&fake_interpreter(), &dir, "demo", &Installer::Pip, &sink)
            .await
            .unwrap();
        assert_eq!(marker.installer, "pip");
        assert!(collected.lock().is_empty(), "reuse must not announce work");

        // A different installer must not layer packages from two resolvers
        // into one prefix — it rebuilds. Whether the rebuild then succeeds
        // depends on the machine (this asserts against a seeded fake venv, and
        // uv may or may not be installed), so the invariant under test is that
        // it did not silently reuse: it announced the rebuild, and on success
        // the recorded provenance is the new installer's.
        let rebuilt = ensure_venv_at(
            &fake_interpreter(),
            &dir,
            "demo",
            &Installer::Uv("uv".into()),
            &sink,
        )
        .await;
        assert!(
            collected.lock().iter().any(|e| e.data["message"]
                .as_str()
                .is_some_and(|m| m.contains("rebuilding"))),
            "a rebuild must be explained, not silent"
        );
        if let Ok(marker) = rebuilt {
            assert_eq!(marker.installer, "uv");
            assert!(marker.deps.is_empty(), "a rebuilt env starts empty");
        }
    }

    #[tokio::test]
    async fn a_custom_installer_is_never_given_the_shared_environment() {
        let tmp = TempDir::new().unwrap();
        let installer = Installer::Custom {
            program: "definitely-missing-installer".into(),
            create_args: vec![],
            install_args: vec!["install".into(), "{specs}".into()],
        };
        // Creation is attempted in the isolated location; it fails because the
        // fake interpreter cannot make a venv, but the shared directory must
        // never have been touched.
        let _ = provision_dependencies(
            &fake_interpreter(),
            tmp.path(),
            "demo",
            &["requests".into()],
            VenvScope::Shared,
            &installer,
            &None,
        )
        .await;
        assert!(
            !shared_venv_dir(tmp.path()).exists(),
            "an installer that cannot dry-run must not create the shared env"
        );
    }

    #[test]
    fn forgetting_a_contributor_leaves_the_others_alone() {
        let tmp = TempDir::new().unwrap();
        let dir = shared_venv_dir(tmp.path());
        let mut marker = VenvMarker {
            version: "3.12.0".into(),
            ..Default::default()
        };
        marker.contributors.insert("a".into(), vec!["x".into()]);
        marker.contributors.insert("b".into(), vec!["y".into()]);
        seed_venv(&dir, &marker);

        forget_shared_contributor(tmp.path(), "a");
        let after = read_marker(&dir).unwrap();
        assert!(!after.contributors.contains_key("a"));
        assert_eq!(after.contributors.get("b").unwrap(), &vec!["y".to_string()]);
        // Packages are deliberately left in place — another contributor may
        // have come to depend on a transitive one.
        assert!(venv_python(&dir).is_file());

        // Forgetting an absent plugin is a no-op, not an error.
        forget_shared_contributor(tmp.path(), "ghost");
        forget_shared_contributor(tmp.path(), "a");
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

    #[tokio::test]
    async fn dry_run_refuses_to_guess_for_a_custom_installer() {
        // "I don't know" must not read as "yes" — that is the whole basis for
        // deciding sharing is safe.
        let err = dry_run_resolve(
            &Installer::Custom {
                program: "x".into(),
                create_args: vec![],
                install_args: vec!["{specs}".into()],
            },
            Path::new("/tmp/venv"),
            &["requests".into()],
            "demo",
            &None,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("cannot resolve without installing"), "{err}");

        // An empty set trivially resolves whatever the installer.
        dry_run_resolve(&Installer::Pip, Path::new("/tmp/venv"), &[], "demo", &None)
            .await
            .unwrap();
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
        let marker = read_marker(&dir).unwrap();
        assert_eq!(marker.version, interp.version);
        assert!(!marker.installer.is_empty(), "provenance must be recorded");
        assert!(collected.lock().iter().any(|e| e.data["phase"] == "venv"));

        let venv_interp = venv_interpreter(tmp.path(), "demo").unwrap();
        assert_eq!(venv_interp.version, interp.version);

        let again = ensure_venv(&interp, tmp.path(), "demo", &None)
            .await
            .unwrap();
        assert_eq!(again, dir);
    }

    /// The shared path end to end, on a machine that has Python: two plugins
    /// with compatible requirements land in one environment.
    #[tokio::test]
    async fn compatible_plugins_share_one_environment() {
        let Some(interp) = discover_interpreter(None) else {
            eprintln!("skipping shared venv test: no python interpreter found");
            return;
        };
        let tmp = TempDir::new().unwrap();
        let installer = resolve_installer(&InstallerPreference::default()).unwrap();

        // No requirements at all: nothing to resolve, so sharing always holds.
        let first = provision_dependencies(
            &interp,
            tmp.path(),
            "one",
            &[],
            VenvScope::Shared,
            &installer,
            &None,
        )
        .await
        .unwrap();
        assert_eq!(first.scope, VenvScope::Shared);
        assert!(first.downgraded_reason.is_none());

        let second = provision_dependencies(
            &interp,
            tmp.path(),
            "two",
            &[],
            VenvScope::Shared,
            &installer,
            &None,
        )
        .await
        .unwrap();
        assert_eq!(second.venv_dir, first.venv_dir);

        let marker = read_marker(&first.venv_dir).unwrap();
        assert_eq!(marker.contributors.len(), 2);
        assert!(venv_interpreter(tmp.path(), "one").is_some());
        assert!(venv_interpreter(tmp.path(), "two").is_some());
    }

    /// The invariant the dry run exists for: a newcomer whose requirements do
    /// not resolve beside the existing contributors is given its own
    /// environment, and the shared one is left exactly as it was.
    ///
    /// Offline by construction — the blocking requirement is unparseable, so
    /// no resolver reaches an index to decide it.
    #[tokio::test]
    async fn a_conflicting_plugin_is_downgraded_and_the_shared_env_is_untouched() {
        let Some(interp) = discover_interpreter(None) else {
            eprintln!("skipping downgrade test: no python interpreter found");
            return;
        };
        let installer = resolve_installer(&InstallerPreference::default()).unwrap();
        let tmp = TempDir::new().unwrap();

        // An existing contributor whose requirement cannot be satisfied.
        provision_dependencies(
            &interp,
            tmp.path(),
            "incumbent",
            &[],
            VenvScope::Shared,
            &installer,
            &None,
        )
        .await
        .unwrap();
        let shared = shared_venv_dir(tmp.path());
        let mut marker = read_marker(&shared).unwrap();
        marker.contributors.insert(
            "incumbent".into(),
            vec!["this is not a requirement ==".into()],
        );
        write_marker(&shared, &marker).unwrap();

        let outcome = provision_dependencies(
            &interp,
            tmp.path(),
            "newcomer",
            &[],
            VenvScope::Shared,
            &installer,
            &None,
        )
        .await
        .unwrap();

        assert_eq!(outcome.scope, VenvScope::Isolated);
        let reason = outcome.downgraded_reason.expect("a downgrade must say why");
        assert!(reason.contains("do not resolve alongside"), "{reason}");
        assert!(outcome.venv_dir.ends_with("newcomer"));

        // The shared environment kept its incumbent and never gained the
        // newcomer: an install that could not be proven safe was not performed.
        let after = read_marker(&shared).unwrap();
        assert!(after.contributors.contains_key("incumbent"));
        assert!(!after.contributors.contains_key("newcomer"));

        // And each plugin resolves to the environment it actually owns.
        assert!(venv_interpreter(tmp.path(), "incumbent")
            .unwrap()
            .argv_prefix[0]
            .contains(SHARED_VENV_DIR));
        assert!(venv_interpreter(tmp.path(), "newcomer")
            .unwrap()
            .argv_prefix[0]
            .contains("newcomer"));
    }

    /// A plugin that asks for isolation gets it, and is evicted from the
    /// shared contributor list on the way.
    #[tokio::test]
    async fn requesting_isolation_evicts_the_plugin_from_the_shared_list() {
        let Some(interp) = discover_interpreter(None) else {
            eprintln!("skipping isolation test: no python interpreter found");
            return;
        };
        let tmp = TempDir::new().unwrap();
        let installer = resolve_installer(&InstallerPreference::default()).unwrap();

        provision_dependencies(
            &interp,
            tmp.path(),
            "demo",
            &[],
            VenvScope::Shared,
            &installer,
            &None,
        )
        .await
        .unwrap();
        assert!(read_marker(&shared_venv_dir(tmp.path()))
            .unwrap()
            .contributors
            .contains_key("demo"));

        let isolated = provision_dependencies(
            &interp,
            tmp.path(),
            "demo",
            &[],
            VenvScope::Isolated,
            &installer,
            &None,
        )
        .await
        .unwrap();
        assert_eq!(isolated.scope, VenvScope::Isolated);
        assert!(!read_marker(&shared_venv_dir(tmp.path()))
            .unwrap()
            .contributors
            .contains_key("demo"));
        // And the plugin now resolves to its own environment.
        let interp_now = venv_interpreter(tmp.path(), "demo").unwrap();
        assert!(interp_now.argv_prefix[0].contains("demo"));
    }
}
