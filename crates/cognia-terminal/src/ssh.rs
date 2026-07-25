//! Native SSH terminal transport.
//!
//! Host metadata arrives from renderer settings, while authentication secrets
//! are resolved from the OS keyring in this process. Server keys use a
//! dedicated OpenSSH `known_hosts` file with TOFU semantics: first use is
//! learned, later connections must match, and changed keys fail closed.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use cognia_secrets::keyring_secrets;
use parking_lot::Mutex;
use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::known_hosts::learn_known_hosts_path;
use russh::keys::{check_known_hosts_path, load_secret_key, ssh_key};
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::replay::ReplayBuffer;
use crate::session::{SeqEvent, SessionOrigin, TerminalEvent, TerminalSessionInfo};

const SSH_CREDENTIAL_NAMESPACE: &str = "cognia-ssh";
const COMMAND_QUEUE_CAPACITY: usize = 256;
const RECONNECT_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyStatus {
    Learned,
    Verified,
}

impl HostKeyStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Learned => "learned",
            Self::Verified => "verified",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    pub credential_ref: Option<String>,
    pub private_key_path: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub project_id: Option<String>,
    pub profile_id: String,
    pub display_name: String,
}

impl SshSpawnRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty() || self.host.chars().any(char::is_whitespace) {
            return Err("SSH host is invalid".into());
        }
        if self.username.trim().is_empty() || self.username.chars().any(char::is_whitespace) {
            return Err("SSH username is invalid".into());
        }
        if self.port == 0 {
            return Err("SSH port is invalid".into());
        }
        if self.profile_id.trim().is_empty() {
            return Err("SSH profile id is required".into());
        }
        if self.rows == 0 || self.cols == 0 {
            return Err("SSH terminal size is invalid".into());
        }
        if self.auth_method == SshAuthMethod::PrivateKey
            && self
                .private_key_path
                .as_deref()
                .is_none_or(|path| path.trim().is_empty())
        {
            return Err("SSH private key path is required".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct StoredCredential {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
}

fn parse_stored_credential(raw: &str) -> Result<StoredCredential, String> {
    let credential: StoredCredential =
        serde_json::from_str(raw).map_err(|_| "invalid SSH credential payload".to_string())?;
    if credential.password.as_deref().is_none_or(str::is_empty)
        && credential.passphrase.as_deref().is_none_or(str::is_empty)
    {
        return Err("invalid SSH credential payload".into());
    }
    Ok(credential)
}

fn load_stored_credential(request: &SshSpawnRequest) -> Result<StoredCredential, String> {
    let Some(reference) = request.credential_ref.as_deref() else {
        if request.auth_method == SshAuthMethod::Password {
            return Err("SSH password credential is required".into());
        }
        return Ok(StoredCredential {
            password: None,
            passphrase: None,
        });
    };
    let raw = keyring_secrets::get(SSH_CREDENTIAL_NAMESPACE, reference)?
        .ok_or_else(|| "SSH credential was not found in the OS keyring".to_string())?;
    parse_stored_credential(&raw)
}

pub fn verify_or_learn_host_key(
    host: &str,
    port: u16,
    key: &ssh_key::PublicKey,
    known_hosts_path: &Path,
) -> Result<HostKeyStatus, russh::keys::Error> {
    if check_known_hosts_path(host, port, key, known_hosts_path)? {
        return Ok(HostKeyStatus::Verified);
    }
    learn_known_hosts_path(host, port, key, known_hosts_path)?;
    Ok(HostKeyStatus::Learned)
}

#[derive(Debug, Default)]
struct HostObservation {
    status: Option<HostKeyStatus>,
    fingerprint: Option<String>,
}

#[derive(Clone)]
struct ClientHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    observation: Arc<StdMutex<HostObservation>>,
}

#[derive(Debug, thiserror::Error)]
enum ClientHandlerError {
    #[error(transparent)]
    Russh(#[from] russh::Error),
    #[error(transparent)]
    Key(#[from] russh::keys::Error),
}

impl client::Handler for ClientHandler {
    type Error = ClientHandlerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let status = verify_or_learn_host_key(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        )?;
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        let mut observation = self
            .observation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        observation.status = Some(status);
        observation.fingerprint = Some(fingerprint);
        Ok(true)
    }
}

struct RemoteConnection {
    handle: client::Handle<ClientHandler>,
    reader: russh::ChannelReadHalf,
    writer: russh::ChannelWriteHalf<client::Msg>,
}

async fn connect_remote(
    request: &SshSpawnRequest,
    credential: &StoredCredential,
    known_hosts_path: &Path,
) -> Result<(RemoteConnection, HostObservation), String> {
    let observation = Arc::new(StdMutex::new(HostObservation::default()));
    let handler = ClientHandler {
        host: request.host.clone(),
        port: request.port,
        known_hosts_path: known_hosts_path.to_path_buf(),
        observation: observation.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let mut handle = client::connect(config, (request.host.as_str(), request.port), handler)
        .await
        .map_err(|error| format!("SSH connection failed: {error}"))?;

    let authenticated = match request.auth_method {
        SshAuthMethod::Password => {
            let password = credential
                .password
                .as_deref()
                .ok_or_else(|| "SSH password credential is missing".to_string())?;
            handle
                .authenticate_password(&request.username, password)
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?
                .success()
        }
        SshAuthMethod::PrivateKey => {
            let path = expand_home(
                request
                    .private_key_path
                    .as_deref()
                    .ok_or_else(|| "SSH private key path is missing".to_string())?,
            );
            let key = load_secret_key(path, credential.passphrase.as_deref())
                .map_err(|error| format!("SSH private key could not be loaded: {error}"))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("SSH RSA negotiation failed: {error}"))?
                .flatten();
            handle
                .authenticate_publickey(
                    &request.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| format!("SSH private-key authentication failed: {error}"))?
                .success()
        }
    };
    if !authenticated {
        return Err("SSH authentication was rejected by the server".into());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH session channel failed: {error}"))?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            u32::from(request.cols),
            u32::from(request.rows),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("SSH PTY request failed: {error}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| format!("SSH shell request failed: {error}"))?;
    let (reader, writer) = channel.split();
    let observed = {
        let mut guard = observation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *guard)
    };
    Ok((
        RemoteConnection {
            handle,
            reader,
            writer,
        },
        observed,
    ))
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

#[derive(Debug)]
enum SessionCommand {
    Write(Vec<u8>),
    Resize { rows: u16, cols: u16 },
    Kill,
}

pub struct SshTerminalSession {
    id: String,
    request: SshSpawnRequest,
    command_tx: mpsc::Sender<SessionCommand>,
    alive: Arc<AtomicBool>,
}

impl SshTerminalSession {
    fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: self.id.clone(),
            project_id: self.request.project_id.clone(),
            extension_id: None,
            origin: SessionOrigin::Remote,
            shell: format!("ssh {}@{}", self.request.username, self.request.host),
            pid: None,
            alive: self.alive.load(Ordering::Acquire),
        }
    }

    fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.command_tx
            .try_send(SessionCommand::Write(data))
            .map_err(|error| format!("SSH write queue unavailable: {error}"))
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        self.command_tx
            .try_send(SessionCommand::Resize { rows, cols })
            .map_err(|error| format!("SSH resize queue unavailable: {error}"))
    }

    fn kill(&self) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Ok(());
        }
        self.command_tx
            .try_send(SessionCommand::Kill)
            .map_err(|error| format!("SSH command queue unavailable: {error}"))
    }
}

