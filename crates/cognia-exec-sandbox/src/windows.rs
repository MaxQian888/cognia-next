//! Windows v2 runner boundary. Roots remain deliberately inert until a signed
//! filesystem enforcement project ships. Admission precedes target launch;
//! capability probing never launches the requested command.

use async_trait::async_trait;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::filesystem_plan::FilesystemPlan;
use crate::traits::SandboxedExec;
use crate::types::{
    NetworkAllowlistProbe, NetworkAllowlistState, NetworkPolicy, NetworkReport, SandboxCommand,
    SandboxError, SandboxHealth, SandboxPolicy, SandboxResult, WindowsCapabilities,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CAPABILITY_BYTES: u64 = 16_384;
type CacheKey = (PathBuf, SystemTime, u64);
type CapabilityCache = HashMap<CacheKey, WindowsCapabilities>;
static CAPABILITIES: OnceLock<Mutex<CapabilityCache>> = OnceLock::new();

#[derive(Debug, Clone, Default)]
pub struct WindowsSandboxBackend {
    // Only unit tests may choose an installation directory; production has no
    // cwd, PATH, environment or user-writable marker override.
    #[cfg(test)]
    install_dir: Option<PathBuf>,
}

impl WindowsSandboxBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn runner_path(&self) -> Result<PathBuf, SandboxError> {
        #[cfg(test)]
        if let Some(dir) = &self.install_dir {
            return trusted_runner_path(dir, &dir.join("cognia-sandbox-runner.exe"));
        }
        let exe = std::env::current_exe().map_err(|e| unavailable(e.to_string()))?;
        let dir = exe
            .parent()
            .ok_or_else(|| unavailable("executable has no parent"))?;
        trusted_runner_path(dir, &dir.join("cognia-sandbox-runner.exe"))
    }

    fn capabilities(&self) -> Result<WindowsCapabilities, SandboxError> {
        let runner = self.runner_path()?;
        cached_capabilities(&runner, probe_capabilities).map_err(unavailable)
    }
}

fn unavailable(reason: impl Into<String>) -> SandboxError {
    SandboxError::Unavailable {
        reason: reason.into(),
    }
}

/// Only called for the host's newly created private scratch directory, after
/// admission. A Low integrity child cannot write a default Medium directory.
/// LABEL_SECURITY_INFORMATION changes the integrity label without relaxing
/// the existing owner or DACL, and never relabels a caller-provided root.
#[cfg(windows)]
fn mark_private_scratch_low_integrity(path: &Path) -> Result<(), SandboxError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorSacl, ACL, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    let failure = |error| unavailable(format!("private scratch integrity unavailable: {error}"));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // The constant SDDL contains one Low mandatory-label ACE, denying write-up.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("S:(ML;;NW;;;LW)"),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(failure)?;
    let result = (|| {
        let mut present = BOOL::default();
        let mut defaulted = BOOL::default();
        let mut sacl: *mut ACL = std::ptr::null_mut();
        unsafe { GetSecurityDescriptorSacl(descriptor, &mut present, &mut sacl, &mut defaulted) }
            .map_err(failure)?;
        if !present.as_bool() || sacl.is_null() {
            return Err(unavailable(
                "private scratch integrity unavailable: missing label ACL",
            ));
        }
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                None,
                None,
                None,
                Some(sacl.cast_const()),
            )
        }
        .ok()
        .map_err(failure)
    })();
    // The ACL borrows descriptor storage; free only after the setter returns,
    // including every error path after descriptor conversion succeeded.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result
}

/// A symlink/reparse point cannot redirect the bundled runner out of the
/// canonical installation directory. The legacy setup marker is a timestamp,
/// not an installation-path authority, and cannot authorize another location.
fn trusted_runner_path(install_dir: &Path, candidate: &Path) -> Result<PathBuf, SandboxError> {
    let install = install_dir
        .canonicalize()
        .map_err(|e| unavailable(format!("runner install directory: {e}")))?;
    let runner = candidate
        .canonicalize()
        .map_err(|e| SandboxError::SetupRequired {
            reason: format!("Windows sandbox runner missing beside the host executable: {e}"),
        })?;
    if runner.parent() != Some(install.as_path()) || !runner.is_file() {
        return Err(unavailable("untrusted_windows_sandbox_runner_path: runner must reside in the host installation directory"));
    }
    Ok(runner)
}

