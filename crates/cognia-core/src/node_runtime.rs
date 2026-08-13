//! Shared Node.js runtime selection and validation.
//!
//! Desktop builds install one immutable result during Tauri setup. Every
//! app-owned JavaScript child then reads that result, so a process cannot
//! silently fall back to a different `node` executable. Headless binaries do
//! not install a desktop result and retain their explicit `node`-on-`PATH`
//! deployment contract.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use wait_timeout::ChildExt;

pub const MIN_SYSTEM_NODE_MAJOR: u64 = 26;
pub const BUNDLED_NODE_VERSION: (u64, u64, u64) = (26, 3, 1);
pub const NODE_DOWNLOAD_URL: &str = "https://nodejs.org/en/download";
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeRuntimeInfo {
    pub executable: PathBuf,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NodeRuntimeError {
    code: &'static str,
    message: String,
}

impl NodeRuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for NodeRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NodeRuntimeError {}

static DESKTOP_RUNTIME: OnceLock<Result<NodeRuntimeInfo, NodeRuntimeError>> = OnceLock::new();

pub fn parse_node_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().strip_prefix('v')?.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

fn probe_node(path: &Path) -> Result<(String, (u64, u64, u64)), NodeRuntimeError> {
    probe_node_with_timeout(path, NODE_PROBE_TIMEOUT)
}

fn probe_node_with_timeout(
    path: &Path,
    timeout: Duration,
) -> Result<(String, (u64, u64, u64)), NodeRuntimeError> {
    let mut command = std::process::Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        NodeRuntimeError::new(
            "COGNIA_NODE_PROBE_FAILED",
            format!("Failed to execute Node.js at {}: {error}", path.display()),
        )
    })?;
    match child.wait_timeout(timeout) {
        Ok(Some(_)) => {}
        Ok(None) => {
            terminate_probe_process_tree(&mut child);
            let _ = child.wait();
            return Err(NodeRuntimeError::new(
                "COGNIA_NODE_PROBE_TIMEOUT",
                format!(
                    "Node.js at {} did not answer `--version` within {} seconds",
                    path.display(),
                    timeout.as_secs_f64()
                ),
            ));
        }
        Err(error) => {
            terminate_probe_process_tree(&mut child);
            let _ = child.wait();
            return Err(NodeRuntimeError::new(
                "COGNIA_NODE_PROBE_FAILED",
                format!(
                    "Failed while waiting for Node.js at {}: {error}",
                    path.display()
                ),
            ));
        }
    }
    let output = child.wait_with_output().map_err(|error| {
        NodeRuntimeError::new(
            "COGNIA_NODE_PROBE_FAILED",
            format!(
                "Failed to collect Node.js version output from {}: {error}",
                path.display()
            ),
        )
    })?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(NodeRuntimeError::new(
            "COGNIA_NODE_PROBE_FAILED",
            format!(
                "`{} --version` exited with status {:?}",
                path.display(),
                output.status.code()
            ),
        ));
    }
    let parsed = parse_node_version(&version).ok_or_else(|| {
        NodeRuntimeError::new(
            "COGNIA_NODE_VERSION_INVALID",
            format!(
                "Could not parse Node.js version {version:?} from {}",
                path.display()
            ),
        )
    })?;
    Ok((version, parsed))
}

fn terminate_probe_process_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        // The probe starts in its own process group, so a shim cannot leave a
        // descendant behind after the startup deadline expires.
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        if let Ok(mut taskkill) = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            if !matches!(taskkill.wait_timeout(Duration::from_secs(1)), Ok(Some(_))) {
                let _ = taskkill.kill();
                let _ = taskkill.wait();
            }
        }
    }
    let _ = child.kill();
}

pub fn system_node_missing_error() -> NodeRuntimeError {
    NodeRuntimeError::new(
        "COGNIA_SYSTEM_NODE_MISSING",
        format!(
            "This lightweight Cognia build requires Node.js >= {MIN_SYSTEM_NODE_MAJOR}. Install it from {NODE_DOWNLOAD_URL}, then fully restart Cognia so it can refresh the system PATH."
        ),
    )
}

pub fn system_node_too_old_error(path: &Path, version: &str) -> NodeRuntimeError {
    NodeRuntimeError::new(
        "COGNIA_SYSTEM_NODE_TOO_OLD",
        format!(
            "Found Node.js {version} at {}, but this lightweight Cognia build requires Node.js >= {MIN_SYSTEM_NODE_MAJOR}. Upgrade it from {NODE_DOWNLOAD_URL}, then fully restart Cognia.",
            path.display()
        ),
    )
}

pub fn bundled_node_missing_error() -> NodeRuntimeError {
    NodeRuntimeError::new(
        "COGNIA_BUNDLED_NODE_MISSING",
        "The verified bundled Node.js 26.3.1 runtime is missing. Reinstall Cognia or rerun the Tauri runtime preparation.",
    )
}

pub fn validate_system_node(path: PathBuf) -> Result<NodeRuntimeInfo, NodeRuntimeError> {
    let (version, parsed) = probe_node(&path).map_err(|error| {
        NodeRuntimeError::new(
            error.code(),
            format!(
                "{}. Install Node.js >= {MIN_SYSTEM_NODE_MAJOR} from {NODE_DOWNLOAD_URL}, then fully restart Cognia.",
                error.message
            ),
        )
    })?;
    if parsed.0 < MIN_SYSTEM_NODE_MAJOR {
        return Err(system_node_too_old_error(&path, &version));
    }
    Ok(NodeRuntimeInfo {
        executable: path,
        version,
    })
}

