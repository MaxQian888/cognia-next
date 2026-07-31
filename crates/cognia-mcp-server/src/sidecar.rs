//! Node sidecar process manager for the MCP HTTP server.
//!
//! # Design — Option A: persistent sidecar with sequential mutex guard
//!
//! A single long-lived `node <sidecar_path>` process is spawned when the HTTP
//! server starts.  Each HTTP handler acquires the `request_lock` mutex, writes
//! one JSON-RPC line to the child's stdin, reads one JSON-RPC line back from
//! stdout, then releases the mutex.  This is intentionally sequential — the
//! MCP SDK's `StdioServerTransport` is also sequential, so we gain nothing
//! from true parallel multiplexing and the simpler design is less prone to
//! ordering bugs.
//!
//! The child inherits a minimal env:
//!   `COGNIA_BRIDGED=1` — tells `standalone-entry.ts` to use bridge mode
//!   `COGNIA_BRIDGE_SETTINGS=<JSON>` — full `ExternalBridgeSettings` object
//!
//! # Cross-platform note
//!
//! `tokio::process::Command` with `.kill_on_drop(true)` ensures the child is
//! terminated when the `SidecarProcess` is dropped (e.g. on server stop).

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use super::types::McpServerError;

/// Buffered read side of a sidecar's stdout (newline-framed JSON-RPC lines).
pub(crate) type SidecarLines = BufReader<ChildStdout>;

/// Internal I/O handles for the sidecar stdin/stdout pipe.
pub(crate) struct SidecarIo {
    pub(crate) stdin: ChildStdin,
    pub(crate) stdout: BufReader<ChildStdout>,
}

/// Live handle to the spawned Node sidecar process.
///
/// `request_lock` serialises all JSON-RPC round-trips so that concurrent HTTP
/// handler tasks don't interleave bytes on the shared stdin/stdout pipe.
pub struct SidecarProcess {
    request_lock: Arc<Mutex<SidecarIo>>,
    /// Kept alive so `kill_on_drop` fires when we are dropped.
    _child: Child,
}

impl SidecarProcess {
    /// Spawn `node <sidecar_path>` with the bridge env vars set.
    ///
    /// `settings_json` is forwarded verbatim as `COGNIA_BRIDGE_SETTINGS`.
    /// Convenience wrapper around `spawn_with_env` with no extra env. Kept
    /// for completeness; callers that need the automation-proxy env go
    /// through `spawn_with_env` directly.
    #[allow(dead_code)]
    pub async fn spawn(sidecar_path: &str, settings_json: &str) -> Result<Self, McpServerError> {
        Self::spawn_with_env(sidecar_path, settings_json, &[]).await
    }

    /// Like `spawn`, but injects extra env vars before launching the child.
    /// Used to pass the automation-proxy address + token through to the
    /// `external-bridge` handler running inside the sidecar.
    pub async fn spawn_with_env(
        sidecar_path: &str,
        settings_json: &str,
        extra_env: &[(String, String)],
    ) -> Result<Self, McpServerError> {
        let metadata = std::fs::metadata(sidecar_path).map_err(|error| {
            McpServerError::SidecarSpawn(format!(
                "MCP sidecar is unavailable at '{sidecar_path}': {error}"
            ))
        })?;
        if !metadata.is_file() {
            return Err(McpServerError::SidecarSpawn(format!(
                "MCP sidecar path is not a file: '{sidecar_path}'"
            )));
        }
        let mut cmd = Command::new("node");
        cmd.arg(sidecar_path)
            .env("COGNIA_BRIDGED", "1")
            .env("COGNIA_BRIDGE_SETTINGS", settings_json)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // Inherit stderr so logs surface in the Tauri console / log file.
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);

        for (key, value) in extra_env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|e| {
            McpServerError::SidecarSpawn(format!(
                "failed to spawn node sidecar at '{sidecar_path}': {e}"
            ))
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpServerError::SidecarSpawn("stdin not available".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpServerError::SidecarSpawn("stdout not available".into()))?;

        Ok(Self::from_parts(
            Arc::new(Mutex::new(SidecarIo {
                stdin,
                stdout: BufReader::new(stdout),
            })),
            child,
        ))
    }

    /// OS process ID of the live Node child, or `None` once it has been
    /// reaped. Surfaced through the unified managed-process registry so the
    /// performance panel can attribute + join the MCP sidecar by PID.
    pub fn pid(&self) -> Option<u32> {
        self._child.id()
    }

    /// Construct from pre-built I/O handles and an already-spawned child.
    ///
    /// Used by integration tests to inject a mock echo process.
    pub(crate) fn from_parts(io: Arc<Mutex<SidecarIo>>, child: Child) -> Self {
        Self {
            request_lock: io,
            _child: child,
        }
    }

    /// Send a single JSON-RPC request line and receive one JSON-RPC response
    /// line.  The mutex guarantees sequential access even when multiple axum
    /// handler tasks race to call this.
    pub async fn round_trip(&self, request: &str) -> Result<String, McpServerError> {
        let mut io = self.request_lock.lock().await;

        // Write the request as a newline-terminated line.
        let line = format!("{request}\n");
        io.stdin.write_all(line.as_bytes()).await.map_err(|e| {
            McpServerError::SidecarIo(format!("write to sidecar stdin failed: {e}"))
        })?;
        io.stdin
            .flush()
            .await
            .map_err(|e| McpServerError::SidecarIo(format!("flush sidecar stdin failed: {e}")))?;

        // Read exactly one line back.
        let mut response = String::new();
        io.stdout.read_line(&mut response).await.map_err(|e| {
            McpServerError::SidecarIo(format!("read from sidecar stdout failed: {e}"))
        })?;

        if response.is_empty() {
            return Err(McpServerError::SidecarIo(
                "sidecar stdout closed unexpectedly".into(),
            ));
        }

        Ok(response.trim_end_matches('\n').to_string())
    }
}

