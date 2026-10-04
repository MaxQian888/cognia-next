//! Durable desktop terminal-host process boundary.
//!
//! The desktop host authenticates an owner-only local socket/named-pipe peer
//! with a bootstrap secret held in the OS credential store. Renderer code can
//! only reach this boundary through native Tauri commands and never receives
//! the secret.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use std::time::{Duration, Instant};

use crate::host::{ClientIdentity, TerminalHost, TerminalHostConfig};
use crate::host_wire::serve_host_stream;
use crate::session::{PathInjection, SessionOrigin, SpawnRequest};
use base64::Engine;
use cognia_secrets::keychain_access::{
    read_password_without_prompt, write_password_without_prompt,
};
use ed25519_dalek::{Signer, SigningKey};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const KEYRING_SERVICE: &str = "com.cognia.terminal-host";
const KEYRING_ACCOUNT: &str = "desktop-bootstrap";
const SIGNING_KEY_ACCOUNT: &str = "descriptor-signing-key";
const AUTH_MAX_BYTES: usize = 256;
const SETTINGS_FILE: &str = "settings.json";

struct RemoteAccessCache {
    checked_at: Option<Instant>,
    enabled: bool,
}

static REMOTE_ACCESS_CACHE: Lazy<tokio::sync::Mutex<RemoteAccessCache>> = Lazy::new(|| {
    tokio::sync::Mutex::new(RemoteAccessCache {
        checked_at: None,
        enabled: false,
    })
});
static REMOTE_ACCESS_CACHE_DIRTY: AtomicBool = AtomicBool::new(true);
static BOOTSTRAP_SECRET: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostSettings {
    pub allow_remote_access: bool,
    pub start_at_login: bool,
    pub diagnostics: bool,
    pub max_sessions: usize,
    pub max_remote_sessions_per_device: usize,
    pub replay_bytes_per_session: usize,
    pub total_replay_bytes: usize,
}

impl Default for TerminalHostSettings {
    fn default() -> Self {
        let config = TerminalHostConfig::default();
        Self {
            allow_remote_access: false,
            start_at_login: false,
            diagnostics: false,
            max_sessions: config.max_sessions,
            max_remote_sessions_per_device: config.max_remote_sessions_per_device,
            replay_bytes_per_session: config.replay_bytes_per_session,
            total_replay_bytes: config.total_replay_bytes,
        }
    }
}

impl TerminalHostSettings {
    pub fn host_config(&self) -> Result<TerminalHostConfig, String> {
        let config = TerminalHostConfig {
            max_sessions: self.max_sessions,
            max_remote_sessions_per_device: self.max_remote_sessions_per_device,
            replay_bytes_per_session: self.replay_bytes_per_session,
            total_replay_bytes: self.total_replay_bytes,
            controller_grace_ms: 10_000,
        };
        config.validate().map_err(|error| error.to_string())?;
        Ok(config)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostDescriptor {
    pub host_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signaling_room_id: Option<String>,
    pub signing_public_key: String,
    pub credential_key_id: String,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedTerminalHostDescriptor<'a> {
    host_id: &'a str,
    issued_at: i64,
    expires_at: i64,
    lan_url: &'a Option<String>,
    signaling_room_id: &'a Option<String>,
    signing_public_key: &'a str,
    credential_key_id: &'a str,
}

pub trait TerminalHostIo: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> TerminalHostIo for T {}
pub type BoxedTerminalHostIo = Pin<Box<dyn TerminalHostIo + Send>>;

pub fn default_terminal_host_endpoint() -> String {
    #[cfg(unix)]
    {
        let base = dirs::runtime_dir()
            .or_else(dirs::data_local_dir)
            .unwrap_or_else(std::env::temp_dir);
        base.join("cognia")
            .join("terminal-host.sock")
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(windows)]
    {
        let domain = std::env::var("USERDOMAIN").unwrap_or_default();
        let user = std::env::var("USERNAME").unwrap_or_default();
        let digest = Sha256::digest(format!("{domain}\\{user}").as_bytes());
        let scope = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!(r"\\.\pipe\cognia-terminal-host-{scope}")
    }
}

pub fn terminal_host_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("cognia")
        .join("terminal-host")
}

const HOST_LOG_FILE: &str = "terminal-host.log";
/// Past this size the log is rotated to `terminal-host.log.1` (replacing the
/// previous one) when the next host is spawned.
const HOST_LOG_ROTATE_BYTES: u64 = 1024 * 1024;

/// Where a spawned host's stderr goes: its `log` output, panics, and the
/// reason it exited. Owner-only, inside the host data directory.
pub fn terminal_host_log_path() -> PathBuf {
    terminal_host_data_dir().join(HOST_LOG_FILE)
}

/// Open the host log for a host about to be spawned, appending.
///
/// Bounded per spawn rather than continuously: a log past
/// [`HOST_LOG_ROTATE_BYTES`] is moved aside first, so at most two files exist
/// and each holds what one or more hosts wrote after their spawn found it
/// small. A host that is already running keeps writing to its own descriptor,
/// so rotating under it loses nothing.
pub fn open_terminal_host_log() -> Result<(std::fs::File, PathBuf), String> {
    open_terminal_host_log_in(&terminal_host_data_dir())
}

fn open_terminal_host_log_in(dir: &Path) -> Result<(std::fs::File, PathBuf), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("terminal host data directory failed: {error}"))?;
    set_owner_only_dir(dir)?;
    let path = dir.join(HOST_LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > HOST_LOG_ROTATE_BYTES) {
        std::fs::rename(&path, dir.join(format!("{HOST_LOG_FILE}.1")))
            .map_err(|error| format!("terminal host log rotation failed: {error}"))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("terminal host log open failed: {error}"))?;
    // `mode` applies only on create; tighten a file left by an older build.
    set_owner_only_file(&path)?;
    Ok((file, path))
}

pub fn load_terminal_host_settings() -> Result<TerminalHostSettings, String> {
    let path = terminal_host_data_dir().join(SETTINGS_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let settings: TerminalHostSettings = serde_json::from_str(&raw)
                .map_err(|error| format!("terminal host settings are invalid: {error}"))?;
            settings.host_config()?;
            Ok(settings)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(TerminalHostSettings::default())
        }
        Err(error) => Err(format!("terminal host settings read failed: {error}")),
    }
}

pub fn save_terminal_host_settings(settings: &TerminalHostSettings) -> Result<(), String> {
    settings.host_config()?;
    let data_dir = terminal_host_data_dir();
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("terminal host data directory failed: {error}"))?;
    let path = data_dir.join(SETTINGS_FILE);
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("terminal host settings serialization failed: {error}"))?;
    std::fs::write(&path, bytes)
        .map_err(|error| format!("terminal host settings write failed: {error}"))?;
    set_owner_only_file(&path)?;
    REMOTE_ACCESS_CACHE_DIRTY.store(true, Ordering::Release);
    Ok(())
}