#[derive(Default)]
pub struct SshTerminalState {
    sessions: Mutex<HashMap<String, Arc<SshTerminalSession>>>,
}

impl SshTerminalState {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, session: Arc<SshTerminalSession>) {
        self.sessions.lock().insert(session.id.clone(), session);
    }

    fn get(&self, id: &str) -> Option<Arc<SshTerminalSession>> {
        self.sessions.lock().get(id).cloned()
    }

    fn remove(&self, id: &str) -> Option<Arc<SshTerminalSession>> {
        self.sessions.lock().remove(id)
    }
}

fn emit_event(replay: &ReplayBuffer, channel: &Channel<SeqEvent>, event: TerminalEvent) {
    let seq = replay.push(event.clone());
    let _ = channel.send(SeqEvent { seq, event });
}

fn emit_notice(replay: &ReplayBuffer, channel: &Channel<SeqEvent>, notice: &str) {
    emit_event(
        replay,
        channel,
        TerminalEvent::Data {
            bytes: format!("\r\n{notice}\r\n").into_bytes(),
        },
    );
}

enum ConnectionEnd {
    Killed,
    Normal(Option<u32>),
    Lost,
}

async fn drive_connection(
    connection: &mut RemoteConnection,
    request: &mut SshSpawnRequest,
    commands: &mut mpsc::Receiver<SessionCommand>,
    pending: &mut VecDeque<SessionCommand>,
    replay: &ReplayBuffer,
    channel: &Channel<SeqEvent>,
) -> ConnectionEnd {
    let mut exit_code = None;
    loop {
        if let Some(command) = pending.pop_front() {
            if handle_session_command(command, connection, request).await {
                return ConnectionEnd::Killed;
            }
            continue;
        }
        tokio::select! {
            message = connection.reader.wait() => {
                match message {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        emit_event(replay, channel, TerminalEvent::Data { bytes: data.to_vec() });
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status);
                    }
                    Some(ChannelMsg::Close) | None => {
                        return if exit_code.is_some() {
                            ConnectionEnd::Normal(exit_code)
                        } else {
                            ConnectionEnd::Lost
                        };
                    }
                    _ => {}
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    return ConnectionEnd::Killed;
                };
                if handle_session_command(command, connection, request).await {
                    return ConnectionEnd::Killed;
                }
            }
        }
    }
}

