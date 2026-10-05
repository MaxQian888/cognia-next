//! Mandatory sandbox wrapper for the **desktop** external-agent spawn path.
//!
//! ADR-0077 states that Cognia "never falls back to an unsandboxed process",
//! and ADR-0119 restates it for Pi. Until this module existed that guarantee
//! held only on the CLI host: `cli/src/runtime/external/sandbox-launcher.ts`
//! rewrites every spawn into `cognia-external-agent-launcher … -- <command>`,
//! while the Tauri command called [`crate::exec_backend::spawn_with_events`]
//! directly — no launcher, no policy, inherited env.
//!
//! The gap was not a caller-trust question. `SpawnPolicy`'s own docstring
//! reasons that "on the desktop the surface never existed (the WebView calls
//! the Tauri command locally)", which is true of *who asks for* the spawn and
//! irrelevant to *what the spawned agent then does*: the agent is the untrusted
//! party, it runs a model, and that model has `bash`.
//!
//! This module is the Rust port of the TypeScript launcher wrapper. The two are
//! deliberately duplicated rather than shared — the desktop cannot call into
//! the CLI's Node code — so the writable-root tables below and
//! `agentStateWritableRoots` in that file must stay in union. A root present in
//! one and missing from the other silently costs an agent its credential store.
//!
//! What this module does NOT do is confine the working directory to the
//! workspaces root the way [`crate::presets::SpawnPolicy`] does. That
//! confinement exists because a *remote* client picks the headless cwd; on the
//! desktop the cwd comes from `agent.config.process.cwd`, a path the local user
//! typed into settings. Desktop confinement is instead enforced by the
//! launcher's own `--cwd` / `--writable` scope, which is the same mechanism the
//! CLI relies on.

use std::path::{Path, PathBuf};

use super::process::ExternalAgentSpawnConfig;

/// Explicit launcher override. Same variable the CLI honours, so a developer
/// pointing one host at a freshly built launcher points both.
pub const LAUNCHER_ENV: &str = "COGNIA_EXTERNAL_AGENT_LAUNCHER";

/// Why a spawn was refused. Every variant is a refusal — there is no variant
/// that means "continue unsandboxed", which is the point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    /// Not macOS or Linux: no Seatbelt, no bubblewrap, no sandbox.
    UnsupportedPlatform(String),
    /// The launcher binary is missing or not executable.
    LauncherUnavailable(String),
    /// The launcher needs a concrete directory to scope the sandbox to.
    MissingCwd,
    /// No home directory to derive agent state roots from.
    MissingHome,
    InvalidQoderConfigDir,
    InvalidClineConfigDir,
    InvalidKimiConfigDir,
    /// The configuration asked for a private state root
    /// ([`crate::state_isolation`]) and it could not be provided. Refusing is
    /// the only safe answer: launching anyway would hand the agent the user's
    /// own login.
    StateIsolation(String),
}

impl SandboxError {
    /// Stable reason code for the renderer, matching the one ADR-0119 names.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::StateIsolation(_) => "state_isolation_failed",
            _ => "sandbox_unavailable",
        }
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedPlatform(os) => write!(
                f,
                "External agents are not available on {os}: they require a strict sandbox \
                 (macOS Seatbelt or Linux bubblewrap), and Cognia never runs them unsandboxed."
            ),
            Self::LauncherUnavailable(command) => write!(
                f,
                "Can't launch \"{command}\": the external-agent sandbox launcher is unavailable. \
                 Cognia only runs external agents inside a strict sandbox and never falls back to \
                 an unsandboxed process. Reinstall the desktop app, or point \
                 {LAUNCHER_ENV} at a built launcher."
            ),
            Self::MissingCwd => write!(
                f,
                "The external-agent sandbox requires a working directory; set one on the agent \
                 before starting a session."
            ),
            Self::InvalidClineConfigDir => write!(f, "Cline ACP requires a nonempty --config or CLINE_DIR inside the Bot state directory when isolated; --data-dir is unsupported in ACP."),
            Self::InvalidKimiConfigDir => write!(f, "Kimi state directory must be nonempty and stay inside the Bot state directory when isolated."),
            Self::InvalidQoderConfigDir => write!(f, "Qoder config directory must be nonempty and stay inside the Bot state directory when isolated."),
            Self::MissingHome => write!(
                f,
                "The external-agent sandbox could not determine this user's home directory."
            ),
            Self::StateIsolation(reason) => write!(
                f,
                "This agent configuration uses its own isolated state, which could not be \
                 prepared: {reason}"
            ),
        }
    }
}

impl std::error::Error for SandboxError {}

/// Can this platform host external agents at all? Fails closed off macOS/Linux.
///
/// Takes the OS as a parameter rather than reading `cfg!` so every branch is
/// reachable from a test on any host.
pub fn sandbox_supports_os(os: &str) -> bool {
    matches!(os, "macos" | "linux")
}

/// Platform-correct launcher filename.
pub fn launcher_file_name(os: &str) -> &'static str {
    if os == "windows" {
        "cognia-external-agent-launcher.exe"
    } else {
        "cognia-external-agent-launcher"
    }
}

/// Strip a Windows executable suffix and lower-case, matching the CLI's
/// `command.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "")`.
pub(crate) fn base_command(command: &str) -> String {
    let lower = command.trim().to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    lower
}

/// Home-relative state directories the agent must be able to write.
///
/// Mirrors `agentStateWritableRoots.rules` in
/// `protocol/external-agent-security-policy.json`, which the TypeScript
/// launcher (`cli/src/runtime/external/sandbox-launcher.ts`) now consumes
/// directly. `pnpm audit:agent-capabilities` fails when the two disagree —
/// while the only link was a "keep the two in union" comment, both sides
/// silently lacked an OpenCode rule, so `opencode serve` ran with its session
/// store outside the sandbox scope and resume started over every time.
pub fn agent_state_writable_roots(command: &str, args: &[String], home: &Path) -> Vec<PathBuf> {
    let base = base_command(command);
    // `npx <package>` runs the package, so the state dir belongs to the
    // package, not to npx.
    let npx_package = if base == "npx" {
        args.iter().find(|arg| !arg.starts_with('-')).cloned()
    } else {
        None
    };
    let target = npx_package.unwrap_or_else(|| base.clone());

    let mut roots = Vec::new();
    if target.contains("codex") {
        roots.push(home.join(".codex"));
    }
    if target.contains("claude") {
        roots.push(home.join(".claude"));
        roots.push(home.join(".claude.json"));
        roots.push(home.join(".claude.json.backup"));
    }
    if target.contains("gemini") {
        roots.push(home.join(".gemini"));
    }
    if target.contains("qwen") {
        roots.push(home.join(".qwen"));
    }
    // Pi's session store, for the native binary the pi-rpc adapter drives
    // (ADR-0119). Matched on `base` rather than `contains` because "copilot"
    // contains "pi". Without this root Pi cannot persist a session, so
    // `--session-id` resume silently starts fresh.
    if base == "pi" {
        roots.push(home.join(".pi"));
    }
    if base == "kimi" {
        roots.push(home.join(".kimi-code"));
    }
    if base == "cline" {
        roots.push(home.join(".cline"));
    }
    if base == "qoder" {
        roots.push(home.join(".qoder"));
    }
    if base == "goose" {
        roots.push(home.join(".config/goose"));
        roots.push(home.join(".local/share/goose"));
        roots.push(home.join(".local/state/goose"));
        roots.push(home.join("Library/Application Support/Block/goose"));
    }
    if base == "devin" {
        roots.push(home.join(".config").join("devin"));
        roots.push(home.join(".local").join("share").join("devin"));
        roots.push(home.join(".cache").join("devin"));
    }
    if target.contains("copilot") {
        roots.push(home.join(".copilot"));
        roots.push(home.join(".cache").join("copilot"));
    }
    if target.contains("kiro") {
        roots.push(home.join(".kiro"));
    }
    if target.contains("droid") || target.contains("factory") {
        roots.push(home.join(".factory"));
    }
    if target.contains("cursor") {
        roots.push(home.join(".cursor"));
    }
    if target.contains("opencode") {
        // OpenCode is XDG-style on every platform (see
        // `crates/cognia-agent-state/src/session_import.rs`): the config lives
        // under `~/.config/opencode` and the session database under
        // `~/.local/share/opencode`.
        roots.push(home.join(".config").join("opencode"));
        roots.push(home.join(".local").join("share").join("opencode"));
    }
    if base == "npx" {
        roots.push(home.join(".npm"));
    }
    roots
}

/// `.claude.json` and friends are files; everything else is a directory.
/// Pre-creating them matters because a sandbox scope naming a path that does
/// not exist is not the same as one naming an empty file.
fn is_state_file_root(root: &Path) -> bool {
    root.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(".claude.json"))
        .unwrap_or(false)
}

/// Narrow host directory exposed inside the sandbox for the tool-host socket.
///
/// Port of `toolHostRuntimeDir` (cli/src/agent/tool-host/protocol.ts). Linux
/// mounts `/tmp` as a private tmpfs inside the sandbox, so a broker socket in
/// the temp root would be unreachable; binding this one directory keeps the
/// rest of the host temp tree hidden. Stage 2 puts a socket here on desktop.
pub fn tool_host_runtime_dir(temp_root: &Path, uid: Option<u32>) -> PathBuf {
    let suffix = uid
        .map(|value| value.to_string())
        .unwrap_or_else(|| "user".to_string());
    temp_root.join(format!("cognia-toolhost-{suffix}"))
}

/// Build the launcher argv.
///
/// Shape is fixed by `crates/cognia-exec-sandbox/src/bin/cognia-external-agent-launcher.rs`:
/// `--cwd <dir> (--writable <root>)* (--readable <root>)* [--network] -- <command> <args…>`.
pub fn build_sandbox_launcher_args(
    command: &str,
    args: &[String],
    cwd: &str,
    home: &Path,
    tool_host_dir: &Path,
) -> Vec<String> {
    let mut writable = vec![PathBuf::from(cwd)];
    writable.extend(agent_state_writable_roots(command, args, home));
    writable.push(tool_host_dir.to_path_buf());

    let mut out = vec!["--cwd".to_string(), cwd.to_string()];
    for root in &writable {
        out.push("--writable".to_string());
        out.push(root.to_string_lossy().into_owned());
    }
    out.push("--readable".to_string());
    out.push(home.to_string_lossy().into_owned());
    if base_command(command) == "aider" {
        for file in aider_implicit_config_paths(Path::new(cwd), home) {
            out.push("--deny-readable".into());
            out.push(file.to_string_lossy().into_owned());
        }
    }
    out.push("--network".to_string());
    out.push("--".to_string());
    out.push(command.to_string());
    out.extend(args.iter().cloned());
    out
}