pub async fn terminal_remote_access_enabled() -> bool {
    let mut cache = REMOTE_ACCESS_CACHE.lock().await;
    let stale = REMOTE_ACCESS_CACHE_DIRTY.swap(false, Ordering::AcqRel)
        || cache
            .checked_at
            .is_none_or(|checked_at| checked_at.elapsed() >= Duration::from_secs(1));
    if stale {
        cache.enabled = tokio::task::spawn_blocking(|| {
            load_terminal_host_settings().is_ok_and(|settings| settings.allow_remote_access)
        })
        .await
        .unwrap_or(false);
        cache.checked_at = Some(Instant::now());
    }
    cache.enabled
}

fn default_terminal_profile() -> SpawnRequest {
    SpawnRequest {
        shell: crate::headless::default_headless_shell(),
        args: Vec::new(),
        cwd: None,
        env: HashMap::new(),
        rows: 24,
        cols: 80,
        project_id: None,
        extension_id: None,
        enable_shell_integration: true,
        force_utf8: true,
        origin: SessionOrigin::Remote,
        skip_user_profile: false,
        sandboxed: false,
        sandbox_network: None,
    }
}

fn install_default_terminal_profile(host: &TerminalHost) -> Result<(), String> {
    let client = host
        .connect(ClientIdentity::local("terminal-host-bootstrap"))
        .map_err(|error| error.to_string())?;
    host.sync_profile(
        &client.connection_id,
        "default".into(),
        default_terminal_profile(),
    )
    .map_err(|error| error.to_string())
}

pub fn set_terminal_host_login_service(
    enabled: bool,
    binary: &Path,
    endpoint: &str,
) -> Result<(), String> {
    if !binary.is_file() {
        return Err("terminal host binary is not available".into());
    }
    set_platform_login_service(enabled, binary, endpoint)
}