async fn handle_session_command(
    command: SessionCommand,
    connection: &mut RemoteConnection,
    request: &mut SshSpawnRequest,
) -> bool {
    match command {
        SessionCommand::Write(data) => {
            let _ = connection.writer.data_bytes(data).await;
            false
        }
        SessionCommand::Resize { rows, cols } => {
            request.rows = rows.max(1);
            request.cols = cols.max(1);
            let _ = connection
                .writer
                .window_change(u32::from(request.cols), u32::from(request.rows), 0, 0)
                .await;
            false
        }
        SessionCommand::Kill => {
            let _ = connection.writer.close().await;
            let _ = connection
                .handle
                .disconnect(Disconnect::ByApplication, "closed by user", "en")
                .await;
            true
        }
    }
}

async fn wait_before_reconnect(
    delay: Duration,
    commands: &mut mpsc::Receiver<SessionCommand>,
    pending: &mut VecDeque<SessionCommand>,
) -> bool {
    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return false,
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Kill) | None => return true,
                    Some(command) => pending.push_back(command),
                }
            }
        }
    }
}

async fn run_ssh_session(
    mut connection: RemoteConnection,
    mut request: SshSpawnRequest,
    credential: StoredCredential,
    known_hosts_path: PathBuf,
    mut commands: mpsc::Receiver<SessionCommand>,
    output: SshSessionOutput,
) {
    let mut pending = VecDeque::new();
    let exit_code = loop {
        match drive_connection(
            &mut connection,
            &mut request,
            &mut commands,
            &mut pending,
            &output.replay,
            &output.channel,
        )
        .await
        {
            ConnectionEnd::Killed => break None,
            ConnectionEnd::Normal(code) => break code,
            ConnectionEnd::Lost => {
                emit_notice(
                    &output.replay,
                    &output.channel,
                    "[SSH connection lost; reconnecting]",
                );
                let mut reconnected = None;
                for (attempt, delay) in RECONNECT_DELAYS.into_iter().enumerate() {
                    if wait_before_reconnect(delay, &mut commands, &mut pending).await {
                        output.alive.store(false, Ordering::Release);
                        emit_event(
                            &output.replay,
                            &output.channel,
                            TerminalEvent::Exit { code: None },
                        );
                        return;
                    }
                    match connect_remote(&request, &credential, &known_hosts_path).await {
                        Ok((next, _)) => {
                            reconnected = Some(next);
                            emit_notice(&output.replay, &output.channel, "[SSH reconnected]");
                            break;
                        }
                        Err(error) if attempt + 1 < RECONNECT_DELAYS.len() => {
                            emit_notice(
                                &output.replay,
                                &output.channel,
                                &format!("[SSH reconnect attempt failed: {error}]"),
                            );
                        }
                        Err(error) => {
                            emit_notice(
                                &output.replay,
                                &output.channel,
                                &format!("[SSH reconnect failed: {error}]"),
                            );
                        }
                    }
                }
                match reconnected {
                    Some(next) => connection = next,
                    None => break None,
                }
            }
        }
    };
    output.alive.store(false, Ordering::Release);
    emit_event(
        &output.replay,
        &output.channel,
        TerminalEvent::Exit { code: exit_code },
    );
}

