//! ACP Terminal Management
//!
//! Provides terminal functionality for ACP agents.
//! Handles spawning, output collection, and lifecycle management
//! of terminal processes requested by external agents.

use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{timeout, Duration};

/// Terminal output line
#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub text: String,
    pub is_stderr: bool,
    pub timestamp: u64,
}

/// Terminal process exit status
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitStatus {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
}

/// Terminal process state
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum TerminalState {
    Running,
    Exited(i32),
    Killed,
    Error(String),
}

/// ACP Terminal instance
pub struct AcpTerminal {
    pub id: String,
    pub session_id: String,
    pub command: String,
    pub state: TerminalState,
    child: Child,
    stdin: Option<ChildStdin>,
    output_rx: mpsc::Receiver<TerminalOutput>,
    output_buffer: Vec<TerminalOutput>,
    default_output_byte_limit: Option<usize>,
    last_exit_code: Option<i32>,
    last_exit_signal: Option<String>,
}

impl AcpTerminal {
    fn update_exit_status_from_process_status(&mut self, status: std::process::ExitStatus) {
        self.last_exit_code = status.code();
        #[cfg(unix)]
        {
            self.last_exit_signal = status.signal().map(|s| s.to_string());
        }
        #[cfg(not(unix))]
        {
            self.last_exit_signal = None;
        }
        self.state = TerminalState::Exited(self.last_exit_code.unwrap_or(-1));
    }

    fn current_exit_status(&self) -> TerminalExitStatus {
        TerminalExitStatus {
            exit_code: self.last_exit_code,
            signal: self.last_exit_signal.clone(),
        }
    }

    fn truncate_output_tail(output: &str, max_bytes: usize) -> (String, bool) {
        if output.len() <= max_bytes {
            return (output.to_string(), false);
        }
        if max_bytes == 0 {
            return (String::new(), !output.is_empty());
        }

        let mut start = output.len() - max_bytes;
        while start < output.len() && !output.is_char_boundary(start) {
            start += 1;
        }
        (output[start..].to_string(), true)
    }

    /// Write to terminal stdin
    pub async fn write(&mut self, data: &str) -> Result<(), String> {
        if let Some(stdin) = &mut self.stdin {
            stdin
                .write_all(data.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to terminal: {}", e))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush terminal: {}", e))?;
            Ok(())
        } else {
            Err("Terminal stdin not available".to_string())
        }
    }

    /// Collect output from the terminal
    pub async fn collect_output(&mut self) -> Vec<TerminalOutput> {
        // Drain any pending output from the channel
        while let Ok(output) = self.output_rx.try_recv() {
            self.output_buffer.push(output);
        }
        self.output_buffer.clone()
    }

    /// Get accumulated output as string
    pub async fn get_output_string(&mut self) -> String {
        let outputs = self.collect_output().await;
        outputs
            .iter()
            .map(|o| o.text.as_str())
            .collect::<Vec<_>>()
            .join("")
    }

    /// Get accumulated output with optional byte limit
    pub async fn get_output_with_limit(
        &mut self,
        requested_limit: Option<usize>,
    ) -> (String, bool) {
        let output = self.get_output_string().await;
        let limit = requested_limit.or(self.default_output_byte_limit);
        if let Some(max_bytes) = limit {
            return Self::truncate_output_tail(&output, max_bytes);
        }
        (output, false)
    }

    /// Check if the terminal is still running
    pub async fn is_running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                self.update_exit_status_from_process_status(status);
                false
            }
            Err(e) => {
                self.state = TerminalState::Error(e.to_string());
                false
            }
        }
    }

    /// Get exit code if the process has exited
    pub fn exit_code(&self) -> Option<i32> {
        self.last_exit_code
    }

    /// Get terminal exit status
    pub fn exit_status(&self) -> TerminalExitStatus {
        self.current_exit_status()
    }

    /// Kill the terminal process
    pub async fn kill(&mut self) -> Result<(), String> {
        self.child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill terminal: {}", e))?;
        self.state = TerminalState::Killed;
        self.last_exit_code = None;
        self.last_exit_signal = Some("killed".to_string());
        Ok(())
    }

    /// Wait for the terminal to exit with optional timeout
    pub async fn wait_for_exit(
        &mut self,
        timeout_secs: Option<u64>,
    ) -> Result<TerminalExitStatus, String> {
        let wait_future = async {
            match self.child.wait().await {
                Ok(status) => {
                    self.update_exit_status_from_process_status(status);
                    Ok(self.current_exit_status())
                }
                Err(e) => {
                    self.state = TerminalState::Error(e.to_string());
                    Err(format!("Failed to wait for terminal: {}", e))
                }
            }
        };

        if let Some(secs) = timeout_secs {
            timeout(Duration::from_secs(secs), wait_future)
                .await
                .map_err(|_| "Timeout waiting for terminal to exit".to_string())?
        } else {
            wait_future.await
        }
    }
}

/// ACP Terminal Manager
/// Manages all terminal instances for ACP agents
pub struct AcpTerminalManager {
    terminals: RwLock<HashMap<String, Arc<Mutex<AcpTerminal>>>>,
    next_id: Mutex<u64>,
}