fn cached_capabilities(
    runner: &Path,
    probe: impl FnOnce(&Path) -> Result<WindowsCapabilities, String>,
) -> Result<WindowsCapabilities, String> {
    let metadata = runner.metadata().map_err(|e| e.to_string())?;
    let key = (
        runner.to_path_buf(),
        metadata.modified().map_err(|e| e.to_string())?,
        metadata.len(),
    );
    let cache = CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().map_err(|e| e.to_string())?.get(&key).cloned() {
        return Ok(cached);
    }
    let result = probe(runner);
    let mut cache = cache.lock().map_err(|e| e.to_string())?;
    cache.retain(|existing, _| existing.0 != key.0);
    if let Ok(capabilities) = &result {
        cache.insert(key, capabilities.clone());
    }
    result
}

fn parse_capabilities(bytes: &[u8]) -> Result<WindowsCapabilities, String> {
    let capabilities: WindowsCapabilities = serde_json::from_slice(bytes)
        .map_err(|e| format!("windows_runner_capabilities_invalid: {e}"))?;
    if !capabilities.protocol_versions.contains(&2)
        || !capabilities.restricted_token
        || !capabilities.low_integrity
        || !capabilities.job_object
        || capabilities.network_enforcement != "unconfined"
        || (!capabilities.filesystem_enforcement && capabilities.filesystem_reason.is_empty())
    {
        return Err("windows_runner_capabilities_unsupported: v2 and token/integrity/job guarantees required".into());
    }
    Ok(capabilities)
}

fn probe_capabilities(runner: &Path) -> Result<WindowsCapabilities, String> {
    use std::io::Read;
    let mut child = std::process::Command::new(runner)
        .arg("--capabilities-v2")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("windows_runner_capabilities_unavailable: {e}"))?;
    let started = Instant::now();
    // A capability report fits in the pipe. Oversize or wedged probes are
    // killed at the same deadline, without unbounded buffering or threads.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(10))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("windows_runner_capabilities_unavailable: probe timeout/wait failure: {result:?}"));
            }
        }
    };
    if !status.success() {
        return Err(format!(
            "windows_runner_capabilities_unavailable: probe exited {status}"
        ));
    }
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .ok_or("capability stdout missing")?
        .take(CAPABILITY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > CAPABILITY_BYTES as usize {
        return Err("windows_runner_capabilities_invalid: oversized report".into());
    }
    parse_capabilities(&bytes)
}

fn admit(
    capabilities: &WindowsCapabilities,
    filesystem: &FilesystemPlan,
    network: &str,
) -> Result<(), SandboxError> {
    if filesystem.has_roots() && !capabilities.filesystem_enforcement {
        return Err(unavailable("windows_filesystem_roots_unenforced: filesystem roots are inert; not confined (minifilter is a separate project)"));
    }
    if matches!(network, "off" | "allowlist") {
        return Err(unavailable(format!(
            "windows_network_unenforced: {network} cannot be enforced; network not restricted"
        )));
    }
    Ok(())
}

fn network_request(policy: &SandboxPolicy) -> &'static str {
    match policy {
        SandboxPolicy::Bash { network, .. } => match network {
            NetworkPolicy::Off => "off",
            NetworkPolicy::On => "on",
            NetworkPolicy::Allowlist { .. } => "allowlist",
        },
        _ => "unspecified",
    }
}

fn network_report(policy: &SandboxPolicy) -> NetworkReport {
    NetworkReport {
        requested: match policy {
            SandboxPolicy::Bash { network, .. } => Some(network.clone()),
            _ => None,
        },
        effective: Some(NetworkPolicy::On),
        mechanism: Some("unconfined".into()),
    }
}

#[derive(serde::Serialize)]
#[serde(deny_unknown_fields)]
struct RunnerEnvelope<'a> {
    protocol: u32,
    request: RunnerRequest<'a>,
}

#[derive(serde::Serialize)]
#[serde(deny_unknown_fields)]
struct RunnerRequest<'a> {
    argv: &'a [String],
    cwd: String,
    env: &'a BTreeMap<String, String>,
    timeout_seconds: u64,
    limits: RunnerLimits,
    network: &'static str,
    filesystem: FilesystemPlan,
}

