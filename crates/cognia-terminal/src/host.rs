//! Durable, transport-neutral terminal session ownership.
//!
//! `TerminalHost` is intentionally independent of Tauri, WebSocket, and
//! WebRTC. Adapters authenticate a client, open a bounded host connection,
//! and translate [`HostEvent`] values to the shared terminal protocol. PTY reader
//! threads never wait for a viewer: a full attachment queue is disconnected
//! and can resume from the bounded replay ring later.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::osc633::IntegrationEvent;
use crate::protocol::TerminalErrorCode;
use crate::replay::{ReplayBounds, ReplayBuffer, ReplayGap};
use crate::session::{
    detached_desk_channel, spawn_session_with_identity, EventSink, PathInjection, PtySession,
    SessionOrigin, SpawnRequest, TerminalEvent,
};
use crate::ssh::{spawn_hosted_ssh, SshSpawnRequest};
use crate::ssh_forward::ForwardStatus;

pub const DEFAULT_MAX_SESSIONS: usize = 32;
pub const DEFAULT_MAX_REMOTE_SESSIONS_PER_DEVICE: usize = 8;
pub const DEFAULT_REPLAY_BYTES_PER_SESSION: usize = 8 * 1024 * 1024;
pub const DEFAULT_TOTAL_REPLAY_BYTES: usize = 128 * 1024 * 1024;
pub const DEFAULT_CONTROLLER_GRACE_MS: u64 = 10_000;
pub const RECENT_COMMAND_LIMIT: usize = 50;
const DEFAULT_ATTACHMENT_QUEUE: usize = 256;
const AUDIT_EVENT_LIMIT: usize = 10_000;
const AUDIT_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostConfig {
    pub max_sessions: usize,
    pub max_remote_sessions_per_device: usize,
    pub replay_bytes_per_session: usize,
    pub total_replay_bytes: usize,
    pub controller_grace_ms: u64,
}

impl Default for TerminalHostConfig {
    fn default() -> Self {
        Self {
            max_sessions: DEFAULT_MAX_SESSIONS,
            max_remote_sessions_per_device: DEFAULT_MAX_REMOTE_SESSIONS_PER_DEVICE,
            replay_bytes_per_session: DEFAULT_REPLAY_BYTES_PER_SESSION,
            total_replay_bytes: DEFAULT_TOTAL_REPLAY_BYTES,
            controller_grace_ms: DEFAULT_CONTROLLER_GRACE_MS,
        }
    }
}

