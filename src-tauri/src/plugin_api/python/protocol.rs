//! Python host subprocess management + NDJSON RPC.
//!
//! One [`PluginHost`] per loaded plugin: spawns
//! `<interpreter> -u <host.py>` with piped stdio (mirroring the Node
//! sidecar pattern in `src-tauri/src/claude/sidecar.rs`), correlates
//! requests/responses by numeric id through a pending-map of oneshot
//! senders, and forwards the child's stderr into the app log.
//!
//! Failure policy: a timeout or protocol corruption kills the process —
//! a host that stopped answering is unrecoverable by design (state lives
//! in the dead interpreter). Pending calls fail immediately when the
//! child exits.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use super::discover::Interpreter;
use crate::plugin_api::{PluginError, Result};

/// Timeout for cheap control calls (ping, get_tools, get_info).
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
/// Timeout for plugin code execution (call_tool, call, import_main —
/// imports can be slow on cold caches).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(120);

type PendingMap = Arc<parking_lot::Mutex<HashMap<u64, oneshot::Sender<HostReply>>>>;

/// Raw host response: `Ok(result)` for `ok: true`, `Err(message)` for
/// `ok: false` or transport-level failures.
type HostReply = std::result::Result<Value, String>;

struct HostInner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

/// A live Python host subprocess for one plugin.
pub struct PluginHost {
    plugin_id: String,
    inner: Mutex<HostInner>,
    next_id: AtomicU64,
    pending: PendingMap,
    /// Cached from `import_main`'s reply so `plugin_python_get_info`
    /// doesn't need a round-trip for static counts.
    pub tool_count: AtomicUsize,
    pub hook_count: AtomicUsize,
}

impl PluginHost {
    /// Spawn `<interpreter argv> -u <host_script>` and wire the stdio tasks.
    pub async fn spawn(
        plugin_id: &str,
        interpreter: &Interpreter,
        host_script: &Path,
    ) -> Result<Arc<Self>> {
        let (program, args) = interpreter
            .argv_prefix
            .split_first()
            .ok_or_else(|| PluginError::PythonHost("empty interpreter argv".into()))?;

        let mut cmd = Command::new(program);
        cmd.args(args)
            .arg("-u")
            .arg(host_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Mirrors sidecar.rs:272-276 — no console flash in release builds.
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            PluginError::PythonHost(format!(
                "failed to spawn python host ({}): {e}",
                interpreter.argv_prefix.join(" ")
            ))
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PluginError::PythonHost("child has no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| PluginError::PythonHost("child has no stderr".into()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| PluginError::PythonHost("child has no stdin".into()))?;

        let host = Arc::new(Self {
            plugin_id: plugin_id.to_string(),
            inner: Mutex::new(HostInner {
                child: Some(child),
                stdin: Some(stdin),
            }),
            next_id: AtomicU64::new(1),
            pending: Arc::new(parking_lot::Mutex::new(HashMap::new())),
            tool_count: AtomicUsize::new(0),
            hook_count: AtomicUsize::new(0),
        });

        // stdout reader: resolve pending requests by id.
        {
            let pending = Arc::clone(&host.pending);
            let plugin_id = host.plugin_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<Value>(trimmed) {
                                Ok(reply) => dispatch_reply(&pending, &plugin_id, &reply),
                                Err(e) => log::warn!(
                                    "[python.{plugin_id}] non-JSON protocol line ({e}): {}",
                                    &trimmed[..trimmed.len().min(200)]
                                ),
                            }
                        }
                        Ok(None) => break, // EOF — child exited
                        Err(e) => {
                            log::warn!("[python.{plugin_id}] stdout read error: {e}");
                            break;
                        }
                    }
                }
                // Child is gone: fail everything still in flight.
                let mut map = pending.lock();
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err("python host exited".into()));
                }
            });
        }

        // stderr reader: plugin prints + host diagnostics → app log.
        {
            let plugin_id = host.plugin_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!("[python.{plugin_id}] {line}");
                }
            });
        }

        Ok(host)
    }

    /// Send one request and await its correlated reply.
    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);

        let line = serde_json::to_string(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))?;

        {
            let mut guard = self.inner.lock().await;
            let stdin = guard.stdin.as_mut().ok_or_else(|| {
                self.pending.lock().remove(&id);
                PluginError::PythonHost("python host is not running".into())
            })?;
            let write = async {
                stdin.write_all(line.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await?;
                std::io::Result::Ok(())
            };
            if let Err(e) = write.await {
                self.pending.lock().remove(&id);
                return Err(PluginError::PythonHost(format!("stdin write failed: {e}")));
            }
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(PluginError::PythonHost(message)),
            // Sender dropped without a reply — reader task ended abnormally.
            Ok(Err(_)) => Err(PluginError::PythonHost("python host exited".into())),
            Err(_) => {
                self.pending.lock().remove(&id);
                self.kill().await;
                Err(PluginError::PythonHost(format!(
                    "request '{method}' timed out after {}s; host killed",
                    timeout.as_secs()
                )))
            }
        }
    }

    /// Terminate the subprocess. Idempotent.
    pub async fn kill(&self) {
        let mut guard = self.inner.lock().await;
        guard.stdin = None;
        if let Some(mut child) = guard.child.take() {
            if let Err(e) = child.kill().await {
                log::warn!("[python.{}] kill failed: {e}", self.plugin_id);
            }
        }
    }

    /// Liveness probe: protocol-level ping with the control timeout.
    pub async fn ping(&self) -> bool {
        matches!(
            self.request("ping", json!({}), CONTROL_TIMEOUT).await,
            Ok(Value::String(s)) if s == "pong"
        )
    }
}