#[derive(serde::Serialize)]
#[serde(deny_unknown_fields)]
struct RunnerLimits {
    max_memory_mb: u32,
    max_job_memory_mb: u32,
    max_cpu_seconds: u32,
    max_processes: u32,
}

fn build_runner_payload<'a>(
    command: &'a SandboxCommand,
    policy: &SandboxPolicy,
    filesystem: FilesystemPlan,
) -> RunnerEnvelope<'a> {
    let (max_memory_mb, max_cpu_seconds, max_processes) = match policy {
        SandboxPolicy::Bash {
            max_memory_mb,
            max_cpu_seconds,
            max_processes,
            ..
        } => (*max_memory_mb, *max_cpu_seconds, *max_processes),
        _ => (0, 0, 0),
    };
    RunnerEnvelope {
        protocol: 2,
        request: RunnerRequest {
            argv: &command.argv,
            cwd: command.cwd.to_string_lossy().into_owned(),
            env: &command.env,
            timeout_seconds: command.timeout.as_secs(),
            limits: RunnerLimits {
                max_memory_mb,
                max_job_memory_mb: 0,
                max_cpu_seconds,
                max_processes,
            },
            network: network_request(policy),
            filesystem,
        },
    }
}

#[derive(serde::Deserialize)]
struct RunnerOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    stdout_truncated: bool,
    stderr_truncated: bool,
    confinement: RunnerConfinement,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerConfinement {
    network_requested: String,
    network_enforced: String,
}