impl TerminalHostConfig {
    pub fn validate(&self) -> Result<(), HostError> {
        if self.max_sessions == 0 || self.max_sessions > 256 {
            return Err(HostError::InvalidRequest(
                "maxSessions must be between 1 and 256".into(),
            ));
        }
        if self.max_remote_sessions_per_device == 0
            || self.max_remote_sessions_per_device > self.max_sessions
        {
            return Err(HostError::InvalidRequest(
                "maxRemoteSessionsPerDevice must be between 1 and maxSessions".into(),
            ));
        }
        if !(64 * 1024..=64 * 1024 * 1024).contains(&self.replay_bytes_per_session) {
            return Err(HostError::InvalidRequest(
                "replayBytesPerSession must be between 64 KiB and 64 MiB".into(),
            ));
        }
        if self.total_replay_bytes < self.replay_bytes_per_session
            || self.total_replay_bytes > 1024 * 1024 * 1024
        {
            return Err(HostError::InvalidRequest(
                "totalReplayBytes must be at least one session budget and at most 1 GiB".into(),
            ));
        }
        if !(1_000..=60_000).contains(&self.controller_grace_ms) {
            return Err(HostError::InvalidRequest(
                "controllerGraceMs must be between 1000 and 60000".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIdentity {
    pub client_id: String,
    pub device_id: Option<String>,
    pub local: bool,
    pub allow_remote_terminal: bool,
}

impl ClientIdentity {
    pub fn local(client_id: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            device_id: None,
            local: true,
            allow_remote_terminal: true,
        }
    }

    pub fn remote(
        client_id: impl Into<String>,
        device_id: impl Into<String>,
        allow_remote_terminal: bool,
    ) -> Self {
        Self {
            client_id: client_id.into(),
            device_id: Some(device_id.into()),
            local: false,
            allow_remote_terminal,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    LocalPty,
    Ssh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationCapabilities {
    pub osc633: bool,
    pub command_status: bool,
    pub cwd_tracking: bool,
    pub degraded_reason: Option<String>,
}

impl IntegrationCapabilities {
    pub fn local_pty(enabled: bool) -> Self {
        Self {
            osc633: enabled,
            command_status: enabled,
            cwd_tracking: enabled,
            degraded_reason: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostReplayBounds {
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub retained_bytes: usize,
    pub truncated: bool,
}

impl From<ReplayBounds> for HostReplayBounds {
    fn from(value: ReplayBounds) -> Self {
        Self {
            first_sequence: value.first_seq,
            last_sequence: value.last_seq,
            retained_bytes: value.retained_bytes,
            truncated: value.truncated,
        }
    }
}

/// One attached client of a session, as seen by every other attachment — the
/// roster behind terminal session sharing (ADR-0131). `role` mirrors the
/// controller lease: exactly one attachment may be `controller`; the rest are
/// read-only `viewer`s (the host enforces this via `NotController`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionParticipant {
    pub client_id: String,
    /// Paired device id for remote clients (`companion:<deviceId>`); `None` for
    /// the local desktop.
    pub device_id: Option<String>,
    pub local: bool,
    pub role: ParticipantRole,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantRole {
    Controller,
    Viewer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostSessionInfo {
    pub id: String,
    pub host_id: String,
    pub kind: SessionKind,
    pub profile_id: String,
    pub project_id: Option<String>,
    pub extension_id: Option<String>,
    pub origin: SessionOrigin,
    pub shell: String,
    pub created_at: u64,
    pub last_activity_at: u64,
    pub current_controller: Option<String>,
    pub attached_clients: usize,
    /// Every attached client with its lease role. Additive: older clients
    /// ignore it, newer ones render the participant list from it.
    #[serde(default)]
    pub participants: Vec<SessionParticipant>,
    pub alive: bool,
    pub sandboxed: bool,
    pub integration_capabilities: IntegrationCapabilities,
    pub replay: HostReplayBounds,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host_key_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostEvent {
    SessionSnapshot {
        session: HostSessionInfo,
    },
    Output {
        session_id: String,
        sequence: u64,
        bytes: Vec<u8>,
    },
    Integration {
        session_id: String,
        sequence: u64,
        event: IntegrationEvent,
    },
    ControllerChanged {
        session_id: String,
        controller: Option<String>,
    },

    ReplayGap {
        session_id: String,
        requested_after: u64,
        first_available: u64,
        last_available: u64,
    },
    Exit {
        session_id: String,
        sequence: u64,
        code: Option<u32>,
    },
    Error {
        code: TerminalErrorCode,
        message: String,
        session_id: Option<String>,
    },
    /// Transport health for one session. Currently reports flow-control
    /// transitions so *other* attached clients learn why output stalled
    /// instead of assuming the session hung.
    TransportState {
        session_id: String,
        state: HostTransportState,
        message: Option<String>,
    },
}

/// Coarse transport health, carried by [`HostEvent::TransportState`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HostTransportState {
    Online,
    FlowPaused,
    Reconnecting,
    Offline,
}

/// How long a flow pause may stand before the host releases it on its own.
///
/// The backstop for "connected but wedged" — a backgrounded phone, a hung JS
/// main thread. Without it a client that pauses and then stops running would
/// park someone's PTY indefinitely.
pub const FLOW_PAUSE_MAX: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuditKind {
    SessionSpawned,
    SessionAttached,
    SessionDetached,
    SessionTerminated,
    SessionExited,
    ControllerTaken { previous: Option<String> },
    ControllerReleased,
    DeviceRevoked,
    AttachmentOverflow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostAuditEvent {
    pub timestamp: u64,
    pub session_id: String,
    pub client_id: Option<String>,
    pub device_id: Option<String>,
    pub event: AuditKind,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HostError {
    #[error("client is not the terminal controller")]
    NotController,
    #[error("remote terminal permission denied")]
    PermissionDenied,
    #[error(
        "terminal replay gap: requested after {requested_after}, first available {first_available}"
    )]
    ReplayGap {
        requested_after: u64,
        first_available: u64,
        last_available: u64,
    },
    #[error("terminal resource limit reached: {0}")]
    ResourceLimit(String),
    #[error("terminal session not found")]
    SessionNotFound,
    #[error("terminal client connection not found")]
    ConnectionNotFound,
    #[error("invalid terminal request: {0}")]
    InvalidRequest(String),
    #[error("terminal process error: {0}")]
    Process(String),
}

impl HostError {
    pub fn code(&self) -> TerminalErrorCode {
        match self {
            Self::NotController => TerminalErrorCode::NotController,
            Self::PermissionDenied => TerminalErrorCode::PermissionDenied,
            Self::ReplayGap { .. } => TerminalErrorCode::ReplayGap,
            Self::ResourceLimit(_) => TerminalErrorCode::ResourceLimit,
            Self::SessionNotFound => TerminalErrorCode::SessionNotFound,
            Self::ConnectionNotFound | Self::InvalidRequest(_) | Self::Process(_) => {
                TerminalErrorCode::InvalidRequest
            }
        }
    }
}

pub trait HostedTerminalProcess: Send + Sync {
    fn write(&self, bytes: &[u8]) -> Result<(), String>;
    fn resize(&self, rows: u16, cols: u16) -> Result<(), String>;
    fn kill(&self) -> Result<(), String>;
    fn is_alive(&self) -> bool;
    fn replay(&self) -> Arc<ReplayBuffer>;
    /// Park or resume the producer. Implementations that cannot actually stop
    /// their source say so by returning `Err`, which the host surfaces rather
    /// than pretending the pause took.
    fn set_flow_paused(&self, paused: bool) -> Result<(), String>;

    /// Live state of this session's SSH port forwards.
    ///
    /// Empty for anything that cannot forward — a local PTY has no tunnels, and
    /// an SSH session configured without rules has none either, which is the
    /// same answer from the caller's point of view.
    fn forward_status(&self) -> Vec<ForwardStatus> {
        Vec::new()
    }

    /// Start or stop one forward on a running session.
    fn set_forward_enabled(&self, _id: &str, _enabled: bool) -> Result<(), String> {
        Err("this session does not support port forwarding".into())
    }
}

impl HostedTerminalProcess for PtySession {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        self.write(bytes).map_err(|error| error.to_string())
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        self.resize(rows, cols).map_err(|error| error.to_string())
    }

    fn kill(&self) -> Result<(), String> {
        self.kill().map_err(|error| error.to_string())
    }

    fn set_flow_paused(&self, paused: bool) -> Result<(), String> {
        PtySession::set_flow_paused(self, paused);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.is_alive()
    }

    fn replay(&self) -> Arc<ReplayBuffer> {
        self.replay()
    }
}

struct ClientRecord {
    identity: ClientIdentity,
    sender: mpsc::Sender<HostEvent>,
}

struct ControllerLease {
    connection_id: Uuid,
    client_id: String,
    disconnected_at: Option<Instant>,
}

struct HostedSession {
    process: Arc<dyn HostedTerminalProcess>,
    kind: SessionKind,
    profile_id: String,
    project_id: Option<String>,
    extension_id: Option<String>,
    shell: String,
    created_at: u64,
    last_activity_at: u64,
    created_by_device: Option<String>,
    sandboxed: bool,
    capabilities: IntegrationCapabilities,
    ssh_host_key_status: Option<String>,
    ssh_host_key_fingerprint: Option<String>,
    attachments: HashSet<Uuid>,
    controller: Option<ControllerLease>,
    recent_commands: VecDeque<String>,
    capture: CommandCapture,
    /// Connections currently asking for this session to be paused, and when
    /// they asked. Slowest-consumer-wins: the PTY stays parked while ANY
    /// attachment has an outstanding pause. The timestamps back
    /// [`TerminalHost::reap_flow_pauses`], the backstop against a client that
    /// paused and then died without detaching.
    flow_paused_by: HashMap<Uuid, Instant>,
}

#[derive(Default)]
struct CommandCapture {
    line: Vec<u8>,
}

impl CommandCapture {
    fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut commands = Vec::new();
        for &byte in bytes {
            match byte {
                b'\r' | b'\n' => {
                    let command = String::from_utf8_lossy(&self.line).trim().to_string();
                    self.line.clear();
                    if !command.is_empty() {
                        commands.push(command);
                    }
                }
                0x08 | 0x7f => {
                    self.line.pop();
                }
                0x15 => self.line.clear(),
                0x20..=0x7e | 0x80..=0xff => {
                    if self.line.len() < 64 * 1024 {
                        self.line.push(byte);
                    }
                }
                _ => {}
            }
        }
        commands
    }
}

struct HostState {
    clients: HashMap<Uuid, ClientRecord>,
    sessions: HashMap<String, HostedSession>,
    profiles: HashMap<String, SpawnRequest>,
    ssh_profiles: HashMap<String, SshSpawnRequest>,
    audit: VecDeque<HostAuditEvent>,
}

struct TerminalHostInner {
    host_id: String,
    config: Mutex<TerminalHostConfig>,
    /// PATH woven into every local PTY this host spawns.
    ///
    /// Host-owned rather than connection-owned on purpose. Remote spawns
    /// (Companion WebSocket, WebRTC) arrive on connections that never send a
    /// `pathInjection` hello, so per-connection state would leave exactly the
    /// transports the durable host exists to serve with an empty PATH. Sessions
    /// belong to the host, so their PATH does too. Only a *local* client may
    /// write it; see [`TerminalHost::set_path_injection`].
    path: Mutex<PathInjection>,
    attachment_queue: usize,
    state: Mutex<HostState>,
}

#[derive(Clone)]
pub struct TerminalHost {
    inner: Arc<TerminalHostInner>,
}

pub struct HostClient {
    pub connection_id: String,
    pub events: mpsc::Receiver<HostEvent>,
    host: Weak<TerminalHostInner>,
    id: Uuid,
}

impl Drop for HostClient {
    fn drop(&mut self) {
        if let Some(host) = self.host.upgrade() {
            disconnect_inner(&host, self.id, Instant::now());
        }
    }
}

impl TerminalHost {
    pub fn new(host_id: impl Into<String>, config: TerminalHostConfig) -> Result<Self, HostError> {
        Self::with_path_injection(host_id, config, PathInjection::default())
    }

    /// Same as [`TerminalHost::new`] but seeds the PATH injection the host
    /// applies before any client has said hello. The service uses this so a
    /// start-at-login host serving a paired phone still resolves the bundled
    /// CLI, even when the desktop app has never run.
    pub fn with_path_injection(
        host_id: impl Into<String>,
        config: TerminalHostConfig,
        path: PathInjection,
    ) -> Result<Self, HostError> {
        config.validate()?;
        Ok(Self::with_attachment_queue(
            host_id,
            config,
            path,
            DEFAULT_ATTACHMENT_QUEUE,
        ))
    }

    fn with_attachment_queue(
        host_id: impl Into<String>,
        config: TerminalHostConfig,
        path: PathInjection,
        attachment_queue: usize,
    ) -> Self {
        Self {
            inner: Arc::new(TerminalHostInner {
                host_id: host_id.into(),
                config: Mutex::new(config),
                path: Mutex::new(path),
                attachment_queue: attachment_queue.max(1),
                state: Mutex::new(HostState {
                    clients: HashMap::new(),
                    sessions: HashMap::new(),
                    profiles: HashMap::new(),
                    ssh_profiles: HashMap::new(),
                    audit: VecDeque::new(),
                }),
            }),
        }
    }

    pub fn host_id(&self) -> &str {
        &self.inner.host_id
    }

    pub fn update_config(
        &self,
        connection_id: &str,
        config: TerminalHostConfig,
    ) -> Result<(), HostError> {
        config.validate()?;
        let connection = parse_connection_id(connection_id)?;
        if !self.identity(connection)?.local {
            return Err(HostError::PermissionDenied);
        }
        *self.inner.config.lock() = config;
        enforce_global_replay_budget(&self.inner);
        Ok(())
    }

    /// Replace the PATH woven into subsequently spawned local PTYs.
    ///
    /// Local clients only: the directories come from the desktop app's managed
    /// CLI registry, and letting a paired phone rewrite the host's PATH would
    /// let it decide which binaries the desktop user's shells resolve.
    ///
    /// Already-running shells keep their old PATH — a PTY's environment is
    /// fixed at `execve` and rewriting it would mean injecting `export PATH=`
    /// into the user's live shell.
    pub fn set_path_injection(
        &self,
        connection_id: &str,
        path: PathInjection,
    ) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        if !self.identity(connection)?.local {
            return Err(HostError::PermissionDenied);
        }
        *self.inner.path.lock() = path;
        Ok(())
    }

    /// The PATH injection currently applied to new local PTYs.
    pub fn path_injection(&self) -> PathInjection {
        self.inner.path.lock().clone()
    }

    pub fn connect(&self, identity: ClientIdentity) -> Result<HostClient, HostError> {
        if !identity.local && !identity.allow_remote_terminal {
            return Err(HostError::PermissionDenied);
        }
        if identity.client_id.trim().is_empty()
            || (!identity.local && identity.device_id.as_deref().unwrap_or("").is_empty())
        {
            return Err(HostError::InvalidRequest(
                "client and remote device identifiers are required".into(),
            ));
        }
        let id = Uuid::new_v4();
        let (sender, events) = mpsc::channel(self.inner.attachment_queue);
        self.inner
            .state
            .lock()
            .clients
            .insert(id, ClientRecord { identity, sender });
        Ok(HostClient {
            connection_id: id.to_string(),
            events,
            host: Arc::downgrade(&self.inner),
            id,
        })
    }

    pub fn spawn_local(
        &self,
        connection_id: &str,
        profile_id: String,
        request: SpawnRequest,
        script_dir: &Path,
    ) -> Result<HostSessionInfo, HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        if !identity.local {
            return Err(HostError::PermissionDenied);
        }
        if profile_id.trim().is_empty() {
            return Err(HostError::InvalidRequest("profileId is required".into()));
        }
        self.sync_profile(connection_id, profile_id.clone(), request.clone())?;
        self.spawn_request(connection, identity, profile_id, request, script_dir)
    }

    pub fn sync_profile(
        &self,
        connection_id: &str,
        profile_id: String,
        request: SpawnRequest,
    ) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        if !identity.local {
            return Err(HostError::PermissionDenied);
        }
        if profile_id.trim().is_empty() {
            return Err(HostError::InvalidRequest("profileId is required".into()));
        }
        self.inner.state.lock().profiles.insert(profile_id, request);
        Ok(())
    }

    pub fn sync_ssh_profile(
        &self,
        connection_id: &str,
        profile_id: String,
        request: SshSpawnRequest,
    ) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        if !identity.local {
            return Err(HostError::PermissionDenied);
        }
        request.validate().map_err(HostError::InvalidRequest)?;
        if profile_id.trim().is_empty() || request.profile_id != profile_id {
            return Err(HostError::InvalidRequest(
                "SSH profile identifier does not match its request".into(),
            ));
        }
        let mut state = self.inner.state.lock();
        if state.profiles.contains_key(&profile_id) {
            return Err(HostError::InvalidRequest(
                "terminal and SSH profile identifiers must be unique".into(),
            ));
        }
        state.ssh_profiles.insert(profile_id, request);
        Ok(())
    }

    pub fn replace_synchronized_profiles(
        &self,
        connection_id: &str,
        local_profiles: HashMap<String, SpawnRequest>,
        ssh_profiles: HashMap<String, SshSpawnRequest>,
    ) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        if !identity.local {
            return Err(HostError::PermissionDenied);
        }
        if local_profiles
            .keys()
            .chain(ssh_profiles.keys())
            .any(|profile_id| profile_id.trim().is_empty())
        {
            return Err(HostError::InvalidRequest("profileId is required".into()));
        }
        if ssh_profiles
            .keys()
            .any(|profile_id| local_profiles.contains_key(profile_id))
        {
            return Err(HostError::InvalidRequest(
                "terminal and SSH profile identifiers must be unique".into(),
            ));
        }
        for (profile_id, request) in &ssh_profiles {
            request.validate().map_err(HostError::InvalidRequest)?;
            if request.profile_id != *profile_id {
                return Err(HostError::InvalidRequest(
                    "SSH profile identifier does not match its request".into(),
                ));
            }
        }
        let mut state = self.inner.state.lock();
        state.profiles = local_profiles;
        state.ssh_profiles = ssh_profiles;
        Ok(())
    }

    /// Spawn a host-synchronized local PTY or SSH profile. Remote callers can
    /// only select the stable identifier; credentials and connection metadata
    /// remain inside the host process.
    pub async fn spawn_synchronized_profile(
        &self,
        connection_id: &str,
        profile_id: String,
        script_dir: &Path,
        known_hosts_path: &Path,
    ) -> Result<HostSessionInfo, HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        let ssh_request = self
            .inner
            .state
            .lock()
            .ssh_profiles
            .get(&profile_id)
            .cloned();
        let Some(mut request) = ssh_request else {
            return self.spawn_profile(connection_id, profile_id, script_dir);
        };
        self.check_spawn_limit(&identity)?;
        if !identity.local {
            request.project_id = None;
        }

        let session_id = Uuid::new_v4().to_string();
        let replay_bytes_per_session = self.inner.config.lock().replay_bytes_per_session;
        let replay = Arc::new(ReplayBuffer::durable(replay_bytes_per_session));
        let weak = Arc::downgrade(&self.inner);
        let callback_session_id = session_id.clone();
        let sink: EventSink = Arc::new(move |sequence, event| {
            if let Some(inner) = weak.upgrade() {
                publish_terminal_event(&inner, &callback_session_id, sequence, event);
            }
        });
        let hosted = spawn_hosted_ssh(
            request.clone(),
            known_hosts_path.to_path_buf(),
            replay,
            sink,
        )
        .await
        .map_err(HostError::Process)?;
        let process: Arc<dyn HostedTerminalProcess> = Arc::new(hosted.process);
        let result = self.register_process(
            connection,
            session_id,
            SessionKind::Ssh,
            profile_id,
            request.project_id,
            None,
            format!("ssh {}@{}", request.username, request.host),
            false,
            IntegrationCapabilities {
                osc633: hosted.integration_enabled,
                command_status: hosted.integration_enabled,
                cwd_tracking: hosted.integration_enabled,
                degraded_reason: hosted.integration_degraded_reason.clone(),
            },
            Some(hosted.host_key_status),
            Some(hosted.host_key_fingerprint),
            Arc::clone(&process),
        );
        if result.is_err() {
            let _ = process.kill();
        }
        result
    }

    /// Spawn from a profile already synchronized by a trusted local client.
    /// Remote callers provide only the stable profile identifier; shell,
    /// environment, cwd, sandbox, and integration settings are resolved here.
    pub fn spawn_profile(
        &self,
        connection_id: &str,
        profile_id: String,
        script_dir: &Path,
    ) -> Result<HostSessionInfo, HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        let mut request = self
            .inner
            .state
            .lock()
            .profiles
            .get(&profile_id)
            .cloned()
            .ok_or_else(|| HostError::InvalidRequest("unknown terminal profile".into()))?;
        if !identity.local {
            request.origin = SessionOrigin::Remote;
        }
        self.spawn_request(connection, identity, profile_id, request, script_dir)
    }

    fn spawn_request(
        &self,
        connection: Uuid,
        identity: ClientIdentity,
        profile_id: String,
        request: SpawnRequest,
        script_dir: &Path,
    ) -> Result<HostSessionInfo, HostError> {
        self.check_spawn_limit(&identity)?;

        // Clone the injection out and release the guard before the (blocking)
        // spawn below — never hold a parking_lot lock across process creation.
        let path = self.inner.path.lock().clone();
        let session_id = Uuid::new_v4().to_string();
        let replay_bytes_per_session = self.inner.config.lock().replay_bytes_per_session;
        let replay = Arc::new(ReplayBuffer::durable(replay_bytes_per_session));
        let weak = Arc::downgrade(&self.inner);
        let callback_session_id = session_id.clone();
        let sink: EventSink = Arc::new(move |sequence, event| {
            if let Some(inner) = weak.upgrade() {
                publish_terminal_event(&inner, &callback_session_id, sequence, event);
            }
        });
        let project_id = request.project_id.clone();
        let extension_id = request.extension_id.clone();
        let shell = request.shell.clone();
        let sandboxed = request.sandboxed;
        let capabilities = IntegrationCapabilities::local_pty(request.enable_shell_integration);
        let process = spawn_session_with_identity(
            request,
            script_dir,
            &path,
            session_id.clone(),
            replay,
            sink,
            detached_desk_channel(),
        )
        .map_err(HostError::Process)?;
        self.register_process(
            connection,
            session_id,
            SessionKind::LocalPty,
            profile_id,
            project_id,
            extension_id,
            shell,
            sandboxed,
            capabilities,
            None,
            None,
            Arc::new(process),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn register_process(
        &self,
        connection_id: Uuid,
        session_id: String,
        kind: SessionKind,
        profile_id: String,
        project_id: Option<String>,
        extension_id: Option<String>,
        shell: String,
        sandboxed: bool,
        capabilities: IntegrationCapabilities,
        ssh_host_key_status: Option<String>,
        ssh_host_key_fingerprint: Option<String>,
        process: Arc<dyn HostedTerminalProcess>,
    ) -> Result<HostSessionInfo, HostError> {
        let now = unix_millis();
        let mut state = self.inner.state.lock();
        let client = state
            .clients
            .get(&connection_id)
            .ok_or(HostError::ConnectionNotFound)?;
        let identity = client.identity.clone();
        let mut attachments = HashSet::new();
        attachments.insert(connection_id);
        state.sessions.insert(
            session_id.clone(),
            HostedSession {
                process,
                kind,
                profile_id,
                project_id,
                extension_id,
                shell,
                created_at: now,
                last_activity_at: now,
                created_by_device: identity.device_id.clone(),
                sandboxed,
                capabilities,
                ssh_host_key_status,
                ssh_host_key_fingerprint,
                attachments,
                controller: Some(ControllerLease {
                    connection_id,
                    client_id: identity.client_id.clone(),
                    disconnected_at: None,
                }),
                recent_commands: VecDeque::new(),
                capture: CommandCapture::default(),
                flow_paused_by: HashMap::new(),
            },
        );
        push_audit(
            &mut state,
            &session_id,
            Some(&identity),
            AuditKind::SessionSpawned,
        );
        let info = session_info(&self.inner, &state, &session_id)?;
        if let Some(sender) = state
            .clients
            .get(&connection_id)
            .map(|client| client.sender.clone())
        {
            let _ = sender.try_send(HostEvent::SessionSnapshot {
                session: info.clone(),
            });
        }
        Ok(info)
    }

    fn check_spawn_limit(&self, identity: &ClientIdentity) -> Result<(), HostError> {
        let state = self.inner.state.lock();
        let live = state
            .sessions
            .values()
            .filter(|session| session.process.is_alive())
            .count();
        let config = self.inner.config.lock().clone();
        if live >= config.max_sessions {
            return Err(HostError::ResourceLimit("host session limit".into()));
        }
        if let Some(device_id) = &identity.device_id {
            let remote_live = state
                .sessions
                .values()
                .filter(|session| {
                    session.process.is_alive()
                        && session.created_by_device.as_ref() == Some(device_id)
                })
                .count();
            if remote_live >= config.max_remote_sessions_per_device {
                return Err(HostError::ResourceLimit(
                    "remote device session limit".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn list(&self, connection_id: &str) -> Result<Vec<HostSessionInfo>, HostError> {
        let connection = parse_connection_id(connection_id)?;
        self.identity(connection)?;
        let state = self.inner.state.lock();
        let mut sessions = state
            .sessions
            .keys()
            .map(|id| session_info(&self.inner, &state, id))
            .collect::<Result<Vec<_>, _>>()?;
        sessions.sort_by_key(|session| session.created_at);
        Ok(sessions)
    }

    pub fn attach(
        &self,
        connection_id: &str,
        session_id: &str,
        resume_after: u64,
    ) -> Result<HostSessionInfo, HostError> {
        let connection = parse_connection_id(connection_id)?;
        let (sender, replay, identity, info) = {
            let mut state = self.inner.state.lock();
            let client = state
                .clients
                .get(&connection)
                .ok_or(HostError::ConnectionNotFound)?;
            let sender = client.sender.clone();
            let identity = client.identity.clone();
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or(HostError::SessionNotFound)?;
            session.attachments.insert(connection);
            if let Some(controller) = session.controller.as_mut() {
                if controller.client_id == identity.client_id
                    && controller.disconnected_at.is_some()
                {
                    controller.connection_id = connection;
                    controller.disconnected_at = None;
                }
            }
            let replay = session.process.replay();
            push_audit(
                &mut state,
                session_id,
                Some(&identity),
                AuditKind::SessionAttached,
            );
            let info = session_info(&self.inner, &state, session_id)?;
            (sender, replay, identity, info)
        };

        if let Err(gap) = replay.since_checked(resume_after) {
            let event = replay_gap_event(session_id, gap);
            if sender.try_send(event).is_err() {
                self.drop_overflowing_attachment(connection, session_id, &identity);
                return Err(HostError::ResourceLimit(
                    "attachment event queue overflow".into(),
                ));
            }
        }
        let replay_from = replay
            .bounds()
            .first_seq
            .saturating_sub(1)
            .max(resume_after);
        for (sequence, event) in replay.since(replay_from) {
            if sender
                .try_send(host_event(session_id, sequence, event))
                .is_err()
            {
                self.drop_overflowing_attachment(connection, session_id, &identity);
                return Err(HostError::ResourceLimit(
                    "attachment event queue overflow".into(),
                ));
            }
        }
        let _ = sender.try_send(HostEvent::SessionSnapshot {
            session: info.clone(),
        });
        // Every attachment (the new one included) learns the roster changed.
        broadcast_participants(&self.inner, session_id);
        Ok(info)
    }

    pub fn detach(&self, connection_id: &str, session_id: &str) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        let mut state = self.inner.state.lock();
        let identity = state
            .clients
            .get(&connection)
            .ok_or(HostError::ConnectionNotFound)?
            .identity
            .clone();
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or(HostError::SessionNotFound)?;
        session.attachments.remove(&connection);
        // A detaching client's pause must not outlive its attachment.
        let flow_release = release_flow_for(session, connection);
        let released = session
            .controller
            .as_ref()
            .is_some_and(|controller| controller.connection_id == connection);
        if released {
            session.controller = None;
        }
        push_audit(
            &mut state,
            session_id,
            Some(&identity),
            AuditKind::SessionDetached,
        );
        if released {
            push_audit(
                &mut state,
                session_id,
                Some(&identity),
                AuditKind::ControllerReleased,
            );
        }
        drop(state);
        if released {
            broadcast_controller(&self.inner, session_id, None);
        }
        broadcast_participants(&self.inner, session_id);
        if let Some(process) = flow_release {
            let _ = apply_flow_state(&self.inner, session_id, &process, false);
        }
        Ok(())
    }

    pub fn take_control(&self, connection_id: &str, session_id: &str) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        let mut state = self.inner.state.lock();
        let identity = state
            .clients
            .get(&connection)
            .ok_or(HostError::ConnectionNotFound)?
            .identity
            .clone();
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or(HostError::SessionNotFound)?;
        if !session.attachments.contains(&connection) {
            return Err(HostError::PermissionDenied);
        }
        let previous = session
            .controller
            .replace(ControllerLease {
                connection_id: connection,
                client_id: identity.client_id.clone(),
                disconnected_at: None,
            })
            .map(|controller| controller.client_id);
        push_audit(
            &mut state,
            session_id,
            Some(&identity),
            AuditKind::ControllerTaken { previous },
        );
        drop(state);
        broadcast_controller(&self.inner, session_id, Some(identity.client_id));
        broadcast_participants(&self.inner, session_id);
        Ok(())
    }

    pub fn release_control(&self, connection_id: &str, session_id: &str) -> Result<(), HostError> {
        self.require_controller(connection_id, session_id)?;
        let connection = parse_connection_id(connection_id)?;
        let mut state = self.inner.state.lock();
        let identity = state
            .clients
            .get(&connection)
            .map(|record| record.identity.clone());
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or(HostError::SessionNotFound)?;
        session.controller = None;
        push_audit(
            &mut state,
            session_id,
            identity.as_ref(),
            AuditKind::ControllerReleased,
        );
        drop(state);
        broadcast_controller(&self.inner, session_id, None);
        broadcast_participants(&self.inner, session_id);
        Ok(())
    }

    pub fn write(
        &self,
        connection_id: &str,
        session_id: &str,
        bytes: &[u8],
    ) -> Result<(), HostError> {
        self.require_controller(connection_id, session_id)?;
        let process = {
            let mut state = self.inner.state.lock();
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or(HostError::SessionNotFound)?;
            for command in session.capture.feed(bytes) {
                session.recent_commands.push_back(command);
                while session.recent_commands.len() > RECENT_COMMAND_LIMIT {
                    session.recent_commands.pop_front();
                }
            }
            session.last_activity_at = unix_millis();
            Arc::clone(&session.process)
        };
        process.write(bytes).map_err(HostError::Process)
    }

    pub fn resize(
        &self,
        connection_id: &str,
        session_id: &str,
        rows: u16,
        cols: u16,
    ) -> Result<(), HostError> {
        self.require_controller(connection_id, session_id)?;
        let process = self.process(session_id)?;
        process
            .resize(rows.max(1), cols.max(1))
            .map_err(HostError::Process)
    }

    pub fn kill(&self, connection_id: &str, session_id: &str) -> Result<(), HostError> {
        self.require_controller(connection_id, session_id)?;
        let connection = parse_connection_id(connection_id)?;
        let (process, identity) = {
            let state = self.inner.state.lock();
            let identity = state
                .clients
                .get(&connection)
                .ok_or(HostError::ConnectionNotFound)?
                .identity
                .clone();
            let process = Arc::clone(
                &state
                    .sessions
                    .get(session_id)
                    .ok_or(HostError::SessionNotFound)?
                    .process,
            );
            (process, identity)
        };
        {
            // Clear every claim and resume before signalling: a parked reader
            // would never see the child's final output nor reach EOF.
            let mut state = self.inner.state.lock();
            if let Some(session) = state.sessions.get_mut(session_id) {
                session.flow_paused_by.clear();
            }
        }
        let _ = process.set_flow_paused(false);
        process.kill().map_err(HostError::Process)?;
        let mut state = self.inner.state.lock();
        push_audit(
            &mut state,
            session_id,
            Some(&identity),
            AuditKind::SessionTerminated,
        );
        Ok(())
    }

    pub fn recent_commands(
        &self,
        connection_id: &str,
        session_id: &str,
    ) -> Result<Vec<String>, HostError> {
        let connection = parse_connection_id(connection_id)?;
        self.identity(connection)?;
        let state = self.inner.state.lock();
        Ok(state
            .sessions
            .get(session_id)
            .ok_or(HostError::SessionNotFound)?
            .recent_commands
            .iter()
            .cloned()
            .collect())
    }

    pub fn revoke_device(&self, device_id: &str) {
        let connections = {
            let state = self.inner.state.lock();
            state
                .clients
                .iter()
                .filter_map(|(id, client)| {
                    (client.identity.device_id.as_deref() == Some(device_id)).then_some(*id)
                })
                .collect::<Vec<_>>()
        };
        for connection in connections {
            disconnect_inner(&self.inner, connection, Instant::now());
        }
        let mut state = self.inner.state.lock();
        let session_ids = state.sessions.keys().cloned().collect::<Vec<_>>();
        for session_id in session_ids {
            push_audit(&mut state, &session_id, None, AuditKind::DeviceRevoked);
        }
    }

    pub fn reap_controller_leases(&self, now: Instant) {
        let grace = Duration::from_millis(self.inner.config.lock().controller_grace_ms);
        let mut released = Vec::new();
        let mut state = self.inner.state.lock();
        for (session_id, session) in &mut state.sessions {
            if session.controller.as_ref().is_some_and(|controller| {
                controller
                    .disconnected_at
                    .is_some_and(|at| now.saturating_duration_since(at) >= grace)
            }) {
                session.controller = None;
                released.push(session_id.clone());
            }
        }
        for session_id in &released {
            push_audit(&mut state, session_id, None, AuditKind::ControllerReleased);
        }
        drop(state);
        for session_id in released {
            broadcast_controller(&self.inner, &session_id, None);
        }
    }

    /// Ask the host to park (or release) a session's producer on this
    /// connection's behalf.
    ///
    /// Reference-counted, slowest-consumer-wins: the process stays parked while
    /// any attachment has an outstanding pause and resumes only when the last
    /// one clears. Deliberately NOT controller-gated — a viewer that cannot
    /// keep up is exactly who needs to pause, and a read-only client asking the
    /// producer to slow down cannot affect anyone's session contents.
    /// Live forwarding state for a session the caller is attached to.
    pub fn forward_status(
        &self,
        connection_id: &str,
        session_id: &str,
    ) -> Result<Vec<ForwardStatus>, HostError> {
        let connection = parse_connection_id(connection_id)?;
        self.identity(connection)?;
        let state = self.inner.state.lock();
        let session = state
            .sessions
            .get(session_id)
            .ok_or(HostError::SessionNotFound)?;
        if !session.attachments.contains(&connection) {
            return Err(HostError::PermissionDenied);
        }
        Ok(session.process.forward_status())
    }

    /// Start or stop one forward on a running session.
    ///
    /// Local-identity only. Enabling a rule opens a listening socket on the
    /// desktop, or asks the remote server to open one pointing back at it —
    /// neither is a decision a phone or LAN client gets to make on the
    /// desktop's behalf (ADR-0082 §8.3).
    pub fn set_forward_enabled(
        &self,
        connection_id: &str,
        session_id: &str,
        forward_id: &str,
        enabled: bool,
    ) -> Result<Vec<ForwardStatus>, HostError> {
        let connection = parse_connection_id(connection_id)?;
        let identity = self.identity(connection)?;
        if !identity.local {
            return Err(HostError::PermissionDenied);
        }
        let state = self.inner.state.lock();
        let session = state
            .sessions
            .get(session_id)
            .ok_or(HostError::SessionNotFound)?;
        if !session.attachments.contains(&connection) {
            return Err(HostError::PermissionDenied);
        }
        session
            .process
            .set_forward_enabled(forward_id, enabled)
            .map_err(HostError::InvalidRequest)?;
        Ok(session.process.forward_status())
    }

    pub fn set_flow_control(
        &self,
        connection_id: &str,
        session_id: &str,
        paused: bool,
    ) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        self.identity(connection)?;
        let mut state = self.inner.state.lock();
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or(HostError::SessionNotFound)?;
        if !session.attachments.contains(&connection) {
            return Err(HostError::PermissionDenied);
        }
        let was_paused = !session.flow_paused_by.is_empty();
        if paused {
            session.flow_paused_by.insert(connection, Instant::now());
        } else {
            session.flow_paused_by.remove(&connection);
        }
        let now_paused = !session.flow_paused_by.is_empty();
        let process = Arc::clone(&session.process);
        // Compute the transition under the lock, then release it before
        // touching the process or broadcasting — same discipline as
        // `broadcast_controller`.
        drop(state);
        if was_paused != now_paused {
            apply_flow_state(&self.inner, session_id, &process, now_paused)?;
        }
        Ok(())
    }

    /// Release flow pauses older than [`FLOW_PAUSE_MAX`]. Runs on the host's
    /// 1 Hz maintenance tick alongside the controller-lease reaper.
    pub fn reap_flow_pauses(&self, now: Instant) {
        let mut resumed = Vec::new();
        let mut state = self.inner.state.lock();
        for (session_id, session) in &mut state.sessions {
            if session.flow_paused_by.is_empty() {
                continue;
            }
            session
                .flow_paused_by
                .retain(|_, at| now.saturating_duration_since(*at) < FLOW_PAUSE_MAX);
            if session.flow_paused_by.is_empty() {
                resumed.push((session_id.clone(), Arc::clone(&session.process)));
            }
        }
        drop(state);
        for (session_id, process) in resumed {
            let _ = apply_flow_state(&self.inner, &session_id, &process, false);
        }
    }

    pub fn audit_events(&self) -> Vec<HostAuditEvent> {
        self.inner.state.lock().audit.iter().cloned().collect()
    }

    fn identity(&self, connection_id: Uuid) -> Result<ClientIdentity, HostError> {
        self.inner
            .state
            .lock()
            .clients
            .get(&connection_id)
            .map(|client| client.identity.clone())
            .ok_or(HostError::ConnectionNotFound)
    }

    fn require_controller(&self, connection_id: &str, session_id: &str) -> Result<(), HostError> {
        let connection = parse_connection_id(connection_id)?;
        let state = self.inner.state.lock();
        let session = state
            .sessions
            .get(session_id)
            .ok_or(HostError::SessionNotFound)?;
        if session
            .controller
            .as_ref()
            .is_some_and(|controller| controller.connection_id == connection)
        {
            Ok(())
        } else {
            Err(HostError::NotController)
        }
    }

    fn process(&self, session_id: &str) -> Result<Arc<dyn HostedTerminalProcess>, HostError> {
        self.inner
            .state
            .lock()
            .sessions
            .get(session_id)
            .map(|session| Arc::clone(&session.process))
            .ok_or(HostError::SessionNotFound)
    }

    fn drop_overflowing_attachment(
        &self,
        connection_id: Uuid,
        session_id: &str,
        identity: &ClientIdentity,
    ) {
        let mut state = self.inner.state.lock();
        let mut flow_release = None;
        if let Some(session) = state.sessions.get_mut(session_id) {
            session.attachments.remove(&connection_id);
            // The dropped client's pause goes with it — otherwise an overflow
            // would leave the PTY parked with nobody left to unpark it.
            flow_release = release_flow_for(session, connection_id);
            if let Some(controller) = session.controller.as_mut() {
                if controller.connection_id == connection_id {
                    controller.disconnected_at = Some(Instant::now());
                }
            }
        }
        push_audit(
            &mut state,
            session_id,
            Some(identity),
            AuditKind::AttachmentOverflow,
        );
        drop(state);
        if let Some(process) = flow_release {
            let _ = apply_flow_state(&self.inner, session_id, &process, false);
        }
    }

    #[cfg(test)]
    fn register_test_process(
        &self,
        connection_id: &str,
        session_id: &str,
        process: Arc<dyn HostedTerminalProcess>,
    ) -> Result<HostSessionInfo, HostError> {
        self.register_process(
            parse_connection_id(connection_id)?,
            session_id.to_string(),
            SessionKind::LocalPty,
            "test-profile".into(),
            Some("test-project".into()),
            None,
            "/bin/test".into(),
            false,
            IntegrationCapabilities::local_pty(true),
            None,
            None,
            process,
        )
    }
}

fn parse_connection_id(connection_id: &str) -> Result<Uuid, HostError> {
    Uuid::parse_str(connection_id).map_err(|_| HostError::ConnectionNotFound)
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn session_info(
    inner: &TerminalHostInner,
    state: &HostState,
    session_id: &str,
) -> Result<HostSessionInfo, HostError> {
    let session = state
        .sessions
        .get(session_id)
        .ok_or(HostError::SessionNotFound)?;
    Ok(HostSessionInfo {
        id: session_id.to_string(),
        host_id: inner.host_id.clone(),
        kind: session.kind,
        profile_id: session.profile_id.clone(),
        project_id: session.project_id.clone(),
        extension_id: session.extension_id.clone(),
        origin: if session.created_by_device.is_some() {
            SessionOrigin::Remote
        } else {
            SessionOrigin::Local
        },
        shell: session.shell.clone(),
        created_at: session.created_at,
        last_activity_at: session.last_activity_at,
        current_controller: session
            .controller
            .as_ref()
            .map(|controller| controller.client_id.clone()),
        attached_clients: session.attachments.len(),
        participants: session_participants(state, session),
        alive: session.process.is_alive(),
        sandboxed: session.sandboxed,
        integration_capabilities: session.capabilities.clone(),
        replay: session.process.replay().bounds().into(),
        ssh_host_key_status: session.ssh_host_key_status.clone(),
        ssh_host_key_fingerprint: session.ssh_host_key_fingerprint.clone(),
    })
}

fn host_event(session_id: &str, sequence: u64, event: TerminalEvent) -> HostEvent {
    match event {
        TerminalEvent::Data { bytes } => HostEvent::Output {
            session_id: session_id.into(),
            sequence,
            bytes,
        },
        TerminalEvent::Integration { event } => HostEvent::Integration {
            session_id: session_id.into(),
            sequence,
            event,
        },
        TerminalEvent::Exit { code } => HostEvent::Exit {
            session_id: session_id.into(),
            sequence,
            code,
        },
    }
}

fn replay_gap_event(session_id: &str, gap: ReplayGap) -> HostEvent {
    HostEvent::ReplayGap {
        session_id: session_id.into(),
        requested_after: gap.requested_after,
        first_available: gap.first_available,
        last_available: gap.last_available,
    }
}

fn publish_terminal_event(
    inner: &Arc<TerminalHostInner>,
    session_id: &str,
    sequence: u64,
    event: TerminalEvent,
) {
    let (recipients, identities) = {
        let mut state = inner.state.lock();
        let Some(session) = state.sessions.get_mut(session_id) else {
            return;
        };
        session.last_activity_at = unix_millis();
        let attachment_ids = session.attachments.iter().copied().collect::<Vec<_>>();
        if matches!(event, TerminalEvent::Exit { .. }) {
            push_audit(&mut state, session_id, None, AuditKind::SessionExited);
        }
        let recipients = attachment_ids
            .iter()
            .filter_map(|id| {
                state
                    .clients
                    .get(id)
                    .map(|client| (*id, client.sender.clone()))
            })
            .collect::<Vec<_>>();
        let identities = attachment_ids
            .iter()
            .filter_map(|id| {
                state
                    .clients
                    .get(id)
                    .map(|client| (*id, client.identity.clone()))
            })
            .collect::<HashMap<_, _>>();
        (recipients, identities)
    };
    let host_event = host_event(session_id, sequence, event);
    for (connection, sender) in recipients {
        if sender.try_send(host_event.clone()).is_err() {
            let host = TerminalHost {
                inner: Arc::clone(inner),
            };
            if let Some(identity) = identities.get(&connection) {
                host.drop_overflowing_attachment(connection, session_id, identity);
            }
        }
    }
    enforce_global_replay_budget(inner);
}

fn enforce_global_replay_budget(inner: &TerminalHostInner) {
    loop {
        let (total, largest) = {
            let state = inner.state.lock();
            let mut total = 0usize;
            let mut largest: Option<(usize, Arc<dyn HostedTerminalProcess>)> = None;
            for session in state.sessions.values() {
                let bytes = session.process.replay().retained_bytes();
                total = total.saturating_add(bytes);
                if largest.as_ref().is_none_or(|(current, _)| bytes > *current) {
                    largest = Some((bytes, Arc::clone(&session.process)));
                }
            }
            (total, largest)
        };
        if total <= inner.config.lock().total_replay_bytes {
            break;
        }
        let Some((bytes, process)) = largest else {
            break;
        };
        if bytes == 0 || process.replay().evict_oldest().is_none() {
            break;
        }
    }
}

/// Tell a session's attachments that its transport state changed.
///
/// Best-effort by design: this rides the same bounded per-connection queue as
/// output, and a client too far behind to accept a status frame is already
/// being handled by the overflow path.
fn broadcast_transport_state(
    inner: &TerminalHostInner,
    session_id: &str,
    state_kind: HostTransportState,
) {
    let recipients = {
        let state = inner.state.lock();
        state
            .sessions
            .get(session_id)
            .map(|session| {
                session
                    .attachments
                    .iter()
                    .filter_map(|id| state.clients.get(id).map(|client| client.sender.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    for sender in recipients {
        let _ = sender.try_send(HostEvent::TransportState {
            session_id: session_id.into(),
            state: state_kind,
            message: None,
        });
    }
}

/// The roster of one session: every attached connection resolved to its
/// client identity, with the lease role. Deterministic order (by client id)
/// so two attachments render identical lists.
fn session_participants(state: &HostState, session: &HostedSession) -> Vec<SessionParticipant> {
    let controller = session
        .controller
        .as_ref()
        .filter(|controller| controller.disconnected_at.is_none())
        .map(|controller| controller.client_id.clone());
    let mut participants = session
        .attachments
        .iter()
        .filter_map(|id| state.clients.get(id))
        .map(|client| SessionParticipant {
            client_id: client.identity.client_id.clone(),
            device_id: client.identity.device_id.clone(),
            local: client.identity.local,
            role: if controller.as_deref() == Some(client.identity.client_id.as_str()) {
                ParticipantRole::Controller
            } else {
                ParticipantRole::Viewer
            },
        })
        .collect::<Vec<_>>();
    participants.sort_by(|a, b| a.client_id.cmp(&b.client_id));
    participants.dedup_by(|a, b| a.client_id == b.client_id);
    participants
}

/// Tell every attachment of `session_id` who is attached now, by re-sending
/// the session snapshot (whose `participants` carries the roster).
///
/// Deliberately NOT a new frame kind: an unsolicited kind an older client
/// cannot decode would break it (the protocol's compatibility invariant),
/// whereas an extra `SessionSnapshot` is a kind every client already accepts
/// and older ones simply overwrite `info` with it.
fn broadcast_participants(inner: &TerminalHostInner, session_id: &str) {
    let (recipients, info) = {
        let state = inner.state.lock();
        let Ok(info) = session_info(inner, &state, session_id) else {
            return;
        };
        let Some(session) = state.sessions.get(session_id) else {
            return;
        };
        let recipients = session
            .attachments
            .iter()
            .filter_map(|id| state.clients.get(id).map(|client| client.sender.clone()))
            .collect::<Vec<_>>();
        (recipients, info)
    };
    for sender in recipients {
        let _ = sender.try_send(HostEvent::SessionSnapshot {
            session: info.clone(),
        });
    }
}

fn broadcast_controller(inner: &TerminalHostInner, session_id: &str, controller: Option<String>) {
    let recipients = {
        let state = inner.state.lock();
        state
            .sessions
            .get(session_id)
            .map(|session| {
                session
                    .attachments
                    .iter()
                    .filter_map(|id| state.clients.get(id).map(|client| client.sender.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    for sender in recipients {
        let _ = sender.try_send(HostEvent::ControllerChanged {
            session_id: session_id.into(),
            controller: controller.clone(),
        });
    }
}

fn disconnect_inner(inner: &Arc<TerminalHostInner>, connection_id: Uuid, now: Instant) {
    let mut state = inner.state.lock();
    state.clients.remove(&connection_id);
    // Fires from `Drop for HostClient`, so this one path covers a closed
    // socket, a crashed renderer, and a revoked device.
    let mut resumed = Vec::new();
    let mut touched = Vec::new();
    for (session_id, session) in &mut state.sessions {
        if session.attachments.remove(&connection_id) {
            touched.push(session_id.clone());
        }
        if let Some(process) = release_flow_for(session, connection_id) {
            resumed.push((session_id.clone(), process));
        }
        if let Some(controller) = session.controller.as_mut() {
            if controller.connection_id == connection_id {
                controller.disconnected_at = Some(now);
            }
        }
    }
    drop(state);
    for (session_id, process) in resumed {
        let _ = apply_flow_state(inner, &session_id, &process, false);
    }
    for session_id in touched {
        broadcast_participants(inner, &session_id);
    }
}

/// Drop `connection`'s pause claim. Returns the session's process when that was
/// the last claim (i.e. the producer should resume), else `None`.
fn release_flow_for(
    session: &mut HostedSession,
    connection: Uuid,
) -> Option<Arc<dyn HostedTerminalProcess>> {
    if session.flow_paused_by.remove(&connection).is_none() {
        return None;
    }
    if session.flow_paused_by.is_empty() {
        Some(Arc::clone(&session.process))
    } else {
        None
    }
}

/// Apply an aggregate pause transition and tell the session's attachments why
/// their output stopped (or resumed). Must be called with the state lock
/// released.
fn apply_flow_state(
    inner: &Arc<TerminalHostInner>,
    session_id: &str,
    process: &Arc<dyn HostedTerminalProcess>,
    paused: bool,
) -> Result<(), HostError> {
    process
        .set_flow_paused(paused)
        .map_err(HostError::Process)?;
    broadcast_transport_state(
        inner,
        session_id,
        if paused {
            HostTransportState::FlowPaused
        } else {
            HostTransportState::Online
        },
    );
    Ok(())
}

fn push_audit(
    state: &mut HostState,
    session_id: &str,
    identity: Option<&ClientIdentity>,
    event: AuditKind,
) {
    let now = unix_millis();
    let cutoff = now.saturating_sub(AUDIT_RETENTION.as_millis() as u64);
    while state
        .audit
        .front()
        .is_some_and(|record| record.timestamp < cutoff)
    {
        state.audit.pop_front();
    }
    while state.audit.len() >= AUDIT_EVENT_LIMIT {
        state.audit.pop_front();
    }
    state.audit.push_back(HostAuditEvent {
        timestamp: now,
        session_id: session_id.into(),
        client_id: identity.map(|value| value.client_id.clone()),
        device_id: identity.and_then(|value| value.device_id.clone()),
        event,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FakeProcess {
        alive: AtomicBool,
        replay: Arc<ReplayBuffer>,
        writes: Mutex<Vec<Vec<u8>>>,
        /// Aggregate pause transitions applied to this process. Reference
        /// counting is asserted through this, not through call counts.
        flow_transitions: Mutex<Vec<bool>>,
    }

    impl FakeProcess {
        fn new(capacity: usize) -> Arc<Self> {
            Arc::new(Self {
                alive: AtomicBool::new(true),
                replay: Arc::new(ReplayBuffer::durable(capacity)),
                writes: Mutex::new(Vec::new()),
                flow_transitions: Mutex::new(Vec::new()),
            })
        }
    }

    impl HostedTerminalProcess for FakeProcess {
        fn write(&self, bytes: &[u8]) -> Result<(), String> {
            self.writes.lock().push(bytes.to_vec());
            Ok(())
        }

        fn resize(&self, _rows: u16, _cols: u16) -> Result<(), String> {
            Ok(())
        }

        fn kill(&self) -> Result<(), String> {
            self.alive.store(false, Ordering::SeqCst);
            Ok(())
        }

        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }

        fn replay(&self) -> Arc<ReplayBuffer> {
            Arc::clone(&self.replay)
        }

        fn set_flow_paused(&self, paused: bool) -> Result<(), String> {
            self.flow_transitions.lock().push(paused);
            Ok(())
        }
    }

    fn test_config() -> TerminalHostConfig {
        TerminalHostConfig {
            replay_bytes_per_session: 64 * 1024,
            total_replay_bytes: 128 * 1024,
            ..TerminalHostConfig::default()
        }
    }

    fn profile_request() -> SpawnRequest {
        SpawnRequest {
            shell: "profile-shell".into(),
            args: Vec::new(),
            cwd: None,
            env: Default::default(),
            rows: 24,
            cols: 80,
            project_id: None,
            extension_id: None,
            enable_shell_integration: true,
            force_utf8: true,
            origin: SessionOrigin::Local,
            skip_user_profile: false,
            sandboxed: true,
            sandbox_network: None,
        }
    }

    fn ssh_profile_request(profile_id: &str) -> SshSpawnRequest {
        SshSpawnRequest {
            host: "host.example".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: crate::ssh::SshAuthMethod::Password,
            credential_ref: Some(profile_id.into()),
            private_key_path: None,
            rows: 24,
            cols: 80,
            project_id: None,
            profile_id: profile_id.into(),
            display_name: "Production".into(),
            jump_chain: Vec::new(),
            local_forwards: Vec::new(),
            remote_forwards: Vec::new(),
        }
    }

    fn local_host() -> (TerminalHost, HostClient, Arc<FakeProcess>, String) {
        let host = TerminalHost::new("host-a", test_config()).unwrap();
        let client = host.connect(ClientIdentity::local("desktop")).unwrap();
        let process = FakeProcess::new(64 * 1024);
        let session_id = Uuid::new_v4().to_string();
        host.register_test_process(&client.connection_id, &session_id, process.clone())
            .unwrap();
        (host, client, process, session_id)
    }

    /// The PATH woven into spawned shells comes from the desktop app's managed
    /// CLI registry. A paired phone must not be able to rewrite it — that would
    /// let it choose which binaries the desktop user's shells resolve.
    #[test]
    fn path_injection_is_local_only_and_reaches_spawns() {
        let host = TerminalHost::new("host-a", test_config()).unwrap();
        let local = host.connect(ClientIdentity::local("desktop")).unwrap();
        let remote = host
            .connect(ClientIdentity::remote("phone", "device-a", true))
            .unwrap();

        assert_eq!(host.path_injection().prepend, Vec::<PathBuf>::new());

        let hostile = PathInjection {
            prepend: vec![PathBuf::from("/tmp/evil")],
            append: Vec::new(),
        };
        assert_eq!(
            host.set_path_injection(&remote.connection_id, hostile),
            Err(HostError::PermissionDenied)
        );
        assert_eq!(host.path_injection().prepend, Vec::<PathBuf>::new());

        let trusted = PathInjection {
            prepend: vec![PathBuf::from("/opt/cognia/bin")],
            append: vec![PathBuf::from("/home/dev/.cargo/bin")],
        };
        host.set_path_injection(&local.connection_id, trusted)
            .unwrap();
        let applied = host.path_injection();
        assert_eq!(applied.prepend, vec![PathBuf::from("/opt/cognia/bin")]);
        assert_eq!(applied.append, vec![PathBuf::from("/home/dev/.cargo/bin")]);
    }

    /// A host seeded before any client connects still resolves the bundled CLI
    /// — the start-at-login case where a phone spawns first.
    #[test]
    fn path_injection_can_be_seeded_at_construction() {
        let host = TerminalHost::with_path_injection(
            "host-a",
            test_config(),
            PathInjection {
                prepend: vec![PathBuf::from("/app/cli")],
                append: Vec::new(),
            },
        )
        .unwrap();
        assert_eq!(
            host.path_injection().prepend,
            vec![PathBuf::from("/app/cli")]
        );
    }

    /// Slowest-consumer-wins: the PTY stays parked while ANY attachment has an
    /// outstanding pause, and resumes only when the last one clears.
    #[test]
    fn flow_pause_is_reference_counted_across_attachments() {
        let (host, first, process, session_id) = local_host();
        let second = host.connect(ClientIdentity::local("desktop-2")).unwrap();
        host.attach(&second.connection_id, &session_id, 0).unwrap();

        host.set_flow_control(&first.connection_id, &session_id, true)
            .unwrap();
        host.set_flow_control(&second.connection_id, &session_id, true)
            .unwrap();
        // Only the first (empty → non-empty) transition reaches the process.
        assert_eq!(process.flow_transitions.lock().clone(), vec![true]);

        host.set_flow_control(&first.connection_id, &session_id, false)
            .unwrap();
        assert_eq!(process.flow_transitions.lock().clone(), vec![true]);

        host.set_flow_control(&second.connection_id, &session_id, false)
            .unwrap();
        assert_eq!(process.flow_transitions.lock().clone(), vec![true, false]);
    }

    /// A viewer that cannot keep up is exactly who needs to pause, so the check
    /// is "are you attached", not "are you the controller".
    #[test]
    fn flow_control_requires_an_attachment_but_not_the_controller_lease() {
        let (host, controller, _process, session_id) = local_host();
        let viewer = host.connect(ClientIdentity::local("viewer")).unwrap();
        let stranger = host.connect(ClientIdentity::local("stranger")).unwrap();
        host.attach(&viewer.connection_id, &session_id, 0).unwrap();

        assert_eq!(
            host.set_flow_control(&stranger.connection_id, &session_id, true),
            Err(HostError::PermissionDenied)
        );
        // The viewer is not the controller and may still pause.
        assert!(host
            .set_flow_control(&viewer.connection_id, &session_id, true)
            .is_ok());
        assert!(host
            .set_flow_control(&controller.connection_id, &session_id, false)
            .is_ok());
    }

    /// Detaching and disconnecting are two of the five paths that must clear a
    /// pause; missing either wedges the PTY for everyone.
    #[test]
    fn detach_and_disconnect_release_a_flow_pause() {
        let (host, client, process, session_id) = local_host();
        host.set_flow_control(&client.connection_id, &session_id, true)
            .unwrap();
        assert_eq!(process.flow_transitions.lock().clone(), vec![true]);
        host.detach(&client.connection_id, &session_id).unwrap();
        assert_eq!(process.flow_transitions.lock().clone(), vec![true, false]);

        let second = host.connect(ClientIdentity::local("desktop-2")).unwrap();
        host.attach(&second.connection_id, &session_id, 0).unwrap();
        host.set_flow_control(&second.connection_id, &session_id, true)
            .unwrap();
        // Dropping the client fires `disconnect_inner` — the path that covers a
        // closed socket and a crashed renderer.
        drop(second);
        assert_eq!(
            process.flow_transitions.lock().clone(),
            vec![true, false, true, false]
        );
    }

    /// The 30 s backstop: a client that paused and then stopped running must
    /// not park someone's PTY indefinitely.
    #[test]
    fn stale_flow_pause_auto_resumes_after_the_maximum() {
        let (host, client, process, session_id) = local_host();
        host.set_flow_control(&client.connection_id, &session_id, true)
            .unwrap();

        host.reap_flow_pauses(Instant::now());
        assert_eq!(process.flow_transitions.lock().clone(), vec![true]);

        host.reap_flow_pauses(Instant::now() + FLOW_PAUSE_MAX + Duration::from_secs(1));
        assert_eq!(process.flow_transitions.lock().clone(), vec![true, false]);
    }

    /// A parked reader would never see the child's final output nor reach EOF.
    #[test]
    fn killing_a_paused_session_resumes_it_first() {
        let (host, client, process, session_id) = local_host();
        host.set_flow_control(&client.connection_id, &session_id, true)
            .unwrap();
        host.kill(&client.connection_id, &session_id).unwrap();
        assert_eq!(process.flow_transitions.lock().last().copied(), Some(false));
        assert!(!process.is_alive());
    }

    #[test]
    fn independent_remote_terminal_grant_is_required() {
        let host = TerminalHost::new("host-a", test_config()).unwrap();
        assert!(matches!(
            host.connect(ClientIdentity::remote("phone", "device-a", false)),
            Err(HostError::PermissionDenied)
        ));
        assert!(host
            .connect(ClientIdentity::remote("phone", "device-a", true))
            .is_ok());
    }

    #[test]
    fn synchronized_ssh_profiles_are_local_only_and_replaced_atomically() {
        let host = TerminalHost::new("host-a", test_config()).unwrap();
        let local = host.connect(ClientIdentity::local("desktop")).unwrap();
        let remote = host
            .connect(ClientIdentity::remote("phone", "device-a", true))
            .unwrap();
        let mut local_profiles = HashMap::new();
        local_profiles.insert("shell".into(), profile_request());
        let mut ssh_profiles = HashMap::new();
        ssh_profiles.insert("production".into(), ssh_profile_request("production"));

        host.replace_synchronized_profiles(&local.connection_id, local_profiles, ssh_profiles)
            .unwrap();
        let state = host.inner.state.lock();
        assert!(state.profiles.contains_key("shell"));
        assert!(state.ssh_profiles.contains_key("production"));
        drop(state);

        assert_eq!(
            host.sync_ssh_profile(
                &remote.connection_id,
                "forbidden".into(),
                ssh_profile_request("forbidden"),
            ),
            Err(HostError::PermissionDenied)
        );
        host.replace_synchronized_profiles(&local.connection_id, HashMap::new(), HashMap::new())
            .unwrap();
        let state = host.inner.state.lock();
        assert!(state.profiles.is_empty());
        assert!(state.ssh_profiles.is_empty());
    }

    #[test]
    fn takeover_demotes_previous_controller_and_blocks_stdin() {
        let (host, first, process, session_id) = local_host();
        let second = host.connect(ClientIdentity::local("tablet")).unwrap();
        host.attach(&second.connection_id, &session_id, 0).unwrap();
        host.take_control(&second.connection_id, &session_id)
            .unwrap();

        assert_eq!(
            host.write(&first.connection_id, &session_id, b"blocked"),
            Err(HostError::NotController)
        );
        host.write(&second.connection_id, &session_id, b"allowed\r")
            .unwrap();
        assert_eq!(process.writes.lock().as_slice(), &[b"allowed\r".to_vec()]);
        assert_eq!(
            host.list(&second.connection_id).unwrap()[0].current_controller,
            Some("tablet".into())
        );
    }

    /// Drain a client's event queue and return every roster the host pushed
    /// (attach / detach / lease moves each re-send the session snapshot).
    fn rosters(client: &mut HostClient) -> Vec<Vec<SessionParticipant>> {
        let mut out = Vec::new();
        while let Ok(event) = client.events.try_recv() {
            if let HostEvent::SessionSnapshot { session } = event {
                out.push(session.participants);
            }
        }
        out
    }

    #[test]
    fn roster_is_broadcast_to_every_attachment_on_attach_detach_and_lease_moves() {
        let (host, mut first, _process, session_id) = local_host();
        let _ = rosters(&mut first); // drop the spawn-time snapshot
        let mut phone = host
            .connect(ClientIdentity::remote("companion:dev-1", "dev-1", true))
            .unwrap();
        host.attach(&phone.connection_id, &session_id, 0).unwrap();

        // Both attachments got the two-member roster; the desktop is controller.
        let desktop_view = rosters(&mut first);
        let phone_view = rosters(&mut phone);
        let expected = vec![
            SessionParticipant {
                client_id: "companion:dev-1".into(),
                device_id: Some("dev-1".into()),
                local: false,
                role: ParticipantRole::Viewer,
            },
            SessionParticipant {
                client_id: "desktop".into(),
                device_id: None,
                local: true,
                role: ParticipantRole::Controller,
            },
        ];
        assert_eq!(desktop_view.last().unwrap(), &expected);
        assert_eq!(phone_view.last().unwrap(), &expected);
        // The list() surface carries the same roster.
        assert_eq!(
            host.list(&phone.connection_id).unwrap()[0].participants,
            expected
        );

        // Lease moves flip the roles.
        host.take_control(&phone.connection_id, &session_id)
            .unwrap();
        let after_take = rosters(&mut first);
        let latest = after_take.last().unwrap();
        assert_eq!(latest[0].role, ParticipantRole::Controller);
        assert_eq!(latest[1].role, ParticipantRole::Viewer);

        // Detach shrinks the roster for the remaining attachment.
        host.detach(&phone.connection_id, &session_id).unwrap();
        let after_detach = rosters(&mut first);
        assert_eq!(after_detach.last().unwrap().len(), 1);
        assert_eq!(after_detach.last().unwrap()[0].client_id, "desktop");
    }

    #[test]
    fn dropping_a_client_updates_the_roster_for_the_others() {
        let (host, mut first, _process, session_id) = local_host();
        let phone = host.connect(ClientIdentity::local("phone")).unwrap();
        host.attach(&phone.connection_id, &session_id, 0).unwrap();
        let _ = rosters(&mut first);
        drop(phone);
        let after_drop = rosters(&mut first);
        assert_eq!(after_drop.last().unwrap().len(), 1);
    }

    #[test]
    fn detach_keeps_process_alive_but_kill_terminates_for_everyone() {
        let (host, first, process, session_id) = local_host();
        let second = host.connect(ClientIdentity::local("phone")).unwrap();
        host.attach(&second.connection_id, &session_id, 0).unwrap();
        host.detach(&first.connection_id, &session_id).unwrap();
        assert!(process.is_alive());

        host.take_control(&second.connection_id, &session_id)
            .unwrap();
        host.kill(&second.connection_id, &session_id).unwrap();
        assert!(!process.is_alive());
    }

    #[test]
    fn disconnected_controller_has_grace_then_releases() {
        let (host, first, _process, _session_id) = local_host();
        let disconnected_at = Instant::now();
        drop(first);
        host.reap_controller_leases(disconnected_at + Duration::from_secs(9));
        let viewer = host.connect(ClientIdentity::local("viewer")).unwrap();
        assert_eq!(
            host.list(&viewer.connection_id).unwrap()[0].current_controller,
            Some("desktop".into())
        );
        host.reap_controller_leases(disconnected_at + Duration::from_secs(11));
        assert_eq!(
            host.list(&viewer.connection_id).unwrap()[0].current_controller,
            None
        );
    }

    #[tokio::test]
    async fn replay_gap_is_explicit_on_attach() {
        let (host, _first, process, session_id) = local_host();
        process.replay.push(TerminalEvent::Data {
            bytes: vec![1; 48 * 1024],
        });
        process.replay.push(TerminalEvent::Data {
            bytes: vec![2; 48 * 1024],
        });
        let mut viewer = host.connect(ClientIdentity::local("viewer")).unwrap();
        host.attach(&viewer.connection_id, &session_id, 0).unwrap();
        assert!(matches!(
            viewer.events.recv().await,
            Some(HostEvent::ReplayGap { .. })
        ));
    }

    #[test]
    fn command_memory_keeps_only_last_fifty_and_audit_redacts_content() {
        let (host, client, _process, session_id) = local_host();
        for index in 0..55 {
            host.write(
                &client.connection_id,
                &session_id,
                format!("secret-command-{index}\r").as_bytes(),
            )
            .unwrap();
        }
        let commands = host
            .recent_commands(&client.connection_id, &session_id)
            .unwrap();
        assert_eq!(commands.len(), RECENT_COMMAND_LIMIT);
        assert_eq!(commands.first().unwrap(), "secret-command-5");
        let audit_json = serde_json::to_string(&host.audit_events()).unwrap();
        assert!(!audit_json.contains("secret-command"));
    }

    #[test]
    fn validated_resource_policy_rejects_unsafe_values() {
        let mut config = test_config();
        config.max_sessions = 0;
        assert!(matches!(
            config.validate(),
            Err(HostError::InvalidRequest(_))
        ));
        let mut config = test_config();
        config.total_replay_bytes = 32 * 1024;
        assert!(matches!(
            config.validate(),
            Err(HostError::InvalidRequest(_))
        ));
    }

    #[test]
    fn only_local_clients_can_synchronize_remote_spawn_profiles() {
        let host = TerminalHost::new("host-a", test_config()).unwrap();
        let local = host.connect(ClientIdentity::local("desktop")).unwrap();
        let remote = host
            .connect(ClientIdentity::remote("phone", "device-a", true))
            .unwrap();
        let request = profile_request();
        assert_eq!(
            host.sync_profile(&remote.connection_id, "profile-a".into(), request.clone()),
            Err(HostError::PermissionDenied)
        );
        host.sync_profile(&local.connection_id, "profile-a".into(), request)
            .unwrap();
        assert!(host.inner.state.lock().profiles.contains_key("profile-a"));
    }

    #[test]
    fn profile_replacement_removes_deleted_profiles_atomically() {
        let host = TerminalHost::new("host-a", TerminalHostConfig::default()).unwrap();
        let local = host
            .connect(ClientIdentity::local("desktop"))
            .expect("local connection");
        host.sync_profile(&local.connection_id, "old".into(), profile_request())
            .unwrap();
        host.replace_synchronized_profiles(
            &local.connection_id,
            HashMap::from([("new".into(), profile_request())]),
            HashMap::new(),
        )
        .unwrap();
        let profiles = &host.inner.state.lock().profiles;
        assert!(!profiles.contains_key("old"));
        assert!(profiles.contains_key("new"));
    }

    #[test]
    fn only_local_clients_can_update_validated_resource_policy() {
        let host = TerminalHost::new("host-a", test_config()).unwrap();
        let local = host.connect(ClientIdentity::local("desktop")).unwrap();
        let remote = host
            .connect(ClientIdentity::remote("phone", "device-a", true))
            .unwrap();
        let mut updated = test_config();
        updated.max_sessions = 48;
        assert_eq!(
            host.update_config(&remote.connection_id, updated.clone()),
            Err(HostError::PermissionDenied)
        );
        host.update_config(&local.connection_id, updated.clone())
            .unwrap();
        assert_eq!(host.inner.config.lock().max_sessions, 48);
        updated.max_sessions = 0;
        assert!(matches!(
            host.update_config(&local.connection_id, updated),
            Err(HostError::InvalidRequest(_))
        ));
    }
}
