//! How a Compose host asks its deploy agent to update it (ADR-0224 A10).
//!
//! A container cannot replace its own image, so on a Compose host the swap is
//! done next to it by `cognia-deploy-agent host-updates`, which holds the
//! Docker socket the server never sees. The two talk over a Unix socket on a
//! volume only they mount, one JSON line each way:
//!
//! * `status`: what the agent is doing, the image it pinned, and how the last
//!   update ended.
//! * `update`: install the release rolling for this host now. The host sends
//!   only its channel, rollout bucket and versions; the agent checks the
//!   signed catalog and the rollout gate itself and refuses when what it
//!   finds is not the version the host expected. A compromised server can at
//!   most ask for a release the catalog signs and the Worker is rolling.
//!
//! The server stops taking writes before it asks; the agent pulls first and
//! answers `accepted` only once the new image is local, then recreates the
//! server container and proves the new version (or rolls back).

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt as _, AsyncWrite, AsyncWriteExt as _};

use crate::install_home::UpdateOutcome;

/// Set on the server container: where its deploy agent listens.
pub const SOCKET_ENV: &str = "COGNIA_HOST_UPDATE_SOCKET";
/// The socket path the Compose overlay mounts (`compose.host-updates.yaml`).
pub const DEFAULT_SOCKET_PATH: &str = "/run/cognia-host-updates/agent.sock";
/// Wire version; either side refuses another.
pub const PROTOCOL_VERSION: u32 = 1;
/// Longest line either side reads.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// A request to the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum AgentRequest {
    Status,
    Update(UpdateRequest),
}

/// `update`: what the host knows; never which image to run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    pub channel: String,
    pub bucket: u32,
    /// Asked for by its owner rather than picked by automatic updates.
    pub manual: bool,
    pub current_version: String,
    /// The release the host found; the agent refuses if it finds another.
    pub expect_version: String,
}

/// The agent's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum AgentResponse {
    Status(AgentStatus),
    /// The image is pulled; the agent recreates the server container next.
    Accepted(AcceptedUpdate),
    Refused {
        error: String,
    },
}

/// Where the agent is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPhase {
    Idle,
    /// Checking the catalog and pulling the new image.
    Pulling,
    /// Recreating the server container.
    Activating,
    /// Waiting for the new version to prove itself.
    Trial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTrial {
    pub attempt_id: String,
    pub from: String,
    pub to: String,
    pub deadline_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub phase: AgentPhase,
    /// The `repository@digest` the agent pinned the server to, once it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trial: Option<AgentTrial>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<UpdateOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedUpdate {
    pub attempt_id: String,
    pub from: String,
    pub to: String,
    pub image: String,
}

/// Write one message as a line, stamped with [`PROTOCOL_VERSION`].
pub async fn write_message<W, T>(writer: &mut W, message: &T) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut value = serde_json::to_value(message).map_err(|error| error.to_string())?;
    let object = value
        .as_object_mut()
        .ok_or("a message must be a JSON object")?;
    object.insert("v".into(), PROTOCOL_VERSION.into());
    let mut line = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    line.push(b'\n');
    writer
        .write_all(&line)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

/// Read one line-message; `None` at a clean end of stream.
pub async fn read_message<R, T>(reader: &mut R) -> Result<Option<T>, String>
where
    R: AsyncBufRead + Unpin,
    T: serde::de::DeserializeOwned,
{
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(|error| error.to_string())?;
        if buffer.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            return Err("the message ended before its newline".into());
        }
        let (taken, done) = match buffer.iter().position(|byte| *byte == b'\n') {
            Some(at) => (at + 1, true),
            None => (buffer.len(), false),
        };
        line.extend_from_slice(&buffer[..taken]);
        reader.consume(taken);
        if line.len() > MAX_MESSAGE_BYTES {
            return Err("the message is too long".into());
        }
        if done {
            break;
        }
    }
    let value: serde_json::Value =
        serde_json::from_slice(&line).map_err(|error| format!("not a message: {error}"))?;
    match value.get("v").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(PROTOCOL_VERSION) => {}
        other => {
            return Err(format!(
                "protocol version {other:?}; this side speaks {PROTOCOL_VERSION}"
            ))
        }
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|error| format!("not a message: {error}"))
}

/// Ask the agent at `socket` once, giving up after `timeout`.
#[cfg(unix)]
pub async fn call(
    socket: &Path,
    request: &AgentRequest,
    timeout: Duration,
) -> Result<AgentResponse, String> {
    let exchange = async {
        let stream = tokio::net::UnixStream::connect(socket)
            .await
            .map_err(|error| format!("the deploy agent at {}: {error}", socket.display()))?;
        let (read, mut write) = stream.into_split();
        write_message(&mut write, request).await?;
        let mut reader = tokio::io::BufReader::new(read);
        read_message(&mut reader)
            .await?
            .ok_or_else(|| "the deploy agent hung up without answering".to_owned())
    };
    tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| "the deploy agent did not answer in time".to_owned())?
}