#[async_trait]
impl SandboxedExec for WindowsSandboxBackend {
    async fn run(
        &self,
        mut command: SandboxCommand,
        policy: SandboxPolicy,
    ) -> Result<SandboxResult, SandboxError> {
        let runner = self.runner_path()?;
        let capabilities = self.capabilities()?;
        crate::env::filter_env(&mut command.env);
        // Reserve a private per-run scratch path; it is never interpreted as
        // permission to ignore the policy's explicit filesystem roots.
        let scratch = tempfile::Builder::new()
            .prefix("cognia-windows-sandbox-")
            .tempdir()
            .map_err(|e| unavailable(format!("private scratch unavailable: {e}")))?;
        let home = dirs::home_dir().ok_or_else(|| unavailable("home directory unavailable"))?;
        let mut runtime_reads = Vec::new();
        if let Some(root) = std::env::var_os("SystemRoot") {
            runtime_reads.push(PathBuf::from(root));
        }
        if let Some(path) = std::env::var_os("PATH") {
            runtime_reads.extend(std::env::split_paths(&path).filter(|p| p.is_absolute()));
        }
        let filesystem =
            FilesystemPlan::from_policy(&policy, &home, &runtime_reads, scratch.path())?;
        admit(&capabilities, &filesystem, network_request(&policy))?;
        if command.stdin.is_some() {
            return Err(unavailable(
                "windows_runner_stdin_unsupported: v2 stdin carries the request",
            ));
        }
        #[cfg(windows)]
        mark_private_scratch_low_integrity(scratch.path())?;
        let payload = build_runner_payload(&command, &policy, filesystem);
        let serialised = serde_json::to_vec(&payload).map_err(|e| SandboxError::BackendFailed {
            reason: e.to_string(),
        })?;
        // Cover stdin delivery and output wait too. A zero timeout uses the
        // runner's finite five-minute default, never an infinite host wait.
        let host_timeout = if command.timeout.is_zero() {
            315
        } else {
            command.timeout.as_secs().saturating_add(15)
        };
        let child = Command::new(&runner)
            .arg("--protocol-v2")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SandboxError::BackendFailed {
                reason: format!("spawn {runner:?}: {e}"),
            })?;
        let operation = async {
            let mut child = child;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| std::io::Error::other("runner stdin missing"))?;
            stdin.write_all(&serialised).await?;
            stdin.shutdown().await?;
            drop(stdin);
            child.wait_with_output().await
        };
        let output = timeout(Duration::from_secs(host_timeout), operation)
            .await
            .map_err(|_| SandboxError::Timeout {
                seconds: host_timeout,
            })?
            .map_err(|e| SandboxError::BackendFailed {
                reason: format!("runner transport failed: {e}"),
            })?;
        if !output.status.success() {
            let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if output.status.code() == Some(3) {
                unavailable(reason)
            } else {
                SandboxError::BackendFailed {
                    reason: format!("runner exited {}: {reason}", output.status),
                }
            });
        }
        let parsed: RunnerOutput =
            serde_json::from_slice(&output.stdout).map_err(|e| SandboxError::BackendFailed {
                reason: format!("parse v2 runner output: {e}"),
            })?;
        if parsed.confinement.network_enforced != "unconfined"
            || parsed.confinement.network_requested != network_request(&policy)
        {
            return Err(SandboxError::BackendFailed {
                reason: "runner network evidence does not match the admitted request".into(),
            });
        }
        let (stdout, stdout_truncated) = crate::output::truncate_utf8(
            parsed.stdout,
            crate::output::MAX_OUTPUT_BYTES,
            parsed.stdout_truncated,
        );
        let (stderr, stderr_truncated) = crate::output::truncate_utf8(
            parsed.stderr,
            crate::output::MAX_OUTPUT_BYTES,
            parsed.stderr_truncated,
        );
        Ok(SandboxResult {
            network: network_report(&policy),
            exit_code: parsed.exit_code,
            stdout,
            stderr,
            duration: Duration::from_millis(parsed.duration_ms),
            timed_out: parsed.timed_out,
            stdout_truncated,
            stderr_truncated,
        })
    }

    fn is_available(&self) -> bool {
        self.runner_path().is_ok()
    }

    async fn first_time_setup(&self) -> Result<(), SandboxError> {
        self.capabilities().map(|_| ())
    }

    fn health(&self) -> SandboxHealth {
        let capabilities = self.capabilities();
        SandboxHealth {
            available: capabilities.is_ok(),
            backend: "windows-cognia-sandbox".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            last_error: capabilities
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default(),
            windows_capabilities: capabilities.ok(),
        }
    }

    async fn probe_confinement(&self) -> crate::types::ProbeReport {
        // No target is needed to demonstrate a known capability refusal.
        // Keep this distinct from a crashed runner in the active health UI.
        let detail = match self.capabilities() {
            Ok(capabilities) if !capabilities.filesystem_enforcement => {
                "not confined: windows_filesystem_roots_unenforced; filesystem enforcement is inert"
                    .into()
            }
            Ok(_) => "not confined: windows_network_unenforced; network Off is unavailable".into(),
            Err(error) => format!("not confined: {error}"),
        };
        crate::types::ProbeReport {
            backend: "windows-cognia-sandbox".into(),
            confined: false,
            detail,
            network_allowlist: self.probe_network_allowlist().await,
        }
    }

    async fn probe_network_allowlist(&self) -> NetworkAllowlistProbe {
        NetworkAllowlistProbe {
            state: NetworkAllowlistState::Unavailable,
            detail: "windows_network_unenforced: network not restricted".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_private_scratch_has_low_integrity_and_missing_path_refuses() {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
            SDDL_REVISION_1, SE_FILE_OBJECT,
        };
        use windows::Win32::Security::{LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

        let scratch = tempfile::tempdir().unwrap();
        mark_private_scratch_low_integrity(scratch.path()).unwrap();
        let name: Vec<u16> = scratch
            .path()
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut descriptor,
            )
        }
        .ok()
        .unwrap();
        let mut sddl = PWSTR::null();
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                LABEL_SECURITY_INFORMATION,
                &mut sddl,
                None,
            )
        };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        converted.unwrap();
        let label = unsafe { sddl.to_string() };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sddl.0.cast())));
        }
        assert!(label.unwrap().contains("(ML;;NW;;;LW)"));
        assert!(matches!(
            mark_private_scratch_low_integrity(&scratch.path().join("missing")),
            Err(SandboxError::Unavailable { .. })
        ));
    }

    fn capabilities() -> WindowsCapabilities {
        parse_capabilities(br#"{"protocolVersions":[2],"filesystemEnforcement":false,"filesystemReason":"windows_filesystem_roots_unenforced","networkEnforcement":"unconfined","restrictedToken":true,"lowIntegrity":true,"jobObject":true}"#).unwrap()
    }
    fn plan() -> FilesystemPlan {
        FilesystemPlan {
            readable_trees: vec![],
            writable_trees: vec![],
            writable_files: vec![],
            deny_read: vec![],
            deny_write: vec![],
            runtime_reads: vec![],
            private_scratch: "C:\\scratch".into(),
        }
    }
    fn policy(network: NetworkPolicy) -> SandboxPolicy {
        SandboxPolicy::Bash {
            writable: vec![],
            readable: vec![],
            network,
            max_cpu_seconds: 5,
            max_memory_mb: 128,
            max_processes: 96,
        }
    }
    #[test]
    fn windows_capability_parsing_fails_closed() {
        let value = serde_json::to_value(capabilities()).unwrap();
        for key in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(
                parse_capabilities(&serde_json::to_vec(&missing).unwrap()).is_err(),
                "{key}"
            );
        }
        let mut extra = value.clone();
        extra["unknown"] = true.into();
        assert!(parse_capabilities(&serde_json::to_vec(&extra).unwrap()).is_err());
        let mut old = value;
        old["protocolVersions"] = serde_json::json!([1]);
        assert!(parse_capabilities(&serde_json::to_vec(&old).unwrap()).is_err());
    }
    #[test]
    fn windows_roots_are_intentionally_inert_and_refused() {
        for field in ["read", "write", "file"] {
            let mut fs = plan();
            match field {
                "read" => fs.readable_trees.push("C:\\work".into()),
                "write" => fs.writable_trees.push("C:\\work".into()),
                _ => fs.writable_files.push("C:\\work\\a.txt".into()),
            }
            let error = admit(&capabilities(), &fs, "on").unwrap_err();
            assert!(matches!(error, SandboxError::Unavailable { .. }));
            assert!(error
                .to_string()
                .contains("windows_filesystem_roots_unenforced"));
        }
    }
    #[test]
    fn windows_off_and_allowlist_refused_on_reports_unrestricted() {
        for network in ["off", "allowlist"] {
            assert!(matches!(
                admit(&capabilities(), &plan(), network),
                Err(SandboxError::Unavailable { .. })
            ));
        }
        assert!(admit(&capabilities(), &plan(), "on").is_ok());
        let evidence = network_report(&policy(NetworkPolicy::On));
        assert_eq!(evidence.effective, Some(NetworkPolicy::On));
        assert_eq!(evidence.mechanism.as_deref(), Some("unconfined"));
    }
    #[test]
    fn windows_payload_is_complete_nested_v2() {
        let command = SandboxCommand {
            argv: vec!["whoami".into()],
            cwd: PathBuf::from("C:\\work"),
            env: BTreeMap::from([("FOO".into(), "bar".into())]),
            stdin: None,
            timeout: Duration::from_secs(42),
        };
        let value = serde_json::to_value(build_runner_payload(
            &command,
            &policy(NetworkPolicy::On),
            plan(),
        ))
        .unwrap();
        assert_eq!(value["protocol"], 2);
        assert_eq!(value["request"]["env"]["FOO"], "bar");
        assert_eq!(value["request"]["timeout_seconds"], 42);
        assert_eq!(
            value["request"]["limits"],
            serde_json::json!({"max_memory_mb":128,"max_job_memory_mb":0,"max_cpu_seconds":5,"max_processes":96})
        );
        assert!(value["request"]["filesystem"].is_object());
    }
    #[test]
    fn windows_runner_must_resolve_inside_installation() {
        let install = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let good = install.path().join("runner.exe");
        let bad = outside.path().join("runner.exe");
        std::fs::write(&good, "runner").unwrap();
        std::fs::write(&bad, "runner").unwrap();
        assert!(trusted_runner_path(install.path(), &good).is_ok());
        assert!(matches!(
            trusted_runner_path(install.path(), &bad),
            Err(SandboxError::Unavailable { .. })
        ));
        #[cfg(unix)]
        {
            let link = install.path().join("escape.exe");
            std::os::unix::fs::symlink(bad, &link).unwrap();
            assert!(trusted_runner_path(install.path(), &link).is_err());
        }
    }
    #[test]
    fn windows_capability_cache_invalidates_changed_runner() {
        let dir = tempfile::tempdir().unwrap();
        let runner = dir.path().join("runner.exe");
        std::fs::write(&runner, "v2").unwrap();
        assert!(cached_capabilities(&runner, |_| Ok(capabilities())).is_ok());
        assert!(cached_capabilities(&runner, |_| panic!("must use cache")).is_ok());
        std::fs::write(&runner, "replacement").unwrap();
        assert!(cached_capabilities(&runner, |_| Err("new runner refused".into())).is_err());
        let other = dir.path().join("other.exe");
        std::fs::write(&other, "v2").unwrap();
        assert!(cached_capabilities(&other, |_| Err("different path".into())).is_err());
        assert!(
            cached_capabilities(&other, |_| Ok(capabilities())).is_ok(),
            "transient probe failure must be retryable"
        );
    }
    #[tokio::test]
    async fn windows_missing_runner_is_setup_required() {
        let dir = tempfile::tempdir().unwrap();
        let backend = WindowsSandboxBackend {
            install_dir: Some(dir.path().to_path_buf()),
        };
        assert!(!backend.is_available());
        assert!(!backend.health().available);
        assert!(matches!(
            backend.first_time_setup().await,
            Err(SandboxError::SetupRequired { .. })
        ));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn windows_host_uses_stdin_and_refuses_before_target_launch() {
        use std::os::unix::fs::PermissionsExt;
        let install = tempfile::tempdir().unwrap();
        let runner = install.path().join("cognia-sandbox-runner.exe");
        let report = serde_json::to_string(&capabilities()).unwrap();
        // The script is a protocol fixture, never a real Windows confinement
        // claim. It records requests only after a --protocol-v2 invocation.
        let script = format!(
            r#"#!/bin/sh
case "$1" in
  --capabilities-v2) printf '%s' '{report}'; exit 0 ;;
  --protocol-v2) cat > "$(dirname "$0")/request.json" ;;
  *) exit 77 ;;