/// Mirrors aiderImplicitConfigPaths in the CLI launcher. Aider searches these
/// files implicitly, including startup commands and provider .env overrides.
pub fn aider_implicit_config_paths(cwd: &Path, home: &Path) -> Vec<PathBuf> {
    let mut roots = vec![home.to_path_buf()];
    for dir in cwd.ancestors() {
        if !roots.iter().any(|root| root == dir) {
            roots.push(dir.to_path_buf());
        }
    }
    let mut files = Vec::new();
    for root in roots {
        for name in [
            ".aider.conf.yml",
            ".env",
            ".aider.model.settings.yml",
            ".aider.model.metadata.json",
        ] {
            files.push(root.join(name));
        }
    }
    files.push(home.join(".aider/oauth-keys.env"));
    files
}

pub fn is_aider_invocation(command: &str, args: &[String]) -> bool {
    base_command(command) == "aider"
        || args
            .iter()
            .position(|arg| arg == "--")
            .and_then(|index| args.get(index + 1))
            .is_some_and(|target| base_command(target) == "aider")
}

pub(crate) fn is_kimi_invocation(command: &str, args: &[String]) -> bool {
    base_command(command) == "kimi"
        || args
            .iter()
            .position(|arg| arg == "--")
            .and_then(|index| args.get(index + 1))
            .is_some_and(|target| base_command(target) == "kimi")
}

pub fn aider_model_env_key(key: &str) -> bool {
    matches!(
        key,
        "AIDER_MODEL"
            | "AIDER_WEAK_MODEL"
            | "AIDER_EDITOR_MODEL"
            | "AIDER_EDIT_FORMAT"
            | "AIDER_EDITOR_EDIT_FORMAT"
            | "AIDER_REASONING_EFFORT"
            | "AIDER_THINKING_TOKENS"
    )
}

/// Env key naming plugin Pi package directories (JSON array of absolute paths)
/// that a Pi session must be able to read. Set by the renderer's Pi adapter
/// (`PI_PACKAGE_ROOTS_ENV` in `pi-rpc-client.ts`, ADR-0210).
///
/// The value is a REQUEST, never a grant: it rides the reviewed
/// `COGNIA_TOOLHOST_` prefix, so anything that can set a spawn env could name
/// any path here. [`pi_package_readable_roots`] therefore keeps only entries
/// that resolve to an existing directory nested under the plugin install root
/// the HOST derives (never the renderer), and the remote spawn policy drops
/// the key outright (`SpawnPolicy::validate`).
pub const PI_PACKAGE_ROOTS_ENV: &str = "COGNIA_TOOLHOST_PI_PACKAGE_ROOTS";

/// Where the desktop app installs plugins: `<data dir>/cognia/plugins`, the
/// directory `src-tauri/src/lib.rs` hands `PluginRuntimeState`
/// (`dirs::data_dir()`): `~/Library/Application Support` on macOS,
/// `$XDG_DATA_HOME` (when absolute) or `~/.local/share` on Linux. Pure, so the
/// rule is testable without touching the developer's home.
pub fn desktop_plugin_install_root(
    os: &str,
    home: Option<&Path>,
    xdg_data_home: Option<&Path>,
) -> Option<PathBuf> {
    // Only the sandboxed platforms mount plugin packages at all.
    if !sandbox_supports_os(os) {
        return None;
    }
    let data_dir = crate::state_isolation::agent_state_data_dir(os, home, xdg_data_home, None)?;
    Some(data_dir.join("cognia").join("plugins"))
}

/// Every spelling of the host's forbidden readable roots: the literal list
/// plus its canonical form (`/var` → `/private/var`, `/tmp` → `/private/tmp`
/// on macOS), so a canonicalized candidate cannot slip past a textual match.
fn forbidden_readable_spellings() -> Vec<PathBuf> {
    let mut roots = cognia_exec_sandbox::protected::forbidden_readable_roots();
    #[cfg(unix)]
    for extra in ["/private/var", "/private/tmp", "/private/etc"] {
        roots.push(PathBuf::from(extra));
    }
    let canonical: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    roots.extend(canonical);
    roots
}

/// Read-only roots for plugin Pi packages, validated so the list can only ever
/// NARROWLY add reads. An entry survives only when ALL of these hold:
///
///   - the command is Pi (the same base-name rule as the state roots);
///   - it canonicalizes (symlinks resolved) to an existing directory;
///   - that directory is strictly nested under `plugin_install_root`, the
///     host-derived plugin store (itself canonicalized) — so the app store's
///     other contents, the home directory and every system path are out;
///   - the part below the plugin store names no protected entry (`.ssh`,
///     `.git`, keychains, …);
///   - it is not, and is not under or above, a forbidden readable root
///     (`/var`, `/run`, `/tmp`, … in every spelling);
///   - it is not nested under any `--deny-readable` root the wrapper emits
///     (Bot-isolated home, gateway-task deny list, the task-home parent): the
///     launcher re-opens a readable nested under a deny, so emitting one would
///     undo that deny;
///   - it is not, and is not under or above, a `--writable` root the wrapper
///     emits. Validation canonicalizes HERE and the launcher binds by PATH
///     later (`--ro-bind-try <path>` under bubblewrap), so a directory the
///     agent can write is one a sandboxed agent could swap for a symlink
///     between this check and a sibling spawn's bind. Refusing every overlap
///     with a writable root closes that window without changing the launcher.
///     (The stronger option is binding an `O_PATH | O_NOFOLLOW` descriptor
///     with bubblewrap's `--ro-bind-fd`, which the launcher does not do today.)
///
/// A Bot-isolated spawn (`COGNIA_BOT_ISOLATION=1`) gets no package roots at
/// all — whatever the plugin store's location, even outside the hidden home
/// (`XDG_DATA_HOME`) — matching ADR-0210 and the adapter's `bot-isolation`
/// refusal.
///
/// Every dropped entry, and an unparseable value, is logged with its reason.
pub fn pi_package_readable_roots(
    config: &ExternalAgentSpawnConfig,
    plugin_install_root: Option<&Path>,
    deny_roots: &[PathBuf],
    writable_roots: &[PathBuf],
) -> Vec<PathBuf> {
    let Some(raw) = config.env.get(PI_PACKAGE_ROOTS_ENV) else {
        return Vec::new();
    };
    if config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1") {
        log::warn!("[sandbox] ignoring {PI_PACKAGE_ROOTS_ENV} on a Bot-isolated spawn");
        return Vec::new();
    }
    if base_command(&config.command) != "pi" {
        log::warn!(
            "[sandbox] ignoring {PI_PACKAGE_ROOTS_ENV} on a non-Pi spawn ({})",
            config.command
        );
        return Vec::new();
    }
    let entries = match serde_json::from_str::<Vec<String>>(raw) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("[sandbox] ignoring malformed {PI_PACKAGE_ROOTS_ENV}: {error}");
            return Vec::new();
        }
    };
    let Some(store) = plugin_install_root.and_then(|root| std::fs::canonicalize(root).ok()) else {
        if !entries.is_empty() {
            log::warn!(
                "[sandbox] ignoring {PI_PACKAGE_ROOTS_ENV}: the plugin install root is unknown \
                 or does not exist on this host"
            );
        }
        return Vec::new();
    };
    let forbidden = forbidden_readable_spellings();
    let mut denies: Vec<PathBuf> = deny_roots.to_vec();
    denies.extend(
        deny_roots
            .iter()
            .filter_map(|deny| std::fs::canonicalize(deny).ok()),
    );
    let mut writables: Vec<PathBuf> = writable_roots.to_vec();
    writables.extend(
        writable_roots
            .iter()
            .filter_map(|root| std::fs::canonicalize(root).ok()),
    );

    let mut roots: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let reject = |reason: &str| {
            log::warn!("[sandbox] dropping Pi package root {entry:?}: {reason}");
        };
        let requested = PathBuf::from(&entry);
        if !requested.is_absolute() {
            reject("not an absolute path");
            continue;
        }
        let canonical = match std::fs::canonicalize(&requested) {
            Ok(path) => path,
            Err(_) => {
                reject("does not resolve");
                continue;
            }
        };
        if !canonical.is_dir() {
            reject("not a directory");
            continue;
        }
        let Ok(below_store) = canonical.strip_prefix(&store) else {
            reject("not inside the plugin install root");
            continue;
        };
        if below_store.as_os_str().is_empty() {
            reject("is the plugin install root itself");
            continue;
        }
        if cognia_exec_sandbox::protected::is_protected_anywhere(below_store) {
            reject("names a protected path");
            continue;
        }
        if cognia_exec_sandbox::protected::is_forbidden_readable(&canonical, &forbidden) {
            reject("is a forbidden readable root");
            continue;
        }
        if denies.iter().any(|deny| canonical.starts_with(deny)) {
            reject("is under a root this sandbox denies");
            continue;
        }
        if writables
            .iter()
            .any(|writable| canonical.starts_with(writable) || writable.starts_with(&canonical))
        {
            reject("overlaps a root this sandbox can write");
            continue;
        }
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    roots
}

/// Host facts the wrapper needs. A trait so tests can drive every branch
/// (unsupported platform, missing launcher, file-vs-dir state roots) without
/// touching the real filesystem or the developer's home directory.
pub trait SandboxHost {
    fn os(&self) -> &str;
    fn home(&self) -> Option<PathBuf>;
    fn temp_dir(&self) -> PathBuf;
    fn uid(&self) -> Option<u32>;
    fn launcher_candidates(&self) -> Vec<PathBuf>;
    fn is_executable(&self, candidate: &Path) -> bool;
    fn ensure_dir(&self, candidate: &Path);
    fn ensure_file(&self, candidate: &Path);
    /// The host-derived plugin install root (see
    /// [`desktop_plugin_install_root`]); `None` when unknown, which disables
    /// plugin Pi package mounts entirely.
    fn plugin_install_root(&self) -> Option<PathBuf> {
        None
    }
    /// The per-user data directory configuration state roots live under
    /// (see [`crate::state_isolation::agent_state_data_dir`]); `None` when
    /// unknown, which refuses every isolated launch.
    fn agent_state_data_dir(&self) -> Option<PathBuf> {
        None
    }
}

/// The real desktop host.
pub struct DesktopSandboxHost;

impl DesktopSandboxHost {
    fn current_os() -> &'static str {
        if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "unsupported"
        }
    }
}