impl Default for AcpTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AcpTerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: RwLock::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    /// Create a new terminal
    pub async fn create(
        &self,
        session_id: &str,
        command: &str,
        args: &[String],
        cwd: Option<&str>,
        env: Option<&HashMap<String, String>>,
        output_byte_limit: Option<usize>,
    ) -> Result<String, String> {
        // Generate unique terminal ID
        let mut next_id = self.next_id.lock().await;
        let terminal_id = format!("term_{}", *next_id);
        *next_id += 1;
        drop(next_id);

        // Build command
        let mut cmd = Command::new(command);
        cmd.args(args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        if let Some(env_map) = env {
            for (key, value) in env_map {
                cmd.env(key, value);
            }
        }

        // Set environment to prevent interactive prompts
        #[cfg(windows)]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Spawn the process
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn terminal: {}", e))?;

        // Take ownership of stdin
        let stdin = child.stdin.take();

        // Create output channel
        let (output_tx, output_rx) = mpsc::channel::<TerminalOutput>(1000);

        // Spawn stdout reader
        if let Some(stdout) = child.stdout.take() {
            let tx = output_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let output = TerminalOutput {
                        text: format!("{}\n", line),
                        is_stderr: false,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    };
                    if tx.send(output).await.is_err() {
                        break;
                    }
                }
            });
        }

        // Spawn stderr reader
        if let Some(stderr) = child.stderr.take() {
            let tx = output_tx;
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let output = TerminalOutput {
                        text: format!("{}\n", line),
                        is_stderr: true,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    };
                    if tx.send(output).await.is_err() {
                        break;
                    }
                }
            });
        }

        // Create terminal instance
        let terminal = AcpTerminal {
            id: terminal_id.clone(),
            session_id: session_id.to_string(),
            command: command.to_string(),
            state: TerminalState::Running,
            child,
            stdin,
            output_rx,
            output_buffer: Vec::new(),
            default_output_byte_limit: output_byte_limit,
            last_exit_code: None,
            last_exit_signal: None,
        };

        // Store terminal
        let mut terminals = self.terminals.write().await;
        terminals.insert(terminal_id.clone(), Arc::new(Mutex::new(terminal)));

        log::info!(
            "[ACP Terminal] Created terminal {} for session {}",
            terminal_id,
            session_id
        );

        Ok(terminal_id)
    }

    /// Get output from a terminal
    pub async fn get_output(
        &self,
        terminal_id: &str,
        requested_limit: Option<usize>,
    ) -> Result<(String, bool, TerminalExitStatus), String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        let (output, truncated) = terminal.get_output_with_limit(requested_limit).await;
        let exit_status = terminal.exit_status();

        Ok((output, truncated, exit_status))
    }

    /// Kill a terminal
    pub async fn kill(&self, terminal_id: &str) -> Result<(), String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        terminal.kill().await?;

        log::info!("[ACP Terminal] Killed terminal {}", terminal_id);
        Ok(())
    }

    /// Release a terminal (remove from manager)
    pub async fn release(&self, terminal_id: &str) -> Result<(), String> {
        let mut terminals = self.terminals.write().await;
        if terminals.remove(terminal_id).is_some() {
            log::info!("[ACP Terminal] Released terminal {}", terminal_id);
            Ok(())
        } else {
            Err(format!("Terminal not found: {}", terminal_id))
        }
    }

    /// Wait for a terminal to exit
    pub async fn wait_for_exit(
        &self,
        terminal_id: &str,
        timeout_secs: Option<u64>,
    ) -> Result<TerminalExitStatus, String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?
            .clone();
        drop(terminals);

        let mut terminal = terminal.lock().await;
        terminal.wait_for_exit(timeout_secs).await
    }

    /// Get all terminals for a session
    pub async fn get_session_terminals(&self, session_id: &str) -> Vec<String> {
        let terminals = self.terminals.read().await;
        terminals
            .iter()
            .filter(|(_, t)| {
                if let Ok(t) = t.try_lock() {
                    t.session_id == session_id
                } else {
                    false
                }
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Kill all terminals for a session
    pub async fn kill_session_terminals(&self, session_id: &str) -> Result<(), String> {
        let terminal_ids = self.get_session_terminals(session_id).await;
        for id in terminal_ids {
            let _ = self.kill(&id).await;
            let _ = self.release(&id).await;
        }
        Ok(())
    }

    /// Write to a terminal's stdin
    pub async fn write(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        terminal.write(data).await
    }

    /// Check if a terminal is running
    pub async fn is_running(&self, terminal_id: &str) -> Result<bool, String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let mut terminal = terminal.lock().await;
        Ok(terminal.is_running().await)
    }

    /// Get terminal info
    pub async fn get_info(&self, terminal_id: &str) -> Result<serde_json::Value, String> {
        let terminals = self.terminals.read().await;
        let terminal = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal not found: {}", terminal_id))?;

        let terminal = terminal.lock().await;
        Ok(serde_json::json!({
            "id": terminal.id,
            "sessionId": terminal.session_id,
            "command": terminal.command,
            "state": terminal.state,
            "exitCode": terminal.exit_code(),
            "exitStatus": terminal.exit_status()
        }))
    }

    /// List all terminal IDs
    pub async fn list(&self) -> Vec<String> {
        let terminals = self.terminals.read().await;
        terminals.keys().cloned().collect()
    }
}