#[cfg(target_os = "macos")]
fn set_platform_login_service(enabled: bool, binary: &Path, endpoint: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    let directory = home.join("Library").join("LaunchAgents");
    let path = directory.join("com.cognia.terminal-host.plist");
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let service = format!("{domain}/com.cognia.terminal-host");
    let _ = Command::new("launchctl")
        .args(["bootout", &service])
        .status();
    if !enabled {
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|error| format!("terminal LaunchAgent removal failed: {error}"))?;
        }
        return Ok(());
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("terminal LaunchAgent directory failed: {error}"))?;
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.cognia.terminal-host</string><key>ProgramArguments</key><array><string>{}</string><string>desktop-host</string><string>--endpoint</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n",
        xml_escape(&binary.to_string_lossy()),
        xml_escape(endpoint),
    );
    std::fs::write(&path, plist)
        .map_err(|error| format!("terminal LaunchAgent write failed: {error}"))?;
    set_owner_only_file(&path)?;
    let status = Command::new("launchctl")
        .args(["bootstrap", &domain])
        .arg(&path)
        .status()
        .map_err(|error| format!("terminal LaunchAgent bootstrap failed: {error}"))?;
    if !status.success() {
        return Err(format!(
            "terminal LaunchAgent bootstrap exited with {status}"
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_platform_login_service(enabled: bool, binary: &Path, endpoint: &str) -> Result<(), String> {
    let config = dirs::config_dir().ok_or_else(|| "config directory is unavailable".to_string())?;
    let unit_dir = config.join("systemd").join("user");
    let unit = unit_dir.join("cognia-terminal-host.service");
    let autostart_dir = config.join("autostart");
    let desktop = autostart_dir.join("cognia-terminal-host.desktop");
    if !enabled {
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", "cognia-terminal-host.service"])
            .status();
        for path in [&unit, &desktop] {
            if path.exists() {
                std::fs::remove_file(path)
                    .map_err(|error| format!("terminal login service removal failed: {error}"))?;
            }
        }
        return Ok(());
    }
    std::fs::create_dir_all(&unit_dir)
        .map_err(|error| format!("terminal systemd user directory failed: {error}"))?;
    let exec = format!(
        "{} desktop-host --endpoint {}",
        quote_service_arg(&binary.to_string_lossy()),
        quote_service_arg(endpoint)
    );
    let unit_body = format!(
        "[Unit]\nDescription=Cognia durable terminal host\n\n[Service]\nType=simple\nExecStart={exec}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n"
    );
    std::fs::write(&unit, unit_body)
        .map_err(|error| format!("terminal systemd user unit write failed: {error}"))?;
    set_owner_only_file(&unit)?;
    let systemd_ok = Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .status()
        .is_ok_and(|status| status.success())
        && Command::new("systemctl")
            .args(["--user", "enable", "--now", "cognia-terminal-host.service"])
            .status()
            .is_ok_and(|status| status.success());
    if systemd_ok {
        if desktop.exists() {
            let _ = std::fs::remove_file(desktop);
        }
        return Ok(());
    }
    std::fs::create_dir_all(&autostart_dir)
        .map_err(|error| format!("terminal XDG autostart directory failed: {error}"))?;
    let desktop_body = format!(
        "[Desktop Entry]\nType=Application\nName=Cognia Terminal Host\nExec={exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    );
    std::fs::write(&desktop, desktop_body)
        .map_err(|error| format!("terminal XDG autostart write failed: {error}"))?;
    set_owner_only_file(&desktop)
}

#[cfg(windows)]
fn set_platform_login_service(enabled: bool, binary: &Path, endpoint: &str) -> Result<(), String> {
    const TASK_NAME: &str = "Cognia Terminal Host";
    if !enabled {
        let status = Command::new("schtasks.exe")
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .status();
        return match status {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Ok(()),
            Err(error) => Err(format!("terminal login task removal failed: {error}")),
        };
    }
    let command = format!(
        "{} desktop-host --endpoint {}",
        quote_service_arg(&binary.to_string_lossy()),
        quote_service_arg(endpoint)
    );
    let status = Command::new("schtasks.exe")
        .args(["/Create", "/SC", "ONLOGON", "/TN", TASK_NAME, "/TR"])
        .arg(command)
        .args(["/F", "/RL", "LIMITED"])
        .status()
        .map_err(|error| format!("terminal login task creation failed: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("terminal login task creation exited with {status}"))
    }
}

#[cfg(any(target_os = "linux", windows, test))]
fn quote_service_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// Keep these credentials in the OS store shared with the separately launched
// terminal daemon. Cognia's process-local encrypted-store cache is not a
// cross-process authority. Background reconnects must never display OS dialogs.
fn load_or_create_credential(account: &str) -> Result<String, String> {
    load_or_create_credential_with(
        account,
        || read_password_without_prompt(KEYRING_SERVICE, account),
        |secret| write_password_without_prompt(KEYRING_SERVICE, account, secret),
    )
}

/// What to do when the OS credential store refuses a no-prompt access.
///
/// The background paths never show a dialog, so a refusal is silent; without
/// this the only trace is the store's own error text, which on macOS reads like
/// a wrong password.
#[cfg(target_os = "macos")]
const CREDENTIAL_ACCESS_HINT: &str = "the login Keychain refused access without a prompt; this \
     usually means the item was created by a different build of cognia-server (a rebuilt or \
     re-signed binary has a new code identity). Allow this binary on the item in Keychain \
     Access, or delete the item and restart the terminal host so it is recreated";
#[cfg(target_os = "linux")]
const CREDENTIAL_ACCESS_HINT: &str = "the Secret Service refused access; check that a keyring \
     daemon (gnome-keyring, KWallet) is running and its login collection is unlocked";
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const CREDENTIAL_ACCESS_HINT: &str = "the OS credential store refused access; check the \
     Credential Manager entry for this item";

/// Names the store item and says what to do about it. Never includes the
/// secret: neither argument carries it.
fn credential_failure(operation: &str, account: &str, error: &keyring::Error) -> String {
    format!(
        "terminal credential {operation} failed for {KEYRING_SERVICE} (account {account}): \
         {error}. Hint: {CREDENTIAL_ACCESS_HINT}"
    )
}

fn load_or_create_credential_with(
    account: &str,
    read: impl FnOnce() -> keyring::Result<String>,
    write: impl FnOnce(&str) -> keyring::Result<()>,
) -> Result<String, String> {
    match read() {
        Ok(secret) => Ok(secret),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::fill(&mut bytes);
            let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
            write(&secret).map_err(|error| credential_failure("write", account, &error))?;
            Ok(secret)
        }
        Err(error) => Err(credential_failure("read", account, &error)),
    }
}

fn load_or_create_bootstrap_secret() -> Result<String, String> {
    let secret = load_or_create_credential(KEYRING_ACCOUNT)?;
    if !valid_bootstrap_secret(&secret) {
        return Err("terminal host bootstrap secret is invalid".into());
    }
    Ok(secret)
}

fn bootstrap_secret() -> Result<String, String> {
    if let Some(secret) = BOOTSTRAP_SECRET.get() {
        return Ok(secret.clone());
    }
    let secret = load_or_create_bootstrap_secret()?;
    let _ = BOOTSTRAP_SECRET.set(secret.clone());
    Ok(secret)
}

fn descriptor_signing_key() -> Result<SigningKey, String> {
    decode_signing_key(&load_or_create_credential(SIGNING_KEY_ACCOUNT)?)
}

fn decode_signing_key(encoded: &str) -> Result<SigningKey, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| format!("terminal descriptor signing key is invalid: {error}"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "terminal descriptor signing key must be 32 bytes".to_string())?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn terminal_credential_key_id(device_id: &str, device_public_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"cognia-terminal-credential\0");
    digest.update((device_id.len() as u64).to_be_bytes());
    digest.update(device_id.as_bytes());
    digest.update((device_public_key.len() as u64).to_be_bytes());
    digest.update(device_public_key.as_bytes());
    hex::encode(digest.finalize())
}

pub fn provision_terminal_host_descriptor(
    device_id: &str,
    device_public_key: &str,
    lan_url: Option<String>,
    signaling_room_id: Option<String>,
) -> Result<TerminalHostDescriptor, String> {
    if device_id.trim().is_empty() || device_public_key.trim().is_empty() {
        return Err("device identity and public key are required".into());
    }
    let data_dir = terminal_host_data_dir();
    let host_id = load_or_create_host_id(&data_dir)?;
    let signing_key = descriptor_signing_key()?;
    let signing_public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(signing_key.verifying_key().as_bytes());
    let credential_key_id = terminal_credential_key_id(device_id, device_public_key);
    let issued_at = chrono::Utc::now().timestamp_millis();
    let expires_at = issued_at.saturating_add(30 * 24 * 60 * 60 * 1_000);
    let unsigned = UnsignedTerminalHostDescriptor {
        host_id: &host_id,
        issued_at,
        expires_at,
        lan_url: &lan_url,
        signaling_room_id: &signaling_room_id,
        signing_public_key: &signing_public_key,
        credential_key_id: &credential_key_id,
    };
    let payload = serde_json::to_vec(&unsigned)
        .map_err(|error| format!("terminal descriptor serialization failed: {error}"))?;
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(signing_key.sign(&payload).to_bytes());
    Ok(TerminalHostDescriptor {
        host_id,
        issued_at,
        expires_at,
        lan_url,
        signaling_room_id,
        signing_public_key,
        credential_key_id,
        signature,
    })
}

fn valid_bootstrap_secret(secret: &str) -> bool {
    (32..=AUTH_MAX_BYTES).contains(&secret.len())
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The client half of the handshake: secret, then identity, each behind a
/// big-endian `u16` length. Built before any socket is opened, so an identity
/// the host would refuse is reported locally.
fn client_auth_payload(secret: &str, identity: &ClientIdentity) -> Result<Vec<u8>, String> {
    let identity = serde_json::to_vec(&SerializableClientIdentity::from(identity))
        .map_err(|error| format!("terminal host identity serialization failed: {error}"))?;
    if identity.len() > AUTH_MAX_BYTES {
        return Err("terminal host client identity is too large".into());
    }
    if !valid_bootstrap_secret(secret) {
        return Err("terminal host bootstrap secret is invalid".into());
    }
    let mut payload = Vec::with_capacity(4 + secret.len() + identity.len());
    payload.extend_from_slice(&(secret.len() as u16).to_be_bytes());
    payload.extend_from_slice(secret.as_bytes());
    payload.extend_from_slice(&(identity.len() as u16).to_be_bytes());
    payload.extend_from_slice(&identity);
    Ok(payload)
}

async fn write_client_auth<S: AsyncWrite + Unpin>(
    stream: &mut S,
    payload: &[u8],
) -> Result<(), String> {
    stream
        .write_all(payload)
        .await
        .map_err(|error| format!("terminal host auth write failed: {error}"))?;
    stream
        .flush()
        .await
        .map_err(|error| format!("terminal host auth flush failed: {error}"))
}

async fn authenticate_server<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<ClientIdentity, String> {
    let length = stream
        .read_u16()
        .await
        .map_err(|error| format!("terminal host auth length read failed: {error}"))?
        as usize;
    if !(32..=AUTH_MAX_BYTES).contains(&length) {
        return Err("terminal host authentication payload has an invalid length".into());
    }
    let mut supplied = vec![0; length];
    stream
        .read_exact(&mut supplied)
        .await
        .map_err(|error| format!("terminal host auth read failed: {error}"))?;
    let expected = tokio::task::spawn_blocking(bootstrap_secret)
        .await
        .map_err(|error| format!("terminal host auth task failed: {error}"))??;
    if !constant_time_eq(&supplied, expected.as_bytes()) {
        return Err("terminal host authentication failed".into());
    }
    let identity_length = stream
        .read_u16()
        .await
        .map_err(|error| format!("terminal host identity length read failed: {error}"))?
        as usize;
    if identity_length == 0 || identity_length > AUTH_MAX_BYTES {
        return Err("terminal host client identity has an invalid length".into());
    }
    let mut identity = vec![0; identity_length];
    stream
        .read_exact(&mut identity)
        .await
        .map_err(|error| format!("terminal host identity read failed: {error}"))?;
    let identity: SerializableClientIdentity = serde_json::from_slice(&identity)
        .map_err(|error| format!("terminal host client identity is invalid: {error}"))?;
    identity.try_into()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializableClientIdentity {
    client_id: String,
    device_id: Option<String>,
    local: bool,
    allow_remote_terminal: bool,
}

impl From<&ClientIdentity> for SerializableClientIdentity {
    fn from(value: &ClientIdentity) -> Self {
        Self {
            client_id: value.client_id.clone(),
            device_id: value.device_id.clone(),
            local: value.local,
            allow_remote_terminal: value.allow_remote_terminal,
        }
    }
}

impl TryFrom<SerializableClientIdentity> for ClientIdentity {
    type Error = String;

    fn try_from(value: SerializableClientIdentity) -> Result<Self, Self::Error> {
        if value.client_id.trim().is_empty() || value.client_id.len() > 128 {
            return Err("terminal host client id is invalid".into());
        }
        if value.local {
            if value.device_id.is_some() {
                return Err("local terminal clients cannot carry a device id".into());
            }
            return Ok(ClientIdentity::local(value.client_id));
        }
        let device_id = value
            .device_id
            .filter(|value| !value.trim().is_empty() && value.len() <= 128)
            .ok_or_else(|| "remote terminal clients require a device id".to_string())?;
        Ok(ClientIdentity::remote(
            value.client_id,
            device_id,
            value.allow_remote_terminal,
        ))
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (&left, &right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn load_or_create_host_id(data_dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("terminal host data directory failed: {error}"))?;
    let path = data_dir.join("host-id");
    if let Ok(value) = std::fs::read_to_string(&path) {
        let value = value.trim();
        if uuid::Uuid::parse_str(value).is_ok() {
            return Ok(value.to_string());
        }
    }
    let value = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, value.as_bytes())
        .map_err(|error| format!("terminal host identity write failed: {error}"))?;
    set_owner_only_file(&path)?;
    Ok(value)
}

fn terminal_script_dir() -> PathBuf {
    if let Ok(path) = std::env::var("COGNIA_TERMINAL_RESOURCES") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return path;
        }
    }
    // Dev fallback — the scripts live under src-tauri/resources/terminal/;
    // CARGO_MANIFEST_DIR is crates/cognia-terminal, two hops below the
    // workspace root (ADR-0067 extraction). Pointing at the crate-local
    // `resources/terminal` (which does not exist) would silently strip shell
    // integration instead of failing, so mirror `commands::resolve_script_dir`.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let development = manifest
        .ancestors()
        .nth(2)
        .map(|root| root.join("src-tauri"))
        .unwrap_or(manifest)
        .join("resources")
        .join("terminal");
    if development.is_dir() {
        return development;
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|parent| parent.join("resources").join("terminal"))
        })
        .unwrap_or(development)
}

/// The dedicated TOFU store for SSH server keys.
///
/// Defined once so the host process that writes it and the app process that
/// lets the user forget an entry can never disagree about which file is
/// authoritative.
pub fn ssh_known_hosts_path() -> PathBuf {
    terminal_host_data_dir().join("ssh").join("known_hosts")
}

pub async fn run_terminal_host(endpoint: String) -> Result<(), String> {
    let (host, script_dir, known_hosts_path, diagnostics) = tokio::task::spawn_blocking(|| {
        let data_dir = terminal_host_data_dir();
        let known_hosts_path = ssh_known_hosts_path();
        if let Some(parent) = known_hosts_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("terminal host SSH directory failed: {error}"))?;
            set_owner_only_dir(parent)?;
        }
        let host_id = load_or_create_host_id(&data_dir)?;
        let settings = load_terminal_host_settings()?;
        let diagnostics = settings.diagnostics;
        let config = settings.host_config()?;
        let host =
            TerminalHost::with_path_injection(host_id, config, host_baseline_path_injection())
                .map_err(|error| error.to_string())?;
        install_default_terminal_profile(&host)?;
        Ok::<_, String>((host, terminal_script_dir(), known_hosts_path, diagnostics))
    })
    .await
    .map_err(|error| format!("terminal host initialization task failed: {error}"))??;
    let maintenance_host = host.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let now = Instant::now();
            maintenance_host.reap_controller_leases(now);
            // Backstop for a client that paused output and then stopped running
            // (backgrounded phone, hung JS main thread) — without this its PTY
            // would stay parked forever.
            maintenance_host.reap_flow_pauses(now);
            // Idle file-transfer connections, which no longer time themselves
            // out now that the SSH link heartbeats (see `reap_idle_sftp`).
            maintenance_host.reap_idle_sftp();
        }
    });
    if diagnostics {
        log::info!("terminal host diagnostics enabled for endpoint {endpoint}");
    }
    run_platform_listener(endpoint, host, script_dir, known_hosts_path, diagnostics).await
}

