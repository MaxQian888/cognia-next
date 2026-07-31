//! Native SSH terminal transport.
//!
//! Host metadata arrives from renderer settings, while authentication secrets
//! are resolved from the OS keyring in this process. Server keys use a
//! dedicated OpenSSH `known_hosts` file with TOFU semantics: first use is
//! learned, later connections must match, and changed keys fail closed.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use cognia_secrets::keyring_secrets;
use russh::client;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::known_hosts::learn_known_hosts_path;
use russh::keys::{check_known_hosts_path, load_secret_key, ssh_key};
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::host::HostedTerminalProcess;
use crate::integration::ShellKind;
use crate::osc633::Osc633Parser;
use crate::replay::ReplayBuffer;
use crate::session::{EventSink, TerminalEvent};

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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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

#[derive(Debug, Clone)]
struct SshIntegrationNegotiation {
    enabled: bool,
    degraded_reason: Option<String>,
}

async fn probe_remote_shell(
    handle: &client::Handle<ClientHandler>,
) -> Result<Option<ShellKind>, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH shell probe channel failed: {error}"))?;
    channel
        .exec(true, "printf 'COGNIA_SHELL=%s\\n' \"$SHELL\"")
        .await
        .map_err(|error| format!("SSH shell probe was rejected: {error}"))?;
    let output = tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if bytes.len() + data.len() <= 4096 {
                        bytes.extend_from_slice(&data);
                    }
                }
                ChannelMsg::ExitStatus { .. } | ChannelMsg::Close => break,
                _ => {}
            }
        }
        bytes
    })
    .await
    .map_err(|_| "SSH shell probe timed out".to_string())?;
    Ok(classify_remote_shell(&output))
}

async fn connect_remote(
    request: &SshSpawnRequest,
    credential: &StoredCredential,
    known_hosts_path: &Path,
    integration_nonce: &str,
) -> Result<(RemoteConnection, HostObservation, SshIntegrationNegotiation), String> {
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

    let probed_shell = probe_remote_shell(&handle).await;

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
    let integration = match probed_shell {
        Ok(Some(shell)) => match ssh_integration_command(shell, integration_nonce) {
            Some(command) => match writer.data_bytes(command.into_bytes()).await {
                Ok(()) => SshIntegrationNegotiation {
                    enabled: true,
                    degraded_reason: None,
                },
                Err(error) => SshIntegrationNegotiation {
                    enabled: false,
                    degraded_reason: Some(format!(
                        "ssh_shell_integration_injection_failed:{error}"
                    )),
                },
            },
            None => SshIntegrationNegotiation {
                enabled: false,
                degraded_reason: Some("ssh_shell_integration_unsupported".into()),
            },
        },
        Ok(None) => SshIntegrationNegotiation {
            enabled: false,
            degraded_reason: Some("ssh_shell_integration_unsupported".into()),
        },
        Err(error) => SshIntegrationNegotiation {
            enabled: false,
            degraded_reason: Some(format!("ssh_shell_integration_probe_failed:{error}")),
        },
    };
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
        integration,
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

fn classify_remote_shell(output: &[u8]) -> Option<ShellKind> {
    let text = String::from_utf8_lossy(output);
    let value = text
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("COGNIA_SHELL="))?
        .trim()
        .trim_start_matches('-');
    let kind = ShellKind::from_shell_path(value);
    matches!(kind, ShellKind::Bash | ShellKind::Zsh | ShellKind::Fish).then_some(kind)
}

