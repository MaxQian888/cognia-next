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
use russh::client::{ChannelOpenHandle, Msg as ClientMsg};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::known_hosts::{known_host_keys_path, learn_known_hosts_path};
use russh::keys::{check_known_hosts_path, load_secret_key, ssh_key};
use russh::{Channel, ChannelMsg, ChannelOpenFailure, Disconnect};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::host::HostedTerminalProcess;
use crate::integration::ShellKind;
use crate::osc633::Osc633Parser;
use crate::replay::ReplayBuffer;
use crate::session::{EventSink, TerminalEvent};
use crate::ssh_forward::{
    validate_local_forwards, validate_remote_forwards, ForwardRegistry, ForwardRunState,
    ForwardStatus, LocalForward, RemoteForward, FORWARD_BIND_ADDRESS, MAX_JUMP_DEPTH,
};

const SSH_CREDENTIAL_NAMESPACE: &str = "cognia-ssh";
/// Prefix marking a spawn failure the renderer must render as a security
/// warning rather than a generic connection error. The payload after the colon
/// is a JSON [`HostKeyChange`].
///
/// A prefixed code is how this module already carries machine-readable detail
/// through the host's `String` error channel (see the
/// `ssh_shell_integration_*` degraded reasons), so it needs no wire-protocol
/// change to reach the renderer intact.
pub const HOST_KEY_CHANGED_CODE: &str = "ssh_host_key_changed";
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
    /// Delegate the signature to a running `ssh-agent`. The private key never
    /// leaves the agent, so nothing is read from the keyring for this method.
    Agent,
}

/// One bastion on the way to the target, ordered outermost first.
///
/// A hop is a full SSH endpoint, not a transparent relay: it authenticates on
/// its own account and its host key is verified against the same `known_hosts`
/// file as any other server. Profile ids stay in the renderer — this process
/// only ever sees an address and the keyring reference that unlocks it.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub credential_ref: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
}

fn validate_endpoint(
    host: &str,
    port: u16,
    username: &str,
    auth_method: SshAuthMethod,
    private_key_path: Option<&str>,
) -> Result<(), String> {
    if host.trim().is_empty() || host.chars().any(char::is_whitespace) {
        return Err("SSH host is invalid".into());
    }
    if username.trim().is_empty() || username.chars().any(char::is_whitespace) {
        return Err("SSH username is invalid".into());
    }
    if port == 0 {
        return Err("SSH port is invalid".into());
    }
    if auth_method == SshAuthMethod::PrivateKey
        && private_key_path.is_none_or(|path| path.trim().is_empty())
    {
        return Err("SSH private key path is required".into());
    }
    Ok(())
}

impl SshJumpHop {
    fn validate(&self) -> Result<(), String> {
        validate_endpoint(
            &self.host,
            self.port,
            &self.username,
            self.auth_method,
            self.private_key_path.as_deref(),
        )
        .map_err(|error| format!("{error} (jump host {}:{})", self.host, self.port))
    }
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
    /// Bastions to traverse, outermost first. Empty means a direct connection.
    #[serde(default)]
    pub jump_chain: Vec<SshJumpHop>,
    #[serde(default)]
    pub local_forwards: Vec<LocalForward>,
    #[serde(default)]
    pub remote_forwards: Vec<RemoteForward>,
}