esac
printf '%s' '{{"exit_code":0,"stdout":"ok","stderr":"","duration_ms":1,"timed_out":false,"stdout_truncated":false,"stderr_truncated":false,"confinement":{{"networkRequested":"on","networkEnforced":"unconfined"}}}}'
"#
        );
        std::fs::write(&runner, script).unwrap();
        std::fs::set_permissions(&runner, std::fs::Permissions::from_mode(0o700)).unwrap();
        let backend = WindowsSandboxBackend {
            install_dir: Some(install.path().to_path_buf()),
        };
        let command = SandboxCommand {
            argv: vec!["ignored-by-fixture".into()],
            cwd: install.path().to_path_buf(),
            env: BTreeMap::from([("SECRET_FOR_TEST".into(), "stdin-only".into())]),
            stdin: None,
            timeout: Duration::from_secs(2),
        };
        let health = backend.health();
        assert!(health.available);
        assert!(!health.windows_capabilities.unwrap().filesystem_enforcement);
        let mut rooted = policy(NetworkPolicy::On);
        if let SandboxPolicy::Bash { writable, .. } = &mut rooted {
            writable.push(install.path().to_path_buf());
        }
        for refused in [
            rooted,
            policy(NetworkPolicy::Off),
            policy(NetworkPolicy::Allowlist {
                hosts: vec!["example.com".into()],
            }),
        ] {
            assert!(matches!(
                backend.run(command.clone(), refused).await,
                Err(SandboxError::Unavailable { .. })
            ));
            assert!(!install.path().join("request.json").exists());
        }
        let probe = backend.probe_confinement().await;
        assert!(!probe.confined);
        assert!(probe
            .detail
            .contains("not confined: windows_filesystem_roots_unenforced"));
        assert!(!install.path().join("request.json").exists());
        let result = backend
            .run(command, policy(NetworkPolicy::On))
            .await
            .unwrap();
        assert_eq!(result.stdout, "ok");
        assert_eq!(result.network.effective, Some(NetworkPolicy::On));
        let request: serde_json::Value =
            serde_json::from_slice(&std::fs::read(install.path().join("request.json")).unwrap())
                .unwrap();
        assert_eq!(request["protocol"], 2);
        assert_eq!(request["request"]["env"]["SECRET_FOR_TEST"], "stdin-only");
    }
}
