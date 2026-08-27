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
}

impl SandboxError {
    /// Stable reason code for the renderer, matching the one ADR-0119 names.
    pub fn reason_code(&self) -> &'static str {
        "sandbox_unavailable"
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
            Self::MissingHome => write!(
                f,
                "The external-agent sandbox could not determine this user's home directory."
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
fn base_command(command: &str) -> String {
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
/// Shape is fixed by `crates/cognia-automation/src/bin/cognia-external-agent-launcher.rs`:
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
    out.push("--network".to_string());
    out.push("--".to_string());
    out.push(command.to_string());
    out.extend(args.iter().cloned());
    out
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

/// Rewrite a validated spawn config so the agent runs under the launcher.
///
/// Call this **after** the command allowlist has run: the allowlist requires a
/// bare binary name, and this replaces `command` with the launcher's absolute
/// path. Doing it the other way round would either reject the launcher or
/// admit an arbitrary path as the agent binary.
pub fn wrap_with_sandbox(
    config: ExternalAgentSpawnConfig,
    host: &dyn SandboxHost,
) -> Result<ExternalAgentSpawnConfig, SandboxError> {
    if !sandbox_supports_os(host.os()) {
        return Err(SandboxError::UnsupportedPlatform(host.os().to_string()));
    }
    let launcher = find_sandbox_launcher(host)
        .ok_or_else(|| SandboxError::LauncherUnavailable(config.command.clone()))?;
    let home = host.home().ok_or(SandboxError::MissingHome)?;
    let cwd = config
        .cwd
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(SandboxError::MissingCwd)?;

    let tool_host_dir = tool_host_runtime_dir(&host.temp_dir(), host.uid());
    for root in agent_state_writable_roots(&config.command, &config.args, &home) {
        if is_state_file_root(&root) {
            host.ensure_file(&root);
        } else {
            host.ensure_dir(&root);
        }
    }
    host.ensure_dir(&tool_host_dir);

    let args =
        build_sandbox_launcher_args(&config.command, &config.args, &cwd, &home, &tool_host_dir);

    Ok(ExternalAgentSpawnConfig {
        command: launcher.to_string_lossy().into_owned(),
        args,
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
    }

    fn config(command: &str, args: &[&str], cwd: Option<&str>) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: "agent-1".to_string(),
            command: command.to_string(),
            args: args.iter().map(|value| value.to_string()).collect(),
            env: HashMap::new(),
            cwd: cwd.map(|value| value.to_string()),
            framing: Default::default(),
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
}
