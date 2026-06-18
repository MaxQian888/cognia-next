//! External Agent Process Management
//!
//! Handles spawning and managing external agent processes.
//! Based on patterns from skill_seekers/service.rs and mcp/transport/stdio.rs

use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

/// Configuration for spawning an external agent
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ExternalAgentSpawnConfig {
    /// Unique identifier for this agent
    pub id: String,
    /// Command to execute
    pub command: String,
    /// Command arguments
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Working directory
    pub cwd: Option<String>,
}

/// State of an external agent process
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum ExternalAgentProcessState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

/// Information about a running external agent process
#[derive(Debug)]
pub struct ExternalAgentProcess {
    /// Process ID
    pub pid: Option<u32>,
    /// Current state
    pub state: ExternalAgentProcessState,
    /// Configuration used to spawn
    pub config: ExternalAgentSpawnConfig,
    /// Child process handle
    child: Child,
    /// Stdin handle for sending messages
    stdin: ChildStdin,
    /// Channel for receiving stdout lines
    stdout_rx: mpsc::Receiver<String>,
    /// Channel for receiving stderr lines
    stderr_rx: mpsc::Receiver<String>,
    /// Last known process exit code
    last_exit_code: Option<i32>,
    /// Last known process exit signal
    last_exit_signal: Option<String>,
}

impl ExternalAgentProcess {
    fn update_exit_from_status(&mut self, status: std::process::ExitStatus) {
        self.last_exit_code = status.code();
        #[cfg(unix)]
        {
            self.last_exit_signal = status.signal().map(|s| s.to_string());
        }
        #[cfg(not(unix))]
        {
            self.last_exit_signal = None;
        }
    }

    /// Get the process ID
    pub fn get_pid(&self) -> Option<u32> {
        self.pid
    }

    /// Get the spawn configuration
    pub fn get_config(&self) -> &ExternalAgentSpawnConfig {
        &self.config
    }

    /// Get the current state
    pub fn get_state(&self) -> &ExternalAgentProcessState {
        &self.state
    }

    /// Transition to Running state
    pub fn set_running(&mut self) {
        self.state = ExternalAgentProcessState::Running;
    }

    /// Transition to Failed state with error message
    pub fn set_failed(&mut self) {
        self.state = ExternalAgentProcessState::Failed;
    }

    /// Send a message to the process via stdin
    pub async fn send(&mut self, message: &str) -> Result<(), String> {
        self.stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;

        self.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {}", e))?;

        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        Ok(())
    }

    /// Receive next stdout line (non-blocking)
    pub async fn receive_stdout(&mut self) -> Option<String> {
        self.stdout_rx.try_recv().ok()
    }

    /// Receive next stderr line (non-blocking)
    pub async fn receive_stderr(&mut self) -> Option<String> {
        self.stderr_rx.try_recv().ok()
    }

    /// Check if the process is still running
    pub async fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                self.update_exit_from_status(status);
                self.state = ExternalAgentProcessState::Stopped;
                false
            }
            Err(_) => {
                self.state = ExternalAgentProcessState::Stopped;
                false
            }
        }
    }

    /// Kill the process
    pub async fn kill(&mut self) -> Result<(), String> {
        self.state = ExternalAgentProcessState::Stopping;
        self.child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill process: {}", e))?;
        self.last_exit_code = None;
        self.last_exit_signal = Some("killed".to_string());
        self.state = ExternalAgentProcessState::Stopped;
        Ok(())
    }

    /// Get process info as JSON-serializable value
    pub fn get_info(&self) -> serde_json::Value {
        let config = self.get_config();
        serde_json::json!({
            "id": config.id,
            "pid": self.get_pid(),
            "state": self.get_state(),
            "command": config.command,
            "args": config.args,
            "cwd": config.cwd,
            "env": config.env,
            "exitCode": self.last_exit_code,
            "exitSignal": self.last_exit_signal.clone()
        })
    }
}