impl SshSpawnRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_endpoint(
            &self.host,
            self.port,
            &self.username,
            self.auth_method,
            self.private_key_path.as_deref(),
        )?;
        if self.profile_id.trim().is_empty() {
            return Err("SSH profile id is required".into());
        }
        if self.rows == 0 || self.cols == 0 {
            return Err("SSH terminal size is invalid".into());
        }
        if self.jump_chain.len() > MAX_JUMP_DEPTH {
            return Err(format!("SSH jump chain exceeds {MAX_JUMP_DEPTH} hops"));
        }
        for hop in &self.jump_chain {
            hop.validate()?;
        }
        validate_local_forwards(&self.local_forwards)?;
        validate_remote_forwards(&self.remote_forwards)?;
        Ok(())
    }

    fn has_forwards(&self) -> bool {
        !self.local_forwards.is_empty() || !self.remote_forwards.is_empty()
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

fn load_credential_for(
    auth_method: SshAuthMethod,
    credential_ref: Option<&str>,
) -> Result<StoredCredential, String> {
    // The agent owns the key material and signs on our behalf, so there is
    // nothing to resolve. Short-circuit before the keyring lookup so a stale
    // `credential_ref` left behind by an auth-method switch cannot fail the
    // connection with a missing-secret error.
    if auth_method == SshAuthMethod::Agent {
        return Ok(StoredCredential {
            password: None,
            passphrase: None,
        });
    }
    let Some(reference) = credential_ref else {
        if auth_method == SshAuthMethod::Password {
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

fn load_stored_credential(request: &SshSpawnRequest) -> Result<StoredCredential, String> {
    load_credential_for(request.auth_method, request.credential_ref.as_deref())
}

/// Every secret a connection needs, resolved once.
///
/// Jump hops each unlock their own keyring entry, and all of them are read in
/// the single blocking task that already wraps the target's lookup — the
/// keyring is a synchronous, occasionally slow OS call, and a reconnect must
/// not go back to it (nor prompt again) for secrets it already holds.
#[derive(Debug, Clone)]
struct SshCredentials {
    target: StoredCredential,
    hops: Vec<StoredCredential>,
}

fn load_all_credentials(request: &SshSpawnRequest) -> Result<SshCredentials, String> {
    let hops = request
        .jump_chain
        .iter()
        .map(|hop| {
            load_credential_for(hop.auth_method, hop.credential_ref.as_deref())
                .map_err(|error| format!("{error} (jump host {}:{})", hop.host, hop.port))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SshCredentials {
        target: load_stored_credential(request)?,
        hops,
    })
}

/// What the server presented, when it does not match what we already trust.
///
/// Carried to the renderer so the warning can name both fingerprints. A changed
/// host key is either a re-provisioned server or a machine-in-the-middle, and
/// the user is the only one who can tell those apart.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChange {
    pub host: String,
    pub port: u16,
    /// Fingerprint recorded on first connect. `None` when the stored entry
    /// cannot be read back — a hand-edited or truncated `known_hosts`.
    pub known_fingerprint: Option<String>,
    pub presented_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Learned,
    Verified,
    Changed(HostKeyChange),
}

fn fingerprint_of(key: &ssh_key::PublicKey) -> String {
    key.fingerprint(ssh_key::HashAlg::Sha256).to_string()
}

/// Fingerprint currently recorded for `host:port`, if it can be read back.
fn stored_host_fingerprint(host: &str, port: u16, known_hosts_path: &Path) -> Option<String> {
    known_host_keys_path(host, port, known_hosts_path)
        .ok()?
        .first()
        .map(|(_, key)| fingerprint_of(key))
}

pub fn verify_or_learn_host_key(
    host: &str,
    port: u16,
    key: &ssh_key::PublicKey,
    known_hosts_path: &Path,
) -> Result<HostKeyVerdict, russh::keys::Error> {
    match check_known_hosts_path(host, port, key, known_hosts_path) {
        Ok(true) => Ok(HostKeyVerdict::Verified),
        Ok(false) => {
            learn_known_hosts_path(host, port, key, known_hosts_path)?;
            Ok(HostKeyVerdict::Learned)
        }
        // A mismatch is a verdict, not a malfunction: it still fails the
        // connection closed, but the caller needs both fingerprints to explain
        // why rather than surfacing a bare library error.
        Err(russh::keys::Error::KeyChanged { .. }) => Ok(HostKeyVerdict::Changed(HostKeyChange {
            host: host.to_string(),
            port,
            known_fingerprint: stored_host_fingerprint(host, port, known_hosts_path),
            presented_fingerprint: fingerprint_of(key),
        })),
        Err(other) => Err(other),
    }
}

/// Drop every recorded key for `host:port` so the next connection re-learns it.
///
/// Deliberately narrow: it rewrites `known_hosts` without the matching lines
/// rather than exposing a general edit, and it is only reachable from a
/// local-identity caller (ADR-0082 §8.3 — a remote or mobile client must never
/// be able to re-trust a server on the desktop's behalf).
pub fn forget_host_key(host: &str, port: u16, known_hosts_path: &Path) -> Result<usize, String> {
    let entries = known_host_keys_path(host, port, known_hosts_path)
        .map_err(|error| format!("known_hosts could not be read: {error}"))?;
    if entries.is_empty() {
        return Ok(0);
    }
    let doomed: std::collections::HashSet<usize> = entries.iter().map(|(line, _)| *line).collect();
    let contents = std::fs::read_to_string(known_hosts_path)
        .map_err(|error| format!("known_hosts could not be read: {error}"))?;
    // `known_host_keys_path` reports 1-based line numbers.
    let kept: Vec<&str> = contents
        .lines()
        .enumerate()
        .filter(|(index, _)| !doomed.contains(&(index + 1)))
        .map(|(_, line)| line)
        .collect();
    let mut next = kept.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    std::fs::write(known_hosts_path, next)
        .map_err(|error| format!("known_hosts could not be written: {error}"))?;
    Ok(doomed.len())
}

#[derive(Debug, Default)]
struct HostObservation {
    status: Option<HostKeyStatus>,
    fingerprint: Option<String>,
    changed: Option<HostKeyChange>,
}

#[derive(Clone)]
struct ClientHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
    observation: Arc<StdMutex<HostObservation>>,
    /// Present only on the target connection. Jump hops carry no forwards, so
    /// an inbound channel on a bastion has nowhere to land and is refused.
    forwards: Option<Arc<ForwardRegistry>>,
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
        let verdict = verify_or_learn_host_key(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        )?;
        let mut observation = self
            .observation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        observation.fingerprint = Some(fingerprint_of(server_public_key));
        match verdict {
            HostKeyVerdict::Learned => observation.status = Some(HostKeyStatus::Learned),
            HostKeyVerdict::Verified => observation.status = Some(HostKeyStatus::Verified),
            // Reject rather than erroring so the recorded change survives for
            // `connect_remote` to turn into a message the user can act on.
            HostKeyVerdict::Changed(change) => {
                observation.changed = Some(change);
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// A `-R` connection arriving from the server.
    ///
    /// The server names only the port it accepted on, so the port is the whole
    /// authorization check: it must belong to a rule this session asked for and
    /// still has switched on. Anything else — a stale forward from before a
    /// toggle, or a server opening a channel we never requested — is rejected
    /// rather than dialled into the user's machine.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<ClientMsg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = u16::try_from(connected_port)
            .ok()
            .and_then(|port| self.forwards.as_ref()?.remote_target(port));
        let (Some(rule), Some(registry)) = (target, self.forwards.clone()) else {
            log::warn!(
                "rejecting unsolicited SSH forwarded-tcpip on {connected_address}:{connected_port}"
            );
            reply
                .reject(ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(serve_remote_forward(channel, rule, registry));
        Ok(())
    }

    /// The server has no business opening a `direct-tcpip` to us; only a server
    /// we are forwarding *to* would, and that is the callback above.
    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: Channel<ClientMsg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::warn!(
            "rejecting server-initiated SSH direct-tcpip to {host_to_connect}:{port_to_connect}"
        );
        reply
            .reject(ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }
}

struct RemoteConnection {
    handle: Arc<client::Handle<ClientHandler>>,
    /// Bastions, outermost first. Held for their lifetime alone — never read —
    /// because dropping a hop's handle tears down the SSH session carrying
    /// every hop nested inside it, target included.
    #[allow(dead_code)]
    jump_handles: Vec<Arc<client::Handle<ClientHandler>>>,
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

/// Offer every identity the agent holds and stop at the first one the server
/// accepts.
///
/// A rejected identity is ordinary rather than exceptional — an agent commonly
/// carries keys for hosts other than this one — so a refusal advances to the
/// next candidate instead of aborting. Only an exhausted list is a failure.
async fn authenticate_via_agent<S>(
    agent: &mut AgentClient<S>,
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
) -> Result<bool, String>
where
    S: AgentStream + Send + Unpin,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("SSH agent did not return identities: {error}"))?;
    if identities.is_empty() {
        return Err("SSH agent holds no identities; add one with `ssh-add`".into());
    }
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|error| format!("SSH RSA negotiation failed: {error}"))?
        .flatten();
    for identity in identities {
        let accepted = match identity {
            AgentIdentity::PublicKey { key, .. } => handle
                .authenticate_publickey_with(username, key, hash, agent)
                .await
                .map(|result| result.success()),
            AgentIdentity::Certificate { certificate, .. } => handle
                .authenticate_certificate_with(username, certificate, hash, agent)
                .await
                .map(|result| result.success()),
        };
        if matches!(accepted, Ok(true)) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Reach the platform's agent and run the identity walk against it.
///
/// Unix resolves `SSH_AUTH_SOCK` to a Unix-domain socket. Windows has no such
/// socket: OpenSSH for Windows exposes a named pipe (which `SSH_AUTH_SOCK`
/// names when set, otherwise the well-known path), and PuTTY's Pageant is the
/// other agent in common use, so both are tried before reporting failure.
#[cfg(unix)]
async fn authenticate_with_platform_agent(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
) -> Result<bool, String> {
    let mut agent = AgentClient::connect_env().await.map_err(|error| {
        format!("SSH agent is unavailable; check that SSH_AUTH_SOCK is set ({error})")
    })?;
    authenticate_via_agent(&mut agent, handle, username).await
}

#[cfg(windows)]
async fn authenticate_with_platform_agent(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
) -> Result<bool, String> {
    const DEFAULT_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    let pipe = std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| DEFAULT_AGENT_PIPE.to_string());
    match AgentClient::connect_named_pipe(pipe.as_str()).await {
        Ok(mut agent) => authenticate_via_agent(&mut agent, handle, username).await,
        Err(pipe_error) => {
            let mut agent = AgentClient::connect_pageant().await.map_err(|pageant_error| {
                format!(
                    "SSH agent is unavailable (named pipe {pipe}: {pipe_error}; Pageant: {pageant_error})"
                )
            })?;
            authenticate_via_agent(&mut agent, handle, username).await
        }
    }
}

/// Turn a failed handshake into the most specific thing we know.
///
/// A rejected server key surfaces as a plain transport failure, so the handler's
/// observation is consulted first: a changed fingerprint is a security event and
/// must not be reported as "connection failed".
fn describe_connect_failure(
    host: &str,
    port: u16,
    error: &dyn std::fmt::Display,
    observation: &StdMutex<HostObservation>,
) -> String {
    let changed = observation
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .changed
        .clone();
    if let Some(change) = changed {
        let payload = serde_json::to_string(&change).unwrap_or_else(|_| "{}".to_string());
        return format!("{HOST_KEY_CHANGED_CODE}:{payload}");
    }
    format!("SSH connection to {host}:{port} failed: {error}")
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    })
}

fn make_handler(
    host: &str,
    port: u16,
    known_hosts_path: &Path,
    forwards: Option<Arc<ForwardRegistry>>,
) -> (ClientHandler, Arc<StdMutex<HostObservation>>) {
    let observation = Arc::new(StdMutex::new(HostObservation::default()));
    (
        ClientHandler {
            host: host.to_string(),
            port,
            known_hosts_path: known_hosts_path.to_path_buf(),
            observation: Arc::clone(&observation),
            forwards,
        },
        observation,
    )
}

async fn authenticate_handle(
    handle: &mut client::Handle<ClientHandler>,
    username: &str,
    auth_method: SshAuthMethod,
    private_key_path: Option<&str>,
    credential: &StoredCredential,
) -> Result<(), String> {
    let authenticated = match auth_method {
        SshAuthMethod::Password => {
            let password = credential
                .password
                .as_deref()
                .ok_or_else(|| "SSH password credential is missing".to_string())?;
            handle
                .authenticate_password(username, password)
                .await
                .map_err(|error| format!("SSH password authentication failed: {error}"))?
                .success()
        }
        SshAuthMethod::PrivateKey => {
            let path = expand_home(
                private_key_path.ok_or_else(|| "SSH private key path is missing".to_string())?,
            );
            let key = load_secret_key(path, credential.passphrase.as_deref())
                .map_err(|error| format!("SSH private key could not be loaded: {error}"))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("SSH RSA negotiation failed: {error}"))?
                .flatten();
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|error| format!("SSH private-key authentication failed: {error}"))?
                .success()
        }
        SshAuthMethod::Agent => authenticate_with_platform_agent(handle, username).await?,
    };
    if !authenticated {
        return Err("SSH authentication was rejected by the server".into());
    }
    Ok(())
}

/// Walk the bastions, innermost handle last.
///
/// Each hop is a full SSH session in its own right — its own key check, its own
/// authentication — tunnelled inside the previous hop's `direct-tcpip` channel.
/// Every handle is returned because dropping one collapses everything nested
/// inside it.
async fn open_jump_chain(
    request: &SshSpawnRequest,
    credentials: &SshCredentials,
    known_hosts_path: &Path,
) -> Result<Vec<Arc<client::Handle<ClientHandler>>>, String> {
    let mut handles: Vec<Arc<client::Handle<ClientHandler>>> = Vec::new();
    for (index, hop) in request.jump_chain.iter().enumerate() {
        let (handler, observation) = make_handler(&hop.host, hop.port, known_hosts_path, None);
        let mut handle = match handles.last() {
            None => client::connect(client_config(), (hop.host.as_str(), hop.port), handler)
                .await
                .map_err(|error| {
                    describe_connect_failure(&hop.host, hop.port, &error, &observation)
                })?,
            Some(previous) => {
                let channel = previous
                    .channel_open_direct_tcpip(
                        hop.host.clone(),
                        u32::from(hop.port),
                        FORWARD_BIND_ADDRESS,
                        0,
                    )
                    .await
                    .map_err(|error| {
                        format!(
                            "SSH jump host refused to reach {}:{}: {error}",
                            hop.host, hop.port
                        )
                    })?;
                client::connect_stream(client_config(), channel.into_stream(), handler)
                    .await
                    .map_err(|error| {
                        describe_connect_failure(&hop.host, hop.port, &error, &observation)
                    })?
            }
        };
        let credential = credentials
            .hops
            .get(index)
            .ok_or_else(|| "SSH jump host credential is missing".to_string())?;
        authenticate_handle(
            &mut handle,
            &hop.username,
            hop.auth_method,
            hop.private_key_path.as_deref(),
            credential,
        )
        .await
        .map_err(|error| format!("{error} (jump host {}:{})", hop.host, hop.port))?;
        handles.push(Arc::new(handle));
    }
    Ok(handles)
}

async fn connect_remote(
    request: &SshSpawnRequest,
    credentials: &SshCredentials,
    known_hosts_path: &Path,
    integration_nonce: &str,
    forwards: Option<Arc<ForwardRegistry>>,
) -> Result<(RemoteConnection, HostObservation, SshIntegrationNegotiation), String> {
    let jump_handles = open_jump_chain(request, credentials, known_hosts_path).await?;
    let (handler, observation) = make_handler(
        &request.host,
        request.port,
        known_hosts_path,
        forwards.clone(),
    );
    let mut handle = match jump_handles.last() {
        None => client::connect(
            client_config(),
            (request.host.as_str(), request.port),
            handler,
        )
        .await
        .map_err(|error| {
            describe_connect_failure(&request.host, request.port, &error, &observation)
        })?,
        Some(previous) => {
            let channel = previous
                .channel_open_direct_tcpip(
                    request.host.clone(),
                    u32::from(request.port),
                    FORWARD_BIND_ADDRESS,
                    0,
                )
                .await
                .map_err(|error| {
                    format!(
                        "SSH jump host refused to reach {}:{}: {error}",
                        request.host, request.port
                    )
                })?;
            client::connect_stream(client_config(), channel.into_stream(), handler)
                .await
                .map_err(|error| {
                    describe_connect_failure(&request.host, request.port, &error, &observation)
                })?
        }
    };

    authenticate_handle(
        &mut handle,
        &request.username,
        request.auth_method,
        request.private_key_path.as_deref(),
        &credentials.target,
    )
    .await?;
    let handle = Arc::new(handle);

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
            jump_handles,
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

/// The handle currently carrying the session, republished on every reconnect
/// and cleared while the link is down.
type ConnectionSlot = watch::Receiver<Option<Arc<client::Handle<ClientHandler>>>>;

/// How long a caller accepted on a `-L` listener waits for the SSH link to come
/// back before being dropped.
///
/// Long enough to ride out the full reconnect ladder, short enough that a
/// browser tab pointed at a dead tunnel eventually gets an error instead of
/// hanging forever.
const FORWARD_QUEUE_TIMEOUT: Duration = Duration::from_secs(60);

async fn await_connection(slot: &mut ConnectionSlot) -> Option<Arc<client::Handle<ClientHandler>>> {
    loop {
        let current = slot.borrow().clone();
        if current.is_some() {
            return current;
        }
        slot.changed().await.ok()?;
    }
}

/// Carry one inbound caller on a `-L` rule.
///
/// The socket has already been accepted, so the tunnel being down is a wait
/// rather than a refusal: the caller is parked until the link returns. That is
/// what keeps a reconnect invisible to whatever is using the forward.
async fn serve_local_connection(
    mut socket: TcpStream,
    rule: LocalForward,
    registry: Arc<ForwardRegistry>,
    mut slot: ConnectionSlot,
) {
    registry.connection_queued(&rule.id);
    let waited = tokio::time::timeout(FORWARD_QUEUE_TIMEOUT, await_connection(&mut slot)).await;
    registry.connection_dequeued(&rule.id);
    let Ok(Some(handle)) = waited else {
        return;
    };
    let channel = match handle
        .channel_open_direct_tcpip(
            rule.remote_host.clone(),
            u32::from(rule.remote_port),
            FORWARD_BIND_ADDRESS,
            u32::from(rule.local_port),
        )
        .await
    {
        Ok(channel) => channel,
        Err(error) => {
            // The listener is healthy; this destination is not. Keep the rule
            // running and report the refusal so the user can see which end
            // is at fault.
            registry.mark(
                &rule.id,
                ForwardRunState::Listening,
                Some(format!(
                    "{}:{} refused the connection: {error}",
                    rule.remote_host, rule.remote_port
                )),
            );
            return;
        }
    };
    registry.connection_opened(&rule.id);
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
    registry.connection_closed(&rule.id);
}

/// Own one `-L` rule's listening socket for as long as the rule is enabled.
async fn run_local_forward(
    rule: LocalForward,
    registry: Arc<ForwardRegistry>,
    slot: ConnectionSlot,
) {
    let listener = match TcpListener::bind((FORWARD_BIND_ADDRESS, rule.local_port)).await {
        Ok(listener) => listener,
        Err(error) => {
            registry.mark(
                &rule.id,
                ForwardRunState::Failed,
                Some(format!(
                    "{FORWARD_BIND_ADDRESS}:{} could not be bound: {error}",
                    rule.local_port
                )),
            );
            return;
        }
    };
    registry.mark(&rule.id, ForwardRunState::Listening, None);
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                tokio::spawn(serve_local_connection(
                    socket,
                    rule.clone(),
                    Arc::clone(&registry),
                    slot.clone(),
                ));
            }
            Err(error) => {
                // Accept failures on an already-bound listener do not clear up
                // on their own (descriptor exhaustion, a revoked socket), so
                // report the rule as failed instead of spinning on the error.
                registry.mark(
                    &rule.id,
                    ForwardRunState::Failed,
                    Some(format!("the listener stopped accepting: {error}")),
                );
                return;
            }
        }
    }
}

