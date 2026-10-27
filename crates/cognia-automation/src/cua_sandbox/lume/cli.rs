//! Pinned CLI and SSH subprocesses. No shell, user SSH config, forwarding or PTY.
use cognia_desktop_guest::lume::{self, Envelope, Reply};
use serde::Deserialize;
use std::{
    net::IpAddr,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

pub const HELPER_COMMAND: &str = "/usr/local/libexec/cognia-lume-guest serve-stdio";
pub const DRIVER_COMMAND: &str = "/usr/local/bin/cua-driver mcp";
const OUTPUT_LIMIT: usize = 12 * 1024 * 1024;

pub fn command(binary: &Path, args: &[String]) -> Command {
    let mut command = Command::new(binary);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    if let Some(home) = dirs::home_dir() {
        command.env("HOME", home);
    }
    command
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

pub async fn bounded(
    command: Command,
    input: Vec<u8>,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    bounded_admitted(command, input, timeout, cancel, None).await
}

async fn bounded_admitted(
    mut command: Command,
    input: Vec<u8>,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
    admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("lume_process_cancelled".into());
    }
    if admission.as_ref().is_some_and(|check| !check()) {
        return Err("lume_preempted_before_send".into());
    }
    command.stdin(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "lume_process_spawn")?;
    let mut stdin = child.stdin.take().ok_or("lume_process_stdin")?;
    let stdout = child.stdout.take().ok_or("lume_process_stdout")?;
    let work = async {
        let write = async {
            if cancel.load(Ordering::Acquire) {
                return Err("lume_process_cancelled");
            }
            if admission.as_ref().is_some_and(|check| !check()) {
                return Err("lume_preempted_before_send");
            }
            stdin
                .write_all(&input)
                .await
                .map_err(|_| "lume_process_write")?;
            stdin.shutdown().await.map_err(|_| "lume_process_write")
        };
        let read = async {
            let mut bytes = Vec::new();
            stdout
                .take((OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "lume_process_read")?;
            if bytes.len() > OUTPUT_LIMIT {
                return Err("lume_process_output_limit");
            }
            Ok(bytes)
        };
        let (_, output) = tokio::try_join!(write, read)?;
        let status = child.wait().await.map_err(|_| "lume_process_wait")?;
        if !status.success() {
            return Err("lume_process_failed");
        }
        Ok(output)
    };
    let cancellation = async {
        loop {
            if cancel.load(Ordering::Acquire) || admission.as_ref().is_some_and(|check| !check()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    let result = tokio::select! {
        result = tokio::time::timeout(timeout, work) => result.map_err(|_| "lume_process_timeout").and_then(|r| r),
        _ = cancellation => Err("lume_process_cancelled"),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result.map_err(str::to_owned)
}

pub async fn cli(
    binary: &Path,
    args: &[String],
    timeout: Duration,
    cancel: Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    bounded(command(binary, args), vec![], timeout, cancel).await
}

pub fn run_vm(binary: &Path, name: &str, storage: &Path, setup: bool) -> Result<Child, String> {
    let args = vec![
        "run".into(),
        name.into(),
        "--storage".into(),
        storage.to_string_lossy().into_owned(),
        "--display".into(),
        if setup { "native" } else { "none" }.into(),
        "--vnc".into(),
        "disabled".into(),
    ];
    command(binary, &args)
        .stdout(Stdio::null())
        .spawn()
        .map_err(|_| "lume_run_spawn".into())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub name: String,
    pub status: String,
    pub memory_size: u64,
    pub cpu_count: u32,
    pub display: String,
    pub machine_identifier: Option<String>,
    pub mac_address: Option<String>,
    pub ip_address: Option<IpAddr>,
    #[serde(default)]
    pub shared_directories: Option<Vec<serde_json::Value>>,
    pub network_mode: Option<String>,
}

impl Inspection {
    pub fn config_hash(&self) -> Result<String, String> {
        if self
            .machine_identifier
            .as_ref()
            .is_none_or(String::is_empty)
            || self
                .shared_directories
                .as_ref()
                .is_some_and(|v| !v.is_empty())
            || self
                .network_mode
                .as_deref()
                .is_some_and(|mode| mode != "nat")
        {
            return Err("lume_vm_profile_unsupported".into());
        }
        Ok(lume::content_hash(
            serde_json::json!([
                self.cpu_count,
                self.memory_size,
                self.display,
                self.machine_identifier,
                self.mac_address
            ])
            .to_string()
            .as_bytes(),
        ))
    }
}

pub async fn inspect(
    binary: &Path,
    storage: &Path,
    name: &str,
    cancel: Arc<AtomicBool>,
) -> Result<Inspection, String> {
    let bytes = cli(
        binary,
        &[
            "get".into(),
            name.into(),
            "--format".into(),
            "json".into(),
            "--storage".into(),
            storage.to_string_lossy().into_owned(),
        ],
        Duration::from_secs(10),
        cancel,
    )
    .await?;
    let mut rows: Vec<Inspection> =
        serde_json::from_slice(&bytes).map_err(|_| "lume_inspect_schema")?;
    if rows.len() != 1 || rows[0].name != name {
        return Err("lume_inspect_identity".into());
    }
    Ok(rows.remove(0))
}

pub struct SshFiles {
    pub key: tempfile::NamedTempFile,
    pub known_hosts: tempfile::NamedTempFile,
}

/// Canonical OpenSSH Ed25519 public key, including its SSH wire lengths.
/// Hostnames/comments and alternative whitespace never change key identity.
pub fn canonical_host_key(value: &str) -> Result<String, String> {
    use base64::Engine;
    if value.len() > 256 {
        return Err("lume_host_key_format".into());
    }
    let parts: Vec<_> = value.split_whitespace().collect();
    if parts.len() != 2 || parts[0] != "ssh-ed25519" {
        return Err("lume_host_key_format".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(parts[1])
        .map_err(|_| "lume_host_key_format")?;
    if bytes.len() != 51
        || bytes[..4] != [0, 0, 0, 11]
        || &bytes[4..15] != b"ssh-ed25519"
        || bytes[15..19] != [0, 0, 0, 32]
    {
        return Err("lume_host_key_format".into());
    }
    Ok(format!(
        "ssh-ed25519 {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

impl SshFiles {
    pub fn new(private_key: &str, host_key: &str) -> Result<Self, String> {
        use std::io::Write;
        let mut key = tempfile::NamedTempFile::new().map_err(|_| "lume_ssh_keyfile")?;
        let mut known_hosts = tempfile::NamedTempFile::new().map_err(|_| "lume_ssh_known_hosts")?;
        key.write_all(private_key.as_bytes())
            .map_err(|_| "lume_ssh_keyfile")?;
        known_hosts
            .write_all(format!("cognia-lume {host_key}\n").as_bytes())
            .map_err(|_| "lume_ssh_known_hosts")?;
        Ok(Self { key, known_hosts })
    }
    pub fn command(
        &self,
        host: IpAddr,
        user: &str,
        remote: &'static str,
    ) -> Result<Command, String> {
        if user.is_empty()
            || !user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || user.starts_with('-')
        {
            return Err("lume_ssh_user".into());
        }
        let args = ssh_args(self.key.path(), self.known_hosts.path(), host, user, remote);
        Ok(command(Path::new("/usr/bin/ssh"), &args))
    }
}

fn ssh_args(
    key: &Path,
    known_hosts: &Path,
    host: IpAddr,
    user: &str,
    remote: &'static str,
) -> Vec<String> {
    vec![
        "-F".into(),
        "/dev/null".into(),
        "-T".into(),
        "-oBatchMode=yes".into(),
        "-oIdentitiesOnly=yes".into(),
        "-oStrictHostKeyChecking=yes".into(),
        "-oGlobalKnownHostsFile=/dev/null".into(),
        format!("-oUserKnownHostsFile={}", known_hosts.display()),
        "-oHostKeyAlias=cognia-lume".into(),
        "-oForwardAgent=no".into(),
        "-oForwardX11=no".into(),
        "-oClearAllForwardings=yes".into(),
        "-oPermitLocalCommand=no".into(),
        "-oProxyCommand=none".into(),
        "-oConnectTimeout=10".into(),
        "-oServerAliveInterval=5".into(),
        "-oServerAliveCountMax=2".into(),
        "-i".into(),
        key.to_string_lossy().into_owned(),
        "-l".into(),
        user.into(),
        host.to_string(),
        remote.into(),
    ]
}

pub struct HelperExecution {
    pub timeout: Duration,
    pub cancel: Arc<AtomicBool>,
    pub admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

pub async fn helper(
    files: &SshFiles,
    host: IpAddr,
    user: &str,
    request: &Envelope,
    payload: &[u8],
    execution: HelperExecution,
) -> Result<(Reply, Vec<u8>), String> {
    let mut input = Vec::new();
    lume::write_frame(&mut input, request, payload)?;
    let output = bounded_admitted(
        files.command(host, user, HELPER_COMMAND)?,
        input,
        execution.timeout,
        execution.cancel,
        execution.admission,
    )
    .await?;
    decode_reply(request, &output)
}

pub(super) fn decode_reply(request: &Envelope, output: &[u8]) -> Result<(Reply, Vec<u8>), String> {
    let mut cursor = std::io::Cursor::new(output);
    let reply: Reply = lume::read_header(&mut cursor)?;
    if reply.version != lume::VERSION || reply.operation_id != request.operation_id {
        return Err("lume_helper_protocol".into());
    }
    let payload = lume::read_payload(&mut cursor, reply.payload_len)?;
    if cursor.position() != cursor.get_ref().len() as u64 {
        return Err("lume_helper_trailing_data".into());
    }
    if let Some(code) = reply.error_code.as_ref() {
        return Err(
            if code.len() <= 80 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                format!("lume_guest_{code}")
            } else {
                "lume_guest_error".into()
            },
        );
    }
    Ok((reply, payload))
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 80
        || name.starts_with('-')
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("lume_vm_name".into());
    }
    Ok(())
}

pub fn binary_hash(path: &Path) -> Result<String, String> {
    use std::io::Read;
    if !path.is_absolute() || !path.is_file() {
        return Err("lume_binary_path".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "lume_binary_read")?;
    if file.metadata().map_err(|_| "lume_binary_read")?.len() > 256 * 1024 * 1024 {
        return Err("lume_binary_limit".into());
    }
    let mut bytes = Vec::new();
    file.take(256 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "lume_binary_read")?;
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("lume_binary_limit".into());
    }
    Ok(lume::content_hash(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_uses_fixed_remote_command_and_disables_ambient_configuration() {
        let args = ssh_args(
            Path::new("/owned/key"),
            Path::new("/owned/known"),
            "192.168.64.2".parse().unwrap(),
            "lume",
            HELPER_COMMAND,
        );
        assert_eq!(args.last().unwrap(), HELPER_COMMAND);
        for required in [
            "/dev/null",
            "-T",
            "-oStrictHostKeyChecking=yes",
            "-oIdentitiesOnly=yes",
            "-oForwardAgent=no",
            "-oClearAllForwardings=yes",
        ] {
            assert!(args.iter().any(|a| a == required));
        }
        for invalid in ["--help", "../vm", "a b", "a;touch x"] {
            assert!(validate_name(invalid).is_err());
        }
    }
    #[tokio::test]
    async fn cancellation_and_output_limits_do_not_return_success() {
        let cancel = Arc::new(AtomicBool::new(true));
        assert!(bounded(
            command(Path::new("/bin/sleep"), &["10".into()]),
            vec![],
            Duration::from_secs(2),
            cancel
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn pre_cancelled_process_is_refused_before_spawn() {
        let result = bounded(
            command(Path::new("/missing/pre-cancelled-lume"), &[]),
            vec![],
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(true)),
        )
        .await;
        assert_eq!(result.unwrap_err(), "lume_process_cancelled");
    }
    #[test]
    fn host_keys_require_a_complete_ed25519_wire_encoding() {
        for key in [
            "ssh-ed25519 YQ==",
            "ssh-ed25519 not-base64",
            "ssh-rsa YQ==",
            "ssh-ed25519 YQ== extra",
        ] {
            assert_eq!(canonical_host_key(key).unwrap_err(), "lume_host_key_format");
        }
    }
}