/// PATH the host weaves into shells it spawns before any desktop client has
/// said hello — a start-at-login host serving a paired phone, for instance.
///
/// Deliberately narrower than the app's `build_cli_path_injection`: the
/// app-managed CLI registry is an in-process static the host cannot read, so it
/// covers only what the host can see for itself. A desktop client replaces this
/// wholesale on connect via the hello frame's `pathInjection`.
fn host_baseline_path_injection() -> PathInjection {
    let mut prepend = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("cli")))
        .filter(|dir| dir.is_dir())
    {
        prepend.push(dir);
    }
    let append = dirs::home_dir()
        .map(|home| vec![home.join(".cargo").join("bin")])
        .unwrap_or_default();
    PathInjection { prepend, append }
}

#[cfg(unix)]
async fn run_platform_listener(
    endpoint: String,
    host: TerminalHost,
    script_dir: PathBuf,
    known_hosts_path: PathBuf,
    diagnostics: bool,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let socket_path = PathBuf::from(&endpoint);
    let parent = socket_path
        .parent()
        .ok_or_else(|| "terminal host socket must have a parent directory".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("terminal host socket directory failed: {error}"))?;
    tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
        .await
        .map_err(|error| format!("terminal host socket directory permissions failed: {error}"))?;
    if socket_path.exists() {
        match tokio::net::UnixStream::connect(&socket_path).await {
            Ok(_) => return Err("terminal host is already running".into()),
            Err(_) => tokio::fs::remove_file(&socket_path)
                .await
                .map_err(|error| format!("stale terminal host socket removal failed: {error}"))?,
        }
    }
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("terminal host socket bind failed: {error}"))?;
    tokio::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|error| format!("terminal host socket permissions failed: {error}"))?;

    accept_unix_connections(listener, verify_unix_peer, move |stream| {
        tokio::spawn(serve_connection(
            stream,
            host.clone(),
            script_dir.clone(),
            known_hosts_path.clone(),
            diagnostics,
        ));
    })
    .await
}

