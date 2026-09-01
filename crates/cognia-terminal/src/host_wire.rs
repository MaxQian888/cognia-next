//! Length-delimited terminal-host stream dispatcher.
//!
//! Local sockets, named pipes, WebSockets, and WebRTC adapters all terminate
//! in the same [`TerminalFrame`] command loop. Authentication happens before
//! entering this module; this layer owns command validation and host calls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

use crate::host::{ClientIdentity, HostError, HostEvent, TerminalHost, TerminalHostConfig};
use crate::host_capabilities::{host_capabilities, TerminalHostCapabilities};
use crate::protocol::{FrameKind, TerminalFrame, HEADER_LEN, MAX_FRAME_PAYLOAD};
use crate::session::{PathInjection, SpawnRequest};
use crate::ssh::SshSpawnRequest;
use crate::ssh_forward::ForwardStatus;

const MAX_WIRE_FRAME: usize = HEADER_LEN + MAX_FRAME_PAYLOAD;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnPayload {
    profile_id: String,
    request: Option<SpawnRequest>,
    ssh_request: Option<SshSpawnRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachPayload {
    resume_after: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloPayload {
    config: Option<TerminalHostConfig>,
    profiles: Option<Vec<ProfilePayload>>,
    ssh_profiles: Option<Vec<SshProfilePayload>>,
    path_injection: Option<PathInjectionPayload>,
    /// Install `profiles` as the set owned by this paired device instead of
    /// replacing the shared one.
    ///
    /// Only the host process sends this, servicing an authenticated
    /// `terminal_host_sync_profiles` RPC — the frame is still refused unless
    /// the connection is local, so a paired client cannot reach it by talking
    /// to the socket itself. It exists because a remote spawn names a profile
    /// and nothing else, which used to leave a headless host with only its
    /// bootstrap `default` and every configured profile id unknown.
    on_behalf_of_device: Option<String>,
}

/// Wire form of [`PathInjection`].
///
/// Directories travel as `String`, not `PathBuf`: serde's `PathBuf` impl
/// *errors* on a non-UTF-8 path, which would fail the whole hello — config,
/// profiles and all — because of one odd `$HOME`. The sender drops
/// unrepresentable entries instead, so everything else still syncs.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathInjectionPayload {
    #[serde(default)]
    prepend: Vec<String>,
    #[serde(default)]
    append: Vec<String>,
}

impl From<PathInjectionPayload> for PathInjection {
    fn from(payload: PathInjectionPayload) -> Self {
        Self {
            prepend: payload.prepend.into_iter().map(PathBuf::from).collect(),
            append: payload.append.into_iter().map(PathBuf::from).collect(),
        }
    }
}

/// Capabilities this host build understands, advertised in the hello ack.
///
/// The bridge reuses an already-running host, which may be an older binary
/// installed as a login service — clients check this list before sending a
/// command that an older host would reject as an unknown frame kind.
const PROTOCOL_FEATURES: &[&str] = &["pathInjection", "flowControl", "history", "sshForwarding"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilePayload {
    profile_id: String,
    request: SpawnRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshProfilePayload {
    profile_id: String,
    request: SshSpawnRequest,
}

#[derive(Debug, Deserialize)]
struct ResizePayload {
    rows: u16,
    cols: u16,
}

#[derive(Debug, Deserialize)]
struct FlowControlPayload {
    paused: bool,
}

/// Read the forwards, or change one and read them back.
///
/// A toggle answers with the same snapshot a plain read would, so the UI never
/// has to guess what its own change did — it gets the post-change truth in the
/// reply it was already waiting for.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SshForwardControlPayload {
    Status,
    #[serde(rename_all = "camelCase")]
    SetEnabled {
        forward_id: String,
        enabled: bool,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshForwardSnapshotPayload {
    forwards: Vec<ForwardStatus>,
}

/// Client to host, frame 26. Host-local only (ADR-0162).
///
/// `onBehalfOfDevice` is the attribution the RPC layer supplies after it has
/// authorized the caller. It is safe as an argument precisely because
/// `TerminalHost::sftp_actor` refuses this frame on a non-local connection, so
/// nothing a paired device can send ever reaches it.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SftpControlPayload {
    Sessions,
    #[serde(rename_all = "camelCase")]
    ListDir {
        profile_id: String,
        path: String,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Stat {
        profile_id: String,
        path: String,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Realpath {
        profile_id: String,
        path: String,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    CreateDir {
        profile_id: String,
        path: String,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Rename {
        profile_id: String,
        from: String,
        to: String,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Remove {
        profile_id: String,
        path: String,
        #[serde(default)]
        is_dir: bool,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReadChunk {
        profile_id: String,
        path: String,
        offset: u64,
        length: usize,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    WriteChunk {
        profile_id: String,
        path: String,
        offset: u64,
        /// Base64. JSON has no byte string, and a number array would cost
        /// roughly four bytes on the wire per byte transferred.
        data: String,
        on_behalf_of_device: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    CloseProfile {
        profile_id: String,
    },
}

/// Host to client, frame 27.
///
/// An SFTP failure comes back as `failed` rather than as an error frame. A
/// server answering "permission denied" for `/etc/shadow` is a *result*: the
/// call reached the machine and the machine said no. Reporting it as a protocol
/// error would merge it with "this frame is malformed", and the RPC layer needs
/// the code to tell a caller which of the two happened.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SftpSnapshotPayload {
    Entries {
        entries: Vec<crate::sftp::SftpEntry>,
    },
    Entry {
        entry: crate::sftp::SftpEntry,
    },
    Path {
        path: String,
    },
    Chunk {
        /// Base64, and shorter than requested at end of file.
        data: String,
        eof: bool,
    },
    #[serde(rename_all = "camelCase")]
    Written {
        /// The host's write head after this chunk, which is the client's
        /// resume point.
        write_head: u64,
    },
    Sessions {
        sessions: Vec<crate::sftp::SftpSessionInfo>,
    },
    Closed {
        closed: usize,
    },
    Ok,
    Failed {
        code: &'static str,
        message: String,
    },
}

impl SftpSnapshotPayload {
    fn from_failure(error: crate::sftp::SftpError) -> Self {
        Self::Failed {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportStatePayload {
    state: crate::host::HostTransportState,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AckPayload<'a> {
    ok: bool,
    host_id: String,
    protocol_features: &'static [&'static str],
    /// Present on the hello ack and the host snapshot only.
    ///
    /// Every other ack answers a hot command (`Resize` fires on each window
    /// drag), and a remote client only needs this once per connection — so it
    /// rides the two frames it is already guaranteed to see before it can
    /// spawn anything, and nowhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<&'a TerminalHostCapabilities>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshotPayload<'a, T> {
    host_id: String,
    sessions: T,
    /// See [`AckPayload::host`]. Carried here too because reattaching after a
    /// page reload lists before it spawns, and that path never sends a hello.
    host: Option<&'a TerminalHostCapabilities>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    code: crate::protocol::TerminalErrorCode,
    message: String,
}

pub async fn serve_host_stream<S>(
    mut stream: S,
    host: TerminalHost,
    identity: ClientIdentity,
    script_dir: PathBuf,
    known_hosts_path: PathBuf,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut client = host.connect(identity).map_err(|error| error.to_string())?;
    loop {
        tokio::select! {
            incoming = read_frame(&mut stream) => {
                let Some(frame) = incoming? else {
                    return Ok(());
                };
                let response = dispatch_command(
                    &host,
                    &client.connection_id,
                    frame,
                    &script_dir,
                    &known_hosts_path,
                ).await;
                match response {
                    Ok(frames) => {
                        for frame in frames {
                            write_frame(&mut stream, &frame).await?;
                        }
                    }
                    Err((sequence, session_id, error)) => {
                        write_frame(&mut stream, &error_frame(sequence, session_id, error)).await?;
                    }
                }
            }
            event = client.events.recv() => {
                let Some(event) = event else {
                    return Ok(());
                };
                write_frame(&mut stream, &host_event_frame(event)?).await?;
            }
        }
    }
}

async fn dispatch_command(
    host: &TerminalHost,
    connection_id: &str,
    frame: TerminalFrame,
    script_dir: &Path,
    known_hosts_path: &Path,
) -> Result<Vec<TerminalFrame>, (u64, Uuid, HostError)> {
    let sequence = frame.sequence;
    let session_id = frame.session_id;
    let result: Result<TerminalFrame, HostError> = match frame.kind {
        FrameKind::Hello => {
            let payload = if frame.payload.is_empty() {
                Ok(HelloPayload::default())
            } else {
                parse_json::<HelloPayload>(&frame.payload)
            };
            payload.and_then(|payload| {
                if let Some(config) = payload.config {
                    host.update_config(connection_id, config)?;
                }
                if let Some(path) = payload.path_injection {
                    host.set_path_injection(connection_id, path.into())?;
                }
                match payload.on_behalf_of_device.as_deref() {
                    // A device's set is replaced within its own namespace, so a
                    // phone syncing cannot erase the desktop user's profiles —
                    // which folding both into the shared map would do on every
                    // sync, because that map is replaced wholesale.
                    Some(device_id) => {
                        if payload.ssh_profiles.is_some() {
                            return Err(HostError::InvalidRequest(
                                "SSH profiles cannot be synchronized on behalf of a device".into(),
                            ));
                        }
                        host.replace_device_profiles(
                            connection_id,
                            device_id,
                            payload
                                .profiles
                                .unwrap_or_default()
                                .into_iter()
                                .map(|profile| (profile.profile_id, profile.request))
                                .collect::<HashMap<_, _>>(),
                        )?;
                    }
                    None => {
                        if payload.profiles.is_some() || payload.ssh_profiles.is_some() {
                            host.replace_synchronized_profiles(
                                connection_id,
                                payload
                                    .profiles
                                    .unwrap_or_default()
                                    .into_iter()
                                    .map(|profile| (profile.profile_id, profile.request))
                                    .collect::<HashMap<_, _>>(),
                                payload
                                    .ssh_profiles
                                    .unwrap_or_default()
                                    .into_iter()
                                    .map(|profile| (profile.profile_id, profile.request))
                                    .collect::<HashMap<_, _>>(),
                            )?;
                        }
                    }
                }
                hello_ack_frame(host, session_id, sequence)
            })
        }
        FrameKind::List => host.list(connection_id).and_then(|sessions| {
            json_frame(
                FrameKind::HostSnapshot,
                session_id,
                sequence,
                &HostSnapshotPayload {
                    host_id: host.host_id().to_string(),
                    sessions,
                    host: Some(host_capabilities()),
                },
            )
            .map_err(HostError::InvalidRequest)
        }),
        FrameKind::Spawn => match parse_json::<SpawnPayload>(&frame.payload) {
            Ok(payload) => match (payload.request, payload.ssh_request) {
                (Some(request), None) => {
                    host.spawn_local(connection_id, payload.profile_id, request, script_dir)
                }
                (None, Some(request)) => {
                    match host.sync_ssh_profile(connection_id, payload.profile_id.clone(), request)
                    {
                        Ok(()) => {
                            host.spawn_synchronized_profile(
                                connection_id,
                                payload.profile_id,
                                script_dir,
                                known_hosts_path,
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    }
                }
                (None, None) => {
                    host.spawn_synchronized_profile(
                        connection_id,
                        payload.profile_id,
                        script_dir,
                        known_hosts_path,
                    )
                    .await
                }
                (Some(_), Some(_)) => Err(HostError::InvalidRequest(
                    "spawn accepts either a local PTY request or an SSH request".into(),
                )),
            }
            .and_then(|session| {
                json_frame(
                    FrameKind::SessionSnapshot,
                    Uuid::parse_str(&session.id).unwrap_or(Uuid::nil()),
                    sequence,
                    &session,
                )
                .map_err(HostError::InvalidRequest)
            }),
            Err(error) => Err(error),
        },
        FrameKind::Attach => parse_json::<AttachPayload>(&frame.payload).and_then(|payload| {
            host.attach(connection_id, &session_id.to_string(), payload.resume_after)
                .and_then(|session| {
                    json_frame(FrameKind::SessionSnapshot, session_id, sequence, &session)
                        .map_err(HostError::InvalidRequest)
                })
        }),
        FrameKind::Detach => host
            .detach(connection_id, &session_id.to_string())
            .and_then(|()| ack_frame(host, session_id, sequence)),
        FrameKind::TakeControl => host
            .take_control(connection_id, &session_id.to_string())
            .and_then(|()| ack_frame(host, session_id, sequence)),
        FrameKind::ReleaseControl => host
            .release_control(connection_id, &session_id.to_string())
            .and_then(|()| ack_frame(host, session_id, sequence)),
        FrameKind::Resize => parse_json::<ResizePayload>(&frame.payload).and_then(|payload| {
            host.resize(
                connection_id,
                &session_id.to_string(),
                payload.rows,
                payload.cols,
            )
            .and_then(|()| ack_frame(host, session_id, sequence))
        }),
        FrameKind::Kill => host
            .kill(connection_id, &session_id.to_string())
            .and_then(|()| ack_frame(host, session_id, sequence)),
        FrameKind::Stdin => host
            .write(connection_id, &session_id.to_string(), &frame.payload)
            .and_then(|()| ack_frame(host, session_id, sequence)),
        FrameKind::FlowControl => {
            parse_json::<FlowControlPayload>(&frame.payload).and_then(|payload| {
                host.set_flow_control(connection_id, &session_id.to_string(), payload.paused)
                    .and_then(|()| ack_frame(host, session_id, sequence))
            })
        }
        FrameKind::SshForwardControl => parse_json::<SshForwardControlPayload>(&frame.payload)
            .and_then(|payload| match payload {
                SshForwardControlPayload::Status => {
                    host.forward_status(connection_id, &session_id.to_string())
                }
                SshForwardControlPayload::SetEnabled {
                    forward_id,
                    enabled,
                } => host.set_forward_enabled(
                    connection_id,
                    &session_id.to_string(),
                    &forward_id,
                    enabled,
                ),
            })
            .and_then(|forwards| {
                json_frame(
                    FrameKind::SshForwardSnapshot,
                    session_id,
                    sequence,
                    &SshForwardSnapshotPayload { forwards },
                )
                .map_err(HostError::InvalidRequest)
            }),
        FrameKind::SftpControl => match parse_json::<SftpControlPayload>(&frame.payload) {
            Ok(payload) => match sftp_command(host, connection_id, payload, known_hosts_path).await
            {
                Ok(snapshot) => {
                    json_frame(FrameKind::SftpSnapshot, session_id, sequence, &snapshot)
                        .map_err(HostError::InvalidRequest)
                }
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        },
        _ => Err(HostError::InvalidRequest(format!(
            "frame kind {:?} is not a client command",
            frame.kind
        ))),
    };
    result
        .map(|frame| vec![frame])
        .map_err(|error| (sequence, session_id, error))
}

fn parse_json<T: for<'de> Deserialize<'de>>(payload: &[u8]) -> Result<T, HostError> {
    serde_json::from_slice(payload)
        .map_err(|error| HostError::InvalidRequest(format!("invalid command payload: {error}")))
}

fn ack_frame(
    host: &TerminalHost,
    session_id: Uuid,
    sequence: u64,
) -> Result<TerminalFrame, HostError> {
    ack_frame_with(host, session_id, sequence, None)
}

/// The hello ack — the one ack that also describes the host, so a remote
/// client learns which platform and shells it is about to spawn on.
fn hello_ack_frame(
    host: &TerminalHost,
    session_id: Uuid,
    sequence: u64,
) -> Result<TerminalFrame, HostError> {
    ack_frame_with(host, session_id, sequence, Some(host_capabilities()))
}

fn ack_frame_with(
    host: &TerminalHost,
    session_id: Uuid,
    sequence: u64,
    capabilities: Option<&TerminalHostCapabilities>,
) -> Result<TerminalFrame, HostError> {
    json_frame(
        FrameKind::Ack,
        session_id,
        sequence,
        &AckPayload {
            ok: true,
            host_id: host.host_id().to_string(),
            protocol_features: PROTOCOL_FEATURES,
            host: capabilities,
        },
    )
    .map_err(HostError::InvalidRequest)
}

fn json_frame<T: Serialize>(
    kind: FrameKind,
    session_id: Uuid,
    sequence: u64,
    payload: &T,
) -> Result<TerminalFrame, String> {
    let payload = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    if payload.len() > MAX_FRAME_PAYLOAD {
        return Err("terminal JSON response exceeds frame limit".into());
    }
    Ok(TerminalFrame::command(kind, session_id, sequence, payload))
}

/// Run one SFTP command, refusing a non-local connection before anything else.
///
/// The two error channels are deliberately different. A caller that is not
/// entitled to this frame at all, or that named a profile this host has never
/// been given, gets a `HostError` and therefore an error frame. A caller that
/// reached the remote machine and was refused by it gets a `Failed` snapshot
/// carrying the server's own words, because that is an answer rather than a
/// protocol fault.
async fn sftp_command(
    host: &TerminalHost,
    connection_id: &str,
    payload: SftpControlPayload,
    known_hosts_path: &Path,
) -> Result<SftpSnapshotPayload, HostError> {
    use base64::Engine as _;
    const B64: base64::engine::general_purpose::GeneralPurpose =
        base64::engine::general_purpose::STANDARD;

    // `Sessions` and `CloseProfile` carry no device attribution: one is a read
    // of this host's own state and the other is the host tidying up after
    // itself, and neither is an operation on somebody's remote machine.
    let device = match &payload {
        SftpControlPayload::Sessions | SftpControlPayload::CloseProfile { .. } => None,
        SftpControlPayload::ListDir {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::Stat {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::Realpath {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::CreateDir {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::Rename {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::Remove {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::ReadChunk {
            on_behalf_of_device,
            ..
        }
        | SftpControlPayload::WriteChunk {
            on_behalf_of_device,
            ..
        } => on_behalf_of_device.clone(),
    };
    let actor = host.sftp_actor(connection_id, device.as_deref())?;

    let outcome = match payload {
        SftpControlPayload::Sessions => {
            return Ok(SftpSnapshotPayload::Sessions {
                sessions: host.sftp_sessions(connection_id)?,
            })
        }
        SftpControlPayload::CloseProfile { profile_id } => {
            return Ok(SftpSnapshotPayload::Closed {
                closed: host.sftp_close_profile(connection_id, &profile_id)?,
            })
        }
        SftpControlPayload::ListDir {
            profile_id, path, ..
        } => host
            .sftp_list_dir(&actor, &profile_id, &path, known_hosts_path)
            .await
            .map(|entries| SftpSnapshotPayload::Entries { entries }),
        SftpControlPayload::Stat {
            profile_id, path, ..
        } => host
            .sftp_stat(&actor, &profile_id, &path, known_hosts_path)
            .await
            .map(|entry| SftpSnapshotPayload::Entry { entry }),
        SftpControlPayload::Realpath {
            profile_id, path, ..
        } => host
            .sftp_realpath(&actor, &profile_id, &path, known_hosts_path)
            .await
            .map(|path| SftpSnapshotPayload::Path { path }),
        SftpControlPayload::CreateDir {
            profile_id, path, ..
        } => host
            .sftp_create_dir(&actor, &profile_id, &path, known_hosts_path)
            .await
            .map(|()| SftpSnapshotPayload::Ok),
        SftpControlPayload::Rename {
            profile_id,
            from,
            to,
            ..
        } => host
            .sftp_rename(&actor, &profile_id, &from, &to, known_hosts_path)
            .await
            .map(|()| SftpSnapshotPayload::Ok),
        SftpControlPayload::Remove {
            profile_id,
            path,
            is_dir,
            ..
        } => host
            .sftp_remove(&actor, &profile_id, &path, is_dir, known_hosts_path)
            .await
            .map(|()| SftpSnapshotPayload::Ok),
        SftpControlPayload::ReadChunk {
            profile_id,
            path,
            offset,
            length,
            ..
        } => host
            .sftp_read_chunk(&actor, &profile_id, &path, offset, length, known_hosts_path)
            .await
            .map(|bytes| SftpSnapshotPayload::Chunk {
                // Short means end of file, and the caller stops. `read_chunk_on`
                // loops over partial reads precisely so this stays true.
                eof: bytes.len() < length,
                data: B64.encode(&bytes),
            }),
        SftpControlPayload::WriteChunk {
            profile_id,
            path,
            offset,
            data,
            ..
        } => match B64.decode(data.as_bytes()) {
            Ok(bytes) => host
                .sftp_write_chunk(&actor, &profile_id, &path, offset, &bytes, known_hosts_path)
                .await
                .map(|write_head| SftpSnapshotPayload::Written { write_head }),
            Err(error) => Err(crate::sftp::SftpError::InvalidRequest(format!(
                "chunk is not valid base64: {error}"
            ))),
        },
    };
    Ok(outcome.unwrap_or_else(SftpSnapshotPayload::from_failure))
}

fn error_frame(sequence: u64, session_id: Uuid, error: HostError) -> TerminalFrame {
    let payload = serde_json::to_vec(&ErrorPayload {
        code: error.code(),
        message: error.to_string(),
    })
    .unwrap_or_else(|_| b"{\"code\":\"invalid_request\",\"message\":\"terminal error\"}".to_vec());
    TerminalFrame::command(FrameKind::Error, session_id, sequence, payload)
}

fn host_event_frame(event: HostEvent) -> Result<TerminalFrame, String> {
    match event {
        HostEvent::Output {
            session_id,
            sequence,
            bytes,
        } => Ok(TerminalFrame::command(
            FrameKind::Stdout,
            parse_session_id(&session_id)?,
            sequence,
            bytes,
        )),
        HostEvent::Integration {
            session_id,
            sequence,
            event,
        } => json_frame(
            FrameKind::Integration,
            parse_session_id(&session_id)?,
            sequence,
            &event,
        ),
        HostEvent::ControllerChanged {
            session_id,
            controller,
        } => json_frame(
            FrameKind::ControllerChanged,
            parse_session_id(&session_id)?,
            0,
            &serde_json::json!({ "controller": controller }),
        ),
        HostEvent::TransportState {
            session_id,
            state,
            message,
        } => json_frame(
            FrameKind::TransportState,
            parse_session_id(&session_id)?,
            0,
            &TransportStatePayload { state, message },
        ),
        HostEvent::ReplayGap {
            session_id,
            requested_after,
            first_available,
            last_available,
        } => json_frame(
            FrameKind::ReplayGap,
            parse_session_id(&session_id)?,
            0,
            &serde_json::json!({
                "requestedAfter": requested_after,
                "firstAvailable": first_available,
                "lastAvailable": last_available,
            }),
        ),
        HostEvent::Exit {
            session_id,
            sequence,
            code,
        } => json_frame(
            FrameKind::Exit,
            parse_session_id(&session_id)?,
            sequence,
            &serde_json::json!({ "code": code }),
        ),
        HostEvent::SessionSnapshot { session } => json_frame(
            FrameKind::SessionSnapshot,
            parse_session_id(&session.id)?,
            0,
            &session,
        ),
        HostEvent::Error {
            code,
            message,
            session_id,
        } => {
            let id = session_id
                .as_deref()
                .map(parse_session_id)
                .transpose()?
                .unwrap_or(Uuid::nil());
            json_frame(FrameKind::Error, id, 0, &ErrorPayload { code, message })
        }
    }
}

fn parse_session_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "host emitted an invalid terminal session id".into())
}

pub async fn read_frame<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<Option<TerminalFrame>, String> {
    let length = match stream.read_u32().await {
        Ok(length) => length as usize,
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(format!("terminal frame length read failed: {error}")),
    };
    if !(HEADER_LEN..=MAX_WIRE_FRAME).contains(&length) {
        return Err(format!(
            "terminal frame length {length} is outside allowed bounds"
        ));
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|error| format!("terminal frame read failed: {error}"))?;
    TerminalFrame::decode(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub async fn write_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    frame: &TerminalFrame,
) -> Result<(), String> {
    let bytes = frame.encode().map_err(|error| error.to_string())?;
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|error| format!("terminal frame length write failed: {error}"))?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|error| format!("terminal frame write failed: {error}"))?;
    stream
        .flush()
        .await
        .map_err(|error| format!("terminal frame flush failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::TerminalHostConfig;
    use crate::protocol::FrameKind;

    fn test_config() -> TerminalHostConfig {
        TerminalHostConfig {
            replay_bytes_per_session: 64 * 1024,
            total_replay_bytes: 128 * 1024,
            ..TerminalHostConfig::default()
        }
    }

    fn ssh_profile_request() -> crate::ssh::SshSpawnRequest {
        crate::ssh::SshSpawnRequest {
            host: "prod.example".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: crate::ssh::SshAuthMethod::Password,
            credential_ref: Some("production".into()),
            private_key_path: None,
            rows: 24,
            cols: 80,
            project_id: None,
            profile_id: "production".into(),
            display_name: "Production".into(),
            jump_chain: Vec::new(),
            local_forwards: Vec::new(),
            remote_forwards: Vec::new(),
        }
    }

    #[tokio::test]
    async fn list_round_trip_uses_the_canonical_host_dispatcher() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(FrameKind::List, Uuid::nil(), 7, Vec::new()),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::HostSnapshot);
        assert_eq!(response.sequence, 7);
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(payload["hostId"], "host-test");
        assert_eq!(payload["sessions"], serde_json::json!([]));
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// A reattaching remote client lists before it spawns and never sends a
    /// hello, so the snapshot is its only chance to learn which shell exists
    /// on the host it is about to spawn on.
    #[tokio::test]
    async fn the_host_snapshot_describes_the_host_it_snapshots() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(FrameKind::List, Uuid::nil(), 1, Vec::new()),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(
            payload["host"]["defaultShell"],
            serde_json::Value::String(host_capabilities().default_shell.clone())
        );
        assert!(payload["host"]["platform"].is_string());
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// The RPC path: the host process connects to itself as a local client and
    /// installs a paired device's profiles on its behalf. Without this a remote
    /// spawn could only ever name a profile the host already had.
    #[tokio::test]
    async fn a_hello_can_install_profiles_on_behalf_of_a_device() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host.clone(),
            ClientIdentity::local("companion-rpc"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::Hello,
                Uuid::nil(),
                1,
                serde_json::to_vec(&serde_json::json!({
                    "onBehalfOfDevice": "device-a",
                    "profiles": [{
                        "profileId": "build",
                        "request": {
                            "shell": "/bin/bash",
                            "rows": 24,
                            "cols": 80,
                            "cwd": null,
                            "projectId": null,
                            "extensionId": null,
                        },
                    }],
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Ack);
        assert_eq!(host.device_profile_count("device-a"), 1);
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// An SSH profile names a destination and a credential; installing one for
    /// a paired device would let it drive outbound connections from the host.
    #[tokio::test]
    async fn a_device_hello_refuses_ssh_profiles() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host.clone(),
            ClientIdentity::local("companion-rpc"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::Hello,
                Uuid::nil(),
                1,
                serde_json::to_vec(&serde_json::json!({
                    "onBehalfOfDevice": "device-a",
                    "sshProfiles": [],
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Error);
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// Hot commands must not pay for the host description. `Resize` fires on
    /// every window drag and `Stdin` on every keystroke; carrying a
    /// filesystem-derived shell list on each one would put that blob in the
    /// middle of the interactive path.
    #[test]
    fn only_the_hello_ack_carries_the_host_description() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();

        let hello = hello_ack_frame(&host, Uuid::nil(), 1).unwrap();
        let hello_payload: serde_json::Value = serde_json::from_slice(&hello.payload).unwrap();
        assert!(
            hello_payload["host"]["defaultShell"].is_string(),
            "the hello ack is where a connecting client learns the host"
        );

        let plain = ack_frame(&host, Uuid::nil(), 2).unwrap();
        let plain_payload: serde_json::Value = serde_json::from_slice(&plain.payload).unwrap();
        assert!(
            plain_payload.get("host").is_none(),
            "resize/stdin acks must stay lean"
        );
        assert_eq!(plain_payload["ok"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn hello_updates_path_injection_and_advertises_protocol_features() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let observed = host.clone();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        let payload = serde_json::to_vec(&serde_json::json!({
            "pathInjection": {
                "prepend": ["/opt/cognia/bin"],
                "append": ["/home/dev/.cargo/bin"],
            },
        }))
        .unwrap();
        write_frame(
            &mut client,
            &TerminalFrame::command(FrameKind::Hello, Uuid::nil(), 1, payload),
        )
        .await
        .unwrap();

        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Ack);
        let ack: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(ack["ok"], true);
        assert_eq!(
            ack["protocolFeatures"],
            serde_json::json!(["pathInjection", "flowControl", "history", "sshForwarding"])
        );

        let applied = observed.path_injection();
        assert_eq!(applied.prepend, vec![PathBuf::from("/opt/cognia/bin")]);
        assert_eq!(applied.append, vec![PathBuf::from("/home/dev/.cargo/bin")]);

        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// Forward compatibility: a client newer than the host sends fields this
    /// build has never heard of. `HelloPayload` must ignore them rather than
    /// failing the handshake — otherwise upgrading the app would break every
    /// already-installed login-service host.
    #[tokio::test]
    async fn hello_ignores_unknown_fields_from_a_newer_client() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        let payload = serde_json::to_vec(&serde_json::json!({
            "somethingFromTheFuture": { "nested": [1, 2, 3] },
            "pathInjection": { "prepend": ["/opt/cognia/bin"] },
        }))
        .unwrap();
        write_frame(
            &mut client,
            &TerminalFrame::command(FrameKind::Hello, Uuid::nil(), 4, payload),
        )
        .await
        .unwrap();

        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Ack);
        assert_eq!(response.sequence, 4);

        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// A remote client may not rewrite the host's PATH; the hello must fail
    /// loudly rather than silently ignoring the field.
    #[tokio::test]
    async fn hello_rejects_a_path_injection_from_a_remote_client() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let observed = host.clone();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::remote("phone", "device-a", true),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        let payload = serde_json::to_vec(&serde_json::json!({
            "pathInjection": { "prepend": ["/tmp/evil"] },
        }))
        .unwrap();
        write_frame(
            &mut client,
            &TerminalFrame::command(FrameKind::Hello, Uuid::nil(), 2, payload),
        )
        .await
        .unwrap();

        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Error);
        assert!(observed.path_injection().prepend.is_empty());

        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// The security property that lets frames 26 and 27 exist at all.
    ///
    /// `/ws/terminal` is a transparent byte pipe, so any frame a paired device
    /// may send is one every device holding `terminal.open` may send. SFTP is
    /// authorized by `ssh.files` at the RPC layer instead, and this refusal is
    /// what stops the frame from being a way around that. Without it, the
    /// separate grant ADR-0162 spends a section justifying would be decorative.
    #[tokio::test]
    async fn a_device_connection_cannot_reach_the_sftp_frame() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::remote("phone", "device-a", true),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::SftpControl,
                Uuid::nil(),
                3,
                serde_json::to_vec(&serde_json::json!({
                    "kind": "listDir",
                    "profileId": "production",
                    "path": "/etc",
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Error);
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(payload["code"], "permission_denied");
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// Even the read that names no machine. Listing the host's live transfers
    /// tells a caller which production boxes this desktop is talking to, which
    /// is not a device's business either.
    #[tokio::test]
    async fn a_device_connection_cannot_list_the_hosts_transfers() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::remote("phone", "device-a", true),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::SftpControl,
                Uuid::nil(),
                1,
                serde_json::to_vec(&serde_json::json!({ "kind": "sessions" })).unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::Error);
        drop(client);
        serve.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_local_client_reads_an_empty_transfer_list() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::SftpControl,
                Uuid::nil(),
                9,
                serde_json::to_vec(&serde_json::json!({ "kind": "sessions" })).unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::SftpSnapshot);
        assert_eq!(response.sequence, 9);
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(payload["kind"], "sessions");
        assert_eq!(payload["sessions"], serde_json::json!([]));
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// A profile the desktop never synchronized is refused before any network
    /// call, and the refusal names a code the RPC layer can classify.
    ///
    /// This is ADR-0082 decision 8 restated for files: the device names an
    /// identifier, the desktop decides what it points at, and an identifier
    /// that points at nothing is not an invitation to dial anything.
    #[tokio::test]
    async fn an_unsynchronized_profile_fails_without_dialling() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::SftpControl,
                Uuid::nil(),
                4,
                serde_json::to_vec(&serde_json::json!({
                    "kind": "listDir",
                    "profileId": "never-synchronized",
                    "path": "/var/log",
                    "onBehalfOfDevice": "device-a",
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        assert_eq!(response.kind, FrameKind::SftpSnapshot);
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(payload["kind"], "failed");
        assert_eq!(payload["code"], "sftp_invalid_request");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("never-synchronized"));
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// A chunk that is not base64 is a client bug, and it must not be reported
    /// as the remote machine refusing the write.
    #[tokio::test]
    async fn a_malformed_chunk_is_refused_as_an_invalid_request() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let mut ssh_profiles = HashMap::new();
        ssh_profiles.insert("production".to_string(), ssh_profile_request());
        let local = host.connect(ClientIdentity::local("seed")).unwrap();
        host.replace_synchronized_profiles(&local.connection_id, HashMap::new(), ssh_profiles)
            .unwrap();

        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::SftpControl,
                Uuid::nil(),
                5,
                serde_json::to_vec(&serde_json::json!({
                    "kind": "writeChunk",
                    "profileId": "production",
                    "path": "/tmp/upload.bin",
                    "offset": 0,
                    "data": "not base64!!",
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(payload["kind"], "failed");
        assert_eq!(payload["code"], "sftp_invalid_request");
        drop(client);
        serve.await.unwrap().unwrap();
    }

    /// Closing a profile nobody opened is a no-op rather than an error, so a
    /// client tidying up after a failed browse does not have to know whether
    /// the connection ever came up.
    #[tokio::test]
    async fn closing_an_unopened_profile_closes_nothing() {
        let host = TerminalHost::new("host-test", test_config()).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathBuf::from("known_hosts"),
        ));

        write_frame(
            &mut client,
            &TerminalFrame::command(
                FrameKind::SftpControl,
                Uuid::nil(),
                2,
                serde_json::to_vec(&serde_json::json!({
                    "kind": "closeProfile",
                    "profileId": "production",
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let response = read_frame(&mut client).await.unwrap().unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&response.payload).unwrap();
        assert_eq!(payload["kind"], "closed");
        assert_eq!(payload["closed"], 0);
        drop(client);
        serve.await.unwrap().unwrap();
    }
}