/// Manager for external agent processes
pub struct ExternalAgentProcessManager {
    processes: RwLock<HashMap<String, Arc<Mutex<ExternalAgentProcess>>>>,
}

impl Default for ExternalAgentProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ExternalAgentProcessManager {
    /// Create a new process manager
    pub fn new() -> Self {
        Self {
            processes: RwLock::new(HashMap::new()),
        }
    }

    /// Spawn a new external agent process
    pub async fn spawn(&self, config: ExternalAgentSpawnConfig) -> Result<String, String> {
        let id = config.id.clone();

        // Check if already running
        {
            let processes = self.processes.read().await;
            if processes.contains_key(&id) {
                return Err(format!("Agent {} is already running", id));
            }
        }

        log::info!(
            "Spawning external agent: id={}, command={}, args={:?}",
            id,
            config.command,
            config.args
        );

        // Build command
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Set environment variables
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        // Set working directory
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }

        // On Windows, prevent window from showing
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Spawn the process
        let mut child = cmd.spawn().map_err(|e| {
            log::error!("Failed to spawn external agent {}: {}", id, e);
            format!("Failed to spawn process: {}", e)
        })?;

        let pid = child.id();
        log::info!("External agent {} spawned with PID: {:?}", id, pid);

        // Get stdio handles
        let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        // Create channels for stdout/stderr
        let (stdout_tx, stdout_rx) = mpsc::channel::<String>(1000);
        let (stderr_tx, stderr_rx) = mpsc::channel::<String>(100);

