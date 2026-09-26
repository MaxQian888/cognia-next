//! Tauri-free client for the durable terminal host (ADR-0196 P6e).
//!
//! Starting the host binary when nothing answers, one-shot identity-scoped
//! connections for the companion's terminal socket and RPC arms, the SFTP and
//! remote list/kill/configure/profile calls, and the settings snapshot. The
//! desktop's long-lived bridge (`host_bridge`) reuses the spawn and framing
//! helpers. Callers pass the app's resource dir, where the host finds its
//! shell-integration scripts; the headless server has none and passes `None`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::host::{ClientIdentity, HostSessionInfo};
use crate::host_wire::{read_frame, write_frame};
use crate::protocol::{FrameKind, TerminalErrorCode, TerminalFrame};
use crate::terminal_host_service::{
    connect_terminal_host_as, default_terminal_host_endpoint, load_terminal_host_settings,
    save_terminal_host_settings, BoxedTerminalHostIo, TerminalHostDescriptor, TerminalHostSettings,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const START_RETRY_COUNT: usize = 40;
pub const START_RETRY_DELAY: Duration = Duration::from_millis(100);

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

fn spawn_terminal_host(
    endpoint: &str,
    terminal_resource_dir: Option<PathBuf>,
) -> Result<(), String> {
    let binary = resolve_server_binary()?;
    let mut command = Command::new(&binary);
    command
        .arg("desktop-host")
        .arg("--endpoint")
        .arg(endpoint)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(resource_dir) = terminal_resource_dir {
        command.env("COGNIA_TERMINAL_RESOURCES", resource_dir);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to start {}: {error}", binary.display()))
}

pub async fn spawn_terminal_host_async(
    endpoint: String,
    terminal_resource_dir: Option<PathBuf>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || spawn_terminal_host(&endpoint, terminal_resource_dir))
        .await
        .map_err(|error| format!("terminal host spawn task failed: {error}"))?
}

/// Open an authenticated, identity-scoped connection for a non-renderer
/// adapter such as the Companion WebSocket route.
pub async fn connect_terminal_host_client(
    resource_dir: Option<&Path>,
    identity: ClientIdentity,
) -> Result<BoxedTerminalHostIo, String> {
    let endpoint = default_terminal_host_endpoint();
    if let Ok(stream) = connect_terminal_host_as(&endpoint, identity.clone()).await {
        return Ok(stream);
    }
    spawn_terminal_host_async(endpoint.clone(), terminal_resources(resource_dir)).await?;
    let mut last_error = "terminal host did not start".to_string();
    for _ in 0..START_RETRY_COUNT {
        tokio::time::sleep(START_RETRY_DELAY).await;
        match connect_terminal_host_as(&endpoint, identity.clone()).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
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
    use super::*;

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
}
