//! Tauri-free client for the durable terminal host (ADR-0196 P6e).
//!
//! Starting the host binary when nothing answers, one-shot identity-scoped
//! connections for the companion's terminal socket and RPC arms, the SFTP and
//! remote list/kill/configure/profile calls, and the settings snapshot. The
//! desktop's long-lived bridge (`host_bridge`) reuses the spawn and framing
//! helpers. Callers pass the app's resource dir, where the host finds its
//! shell-integration scripts; the headless server has none and passes `None`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::host::{ClientIdentity, HostSessionInfo};
use crate::host_wire::{read_frame, write_frame};
use crate::protocol::{FrameKind, TerminalErrorCode, TerminalFrame};
use crate::terminal_host_service::{
    default_terminal_host_endpoint, load_terminal_host_settings, open_terminal_host_log,
    save_terminal_host_settings, try_connect_terminal_host_as, BoxedTerminalHostIo,
    TerminalHostConnectError, TerminalHostDescriptor, TerminalHostSettings,
    CREDENTIAL_UNAVAILABLE_EXIT_CODE,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const START_RETRY_COUNT: usize = 40;
pub const START_RETRY_DELAY: Duration = Duration::from_millis(100);
const AUTHORIZATION_RETRY_COUNT: usize = 1200;

/// Interactive startup is reachable only from the user's credential recovery action.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TerminalHostStartMode {
    #[default]
    Background,
    AuthorizeCredentials,
}

impl TerminalHostStartMode {
    fn retries(self) -> usize {
        match self {
            Self::Background => START_RETRY_COUNT,
            Self::AuthorizeCredentials => AUTHORIZATION_RETRY_COUNT,
        }
    }

    fn configure_command(self, command: &mut Command) {
        if self == Self::AuthorizeCredentials {
            command.arg("--authorize-credentials");
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: TerminalErrorCode,
    pub message: String,
}

pub fn is_response_kind(kind: FrameKind) -> bool {
    matches!(
        kind,
        FrameKind::Ack
            | FrameKind::HostSnapshot
            | FrameKind::SessionSnapshot
            | FrameKind::SftpSnapshot
            | FrameKind::Error
    )
}

pub fn error_code_name(code: TerminalErrorCode) -> &'static str {
    match code {
        TerminalErrorCode::NotController => "not_controller",
        TerminalErrorCode::PermissionDenied => "permission_denied",
        TerminalErrorCode::ReplayGap => "replay_gap",
        TerminalErrorCode::ResourceLimit => "resource_limit",
        TerminalErrorCode::HostOffline => "host_offline",
        TerminalErrorCode::Unpaired => "unpaired",
        TerminalErrorCode::Unauthorized => "unauthorized",
        TerminalErrorCode::SessionNotFound => "session_not_found",
        TerminalErrorCode::InvalidRequest => "invalid_request",
        TerminalErrorCode::QueueOverflow => "queue_overflow",
    }
}

/// A host process this client started.
///
/// Kept so the connect loop notices (and reaps) a host that exits during
/// startup instead of waiting out every retry, and can say where its stderr
/// went.
#[derive(Debug, Default)]
pub struct SpawnedTerminalHost {
    child: Option<Child>,
    log_path: Option<PathBuf>,
    stop_on_drop: bool,
}

impl Drop for SpawnedTerminalHost {
    fn drop(&mut self) {
        // Only our pending interactive launch is owned by this request. A
        // successful connection releases it; an existing host is never owned.
        if self.stop_on_drop {
            if let Some(child) = self.child.as_mut() {
                if child.try_wait().ok().flatten().is_none() && child.kill().is_ok() {
                    let _ = child.wait();
                }
            }
        }
    }
}

impl SpawnedTerminalHost {
    /// The exit status, once the process has exited. Never blocks.
    fn exit_status(&mut self) -> Option<ExitStatus> {
        self.child.as_mut()?.try_wait().ok().flatten()
    }