impl SandboxHost for DesktopSandboxHost {
    fn os(&self) -> &str {
        Self::current_os()
    }

    fn home(&self) -> Option<PathBuf> {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    }

    fn temp_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    fn agent_state_data_dir(&self) -> Option<PathBuf> {
        let env_path = |name: &str| {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        crate::state_isolation::agent_state_data_dir(
            self.os(),
            self.home().as_deref(),
            env_path("XDG_DATA_HOME").as_deref(),
            env_path("APPDATA").as_deref(),
        )
    }

    fn plugin_install_root(&self) -> Option<PathBuf> {
        desktop_plugin_install_root(
            self.os(),
            self.home().as_deref(),
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .as_deref(),
        )
    }

    #[cfg(unix)]
    fn uid(&self) -> Option<u32> {
        // SAFETY: `getuid` takes no arguments, cannot fail, and touches no
        // memory we own.
        Some(unsafe { libc::getuid() })
    }

    #[cfg(not(unix))]
    fn uid(&self) -> Option<u32> {
        None
    }

    /// Mirrors `resolve_server_binary` in `src-tauri/src/terminal_host_bridge.rs`:
    /// the packaged sidecar lands next to the app executable, and a repo
    /// checkout falls back to the shared `target/` directory.
    fn launcher_candidates(&self) -> Vec<PathBuf> {
        let name = launcher_file_name(self.os());
        let mut candidates = Vec::new();
        if let Some(explicit) = std::env::var_os(LAUNCHER_ENV) {
            let path = PathBuf::from(explicit);
            if !path.as_os_str().is_empty() {
                candidates.push(path);
            }
        }
        if let Ok(current) = std::env::current_exe() {
            if let Some(parent) = current.parent() {
                candidates.push(parent.join(name));
            }
        }
        if let Some(root) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|crates| crates.parent())
        {
            candidates.push(root.join("target").join("release").join(name));
            candidates.push(root.join("target").join("debug").join(name));
        }
        candidates
    }

    #[cfg(unix)]
    fn is_executable(&self, candidate: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(candidate)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    fn is_executable(&self, candidate: &Path) -> bool {
        candidate.is_file()
    }

    fn ensure_dir(&self, candidate: &Path) {
        let _ = std::fs::create_dir_all(candidate);
    }

    fn ensure_file(&self, candidate: &Path) {
        if candidate.exists() {
            return;
        }
        if let Some(parent) = candidate.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(candidate);
    }
}

/// Find the first executable launcher among the candidates.
///
/// Separate from [`wrap_with_sandbox`] so a readiness probe can report whether
/// the desktop can sandbox at all WITHOUT attempting a spawn.
pub fn find_sandbox_launcher(host: &dyn SandboxHost) -> Option<PathBuf> {
    host.launcher_candidates()
        .into_iter()
        .find(|candidate| host.is_executable(candidate))
}

fn qoder_config_root(
    config: &ExternalAgentSpawnConfig,
    home: &Path,
) -> Result<Option<PathBuf>, SandboxError> {
    if base_command(&config.command) != "qoder" {
        return Ok(None);
    }
    let mut selected = config
        .env
        .get("QODER_CONFIG_DIR")
        .cloned()
        .or_else(|| std::env::var("QODER_CONFIG_DIR").ok());
    let mut args = config.args.iter();
    while let Some(arg) = args.next() {
        if arg == "--config-dir" {
            selected = Some(args.next().cloned().unwrap_or_default());
        } else if let Some(value) = arg.strip_prefix("--config-dir=") {
            selected = Some(value.into());
        }
    }
    let bot = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    let base = if bot {
        config
            .env
            .get("COGNIA_BOT_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(SandboxError::InvalidQoderConfigDir)?
    } else {
        home.to_path_buf()
    };
    if !base.is_absolute() {
        return Err(SandboxError::InvalidQoderConfigDir);
    }
    let root = match selected {
        Some(value) if value.trim().is_empty() => return Err(SandboxError::InvalidQoderConfigDir),
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                Path::new(config.cwd.as_deref().ok_or(SandboxError::MissingCwd)?).join(path)
            }
        }
        None => base.join(".qoder"),
    };
    let mut normalized = PathBuf::new();
    for component in root.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            component => normalized.push(component.as_os_str()),
        }
    }
    if bot && !normalized.starts_with(&base) {
        return Err(SandboxError::InvalidQoderConfigDir);
    }
    Ok(Some(normalized))
}

fn cline_config_root(
    config: &ExternalAgentSpawnConfig,
    home: &Path,
) -> Result<Option<PathBuf>, SandboxError> {
    if base_command(&config.command) != "cline" {
        return Ok(None);
    }
    if config
        .args
        .iter()
        .any(|arg| arg == "--data-dir" || arg.starts_with("--data-dir="))
    {
        return Err(SandboxError::InvalidClineConfigDir);
    }
    let mut selected = config
        .env
        .get("CLINE_DIR")
        .cloned()
        .or_else(|| std::env::var("CLINE_DIR").ok());
    let mut args = config.args.iter();
    while let Some(arg) = args.next() {
        if arg == "--config" {
            selected = Some(args.next().cloned().unwrap_or_default());
            break;
        } else if let Some(value) = arg.strip_prefix("--config=") {
            selected = Some(value.into());
            break;
        }
    }
    let bot = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    let base = if bot {
        config
            .env
            .get("COGNIA_BOT_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(SandboxError::InvalidClineConfigDir)?
    } else {
        home.to_path_buf()
    };
    if !base.is_absolute() {
        return Err(SandboxError::InvalidClineConfigDir);
    }
    let root = match selected {
        Some(value) if value.trim().is_empty() => return Err(SandboxError::InvalidClineConfigDir),
        Some(value) => {
            let path = PathBuf::from(value.trim());
            if path.is_absolute() {
                path
            } else {
                Path::new(config.cwd.as_deref().ok_or(SandboxError::MissingCwd)?).join(path)
            }
        }
        None => base.join(".cline"),
    };
    let mut normalized = PathBuf::new();
    for component in root.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            component => normalized.push(component.as_os_str()),
        }
    }
    if bot && !normalized.starts_with(&base) {
        return Err(SandboxError::InvalidClineConfigDir);
    }
    Ok(Some(normalized))
}

fn kimi_config_root(
    config: &ExternalAgentSpawnConfig,
    home: &Path,
) -> Result<Option<PathBuf>, SandboxError> {
    if base_command(&config.command) != "kimi" {
        return Ok(None);
    }
    let selected = config
        .env
        .get("KIMI_CODE_HOME")
        .cloned()
        .or_else(|| std::env::var("KIMI_CODE_HOME").ok());
    let bot = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    let base = if bot {
        config
            .env
            .get("COGNIA_BOT_STATE_DIR")
            .map(PathBuf::from)
            .ok_or(SandboxError::InvalidKimiConfigDir)?
    } else {
        home.to_path_buf()
    };
    if !base.is_absolute() {
        return Err(SandboxError::InvalidKimiConfigDir);
    }
    let root = match selected {
        Some(value) if value.trim().is_empty() => return Err(SandboxError::InvalidKimiConfigDir),
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                Path::new(config.cwd.as_deref().ok_or(SandboxError::MissingCwd)?).join(path)
            }
        }
        None => base.join(".kimi-code"),
    };
    let mut normalized = PathBuf::new();
    for component in root.components() {
        match component {
            std::path::Component::ParentDir => {
                if normalized.parent().is_some() {
                    normalized.pop();
                }
            }
            std::path::Component::CurDir => {}
            component => normalized.push(component.as_os_str()),
        }
    }
    if bot && !normalized.starts_with(&base) {
        return Err(SandboxError::InvalidKimiConfigDir);
    }
    if bot {
        let physical_base = cognia_exec_sandbox::paths::safe_canonicalize(&base)
            .map_err(|_| SandboxError::InvalidKimiConfigDir)?;
        let physical_root = cognia_exec_sandbox::paths::safe_canonicalize(&normalized)
            .map_err(|_| SandboxError::InvalidKimiConfigDir)?;
        if !physical_root.starts_with(&physical_base) {
            return Err(SandboxError::InvalidKimiConfigDir);
        }
    }
    Ok(Some(normalized))
}

/// Remove every `--writable <root>` pair naming exactly `root`.
fn drop_writable(args: &mut Vec<String>, root: &Path) {
    let root = root.to_string_lossy();
    while let Some(index) = args
        .windows(2)
        .position(|pair| pair[0] == "--writable" && pair[1] == root)
    {
        args.drain(index..index + 2);
    }
}