        // Spawn stdout reader task
        let stdout_id = id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::trace!("External agent {} stdout: {}", stdout_id, line);
                if stdout_tx.send(line).await.is_err() {
                    break;
                }
            }
        });

        // Spawn stderr reader task
        let stderr_id = id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("External agent {} stderr: {}", stderr_id, line);
                if stderr_tx.send(line).await.is_err() {
                    break;
                }
            }
        });

        // Create process entry with Starting state
        let process = ExternalAgentProcess {
            pid,
            state: ExternalAgentProcessState::Starting,
            config,
            child,
            stdin,
            stdout_rx,
            stderr_rx,
            last_exit_code: None,
            last_exit_signal: None,
        };

        // Store in manager
        {
            let mut processes = self.processes.write().await;
            processes.insert(id.clone(), Arc::new(Mutex::new(process)));
        }

        Ok(id)
    }

    /// Get a process by ID
    pub async fn get(&self, id: &str) -> Option<Arc<Mutex<ExternalAgentProcess>>> {
        let processes = self.processes.read().await;
        processes.get(id).cloned()
    }

    /// Send a message to a process
    pub async fn send(&self, id: &str, message: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;
        process.send(message).await
    }

    /// Receive stdout from a process
    pub async fn receive_stdout(&self, id: &str) -> Result<Vec<String>, String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;

        let mut lines = Vec::new();
        while let Some(line) = process.receive_stdout().await {
            lines.push(line);
        }
        Ok(lines)
    }

    /// Kill a process
    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        {
            let mut process = process.lock().await;
            process.kill().await?;
        }

        // Remove from manager
        let mut processes = self.processes.write().await;
        processes.remove(id);

        log::info!("External agent {} killed", id);
        Ok(())
    }

    /// Kill all processes
    pub async fn kill_all(&self) -> Result<(), String> {
        let ids: Vec<String> = {
            let processes = self.processes.read().await;
            processes.keys().cloned().collect()
        };

        for id in ids {
            if let Err(e) = self.kill(&id).await {
                log::error!("Failed to kill agent {}: {}", id, e);
            }
        }

        Ok(())
    }

    /// Get list of all running process IDs
    pub async fn list(&self) -> Vec<String> {
        let processes = self.processes.read().await;
        processes.keys().cloned().collect()
    }

    /// Get status of a process
    pub async fn status(&self, id: &str) -> Option<ExternalAgentProcessState> {
        let process = self.get(id).await?;
        let process = process.lock().await;
        Some(process.state.clone())
    }

    /// Receive stderr from a process
    pub async fn receive_stderr(&self, id: &str) -> Result<Vec<String>, String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;

        let mut lines = Vec::new();
        while let Some(line) = process.receive_stderr().await {
            lines.push(line);
        }
        Ok(lines)
    }

    /// Check if a process is still running
    pub async fn is_running(&self, id: &str) -> Result<bool, String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;
        Ok(process.is_running().await)
    }

    /// Get detailed info about a process
    pub async fn get_info(&self, id: &str) -> Result<serde_json::Value, String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let process = process.lock().await;
        Ok(process.get_info())
    }

    /// Transition a process to Running state
    pub async fn set_running(&self, id: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;
        process.set_running();
        Ok(())
    }

    /// Transition a process to Failed state
    pub async fn set_failed(&self, id: &str) -> Result<(), String> {
        let process = self
            .get(id)
            .await
            .ok_or(format!("Agent {} not found", id))?;
        let mut process = process.lock().await;
        process.set_failed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_config_defaults_args_and_env() {
        let cfg: ExternalAgentSpawnConfig =
            serde_json::from_str(r#"{"id":"a","command":"echo"}"#).expect("parse minimal config");
        assert_eq!(cfg.id, "a");
        assert_eq!(cfg.command, "echo");
        assert!(cfg.args.is_empty());
        assert!(cfg.env.is_empty());
        assert!(cfg.cwd.is_none());
    }

    #[tokio::test]
    async fn unknown_agent_ops_return_not_found() {
        let mgr = ExternalAgentProcessManager::new();
        assert!(mgr.send("ghost", "x").await.is_err());
        assert!(mgr.kill("ghost").await.is_err());
        assert!(mgr.receive_stdout("ghost").await.is_err());
        assert!(mgr.receive_stderr("ghost").await.is_err());
        assert!(mgr.is_running("ghost").await.is_err());
        assert!(mgr.get_info("ghost").await.is_err());
        assert!(mgr.set_running("ghost").await.is_err());
        assert!(mgr.set_failed("ghost").await.is_err());
        assert!(mgr.status("ghost").await.is_none());
        assert!(mgr.get("ghost").await.is_none());
        assert!(mgr.list().await.is_empty());
    }

    #[cfg(unix)]
    fn echo_config(id: &str) -> ExternalAgentSpawnConfig {
        ExternalAgentSpawnConfig {
            id: id.to_string(),
            command: "cat".to_string(), // reads stdin; stays alive until killed
            args: vec![],
            env: HashMap::new(),
            cwd: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_registers_then_kill_removes() {
        let mgr = ExternalAgentProcessManager::new();
        let id = mgr.spawn(echo_config("agent-1")).await.expect("spawn");
        assert!(mgr.list().await.contains(&id));
        assert_eq!(
            mgr.status(&id).await,
            Some(ExternalAgentProcessState::Starting)
        );

        mgr.set_running(&id).await.expect("set running");
        assert_eq!(
            mgr.status(&id).await,
            Some(ExternalAgentProcessState::Running)
        );

        // get_info reflects the spawn config.
        let info = mgr.get_info(&id).await.expect("info");
        assert_eq!(info["id"], serde_json::json!("agent-1"));
        assert_eq!(info["command"], serde_json::json!("cat"));

        // send writes a line to stdin without error.
        mgr.send(&id, "hello").await.expect("send");

        mgr.kill(&id).await.expect("kill");
        assert!(!mgr.list().await.contains(&id));
        assert!(mgr.get_info(&id).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn duplicate_spawn_is_rejected() {
        let mgr = ExternalAgentProcessManager::new();
        mgr.spawn(echo_config("dup")).await.expect("first spawn");
        let second = mgr.spawn(echo_config("dup")).await;
        assert!(second.is_err());
        mgr.kill_all().await.expect("cleanup");
        assert!(mgr.list().await.is_empty());
    }
}
