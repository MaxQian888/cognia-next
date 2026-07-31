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
use crate::protocol::{FrameKind, TerminalFrame, HEADER_LEN, MAX_FRAME_PAYLOAD};
use crate::session::{PathInjection, SpawnRequest};
use crate::ssh::SshSpawnRequest;

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
}

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AckPayload {
    ok: bool,
    host_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSnapshotPayload<T> {
    host_id: String,
    sessions: T,
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
    path: PathInjection,
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
                    &path,
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
    path: &PathInjection,
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
                ack_frame(host, session_id, sequence)
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
                },
            )
            .map_err(HostError::InvalidRequest)
        }),
        FrameKind::Spawn => match parse_json::<SpawnPayload>(&frame.payload) {
            Ok(payload) => match (payload.request, payload.ssh_request) {
                (Some(request), None) => {
                    host.spawn_local(connection_id, payload.profile_id, request, script_dir, path)
                }
                (None, Some(request)) => {
                    match host.sync_ssh_profile(connection_id, payload.profile_id.clone(), request)
                    {
                        Ok(()) => {
                            host.spawn_synchronized_profile(
                                connection_id,
                                payload.profile_id,
                                script_dir,
                                path,
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
                        path,
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
    json_frame(
        FrameKind::Ack,
        session_id,
        sequence,
        &AckPayload {
            ok: true,
            host_id: host.host_id().to_string(),
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

    #[tokio::test]
    async fn list_round_trip_uses_the_canonical_host_dispatcher() {
        let config = TerminalHostConfig {
            replay_bytes_per_session: 64 * 1024,
            total_replay_bytes: 128 * 1024,
            ..TerminalHostConfig::default()
        };
        let host = TerminalHost::new("host-test", config).unwrap();
        let (mut client, server) = tokio::io::duplex(16 * 1024);
        let serve = tokio::spawn(serve_host_stream(
            server,
            host,
            ClientIdentity::local("desktop"),
            PathBuf::from("."),
            PathInjection::default(),
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
}
