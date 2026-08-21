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

fn load_or_create_bootstrap_secret() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("terminal host keyring init failed: {error}"))?;
    match entry.get_password() {
        Ok(secret) if valid_bootstrap_secret(&secret) => Ok(secret),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::fill(&mut bytes);
            let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
            entry
                .set_password(&secret)
                .map_err(|error| format!("terminal host keyring write failed: {error}"))?;
            Ok(secret)
        }
        Err(error) => Err(format!("terminal host keyring read failed: {error}")),
    }
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
    let entry = keyring::Entry::new(KEYRING_SERVICE, SIGNING_KEY_ACCOUNT)
        .map_err(|error| format!("terminal descriptor keyring init failed: {error}"))?;
    match entry.get_password() {
        Ok(encoded) => decode_signing_key(&encoded),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::fill(&mut bytes);
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
            entry
                .set_password(&encoded)
                .map_err(|error| format!("terminal descriptor keyring write failed: {error}"))?;
            Ok(SigningKey::from_bytes(&bytes))
        }
        Err(error) => Err(format!("terminal descriptor keyring read failed: {error}")),
    }
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

async fn authenticate_client<S: AsyncWrite + Unpin>(
    stream: &mut S,
    identity: &ClientIdentity,
) -> Result<(), String> {
    let secret = tokio::task::spawn_blocking(bootstrap_secret)
        .await
        .map_err(|error| format!("terminal host auth task failed: {error}"))??;
    stream
        .write_u16(secret.len() as u16)
        .await
        .map_err(|error| format!("terminal host auth length write failed: {error}"))?;
    stream
        .write_all(secret.as_bytes())
        .await
        .map_err(|error| format!("terminal host auth write failed: {error}"))?;
    let identity = serde_json::to_vec(&SerializableClientIdentity::from(identity))
        .map_err(|error| format!("terminal host identity serialization failed: {error}"))?;
    if identity.len() > AUTH_MAX_BYTES {
        return Err("terminal host client identity is too large".into());
    }
    stream
        .write_u16(identity.len() as u16)
        .await
        .map_err(|error| format!("terminal host identity length write failed: {error}"))?;
    stream
        .write_all(&identity)
        .await
        .map_err(|error| format!("terminal host identity write failed: {error}"))?;
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

    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("terminal host socket accept failed: {error}"))?;
        verify_unix_peer(&stream)?;
        let host = host.clone();
        let script_dir = script_dir.clone();
        let known_hosts_path = known_hosts_path.clone();
        tokio::spawn(async move {
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
        });
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
    let mut first = true;
    loop {
        let server = ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create(&endpoint)
            .map_err(|error| format!("terminal host named pipe create failed: {error}"))?;
        first = false;
        server
            .connect()
            .await
            .map_err(|error| format!("terminal host named pipe connect failed: {error}"))?;
        let host = host.clone();
        let script_dir = script_dir.clone();
        let known_hosts_path = known_hosts_path.clone();
        tokio::spawn(async move {
            let mut server = server;
            let identity = match authenticate_server(&mut server).await {
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
                serve_host_stream(server, host, identity, script_dir, known_hosts_path).await
            {
                log::warn!("terminal host connection closed: {error}");
            }
        });
    }
}

pub async fn connect_terminal_host(endpoint: &str) -> Result<BoxedTerminalHostIo, String> {
    connect_terminal_host_as(endpoint, ClientIdentity::local("desktop")).await
}

pub async fn connect_terminal_host_as(
    endpoint: &str,
    identity: ClientIdentity,
) -> Result<BoxedTerminalHostIo, String> {
    #[cfg(unix)]
    let mut stream: BoxedTerminalHostIo = Box::pin(
        tokio::net::UnixStream::connect(endpoint)
            .await
            .map_err(|error| format!("terminal host socket connect failed: {error}"))?,
    );
    #[cfg(windows)]
    let mut stream: BoxedTerminalHostIo = {
        use tokio::net::windows::named_pipe::ClientOptions;
        Box::pin(
            ClientOptions::new()
                .open(endpoint)
                .map_err(|error| format!("terminal host named pipe open failed: {error}"))?,
        )
    };
    authenticate_client(&mut stream, &identity).await?;
    Ok(stream)
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
}