pub fn validate_bundled_node(path: PathBuf) -> Result<NodeRuntimeInfo, NodeRuntimeError> {
    if !path.is_absolute() {
        return Err(NodeRuntimeError::new(
            "COGNIA_BUNDLED_NODE_INVALID",
            "The bundled Node.js executable path must be absolute",
        ));
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        NodeRuntimeError::new(
            "COGNIA_BUNDLED_NODE_MISSING",
            format!(
                "The verified bundled Node.js runtime is missing at {}: {error}",
                path.display()
            ),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NodeRuntimeError::new(
            "COGNIA_BUNDLED_NODE_INVALID",
            format!(
                "The bundled Node.js executable must be a non-symlink regular file: {}",
                path.display()
            ),
        ));
    }
    let (version, parsed) = probe_node(&path)?;
    if parsed.0 != BUNDLED_NODE_VERSION.0 || parsed < BUNDLED_NODE_VERSION {
        return Err(NodeRuntimeError::new(
            "COGNIA_BUNDLED_NODE_VERSION_INVALID",
            format!(
                "The bundled runtime requires patched Node.js 26.3.1 or newer on the Node 26 line, but found {version} at {}",
                path.display()
            ),
        ));
    }
    Ok(NodeRuntimeInfo {
        executable: path,
        version,
    })
}

/// Install the desktop runtime result exactly once during Tauri setup.
pub fn install_desktop_runtime(
    runtime: Result<NodeRuntimeInfo, NodeRuntimeError>,
) -> Result<(), &'static str> {
    DESKTOP_RUNTIME
        .set(runtime)
        .map_err(|_| "desktop Node.js runtime was already configured")
}

/// Resolve the executable selected for app-owned Node.js subprocesses.
///
/// Headless binaries intentionally receive the bare `node` command when no
/// desktop result was installed.
pub fn node_executable() -> Result<PathBuf, NodeRuntimeError> {
    match DESKTOP_RUNTIME.get() {
        Some(Ok(runtime)) => Ok(runtime.executable.clone()),
        Some(Err(error)) => Err(error.clone()),
        None => Ok(PathBuf::from("node")),
    }
}

pub fn configured_node_executable() -> Option<Result<PathBuf, NodeRuntimeError>> {
    DESKTOP_RUNTIME.get().map(|runtime| {
        runtime
            .as_ref()
            .map(|runtime| runtime.executable.clone())
            .map_err(Clone::clone)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parses_canonical_node_versions() {
        assert_eq!(parse_node_version("v26.3.1\n"), Some((26, 3, 1)));
        assert_eq!(parse_node_version("v28.0.0"), Some((28, 0, 0)));
        assert_eq!(parse_node_version("26.3.1"), None);
        assert_eq!(parse_node_version("v26.3"), None);
    }

    #[test]
    fn missing_system_runtime_error_contains_install_guidance() {
        let error = system_node_missing_error();

        assert_eq!(error.code(), "COGNIA_SYSTEM_NODE_MISSING");
        assert!(error.to_string().contains("Node.js >= 26"));
        assert!(error.to_string().contains("https://nodejs.org/en/download"));
    }

    #[test]
    fn old_system_runtime_error_reports_the_detected_version_and_path() {
        let error = system_node_too_old_error(Path::new("/opt/node/bin/node"), "v24.9.0");

        assert_eq!(error.code(), "COGNIA_SYSTEM_NODE_TOO_OLD");
        assert!(error.to_string().contains("v24.9.0"));
        assert!(error.to_string().contains("/opt/node/bin/node"));
        assert!(error.to_string().contains("https://nodejs.org/en/download"));
    }

    #[cfg(unix)]
    fn executable_script(body: &str) -> tempfile::TempPath {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "#!/bin/sh\n{body}").unwrap();
        let mut permissions = file.as_file().metadata().unwrap().permissions();
        permissions.set_mode(0o700);
        file.as_file().set_permissions(permissions).unwrap();
        file.into_temp_path()
    }

    #[cfg(unix)]
    #[test]
    fn validates_the_system_node_version_boundary() {
        let supported = executable_script("printf 'v26.0.0\\n'");
        let old = executable_script("printf 'v25.9.0\\n'");

        assert_eq!(
            validate_system_node(supported.to_path_buf())
                .unwrap()
                .version,
            "v26.0.0"
        );
        assert_eq!(
            validate_system_node(old.to_path_buf()).unwrap_err().code(),
            "COGNIA_SYSTEM_NODE_TOO_OLD"
        );
    }

    #[cfg(unix)]
    #[test]
    fn node_probe_has_a_hard_deadline() {
        let hanging = executable_script("sleep 5");

        let error = probe_node_with_timeout(&hanging, Duration::from_millis(20)).unwrap_err();

        assert_eq!(error.code(), "COGNIA_NODE_PROBE_TIMEOUT");
    }

    #[cfg(unix)]
    #[test]
    fn bundled_runtime_rejects_symlinks() {
        let runtime = executable_script("printf 'v26.3.1\\n'");
        let directory = tempfile::tempdir().unwrap();
        let link = directory.path().join("node");
        std::os::unix::fs::symlink(&runtime, &link).unwrap();

        assert_eq!(
            validate_bundled_node(link).unwrap_err().code(),
            "COGNIA_BUNDLED_NODE_INVALID"
        );
    }
}