/// Rewrite a validated spawn config so the agent runs under the launcher.
///
/// Call this **after** the command allowlist has run: the allowlist requires a
/// bare binary name, and this replaces `command` with the launcher's absolute
/// path. Doing it the other way round would either reject the launcher or
/// admit an arbitrary path as the agent binary.
///
/// A configuration with a private state root (`COGNIA_AGENT_STATE_KEY`, see
/// [`crate::state_isolation`]) is resolved here too, before the Kimi / Cline /
/// Qoder roots are read: the isolated home lands in their env variables, so
/// those rebasings scope the launch to it. The root is granted writable, the
/// runtime's shared default roots leave the writable set and are denied
/// reading.
pub fn wrap_with_sandbox(
    config: ExternalAgentSpawnConfig,
    host: &dyn SandboxHost,
) -> Result<ExternalAgentSpawnConfig, SandboxError> {
    if !sandbox_supports_os(host.os()) {
        return Err(SandboxError::UnsupportedPlatform(host.os().to_string()));
    }
    let launcher = find_sandbox_launcher(host)
        .ok_or_else(|| SandboxError::LauncherUnavailable(config.command.clone()))?;
    let host_home = host.home().ok_or(SandboxError::MissingHome)?;
    let home = crate::gateway_task::task_home(&config.env, &host_home)
        .map_err(|_| SandboxError::MissingHome)?
        .unwrap_or_else(|| host_home.clone());
    let cwd = config
        .cwd
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(SandboxError::MissingCwd)?;

    let mut config = config;
    let isolation = crate::state_isolation::apply_state_isolation(
        &mut config,
        host.agent_state_data_dir().as_deref(),
        &host_home,
    )
    .map_err(SandboxError::StateIsolation)?;

    let kimi_root = kimi_config_root(&config, &home)?;
    let cline_root = cline_config_root(&config, &home)?;
    let qoder_root = qoder_config_root(&config, &home)?;
    let tool_host_dir = tool_host_runtime_dir(&host.temp_dir(), host.uid());
    for root in cline_root
        .clone()
        .or_else(|| qoder_root.clone())
        .or_else(|| kimi_root.clone())
        .map(|root| vec![root])
        .unwrap_or_else(|| agent_state_writable_roots(&config.command, &config.args, &home))
    {
        // An isolated launch must not (re)create the user's own login roots.
        if isolation
            .as_ref()
            .is_some_and(|plan| plan.shared_roots.contains(&root))
        {
            continue;
        }
        if is_state_file_root(&root) {
            host.ensure_file(&root);
        } else {
            host.ensure_dir(&root);
        }
    }
    host.ensure_dir(&tool_host_dir);

    let bot_isolation = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    let mut args = if bot_isolation {
        let state = config
            .env
            .get("COGNIA_BOT_STATE_DIR")
            .filter(|value| Path::new(value).is_absolute())
            .ok_or(SandboxError::MissingCwd)?;
        host.ensure_dir(Path::new(state));
        vec![
            "--cwd".into(),
            cwd.clone(),
            "--writable".into(),
            state.clone(),
            "--writable".into(),
            tool_host_dir.to_string_lossy().into_owned(),
            "--network".into(),
            "--".into(),
            config.command.clone(),
        ]
        .into_iter()
        .chain(config.args.clone())
        .collect()
    } else {
        build_sandbox_launcher_args(&config.command, &config.args, &cwd, &home, &tool_host_dir)
    };
    if bot_isolation {
        // The launcher owns env/keychain confinement too. An old launcher
        // rejects this flag instead of silently running with a weaker policy.
        args.splice(
            0..0,
            [
                "--bot-isolation".to_string(),
                "--deny-readable".to_string(),
                host_home.to_string_lossy().into_owned(),
            ],
        );
        for relative in [
            ".nvm",
            ".local/bin",
            ".local/share/pnpm",
            ".local/share/devin/cli/_versions",
            ".bun/bin",
            ".cargo/bin",
            ".rustup/toolchains",
            "Library/pnpm",
        ] {
            args.splice(
                0..0,
                [
                    "--readable".to_string(),
                    host_home.join(relative).to_string_lossy().into_owned(),
                ],
            );
        }
        if base_command(&config.command) == "qoder" {
            for relative in [".qoder/entry", ".qoder/bin"] {
                args.splice(
                    0..0,
                    [
                        "--readable".into(),
                        host_home.join(relative).to_string_lossy().into_owned(),
                    ],
                );
            }
        }
    }
    if config.env.contains_key(crate::gateway_task::PAYLOAD_ENV) {
        // All runtime state lives under this task root, not the user's roots.
        args.splice(
            0..0,
            [
                "--writable".to_string(),
                home.to_string_lossy().into_owned(),
            ],
        );
        args.splice(
            0..0,
            [
                "--readable".to_string(),
                host_home.to_string_lossy().into_owned(),
            ],
        );
        for relative in [
            ".codex",
            ".claude",
            ".claude.json",
            ".pi",
            ".qwen",
            ".config/opencode",
            ".local/share/opencode",
            ".local/share/cognia-agent-tasks",
            // Kimi Code (and its archived Python CLI), Copilot CLI, Goose and
            // Aider keep logins and provider settings here; a task uses its own.
            ".kimi-code",
            ".kimi",
            ".copilot",
            ".config/goose",
            ".local/share/goose",
            ".local/state/goose",
            ".aider",
        ] {
            args.splice(
                0..0,
                [
                    "--deny-readable".to_string(),
                    host_home.join(relative).to_string_lossy().into_owned(),
                ],
            );
        }
    }

    // A private state root replaces the runtime's shared default roots. Bot
    // and gateway launches never get here with a plan: both own a private
    // home already and `apply_state_isolation` ignores the key for them.
    if let Some(plan) = &isolation {
        for shared in &plan.shared_roots {
            drop_writable(&mut args, shared);
        }
        args.splice(
            0..0,
            [
                "--writable".to_string(),
                plan.root.to_string_lossy().into_owned(),
            ],
        );
        for denied in &plan.deny_readable {
            args.splice(
                0..0,
                [
                    "--deny-readable".to_string(),
                    denied.to_string_lossy().into_owned(),
                ],
            );
        }
    }

    // Plugin Pi packages (ADR-0210): each validated package directory is
    // mounted read-only. Computed after every `--deny-readable` above has been
    // emitted, so no package root can re-open a denied subtree.
    let emitted_denies: Vec<PathBuf> = args
        .windows(2)
        .filter(|pair| pair[0] == "--deny-readable")
        .map(|pair| PathBuf::from(&pair[1]))
        .collect();
    let emitted_writables: Vec<PathBuf> = args
        .windows(2)
        .filter(|pair| pair[0] == "--writable")
        .map(|pair| PathBuf::from(&pair[1]))
        .collect();
    let plugin_store = host.plugin_install_root();
    for root in pi_package_readable_roots(
        &config,
        plugin_store.as_deref(),
        &emitted_denies,
        &emitted_writables,
    ) {
        args.splice(
            0..0,
            [
                "--readable".to_string(),
                root.to_string_lossy().into_owned(),
            ],
        );
    }

    let mut env = config.env.clone();
    if let Some(root) = &kimi_root {
        let default_root = home.join(".kimi-code").to_string_lossy().into_owned();
        while let Some(index) = args
            .windows(2)
            .position(|pair| pair[0] == "--writable" && pair[1] == default_root)
        {
            args.drain(index..index + 2);
        }
        host.ensure_dir(root);
        if !bot_isolation {
            args.splice(
                0..0,
                ["--writable".into(), root.to_string_lossy().into_owned()],
            );
        }
        env.insert("KIMI_CODE_HOME".into(), root.to_string_lossy().into_owned());
        env.insert("KIMI_CODE_NO_AUTO_UPDATE".into(), "1".into());
        env.insert("KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT".into(), "0".into());
    }
    if let Some(root) = cline_root {
        let default_root = home.join(".cline").to_string_lossy().into_owned();
        while let Some(index) = args
            .windows(2)
            .position(|pair| pair[0] == "--writable" && pair[1] == default_root)
        {
            args.drain(index..index + 2);
        }
        host.ensure_dir(&root);
        args.splice(
            0..0,
            ["--writable".into(), root.to_string_lossy().into_owned()],
        );
        env.insert("CLINE_DIR".into(), root.to_string_lossy().into_owned());
        env.insert("CLINE_NO_AUTO_UPDATE".into(), "1".into());
        if !bot_isolation {
            let temp = root.join("tmp");
            host.ensure_dir(&temp);
            for key in ["TMPDIR", "TMP", "TEMP"] {
                env.insert(key.into(), temp.to_string_lossy().into_owned());
            }
        }
    }

    if let Some(root) = qoder_root {
        // A custom configuration root must not also grant writes to the CLI login root.
        let default_root = home.join(".qoder").to_string_lossy().into_owned();
        while let Some(index) = args
            .windows(2)
            .position(|pair| pair[0] == "--writable" && pair[1] == default_root)
        {
            args.drain(index..index + 2);
        }
        host.ensure_dir(&root);
        args.splice(
            0..0,
            ["--writable".into(), root.to_string_lossy().into_owned()],
        );
        env.insert(
            "QODER_CONFIG_DIR".into(),
            root.to_string_lossy().into_owned(),
        );
        if !bot_isolation {
            let temp = root.join("tmp");
            host.ensure_dir(&temp);
            for key in ["TMPDIR", "TMP", "TEMP"] {
                env.insert(key.into(), temp.to_string_lossy().into_owned());
            }
        }
    }
    if config.command == "goose" && !bot_isolation {
        // Goose creates platform-extension temp files while opening a session.
        // Keep them under an existing scoped write root, not ambient macOS temp.
        let temp = home.join(".local/state/goose/tmp");
        host.ensure_dir(&temp);
        for key in ["TMPDIR", "TMP", "TEMP"] {
            env.insert(key.into(), temp.to_string_lossy().into_owned());
        }
    }
    if bot_isolation {
        let state = Path::new(&config.env["COGNIA_BOT_STATE_DIR"]);
        for (key, relative) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
            ("TMPDIR", "tmp"),
            ("TMP", "tmp"),
            ("TEMP", "tmp"),
            ("npm_config_cache", "cache/npm"),
            ("npm_config_store_dir", "cache/pnpm-store"),
            ("pnpm_config_store_dir", "cache/pnpm-store"),
            ("pnpm_config_cache_dir", "cache/pnpm"),
        ] {
            let root = state.join(relative);
            host.ensure_dir(&root);
            env.insert(key.into(), root.to_string_lossy().into_owned());
        }
    }
    if env.contains_key(crate::devin_mcp_config::PAYLOAD_ENV) {
        env.insert(crate::devin_mcp_config::WRAPPED_ENV.into(), "1".into());
    }
    if let Some(root) = &kimi_root {
        let temp = root.join("tmp");
        host.ensure_dir(&temp);
        for key in ["TMPDIR", "TMP", "TEMP"] {
            env.insert(key.into(), temp.to_string_lossy().into_owned());
        }
    }
    Ok(ExternalAgentSpawnConfig {
        command: launcher.to_string_lossy().into_owned(),
        args,
        env,
        ..config
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeHost {
        os: String,
        home: Option<PathBuf>,
        candidates: Vec<PathBuf>,
        executable: Vec<PathBuf>,
        dirs: RefCell<Vec<PathBuf>>,
        files: RefCell<Vec<PathBuf>>,
        plugin_root: Option<PathBuf>,
        state_data_dir: Option<PathBuf>,
    }

    impl FakeHost {
        fn new(os: &str) -> Self {
            Self {
                os: os.to_string(),
                home: Some(PathBuf::from("/home/dev")),
                candidates: vec![PathBuf::from("/opt/launcher")],
                executable: vec![PathBuf::from("/opt/launcher")],
                ..Default::default()
            }
        }
    }

    impl SandboxHost for FakeHost {
        fn os(&self) -> &str {
            &self.os
        }
        fn home(&self) -> Option<PathBuf> {
            self.home.clone()
        }
        fn temp_dir(&self) -> PathBuf {
            PathBuf::from("/tmp")
        }
        fn uid(&self) -> Option<u32> {
            Some(501)
        }
        fn launcher_candidates(&self) -> Vec<PathBuf> {
            self.candidates.clone()
        }
        fn is_executable(&self, candidate: &Path) -> bool {
            self.executable.iter().any(|item| item == candidate)
        }
        fn ensure_dir(&self, candidate: &Path) {
            self.dirs.borrow_mut().push(candidate.to_path_buf());
        }
        fn ensure_file(&self, candidate: &Path) {
            self.files.borrow_mut().push(candidate.to_path_buf());
        }
        fn plugin_install_root(&self) -> Option<PathBuf> {
            self.plugin_root.clone()
        }
        fn agent_state_data_dir(&self) -> Option<PathBuf> {
            self.state_data_dir.clone()
        }
    }

    fn config(command: &str, args: &[&str], cwd: Option<&str>) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: "agent-1".to_string(),
            command: command.to_string(),
            args: args.iter().map(|value| value.to_string()).collect(),
            env: HashMap::new(),
            cwd: cwd.map(|value| value.to_string()),
            framing: Default::default(),
            sandbox: None,
        }
    }

    #[test]
    fn supports_only_macos_and_linux() {
        assert!(sandbox_supports_os("macos"));
        assert!(sandbox_supports_os("linux"));
        assert!(!sandbox_supports_os("windows"));
        assert!(!sandbox_supports_os("unsupported"));
    }

    #[test]
    fn aider_hides_implicit_configuration_and_only_accepts_model_environment() {
        let args = build_sandbox_launcher_args(
            "aider",
            &[],
            "/work/project/sub",
            Path::new("/home/user"),
            Path::new("/tmp/toolhost"),
        );
        let denied: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "--deny-readable")
            .map(|pair| pair[1].as_str())
            .collect();
        for file in [
            "/home/user/.aider.conf.yml",
            "/work/project/sub/.env",
            "/work/project/.aider.conf.yml",
            "/.aider.model.metadata.json",
            "/home/user/.aider/oauth-keys.env",
        ] {
            assert!(denied.contains(&file));
        }
        assert!(is_aider_invocation(
            "/launcher",
            &["--".into(), "aider".into()]
        ));
        assert!(!is_aider_invocation("pi", &["--mode".into(), "rpc".into()]));
        assert!(aider_model_env_key("AIDER_MODEL"));
        assert!(!aider_model_env_key("AIDER_LOAD"));
        assert!(!aider_model_env_key("AIDER_FILE"));
    }

    #[test]
    fn launcher_file_name_is_platform_correct() {
        assert_eq!(
            launcher_file_name("windows"),
            "cognia-external-agent-launcher.exe"
        );
        assert_eq!(
            launcher_file_name("macos"),
            "cognia-external-agent-launcher"
        );
    }

    #[test]
    fn pi_gets_its_session_store_as_a_writable_root() {
        let roots = agent_state_writable_roots("pi", &[], Path::new("/home/dev"));
        assert_eq!(roots, vec![PathBuf::from("/home/dev/.pi")]);
    }

    #[cfg(unix)]
    #[test]
    fn kimi_bot_rejects_symlinked_state_escape_before_directory_provisioning() {
        let owned = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), owned.path().join("escape")).unwrap();
        let host = FakeHost::new("macos");
        let mut input = config("kimi", &["acp"], Some("/work"));
        input.env.extend([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            (
                "COGNIA_BOT_STATE_DIR".into(),
                owned.path().to_string_lossy().into_owned(),
            ),
            (
                "KIMI_CODE_HOME".into(),
                owned
                    .path()
                    .join("escape/new")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidKimiConfigDir)
        ));
        assert!(host.dirs.borrow().is_empty());
    }

    #[test]
    fn kimi_scopes_native_state_temp_and_update_lifecycle() {
        let host = FakeHost::new("macos");
        for (selected, expected) in [
            ("state/../kimi", "/work/kimi"),
            (" state ", "/work/ state "),
            ("/isolated/kimi", "/isolated/kimi"),
        ] {
            let mut input = config("kimi", &["acp"], Some("/work"));
            input.env.insert("KIMI_CODE_HOME".into(), selected.into());
            input
                .env
                .insert("KIMI_CODE_NO_AUTO_UPDATE".into(), "0".into());
            input
                .env
                .insert("KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT".into(), "1".into());
            let wrapped = wrap_with_sandbox(input, &host).unwrap();
            assert_eq!(wrapped.env["KIMI_CODE_HOME"], expected);
            assert_eq!(wrapped.env["TMPDIR"], format!("{expected}/tmp"));
            assert_eq!(wrapped.env["KIMI_CODE_NO_AUTO_UPDATE"], "1");
            assert_eq!(wrapped.env["KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"], "0");
            assert!(wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--writable", expected]));
            assert!(!wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--writable", "/home/dev/.kimi-code"]));
        }
        assert_eq!(
            agent_state_writable_roots("kimi", &[], Path::new("/home/dev")),
            vec![PathBuf::from("/home/dev/.kimi-code")]
        );
    }

    #[test]
    fn kimi_bot_rejects_empty_and_escaping_state_and_retains_owned_temp() {
        let host = FakeHost::new("macos");
        for selected in ["", "   ", "/work/state/../escape", "/home/dev/.kimi-code"] {
            let mut input = config("kimi", &["acp"], Some("/work"));
            input.env.extend([
                ("COGNIA_BOT_ISOLATION".into(), "1".into()),
                ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
                ("KIMI_CODE_HOME".into(), selected.into()),
            ]);
            assert!(matches!(
                wrap_with_sandbox(input, &host),
                Err(SandboxError::InvalidKimiConfigDir)
            ));
        }
        let mut input = config("kimi", &["acp"], Some("/work"));
        input.env.extend([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
            ("KIMI_CODE_HOME".into(), "/work/state/kimi".into()),
        ]);
        let wrapped = wrap_with_sandbox(input, &host).unwrap();
        assert_eq!(wrapped.env["KIMI_CODE_HOME"], "/work/state/kimi");
        assert_eq!(wrapped.env["TMPDIR"], "/work/state/kimi/tmp");
        assert!(!wrapped.args.iter().any(|arg| arg == "/home/dev/.kimi-code"));
    }

    #[test]
    fn cline_scopes_actual_acp_config_and_disables_updates() {
        let host = FakeHost::new("macos");
        let mut input = config("cline", &["--acp", "--config", "state"], Some("/work"));
        input.env.insert("CLINE_DIR".into(), "/ignored".into());
        let wrapped = wrap_with_sandbox(input, &host).unwrap();
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/work/state"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/home/dev/.cline"]));
        assert_eq!(wrapped.env["CLINE_DIR"], "/work/state");
        assert_eq!(wrapped.env["TMPDIR"], "/work/state/tmp");
        assert_eq!(wrapped.env["CLINE_NO_AUTO_UPDATE"], "1");
        assert_eq!(
            agent_state_writable_roots("cline", &[], Path::new("/home/dev")),
            vec![PathBuf::from("/home/dev/.cline")]
        );
    }
    #[test]
    fn cline_bot_cannot_escape_owned_state_or_use_ignored_data_flag() {
        let host = FakeHost::new("macos");
        let mut input = config("cline", &["--acp"], Some("/work"));
        input.env.extend([
            ("COGNIA_BOT_ISOLATION".into(), "1".into()),
            ("COGNIA_BOT_STATE_DIR".into(), "/work/state".into()),
            ("CLINE_DIR".into(), "/work/state/../escape".into()),
        ]);
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidClineConfigDir)
        ));
        let input = config(
            "cline",
            &["--acp", "--data-dir", "/work/state"],
            Some("/work"),
        );
        assert!(matches!(
            wrap_with_sandbox(input, &host),
            Err(SandboxError::InvalidClineConfigDir)
        ));
    }

    #[test]
    fn qoder_custom_state_is_scoped_without_writing_the_default_login_root() {
        let home = Path::new("/home/dev");
        assert_eq!(
            agent_state_writable_roots("qoder", &["--acp".into()], home),
            vec![home.join(".qoder")]
        );
        let mut input = config(
            "qoder",
            &["--acp", "--config-dir", "state"],
            Some("/work/project"),
        );
        input
            .env
            .insert("QODER_CONFIG_DIR".into(), "/ignored".into());
        let wrapped = wrap_with_sandbox(input, &FakeHost::new("macos")).unwrap();
        assert_eq!(wrapped.env["QODER_CONFIG_DIR"], "/work/project/state");
        assert_eq!(wrapped.env["TMPDIR"], "/work/project/state/tmp");
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/work/project/state"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/home/dev/.qoder"]));
    }

    #[test]
    fn qoder_bot_config_cannot_escape_owned_state() {
        let mut input = config("qoder", &["--acp"], Some("/work"));
        input.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        input
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        input
            .env
            .insert("QODER_CONFIG_DIR".into(), "/work/state/../outside".into());
        assert!(matches!(
            wrap_with_sandbox(input, &FakeHost::new("macos")),
            Err(SandboxError::InvalidQoderConfigDir)
        ));
    }

    #[test]
    fn qoder_bot_exposes_host_programs_without_the_login_root() {
        let mut input = config("qoder", &["--acp"], Some("/work"));
        input.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        input
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        let wrapped = wrap_with_sandbox(input, &FakeHost::new("macos")).unwrap();
        for root in ["/home/dev/.qoder/entry", "/home/dev/.qoder/bin"] {
            assert!(wrapped
                .args
                .windows(2)
                .any(|pair| pair == ["--readable", root]));
        }
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--readable", "/home/dev/.qoder"]));
        assert_eq!(wrapped.env["QODER_CONFIG_DIR"], "/work/state/.qoder");
    }

    #[test]
    fn goose_gets_its_config_data_and_state_on_both_unix_platforms() {
        let home = Path::new("/home/dev");
        assert_eq!(
            agent_state_writable_roots("goose", &["acp".into()], home),
            vec![
                home.join(".config/goose"),
                home.join(".local/share/goose"),
                home.join(".local/state/goose"),
                home.join("Library/Application Support/Block/goose"),
            ]
        );
        assert_eq!(
            agent_state_writable_roots("npx", &["-y".into(), "goose-adapter".into()], home),
            vec![home.join(".npm")]
        );
    }

    #[test]
    fn devin_gets_its_config_sessions_and_cache_without_matching_other_commands() {
        assert_eq!(
            agent_state_writable_roots("devin", &["acp".into()], Path::new("/home/dev")),
            vec![
                PathBuf::from("/home/dev/.config/devin"),
                PathBuf::from("/home/dev/.local/share/devin"),
                PathBuf::from("/home/dev/.cache/devin"),
            ]
        );
        assert_eq!(
            agent_state_writable_roots(
                "npx",
                &["-y".into(), "devin-adapter".into()],
                Path::new("/home/dev"),
            ),
            vec![PathBuf::from("/home/dev/.npm")]
        );
    }

    #[test]
    fn npx_package_decides_the_state_root_not_npx() {
        // Vehicle is Qwen because it is still launched through npx; `pi-acp`,
        // which this used to use, was removed with the ACP bridge (ADR-0119).
        let args = vec!["-y".to_string(), "@qwen-code/qwen-code".to_string()];
        let roots = agent_state_writable_roots("npx", &args, Path::new("/home/dev"));
        assert!(roots.contains(&PathBuf::from("/home/dev/.qwen")));
        assert!(roots.contains(&PathBuf::from("/home/dev/.npm")));
    }

    /// `pi` must match on the base command, never as a substring: the native
    /// binary is the only Pi launch left, and an `npx` package that merely
    /// contains "pi" must not inherit Pi's session store.
    #[test]
    fn pi_state_root_does_not_leak_to_an_npx_package_containing_pi() {
        let args = vec!["-y".to_string(), "pi-acp".to_string()];
        let roots = agent_state_writable_roots("npx", &args, Path::new("/home/dev"));
        assert!(!roots.contains(&PathBuf::from("/home/dev/.pi")));
    }

    #[test]
    fn windows_suffix_is_stripped_before_matching() {
        let roots = agent_state_writable_roots("Codex.EXE", &[], Path::new("/home/dev"));
        assert_eq!(roots, vec![PathBuf::from("/home/dev/.codex")]);
    }

    #[test]
    fn opencode_gets_its_config_and_session_store() {
        // Neither launcher had an OpenCode rule, so `opencode serve` ran with
        // its session database outside the sandbox scope: writes failed
        // silently and `--session-id` resume started over every time.
        let roots = agent_state_writable_roots("opencode", &[], Path::new("/home/dev"));
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/home/dev/.config/opencode"),
                PathBuf::from("/home/dev/.local/share/opencode"),
            ]
        );
    }

    #[test]
    fn copilot_does_not_inherit_pis_state_directory() {
        // "copilot" contains "pi", which is why the Pi rule matches the exact
        // target rather than a substring.
        let roots = agent_state_writable_roots("copilot", &[], Path::new("/home/dev"));
        assert!(!roots.contains(&PathBuf::from("/home/dev/.pi")));
    }

    #[test]
    fn claude_json_roots_are_files_not_directories() {
        assert!(is_state_file_root(Path::new("/home/dev/.claude.json")));
        assert!(is_state_file_root(Path::new(
            "/home/dev/.claude.json.backup"
        )));
        assert!(!is_state_file_root(Path::new("/home/dev/.claude")));
    }

    #[test]
    fn tool_host_dir_falls_back_when_uid_is_unavailable() {
        assert_eq!(
            tool_host_runtime_dir(Path::new("/tmp"), Some(501)),
            PathBuf::from("/tmp/cognia-toolhost-501")
        );
        assert_eq!(
            tool_host_runtime_dir(Path::new("/tmp"), None),
            PathBuf::from("/tmp/cognia-toolhost-user")
        );
    }

    #[test]
    fn launcher_args_scope_cwd_state_and_toolhost_then_pass_the_target_through() {
        let args = build_sandbox_launcher_args(
            "pi",
            &["--mode".to_string(), "rpc".to_string()],
            "/work/project",
            Path::new("/home/dev"),
            Path::new("/tmp/cognia-toolhost-501"),
        );
        assert_eq!(
            args,
            vec![
                "--cwd",
                "/work/project",
                "--writable",
                "/work/project",
                "--writable",
                "/home/dev/.pi",
                "--writable",
                "/tmp/cognia-toolhost-501",
                "--readable",
                "/home/dev",
                "--network",
                "--",
                "pi",
                "--mode",
                "rpc",
            ]
        );
    }

    #[test]
    fn wrap_replaces_the_command_with_the_launcher_and_keeps_id_env_cwd() {
        let host = FakeHost::new("macos");
        let mut original = config("pi", &["--mode", "rpc"], Some("/work/project"));
        original
            .env
            .insert("ANTHROPIC_API_KEY".to_string(), "secret".to_string());

        let wrapped = wrap_with_sandbox(original, &host).expect("sandbox wrap");

        assert_eq!(wrapped.command, "/opt/launcher");
        assert_eq!(wrapped.id, "agent-1");
        assert_eq!(wrapped.cwd.as_deref(), Some("/work/project"));
        assert_eq!(
            wrapped.env.get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("secret")
        );
        // The real agent survives after the `--` separator.
        let separator = wrapped.args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(&wrapped.args[separator + 1..], ["pi", "--mode", "rpc"]);
    }

    #[test]
    fn goose_temp_is_scoped_even_when_ambient_temp_or_custom_state_is_set() {
        let host = FakeHost::new("macos");
        let mut original = config("goose", &["acp"], Some("/work/project"));
        original.env.insert("TMPDIR".into(), "/ambient/tmp".into());
        original
            .env
            .insert("GOOSE_PATH_ROOT".into(), "/untrusted".into());
        let wrapped = wrap_with_sandbox(original, &host).expect("sandbox wrap");
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(wrapped.env[key], "/home/dev/.local/state/goose/tmp");
        }
        assert!(host
            .dirs
            .borrow()
            .contains(&PathBuf::from("/home/dev/.local/state/goose/tmp")));
        assert!(!wrapped
            .args
            .iter()
            .any(|arg| arg == "/ambient/tmp" || arg == "/untrusted"));
    }

    /// A real directory tree for the Pi package root tests. Created under the
    /// workspace `target/` dir rather than the OS temp dir: `/tmp` and `/var`
    /// (macOS temp lives in `/private/var`) are forbidden readable roots, so a
    /// fixture there could never exercise the accepting path.
    struct PiRootsFixture {
        _tmp: tempfile::TempDir,
        base: PathBuf,
    }

    impl PiRootsFixture {
        fn new() -> Self {
            let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/cognia-external-agent-test-fixtures");
            std::fs::create_dir_all(&parent).unwrap();
            let tmp = tempfile::tempdir_in(&parent).unwrap();
            let base = std::fs::canonicalize(tmp.path()).unwrap();
            Self { _tmp: tmp, base }
        }
        fn dir(&self, relative: &str) -> PathBuf {
            let path = self.base.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    fn pi_roots_config(command: &str, entries: serde_json::Value) -> ExternalAgentSpawnConfig {
        let mut cfg = config(command, &["--mode", "rpc"], Some("/work/project"));
        cfg.env
            .insert(PI_PACKAGE_ROOTS_ENV.into(), entries.to_string());
        cfg
    }

    #[test]
    fn desktop_plugin_install_root_matches_the_app_plugin_store() {
        let home = Path::new("/Users/dev");
        assert_eq!(
            desktop_plugin_install_root("macos", Some(home), None),
            Some(PathBuf::from(
                "/Users/dev/Library/Application Support/cognia/plugins"
            ))
        );
        assert_eq!(
            desktop_plugin_install_root("linux", Some(Path::new("/home/dev")), None),
            Some(PathBuf::from("/home/dev/.local/share/cognia/plugins"))
        );
        assert_eq!(
            desktop_plugin_install_root(
                "linux",
                Some(Path::new("/home/dev")),
                Some(Path::new("/data/xdg"))
            ),
            Some(PathBuf::from("/data/xdg/cognia/plugins"))
        );
        // A relative XDG_DATA_HOME is ignored, as `dirs` does.
        assert_eq!(
            desktop_plugin_install_root(
                "linux",
                Some(Path::new("/home/dev")),
                Some(Path::new("rel"))
            ),
            Some(PathBuf::from("/home/dev/.local/share/cognia/plugins"))
        );
        assert_eq!(
            desktop_plugin_install_root("windows", Some(home), None),
            None
        );
        assert_eq!(desktop_plugin_install_root("macos", None, None), None);
    }

    #[test]
    fn pi_package_roots_keep_only_existing_dirs_inside_the_plugin_store() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let latex = fx.dir("data/cognia/plugins/latex-workbench");
        let file = store.join("latex-workbench/README.md");
        std::fs::write(&file, "x").unwrap();
        let other_app_data = fx.dir("data/cognia/secrets");
        let ssh = fx.dir("data/cognia/plugins/evil/.ssh");
        let cfg = pi_roots_config(
            "pi",
            serde_json::json!([
                latex,
                latex,
                format!("{}/../latex-workbench", store.join("evil").display()),
                "relative/dir",
                store,
                other_app_data,
                file,
                ssh,
                store.join("missing"),
            ]),
        );
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
            vec![latex.clone()]
        );
        // No host-derived store → nothing is mounted at all.
        assert!(pi_package_readable_roots(&cfg, None, &[], &[]).is_empty());
        assert!(pi_package_readable_roots(&cfg, Some(&fx.base.join("nope")), &[], &[]).is_empty());
    }

    #[test]
    fn pi_package_roots_resolve_symlinks_before_checking_containment() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let home = fx.dir("home");
        let link = store.join("looks-like-a-plugin");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&home, &link).unwrap();
        #[cfg(unix)]
        {
            let cfg = pi_roots_config("pi", serde_json::json!([link]));
            assert!(pi_package_readable_roots(&cfg, Some(&store), &[], &[]).is_empty());
        }
    }

    #[test]
    fn pi_package_roots_refuse_malformed_values_and_non_pi_commands() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let latex = fx.dir("data/cognia/plugins/latex-workbench");
        let mut malformed = config("pi", &[], Some("/work"));
        malformed
            .env
            .insert(PI_PACKAGE_ROOTS_ENV.into(), "{not json".into());
        assert!(pi_package_readable_roots(&malformed, Some(&store), &[], &[]).is_empty());
        let object = pi_roots_config("pi", serde_json::json!({ "root": latex }));
        assert!(pi_package_readable_roots(&object, Some(&store), &[], &[]).is_empty());

        // `pi.exe` and `PI` are Pi under the wrapper's base-name rule (the same
        // one that grants Pi its state root); anything else is ignored.
        for command in ["pi.exe", "PI", "pi"] {
            let cfg = pi_roots_config(command, serde_json::json!([latex]));
            assert_eq!(
                pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
                vec![latex.clone()],
                "{command}"
            );
        }
        for command in ["codex", "copilot", "pip"] {
            let cfg = pi_roots_config(command, serde_json::json!([latex]));
            assert!(
                pi_package_readable_roots(&cfg, Some(&store), &[], &[]).is_empty(),
                "{command}"
            );
        }
    }

    #[test]
    fn pi_package_roots_never_name_a_forbidden_readable_root() {
        // Even if the host store itself were mis-derived onto a system path,
        // nothing under a forbidden readable root is admitted.
        for system in ["/var/run", "/var", "/tmp", "/etc"] {
            let store = PathBuf::from(system);
            if !store.exists() {
                continue;
            }
            let cfg = pi_roots_config("pi", serde_json::json!([store]));
            assert!(
                pi_package_readable_roots(&cfg, Some(Path::new("/")), &[], &[]).is_empty(),
                "{system}"
            );
        }
    }

    #[test]
    fn pi_package_roots_under_an_emitted_deny_are_dropped() {
        let fx = PiRootsFixture::new();
        let home = fx.dir("home");
        let store = fx.dir("home/.codex/plugins");
        let pkg = fx.dir("home/.codex/plugins/latex");
        let cfg = pi_roots_config("pi", serde_json::json!([pkg]));
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
            vec![pkg.clone()]
        );
        assert!(
            pi_package_readable_roots(&cfg, Some(&store), &[home.join(".codex")], &[]).is_empty()
        );
        assert!(pi_package_readable_roots(&cfg, Some(&store), &[home], &[]).is_empty());
    }

    /// L1: a package root that overlaps a writable root (under it, or
    /// containing it) is dropped — the agent could swap a writable directory
    /// for a symlink between validation and the bind.
    #[test]
    fn pi_package_roots_overlapping_a_writable_root_are_dropped() {
        let fx = PiRootsFixture::new();
        let store = fx.dir("data/cognia/plugins");
        let pkg = fx.dir("data/cognia/plugins/latex");
        let inner = fx.dir("data/cognia/plugins/latex/work");
        let cfg = pi_roots_config("pi", serde_json::json!([pkg]));
        // Writable at the package dir, above it, or below it: all refused.
        for writable in [pkg.clone(), store.clone(), inner.clone()] {
            assert!(
                pi_package_readable_roots(&cfg, Some(&store), &[], std::slice::from_ref(&writable))
                    .is_empty(),
                "{}",
                writable.display()
            );
        }
        // An unrelated writable root leaves it alone.
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[fx.dir("work/project")]),
            vec![pkg.clone()]
        );

        // Wrapper level: the agent's cwd inside the package makes it writable,
        // so the package is not also mounted as a readable root.
        let host = FakeHost {
            plugin_root: Some(store.clone()),
            home: Some(fx.dir("home")),
            ..FakeHost::new("macos")
        };
        let mut wrapped_cfg = config("pi", &["--mode", "rpc"], Some(inner.to_str().unwrap()));
        wrapped_cfg.env.insert(
            PI_PACKAGE_ROOTS_ENV.into(),
            serde_json::json!([pkg]).to_string(),
        );
        let wrapped = wrap_with_sandbox(wrapped_cfg, &host).unwrap();
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair[0] == "--readable" && Path::new(&pair[1]) == pkg));
    }

    /// L3: Bot isolation mounts no package roots, even when the plugin store
    /// sits OUTSIDE the hidden home (an absolute `XDG_DATA_HOME`).
    #[test]
    fn pi_package_roots_are_never_mounted_for_a_bot_isolated_spawn() {
        let fx = PiRootsFixture::new();
        let xdg = fx.dir("xdg-data");
        let store =
            desktop_plugin_install_root("linux", Some(&fx.base.join("home")), Some(&xdg)).unwrap();
        std::fs::create_dir_all(&store).unwrap();
        let pkg = fx.dir("xdg-data/cognia/plugins/latex");
        assert!(store.starts_with(&xdg) && !store.starts_with(fx.base.join("home")));

        let mut cfg = pi_roots_config("pi", serde_json::json!([pkg]));
        assert_eq!(
            pi_package_readable_roots(&cfg, Some(&store), &[], &[]),
            vec![pkg.clone()]
        );
        cfg.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        assert!(pi_package_readable_roots(&cfg, Some(&store), &[], &[]).is_empty());

        // And through the wrapper, where nothing else would have denied it.
        let host = FakeHost {
            plugin_root: Some(store.clone()),
            home: Some(fx.dir("home")),
            ..FakeHost::new("linux")
        };
        cfg.env.insert(
            "COGNIA_BOT_STATE_DIR".into(),
            fx.dir("bot-state").display().to_string(),
        );
        let wrapped = wrap_with_sandbox(cfg, &host).unwrap();
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair[0] == "--readable" && Path::new(&pair[1]) == pkg));
    }

    /// Wrapper-level invariant: whatever the mode, no `--readable` that the
    /// Pi package list contributes lands under any `--deny-readable` the
    /// wrapper emits, and a package root is never writable.
    #[test]
    fn wrapped_pi_package_roots_never_reopen_a_denied_subtree() {
        let fx = PiRootsFixture::new();
        let home = fx.dir("home");
        let store = fx.dir("home/Library/Application Support/cognia/plugins");
        let pkg = fx.dir("home/Library/Application Support/cognia/plugins/latex");
        let task_store = fx.dir("home/.local/share/cognia-agent-tasks/plugins");
        let task_pkg = fx.dir("home/.local/share/cognia-agent-tasks/plugins/latex");

        let readables = |args: &[String]| -> Vec<String> {
            args.windows(2)
                .filter(|pair| pair[0] == "--readable")
                .map(|pair| pair[1].clone())
                .collect()
        };
        let denies = |args: &[String]| -> Vec<PathBuf> {
            args.windows(2)
                .filter(|pair| pair[0] == "--deny-readable")
                .map(|pair| PathBuf::from(&pair[1]))
                .collect()
        };

        let modes: Vec<(&str, HashMap<String, String>)> = vec![
            ("default", HashMap::new()),
            (
                "bot",
                HashMap::from([
                    ("COGNIA_BOT_ISOLATION".to_string(), "1".to_string()),
                    (
                        "COGNIA_BOT_STATE_DIR".to_string(),
                        fx.dir("bot-state").display().to_string(),
                    ),
                ]),
            ),
            (
                "gateway",
                HashMap::from([(
                    crate::gateway_task::PAYLOAD_ENV.to_string(),
                    serde_json::json!({"taskId":"t1","runtime":"pi","binding":{},"files":{}})
                        .to_string(),
                )]),
            ),
        ];
        for (mode, env) in modes {
            for store_override in [None, Some(task_store.clone())] {
                let host = FakeHost {
                    plugin_root: store_override.clone().or(Some(store.clone())),
                    home: Some(home.clone()),
                    ..FakeHost::new("macos")
                };
                let candidate = if store_override.is_some() {
                    &task_pkg
                } else {
                    &pkg
                };
                let mut base = config("pi", &["--mode", "rpc"], Some("/work/project"));
                base.env.extend(env.clone());
                let without = wrap_with_sandbox(base.clone(), &host).unwrap();
                let mut with_roots = base;
                with_roots.env.insert(
                    PI_PACKAGE_ROOTS_ENV.into(),
                    serde_json::json!([candidate]).to_string(),
                );
                let wrapped = wrap_with_sandbox(with_roots, &host).unwrap();
                let before = readables(&without.args);
                let added: Vec<String> = readables(&wrapped.args)
                    .into_iter()
                    .filter(|path| !before.contains(path))
                    .collect();
                for path in &added {
                    for deny in denies(&wrapped.args) {
                        assert!(
                            !Path::new(path).starts_with(&deny),
                            "{mode}: {path} re-opens denied {}",
                            deny.display()
                        );
                    }
                }
                assert!(!wrapped
                    .args
                    .windows(2)
                    .any(|pair| pair[0] == "--writable" && Path::new(&pair[1]) == candidate));
                match (mode, store_override.is_some()) {
                    // Default mode: the package is mounted.
                    ("default", _) => assert_eq!(added, vec![candidate.display().to_string()]),
                    // Bot isolation denies the whole home; the store is under it.
                    ("bot", _) => assert!(added.is_empty(), "{mode}"),
                    // A gateway task denies the task-home parent.
                    ("gateway", true) => assert!(added.is_empty(), "{mode}"),
                    ("gateway", false) => {
                        assert_eq!(added, vec![candidate.display().to_string()])
                    }
                    _ => unreachable!(),
                }
            }
        }
    }

    #[test]
    fn gateway_task_hides_every_supported_runtime_native_state() {
        let host = FakeHost::new("macos");
        let mut original = config("kimi", &["acp"], Some("/work/project"));
        original.env.insert(
            crate::gateway_task::PAYLOAD_ENV.into(),
            serde_json::json!({"taskId":"kimi-task","runtime":"kimi","binding":{},"files":{}})
                .to_string(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        for relative in [
            ".codex",
            ".kimi-code",
            ".kimi",
            ".copilot",
            ".config/goose",
            ".local/share/goose",
            ".local/state/goose",
            ".aider",
        ] {
            let denied = format!("/home/dev/{relative}");
            assert!(
                wrapped
                    .args
                    .windows(2)
                    .any(|pair| pair[0] == "--deny-readable" && pair[1] == denied),
                "{relative}"
            );
        }
    }

    #[test]
    fn bot_launch_hides_home_and_uses_owned_state() {
        let host = FakeHost::new("macos");
        let mut original = config("devin", &["acp"], Some("/work/project"));
        original
            .env
            .insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        original
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        original.env.insert("TMPDIR".into(), "/ambient/tmp".into());
        original
            .env
            .insert("pnpm_config_store_dir".into(), "/ambient/store".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(wrapped.args.iter().any(|arg| arg == "--bot-isolation"));
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--deny-readable", "/home/dev"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--readable", "/home/dev"]));
        assert!(!wrapped
            .args
            .windows(2)
            .any(|pair| pair == ["--writable", "/home/dev/.local/share/devin"]));
        assert_eq!(wrapped.env["XDG_DATA_HOME"], "/work/state/data");
        for key in ["TMPDIR", "TMP", "TEMP"] {
            assert_eq!(wrapped.env[key], "/work/state/tmp");
        }
        assert_eq!(wrapped.env["npm_config_cache"], "/work/state/cache/npm");
        assert_eq!(
            wrapped.env["npm_config_store_dir"],
            "/work/state/cache/pnpm-store"
        );
        assert_eq!(
            wrapped.env["pnpm_config_store_dir"],
            "/work/state/cache/pnpm-store"
        );
        assert_eq!(
            wrapped.env["pnpm_config_cache_dir"],
            "/work/state/cache/pnpm"
        );
        for directory in ["tmp", "cache/npm", "cache/pnpm-store", "cache/pnpm"] {
            assert!(host
                .dirs
                .borrow()
                .contains(&PathBuf::from("/work/state").join(directory)));
        }
    }

    #[test]
    fn wrap_attests_devin_configuration_after_policy_even_for_custom_launcher_paths() {
        let host = FakeHost::new("macos");
        let mut original = config("devin", &["acp"], Some("/work/project"));
        original
            .env
            .insert(crate::devin_mcp_config::PAYLOAD_ENV.into(), "[]".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert_eq!(wrapped.command, "/opt/launcher");
        assert_eq!(wrapped.env[crate::devin_mcp_config::WRAPPED_ENV], "1");
        assert_eq!(wrapped.env[crate::devin_mcp_config::PAYLOAD_ENV], "[]");
    }

    #[test]
    fn wrap_pre_creates_state_roots_choosing_file_or_directory() {
        let host = FakeHost::new("linux");
        let original = config("claude", &[], Some("/work/project"));
        wrap_with_sandbox(original, &host).expect("sandbox wrap");

        let dirs = host.dirs.borrow();
        let files = host.files.borrow();
        assert!(dirs.contains(&PathBuf::from("/home/dev/.claude")));
        assert!(dirs.contains(&PathBuf::from("/tmp/cognia-toolhost-501")));
        assert!(files.contains(&PathBuf::from("/home/dev/.claude.json")));
        assert!(files.contains(&PathBuf::from("/home/dev/.claude.json.backup")));
        assert!(!dirs.contains(&PathBuf::from("/home/dev/.claude.json")));
    }

    #[test]
    fn wrap_refuses_unsupported_platform() {
        let host = FakeHost::new("windows");
        let error = wrap_with_sandbox(config("pi", &[], Some("/work")), &host).unwrap_err();
        assert_eq!(error, SandboxError::UnsupportedPlatform("windows".into()));
        assert_eq!(error.reason_code(), "sandbox_unavailable");
        assert!(error.to_string().contains("never runs them unsandboxed"));
    }

    #[test]
    fn wrap_refuses_when_no_launcher_is_executable() {
        let mut host = FakeHost::new("macos");
        host.executable.clear();
        let error = wrap_with_sandbox(config("pi", &[], Some("/work")), &host).unwrap_err();
        assert_eq!(error, SandboxError::LauncherUnavailable("pi".into()));
        assert!(error.to_string().contains(LAUNCHER_ENV));
    }

    #[test]
    fn wrap_refuses_a_missing_or_blank_cwd() {
        let host = FakeHost::new("macos");
        assert_eq!(
            wrap_with_sandbox(config("pi", &[], None), &host).unwrap_err(),
            SandboxError::MissingCwd
        );
        assert_eq!(
            wrap_with_sandbox(config("pi", &[], Some("   ")), &host).unwrap_err(),
            SandboxError::MissingCwd
        );
    }

    #[test]
    fn wrap_refuses_without_a_home_directory() {
        let mut host = FakeHost::new("macos");
        host.home = None;
        assert_eq!(
            wrap_with_sandbox(config("pi", &[], Some("/work")), &host).unwrap_err(),
            SandboxError::MissingHome
        );
    }

    #[test]
    fn find_launcher_picks_the_first_executable_candidate() {
        let mut host = FakeHost::new("macos");
        host.candidates = vec![
            PathBuf::from("/missing/launcher"),
            PathBuf::from("/opt/launcher"),
        ];
        assert_eq!(
            find_sandbox_launcher(&host),
            Some(PathBuf::from("/opt/launcher"))
        );
    }

    // ── Per-configuration state roots (ADR-0216) ────────────────────────────

    fn isolated_host(data: &Path) -> FakeHost {
        FakeHost {
            state_data_dir: Some(data.to_path_buf()),
            ..FakeHost::new("macos")
        }
    }

    fn pairs<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|pair| pair[0] == flag)
            .map(|pair| pair[1].as_str())
            .collect()
    }

    #[test]
    fn isolated_codex_writes_only_its_own_root_and_cannot_read_the_shared_login() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config(
            "npx",
            &["-y", "@zed-industries/codex-acp"],
            Some("/work/project"),
        );
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg-1".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let root = data.path().join("cognia/external-agents/cfg-1");
        let writable = pairs(&wrapped.args, "--writable");
        assert!(writable.contains(&root.to_str().unwrap()), "{writable:?}");
        assert!(!writable.contains(&"/home/dev/.codex"), "{writable:?}");
        // npx's own cache is not a login root and stays writable.
        assert!(writable.contains(&"/home/dev/.npm"));
        assert!(pairs(&wrapped.args, "--deny-readable").contains(&"/home/dev/.codex"));
        assert_eq!(
            wrapped.env["CODEX_HOME"],
            root.join("codex").to_string_lossy()
        );
        assert!(!wrapped
            .env
            .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
        // The shared login root is never pre-created for an isolated launch.
        assert!(!host
            .dirs
            .borrow()
            .contains(&PathBuf::from("/home/dev/.codex")));
        let separator = wrapped.args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(wrapped.args[separator + 1], "npx");
    }

    #[test]
    fn isolated_claude_never_creates_or_writes_the_shared_json_files() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("claude-agent-acp", &[], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "c".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let writable = pairs(&wrapped.args, "--writable");
        let denied = pairs(&wrapped.args, "--deny-readable");
        for shared in [
            "/home/dev/.claude",
            "/home/dev/.claude.json",
            "/home/dev/.claude.json.backup",
        ] {
            assert!(!writable.contains(&shared), "{shared}");
            assert!(denied.contains(&shared), "{shared}");
        }
        assert!(host.files.borrow().is_empty());
        assert!(wrapped.env["CLAUDE_CONFIG_DIR"].ends_with("external-agents/c/claude"));
    }

    #[test]
    fn isolated_kimi_cline_and_qoder_rebase_onto_the_private_root() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        for (command, env_key, shared, sub) in [
            ("kimi", "KIMI_CODE_HOME", "/home/dev/.kimi-code", "kimi"),
            ("cline", "CLINE_DIR", "/home/dev/.cline", "cline"),
            ("qoder", "QODER_CONFIG_DIR", "/home/dev/.qoder", "qoder"),
        ] {
            let mut original = config(command, &["--acp"], Some("/work/project"));
            original.env.insert(
                crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
                format!("{command}-cfg"),
            );
            // A caller value for the owned key never wins.
            original
                .env
                .insert(env_key.into(), "/somewhere/else".into());
            let wrapped = wrap_with_sandbox(original, &host).unwrap();
            let own = data
                .path()
                .join("cognia/external-agents")
                .join(format!("{command}-cfg"))
                .join(sub);
            assert_eq!(wrapped.env[env_key], own.to_string_lossy(), "{command}");
            let writable = pairs(&wrapped.args, "--writable");
            assert!(!writable.contains(&shared), "{command}: {writable:?}");
            assert!(!writable.contains(&"/somewhere/else"), "{command}");
            // Temp lands inside the isolated home too.
            assert!(
                wrapped.env["TMPDIR"].starts_with(own.to_str().unwrap()),
                "{command}"
            );
        }
    }

    #[test]
    fn isolated_qoder_keeps_its_login_root_readable() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("qoder", &["--acp"], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "q".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(!pairs(&wrapped.args, "--deny-readable").contains(&"/home/dev/.qoder"));
    }

    #[test]
    fn isolated_opencode_maps_xdg_homes_into_the_root() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("opencode", &["acp"], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "oc".into(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        let root = data.path().join("cognia/external-agents/oc");
        assert_eq!(
            wrapped.env["XDG_DATA_HOME"],
            root.join("data").to_string_lossy()
        );
        assert_eq!(
            wrapped.env["XDG_STATE_HOME"],
            root.join("state").to_string_lossy()
        );
        assert_eq!(
            wrapped.env["XDG_CACHE_HOME"],
            root.join("cache").to_string_lossy()
        );
        let writable = pairs(&wrapped.args, "--writable");
        for shared in [
            "/home/dev/.config/opencode",
            "/home/dev/.local/share/opencode",
        ] {
            assert!(!writable.contains(&shared));
            assert!(pairs(&wrapped.args, "--deny-readable").contains(&shared));
        }
    }

    #[test]
    fn isolated_launch_refuses_unsupported_runtimes_bad_keys_and_unknown_data_dirs() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut gemini = config("gemini", &["--acp"], Some("/work/project"));
        gemini.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "g".into(),
        );
        let error = wrap_with_sandbox(gemini, &host).unwrap_err();
        assert_eq!(
            error,
            SandboxError::StateIsolation("state isolation unsupported for gemini".into())
        );
        assert_eq!(error.reason_code(), "state_isolation_failed");

        let mut bad = config("codex", &[], Some("/work/project"));
        bad.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "../../etc".into(),
        );
        assert!(matches!(
            wrap_with_sandbox(bad, &host),
            Err(SandboxError::StateIsolation(_))
        ));

        let no_data = FakeHost::new("macos");
        let mut codex = config("codex", &[], Some("/work/project"));
        codex.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "c".into(),
        );
        assert!(matches!(
            wrap_with_sandbox(codex, &no_data),
            Err(SandboxError::StateIsolation(_))
        ));
    }

    #[test]
    fn bot_isolation_wins_over_a_state_key() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("codex", &[], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg".into(),
        );
        original
            .env
            .insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        original
            .env
            .insert("COGNIA_BOT_STATE_DIR".into(), "/work/state".into());
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(!wrapped
            .env
            .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
        assert!(!wrapped.env.contains_key("CODEX_HOME"));
        assert!(pairs(&wrapped.args, "--writable").contains(&"/work/state"));
        assert!(!data.path().join("cognia").exists());
    }

    #[test]
    fn gateway_task_wins_over_a_state_key() {
        let data = tempfile::tempdir().unwrap();
        let host = isolated_host(data.path());
        let mut original = config("codex", &[], Some("/work/project"));
        original.env.insert(
            crate::state_isolation::AGENT_STATE_KEY_ENV.into(),
            "cfg".into(),
        );
        original.env.insert(
            crate::gateway_task::PAYLOAD_ENV.into(),
            serde_json::json!({"taskId":"t1","runtime":"codex","binding":{},"files":{}})
                .to_string(),
        );
        let wrapped = wrap_with_sandbox(original, &host).unwrap();
        assert!(!wrapped
            .env
            .contains_key(crate::state_isolation::AGENT_STATE_KEY_ENV));
        assert!(!wrapped.env.contains_key("CODEX_HOME"));
        assert!(!data.path().join("cognia").exists());
    }
}