fn ssh_integration_command(kind: ShellKind, nonce: &str) -> Option<String> {
    if !(16..=64).contains(&nonce.len()) || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let script = match kind {
        ShellKind::Bash => format!(
            r#"__cognia_term_emit() {{ printf '\033]633;%s;{nonce}\a' "$1"; }}
__cognia_term_emit_with() {{ printf '\033]633;%s;{nonce};%s\a' "$1" "$2"; }}
__cognia_term_in_prompt=0
__cognia_term_preexec() {{ [ "$__cognia_term_in_prompt" = 1 ] || __cognia_term_emit C; }}
__cognia_term_precmd() {{ local e=$?; __cognia_term_in_prompt=1; __cognia_term_emit_with D "$e"; __cognia_term_emit_with P "Cwd=$PWD"; __cognia_term_in_prompt=0; }}
trap '__cognia_term_preexec' DEBUG
if [ -n "$PROMPT_COMMAND" ]; then PROMPT_COMMAND="__cognia_term_precmd; $PROMPT_COMMAND"; else PROMPT_COMMAND=__cognia_term_precmd; fi
PS1="\[\e]633;A;{nonce}\a\]${{PS1}}\[\e]633;B;{nonce}\a\]""#
        ),
        ShellKind::Zsh => format!(
            r#"__cognia_term_emit() {{ printf '\033]633;%s;{nonce}\a' "$1"; }}
__cognia_term_emit_with() {{ printf '\033]633;%s;{nonce};%s\a' "$1" "$2"; }}
__cognia_term_preexec() {{ __cognia_term_emit C; }}
__cognia_term_precmd() {{ local e=$?; __cognia_term_emit_with D "$e"; __cognia_term_emit_with P "Cwd=$PWD"; }}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __cognia_term_precmd
add-zsh-hook preexec __cognia_term_preexec
PROMPT=$'%{{\033]633;A;{nonce}\a%}}'${{PROMPT}}$'%{{\033]633;B;{nonce}\a%}}'"#
        ),
        ShellKind::Fish => format!(
            r#"function __cognia_term_emit
  printf '\033]633;%s;{nonce}\a' $argv[1]
end
function __cognia_term_emit_with
  printf '\033]633;%s;{nonce};%s\a' $argv[1] $argv[2]
end
function __cognia_term_preexec --on-event fish_preexec
  __cognia_term_emit C
end
function __cognia_term_render_prompt --on-event fish_prompt
  set -l e $status
  __cognia_term_emit_with D $e
  __cognia_term_emit_with P "Cwd=$PWD"
  __cognia_term_emit A
end"#
        ),
        _ => return None,
    };
    let quoted = script.replace('\'', "'\"'\"'");
    Some(format!("eval '{quoted}'\r"))
}

#[derive(Debug)]
enum SessionCommand {
    Write(Vec<u8>),
    Resize { rows: u16, cols: u16 },
    Kill,
}

pub struct SshTerminalSession {
    command_tx: mpsc::Sender<SessionCommand>,
    alive: Arc<AtomicBool>,
    replay: Arc<ReplayBuffer>,
}

impl SshTerminalSession {
    fn write_owned(&self, data: Vec<u8>) -> Result<(), String> {
        self.command_tx
            .try_send(SessionCommand::Write(data))
            .map_err(|error| format!("SSH write queue unavailable: {error}"))
    }

    fn resize_terminal(&self, rows: u16, cols: u16) -> Result<(), String> {
        self.command_tx
            .try_send(SessionCommand::Resize { rows, cols })
            .map_err(|error| format!("SSH resize queue unavailable: {error}"))
    }

    fn kill_terminal(&self) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Ok(());
        }
        self.command_tx
            .try_send(SessionCommand::Kill)
            .map_err(|error| format!("SSH command queue unavailable: {error}"))
    }
}

impl HostedTerminalProcess for SshTerminalSession {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.write_owned(bytes.to_vec())
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        self.resize_terminal(rows.max(1), cols.max(1))
    }

    fn kill(&self) -> Result<(), String> {
        self.kill_terminal()
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    fn replay(&self) -> Arc<ReplayBuffer> {
        Arc::clone(&self.replay)
    }
}

fn emit_event(replay: &ReplayBuffer, sink: &EventSink, event: TerminalEvent) {
    let seq = replay.push(event.clone());
    sink(seq, event);
}