/// Authenticate one accepted connection and serve it until it closes.
///
/// Runs on its own task: whatever goes wrong here ends this connection, never
/// the listener.
async fn serve_connection<S>(
    mut stream: S,
    host: TerminalHost,
    script_dir: PathBuf,
    known_hosts_path: PathBuf,
    diagnostics: bool,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let identity = match authenticate_server(&mut stream).await {
        Ok(identity) => identity,
        Err(error) => {
            log::warn!("terminal host client authentication rejected: {error}");
            return;
        }
    };
    if diagnostics {
        log::info!("terminal host authenticated client {}", identity.client_id);
    }
    if let Err(error) =
        serve_host_stream(stream, host, identity, script_dir, known_hosts_path).await
    {
        log::warn!("terminal host connection closed: {error}");
    }
}

/// What the accept loop does after a failed accept.
///
/// Only the Unix listener classifies OS errors; the named-pipe listener uses
/// `Unknown` for instance-creation failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(unix), allow(dead_code))]
enum AcceptFailure {
    /// One pending connection went bad (aborted by its client, interrupted
    /// call). The next accept is unaffected, so retry at once.
    Connection,
    /// The process or system is out of descriptors or memory. Usually this
    /// host's own sessions, so it clears as they close; back off rather than
    /// spin, and never exit over it: exiting would take every live PTY with it.
    Resources,
    /// Not a known class. Backed off like `Resources`, but only
    /// [`MAX_UNKNOWN_ACCEPT_FAILURES`] times in a row before the listener gives
    /// up, so a broken listener ends the process (and the next client starts a
    /// fresh host) instead of holding the endpoint while answering no one.
    Unknown,
    /// The listening descriptor itself is unusable. No retry can fix it.
    Listener,
}

const ACCEPT_BACKOFF_START: Duration = Duration::from_millis(50);
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(1);
const MAX_UNKNOWN_ACCEPT_FAILURES: u32 = 64;

/// Exponential pause between failed accepts, reset by the next good one.
#[derive(Debug, Default)]
struct AcceptBackoff {
    consecutive: u32,
    unknown: u32,
}

impl AcceptBackoff {
    fn succeeded(&mut self) {
        self.consecutive = 0;
        self.unknown = 0;
    }

    /// The pause before the next accept, or `None` when the listener should
    /// give up.
    fn failed(&mut self, failure: AcceptFailure) -> Option<Duration> {
        match failure {
            AcceptFailure::Connection => return Some(Duration::ZERO),
            AcceptFailure::Listener => return None,
            AcceptFailure::Unknown => {
                self.unknown += 1;
                if self.unknown > MAX_UNKNOWN_ACCEPT_FAILURES {
                    return None;
                }
            }
            AcceptFailure::Resources => {}
        }
        let delay = ACCEPT_BACKOFF_START
            .saturating_mul(1 << self.consecutive.min(5))
            .min(ACCEPT_BACKOFF_MAX);
        self.consecutive = self.consecutive.saturating_add(1);
        Some(delay)
    }
}

#[cfg(unix)]
fn classify_accept_error(error: &std::io::Error) -> AcceptFailure {
    match error.raw_os_error() {
        Some(libc::EMFILE | libc::ENFILE | libc::ENOBUFS | libc::ENOMEM) => {
            AcceptFailure::Resources
        }
        Some(libc::EBADF | libc::EINVAL | libc::ENOTSOCK | libc::EOPNOTSUPP | libc::EFAULT) => {
            AcceptFailure::Listener
        }
        Some(libc::ECONNABORTED | libc::EINTR | libc::EAGAIN | libc::EPROTO | libc::EPERM) => {
            AcceptFailure::Connection
        }
        _ => match error.kind() {
            std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::WouldBlock => AcceptFailure::Connection,
            _ => AcceptFailure::Unknown,
        },
    }
}

/// Accept connections until the listener itself fails.
///
/// A connection that fails `check_peer` is logged and dropped; it does not
/// end the loop. That covers a client that hung up before its credentials
/// could be read (`ENOTCONN` from `peer_cred`) and a process of another OS user
/// reaching the socket, which must not be able to stop this user's host.
#[cfg(unix)]
async fn accept_unix_connections<C, H>(
    listener: tokio::net::UnixListener,
    check_peer: C,
    mut handle: H,
) -> Result<(), String>
where
    C: Fn(&tokio::net::UnixStream) -> Result<(), String>,
    H: FnMut(tokio::net::UnixStream),
{
    let mut backoff = AcceptBackoff::default();
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                backoff.succeeded();
                match check_peer(&stream) {
                    Ok(()) => handle(stream),
                    Err(error) => log::warn!("terminal host dropped a connection: {error}"),
                }
            }
            Err(error) => {
                let failure = classify_accept_error(&error);
                let Some(delay) = backoff.failed(failure) else {
                    return Err(format!("terminal host socket accept failed: {error}"));
                };
                log::warn!(
                    "terminal host socket accept failed ({failure:?}), retrying in {}ms: {error}",
                    delay.as_millis()
                );
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
}

#[cfg(unix)]
fn verify_unix_peer(stream: &tokio::net::UnixStream) -> Result<(), String> {
    let credential = stream
        .peer_cred()
        .map_err(|error| format!("terminal host peer credential failed: {error}"))?;
    let current_uid = unsafe { libc::geteuid() };
    if credential.uid() != current_uid {
        return Err("terminal host rejected a peer owned by another OS user".into());
    }
    Ok(())
}

