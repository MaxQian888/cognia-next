//! The agent's Unix socket: one request and one answer per connection.
//!
//! The socket sits on a volume only the agent and the server container mount
//! (`compose.host-updates.yaml`). Each connection's peer is checked against
//! the allowed uids (the server image runs as 10001) before anything is read,
//! so another container that somehow reaches the volume still cannot ask.
//! After an `accepted` answer is written the agent switches the server, which
//! ends that same server's process; answering first is what lets the host
//! know the swap is its own doing.

use std::path::Path;
use std::sync::Arc;

use cognia_host_service::update_agent::{read_message, write_message, AgentRequest, AgentResponse};
use tokio::net::{UnixListener, UnixStream};

use super::agent::HostUpdateAgent;

/// Bind `path`, replacing a stale socket a previous agent left, never any
/// other kind of file.
pub fn bind(path: &Path) -> Result<UnixListener, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            use std::os::unix::fs::FileTypeExt as _;
            if !metadata.file_type().is_socket() {
                return Err(format!("{} exists and is not a socket", path.display()));
            }
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let listener = UnixListener::bind(path).map_err(|error| error.to_string())?;
    // The peer check, not the file mode, decides who may ask: the server runs
    // as a different uid than the agent.
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))
        .map_err(|error| error.to_string())?;
    Ok(listener)
}

/// Serve requests until the listener fails.
pub async fn serve(
    agent: Arc<HostUpdateAgent>,
    listener: UnixListener,
    allowed_uids: Arc<Vec<u32>>,
) -> Result<(), String> {
    loop {
        let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let agent = Arc::clone(&agent);
        let allowed = Arc::clone(&allowed_uids);
        tokio::spawn(async move {
            if let Err(error) = handle(agent, stream, &allowed).await {
                tracing::warn!(%error, "host update request failed");
            }
        });
    }
}

async fn handle(
    agent: Arc<HostUpdateAgent>,
    stream: UnixStream,
    allowed_uids: &[u32],
) -> Result<(), String> {
    let uid = stream
        .peer_cred()
        .map_err(|error| format!("could not read the peer's credentials: {error}"))?
        .uid();
    let (read, mut write) = stream.into_split();
    if !allowed_uids.contains(&uid) {
        let _ = write_message(
            &mut write,
            &AgentResponse::Refused {
                error: format!("uid {uid} may not ask this deploy agent"),
            },
        )
        .await;
        return Err(format!("refused a request from uid {uid}"));
    }
    let mut reader = tokio::io::BufReader::new(read);
    let Some(request) = read_message::<_, AgentRequest>(&mut reader).await? else {
        return Ok(());
    };
    let (response, activate) = agent.answer(request).await;
    let written = write_message(&mut write, &response).await;
    drop(write);
    if activate {
        // Whether or not the host heard the answer, the swap is recorded and
        // pulled; finishing it (or rolling it back) is the agent's job now.
        tokio::spawn(async move {
            agent.activate().await;
        });
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_updates::agent::tests::{harness, request};
    use cognia_host_service::update_agent::{call, AgentPhase};
    use std::os::unix::fs::MetadataExt as _;
    use std::time::Duration;

    fn my_uid(dir: &Path) -> u32 {
        let probe = dir.join("uid-probe");
        std::fs::write(&probe, "").unwrap();
        std::fs::metadata(&probe).unwrap().uid()
    }

    #[tokio::test]
    async fn an_allowed_peer_gets_status_and_others_are_refused() {
        let h = harness();
        let path = h.tmp.path().join("run").join("agent.sock");
        let uid = my_uid(h.tmp.path());
        let listener = bind(&path).unwrap();
        tokio::spawn(serve(Arc::clone(&h.agent), listener, Arc::new(vec![uid])));
        let answer = call(&path, &AgentRequest::Status, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            matches!(answer, AgentResponse::Status(status) if status.phase == AgentPhase::Idle)
        );

        let other = h.tmp.path().join("other.sock");
        let listener = bind(&other).unwrap();
        tokio::spawn(serve(
            Arc::clone(&h.agent),
            listener,
            Arc::new(vec![uid.wrapping_add(1)]),
        ));
        let answer = call(&other, &AgentRequest::Status, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            matches!(answer, AgentResponse::Refused { error } if error.contains("may not ask"))
        );
    }

    #[tokio::test]
    async fn an_accepted_update_is_answered_before_the_switch() {
        let h = harness();
        let path = h.tmp.path().join("agent.sock");
        let listener = bind(&path).unwrap();
        tokio::spawn(serve(
            Arc::clone(&h.agent),
            listener,
            Arc::new(vec![my_uid(h.tmp.path())]),
        ));
        let answer = call(
            &path,
            &AgentRequest::Update(request("1.5.0")),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(matches!(answer, AgentResponse::Accepted(ref accepted) if accepted.to == "1.5.0"));
        // The switch follows the answer.
        for _ in 0..100 {
            if !h.compose.recreates.lock().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(h.compose.recreates.lock().len(), 1);
    }

    #[test]
    fn only_a_stale_socket_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("agent.sock");
        std::fs::write(&file, "not a socket").unwrap();
        assert!(bind(&file).unwrap_err().contains("not a socket"));
    }
}