    fn log_hint(&self) -> String {
        self.log_path
            .as_ref()
            .map(|path| format!(" (host log: {})", path.display()))
            .unwrap_or_default()
    }
}

fn spawn_terminal_host(
    endpoint: &str,
    terminal_resource_dir: Option<PathBuf>,
    mode: TerminalHostStartMode,
) -> Result<SpawnedTerminalHost, String> {
    let binary = resolve_server_binary()?;
    // The host's stderr carries its log and the reason it exits. A log that
    // cannot be opened costs only that record, not the host.
    let (stderr, log_path) = match open_terminal_host_log() {
        Ok((file, path)) => (Stdio::from(file), Some(path)),
        Err(error) => {
            log::warn!("terminal host stderr is discarded: {error}");
            (Stdio::null(), None)
        }
    };
    let mut command = Command::new(&binary);
    command
        .arg("desktop-host")
        .arg("--endpoint")
        .arg(endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr);
    mode.configure_command(&mut command);
    if let Some(resource_dir) = terminal_resource_dir {
        command.env("COGNIA_TERMINAL_RESOURCES", resource_dir);
    }
    let child = command
        .spawn()
        .map_err(|error| format!("failed to start {}: {error}", binary.display()))?;
    Ok(SpawnedTerminalHost {
        child: Some(child),
        log_path,
        stop_on_drop: mode == TerminalHostStartMode::AuthorizeCredentials,
    })
}

pub async fn spawn_terminal_host_async(
    endpoint: String,
    terminal_resource_dir: Option<PathBuf>,
) -> Result<SpawnedTerminalHost, String> {
    spawn_terminal_host_with_mode(
        endpoint,
        terminal_resource_dir,
        TerminalHostStartMode::Background,
    )
    .await
}

async fn spawn_terminal_host_with_mode(
    endpoint: String,
    terminal_resource_dir: Option<PathBuf>,
    mode: TerminalHostStartMode,
) -> Result<SpawnedTerminalHost, String> {
    tokio::task::spawn_blocking(move || spawn_terminal_host(&endpoint, terminal_resource_dir, mode))
        .await
        .map_err(|error| format!("terminal host spawn task failed: {error}"))?
}

/// Connect with `connect`, starting the host first if nothing is listening.
///
/// Shared by the one-shot clients below and the desktop bridge, which
/// connects its own long-lived client the same way.
pub async fn connect_or_spawn_terminal_host<T, C, F>(
    endpoint: &str,
    terminal_resource_dir: Option<PathBuf>,
    connect: C,
) -> Result<T, String>
where
    C: FnMut() -> F,
    F: Future<Output = Result<T, TerminalHostConnectError>>,
{
    connect_or_spawn_terminal_host_with_mode(
        endpoint,
        terminal_resource_dir,
        TerminalHostStartMode::Background,
        connect,
    )
    .await
}

pub async fn connect_or_spawn_terminal_host_with_mode<T, C, F>(
    endpoint: &str,
    terminal_resource_dir: Option<PathBuf>,
    mode: TerminalHostStartMode,
    connect: C,
) -> Result<T, String>
where
    C: FnMut() -> F,
    F: Future<Output = Result<T, TerminalHostConnectError>>,
{
    let endpoint = endpoint.to_string();
    connect_with_start_policy(
        connect,
        move || spawn_terminal_host_with_mode(endpoint, terminal_resource_dir, mode),
        mode.retries(),
        START_RETRY_DELAY,
    )
    .await
}

/// The start policy behind [`connect_or_spawn_terminal_host`], with the spawn
/// and timing injectable for tests.
///
/// Only an unreachable host leads to a spawn. A credential the OS store
/// refuses, or a host that is listening but failed the connection, comes back
/// unchanged from every retry, and a second host would only exit with
/// "already running"; those return at once with their own message. While
/// waiting for a spawned host, a refused credential still returns at once, and
/// the error finally reported is the most telling one seen (by
/// [`TerminalHostConnectError::severity`]) rather than merely the last, so a
/// host that accepted and then died is not reported as "connection refused".
async fn connect_with_start_policy<T, C, F, S, SF>(
    mut connect: C,
    spawn: S,
    retries: usize,
    delay: Duration,
) -> Result<T, String>
where
    C: FnMut() -> F,
    F: Future<Output = Result<T, TerminalHostConnectError>>,
    S: FnOnce() -> SF,
    SF: Future<Output = Result<SpawnedTerminalHost, String>>,
{
    match connect().await {
        Ok(stream) => return Ok(stream),
        Err(error) if error.host_start_may_help() => {}
        Err(error) => return Err(error.into()),
    }
    let mut spawned = spawn().await?;
    let mut reported: Option<TerminalHostConnectError> = None;
    for _ in 0..retries {
        tokio::time::sleep(delay).await;
        // Read before connecting: a host that exited may have lost a race to
        // one that is now listening, so it still gets one more attempt.
        let exited = spawned.exit_status();
        match connect().await {
            Ok(stream) => {
                spawned.stop_on_drop = false;
                return Ok(stream);
            }
            Err(error @ TerminalHostConnectError::CredentialUnavailable(_)) => {
                return Err(error.into());
            }
            Err(error) => {
                if reported
                    .as_ref()
                    .is_none_or(|current| error.severity() >= current.severity())
                {
                    reported = Some(error);
                }
            }
        }
        if let Some(status) = exited {
            if status.code() == Some(CREDENTIAL_UNAVAILABLE_EXIT_CODE) {
                return Err(format!(
                    "terminal_credential_unavailable: the terminal host could not access its OS credential; use Authorize access{}",
                    spawned.log_hint(),
                ));
            }
            return Err(format!(
                "terminal host exited during startup with {status}{}: {}",
                spawned.log_hint(),
                reported.map(String::from).unwrap_or_default()
            ));
        }
    }
    Err(format!(
        "terminal host did not start within {}ms{}: {}",
        delay.saturating_mul(retries as u32).as_millis(),
        spawned.log_hint(),
        reported
            .map(String::from)
            .unwrap_or_else(|| "no connection was attempted".to_string())
    ))
}

/// Open an authenticated, identity-scoped connection for a non-renderer
/// adapter such as the Companion WebSocket route.
pub async fn connect_terminal_host_client(
    resource_dir: Option<&Path>,
    mut identity: ClientIdentity,
) -> Result<BoxedTerminalHostIo, String> {
    let bridge_workspace_env = !identity.local;
    identity.workspace_env_bridge = bridge_workspace_env;
    let endpoint = default_terminal_host_endpoint();
    let stream =
        connect_or_spawn_terminal_host(&endpoint, terminal_resources(resource_dir), || {
            try_connect_terminal_host_as(&endpoint, identity.clone())
        })
        .await?;
    if bridge_workspace_env {
        remote_workspace_bridge(stream).await
    } else {
        Ok(stream)
    }
}

async fn remote_workspace_bridge(
    mut stream: BoxedTerminalHostIo,
) -> Result<BoxedTerminalHostIo, String> {
    let hello = request_over_host_stream(
        &mut stream,
        TerminalFrame::command(FrameKind::Hello, Uuid::nil(), 0, b"{}".to_vec()),
    )
    .await?;
    let ack: serde_json::Value =
        serde_json::from_slice(&hello.payload).map_err(|error| error.to_string())?;
    let supported = ack["protocolFeatures"].as_array().is_some_and(|features| {
        features
            .iter()
            .any(|feature| feature == "workspaceEnvBridge")
    });
    if supported {
        Ok(workspace_env_bridge(stream))
    } else {
        Ok(legacy_workspace_env_bridge(stream))
    }
}

/// Old hosts expose no profile cwd or immutable profile revision. A remote
/// profile-only spawn cannot be resolved safely, even with a native mirror:
/// another native process may have replaced the profile. Existing sessions
/// remain accessible; only new remote spawns require a host restart.
fn legacy_workspace_env_bridge(host: BoxedTerminalHostIo) -> BoxedTerminalHostIo {
    let (client, bridge) = tokio::io::duplex(crate::protocol::MAX_FRAME_PAYLOAD * 2);
    tokio::spawn(async move {
        let (mut client_reader, client_writer) = tokio::io::split(bridge);
        let (mut host_reader, mut host_writer) = tokio::io::split(host);
        let client_writer = std::sync::Arc::new(tokio::sync::Mutex::new(client_writer));
        let outgoing_client = client_writer.clone();
        let mut outgoing = tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut client_reader).await {
                let error = match frame.kind {
                    FrameKind::Spawn => Some("terminal host cannot resolve the remote profile's workspace environment; restart the desktop host"),
                    FrameKind::WorkspaceEnvQuery | FrameKind::WorkspaceEnvResult => Some("native workspace environment frames are not renderer commands"),
                    _ => None,
                };
                if let Some(message) = error {
                    let Ok(error) = bridge_error(&frame, message) else {
                        break;
                    };
                    if write_frame(&mut *outgoing_client.lock().await, &error)
                        .await
                        .is_err()
                    {
                        break;
                    }
                } else if write_frame(&mut host_writer, &frame).await.is_err() {
                    break;
                }
            }
        });
        let mut incoming = tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut host_reader).await {
                if write_frame(&mut *client_writer.lock().await, &frame)
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        tokio::select! {
            _ = &mut outgoing => { incoming.abort(); let _ = incoming.await; }
            _ = &mut incoming => { outgoing.abort(); let _ = outgoing.await; }
        }
    });
    Box::pin(client)
}

