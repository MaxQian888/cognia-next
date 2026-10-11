//! Install a Cognia host as an OS service (ADR-0224 A1).
//!
//! One writer renders every service definition Cognia installs: the always-on
//! server host's LaunchDaemon or systemd unit, and the desktop's durable
//! terminal host's login agent. The work is split so that nothing here touches
//! the machine except through [`ServiceIo`]:
//!
//! - [`render_launchd_plist`] / [`render_systemd_unit`] are pure text,
//! - [`install_plan`] / [`uninstall_plan`] decide the file and the commands for
//!   a scope and platform,
//! - [`install`], [`uninstall`] and [`status`] apply a plan through an IO port,
//!   which [`SystemIo`] implements for real and tests replace.
//!
//! Windows has no host service here: its terminal host keeps a logon task of
//! its own, and an always-on server on Windows is out of scope (ADR-0224).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

pub mod install_home;
pub mod server;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod update_agent;

/// Where a service runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceScope {
    /// Per-user: a LaunchAgent or a `systemd --user` unit. Starts at login (or
    /// at boot on Linux when the user has lingering enabled).
    User,
    /// Machine-wide: a LaunchDaemon or a system unit. Starts at boot with no
    /// login, and runs as [`ServiceSpec::run_as`].
    System,
}

impl ServiceScope {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceScope::User => "user",
            ServiceScope::System => "system",
        }
    }
}

/// The service managers this crate writes for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServicePlatform {
    MacOs,
    Linux,
}

impl ServicePlatform {
    /// The platform this binary was built for, if it has a service manager here.
    pub fn current() -> Result<Self, ServiceError> {
        if cfg!(target_os = "macos") {
            Ok(ServicePlatform::MacOs)
        } else if cfg!(target_os = "linux") {
            Ok(ServicePlatform::Linux)
        } else {
            Err(ServiceError::UnsupportedPlatform)
        }
    }
}

/// How the service manager restarts the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartPolicy {
    /// Restart whenever it exits (launchd `KeepAlive`, systemd `Restart=always`).
    Always,
    /// Restart only after a failure (systemd `Restart=on-failure`; launchd has
    /// no distinction and keeps it alive).
    OnFailure,
}

/// Everything a service definition says, independent of the service manager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    /// launchd label, reverse-DNS (`com.cognia.server`).
    pub label: String,
    /// systemd unit stem (`cognia-server` → `cognia-server.service`).
    pub unit: String,
    pub description: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub working_directory: Option<PathBuf>,
    /// One file for stdout and stderr.
    pub log_path: Option<PathBuf>,
    /// Account the process runs as in [`ServiceScope::System`]. Ignored in the
    /// user scope, where it is always the installing user.
    pub run_as: Option<String>,
    /// systemd credentials (`LoadCredential=<name>:<path>`), read by the
    /// manager as root and exposed to the process under
    /// `$CREDENTIALS_DIRECTORY/<name>`. launchd has no equivalent; specs that
    /// rely on one also carry a file fallback in `env`.
    pub credentials: Vec<(String, PathBuf)>,
    pub restart: RestartPolicy,
}

/// Locations that depend on who is installing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerContext {
    /// Home directory of the installing user (user scope definitions live here).
    pub home: PathBuf,
    /// Numeric uid of the installing user (the launchd `gui/<uid>` domain).
    pub uid: u32,
}

impl InstallerContext {
    /// The current process's user.
    pub fn current() -> Result<Self, ServiceError> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or(ServiceError::NoHome)?;
        Ok(Self {
            home,
            uid: current_uid(),
        })
    }
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