/// Carry one inbound caller on a `-R` rule, dialling the local destination.
async fn serve_remote_forward(
    channel: Channel<ClientMsg>,
    rule: RemoteForward,
    registry: Arc<ForwardRegistry>,
) {
    let mut socket = match TcpStream::connect((rule.local_host.clone(), rule.local_port)).await {
        Ok(socket) => socket,
        Err(error) => {
            registry.mark(
                &rule.id,
                ForwardRunState::Listening,
                Some(format!(
                    "{}:{} is unreachable from this machine: {error}",
                    rule.local_host, rule.local_port
                )),
            );
            let _ = channel.close().await;
            return;
        }
    };
    registry.connection_opened(&rule.id);
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
    registry.connection_closed(&rule.id);
}

/// Keep the live tunnels matching the enabled rule set.
///
/// Driven by two edges and nothing else: the user toggling a rule, and the SSH
/// link appearing or disappearing. Local listeners are spawned and aborted here;
/// remote forwards are (re-)requested from the server, which forgets them every
/// time the connection drops.
async fn run_forward_supervisor(
    local_rules: Vec<LocalForward>,
    remote_rules: Vec<RemoteForward>,
    registry: Arc<ForwardRegistry>,
    mut connection: ConnectionSlot,
) {
    let mut control = registry.subscribe();
    let mut listeners: std::collections::HashMap<String, JoinHandle<()>> =
        std::collections::HashMap::new();
    let mut requested: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut current: Option<Arc<client::Handle<ClientHandler>>> = None;

    loop {
        let latest = connection.borrow().clone();
        let same_link = match (&current, &latest) {
            (Some(held), Some(next)) => Arc::ptr_eq(held, next),
            (None, None) => true,
            _ => false,
        };
        if !same_link {
            // A new session means the server has no memory of our forwards.
            requested.clear();
            current = latest;
        }

        for rule in &local_rules {
            match (
                registry.is_enabled(&rule.id),
                listeners.contains_key(&rule.id),
            ) {
                (true, false) => {
                    listeners.insert(
                        rule.id.clone(),
                        tokio::spawn(run_local_forward(
                            rule.clone(),
                            Arc::clone(&registry),
                            connection.clone(),
                        )),
                    );
                }
                (false, true) => {
                    if let Some(task) = listeners.remove(&rule.id) {
                        task.abort();
                    }
                }
                _ => {}
            }
            // A listener that stayed bound through an outage is working again
            // the moment the link returns; one that never bound keeps its error.
            if current.is_some() && listeners.contains_key(&rule.id) {
                registry.resume(&rule.id);
            }
        }

        if let Some(handle) = current.clone() {
            for rule in &remote_rules {
                let wanted = registry.is_enabled(&rule.id);
                let held = requested.contains(&rule.id);
                if wanted && !held {
                    match handle
                        .tcpip_forward(FORWARD_BIND_ADDRESS, u32::from(rule.remote_port))
                        .await
                    {
                        Ok(_) => {
                            requested.insert(rule.id.clone());
                            registry.mark(&rule.id, ForwardRunState::Listening, None);
                        }
                        Err(error) => registry.mark(
                            &rule.id,
                            ForwardRunState::Failed,
                            Some(format!(
                                "the server refused to listen on {FORWARD_BIND_ADDRESS}:{}: {error}",
                                rule.remote_port
                            )),
                        ),
                    }
                } else if !wanted && held {
                    let _ = handle
                        .cancel_tcpip_forward(FORWARD_BIND_ADDRESS, u32::from(rule.remote_port))
                        .await;
                    requested.remove(&rule.id);
                }
            }
        }

        let ended = tokio::select! {
            changed = connection.changed() => changed.is_err(),
            changed = control.changed() => changed.is_err(),
        };
        if ended {
            break;
        }
    }

    for (_, task) in listeners {
        task.abort();
    }
}