/// Local callers own the complete request, so unlike legacy remote profiles
/// their cwd can be resolved before deciding whether the host capability is
/// needed. The returned payload is the actual Spawn wire request.
#[cfg(any(test, feature = "tauri-host"))]
pub(crate) async fn local_spawn_payload(
    request: crate::session::SpawnRequest,
    profile_id: String,
    supports_workspace_env: bool,
) -> Result<serde_json::Value, String> {
    let workspace_env = crate::session::resolve_workspace_env_for_request_async(&request).await?;
    if workspace_env.env.is_some() && !supports_workspace_env {
        return Err(
            "terminal host lacks the workspace environment bridge; restart the desktop host".into(),
        );
    }
    Ok(
        serde_json::json!({"profileId": profile_id, "request": request, "workspaceEnv": workspace_env}),
    )
}

/// Keep the existing byte-stream API for WS/RTC adapters. Internal lease
/// queries terminate here and never reach the renderer. One spawn exchange
/// is in flight at a time so its answer cannot be interleaved with user input.
fn workspace_env_bridge(host: BoxedTerminalHostIo) -> BoxedTerminalHostIo {
    workspace_env_bridge_with_resolver(host, crate::session::resolve_workspace_env_for_request)
}

fn workspace_env_bridge_with_resolver<F>(
    host: BoxedTerminalHostIo,
    resolve: F,
) -> BoxedTerminalHostIo
where
    F: Fn(&crate::session::SpawnRequest) -> Result<crate::session::WorkspaceEnvResolution, String>
        + Send
        + Sync
        + 'static,
{
    use std::sync::Arc;
    use tokio::sync::{watch, Mutex};
    let (client, bridge) = tokio::io::duplex(crate::protocol::MAX_FRAME_PAYLOAD * 2);
    let (mut client_reader, client_writer) = tokio::io::split(bridge);
    let (mut host_reader, host_writer) = tokio::io::split(host);
    let client_writer = Arc::new(Mutex::new(client_writer));
    let host_writer = Arc::new(Mutex::new(host_writer));
    let (pending, mut pending_changed) = watch::channel(None::<u64>);
    let pending = Arc::new(pending);
    let resolve = Arc::new(resolve);
    tokio::spawn(async move {
        let (frames, mut received) = tokio::sync::mpsc::channel(256);
        // Read EOF even while allocation is pending, so disconnect cancels
        // the native response before desktop-host can create a child.
        let mut reader = tokio::spawn(async move {
            loop {
                let Some(frame) = read_frame(&mut client_reader).await? else {
                    return Ok::<(), String>(());
                };
                frames
                    .try_send(frame)
                    .map_err(|_| "terminal bridge input queue overflowed".to_string())?;
            }
        });
        let outgoing_host = host_writer.clone();
        let outgoing_client = client_writer.clone();
        let outgoing_pending = pending.clone();
        let mut outgoing = tokio::spawn(async move {
            loop {
                let Some(frame) = received.recv().await else {
                    return Ok::<(), String>(());
                };
                if matches!(
                    frame.kind,
                    FrameKind::WorkspaceEnvQuery | FrameKind::WorkspaceEnvResult
                ) {
                    let error = bridge_error(
                        &frame,
                        "native workspace environment frames are not renderer commands",
                    )?;
                    write_frame(&mut *outgoing_client.lock().await, &error).await?;
                    continue;
                }
                let spawn = frame.kind == FrameKind::Spawn;
                if spawn {
                    outgoing_pending.send_replace(Some(frame.sequence));
                }
                write_frame(&mut *outgoing_host.lock().await, &frame).await?;
                if spawn {
                    while pending_changed.borrow_and_update().is_some() {
                        pending_changed
                            .changed()
                            .await
                            .map_err(|_| "workspace bridge closed".to_string())?;
                    }
                }
            }
        });
        let mut incoming = tokio::spawn(async move {
            loop {
                let Some(frame) = read_frame(&mut host_reader).await? else {
                    return Ok::<(), String>(());
                };
                if frame.kind == FrameKind::WorkspaceEnvQuery {
                    if *pending.borrow() != Some(frame.sequence) {
                        return Err("unexpected workspace environment query".into());
                    }
                    let resolved = match serde_json::from_slice::<crate::session::SpawnRequest>(
                        &frame.payload,
                    ) {
                        Ok(request) => {
                            let resolve = resolve.clone();
                            tokio::task::spawn_blocking(move || resolve(&request))
                                .await
                                .map_err(|error| {
                                    format!("workspace resolver task failed: {error}")
                                })?
                        }
                        Err(error) => Err(format!("workspace profile is invalid: {error}")),
                    };
                    let response = TerminalFrame::command(
                        FrameKind::WorkspaceEnvResult,
                        frame.session_id,
                        frame.sequence,
                        serde_json::to_vec(&resolved).map_err(|error| error.to_string())?,
                    );
                    write_frame(&mut *host_writer.lock().await, &response).await?;
                    continue;
                }
                if frame.kind == FrameKind::WorkspaceEnvResult {
                    return Err("unexpected workspace environment result".into());
                }
                if matches!(frame.kind, FrameKind::SessionSnapshot | FrameKind::Error)
                    && *pending.borrow() == Some(frame.sequence)
                {
                    pending.send_replace(None);
                }
                write_frame(&mut *client_writer.lock().await, &frame).await?;
            }
        });
        tokio::select! {
            _ = &mut reader => { outgoing.abort(); incoming.abort(); let _ = outgoing.await; let _ = incoming.await; }
            _ = &mut outgoing => { reader.abort(); incoming.abort(); let _ = reader.await; let _ = incoming.await; }
            _ = &mut incoming => { reader.abort(); outgoing.abort(); let _ = reader.await; let _ = outgoing.await; }
        }
    });
    Box::pin(client)
}