#[cfg(windows)]
async fn run_platform_listener(
    endpoint: String,
    host: TerminalHost,
    script_dir: PathBuf,
    known_hosts_path: PathBuf,
    diagnostics: bool,
) -> Result<(), String> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // The first instance claims the name; failing that means another host owns
    // it, so it stays fatal.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&endpoint)
        .map_err(|error| format!("terminal host named pipe create failed: {error}"))?;
    let mut backoff = AcceptBackoff::default();
    loop {
        // A client that connects and hangs up before this resolves
        // (`ERROR_NO_DATA`) fails only its own instance.
        let connected = server.connect().await;
        // Have the next instance listening before letting go of this one, as
        // tokio's named-pipe docs prescribe: while no instance exists a client
        // sees the name as missing and starts a second host, which could then
        // claim it.
        let next = loop {
            match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&endpoint)
            {
                Ok(next) => {
                    backoff.succeeded();
                    break next;
                }
                Err(error) => {
                    let Some(delay) = backoff.failed(AcceptFailure::Unknown) else {
                        return Err(format!("terminal host named pipe create failed: {error}"));
                    };
                    log::warn!(
                        "terminal host named pipe create failed, retrying in {}ms: {error}",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        };
        let current = std::mem::replace(&mut server, next);
        match connected {
            Ok(()) => {
                tokio::spawn(serve_connection(
                    current,
                    host.clone(),
                    script_dir.clone(),
                    known_hosts_path.clone(),
                    diagnostics,
                ));
            }
            Err(error) => log::warn!("terminal host dropped a named pipe connection: {error}"),
        }
    }
}

/// Why a connection to the terminal host could not be opened.
///
/// The distinction is what a caller may do about it: only
/// [`Unreachable`](Self::Unreachable) is fixed by starting a host. The other two
/// come back unchanged however many hosts are spawned, so retrying them only
/// replaces the real reason with a later, vaguer one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalHostConnectError {
    /// Nothing is listening: the socket (or pipe) is missing or refuses
    /// connections, which is what a host that is not running looks like.
    Unreachable(String),
    /// This process cannot read (or create) the bootstrap secret from the OS
    /// credential store. Checked before the socket is opened.
    CredentialUnavailable(String),
    /// Something answered but the connection still failed: a socket this user
    /// may not open, an identity the handshake cannot carry, or a host that
    /// hung up mid-handshake.
    Failed(String),
}

impl TerminalHostConnectError {
    pub fn message(&self) -> &str {
        match self {
            Self::Unreachable(message)
            | Self::CredentialUnavailable(message)
            | Self::Failed(message) => message,
        }
    }

    /// Whether starting a host could make the next attempt succeed.
    pub fn host_start_may_help(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }

    /// How much an error says about the actual problem, for picking which one
    /// to report after several attempts: a refused credential beats a host
    /// that hung up, which beats "nothing is listening".
    pub fn severity(&self) -> u8 {
        match self {
            Self::Unreachable(_) => 0,
            Self::Failed(_) => 1,
            Self::CredentialUnavailable(_) => 2,
        }
    }
}

impl std::fmt::Display for TerminalHostConnectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for TerminalHostConnectError {}

impl From<TerminalHostConnectError> for String {
    fn from(error: TerminalHostConnectError) -> Self {
        match error {
            TerminalHostConnectError::Unreachable(message)
            | TerminalHostConnectError::CredentialUnavailable(message)
            | TerminalHostConnectError::Failed(message) => message,
        }
    }
}

pub async fn connect_terminal_host(endpoint: &str) -> Result<BoxedTerminalHostIo, String> {
    connect_terminal_host_as(endpoint, ClientIdentity::local("desktop")).await
}

/// [`try_connect_terminal_host_as`] with the error flattened to its message,
/// for callers that only report it.
pub async fn connect_terminal_host_as(
    endpoint: &str,
    identity: ClientIdentity,
) -> Result<BoxedTerminalHostIo, String> {
    try_connect_terminal_host_as(endpoint, identity)
        .await
        .map_err(String::from)
}

/// Open an authenticated connection, classifying any failure.
///
/// The secret is read before the socket is opened: a credential the OS store
/// refuses is a local problem no host can fix, and connecting first would only
/// hand the host a connection it then has to reject.
pub async fn try_connect_terminal_host_as(
    endpoint: &str,
    identity: ClientIdentity,
) -> Result<BoxedTerminalHostIo, TerminalHostConnectError> {
    connect_terminal_host_with_secret(endpoint, &identity, bootstrap_secret).await
}

async fn connect_terminal_host_with_secret(
    endpoint: &str,
    identity: &ClientIdentity,
    load_secret: fn() -> Result<String, String>,
) -> Result<BoxedTerminalHostIo, TerminalHostConnectError> {
    let secret = tokio::task::spawn_blocking(load_secret)
        .await
        .map_err(|error| {
            TerminalHostConnectError::CredentialUnavailable(format!(
                "terminal credential task failed: {error}"
            ))
        })?
        .map_err(TerminalHostConnectError::CredentialUnavailable)?;
    let payload =
        client_auth_payload(&secret, identity).map_err(TerminalHostConnectError::Failed)?;
    #[cfg(unix)]
    let mut stream: BoxedTerminalHostIo = Box::pin(
        tokio::net::UnixStream::connect(endpoint)
            .await
            .map_err(|error| {
                classify_connect_error(
                    &error,
                    format!("terminal host socket connect failed: {error}"),
                )
            })?,
    );
    #[cfg(windows)]
    let mut stream: BoxedTerminalHostIo = {
        use tokio::net::windows::named_pipe::ClientOptions;
        Box::pin(ClientOptions::new().open(endpoint).map_err(|error| {
            classify_connect_error(
                &error,
                format!("terminal host named pipe open failed: {error}"),
            )
        })?)
    };
    write_client_auth(&mut stream, &payload)
        .await
        .map_err(TerminalHostConnectError::Failed)?;
    Ok(stream)
}

/// Sort a socket/pipe open failure into "nothing is listening" or not.
///
/// Unix: `NotFound` is a missing socket, `ConnectionRefused` a stale one left
/// by a host that died, and `WouldBlock` a full backlog (Linux), which a
/// retry outlasts. Windows: `NotFound` is a missing pipe, and `ERROR_PIPE_BUSY`
/// means every instance is taken for the moment; it is retried like an absent
/// host, and a host spawned for it exits at once because the pipe name is
/// already owned. Anything else (a socket this user may not open, for one)
/// stays the same however many hosts start.
fn classify_connect_error(error: &std::io::Error, message: String) -> TerminalHostConnectError {
    #[cfg(windows)]
    const ERROR_PIPE_BUSY: i32 = 231;
    let unreachable = matches!(
        error.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::WouldBlock
    );
    #[cfg(windows)]
    let unreachable = unreachable || error.raw_os_error() == Some(ERROR_PIPE_BUSY);
    if unreachable {
        TerminalHostConnectError::Unreachable(message)
    } else {
        TerminalHostConnectError::Failed(message)
    }
}

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("owner-only file permissions failed: {error}"))
}

#[cfg(windows)]
fn set_owner_only_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("owner-only directory permissions failed: {error}"))
}