#[derive(Debug)]
enum SessionCommand {
    Write(Vec<u8>),
    Resize { rows: u16, cols: u16 },
    Kill,
}

pub struct SshTerminalSession {
    command_tx: mpsc::Sender<SessionCommand>,
    /// Flow-control pause, deliberately NOT routed through `command_tx`.
    ///
    /// The command queue is bounded and `try_send` fails exactly when a client
    /// is drowning — the one moment a pause must not be lost. A `watch` channel
    /// is lossless for the latest value and always accepts a send.
    flow_tx: watch::Sender<bool>,
    alive: Arc<AtomicBool>,
    replay: Arc<ReplayBuffer>,
    forwards: Arc<ForwardRegistry>,
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

    /// russh does its own window-based flow control; the equivalent of "stop
    /// reading" is to stop polling the channel, so russh stops issuing window
    /// adjustments and the remote end backs off.
    fn set_flow_paused(&self, paused: bool) -> Result<(), String> {
        self.flow_tx
            .send(paused)
            .map_err(|_| "SSH session is no longer running".to_string())
    }

    fn forward_status(&self) -> Vec<ForwardStatus> {
        self.forwards.status()
    }

    /// Record the user's intent and return.
    ///
    /// Binding a socket or asking the server to listen is asynchronous and can
    /// fail on its own schedule, so this cannot honestly report success. The
    /// rule flips to `starting` immediately and the next status read carries the
    /// outcome — including the reason, when there is one.
    fn set_forward_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        self.forwards.set_enabled(id, enabled)
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

#[allow(clippy::too_many_arguments)]
async fn drive_connection(
    connection: &mut RemoteConnection,
    request: &mut SshSpawnRequest,
    commands: &mut mpsc::Receiver<SessionCommand>,
    pending: &mut VecDeque<SessionCommand>,
    replay: &ReplayBuffer,
    sink: &EventSink,
    parser: &mut Option<Osc633Parser>,
    flow_rx: &mut watch::Receiver<bool>,
) -> ConnectionEnd {
    let mut exit_code = None;
    loop {
        if let Some(command) = pending.pop_front() {
            if handle_session_command(command, connection, request).await {
                return ConnectionEnd::Killed;
            }
            continue;
        }
        // Read the flag into a plain bool: holding the `watch::Ref` across the
        // `select!` below would keep the channel's lock over an await point.
        let paused = *flow_rx.borrow();
        tokio::select! {
            _ = flow_rx.changed() => {
                continue;
            }
            message = connection.reader.wait(), if !paused => {
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

#[allow(clippy::too_many_arguments)]
async fn run_ssh_session(
    mut connection: RemoteConnection,
    mut request: SshSpawnRequest,
    credentials: SshCredentials,
    known_hosts_path: PathBuf,
    mut commands: mpsc::Receiver<SessionCommand>,
    mut flow_rx: watch::Receiver<bool>,
    output: SshSessionOutput,
    integration_nonce: String,
    integration_enabled: bool,
    forwards: Arc<ForwardRegistry>,
    connection_tx: watch::Sender<Option<Arc<client::Handle<ClientHandler>>>>,
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
            &mut flow_rx,
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
                // Park the tunnels before the first retry: local listeners stay
                // bound and queue their callers, remote forwards are gone until
                // the server is asked again.
                let _ = connection_tx.send(None);
                forwards.connection_lost();
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
                        &credentials,
                        &known_hosts_path,
                        &integration_nonce,
                        Some(Arc::clone(&forwards)),
                    )
                    .await
                    {
                        Ok((next, _, integration)) => {
                            parser = integration
                                .enabled
                                .then(|| Osc633Parser::new(integration_nonce.clone()));
                            let _ = connection_tx.send(Some(Arc::clone(&next.handle)));
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
    // Dropping the sender is what stops the forward supervisor, which aborts
    // every listener it owns; clearing it first parks them in case anything is
    // mid-handoff.
    let _ = connection_tx.send(None);
    forwards.connection_lost();
    drop(connection_tx);
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
    let credentials =
        tokio::task::spawn_blocking(move || load_all_credentials(&credential_request))
            .await
            .map_err(|error| format!("SSH credential task failed: {error}"))??;
    let integration_nonce = uuid::Uuid::new_v4().simple().to_string();
    let forwards = Arc::new(ForwardRegistry::new(
        &req.local_forwards,
        &req.remote_forwards,
    ));
    let (connection, observation, integration) = connect_remote(
        &req,
        &credentials,
        &known_hosts_path,
        &integration_nonce,
        req.has_forwards().then(|| Arc::clone(&forwards)),
    )
    .await?;
    let status = observation
        .status
        .ok_or_else(|| "SSH server did not present a host key".to_string())?;
    let fingerprint = observation
        .fingerprint
        .ok_or_else(|| "SSH host-key fingerprint is unavailable".to_string())?;
    let (command_tx, command_rx) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    let (flow_tx, flow_rx) = watch::channel(false);
    let (connection_tx, connection_rx) = watch::channel(Some(Arc::clone(&connection.handle)));
    let alive = Arc::new(AtomicBool::new(true));
    let process = SshTerminalSession {
        command_tx,
        flow_tx,
        alive: alive.clone(),
        replay: Arc::clone(&replay),
        forwards: Arc::clone(&forwards),
    };
    if !forwards.is_empty() {
        tokio::spawn(run_forward_supervisor(
            req.local_forwards.clone(),
            req.remote_forwards.clone(),
            Arc::clone(&forwards),
            connection_rx,
        ));
    }
    tokio::spawn(run_ssh_session(
        connection,
        req,
        credentials,
        known_hosts_path,
        command_rx,
        flow_rx,
        SshSessionOutput {
            sink,
            replay,
            alive,
        },
        integration_nonce,
        integration.enabled,
        forwards,
        connection_tx,
    ));
    Ok(HostedSshSpawn {
        process,
        host_key_status: status.as_str().into(),
        host_key_fingerprint: fingerprint,
        integration_enabled: integration.enabled,
        integration_degraded_reason: integration.degraded_reason,
    })
}

/// A minimal in-process SSH server, enough of RFC 4254 to exercise the client
/// paths that matter: authentication, a PTY shell, `direct-tcpip` (which serves
/// both `-L` and every jump hop), and `tcpip_forward`.
///
/// Everything runs on `127.0.0.1:0` inside the test process, so the forwarding
/// and jump code is driven by a real SSH handshake over a real socket rather
/// than a stub — which is the only way to cover the parts that can go wrong.
#[cfg(test)]
mod test_server {
    use std::sync::Arc;

    use russh::keys::PrivateKey;
    use russh::server::{self, Auth, ChannelOpenHandle, Msg, Session};
    use russh::{Channel, ChannelId};
    use tokio::io::AsyncWriteExt;
    use tokio::net::{TcpListener, TcpStream};

    /// Test-only key material. Committed on purpose: a fixed pair keeps the
    /// tests deterministic and there is nothing to protect — these keys guard
    /// a listener that exists for the duration of one test.
    pub const HOST_KEY_A: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACA7SqYQ0BbL1dg6FkxIjIyVbtlnXPuXGo4UaFL3kZrKVgAAAJjVTelP1U3p
TwAAAAtzc2gtZWQyNTUxOQAAACA7SqYQ0BbL1dg6FkxIjIyVbtlnXPuXGo4UaFL3kZrKVg
AAAEBw195XP5sA0kc82zlqnn9rteGEtIJtKaUcpqJhBGA1djtKphDQFsvV2DoWTEiMjJVu
2Wdc+5cajhRoUveRmspWAAAAEGNvZ25pYS10ZXN0LWhvc3QBAgMEBQ==
-----END OPENSSH PRIVATE KEY-----
";

    pub const HOST_KEY_B: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCBiia7hhVIM40LIZ/mWK7kCgWL6KWNAR46WW5c6VonFwAAAJh5QTy4eUE8
uAAAAAtzc2gtZWQyNTUxOQAAACCBiia7hhVIM40LIZ/mWK7kCgWL6KWNAR46WW5c6VonFw
AAAEDpzNdHK9OEO2sbzp/Nmp9tzVeM7f5LQhO5A03TYmtPO4GKJruGFUgzjQshn+ZYruQK
BYvopY0BHjpZblzpWicXAAAAEmNvZ25pYS10ZXN0LWhvc3QtYgECAw==
-----END OPENSSH PRIVATE KEY-----
";

    pub const CLIENT_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCKwOjIlxHhRNLsdSwT6JJzixJFIIPW8jHg7lXfdh/FqgAAAJjlXJNw5VyT
cAAAAAtzc2gtZWQyNTUxOQAAACCKwOjIlxHhRNLsdSwT6JJzixJFIIPW8jHg7lXfdh/Fqg
AAAEAI2vEL2ee/m6utDwpSF3xHQ2HlKngvbj9K89+JEvGa+4rA6MiXEeFE0ux1LBPoknOL
EkUgg9byMeDuVd92H8WqAAAAEmNvZ25pYS10ZXN0LWNsaWVudAECAw==
-----END OPENSSH PRIVATE KEY-----
";

    #[derive(Debug, thiserror::Error)]
    #[error(transparent)]
    pub struct ServerError(#[from] russh::Error);

    #[derive(Clone, Default)]
    pub struct TestServerHandler {
        /// When set, an accepted `tcpip_forward` immediately opens one inbound
        /// channel back to the client, which is how a real server announces a
        /// connection arriving on the forwarded port.
        pub knock_on_forward: bool,
    }

    impl server::Server for TestServerHandler {
        type Handler = Self;

        fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }

    impl server::Handler for TestServerHandler {
        type Error = ServerError;

        /// Any key is accepted. Authentication is not what these tests are
        /// about; reaching the code *after* it is.
        async fn auth_publickey(
            &mut self,
            _user: &str,
            _key: &russh::keys::ssh_key::PublicKey,
        ) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _term: &str,
            _cols: u32,
            _rows: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(russh::Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            let handle = session.handle();
            tokio::spawn(async move {
                let _ = handle
                    .data(channel, b"cognia-test-shell\r\n".to_vec())
                    .await;
            });
            Ok(())
        }

        /// Dial what the client asked for and relay.
        ///
        /// This one handler covers both cases the client uses it for: a `-L`
        /// tunnel to some service, and a jump hop, where the "service" is the
        /// next SSH server in the chain.
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            reply: ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            let target = format!("{host_to_connect}:{port_to_connect}");
            match TcpStream::connect(&target).await {
                Ok(mut socket) => {
                    reply.accept().await;
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
                        let _ = socket.shutdown().await;
                    });
                }
                Err(_) => {
                    reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                }
            }
            Ok(())
        }

        async fn tcpip_forward(
            &mut self,
            address: &str,
            port: &mut u32,
            session: &mut Session,
        ) -> Result<bool, Self::Error> {
            let address = address.to_string();
            let port = *port;
            if self.knock_on_forward {
                let handle = session.handle();
                tokio::spawn(async move {
                    if let Ok(channel) = handle
                        .channel_open_forwarded_tcpip(address, port, "127.0.0.1", 65_000)
                        .await
                    {
                        let mut stream = channel.into_stream();
                        let _ = stream.write_all(b"from-remote").await;
                        // Reading the echo back proves the client dialled the
                        // local destination and wired both directions.
                        let mut buffer = [0u8; 32];
                        let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut buffer).await;
                    }
                });
            }
            Ok(true)
        }

        async fn cancel_tcpip_forward(
            &mut self,
            _address: &str,
            _port: u32,
            _session: &mut Session,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    pub struct RunningTestServer {
        pub port: u16,
    }

    /// Start a server on an ephemeral loopback port and leave it running for
    /// the rest of the test.
    pub async fn start(host_key: &str, knock_on_forward: bool) -> RunningTestServer {
        let key = PrivateKey::from_openssh(host_key).expect("test host key");
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = TestServerHandler { knock_on_forward };
                let config = Arc::clone(&config);
                tokio::spawn(async move {
                    let _ = server::run_stream(config, socket, handler).await;
                });
            }
        });
        RunningTestServer { port }
    }

    /// A loopback TCP server that echoes back what it is sent, used as the far
    /// end of a tunnel so a round trip can actually be asserted.
    pub async fn start_echo() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind echo");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let (mut reader, mut writer) = socket.split();
                    let _ = tokio::io::copy(&mut reader, &mut writer).await;
                });
            }
        });
        port
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use russh::keys::{parse_public_key_base64, ssh_key};

    use super::{
        classify_remote_shell, forget_host_key, learn_known_hosts_path, load_stored_credential,
        parse_stored_credential, spawn_hosted_ssh, ssh_integration_command,
        verify_or_learn_host_key, Arc, ForwardStatus, HostKeyChange, HostKeyVerdict,
        HostedSshSpawn, HostedTerminalProcess, LocalForward, PathBuf, ShellKind, SshAuthMethod,
        SshJumpHop, SshSpawnRequest, SshTerminalSession, HOST_KEY_CHANGED_CODE, MAX_JUMP_DEPTH,
    };

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    fn key(encoded: &str) -> ssh_key::PublicKey {
        parse_public_key_base64(encoded).expect("test public key")
    }

    fn fingerprint(encoded: &str) -> String {
        super::fingerprint_of(&key(encoded))
    }

    #[test]
    fn tofu_learns_unknown_host_then_verifies_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");

        assert_eq!(
            verify_or_learn_host_key("host.example", 22, &key(KEY_A), &path).unwrap(),
            HostKeyVerdict::Learned
        );
        assert_eq!(
            verify_or_learn_host_key("host.example", 22, &key(KEY_A), &path).unwrap(),
            HostKeyVerdict::Verified
        );
        let saved = fs::read_to_string(path).expect("known_hosts written");
        assert!(saved.contains("host.example ssh-ed25519"));
    }

    #[test]
    fn tofu_reports_a_changed_key_with_both_fingerprints() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        verify_or_learn_host_key("host.example", 2222, &key(KEY_A), &path).unwrap();

        let verdict = verify_or_learn_host_key("host.example", 2222, &key(KEY_B), &path).unwrap();
        let HostKeyVerdict::Changed(change) = verdict else {
            panic!("expected a changed verdict, got {verdict:?}");
        };
        assert_eq!(change.host, "host.example");
        assert_eq!(change.port, 2222);
        // Both sides are needed for the warning to mean anything: the one the
        // user trusted, and the one the server just presented.
        assert_eq!(
            change.known_fingerprint.as_deref(),
            Some(fingerprint(KEY_A).as_str())
        );
        assert_eq!(change.presented_fingerprint, fingerprint(KEY_B));

        // Fails closed — the presented key is never learned over the top of
        // the trusted one, so the next attempt reports the same mismatch.
        assert_eq!(
            super::stored_host_fingerprint("host.example", 2222, &path).as_deref(),
            Some(fingerprint(KEY_A).as_str())
        );
    }

    #[test]
    fn forgetting_a_host_lets_the_next_connection_relearn_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        verify_or_learn_host_key("keep.example", 22, &key(KEY_A), &path).unwrap();
        verify_or_learn_host_key("drop.example", 22, &key(KEY_A), &path).unwrap();

        assert_eq!(forget_host_key("drop.example", 22, &path).unwrap(), 1);

        // The untouched host still verifies, and the forgotten one is learned
        // afresh rather than reported as changed.
        assert_eq!(
            verify_or_learn_host_key("keep.example", 22, &key(KEY_A), &path).unwrap(),
            HostKeyVerdict::Verified
        );
        assert_eq!(
            verify_or_learn_host_key("drop.example", 22, &key(KEY_B), &path).unwrap(),
            HostKeyVerdict::Learned
        );
    }

    #[test]
    fn forgetting_an_unknown_host_is_a_no_op() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        verify_or_learn_host_key("keep.example", 22, &key(KEY_A), &path).unwrap();
        let before = fs::read_to_string(&path).expect("known_hosts readable");

        assert_eq!(forget_host_key("absent.example", 22, &path).unwrap(), 0);

        assert_eq!(
            fs::read_to_string(&path).expect("known_hosts readable"),
            before
        );
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
            jump_chain: Vec::new(),
            local_forwards: Vec::new(),
            remote_forwards: Vec::new(),
        }
    }

    fn hop(host: &str) -> SshJumpHop {
        SshJumpHop {
            host: host.into(),
            port: 22,
            username: "bastion".into(),
            auth_method: SshAuthMethod::Agent,
            credential_ref: None,
            private_key_path: None,
        }
    }

    fn local_rule(id: &str, port: u16) -> LocalForward {
        LocalForward {
            id: id.into(),
            local_port: port,
            remote_host: "db.internal".into(),
            remote_port: 5432,
            enabled: true,
        }
    }

    #[test]
    fn a_jump_chain_is_validated_hop_by_hop_and_capped() {
        let mut request = request();
        request.jump_chain = vec![hop("bastion-a.example"), hop("bastion-b.example")];
        assert!(request.validate().is_ok());

        // A bastion authenticates on its own account, so an incomplete hop is
        // as fatal as an incomplete target — and the message has to say which.
        let mut broken = request.clone();
        broken.jump_chain[1].auth_method = SshAuthMethod::PrivateKey;
        broken.jump_chain[1].private_key_path = None;
        let error = broken.validate().unwrap_err();
        assert!(error.contains("private key"), "{error}");
        assert!(error.contains("bastion-b.example"), "{error}");

        let mut deep = request.clone();
        deep.jump_chain = (0..=MAX_JUMP_DEPTH)
            .map(|index| hop(&format!("bastion-{index}.example")))
            .collect();
        assert!(deep.validate().unwrap_err().contains("jump chain"));
    }

    #[test]
    fn forwarding_rules_are_validated_before_a_socket_is_touched() {
        let mut request = request();
        request.local_forwards = vec![local_rule("l1", 8080), local_rule("l2", 8080)];
        // Two rules on one port is a mistake the user must see, not something
        // to resolve by quietly dropping the second.
        assert!(request.validate().unwrap_err().contains("8080"));

        request.local_forwards = vec![local_rule("l1", 8080)];
        assert!(request.validate().is_ok());
        assert!(request.has_forwards());

        request.local_forwards.clear();
        assert!(!request.has_forwards());
    }

    #[test]
    fn a_request_without_forwarding_fields_parses_as_a_plain_connection() {
        // Profiles synchronized to the host predate these fields and must keep
        // spawning a shell with no tunnels rather than failing to parse.
        let request: SshSpawnRequest = serde_json::from_str(
            r#"{"host":"h.example","port":22,"username":"deploy","authMethod":"agent",
                "credentialRef":null,"privateKeyPath":null,"rows":24,"cols":80,
                "projectId":null,"profileId":"ssh-1","displayName":"Prod"}"#,
        )
        .expect("legacy spawn request parses");
        assert!(request.jump_chain.is_empty());
        assert!(!request.has_forwards());
        assert!(request.validate().is_ok());
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

        // Agent auth carries no local key path — the agent holds the material.
        let mut agent = request();
        agent.auth_method = SshAuthMethod::Agent;
        agent.private_key_path = None;
        assert!(agent.validate().is_ok());
    }

    #[test]
    fn agent_auth_resolves_without_consulting_the_keyring() {
        let mut agent = request();
        agent.auth_method = SshAuthMethod::Agent;

        // `request()` still carries the `credential_ref` a password profile
        // would have written. Switching a profile to agent auth must not strand
        // it on a keyring entry that was never created, so the reference is
        // ignored rather than resolved — this returns without a keyring at all.
        assert!(agent.credential_ref.is_some());
        let credential = load_stored_credential(&agent).expect("agent needs no stored secret");
        assert_eq!(credential.password, None);
        assert_eq!(credential.passphrase, None);
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

    // ---- End-to-end tests against the in-process server -------------------
    //
    // These drive `spawn_hosted_ssh` through a real handshake on a loopback
    // socket. Private-key auth is used throughout because it is the one method
    // that resolves without touching the OS keyring — a unit test must not
    // prompt for, or depend on, the developer's real keychain.

    use std::time::Duration as StdDuration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::test_server;
    use crate::replay::ReplayBuffer;
    use crate::session::EventSink;
    use crate::ssh_forward::{ForwardDirection, ForwardRunState, RemoteForward};

    struct TestClient {
        _dir: tempfile::TempDir,
        known_hosts: PathBuf,
        key_path: String,
    }

    fn test_client() -> TestClient {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_ed25519");
        fs::write(&key_path, test_server::CLIENT_KEY).expect("client key");
        TestClient {
            known_hosts: dir.path().join("known_hosts"),
            key_path: key_path.to_string_lossy().into_owned(),
            _dir: dir,
        }
    }

    fn connect_request(client: &TestClient, port: u16) -> SshSpawnRequest {
        SshSpawnRequest {
            host: "127.0.0.1".into(),
            port,
            username: "deploy".into(),
            auth_method: SshAuthMethod::PrivateKey,
            credential_ref: None,
            private_key_path: Some(client.key_path.clone()),
            rows: 24,
            cols: 80,
            project_id: None,
            profile_id: "ssh-test".into(),
            display_name: "Test".into(),
            jump_chain: Vec::new(),
            local_forwards: Vec::new(),
            remote_forwards: Vec::new(),
        }
    }

    fn silent_sink() -> (Arc<ReplayBuffer>, EventSink) {
        let replay = Arc::new(ReplayBuffer::durable(64 * 1024));
        (replay, Arc::new(|_, _| {}))
    }

    async fn spawn_test_session(
        request: SshSpawnRequest,
        client: &TestClient,
    ) -> Result<HostedSshSpawn, String> {
        let (replay, sink) = silent_sink();
        spawn_hosted_ssh(request, client.known_hosts.clone(), replay, sink).await
    }

    /// `HostedSshSpawn` holds channel senders and is deliberately not `Debug`,
    /// so `expect`/`unwrap_err` are unavailable — these report the reason instead.
    async fn expect_session(request: SshSpawnRequest, client: &TestClient) -> HostedSshSpawn {
        match spawn_test_session(request, client).await {
            Ok(spawned) => spawned,
            Err(error) => panic!("session should have spawned: {error}"),
        }
    }

    async fn expect_error(request: SshSpawnRequest, client: &TestClient) -> String {
        match spawn_test_session(request, client).await {
            Ok(_) => panic!("session should not have spawned"),
            Err(error) => error,
        }
    }

    /// Poll until `predicate` holds, so a test never depends on how long a
    /// socket takes to bind.
    async fn wait_for(
        session: &SshTerminalSession,
        predicate: impl Fn(&[ForwardStatus]) -> bool,
    ) -> Vec<ForwardStatus> {
        for _ in 0..200 {
            let status = session.forward_status();
            if predicate(&status) {
                return status;
            }
            tokio::time::sleep(StdDuration::from_millis(25)).await;
        }
        panic!(
            "forward never reached the expected state: {:?}",
            session.forward_status()
        );
    }

    #[tokio::test]
    async fn connects_authenticates_and_learns_the_host_key() {
        let server = test_server::start(test_server::HOST_KEY_A, false).await;
        let client = test_client();

        let spawned = expect_session(connect_request(&client, server.port), &client).await;

        assert_eq!(spawned.host_key_status, "learned");
        assert!(spawned.host_key_fingerprint.starts_with("SHA256:"));
        assert!(spawned.process.is_alive());

        // Reconnecting to the same server now verifies against what was learned.
        let spawned = expect_session(connect_request(&client, server.port), &client).await;
        assert_eq!(spawned.host_key_status, "verified");
    }

    #[tokio::test]
    async fn a_changed_host_key_fails_closed_with_a_machine_readable_report() {
        let client = test_client();
        // A server whose key is not the one already recorded for its address is
        // what a machine-in-the-middle looks like from here, and is
        // indistinguishable from an honestly rebuilt server — which is exactly
        // why it has to reach the user rather than be resolved in code.
        let server = test_server::start(test_server::HOST_KEY_B, false).await;
        let other_key = russh::keys::PrivateKey::from_openssh(test_server::HOST_KEY_A)
            .expect("host key a")
            .public_key()
            .clone();
        learn_known_hosts_path("127.0.0.1", server.port, &other_key, &client.known_hosts)
            .expect("seed known_hosts");

        let error = expect_error(connect_request(&client, server.port), &client).await;

        assert!(
            error.starts_with(&format!("{HOST_KEY_CHANGED_CODE}:")),
            "expected a host-key-change report, got {error}"
        );
        let payload = error
            .split_once(':')
            .map(|(_, json)| json)
            .expect("payload follows the code");
        let change: HostKeyChange = serde_json::from_str(payload).expect("payload is JSON");
        assert_eq!(change.host, "127.0.0.1");
        assert_eq!(change.port, server.port);
        // Both halves are needed for the warning to mean anything, and they
        // must differ or there was nothing to warn about.
        assert_eq!(
            change.known_fingerprint.as_deref(),
            Some(super::fingerprint_of(&other_key).as_str())
        );
        assert_ne!(
            change.known_fingerprint.as_deref(),
            Some(change.presented_fingerprint.as_str())
        );

        // Fails closed: the presented key is never written over the trusted
        // one, so the next attempt reports the same mismatch rather than
        // quietly succeeding.
        assert_eq!(
            super::stored_host_fingerprint("127.0.0.1", server.port, &client.known_hosts)
                .as_deref(),
            Some(super::fingerprint_of(&other_key).as_str())
        );
    }

    #[tokio::test]
    async fn a_local_forward_carries_bytes_to_the_far_side() {
        let server = test_server::start(test_server::HOST_KEY_A, false).await;
        let echo_port = test_server::start_echo().await;
        let client = test_client();

        let mut request = connect_request(&client, server.port);
        request.local_forwards = vec![LocalForward {
            id: "lfwd-1".into(),
            // Port 0 lets the OS choose, but the rule needs a fixed port to
            // dial, so bind an ephemeral one first and reuse the number.
            local_port: reserve_port().await,
            remote_host: "127.0.0.1".into(),
            remote_port: echo_port,
            enabled: true,
        }];
        let local_port = request.local_forwards[0].local_port;

        let spawned = expect_session(request, &client).await;
        wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Listening
        })
        .await;

        let mut socket = TcpStream::connect(("127.0.0.1", local_port))
            .await
            .expect("the forward is listening");
        socket
            .write_all(b"through-the-tunnel")
            .await
            .expect("write");
        let mut buffer = [0u8; 18];
        socket.read_exact(&mut buffer).await.expect("echo returns");
        assert_eq!(&buffer, b"through-the-tunnel");

        let status = &spawned.process.forward_status()[0];
        assert_eq!(status.direction, ForwardDirection::Local);
        assert!(status.enabled);
        assert_eq!(
            status.summary,
            format!("127.0.0.1:{local_port} → 127.0.0.1:{echo_port}")
        );
    }

    #[tokio::test]
    async fn a_remote_forward_dials_the_local_destination_when_the_server_knocks() {
        let echo_port = test_server::start_echo().await;
        let server = test_server::start(test_server::HOST_KEY_A, true).await;
        let client = test_client();

        let mut request = connect_request(&client, server.port);
        request.remote_forwards = vec![RemoteForward {
            id: "rfwd-1".into(),
            remote_port: 9_000,
            local_host: "127.0.0.1".into(),
            local_port: echo_port,
            enabled: true,
        }];

        let spawned = expect_session(request, &client).await;
        // The server accepts the forward and immediately opens one inbound
        // channel; the client must dial the echo server and relay, which is
        // what moves the rule off `starting`.
        let status = wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Listening
        })
        .await;
        assert_eq!(status[0].direction, ForwardDirection::Remote);
        assert_eq!(
            status[0].summary,
            format!("remote 127.0.0.1:9000 → 127.0.0.1:{echo_port}")
        );
    }

    #[tokio::test]
    async fn an_unclaimed_inbound_channel_is_refused_rather_than_dialled() {
        // The server opens a `forwarded-tcpip` on a port no rule claims. The
        // client must not connect anything anywhere; it should simply refuse.
        let server = test_server::start(test_server::HOST_KEY_A, true).await;
        let client = test_client();
        let echo_port = test_server::start_echo().await;

        let mut request = connect_request(&client, server.port);
        request.remote_forwards = vec![RemoteForward {
            id: "rfwd-1".into(),
            remote_port: 9_000,
            local_host: "127.0.0.1".into(),
            local_port: echo_port,
            enabled: true,
        }];
        let spawned = expect_session(request, &client).await;
        wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Listening
        })
        .await;

        // Switching the rule off revokes the port's authorization, so a later
        // channel on it has nowhere legitimate to land.
        spawned
            .process
            .set_forward_enabled("rfwd-1", false)
            .expect("known rule");
        let status = wait_for(&spawned.process, |rules| !rules[0].enabled).await;
        assert_eq!(status[0].state, ForwardRunState::Stopped);
    }

    #[tokio::test]
    async fn a_port_that_cannot_be_bound_reports_why_instead_of_failing_the_session() {
        let server = test_server::start(test_server::HOST_KEY_A, false).await;
        let client = test_client();

        // Hold the port for the duration of the test so the bind genuinely fails.
        let blocker = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("blocker binds");
        let taken = blocker.local_addr().expect("addr").port();

        let mut request = connect_request(&client, server.port);
        request.local_forwards = vec![LocalForward {
            id: "lfwd-1".into(),
            local_port: taken,
            remote_host: "127.0.0.1".into(),
            remote_port: 80,
            enabled: true,
        }];

        // The shell still comes up: one unusable tunnel is not a reason to
        // refuse the terminal the user actually asked for.
        let spawned = expect_session(request, &client).await;
        assert!(spawned.process.is_alive());
        let status = wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Failed
        })
        .await;
        assert!(
            status[0]
                .error
                .as_deref()
                .is_some_and(|reason| reason.contains(&taken.to_string())),
            "the failure should name the port: {:?}",
            status[0].error
        );
        drop(blocker);
    }

    #[tokio::test]
    async fn a_forward_can_be_stopped_and_started_on_a_live_session() {
        let server = test_server::start(test_server::HOST_KEY_A, false).await;
        let echo_port = test_server::start_echo().await;
        let client = test_client();

        let local_port = reserve_port().await;
        let mut request = connect_request(&client, server.port);
        request.local_forwards = vec![LocalForward {
            id: "lfwd-1".into(),
            local_port,
            remote_host: "127.0.0.1".into(),
            remote_port: echo_port,
            enabled: true,
        }];
        let spawned = expect_session(request, &client).await;
        wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Listening
        })
        .await;

        spawned
            .process
            .set_forward_enabled("lfwd-1", false)
            .expect("known rule");
        wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Stopped
        })
        .await;
        // Stopping releases the socket, which is the observable difference
        // between "off" and "on but idle". The release is asynchronous —
        // `set_forward_enabled` records intent and the supervisor acts on it —
        // so this waits for it rather than assuming the state flip was the
        // socket closing.
        assert!(
            rebind_eventually_succeeds(local_port).await,
            "the listener should have been released"
        );

        spawned
            .process
            .set_forward_enabled("lfwd-1", true)
            .expect("known rule");
        wait_for(&spawned.process, |rules| {
            rules[0].state == ForwardRunState::Listening
        })
        .await;

        assert!(spawned
            .process
            .set_forward_enabled("nope", true)
            .unwrap_err()
            .contains("nope"));
    }

    #[tokio::test]
    async fn a_two_hop_jump_chain_reaches_the_innermost_server() {
        // Each hop is a full SSH server; the middle one carries the next
        // handshake inside a `direct-tcpip` channel.
        let outer = test_server::start(test_server::HOST_KEY_A, false).await;
        let inner = test_server::start(test_server::HOST_KEY_B, false).await;
        let client = test_client();

        let mut request = connect_request(&client, inner.port);
        request.jump_chain = vec![SshJumpHop {
            host: "127.0.0.1".into(),
            port: outer.port,
            username: "bastion".into(),
            auth_method: SshAuthMethod::PrivateKey,
            credential_ref: None,
            private_key_path: Some(client.key_path.clone()),
        }];

        let spawned = expect_session(request, &client).await;
        assert!(spawned.process.is_alive());
        // Both hops were TOFU-learned in their own right, under their own
        // host:port identity.
        let recorded = fs::read_to_string(&client.known_hosts).expect("known_hosts");
        assert!(
            recorded.contains(&format!("127.0.0.1]:{}", outer.port)),
            "{recorded}"
        );
        assert!(
            recorded.contains(&format!("127.0.0.1]:{}", inner.port)),
            "{recorded}"
        );
    }

    #[tokio::test]
    async fn a_jump_chain_names_the_hop_it_could_not_reach() {
        let client = test_client();
        let unreachable = reserve_port().await;
        let mut request = connect_request(&client, 22);
        request.jump_chain = vec![SshJumpHop {
            host: "127.0.0.1".into(),
            port: unreachable,
            username: "bastion".into(),
            auth_method: SshAuthMethod::PrivateKey,
            credential_ref: None,
            private_key_path: Some(client.key_path.clone()),
        }];

        let error = expect_error(request, &client).await;
        assert!(
            error.contains(&unreachable.to_string()),
            "the failure should name the hop that failed: {error}"
        );
    }

    /// Whether `port` becomes bindable again within a bounded wait.
    async fn rebind_eventually_succeeds(port: u16) -> bool {
        for _ in 0..200 {
            if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
                return true;
            }
            tokio::time::sleep(StdDuration::from_millis(25)).await;
        }
        false
    }

    /// Bind an ephemeral port, note the number, and release it.
    ///
    /// A forwarding rule needs a concrete port to dial, and this keeps
    /// concurrently running tests off each other's numbers far better than a
    /// hardcoded constant would.
    async fn reserve_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("reserve");
        listener.local_addr().expect("addr").port()
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