/// Whether this process can write a system-scope definition.
pub fn running_as_root() -> bool {
    current_uid() == 0
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ServiceError {
    #[error("this platform has no supported service manager (macOS launchd or Linux systemd)")]
    UnsupportedPlatform,
    #[error("HOME is not set, so the user-scope service location is unknown")]
    NoHome,
    #[error("a system-scope service needs `run_as`: it must never run as root by default")]
    SystemScopeWithoutUser,
    #[error("installing a system-scope service needs root; rerun with sudo or choose the user scope")]
    NotRoot,
    #[error("{0}")]
    Invalid(String),
    #[error("{action} failed: {detail}")]
    Io { action: String, detail: String },
    #[error("`{command}` exited unsuccessfully: {stderr}")]
    Command { command: String, stderr: String },
}

/// The file a plan writes and the commands it runs around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallPlan {
    pub definition_path: PathBuf,
    pub definition: String,
    /// Unix mode for the definition file.
    pub mode: u32,
    /// Run before writing; failures are ignored (unloading a service that was
    /// never loaded is not an error).
    pub unload: Vec<Vec<String>>,
    /// Run after writing; every one must succeed.
    pub load: Vec<Vec<String>>,
    /// Things the operator should know that the plan cannot do for them.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallPlan {
    pub definition_path: PathBuf,
    /// Run before removing the file; failures are ignored.
    pub unload: Vec<Vec<String>>,
    /// Run after removing the file; failures are ignored.
    pub after: Vec<Vec<String>>,
}

fn definition_path(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
) -> PathBuf {
    match (platform, scope) {
        (ServicePlatform::MacOs, ServiceScope::User) => ctx
            .home
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", spec.label)),
        (ServicePlatform::MacOs, ServiceScope::System) => {
            PathBuf::from("/Library/LaunchDaemons").join(format!("{}.plist", spec.label))
        }
        (ServicePlatform::Linux, ServiceScope::User) => ctx
            .home
            .join(".config/systemd/user")
            .join(format!("{}.service", spec.unit)),
        (ServicePlatform::Linux, ServiceScope::System) => {
            PathBuf::from("/etc/systemd/system").join(format!("{}.service", spec.unit))
        }
    }
}

fn launchd_domain(scope: ServiceScope, ctx: &InstallerContext) -> String {
    match scope {
        ServiceScope::User => format!("gui/{}", ctx.uid),
        ServiceScope::System => "system".to_string(),
    }
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_string()).collect()
}

fn validate(spec: &ServiceSpec, scope: ServiceScope) -> Result<(), ServiceError> {
    let label_ok = !spec.label.is_empty()
        && spec
            .label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !label_ok {
        return Err(ServiceError::Invalid(format!(
            "service label {:?} must be non-empty ASCII letters, digits, '.', '-' or '_'",
            spec.label
        )));
    }
    let unit_ok = !spec.unit.is_empty()
        && spec
            .unit
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if !unit_ok {
        return Err(ServiceError::Invalid(format!(
            "unit name {:?} must be non-empty ASCII letters, digits, '-' or '_'",
            spec.unit
        )));
    }
    if !spec.program.is_absolute() {
        return Err(ServiceError::Invalid(format!(
            "service program {} must be an absolute path",
            spec.program.display()
        )));
    }
    for (name, _) in &spec.credentials {
        if name.is_empty() || name.contains(['/', ':']) {
            return Err(ServiceError::Invalid(format!(
                "credential name {name:?} must be non-empty and contain no '/' or ':'"
            )));
        }
    }
    if scope == ServiceScope::System && spec.run_as.as_deref().unwrap_or("").is_empty() {
        return Err(ServiceError::SystemScopeWithoutUser);
    }
    Ok(())
}