fn emit_notice(replay: &ReplayBuffer, sink: &EventSink, notice: &str) {
    emit_event(
        replay,
        sink,
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
    sink: &EventSink,
    parser: &mut Option<Osc633Parser>,
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
                        if let Some(parser) = parser.as_mut() {
                            for event in parser.feed(&data) {
                                emit_event(replay, sink, TerminalEvent::Integration { event });
                            }
                        }
                        emit_event(replay, sink, TerminalEvent::Data { bytes: data.to_vec() });
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
    integration_nonce: String,
    integration_enabled: bool,
) {
    let mut pending = VecDeque::new();
    let mut parser = integration_enabled.then(|| Osc633Parser::new(integration_nonce.clone()));
    let exit_code = loop {
        match drive_connection(
            &mut connection,
            &mut request,
            &mut commands,
            &mut pending,
            &output.replay,
            &output.sink,
            &mut parser,
        )
        .await
        {
            ConnectionEnd::Killed => break None,
            ConnectionEnd::Normal(code) => break code,
            ConnectionEnd::Lost => {
                emit_notice(
                    &output.replay,
                    &output.sink,
                    "[SSH connection lost; reconnecting]",
                );
                let mut reconnected = None;
                for (attempt, delay) in RECONNECT_DELAYS.into_iter().enumerate() {
                    if wait_before_reconnect(delay, &mut commands, &mut pending).await {
                        output.alive.store(false, Ordering::Release);
                        emit_event(
                            &output.replay,
                            &output.sink,
                            TerminalEvent::Exit { code: None },
                        );
                        return;
                    }
                    match connect_remote(
                        &request,
                        &credential,
                        &known_hosts_path,
                        &integration_nonce,
                    )
                    .await
                    {
                        Ok((next, _, integration)) => {
                            parser = integration
                                .enabled
                                .then(|| Osc633Parser::new(integration_nonce.clone()));
                            reconnected = Some(next);
                            emit_notice(&output.replay, &output.sink, "[SSH reconnected]");
                            break;
                        }
                        Err(error) if attempt + 1 < RECONNECT_DELAYS.len() => {
                            emit_notice(
                                &output.replay,
                                &output.sink,
                                &format!("[SSH reconnect attempt failed: {error}]"),
                            );
                        }
                        Err(error) => {
                            emit_notice(
                                &output.replay,
                                &output.sink,
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
        &output.sink,
        TerminalEvent::Exit { code: exit_code },
    );
}

struct SshSessionOutput {
    sink: EventSink,
    replay: Arc<ReplayBuffer>,
    alive: Arc<AtomicBool>,
}

pub struct HostedSshSpawn {
    pub process: SshTerminalSession,
    pub host_key_status: String,
    pub host_key_fingerprint: String,
    pub integration_enabled: bool,
    pub integration_degraded_reason: Option<String>,
}

/// Connect an SSH PTY whose lifetime and replay are owned by the durable
/// terminal host. The caller supplies the canonical event sink so SSH and
/// local PTYs share the same attachment, controller, and backpressure path.
pub async fn spawn_hosted_ssh(
    req: SshSpawnRequest,
    known_hosts_path: PathBuf,
    replay: Arc<ReplayBuffer>,
    sink: EventSink,
) -> Result<HostedSshSpawn, String> {
    req.validate()?;
    let credential_request = req.clone();
    let credential =
        tokio::task::spawn_blocking(move || load_stored_credential(&credential_request))
            .await
            .map_err(|error| format!("SSH credential task failed: {error}"))??;
    let integration_nonce = uuid::Uuid::new_v4().simple().to_string();
    let (connection, observation, integration) =
        connect_remote(&req, &credential, &known_hosts_path, &integration_nonce).await?;
    let status = observation
        .status
        .ok_or_else(|| "SSH server did not present a host key".to_string())?;
    let fingerprint = observation
        .fingerprint
        .ok_or_else(|| "SSH host-key fingerprint is unavailable".to_string())?;
    let (command_tx, command_rx) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    let alive = Arc::new(AtomicBool::new(true));
    let process = SshTerminalSession {
        command_tx,
        alive: alive.clone(),
        replay: Arc::clone(&replay),
    };
    tokio::spawn(run_ssh_session(
        connection,
        req,
        credential,
        known_hosts_path,
        command_rx,
        SshSessionOutput {
            sink,
            replay,
            alive,
        },
        integration_nonce,
        integration.enabled,
    ));
    Ok(HostedSshSpawn {
        process,
        host_key_status: status.as_str().into(),
        host_key_fingerprint: fingerprint,
        integration_enabled: integration.enabled,
        integration_degraded_reason: integration.degraded_reason,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use russh::keys::{parse_public_key_base64, ssh_key};

    use super::{
        classify_remote_shell, parse_stored_credential, ssh_integration_command,
        verify_or_learn_host_key, HostKeyStatus, ShellKind, SshAuthMethod, SshSpawnRequest,
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

    #[test]
    fn remote_shell_probe_accepts_only_supported_interactive_shells() {
        assert_eq!(
            classify_remote_shell(b"noise\nCOGNIA_SHELL=/bin/bash\n"),
            Some(ShellKind::Bash)
        );
        assert_eq!(
            classify_remote_shell(b"COGNIA_SHELL=-zsh\n"),
            Some(ShellKind::Zsh)
        );
        assert_eq!(
            classify_remote_shell(b"COGNIA_SHELL=/usr/bin/fish\n"),
            Some(ShellKind::Fish)
        );
        assert_eq!(classify_remote_shell(b"COGNIA_SHELL=/bin/tcsh\n"), None);
    }

    #[test]
    fn ssh_integration_is_nonce_bound_and_never_interpolates_unknown_shells() {
        let nonce = "0123456789abcdef";
        for shell in [ShellKind::Bash, ShellKind::Zsh, ShellKind::Fish] {
            let command = ssh_integration_command(shell, nonce).expect("supported shell");
            assert!(command.contains(nonce));
            assert!(command.contains("633"));
            assert!(command.ends_with('\r'));
        }
        assert!(ssh_integration_command(ShellKind::Pwsh, nonce).is_none());
        assert!(ssh_integration_command(ShellKind::Unknown, nonce).is_none());
        assert!(ssh_integration_command(ShellKind::Bash, "unsafe';command").is_none());
    }
}