fn bridge_error(frame: &TerminalFrame, message: &str) -> Result<TerminalFrame, String> {
    Ok(TerminalFrame::command(
        FrameKind::Error,
        frame.session_id,
        frame.sequence,
        serde_json::to_vec(
            &serde_json::json!({"code": TerminalErrorCode::PermissionDenied, "message": message}),
        )
        .map_err(|error| error.to_string())?,
    ))
}

async fn request_over_host_stream(
    stream: &mut BoxedTerminalHostIo,
    frame: TerminalFrame,
) -> Result<TerminalFrame, String> {
    request_over_host_stream_with_timeout(stream, frame, REQUEST_TIMEOUT).await
}

async fn request_over_host_stream_with_timeout(
    stream: &mut BoxedTerminalHostIo,
    frame: TerminalFrame,
    timeout: Duration,
) -> Result<TerminalFrame, String> {
    tokio::time::timeout(timeout, async {
        let sequence = frame.sequence;
        write_frame(stream, &frame).await?;
        loop {
            let response = read_frame(stream)
                .await?
                .ok_or_else(|| "terminal host connection closed before responding".to_string())?;
            if response.sequence != sequence || !is_response_kind(response.kind) {
                continue;
            }
            if response.kind == FrameKind::Error {
                let error: ErrorPayload =
                    serde_json::from_slice(&response.payload).map_err(|decode| {
                        format!("terminal host returned an invalid error: {decode}")
                    })?;
                return Err(format!(
                    "{}: {}",
                    error_code_name(error.code),
                    error.message
                ));
            }
            return Ok(response);
        }
    })
    .await
    .map_err(|_| "terminal host request timed out".to_string())?
}

/// How long one SFTP operation may take on the host socket.
///
/// Longer than the general request timeout because the host may have to dial a
/// machine, walk a jump chain and authenticate before it can answer the first
/// listing. Every later call on that profile reuses the pooled session and
/// returns in milliseconds.
const SFTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The largest number of file bytes one SFTP chunk may carry.
///
/// Bounded by the terminal frame ceiling rather than by anything about SFTP.
/// A chunk crosses the host socket as base64 inside a JSON frame, so 64 KiB of
/// frame is 48 KiB of bytes before the envelope. 32 KiB leaves room for the
/// path and still fills a network packet many times over.
/// `sftp_download_open` and `sftp_upload_open` answer with this number so a
/// client sizes its reads from the host rather than from a constant of its own,
/// which is the host-negotiated chunk size ADR-0162 calls for.
pub const SFTP_CHUNK_BYTES: usize = 32 * 1024;

/// Perform one SFTP operation on the terminal host (ADR-0162).
///
/// Connects as a **local** client, which is the entire authorization
/// handshake: `TerminalHost` refuses frame 26 on any connection that is not
/// local, so the only way to reach it is from this process, after the RPC layer
/// has checked `ssh.files`, taken the approval, and written the audit row.
/// `terminal_host_remote_configure` reaches `update_config` the same way.
///
/// A fresh connection per call rather than a pooled one. The SFTP session
/// itself is pooled inside the host, keyed on the profile's configuration
/// fingerprint and independent of which client connection asked, so the socket
/// here carries one request and nothing that outlives it. A Unix socket connect
/// costs microseconds against an SFTP round trip that costs milliseconds, and
/// the alternative is a shared client whose lifetime nothing owns.
pub async fn terminal_host_sftp(
    resource_dir: Option<&Path>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut stream =
        connect_terminal_host_client(resource_dir, ClientIdentity::local("companion-rpc:sftp"))
            .await?;
    let response = request_over_host_stream_with_timeout(
        &mut stream,
        TerminalFrame::command(
            FrameKind::SftpControl,
            Uuid::nil(),
            1,
            serde_json::to_vec(&payload).map_err(|error| error.to_string())?,
        ),
        SFTP_REQUEST_TIMEOUT,
    )
    .await?;
    serde_json::from_slice(&response.payload)
        .map_err(|error| format!("terminal host returned an invalid SFTP snapshot: {error}"))
}

pub async fn terminal_host_remote_list(
    resource_dir: Option<&Path>,
    device_id: &str,
) -> Result<Vec<HostSessionInfo>, String> {
    let identity = ClientIdentity::remote(
        format!("companion-rpc:{device_id}"),
        device_id.to_string(),
        true,
    );
    let mut stream = connect_terminal_host_client(resource_dir, identity).await?;
    let response = request_over_host_stream(
        &mut stream,
        TerminalFrame::command(FrameKind::List, Uuid::nil(), 1, Vec::new()),
    )
    .await?;
    let value: serde_json::Value = serde_json::from_slice(&response.payload)
        .map_err(|error| format!("terminal host snapshot is invalid: {error}"))?;
    serde_json::from_value(value.get("sessions").cloned().unwrap_or_default())
        .map_err(|error| format!("terminal session list is invalid: {error}"))
}

/// Read the host's own settings, for a client that cannot reach the local
/// `terminal_host_service` command.
///
/// Host-neutral: the settings live in a file next to the terminal host, not in
/// Tauri state, so this is the same answer on a desktop and on a headless
/// `cognia-server`.
pub async fn terminal_host_remote_status() -> Result<TerminalHostStatus, String> {
    let endpoint = default_terminal_host_endpoint();
    let settings = tokio::task::spawn_blocking(load_terminal_host_settings)
        .await
        .map_err(|error| format!("terminal host settings task failed: {error}"))??;
    Ok(TerminalHostStatus {
        running: true,
        endpoint,
        settings,
        descriptor: None,
    })
}