struct SshSessionOutput {
    channel: Channel<SeqEvent>,
    replay: Arc<ReplayBuffer>,
    alive: Arc<AtomicBool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnResult {
    session: TerminalSessionInfo,
    host_key_status: String,
    host_key_fingerprint: String,
}

#[tauri::command]
pub async fn ssh_terminal_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SshTerminalState>,
    req: SshSpawnRequest,
    on_event: Channel<SeqEvent>,
) -> Result<SshSpawnResult, String> {
    req.validate()?;
    let credential_request = req.clone();
    let credential =
        tokio::task::spawn_blocking(move || load_stored_credential(&credential_request))
            .await
            .map_err(|error| format!("SSH credential task failed: {error}"))??;
    let known_hosts_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("SSH app data directory unavailable: {error}"))?
        .join("ssh")
        .join("known_hosts");
    let (connection, observation) = connect_remote(&req, &credential, &known_hosts_path).await?;
    let status = observation
        .status
        .ok_or_else(|| "SSH server did not present a host key".to_string())?;
    let fingerprint = observation
        .fingerprint
        .ok_or_else(|| "SSH host-key fingerprint is unavailable".to_string())?;
    let id = Uuid::now_v7().to_string();
    let (command_tx, command_rx) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    let alive = Arc::new(AtomicBool::new(true));
    let replay = Arc::new(ReplayBuffer::new());
    let session = Arc::new(SshTerminalSession {
        id,
        request: req.clone(),
        command_tx,
        alive: alive.clone(),
    });
    let info = session.info();
    state.insert(session);
    tokio::spawn(run_ssh_session(
        connection,
        req,
        credential,
        known_hosts_path,
        command_rx,
        SshSessionOutput {
            channel: on_event,
            replay,
            alive,
        },
    ));
    Ok(SshSpawnResult {
        session: info,
        host_key_status: status.as_str().into(),
        host_key_fingerprint: fingerprint,
    })
}

#[tauri::command]
pub fn ssh_terminal_write(
    state: State<'_, SshTerminalState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state
        .get(&id)
        .ok_or_else(|| format!("unknown SSH session id: {id}"))?
        .write(data)
}

#[tauri::command]
pub fn ssh_terminal_resize(
    state: State<'_, SshTerminalState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state
        .get(&id)
        .ok_or_else(|| format!("unknown SSH session id: {id}"))?
        .resize(rows.max(1), cols.max(1))
}

#[tauri::command]
pub fn ssh_terminal_kill(state: State<'_, SshTerminalState>, id: String) -> Result<(), String> {
    if let Some(session) = state.remove(&id) {
        session.kill()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use russh::keys::{parse_public_key_base64, ssh_key};

    use super::{
        parse_stored_credential, verify_or_learn_host_key, HostKeyStatus, SshAuthMethod,
        SshSpawnRequest,
    };

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    fn key(encoded: &str) -> ssh_key::PublicKey {
        parse_public_key_base64(encoded).expect("test public key")
    }

    #[test]
    fn tofu_learns_unknown_host_then_verifies_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");

        assert_eq!(
            verify_or_learn_host_key("host.example", 22, &key(KEY_A), &path).unwrap(),
            HostKeyStatus::Learned
        );
        assert_eq!(
            verify_or_learn_host_key("host.example", 22, &key(KEY_A), &path).unwrap(),
            HostKeyStatus::Verified
        );
        let saved = fs::read_to_string(path).expect("known_hosts written");
        assert!(saved.contains("host.example ssh-ed25519"));
    }

    #[test]
    fn tofu_rejects_a_changed_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        verify_or_learn_host_key("host.example", 2222, &key(KEY_A), &path).unwrap();

        let error = verify_or_learn_host_key("host.example", 2222, &key(KEY_B), &path).unwrap_err();
        assert!(error.to_string().contains("changed"));
    }

    fn request() -> SshSpawnRequest {
        SshSpawnRequest {
            host: "host.example".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: SshAuthMethod::Password,
            credential_ref: Some("ssh-1".into()),
            private_key_path: None,
            rows: 24,
            cols: 80,
            project_id: Some("project-1".into()),
            profile_id: "ssh-1".into(),
            display_name: "Production".into(),
        }
    }

    #[test]
    fn spawn_request_validation_rejects_ambiguous_or_incomplete_targets() {
        assert!(request().validate().is_ok());

        let mut invalid = request();
        invalid.host = "bad host".into();
        assert!(invalid.validate().unwrap_err().contains("host"));

        let mut invalid = request();
        invalid.username.clear();
        assert!(invalid.validate().unwrap_err().contains("username"));

        let mut invalid = request();
        invalid.auth_method = SshAuthMethod::PrivateKey;
        invalid.private_key_path = None;
        assert!(invalid.validate().unwrap_err().contains("private key"));
    }

    #[test]
    fn stored_credentials_are_typed_and_never_accept_empty_payloads() {
        let password = parse_stored_credential(r#"{"password":"secret"}"#).unwrap();
        assert_eq!(password.password.as_deref(), Some("secret"));
        assert_eq!(password.passphrase, None);

        let passphrase = parse_stored_credential(r#"{"passphrase":"key-secret"}"#).unwrap();
        assert_eq!(passphrase.passphrase.as_deref(), Some("key-secret"));
        assert!(parse_stored_credential("{}").is_err());
        assert!(parse_stored_credential(r#"{"password":42}"#).is_err());
    }
}