fn dispatch_reply(pending: &PendingMap, plugin_id: &str, reply: &Value) {
    let Some(id) = reply.get("id").and_then(Value::as_u64) else {
        log::warn!("[python.{plugin_id}] protocol reply without id: {reply}");
        return;
    };
    let Some(tx) = pending.lock().remove(&id) else {
        log::warn!("[python.{plugin_id}] reply for unknown request id {id}");
        return;
    };
    let outcome = if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(reply
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown host error")
            .to_string())
    };
    let _ = tx.send(outcome);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_api::python::discover::discover_interpreter;
    use std::path::PathBuf;

    fn host_script() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("plugin_api")
            .join("python")
            .join("host.py")
    }

    /// Resolve a real interpreter or skip (mirrors the repo's gated-test
    /// convention — GitHub runners ship Python, so CI exercises these).
    fn interpreter_or_skip(test: &str) -> Option<Interpreter> {
        match discover_interpreter(None) {
            Some(interp) => Some(interp),
            None => {
                eprintln!("skipping {test}: no python >= 3.9 interpreter found");
                None
            }
        }
    }

    #[tokio::test]
    async fn spawn_and_ping_roundtrips() {
        let Some(interp) = interpreter_or_skip("spawn_and_ping_roundtrips") else {
            return;
        };
        let host = PluginHost::spawn("t-ping", &interp, &host_script()).await.unwrap();
        assert!(host.ping().await);
        host.kill().await;
    }

    #[tokio::test]
    async fn unknown_method_returns_python_host_error() {
        let Some(interp) = interpreter_or_skip("unknown_method_returns_python_host_error") else {
            return;
        };
        let host = PluginHost::spawn("t-unknown", &interp, &host_script()).await.unwrap();
        let err = host
            .request("definitely_not_a_method", json!({}), CONTROL_TIMEOUT)
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::PythonHost(_)));
        assert!(err.to_string().contains("unknown method"));
        host.kill().await;
    }

    #[tokio::test]
    async fn concurrent_requests_correlate() {
        let Some(interp) = interpreter_or_skip("concurrent_requests_correlate") else {
            return;
        };
        let host = PluginHost::spawn("t-concurrent", &interp, &host_script()).await.unwrap();
        let pings = (0..8).map(|_| host.request("ping", json!({}), CONTROL_TIMEOUT));
        for result in futures_util::future::join_all(pings).await {
            assert_eq!(result.unwrap(), Value::String("pong".into()));
        }
        host.kill().await;
    }

    #[tokio::test]
    async fn timeout_kills_host_and_errors() {
        let Some(interp) = interpreter_or_skip("timeout_kills_host_and_errors") else {
            return;
        };
        // A "host" that reads requests but never answers.
        let tmp = tempfile::TempDir::new().unwrap();
        let silent = tmp.path().join("silent.py");
        std::fs::write(&silent, "import sys\nfor line in sys.stdin:\n    pass\n").unwrap();

        let host = PluginHost::spawn("t-timeout", &interp, &silent).await.unwrap();
        let err = host
            .request("ping", json!({}), Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"));
        // Killed: a follow-up request fails fast on the missing stdin.
        let err = host.request("ping", json!({}), CONTROL_TIMEOUT).await.unwrap_err();
        assert!(err.to_string().contains("not running") || err.to_string().contains("exited"));
    }

    #[tokio::test]
    async fn spawn_failure_is_python_host_error() {
        let interp = Interpreter {
            argv_prefix: vec!["cognia-no-such-python".into()],
            version: "3.99.0".into(),
        };
        match PluginHost::spawn("t-spawn-fail", &interp, &host_script()).await {
            Ok(_) => panic!("spawn with a bogus interpreter must fail"),
            Err(err) => assert!(matches!(err, PluginError::PythonHost(_))),
        }
    }
}