/// Apply host settings on behalf of an authenticated remote administrator.
///
/// Connects to the terminal host as a **local** client, which is what lets the
/// config actually land: `TerminalHost::update_config` refuses non-local
/// connections on purpose, so a paired device can never rewrite host state by
/// talking to the socket itself. The authority here is the RPC layer's
/// `host.admin` capability check, which is a stronger gate than the desktop
/// toggle it mirrors — and it is the only way to turn remote terminal access
/// on for a headless server that was started without `--allow-remote-terminal`,
/// short of shelling into the box.
///
/// Rolls the live config back if persisting fails, so the running host and the
/// settings file cannot disagree about what was configured.
pub async fn terminal_host_remote_configure(
    resource_dir: Option<&Path>,
    updated: TerminalHostSettings,
) -> Result<TerminalHostStatus, String> {
    let config = updated.host_config()?;
    let previous = tokio::task::spawn_blocking(load_terminal_host_settings)
        .await
        .map_err(|error| format!("terminal host settings task failed: {error}"))??;
    let endpoint = default_terminal_host_endpoint();
    let mut stream = connect_terminal_host_client(
        resource_dir,
        ClientIdentity::local("companion-rpc:configure"),
    )
    .await?;
    request_over_host_stream(
        &mut stream,
        TerminalFrame::command(
            FrameKind::Hello,
            Uuid::nil(),
            1,
            serde_json::to_vec(&serde_json::json!({ "config": config }))
                .map_err(|error| error.to_string())?,
        ),
    )
    .await?;

    let persisted = updated.clone();
    if let Err(error) = tokio::task::spawn_blocking(move || save_terminal_host_settings(&persisted))
        .await
        .map_err(|task| format!("terminal host settings task failed: {task}"))?
    {
        if let Ok(rollback) = previous.host_config() {
            let _ = request_over_host_stream(
                &mut stream,
                TerminalFrame::command(
                    FrameKind::Hello,
                    Uuid::nil(),
                    2,
                    serde_json::to_vec(&serde_json::json!({ "config": rollback }))
                        .unwrap_or_default(),
                ),
            )
            .await;
        }
        return Err(error);
    }

    Ok(TerminalHostStatus {
        running: true,
        endpoint,
        settings: updated,
        descriptor: None,
    })
}

/// Install a paired device's terminal profiles on the host.
///
/// This is what makes a remote shell choice mean anything. A remote spawn frame
/// carries a profile id and nothing else — `TerminalHost::spawn_local` refuses
/// non-local identities — so before this existed, a browser's picker selection
/// was discarded and the host fell back to whichever profile happened to be
/// installed. On a headless server that was only the bootstrap `default`, and
/// every configured profile id came back "unknown terminal profile".
///
/// Scoped to `device_id` so one device's sync cannot erase another's: the
/// shared profile map is *replaced* by `replace_synchronized_profiles`, so a
/// phone and a desktop writing into it would take turns deleting each other.
pub async fn terminal_host_remote_sync_profiles(
    resource_dir: Option<&Path>,
    device_id: &str,
    profiles: Vec<serde_json::Value>,
) -> Result<usize, String> {
    if device_id.trim().is_empty() {
        return Err("deviceId is required".to_string());
    }
    let mut stream = connect_terminal_host_client(
        resource_dir,
        ClientIdentity::local(format!("companion-rpc:profiles:{device_id}")),
    )
    .await?;
    let count = profiles.len();
    request_over_host_stream(
        &mut stream,
        TerminalFrame::command(
            FrameKind::Hello,
            Uuid::nil(),
            1,
            serde_json::to_vec(&serde_json::json!({
                "onBehalfOfDevice": device_id,
                "profiles": profiles,
            }))
            .map_err(|error| error.to_string())?,
        ),
    )
    .await?;
    Ok(count)
}

pub async fn terminal_host_remote_kill(
    resource_dir: Option<&Path>,
    device_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let identity = ClientIdentity::remote(
        format!("companion-rpc:{device_id}"),
        device_id.to_string(),
        true,
    );
    let mut stream = connect_terminal_host_client(resource_dir, identity).await?;
    let session_id = parse_session_id(session_id)?;
    request_over_host_stream(
        &mut stream,
        TerminalFrame::command(
            FrameKind::Attach,
            session_id,
            1,
            serde_json::to_vec(&serde_json::json!({ "resumeAfter": u64::MAX }))
                .map_err(|error| error.to_string())?,
        ),
    )
    .await?;
    request_over_host_stream(
        &mut stream,
        TerminalFrame::command(FrameKind::TakeControl, session_id, 2, Vec::new()),
    )
    .await?;
    request_over_host_stream(
        &mut stream,
        TerminalFrame::command(FrameKind::Kill, session_id, 3, Vec::new()),
    )
    .await?;
    Ok(())
}

pub fn resolve_server_binary() -> Result<PathBuf, String> {
    let executable_name = if cfg!(windows) {
        "cognia-server.exe"
    } else {
        "cognia-server"
    };
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(executable_name));
        }
    }
    if let Some(root) = dev_workspace_root() {
        candidates.push(root.join("target").join("debug").join(executable_name));
        candidates.push(root.join("target").join("release").join(executable_name));
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "cognia-server is not bundled; build the desktop host before opening a terminal"
                .to_string()
        })
}

