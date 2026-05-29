//! Docker container lifecycle for cua desktop sandboxes (ADR-0020
//! remote-target, Phase 1). cognia shells the `docker` CLI to run / stop /
//! probe a `ghcr.io/trycua/cua-xfce` container exposing `computer-server` on
//! :8000. The container is the isolation boundary (same model as the existing
//! e2b microvm tier); we don't apply fine-grained policy inside it.

use std::process::Stdio;

use tokio::process::Command;

use crate::automation::types::{AutomationError, Result};

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    /// e.g. `ghcr.io/trycua/cua-xfce:latest`.
    pub image: String,
    /// `docker --name`, derived from the connection id (`cua-<id>`).
    pub name: String,
}

fn backend_err(msg: impl Into<String>) -> AutomationError {
    AutomationError::BackendError { message: msg.into() }
}

/// `docker run -d --rm -p 0:8000 --name <name> <image>` — `-p 0:8000` asks
/// Docker for an ephemeral host port mapped to the container's computer-server.
pub fn run_args(spec: &SpawnSpec) -> Vec<String> {
    vec![
        "run".into(),
        "-d".into(),
        "--rm".into(),
        "-p".into(),
        "0:8000".into(),
        "--name".into(),
        spec.name.clone(),
        spec.image.clone(),
    ]
}

/// Run the container; returns its container id.
pub async fn docker_run(spec: &SpawnSpec) -> Result<String> {
    let out = Command::new("docker")
        .args(run_args(spec))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| backend_err(format!("docker run spawn failed (is Docker installed?): {e}")))?;
    if !out.status.success() {
        return Err(backend_err(format!(
            "docker run failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `docker port <id> 8000/tcp` → e.g. `0.0.0.0:49160` → `49160`.
pub async fn resolve_port(container_id: &str) -> Result<u16> {
    let out = Command::new("docker")
        .args(["port", container_id, "8000/tcp"])
        .output()
        .await
        .map_err(|e| backend_err(format!("docker port failed: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    parse_port(&text).ok_or_else(|| backend_err(format!("no mapped port in `docker port` output: {text:?}")))
}

/// Extracts the port from a `docker port` line such as `0.0.0.0:49160` or
/// `[::]:49161` — the trailing `:`-delimited number.
fn parse_port(s: &str) -> Option<u16> {
    s.lines()
        .next()?
        .trim()
        .rsplit(':')
        .next()?
        .trim()
        .parse()
        .ok()
}

pub async fn docker_stop(container_id: &str) -> Result<()> {
    Command::new("docker")
        .args(["stop", container_id])
        .output()
        .await
        .map_err(|e| backend_err(format!("docker stop failed: {e}")))?;
    Ok(())
}

/// `docker exec <id> true` succeeds only while the container is running.
pub async fn docker_health(container_id: &str) -> bool {
    Command::new("docker")
        .args(["exec", container_id, "true"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_args_have_port_and_name() {
        let a = run_args(&SpawnSpec { image: "img".into(), name: "cua-c1".into() });
        assert!(a.contains(&"0:8000".to_string()));
        assert!(a.contains(&"cua-c1".to_string()));
        assert!(a.contains(&"img".to_string()));
        assert_eq!(a.first().map(String::as_str), Some("run"));
    }

    #[test]
    fn parse_port_extracts_last_colon_segment() {
        assert_eq!(parse_port("0.0.0.0:49160\n"), Some(49160));
        assert_eq!(parse_port("[::]:49161\n"), Some(49161));
        assert_eq!(parse_port(""), None);
        assert_eq!(parse_port("garbage"), None);
    }
}