/// The definition file and commands that install `spec`.
pub fn install_plan(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
) -> Result<InstallPlan, ServiceError> {
    validate(spec, scope)?;
    let path = definition_path(spec, scope, platform, ctx);
    let path_text = path.to_string_lossy().into_owned();
    match platform {
        ServicePlatform::MacOs => {
            let domain = launchd_domain(scope, ctx);
            Ok(InstallPlan {
                definition: render_launchd_plist(spec, scope),
                definition_path: path,
                // launchd refuses a daemon plist that is group- or world-writable.
                mode: match scope {
                    ServiceScope::User => 0o600,
                    ServiceScope::System => 0o644,
                },
                unload: vec![argv(&[
                    "launchctl",
                    "bootout",
                    &format!("{domain}/{}", spec.label),
                ])],
                load: vec![argv(&["launchctl", "bootstrap", &domain, &path_text])],
                notes: Vec::new(),
            })
        }
        ServicePlatform::Linux => {
            let unit = format!("{}.service", spec.unit);
            // `enable --now` leaves an already-running unit on its old
            // definition; `restart` applies a reinstall (and starts a new one).
            let (reload, enable, restart, notes) = match scope {
                ServiceScope::User => (
                    argv(&["systemctl", "--user", "daemon-reload"]),
                    argv(&["systemctl", "--user", "enable", &unit]),
                    argv(&["systemctl", "--user", "restart", &unit]),
                    vec![
                        "A user unit starts at login. Run `loginctl enable-linger $USER` once \
                         so it starts at boot without one."
                            .to_string(),
                    ],
                ),
                ServiceScope::System => (
                    argv(&["systemctl", "daemon-reload"]),
                    argv(&["systemctl", "enable", &unit]),
                    argv(&["systemctl", "restart", &unit]),
                    Vec::new(),
                ),
            };
            Ok(InstallPlan {
                definition: render_systemd_unit(spec, scope),
                definition_path: path,
                mode: match scope {
                    ServiceScope::User => 0o600,
                    ServiceScope::System => 0o644,
                },
                unload: Vec::new(),
                load: vec![reload, enable, restart],
                notes,
            })
        }
    }
}

/// The commands and file that remove a service installed with [`install_plan`].
pub fn uninstall_plan(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
) -> UninstallPlan {
    let path = definition_path(spec, scope, platform, ctx);
    match platform {
        ServicePlatform::MacOs => UninstallPlan {
            unload: vec![argv(&[
                "launchctl",
                "bootout",
                &format!("{}/{}", launchd_domain(scope, ctx), spec.label),
            ])],
            after: Vec::new(),
            definition_path: path,
        },
        ServicePlatform::Linux => {
            let unit = format!("{}.service", spec.unit);
            let (disable, reload) = match scope {
                ServiceScope::User => (
                    argv(&["systemctl", "--user", "disable", "--now", &unit]),
                    argv(&["systemctl", "--user", "daemon-reload"]),
                ),
                ServiceScope::System => (
                    argv(&["systemctl", "disable", "--now", &unit]),
                    argv(&["systemctl", "daemon-reload"]),
                ),
            };
            UninstallPlan {
                unload: vec![disable],
                after: vec![reload],
                definition_path: path,
            }
        }
    }
}

/// The one command whose success means "the service manager has it loaded".
pub fn status_command(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
) -> Vec<String> {
    match platform {
        ServicePlatform::MacOs => argv(&[
            "launchctl",
            "print",
            &format!("{}/{}", launchd_domain(scope, ctx), spec.label),
        ]),
        ServicePlatform::Linux => {
            let unit = format!("{}.service", spec.unit);
            match scope {
                ServiceScope::User => argv(&["systemctl", "--user", "is-active", &unit]),
                ServiceScope::System => argv(&["systemctl", "is-active", &unit]),
            }
        }
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// A launchd property list for `spec`.
pub fn render_launchd_plist(spec: &ServiceSpec, scope: ServiceScope) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n",
    );
    let _ = writeln!(
        out,
        "  <key>Label</key>\n  <string>{}</string>",
        xml_escape(&spec.label)
    );
    out.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    let _ = writeln!(
        out,
        "    <string>{}</string>",
        xml_escape(&spec.program.to_string_lossy())
    );
    for arg in &spec.args {
        let _ = writeln!(out, "    <string>{}</string>", xml_escape(arg));
    }
    out.push_str("  </array>\n");
    if !spec.env.is_empty() {
        out.push_str("  <key>EnvironmentVariables</key>\n  <dict>\n");
        for (key, value) in &spec.env {
            let _ = writeln!(
                out,
                "    <key>{}</key>\n    <string>{}</string>",
                xml_escape(key),
                xml_escape(value)
            );
        }
        out.push_str("  </dict>\n");
    }
    if let Some(dir) = &spec.working_directory {
        let _ = writeln!(
            out,
            "  <key>WorkingDirectory</key>\n  <string>{}</string>",
            xml_escape(&dir.to_string_lossy())
        );
    }
    if let Some(log) = &spec.log_path {
        let log = xml_escape(&log.to_string_lossy());
        let _ = writeln!(
            out,
            "  <key>StandardOutPath</key>\n  <string>{log}</string>\n  \
             <key>StandardErrorPath</key>\n  <string>{log}</string>"
        );
    }
    if scope == ServiceScope::System {
        if let Some(user) = &spec.run_as {
            let _ = writeln!(
                out,
                "  <key>UserName</key>\n  <string>{}</string>",
                xml_escape(user)
            );
        }
    }
    out.push_str("  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n");
    out.push_str("</dict>\n</plist>\n");
    out
}