pub fn parse_session_id(id: &str) -> Result<Uuid, String> {
    Uuid::parse_str(id).map_err(|_| format!("invalid terminal session id: {id}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHostStatus {
    pub running: bool,
    pub endpoint: String,
    pub settings: TerminalHostSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<TerminalHostDescriptor>,
}

/// The terminal resources inside an app resource dir.
pub fn terminal_resources(resource_dir: Option<&Path>) -> Option<PathBuf> {
    resource_dir.map(|dir| dir.join("terminal"))
}

/// The workspace root, two levels above this crate: a dev build's
/// `cognia-server` sits in its `target/`.
fn dev_workspace_root() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {

    #[tokio::test]
    async fn old_host_keeps_existing_sessions_and_refuses_unresolvable_remote_spawns() {
        let host_id = Uuid::new_v4().to_string();
        let (native, mut server) = tokio::io::duplex(65536);
        let (sent, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let server_host = host_id.clone();
        let host_task = tokio::spawn(async move {
            let hello = read_frame(&mut server).await.unwrap().unwrap();
            assert_eq!(hello.kind, FrameKind::Hello);
            write_frame(
                &mut server,
                &TerminalFrame::command(
                    FrameKind::Ack,
                    Uuid::nil(),
                    hello.sequence,
                    serde_json::to_vec(&serde_json::json!({"ok":true,"hostId":server_host}))
                        .unwrap(),
                ),
            )
            .await
            .unwrap();
            while let Some(frame) = read_frame(&mut server).await.unwrap() {
                sent.send(frame.kind).unwrap();
                let kind = match frame.kind {
                    FrameKind::List => FrameKind::HostSnapshot,
                    FrameKind::Spawn => FrameKind::SessionSnapshot,
                    _ => FrameKind::Ack,
                };
                write_frame(
                    &mut server,
                    &TerminalFrame::command(kind, frame.session_id, frame.sequence, b"{}".to_vec()),
                )
                .await
                .unwrap();
            }
        });
        let mut client = remote_workspace_bridge(Box::pin(native)).await.unwrap();
        for (sequence, kind) in [
            (1, FrameKind::List),
            (2, FrameKind::Attach),
            (3, FrameKind::Kill),
        ] {
            request_over_host_stream(
                &mut client,
                TerminalFrame::command(kind, Uuid::nil(), sequence, b"{}".to_vec()),
            )
            .await
            .unwrap();
            assert_eq!(observed.recv().await, Some(kind));
        }
        let error = request_over_host_stream(
            &mut client,
            TerminalFrame::command(
                FrameKind::Spawn,
                Uuid::nil(),
                4,
                serde_json::to_vec(&serde_json::json!({"profileId":"default"})).unwrap(),
            ),
        )
        .await
        .unwrap_err();
        assert!(error.contains("restart the desktop host"), "{error}");
        assert!(
            observed.try_recv().is_err(),
            "refused spawn reached the old host"
        );
        drop(client);
        host_task.await.unwrap();
    }

    #[tokio::test]
    async fn old_host_local_spawn_resolves_request_before_capability_gate() {
        for kind in ["none", "some", "error"] {
            let cwd = crate::workspace_env_fixture(kind);
            let request: crate::session::SpawnRequest = serde_json::from_value(serde_json::json!({
                "shell":"/bin/sh", "cwd":cwd.path(), "env":{"PORT":"user"}, "rows":24,"cols":80
            }))
            .unwrap();
            let result = local_spawn_payload(request.clone(), "default".into(), false).await;
            match kind {
                "none" => {
                    let payload = result.unwrap();
                    assert_eq!(payload["request"]["cwd"], cwd.path().to_str().unwrap());
                    assert_eq!(payload["request"]["env"]["PORT"], "user");
                    assert!(payload["workspaceEnv"]["env"].is_null());
                    assert_eq!(payload["profileId"], "default");
                }
                "some" => {
                    assert!(result.unwrap_err().contains("restart the desktop host"));
                    let payload = local_spawn_payload(request, "default".into(), true)
                        .await
                        .unwrap();
                    assert_eq!(payload["workspaceEnv"]["env"]["PORT"], "41000");
                    assert_eq!(payload["workspaceEnv"]["env"]["COGNIA_PORT"], "41000");
                    assert_eq!(payload["workspaceEnv"]["env"]["COGNIA_PORT_COUNT"], "10");
                }
                "error" => assert!(result.unwrap_err().contains("fixture port range exhausted")),
                _ => unreachable!(),
            }
        }
    }

    #[cfg(unix)]
    fn workspace_bridge_host(root: &Path) -> (crate::host::TerminalHost, crate::host::HostClient) {
        let host = crate::host::TerminalHost::new("workspace-test", Default::default()).unwrap();
        let local = host.connect(ClientIdentity::local("seed")).unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "shell": "/bin/sh", "args": ["-c", r#"printf '%s:%s:%s\n' "${COGNIA_PORT-unset}" "${COGNIA_PORT_COUNT-unset}" "$PORT" > observed"#],
            "cwd": root, "env": {"PORT": "user-port"}, "rows": 24, "cols": 80,
            "enableShellIntegration": false, "forceUtf8": false
        })).unwrap();
        host.sync_profile(&local.connection_id, "default".into(), request)
            .unwrap();
        (host, local)
    }

    #[cfg(unix)]
    fn workspace_bridge_identity() -> ClientIdentity {
        let mut identity = ClientIdentity::remote("native-proxy", "device", true);
        identity.workspace_env_bridge = true;
        identity
    }

    #[cfg(unix)]
    async fn workspace_bridge_reply(
        stream: &mut BoxedTerminalHostIo,
        sequence: u64,
    ) -> TerminalFrame {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = read_frame(stream)
                    .await
                    .unwrap()
                    .expect("bridge stays open");
                assert!(!matches!(
                    frame.kind,
                    FrameKind::WorkspaceEnvQuery | FrameKind::WorkspaceEnvResult
                ));
                if frame.sequence == sequence
                    && matches!(frame.kind, FrameKind::SessionSnapshot | FrameKind::Error)
                {
                    return frame;
                }
            }
        })
        .await
        .unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_env_bridge_resolves_each_remote_spawn_without_stale_profile_env() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let root = tempfile::tempdir().unwrap();
        let (host, local) = workspace_bridge_host(root.path());
        let (native, server) = tokio::io::duplex(128 * 1024);
        let serve = tokio::spawn(crate::host_wire::serve_host_stream(
            server,
            host.clone(),
            workspace_bridge_identity(),
            root.path().into(),
            root.path().join("known_hosts"),
        ));
        let mode = Arc::new(AtomicUsize::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let mode_in = mode.clone();
        let calls_in = calls.clone();
        let expected_cwd = root.path().to_string_lossy().into_owned();
        let mut client = workspace_env_bridge_with_resolver(Box::pin(native), move |request| {
            calls_in.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.cwd.as_deref(), Some(expected_cwd.as_str()));
            assert_eq!(
                request.env["PORT"], "user-port",
                "trusted lease must never overwrite stored profile"
            );
            assert!(!request.env.contains_key("COGNIA_PORT"));
            match mode_in.load(Ordering::SeqCst) {
                0 => Ok(crate::session::WorkspaceEnvResolution {
                    cwd: request.cwd.clone(),
                    env: Some(std::collections::BTreeMap::from([
                        ("PORT".into(), "41000".into()),
                        ("COGNIA_PORT".into(), "41000".into()),
                        ("COGNIA_PORT_COUNT".into(), "10".into()),
                    ])),
                }),
                1 => Ok(crate::session::WorkspaceEnvResolution {
                    cwd: None,
                    env: None,
                }),
                _ => Err("port range exhausted at execution".into()),
            }
        });
        // Paired clients cannot inject the internal native response kind.
        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::WorkspaceEnvResult,
                Uuid::new_v4(),
                7,
                b"{}".to_vec(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            workspace_bridge_reply(&mut client, 7).await.kind,
            FrameKind::Error
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        for value in 0..3 {
            mode.store(value, Ordering::SeqCst);
            let _ = std::fs::remove_file(root.path().join("observed"));
            let sequence = value as u64 + 10;
            write_frame(
                &mut client,
                &TerminalFrame::command(
                    FrameKind::Spawn,
                    Uuid::nil(),
                    sequence,
                    br#"{"profileId":"default"}"#.to_vec(),
                ),
            )
            .await
            .unwrap();
            let response = workspace_bridge_reply(&mut client, sequence).await;
            if value == 2 {
                assert_eq!(response.kind, FrameKind::Error);
                assert!(String::from_utf8_lossy(&response.payload)
                    .contains("port range exhausted at execution"));
                assert!(!root.path().join("observed").exists());
            } else {
                assert_eq!(response.kind, FrameKind::SessionSnapshot);
                let expected = if value == 0 {
                    "41000:10:41000"
                } else {
                    "unset:unset:user-port"
                };
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        if std::fs::read_to_string(root.path().join("observed"))
                            .is_ok_and(|value| value.trim() == expected)
                        {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(host.list(&local.connection_id).unwrap().len(), 2);
        drop(client);
        let _ = tokio::time::timeout(Duration::from_secs(2), serve)
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_env_bridge_disconnect_cancels_pending_resolution() {
        use std::sync::{mpsc, Arc, Mutex};
        let root = tempfile::tempdir().unwrap();
        let (host, local) = workspace_bridge_host(root.path());
        let (native, server) = tokio::io::duplex(128 * 1024);
        let serve = tokio::spawn(crate::host_wire::serve_host_stream(
            server,
            host.clone(),
            workspace_bridge_identity(),
            root.path().into(),
            root.path().join("known_hosts"),
        ));
        let (started, mut begun) = tokio::sync::mpsc::unbounded_channel();
        let (release, wait) = mpsc::channel();
        let wait = Arc::new(Mutex::new(wait));
        let mut client = workspace_env_bridge_with_resolver(Box::pin(native), move |_| {
            started.send(()).unwrap();
            let _ = wait.lock().unwrap().recv_timeout(Duration::from_secs(5));
            Ok(crate::session::WorkspaceEnvResolution {
                cwd: None,
                env: None,
            })
        });
        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::Spawn,
                Uuid::nil(),
                1,
                br#"{"profileId":"default"}"#.to_vec(),
            ),
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(2), begun.recv())
            .await
            .unwrap()
            .unwrap();
        drop(client);
        let stopped = tokio::time::timeout(Duration::from_secs(2), serve).await;
        let _ = release.send(());
        assert!(
            stopped.is_ok(),
            "disconnect must close host stream before resolution returns"
        );
        assert!(host.list(&local.connection_id).unwrap().is_empty());
        assert!(!root.path().join("observed").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_env_bridge_rejects_stale_or_forged_correlation() {
        for wrong_sequence in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (host, local) = workspace_bridge_host(root.path());
            let (mut native, server) = tokio::io::duplex(128 * 1024);
            let serve = tokio::spawn(crate::host_wire::serve_host_stream(
                server,
                host.clone(),
                workspace_bridge_identity(),
                root.path().into(),
                root.path().join("known_hosts"),
            ));
            write_frame(
                &mut native,
                &TerminalFrame::command(
                    FrameKind::Spawn,
                    Uuid::nil(),
                    1,
                    br#"{"profileId":"default"}"#.to_vec(),
                ),
            )
            .await
            .unwrap();
            let query = read_frame(&mut native).await.unwrap().unwrap();
            assert_eq!(query.kind, FrameKind::WorkspaceEnvQuery);
            let response = TerminalFrame::command(
                FrameKind::WorkspaceEnvResult,
                if wrong_sequence {
                    query.session_id
                } else {
                    Uuid::new_v4()
                },
                if wrong_sequence { 2 } else { query.sequence },
                serde_json::to_vec(&Ok::<_, String>(crate::session::WorkspaceEnvResolution {
                    cwd: None,
                    env: None,
                }))
                .unwrap(),
            );
            write_frame(&mut native, &response).await.unwrap();
            assert_eq!(
                read_frame(&mut native).await.unwrap().unwrap().kind,
                FrameKind::Error
            );
            assert!(host.list(&local.connection_id).unwrap().is_empty());
            drop(native);
            let _ = tokio::time::timeout(Duration::from_secs(2), serve)
                .await
                .unwrap();
        }
    }
    use super::*;

    #[test]
    fn only_explicit_authorization_enables_daemon_prompts_and_the_long_start_budget() {
        for mode in [
            TerminalHostStartMode::Background,
            TerminalHostStartMode::AuthorizeCredentials,
        ] {
            let mut command = Command::new("cognia-server");
            command.arg("desktop-host");
            mode.configure_command(&mut command);
            let args: Vec<_> = command.get_args().collect();
            assert_eq!(
                args.contains(&std::ffi::OsStr::new("--authorize-credentials")),
                mode == TerminalHostStartMode::AuthorizeCredentials
            );
        }
        assert_eq!(
            TerminalHostStartMode::default(),
            TerminalHostStartMode::Background
        );
        assert_eq!(TerminalHostStartMode::Background.retries(), 40);
        assert_eq!(TerminalHostStartMode::AuthorizeCredentials.retries(), 1200);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_authorization_startup_terminates_only_its_pending_child() {
        let child = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let pid = child.id() as i32;
        let (result, _, _) = run_policy(
            vec![unreachable()],
            SpawnedTerminalHost {
                child: Some(child),
                log_path: None,
                stop_on_drop: true,
            },
        )
        .await;
        assert!(result.is_err());
        // SAFETY: signal zero only checks whether this test-owned pid remains alive.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }

    #[tokio::test]
    async fn remote_stream_requests_time_out_when_the_host_never_responds() {
        let (client, _server) = tokio::io::duplex(4096);
        let mut stream: BoxedTerminalHostIo = Box::pin(client);

        let error = request_over_host_stream_with_timeout(
            &mut stream,
            TerminalFrame::command(FrameKind::List, Uuid::nil(), 7, Vec::new()),
            Duration::from_millis(10),
        )
        .await
        .unwrap_err();

        assert_eq!(error, "terminal host request timed out");
    }

    #[test]
    fn response_kinds_do_not_consume_stream_events_with_same_sequence() {
        assert!(is_response_kind(FrameKind::Ack));
        assert!(is_response_kind(FrameKind::SessionSnapshot));
        assert!(!is_response_kind(FrameKind::Stdout));
        assert!(!is_response_kind(FrameKind::Integration));
    }

    #[test]
    fn invalid_session_ids_are_rejected_before_native_io() {
        assert!(parse_session_id("not-a-uuid").is_err());
        assert!(parse_session_id(&Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn terminal_errors_keep_machine_readable_codes() {
        assert_eq!(
            error_code_name(TerminalErrorCode::NotController),
            "not_controller"
        );
        assert_eq!(
            error_code_name(TerminalErrorCode::ResourceLimit),
            "resource_limit"
        );
    }

    #[test]
    fn terminal_resources_live_under_the_app_resource_dir() {
        assert_eq!(terminal_resources(None), None);
        assert_eq!(
            terminal_resources(Some(Path::new("/app/Resources"))),
            Some(PathBuf::from("/app/Resources/terminal"))
        );
    }

    #[test]
    fn the_dev_workspace_root_is_the_repository() {
        let root = dev_workspace_root().expect("workspace root");
        assert!(root.join("src-tauri").join("Cargo.toml").is_file());
    }
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    /// Drive the start policy with scripted connect outcomes, counting spawns.
    async fn run_policy(
        outcomes: Vec<Result<u8, TerminalHostConnectError>>,
        spawned: SpawnedTerminalHost,
    ) -> (Result<u8, String>, usize, usize) {
        let outcomes = RefCell::new(VecDeque::from(outcomes));
        let attempts = Cell::new(0usize);
        let spawns = Cell::new(0usize);
        let spawned = RefCell::new(Some(spawned));
        let result = connect_with_start_policy(
            || {
                attempts.set(attempts.get() + 1);
                let next = outcomes.borrow_mut().pop_front().unwrap_or_else(|| {
                    Err(TerminalHostConnectError::Unreachable(
                        "terminal host socket connect failed: Connection refused".into(),
                    ))
                });
                async move { next }
            },
            || {
                spawns.set(spawns.get() + 1);
                let spawned = spawned.borrow_mut().take().unwrap();
                async move { Ok(spawned) }
            },
            5,
            Duration::from_millis(1),
        )
        .await;
        (result, attempts.get(), spawns.get())
    }

    fn unreachable() -> Result<u8, TerminalHostConnectError> {
        Err(TerminalHostConnectError::Unreachable(
            "terminal host socket connect failed: No such file or directory".into(),
        ))
    }

    /// Bug 2 regression: a Keychain refusal used to spawn a host and then be
    /// reported as the last retry's "Connection refused".
    #[tokio::test]
    async fn a_refused_credential_returns_at_once_without_spawning() {
        let (result, attempts, spawns) = run_policy(
            vec![Err(TerminalHostConnectError::CredentialUnavailable(
                "terminal credential read failed for com.cognia.terminal-host".into(),
            ))],
            SpawnedTerminalHost::default(),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "terminal credential read failed for com.cognia.terminal-host"
        );
        assert_eq!((attempts, spawns), (1, 0));
    }

    #[tokio::test]
    async fn a_listening_host_that_fails_the_connection_is_not_respawned() {
        let (result, attempts, spawns) = run_policy(
            vec![Err(TerminalHostConnectError::Failed(
                "terminal host socket connect failed: Permission denied".into(),
            ))],
            SpawnedTerminalHost::default(),
        )
        .await;
        assert!(result.unwrap_err().contains("Permission denied"));
        assert_eq!((attempts, spawns), (1, 0));
    }

    #[tokio::test]
    async fn an_absent_host_is_started_once_and_retried_until_it_answers() {
        let (result, attempts, spawns) = run_policy(
            vec![unreachable(), unreachable(), Ok(7)],
            SpawnedTerminalHost::default(),
        )
        .await;
        assert_eq!(result.unwrap(), 7);
        assert_eq!((attempts, spawns), (3, 1));
    }

    #[tokio::test]
    async fn a_credential_refusal_while_waiting_ends_the_wait() {
        let (result, attempts, spawns) = run_policy(
            vec![
                unreachable(),
                unreachable(),
                Err(TerminalHostConnectError::CredentialUnavailable(
                    "denied".into(),
                )),
                Ok(7),
            ],
            SpawnedTerminalHost::default(),
        )
        .await;
        assert_eq!(result.unwrap_err(), "denied");
        assert_eq!((attempts, spawns), (3, 1));
    }

    #[tokio::test]
    async fn the_most_telling_retry_error_is_reported_not_the_last() {
        let (result, attempts, spawns) = run_policy(
            vec![
                unreachable(),
                Err(TerminalHostConnectError::Failed(
                    "terminal host auth write failed: Broken pipe".into(),
                )),
                // Every later attempt: "Connection refused".
            ],
            SpawnedTerminalHost {
                child: None,
                log_path: Some(PathBuf::from("/tmp/terminal-host.log")),
                stop_on_drop: false,
            },
        )
        .await;
        let error = result.unwrap_err();
        assert!(error.contains("did not start within 5ms"), "{error}");
        assert!(error.contains("/tmp/terminal-host.log"), "{error}");
        assert!(error.contains("Broken pipe"), "{error}");
        assert!(!error.contains("Connection refused"), "{error}");
        assert_eq!((attempts, spawns), (6, 1));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_credential_refusal_keeps_authorization_available_to_its_client() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 77"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let (result, attempts, spawns) = run_policy(
            vec![unreachable()],
            SpawnedTerminalHost {
                child: Some(child),
                log_path: None,
                stop_on_drop: false,
            },
        )
        .await;
        let error = result.unwrap_err();
        assert!(
            error.starts_with("terminal_credential_unavailable:"),
            "{error}"
        );
        assert_eq!((attempts, spawns), (2, 1));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_host_that_exits_during_startup_ends_the_wait_with_its_status() {
        // Waited for here, so the first retry sees the status (`try_wait`
        // returns the recorded one).
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 3"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let (result, attempts, spawns) = run_policy(
            vec![unreachable()],
            SpawnedTerminalHost {
                child: Some(child),
                log_path: None,
                stop_on_drop: false,
            },
        )
        .await;
        let error = result.unwrap_err();
        assert!(error.contains("exited during startup"), "{error}");
        assert!(error.contains('3'), "{error}");
        // The initial attempt, then one more after the exit was seen.
        assert_eq!((attempts, spawns), (2, 1));
    }
}