/// Compose deploy agents use a Unix socket, not the desktop update transport.
#[cfg(not(unix))]
pub async fn call(
    _socket: &Path,
    _request: &AgentRequest,
    _timeout: Duration,
) -> Result<AgentResponse, String> {
    Err("Compose deploy-agent updates require Unix domain sockets".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install_home::UpdateResult;

    #[test]
    fn requests_and_answers_have_one_wire_shape() {
        assert_eq!(
            serde_json::to_value(AgentRequest::Update(UpdateRequest {
                channel: "beta".into(),
                bucket: 17,
                manual: true,
                current_version: "1.4.0".into(),
                expect_version: "1.5.0".into(),
            }))
            .unwrap(),
            serde_json::json!({
                "op": "update", "channel": "beta", "bucket": 17, "manual": true,
                "currentVersion": "1.4.0", "expectVersion": "1.5.0",
            })
        );
        let status = AgentResponse::Status(AgentStatus {
            phase: AgentPhase::Trial,
            image: Some("ghcr.io/x/cognia-server@sha256:aa".into()),
            trial: Some(AgentTrial {
                attempt_id: "a1".into(),
                from: "1.4.0".into(),
                to: "1.5.0".into(),
                deadline_ms: 9,
            }),
            last_outcome: Some(UpdateOutcome {
                attempt_id: "a0".into(),
                from: "1.3.0".into(),
                to: "1.4.0".into(),
                result: UpdateResult::Installed,
                reason: None,
                at_ms: 5,
            }),
            last_error: None,
        });
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["result"], "status");
        assert_eq!(value["phase"], "trial");
        assert_eq!(value["trial"]["deadlineMs"], 9);
        assert_eq!(value["lastOutcome"]["result"], "installed");
        assert_eq!(
            serde_json::to_value(AgentResponse::Refused { error: "no".into() }).unwrap(),
            serde_json::json!({ "result": "refused", "error": "no" })
        );
    }

    #[tokio::test]
    async fn a_message_crosses_as_one_versioned_line() {
        let (client, server) = tokio::io::duplex(4096);
        let (server_read, _server_write) = tokio::io::split(server);
        let (_client_read, mut client_write) = tokio::io::split(client);
        write_message(&mut client_write, &AgentRequest::Status)
            .await
            .unwrap();
        drop(client_write);
        let mut reader = tokio::io::BufReader::new(server_read);
        let request: Option<AgentRequest> = read_message(&mut reader).await.unwrap();
        assert_eq!(request, Some(AgentRequest::Status));
    }

    #[tokio::test]
    async fn another_version_a_long_line_or_a_cut_one_is_refused() {
        async fn read(bytes: Vec<u8>) -> Result<Option<AgentRequest>, String> {
            let mut reader = tokio::io::BufReader::new(std::io::Cursor::new(bytes));
            read_message(&mut reader).await
        }
        assert!(read(b"{\"v\":2,\"op\":\"status\"}\n".to_vec())
            .await
            .unwrap_err()
            .contains("protocol version"));
        assert!(read(b"{\"op\":\"status\"}\n".to_vec()).await.is_err());
        let mut long = b"{\"v\":1,\"op\":\"status\",\"pad\":\"".to_vec();
        long.extend(std::iter::repeat_n(b'x', MAX_MESSAGE_BYTES));
        long.extend_from_slice(b"\"}\n");
        assert!(read(long).await.unwrap_err().contains("too long"));
        assert!(read(b"{\"v\":1,\"op\":\"status\"}".to_vec())
            .await
            .unwrap_err()
            .contains("newline"));
        assert_eq!(read(Vec::new()).await.unwrap(), None);
    }

    #[cfg(not(unix))]
    #[tokio::test]
    async fn call_rejects_a_transport_not_supported_on_this_platform() {
        let tmp = tempfile::tempdir().unwrap();
        for request in [
            AgentRequest::Status,
            AgentRequest::Update(UpdateRequest {
                channel: "stable".into(),
                bucket: 1,
                manual: false,
                current_version: "1.4.0".into(),
                expect_version: "1.5.0".into(),
            }),
        ] {
            let error = call(&tmp.path().join("agent.sock"), &request, Duration::ZERO)
                .await
                .unwrap_err();
            assert_eq!(
                error,
                "Compose deploy-agent updates require Unix domain sockets"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn call_asks_once_and_reads_the_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("agent.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut reader = tokio::io::BufReader::new(read);
            let request: AgentRequest = read_message(&mut reader).await.unwrap().unwrap();
            assert!(
                matches!(request, AgentRequest::Update(ref update) if update.expect_version == "1.5.0")
            );
            write_message(
                &mut write,
                &AgentResponse::Refused {
                    error: "held back".into(),
                },
            )
            .await
            .unwrap();
        });
        let answer = call(
            &path,
            &AgentRequest::Update(UpdateRequest {
                channel: "stable".into(),
                bucket: 1,
                manual: false,
                current_version: "1.4.0".into(),
                expect_version: "1.5.0".into(),
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(
            answer,
            AgentResponse::Refused {
                error: "held back".into()
            }
        );
        server.await.unwrap();

        let missing = call(
            &tmp.path().join("none.sock"),
            &AgentRequest::Status,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(missing.contains("deploy agent"), "{missing}");
    }
}