/// One systemd `ExecStart=` word: quoted, with `\`, `"` escaped and the
/// specifier `%` and variable `$` characters doubled so systemd passes them
/// through literally.
pub fn systemd_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    format!("\"{escaped}\"")
}

/// One `Environment=` assignment: quoted, with `\`, `"` escaped and the
/// specifier `%` doubled. systemd does no variable expansion there, so `$`
/// stays as is.
fn systemd_env_quote(assignment: &str) -> String {
    let escaped = assignment
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

/// A path in a systemd directive that takes no quoting (`WorkingDirectory=`,
/// `StandardOutput=append:`): only the specifier character needs escaping.
fn systemd_path(path: &Path) -> String {
    path.to_string_lossy().replace('%', "%%")
}

/// A systemd unit file for `spec`.
pub fn render_systemd_unit(spec: &ServiceSpec, scope: ServiceScope) -> String {
    let mut out = String::from("[Unit]\n");
    let _ = writeln!(out, "Description={}", spec.description.replace('\n', " "));
    out.push_str("After=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n");
    let mut exec = systemd_quote(&spec.program.to_string_lossy());
    for arg in &spec.args {
        exec.push(' ');
        exec.push_str(&systemd_quote(arg));
    }
    let _ = writeln!(out, "ExecStart={exec}");
    for (key, value) in &spec.env {
        // `Environment=` takes one quoted `KEY=value` assignment per word.
        let _ = writeln!(out, "Environment={}", systemd_env_quote(&format!("{key}={value}")));
    }
    for (name, path) in &spec.credentials {
        let _ = writeln!(out, "LoadCredential={name}:{}", systemd_path(path));
    }
    if let Some(dir) = &spec.working_directory {
        let _ = writeln!(out, "WorkingDirectory={}", systemd_path(dir));
    }
    if let Some(log) = &spec.log_path {
        let log = systemd_path(log);
        let _ = writeln!(out, "StandardOutput=append:{log}\nStandardError=append:{log}");
    }
    if scope == ServiceScope::System {
        if let Some(user) = &spec.run_as {
            let _ = writeln!(out, "User={user}");
        }
    }
    let restart = match spec.restart {
        RestartPolicy::Always => "always",
        RestartPolicy::OnFailure => "on-failure",
    };
    let _ = writeln!(out, "Restart={restart}\nRestartSec=5\n");
    let target = match scope {
        ServiceScope::User => "default.target",
        ServiceScope::System => "multi-user.target",
    };
    let _ = writeln!(out, "[Install]\nWantedBy={target}");
    out
}

/// What a command run returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutcome {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Everything [`install`], [`uninstall`] and [`status`] do to the machine.
pub trait ServiceIo {
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()>;
    fn write_file(&self, path: &Path, contents: &str, mode: u32) -> std::io::Result<()>;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
    fn exists(&self, path: &Path) -> bool;
    fn run(&self, argv: &[String]) -> std::io::Result<CommandOutcome>;
}

/// The real machine.
pub struct SystemIo;

impl ServiceIo for SystemIo {
    fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)
    }

    fn write_file(&self, path: &Path, contents: &str, mode: u32) -> std::io::Result<()> {
        write_with_mode(path, contents.as_bytes(), mode)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn run(&self, argv: &[String]) -> std::io::Result<CommandOutcome> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| std::io::Error::other("empty command"))?;
        let output = std::process::Command::new(program).args(args).output()?;
        Ok(CommandOutcome {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Write `bytes` to `path` with `mode`, replacing it atomically.
pub fn write_with_mode(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write as _;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("definition path has no parent"))?;
    let staging = parent.join(format!(
        ".{}.staging",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    {
        let mut file = std::fs::File::create(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    set_mode(&staging, mode)?;
    std::fs::rename(&staging, path)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

fn command_text(argv: &[String]) -> String {
    argv.join(" ")
}

/// Write the definition and load it. Returns the plan that was applied.
pub fn install(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
    io: &dyn ServiceIo,
) -> Result<InstallPlan, ServiceError> {
    let plan = install_plan(spec, scope, platform, ctx)?;
    for command in &plan.unload {
        let _ = io.run(command);
    }
    if let Some(parent) = plan.definition_path.parent() {
        io.create_dir_all(parent).map_err(|error| ServiceError::Io {
            action: format!("create {}", parent.display()),
            detail: error.to_string(),
        })?;
    }
    io.write_file(&plan.definition_path, &plan.definition, plan.mode)
        .map_err(|error| ServiceError::Io {
            action: format!("write {}", plan.definition_path.display()),
            detail: error.to_string(),
        })?;
    for command in &plan.load {
        let outcome = io.run(command).map_err(|error| ServiceError::Io {
            action: format!("run `{}`", command_text(command)),
            detail: error.to_string(),
        })?;
        if !outcome.success {
            return Err(ServiceError::Command {
                command: command_text(command),
                stderr: outcome.stderr.trim().to_string(),
            });
        }
    }
    Ok(plan)
}

/// Unload the service and remove its definition. Removing a service that was
/// never installed is not an error.
pub fn uninstall(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
    io: &dyn ServiceIo,
) -> Result<UninstallPlan, ServiceError> {
    let plan = uninstall_plan(spec, scope, platform, ctx);
    for command in &plan.unload {
        let _ = io.run(command);
    }
    if io.exists(&plan.definition_path) {
        io.remove_file(&plan.definition_path)
            .map_err(|error| ServiceError::Io {
                action: format!("remove {}", plan.definition_path.display()),
                detail: error.to_string(),
            })?;
    }
    for command in &plan.after {
        let _ = io.run(command);
    }
    Ok(plan)
}

/// What [`status`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceStatus {
    pub definition_path: PathBuf,
    pub installed: bool,
    /// The service manager has it loaded (launchd) or active (systemd).
    pub running: bool,
}

pub fn status(
    spec: &ServiceSpec,
    scope: ServiceScope,
    platform: ServicePlatform,
    ctx: &InstallerContext,
    io: &dyn ServiceIo,
) -> ServiceStatus {
    let definition_path = definition_path(spec, scope, platform, ctx);
    let installed = io.exists(&definition_path);
    let running = io
        .run(&status_command(spec, scope, platform, ctx))
        .map(|outcome| outcome.success)
        .unwrap_or(false);
    ServiceStatus {
        definition_path,
        installed,
        running,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            label: "com.cognia.server".into(),
            unit: "cognia-server".into(),
            description: "Cognia always-on host".into(),
            program: PathBuf::from("/opt/cognia host/bin/cognia-server"),
            args: vec!["serve".into(), "--port".into(), "27890".into()],
            env: BTreeMap::from([
                ("COGNIA_DATA_DIR".to_string(), "/var/lib/cognia".to_string()),
                ("PATH".to_string(), "/opt/node/bin:$PATH 100%".to_string()),
            ]),
            working_directory: Some(PathBuf::from("/var/lib/cognia")),
            log_path: Some(PathBuf::from("/var/log/cognia/server.log")),
            run_as: Some("max".into()),
            credentials: vec![(
                "cognia-master-key".into(),
                PathBuf::from("/etc/cognia/master.key"),
            )],
            restart: RestartPolicy::Always,
        }
    }

    fn ctx() -> InstallerContext {
        InstallerContext {
            home: PathBuf::from("/Users/max"),
            uid: 501,
        }
    }

    #[derive(Default)]
    struct FakeIo {
        files: RefCell<BTreeMap<PathBuf, (String, u32)>>,
        ran: RefCell<Vec<Vec<String>>>,
        fail: Option<&'static str>,
    }

    impl ServiceIo for FakeIo {
        fn create_dir_all(&self, _path: &Path) -> std::io::Result<()> {
            Ok(())
        }
        fn write_file(&self, path: &Path, contents: &str, mode: u32) -> std::io::Result<()> {
            self.files
                .borrow_mut()
                .insert(path.to_path_buf(), (contents.to_string(), mode));
            Ok(())
        }
        fn remove_file(&self, path: &Path) -> std::io::Result<()> {
            self.files.borrow_mut().remove(path);
            Ok(())
        }
        fn exists(&self, path: &Path) -> bool {
            self.files.borrow().contains_key(path)
        }
        fn run(&self, argv: &[String]) -> std::io::Result<CommandOutcome> {
            self.ran.borrow_mut().push(argv.to_vec());
            let failed = self.fail.is_some_and(|word| argv.iter().any(|arg| arg == word));
            Ok(CommandOutcome {
                success: !failed,
                stdout: String::new(),
                stderr: if failed { "boom".into() } else { String::new() },
            })
        }
    }

    #[test]
    fn launchd_daemon_runs_as_the_named_user_and_escapes_xml() {
        let mut spec = spec();
        spec.args.push("<&>".into());
        let plist = render_launchd_plist(&spec, ServiceScope::System);
        assert!(plist.contains("<string>com.cognia.server</string>"));
        assert!(plist.contains("<string>/opt/cognia host/bin/cognia-server</string>"));
        assert!(plist.contains("<string>&lt;&amp;&gt;</string>"));
        assert!(plist.contains("<key>UserName</key>\n  <string>max</string>"));
        assert!(plist.contains("<key>COGNIA_DATA_DIR</key>\n    <string>/var/lib/cognia</string>"));
        assert!(plist.contains("<key>StandardErrorPath</key>"));
        assert!(plist.contains("<key>KeepAlive</key>\n  <true/>"));
        // A user agent never names a user: it is always the one logged in.
        assert!(!render_launchd_plist(&spec, ServiceScope::User).contains("UserName"));
    }

    #[test]
    fn systemd_unit_quotes_words_and_passes_specifiers_through() {
        let unit = render_systemd_unit(&spec(), ServiceScope::System);
        assert!(unit.contains(
            "ExecStart=\"/opt/cognia host/bin/cognia-server\" \"serve\" \"--port\" \"27890\""
        ));
        // `Environment=` does not expand `$`, so it must not be doubled there.
        assert!(unit.contains("Environment=\"PATH=/opt/node/bin:$PATH 100%%\""));
        assert!(unit.contains("LoadCredential=cognia-master-key:/etc/cognia/master.key"));
        assert!(unit.contains("User=max"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains("WantedBy=multi-user.target"));
        let user = render_systemd_unit(&spec(), ServiceScope::User);
        assert!(!user.contains("User=max"));
        assert!(user.contains("WantedBy=default.target"));
    }

    #[test]
    fn plans_put_each_scope_where_its_manager_reads_it() {
        let macos_user =
            install_plan(&spec(), ServiceScope::User, ServicePlatform::MacOs, &ctx()).unwrap();
        assert_eq!(
            macos_user.definition_path,
            PathBuf::from("/Users/max/Library/LaunchAgents/com.cognia.server.plist")
        );
        assert_eq!(macos_user.load[0], argv(&["launchctl", "bootstrap", "gui/501", "/Users/max/Library/LaunchAgents/com.cognia.server.plist"]));
        assert_eq!(macos_user.mode, 0o600);

        let macos_system =
            install_plan(&spec(), ServiceScope::System, ServicePlatform::MacOs, &ctx()).unwrap();
        assert_eq!(
            macos_system.definition_path,
            PathBuf::from("/Library/LaunchDaemons/com.cognia.server.plist")
        );
        assert_eq!(macos_system.unload[0], argv(&["launchctl", "bootout", "system/com.cognia.server"]));
        assert_eq!(macos_system.mode, 0o644);

        let linux_user =
            install_plan(&spec(), ServiceScope::User, ServicePlatform::Linux, &ctx()).unwrap();
        assert_eq!(
            linux_user.definition_path,
            PathBuf::from("/Users/max/.config/systemd/user/cognia-server.service")
        );
        assert!(linux_user.notes[0].contains("enable-linger"));
        assert_eq!(
            linux_user.load,
            vec![
                argv(&["systemctl", "--user", "daemon-reload"]),
                argv(&["systemctl", "--user", "enable", "cognia-server.service"]),
                argv(&["systemctl", "--user", "restart", "cognia-server.service"]),
            ]
        );

        let linux_system =
            install_plan(&spec(), ServiceScope::System, ServicePlatform::Linux, &ctx()).unwrap();
        assert_eq!(
            linux_system.definition_path,
            PathBuf::from("/etc/systemd/system/cognia-server.service")
        );
    }

    #[test]
    fn a_system_service_must_name_a_user_and_specs_are_validated() {
        let mut no_user = spec();
        no_user.run_as = None;
        assert_eq!(
            install_plan(&no_user, ServiceScope::System, ServicePlatform::Linux, &ctx()),
            Err(ServiceError::SystemScopeWithoutUser)
        );
        // The user scope does not need one.
        assert!(install_plan(&no_user, ServiceScope::User, ServicePlatform::Linux, &ctx()).is_ok());

        let mut bad_label = spec();
        bad_label.label = "com.cognia/../x".into();
        assert!(matches!(
            install_plan(&bad_label, ServiceScope::User, ServicePlatform::MacOs, &ctx()),
            Err(ServiceError::Invalid(_))
        ));
        let mut relative = spec();
        relative.program = PathBuf::from("bin/cognia-server");
        assert!(matches!(
            install_plan(&relative, ServiceScope::User, ServicePlatform::MacOs, &ctx()),
            Err(ServiceError::Invalid(_))
        ));
        let mut bad_credential = spec();
        bad_credential.credentials = vec![("a:b".into(), PathBuf::from("/k"))];
        assert!(matches!(
            install_plan(&bad_credential, ServiceScope::System, ServicePlatform::Linux, &ctx()),
            Err(ServiceError::Invalid(_))
        ));
    }

    #[test]
    fn install_writes_then_loads_and_reports_a_failed_load() {
        let io = FakeIo::default();
        let plan = install(&spec(), ServiceScope::User, ServicePlatform::MacOs, &ctx(), &io).unwrap();
        assert!(io.exists(&plan.definition_path));
        let ran = io.ran.borrow().clone();
        assert_eq!(ran.first().unwrap()[1], "bootout");
        assert_eq!(ran.last().unwrap()[1], "bootstrap");

        let failing = FakeIo {
            fail: Some("bootstrap"),
            ..FakeIo::default()
        };
        let error =
            install(&spec(), ServiceScope::User, ServicePlatform::MacOs, &ctx(), &failing).unwrap_err();
        assert!(matches!(error, ServiceError::Command { ref stderr, .. } if stderr == "boom"));
    }

    #[test]
    fn uninstall_and_status_follow_the_definition() {
        let io = FakeIo::default();
        install(&spec(), ServiceScope::System, ServicePlatform::Linux, &ctx(), &io).unwrap();
        let installed = status(&spec(), ServiceScope::System, ServicePlatform::Linux, &ctx(), &io);
        assert!(installed.installed && installed.running);

        uninstall(&spec(), ServiceScope::System, ServicePlatform::Linux, &ctx(), &io).unwrap();
        let removed = status(&spec(), ServiceScope::System, ServicePlatform::Linux, &ctx(), &io);
        assert!(!removed.installed);
        // Uninstalling twice is not an error.
        assert!(uninstall(&spec(), ServiceScope::System, ServicePlatform::Linux, &ctx(), &io).is_ok());
    }

    #[test]
    fn write_with_mode_replaces_atomically_with_the_requested_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("svc.plist");
        write_with_mode(&path, b"one", 0o600).unwrap();
        write_with_mode(&path, b"two", 0o644).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o644);
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