#[cfg(windows)]
fn set_owner_only_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_reads_never_rotate_existing_or_inaccessible_keys() {
        for existing in ["existing", "invalid"] {
            assert_eq!(
                load_or_create_credential_with(
                    KEYRING_ACCOUNT,
                    || Ok(existing.into()),
                    |_| panic!("must not replace an existing credential"),
                )
                .unwrap(),
                existing
            );
        }
        let denied = keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("denied")));
        let error = load_or_create_credential_with(
            KEYRING_ACCOUNT,
            || Err(denied),
            |_| panic!("denial is not absence"),
        )
        .unwrap_err();
        // The message names the item and says what to do, so the Host's
        // `HostOffline` reason is actionable.
        assert!(error.contains("read failed"));
        assert!(error.contains(KEYRING_SERVICE));
        assert!(error.contains(KEYRING_ACCOUNT));
        assert!(error.contains("Hint:"));
    }

    #[test]
    fn missing_credentials_are_persisted_before_they_are_returned() {
        let written = std::cell::RefCell::new(None);
        let secret = load_or_create_credential_with(
            KEYRING_ACCOUNT,
            || Err(keyring::Error::NoEntry),
            |value| {
                *written.borrow_mut() = Some(value.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert!(valid_bootstrap_secret(&secret));
        assert!(decode_signing_key(&secret).is_ok());
        assert_eq!(written.into_inner(), Some(secret));
        assert!(load_or_create_credential_with(
            KEYRING_ACCOUNT,
            || Err(keyring::Error::NoEntry),
            |_| Err(keyring::Error::NoStorageAccess(Box::new(
                std::io::Error::other("denied")
            ))),
        )
        .is_err());
    }

    /// The baseline is what a start-at-login host applies before any desktop
    /// client has said hello — a phone spawning against a machine whose app has
    /// never run. It cannot see the app's managed-CLI registry, but
    /// `~/.cargo/bin` it can always work out for itself.
    #[test]
    fn host_baseline_path_injection_appends_cargo_bin() {
        let injection = host_baseline_path_injection();
        match dirs::home_dir() {
            Some(home) => assert_eq!(injection.append, vec![home.join(".cargo").join("bin")]),
            // Headless CI without a resolvable HOME: an empty append is the
            // honest answer, not a panic.
            None => assert!(injection.append.is_empty()),
        }
    }

    #[test]
    fn bootstrap_secret_validation_is_strict() {
        assert!(valid_bootstrap_secret(&"a".repeat(32)));
        assert!(!valid_bootstrap_secret("short"));
        assert!(!valid_bootstrap_secret(&format!("{}!", "a".repeat(31))));
    }

    #[test]
    fn secret_comparison_checks_length_and_content() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn endpoint_is_scoped_to_the_current_user_runtime() {
        let endpoint = default_terminal_host_endpoint();
        assert!(endpoint.contains("cognia"));
        assert!(endpoint.contains("terminal-host"));
    }

    #[test]
    fn credential_key_ids_are_device_and_key_bound() {
        let first = terminal_credential_key_id("device-a", "public-a");
        assert_eq!(first, terminal_credential_key_id("device-a", "public-a"));
        assert_ne!(first, terminal_credential_key_id("device-b", "public-a"));
        assert_ne!(first, terminal_credential_key_id("device-a", "public-b"));
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn stored_signing_keys_require_exactly_thirty_two_bytes() {
        let valid = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
        assert!(decode_signing_key(&valid).is_ok());
        let short = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 31]);
        assert!(decode_signing_key(&short).is_err());
    }

    #[test]
    fn serialized_remote_identity_requires_a_device_id() {
        let invalid = SerializableClientIdentity {
            client_id: "client-a".into(),
            device_id: None,
            local: false,
            allow_remote_terminal: true,
        };
        assert!(ClientIdentity::try_from(invalid).is_err());
        let valid = SerializableClientIdentity {
            client_id: "client-a".into(),
            device_id: Some("device-a".into()),
            local: false,
            allow_remote_terminal: true,
        };
        let identity = ClientIdentity::try_from(valid).unwrap();
        assert_eq!(identity.device_id.as_deref(), Some("device-a"));
        assert!(!identity.local);
    }

    #[test]
    fn host_settings_validate_resource_limits_and_default_remote_access_off() {
        let settings = TerminalHostSettings::default();
        assert!(!settings.allow_remote_access);
        assert!(settings.host_config().is_ok());
        let mut invalid = settings;
        invalid.max_sessions = 0;
        assert!(invalid.host_config().is_err());
    }

    #[test]
    fn default_remote_profile_is_interactive_and_credential_free() {
        let request = default_terminal_profile();
        assert!(!request.shell.trim().is_empty());
        assert_eq!(request.origin, SessionOrigin::Remote);
        assert!(request.env.is_empty());
        assert!(request.cwd.is_none());
        assert!(request.enable_shell_integration);
    }

    #[test]
    fn service_argument_quoting_handles_spaces_and_metacharacters() {
        // Pre-existing bug, surfaced by the ADR-0067 move: the input was written
        // as a RAW string containing `\"`, so the backslashes were literal. Correct
        // escaping doubles them (`\\\"`), which the assertion could never match —
        // the test asserted that a literal backslash silently disappears. The
        // metacharacter this means to cover is a bare quote.
        let quoted = quote_service_arg(r#"/path with space/"terminal""#);
        assert!(quoted.starts_with('"'));
        assert!(quoted.ends_with('"'));
        assert!(quoted.contains("\\\"terminal\\\""));
        // A literal backslash must survive as an escaped pair.
        assert!(quote_service_arg(r"a\b").contains(r"a\\b"));
    }
    /// Tests share one process-wide secret cache; fill it with a test value so
    /// nothing here ever reaches the real credential store.
    fn install_test_bootstrap_secret() -> String {
        BOOTSTRAP_SECRET.get_or_init(|| "t".repeat(43)).clone()
    }

    fn test_secret() -> Result<String, String> {
        Ok("s".repeat(43))
    }

    #[test]
    fn connect_errors_say_whether_starting_a_host_can_help() {
        let unreachable = TerminalHostConnectError::Unreachable("refused".into());
        let credential = TerminalHostConnectError::CredentialUnavailable("denied".into());
        let failed = TerminalHostConnectError::Failed("hung up".into());
        assert!(unreachable.host_start_may_help());
        assert!(!credential.host_start_may_help());
        assert!(!failed.host_start_may_help());
        assert!(credential.severity() > failed.severity());
        assert!(failed.severity() > unreachable.severity());
        assert_eq!(String::from(credential), "denied");

        for kind in [
            std::io::ErrorKind::NotFound,
            std::io::ErrorKind::ConnectionRefused,
        ] {
            assert!(matches!(
                classify_connect_error(&std::io::Error::from(kind), String::new()),
                TerminalHostConnectError::Unreachable(_)
            ));
        }
        assert!(matches!(
            classify_connect_error(
                &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
                String::new()
            ),
            TerminalHostConnectError::Failed(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn accept_errors_are_classified_by_what_retrying_can_fix() {
        let class = |errno| classify_accept_error(&std::io::Error::from_raw_os_error(errno));
        assert_eq!(class(libc::EMFILE), AcceptFailure::Resources);
        assert_eq!(class(libc::ENFILE), AcceptFailure::Resources);
        assert_eq!(class(libc::ECONNABORTED), AcceptFailure::Connection);
        assert_eq!(class(libc::EINTR), AcceptFailure::Connection);
        assert_eq!(class(libc::EBADF), AcceptFailure::Listener);
        assert_eq!(class(libc::EINVAL), AcceptFailure::Listener);
        assert_eq!(class(libc::EIO), AcceptFailure::Unknown);
    }

    #[test]
    fn accept_backoff_grows_resets_and_gives_up_only_on_unknown_failures() {
        let mut backoff = AcceptBackoff::default();
        assert_eq!(
            backoff.failed(AcceptFailure::Connection),
            Some(Duration::ZERO)
        );
        assert_eq!(backoff.failed(AcceptFailure::Listener), None);
        let first = backoff.failed(AcceptFailure::Resources).unwrap();
        let second = backoff.failed(AcceptFailure::Resources).unwrap();
        assert_eq!(first, ACCEPT_BACKOFF_START);
        assert!(second > first);
        // Descriptor exhaustion never ends the host, and never spins.
        for _ in 0..1_000 {
            let delay = backoff.failed(AcceptFailure::Resources).unwrap();
            assert!(delay >= ACCEPT_BACKOFF_START && delay <= ACCEPT_BACKOFF_MAX);
        }
        backoff.succeeded();
        assert_eq!(
            backoff.failed(AcceptFailure::Resources),
            Some(ACCEPT_BACKOFF_START)
        );

        let mut backoff = AcceptBackoff::default();
        for _ in 0..MAX_UNKNOWN_ACCEPT_FAILURES {
            assert!(backoff.failed(AcceptFailure::Unknown).is_some());
        }
        assert_eq!(backoff.failed(AcceptFailure::Unknown), None);
    }

    /// Bug 1 regression: a client that hangs up before its peer credentials are
    /// read (what a second host's "already running" probe does), and a peer
    /// that fails the check (another OS user), used to end the whole host.
    #[cfg(unix)]
    #[tokio::test]
    async fn listener_survives_hung_up_and_rejected_peers() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        use tokio::io::AsyncReadExt;

        install_test_bootstrap_secret();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.sock");
        let endpoint = path.to_string_lossy().into_owned();
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let checked = Arc::new(AtomicUsize::new(0));
        let check_count = Arc::clone(&checked);
        let (authenticated_tx, mut authenticated_rx) = tokio::sync::mpsc::unbounded_channel();
        let listener_task = tokio::spawn(accept_unix_connections(
            listener,
            move |stream| {
                // The second connection stands in for another OS user's process.
                if check_count.fetch_add(1, Ordering::SeqCst) == 1 {
                    return Err("terminal host rejected a peer owned by another OS user".into());
                }
                verify_unix_peer(stream)
            },
            move |mut stream| {
                let authenticated_tx = authenticated_tx.clone();
                // Finishes on its own: every client here either sends its
                // handshake or closes.
                tokio::spawn(async move {
                    let outcome = authenticate_server(&mut stream)
                        .await
                        .map(|identity| identity.client_id);
                    let _ = authenticated_tx.send(outcome);
                });
            },
        ));

        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            drop(tokio::net::UnixStream::connect(&path).await.unwrap());

            let mut rejected = tokio::net::UnixStream::connect(&path).await.unwrap();
            let mut byte = [0u8; 1];
            assert_eq!(
                rejected.read(&mut byte).await.unwrap(),
                0,
                "a rejected peer is dropped"
            );

            let _client = connect_terminal_host_with_secret(
                &endpoint,
                &ClientIdentity::local("probe"),
                bootstrap_secret,
            )
            .await
            .expect("a well-behaved client still connects");
            loop {
                if let Some(Ok(client_id)) = authenticated_rx.recv().await {
                    break client_id;
                }
            }
        })
        .await
        .expect("listener answered within the timeout");

        assert_eq!(outcome, "probe");
        assert!(checked.load(Ordering::SeqCst) >= 3);
        assert!(!listener_task.is_finished(), "listener kept running");
        listener_task.abort();
        let _ = listener_task.await;
    }

    /// A credential this process cannot read is reported as such, before any
    /// socket is opened for the host to reject.
    #[cfg(unix)]
    #[tokio::test]
    async fn credential_failure_is_reported_without_opening_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let error = match connect_terminal_host_with_secret(
            &path.to_string_lossy(),
            &ClientIdentity::local("probe"),
            || Err("terminal credential read failed: denied".into()),
        )
        .await
        {
            Ok(_) => panic!("a refused credential cannot connect"),
            Err(error) => error,
        };
        assert_eq!(
            error,
            TerminalHostConnectError::CredentialUnavailable(
                "terminal credential read failed: denied".into()
            )
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "no connection reached the host"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_and_stale_sockets_are_unreachable() {
        let dir = tempfile::tempdir().unwrap();
        let identity = ClientIdentity::local("probe");
        let missing = dir.path().join("missing.sock");
        let error =
            connect_terminal_host_with_secret(&missing.to_string_lossy(), &identity, test_secret)
                .await
                .err()
                .expect("nothing listens on a missing socket");
        assert!(
            matches!(error, TerminalHostConnectError::Unreachable(_)),
            "{error}"
        );

        // A host that died leaves its socket file behind.
        let stale = dir.path().join("stale.sock");
        drop(tokio::net::UnixListener::bind(&stale).unwrap());
        assert!(stale.exists());
        let error =
            connect_terminal_host_with_secret(&stale.to_string_lossy(), &identity, test_secret)
                .await
                .err()
                .expect("nothing listens on a stale socket");
        assert!(
            matches!(error, TerminalHostConnectError::Unreachable(_)),
            "{error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn host_log_is_owner_only_and_rotated_when_large() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let (mut file, path) = open_terminal_host_log_in(dir.path()).unwrap();
        file.write_all(b"first host\n").unwrap();
        drop(file);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        // Appends while small.
        let (mut file, _) = open_terminal_host_log_in(dir.path()).unwrap();
        file.write_all(b"second host\n").unwrap();
        drop(file);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "first host\nsecond host\n"
        );

        // Rotated once past the bound.
        std::fs::write(&path, vec![b'x'; HOST_LOG_ROTATE_BYTES as usize + 1]).unwrap();
        let (_file, path) = open_terminal_host_log_in(dir.path()).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(
            std::fs::metadata(dir.path().join(format!("{HOST_LOG_FILE}.1")))
                .unwrap()
                .len(),
            HOST_LOG_ROTATE_BYTES + 1
        );
    }
}