// ---------------------------------------------------------------------------
// Streaming-session spawn helpers (one dedicated child per streamable-HTTP
// session — see `streamable_http.rs`). Unlike `SidecarProcess`, these hand the
// raw stdin / stdout back so the session can own an independent reader task
// (server→client notifications can't flow through the shared round-trip mutex).
// ---------------------------------------------------------------------------

/// Spawn `node <sidecar_path>` in bridge mode and return its child + raw pipes.
pub(crate) async fn spawn_streaming_node(
    sidecar_path: &str,
    settings_json: &str,
    extra_env: &[(String, String)],
) -> Result<(Child, ChildStdin, BufReader<ChildStdout>), McpServerError> {
    if !std::path::Path::new(sidecar_path).is_file() {
        return Err(McpServerError::SidecarSpawn(format!(
            "MCP streaming sidecar is unavailable at '{sidecar_path}'"
        )));
    }
    let mut cmd = Command::new("node");
    cmd.arg(sidecar_path)
        .env("COGNIA_BRIDGED", "1")
        .env("COGNIA_BRIDGE_SETTINGS", settings_json)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().map_err(|e| {
        McpServerError::SidecarSpawn(format!("failed to spawn streaming sidecar: {e}"))
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| McpServerError::SidecarSpawn("stdin not available".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| McpServerError::SidecarSpawn("stdout not available".into()))?;
    Ok((child, stdin, BufReader::new(stdout)))
}

/// Spawn an inline-echo Node process for streaming tests (same framing as the
/// real sidecar). Returns `Err(())` when `node` is not on `PATH`.
#[allow(dead_code)] // used only in #[cfg(test)] blocks across the crate
pub(crate) async fn spawn_streaming_echo() -> Result<(Child, ChildStdin, BufReader<ChildStdout>), ()>
{
    let echo_script = concat!(
        "process.stdin.setEncoding('utf8');",
        "let b='';",
        "process.stdin.on('data',d=>{",
        "b+=d;",
        "let i;",
        "while((i=b.indexOf('\\n'))>=0){",
        "process.stdout.write(b.slice(0,i+1));",
        "b=b.slice(i+1);",
        "}",
        "});"
    );
    let mut child = Command::new("node")
        .args(["-e", echo_script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ())?;
    let stdin = child.stdin.take().ok_or(())?;
    let stdout = child.stdout.take().ok_or(())?;
    Ok((child, stdin, BufReader::new(stdout)))
}

// ---------------------------------------------------------------------------
// Helper visible only in tests (same crate).
// ---------------------------------------------------------------------------

/// Spawn a Node inline-echo process for use in tests.
///
/// Returns `Err(())` if `node` is not available on `PATH`.
#[allow(dead_code)] // used only in #[cfg(test)] blocks across the crate
pub(crate) async fn spawn_echo_for_tests() -> Result<SidecarProcess, ()> {
    let echo_script = concat!(
        "process.stdin.setEncoding('utf8');",
        "let b='';",
        "process.stdin.on('data',d=>{",
        "b+=d;",
        "let i;",
        "while((i=b.indexOf('\\n'))>=0){",
        "process.stdout.write(b.slice(0,i+1));",
        "b=b.slice(i+1);",
        "}",
        "});"
    );

    let mut child = Command::new("node")
        .args(["-e", echo_script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ())?;

    let stdin = child.stdin.take().ok_or(())?;
    let stdout = child.stdout.take().ok_or(())?;

    Ok(SidecarProcess::from_parts(
        Arc::new(Mutex::new(SidecarIo {
            stdin,
            stdout: BufReader::new(stdout),
        })),
        child,
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip_echo() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            // node not available in this environment — skip
            return;
        };

        let response = sidecar
            .round_trip(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
            .await
            .expect("round-trip should succeed");

        assert_eq!(response, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
    }

    #[tokio::test]
    async fn round_trip_multiple_sequential() {
        let Ok(sidecar) = spawn_echo_for_tests().await else {
            return;
        };

        for i in 0..3u32 {
            let req = format!(r#"{{"jsonrpc":"2.0","id":{i},"method":"ping"}}"#);
            let resp = sidecar.round_trip(&req).await.expect("round-trip");
            assert_eq!(resp, req, "response for id={i} should echo exactly");
        }
    }

    #[tokio::test]
    async fn spawn_rejects_a_missing_sidecar_before_starting_node() {
        let result = SidecarProcess::spawn_with_env(
            "/definitely/missing/cognia-mcp.mjs",
            r#"{"enabled":true,"enabledScopes":[]}"#,
            &[],
        )
        .await;
        let error = match result {
            Ok(_) => panic!("missing sidecar path must be rejected"),
            Err(error) => error,
        };
        assert!(matches!(error, McpServerError::SidecarSpawn(_)));
    }
}
