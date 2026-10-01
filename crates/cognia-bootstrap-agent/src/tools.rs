//! Small, bounded bootstrap tools. The shell is an owned process group; the
//! editor uses directory-relative operations so a symlink cannot redirect edits.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::config::ToolConfig;
use cognia_exec_sandbox::proc_group::{apply_process_group, kill_process_group};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, watch};

const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONFIGURED_TEXT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub shell_reset: bool,
}

impl ToolResult {
    fn error(message: impl Into<String>) -> Self {
        Self {
            output: message.into(),
            exit_code: None,
            timed_out: false,
            cancelled: false,
            shell_reset: false,
        }
    }

    fn success(output: String) -> Self {
        Self {
            output,
            exit_code: Some(0),
            timed_out: false,
            cancelled: false,
            shell_reset: false,
        }
    }

    fn cancelled() -> Self {
        let mut result = Self::error("Tool execution cancelled.");
        result.cancelled = true;
        result
    }
}

/// Validate once before a batch is executed, and again at the tool boundary.
pub fn validate_call(name: &str, args: &Value) -> Result<(), String> {
    if name == "bash" {
        return validate_call("shell", args);
    }
    if name == "str_replace_editor" {
        return normalize_dsh_editor(args).map(|_| ());
    }
    let object = args.as_object().ok_or("Tool arguments must be an object")?;
    let allowed: &[&str] = match name {
        "shell" => {
            required_text(args, "command", MAX_COMMAND_BYTES)?;
            if let Some(timeout) = object.get("timeoutSecs") {
                let timeout = timeout
                    .as_u64()
                    .ok_or("timeoutSecs must be a positive integer")?;
                if !(1..=3600).contains(&timeout) {
                    return Err("timeoutSecs must be between 1 and 3600".into());
                }
            }
            &["command", "timeoutSecs"]
        }
        "editor" => {
            required_text(args, "path", 4096)?;
            match args.get("action").and_then(Value::as_str) {
                Some("view") => {
                    for key in ["startLine", "endLine"] {
                        if let Some(value) = object.get(key) {
                            positive_line(value, key)?;
                        }
                    }
                    if let (Some(start), Some(end)) = (args.get("startLine"), args.get("endLine")) {
                        if start.as_u64() > end.as_u64() {
                            return Err("startLine must not exceed endLine".into());
                        }
                    }
                    &["action", "path", "startLine", "endLine"]
                }
                Some("create") => {
                    text(args, "content", MAX_CONFIGURED_TEXT_BYTES)?;
                    &["action", "path", "content"]
                }
                Some("replace") => {
                    required_text(args, "oldText", MAX_CONFIGURED_TEXT_BYTES)?;
                    text(args, "newText", MAX_CONFIGURED_TEXT_BYTES)?;
                    &["action", "path", "oldText", "newText"]
                }
                Some("insert") => {
                    text(args, "newText", MAX_CONFIGURED_TEXT_BYTES)?;
                    positive_line(args.get("line").ok_or("insert requires line")?, "line")?;
                    &["action", "path", "line", "newText"]
                }
                _ => return Err("editor action must be view, create, replace, or insert".into()),
            }
        }
        _ => return Err(format!("Unknown tool: {name}")),
    };
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("Unknown {name} argument: {key}"));
    }
    Ok(())
}

/// Translate the reference tool's arguments without changing its line semantics.
fn normalize_dsh_editor(args: &Value) -> Result<Value, String> {
    use serde_json::json;
    let object = args.as_object().ok_or("Tool arguments must be an object")?;
    let allowed = [
        "command",
        "path",
        "file_text",
        "old_str",
        "new_str",
        "insert_line",
        "view_range",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unknown str_replace_editor argument".into());
    }
    let path = required_text(args, "path", 4096)?;
    if !Path::new(path).is_absolute() {
        return Err("str_replace_editor requires an absolute path".into());
    }
    let mut normalized = json!({"path":path, "dsh":true});
    match args.get("command").and_then(Value::as_str) {
        Some("view") => {
            normalized["action"] = json!("view");
            if let Some(range) = args.get("view_range").filter(|v| !v.is_null()) {
                let range = range
                    .as_array()
                    .filter(|v| v.len() == 2)
                    .ok_or("view_range must be [start,end]")?;
                positive_line(&range[0], "view_range start")?;
                let end = range[1]
                    .as_i64()
                    .filter(|end| *end == -1 || *end > 0)
                    .ok_or("view_range end must be positive or -1")?;
                if end != -1 && range[0].as_u64().unwrap_or(0) > end as u64 {
                    return Err("view_range start exceeds end".into());
                }
                normalized["startLine"] = range[0].clone();
                if end != -1 {
                    normalized["endLine"] = json!(end);
                }
                normalized["hasRange"] = json!(true);
            }
        }
        Some("create") => {
            normalized["action"] = json!("create");
            normalized["content"] = json!(text(args, "file_text", MAX_CONFIGURED_TEXT_BYTES)?);
        }
        Some("str_replace") => {
            normalized["action"] = json!("replace");
            normalized["oldText"] =
                json!(required_text(args, "old_str", MAX_CONFIGURED_TEXT_BYTES)?);
            normalized["newText"] = json!(if object.contains_key("new_str") {
                text(args, "new_str", MAX_CONFIGURED_TEXT_BYTES)?
            } else {
                ""
            });
        }
        Some("insert") => {
            normalized["action"] = json!("insert");
            normalized["newText"] = json!(text(args, "new_str", MAX_CONFIGURED_TEXT_BYTES)?);
            let line = args
                .get("insert_line")
                .and_then(Value::as_u64)
                .filter(|line| *line <= usize::MAX as u64)
                .ok_or("insert_line must be a nonnegative integer")?;
            normalized["line"] = json!(line);
        }
        _ => return Err("Unknown str_replace_editor command".into()),
    }
    Ok(normalized)
}

fn text<'a>(args: &'a Value, key: &str, limit: usize) -> Result<&'a str, String> {
    let value = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))?;
    if value.len() > limit || value.contains('\0') {
        return Err(format!("{key} exceeds its size limit or contains NUL"));
    }
    Ok(value)
}

fn required_text<'a>(args: &'a Value, key: &str, limit: usize) -> Result<&'a str, String> {
    let value = text(args, key, limit)?;
    if value.is_empty() {
        return Err(format!("{key} must not be empty"));
    }
    Ok(value)
}

fn positive_line(value: &Value, key: &str) -> Result<usize, String> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{key} must be a positive line number"))
}

pub struct Tools {
    root: PathBuf,
    command_timeout: Duration,
    output_limit: usize,
    secret_env: Vec<String>,
    shell: Option<mpsc::Sender<ShellRequest>>,
    config: ToolConfig,
}

impl Tools {
    /// The first secret environment name is the model credential. Remaining
    /// names may be explicitly granted to trusted user-configured scripts.
    #[cfg(test)]
    pub fn new(
        root: &Path,
        command_timeout: Duration,
        output_limit: usize,
        secret_env: &[String],
    ) -> Result<Self, String> {
        Self::with_config(
            root,
            command_timeout,
            output_limit,
            secret_env,
            &ToolConfig::default(),
        )
    }

    pub fn with_config(
        root: &Path,
        command_timeout: Duration,
        output_limit: usize,
        secret_env: &[String],
        config: &ToolConfig,
    ) -> Result<Self, String> {
        if !cfg!(unix) {
            return Err("Bootstrap tools currently require Linux or macOS process groups".into());
        }
        let root = root
            .canonicalize()
            .map_err(|error| format!("Invalid workspace: {error}"))?;
        if !root.is_dir() {
            return Err("Workspace must be a directory".into());
        }
        if command_timeout.is_zero() || command_timeout > Duration::from_secs(3600) {
            return Err("Command timeout must be between zero and 3600 seconds".into());
        }
        if !(256..=MAX_TEXT_BYTES).contains(&output_limit) {
            return Err("Output limit must be between 256 bytes and 4 MiB".into());
        }
        if !(256..=MAX_CONFIGURED_TEXT_BYTES).contains(&config.max_file_bytes)
            || config.shell_executable.is_empty()
            || config.shell_executable.contains('\0')
            || config.shell_args.iter().any(|arg| arg.contains('\0'))
        {
            return Err("Invalid shell or file limit configuration".into());
        }
        Ok(Self {
            root,
            command_timeout,
            output_limit,
            secret_env: secret_env.to_vec(),
            shell: None,
            config: config.clone(),
        })
    }

    pub async fn execute(
        &mut self,
        name: &str,
        args: &Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> ToolResult {
        if let Err(error) = validate_call(name, args) {
            return ToolResult::error(error);
        }
        if *cancel.borrow() {
            return ToolResult::cancelled();
        }
        if name == "editor" || name == "str_replace_editor" {
            if !self.config.editor {
                return ToolResult::error("Editor tool is disabled");
            }
            let normalized;
            let args = if name == "str_replace_editor" {
                normalized = match normalize_dsh_editor(args) {
                    Ok(value) => value,
                    Err(error) => return ToolResult::error(error),
                };
                &normalized
            } else {
                args
            };
            return match self.edit(args) {
                Ok(output) => ToolResult::success(preview(output.as_bytes(), self.output_limit)),
                Err(error) => ToolResult::error(error),
            };
        }
        if !self.config.shell {
            return ToolResult::error("Shell tool is disabled");
        }
        if self.shell.is_none() {
            let (sender, receiver) = mpsc::channel(1);
            tokio::spawn(shell_worker(
                self.root.clone(),
                self.secret_env.clone(),
                self.output_limit,
                self.config.clone(),
                receiver,
            ));
            self.shell = Some(sender);
        }
        let timeout = args
            .get("timeoutSecs")
            .and_then(Value::as_u64)
            .map(Duration::from_secs)
            .unwrap_or(self.command_timeout)
            .min(self.command_timeout);
        let (reply, receive) = oneshot::channel();
        let request = ShellRequest::Run {
            command: args["command"].as_str().unwrap_or_default().into(),
            timeout,
            cancel: cancel.clone(),
            reply,
        };
        let Some(sender) = &self.shell else {
            return ToolResult::error("Shell unavailable");
        };
        if sender.send(request).await.is_err() {
            self.shell = None;
            return ToolResult::error("Shell worker stopped; retry the command");
        }
        receive
            .await
            .unwrap_or_else(|_| ToolResult::error("Shell worker stopped"))
    }

    /// Readiness always runs in a fresh shell, independent of model shell state.
    pub async fn run_check(&self, command: &str, cancel: &mut watch::Receiver<bool>) -> ToolResult {
        self.run_fresh(command, cancel, &[]).await
    }

    /// Credential grants apply only to a fresh fixed setup/check command.
    pub async fn run_trusted(
        &self,
        command: &str,
        cancel: &mut watch::Receiver<bool>,
        allowed_secret_env: &[String],
    ) -> ToolResult {
        for allowed in allowed_secret_env {
            if startup_env(allowed)
                || self
                    .secret_env
                    .first()
                    .is_some_and(|model| model.eq_ignore_ascii_case(allowed))
                || !self.secret_env.contains(allowed)
            {
                return ToolResult::error(format!(
                    "Trusted credential grant is invalid or names the model credential: {allowed}"
                ));
            }
        }
        self.run_fresh(command, cancel, allowed_secret_env).await
    }

    async fn run_fresh(
        &self,
        command: &str,
        cancel: &mut watch::Receiver<bool>,
        allowed_secret_env: &[String],
    ) -> ToolResult {
        if command.is_empty() || command.len() > MAX_COMMAND_BYTES || command.contains('\0') {
            return ToolResult::error("Check command is empty, too large, or contains NUL");
        }
        if *cancel.borrow() {
            return ToolResult::cancelled();
        }
        let mut process = match ShellProcess::spawn(
            &self.root,
            &self.secret_env,
            allowed_secret_env,
            &self.config,
        ) {
            Ok(process) => process,
            Err(error) => return ToolResult::error(error),
        };
        let mut result = process
            .run(
                command,
                self.command_timeout,
                self.output_limit,
                cancel,
                None,
            )
            .await;
        process.close().await;
        result.shell_reset = false;
        result
    }

    pub async fn close(&mut self) {
        if let Some(sender) = self.shell.take() {
            let (reply, receive) = oneshot::channel();
            if sender.send(ShellRequest::Close(reply)).await.is_ok() {
                let _ = receive.await;
            }
        }
    }

    pub async fn reset(&mut self) {
        self.close().await;
    }

    #[cfg(unix)]
    fn edit(&self, args: &Value) -> Result<String, String> {
        editor::edit(
            &self.root,
            args,
            self.config.max_file_bytes,
            self.output_limit,
        )
    }

    #[cfg(not(unix))]
    fn edit(&self, _args: &Value) -> Result<String, String> {
        Err("Editor requires Linux or macOS".into())
    }
}

enum ShellRequest {
    Run {
        command: String,
        timeout: Duration,
        cancel: watch::Receiver<bool>,
        reply: oneshot::Sender<ToolResult>,
    },
    Close(oneshot::Sender<()>),
}

async fn shell_worker(
    root: PathBuf,
    secrets: Vec<String>,
    output_limit: usize,
    config: ToolConfig,
    mut receiver: mpsc::Receiver<ShellRequest>,
) {
    let mut process: Option<ShellProcess> = None;
    let mut state_lost = false;
    let mut idle_buffer = [0_u8; 8192];
    loop {
        // Keep draining background output even while no model call is running.
        let request = if let Some(shell) = process.as_mut() {
            tokio::select! {
                request = receiver.recv() => request,
                read = shell.stdout.read(&mut idle_buffer) => {
                    if !matches!(read, Ok(count) if count > 0) {
                        shell.close().await;
                        process = None;
                        state_lost = true;
                    }
                    continue;
                }
            }
        } else {
            receiver.recv().await
        };
        match request {
            Some(ShellRequest::Run {
                command,
                timeout,
                mut cancel,
                mut reply,
            }) => {
                if reply.is_closed() || *cancel.borrow() {
                    let _ = reply.send(ToolResult::cancelled());
                    continue;
                }
                if process.is_none() {
                    match ShellProcess::spawn(&root, &secrets, &[], &config) {
                        Ok(shell) => process = Some(shell),
                        Err(error) => {
                            let _ = reply.send(ToolResult::error(error));
                            continue;
                        }
                    }
                }
                if let Some(shell) = process.as_mut() {
                    let mut result = shell
                        .run(
                            &command,
                            timeout,
                            output_limit,
                            &mut cancel,
                            Some(&mut reply),
                        )
                        .await;
                    if result.shell_reset {
                        shell.close().await;
                        process = None;
                    }
                    if state_lost && !result.shell_reset {
                        result.shell_reset = true;
                        result.output.insert_str(
                            0,
                            "[Previous shell exited; state was reset before this command.]\n",
                        );
                    }
                    state_lost = false;
                    let _ = reply.send(result);
                }
            }
            Some(ShellRequest::Close(reply)) => {
                if let Some(shell) = process.as_mut() {
                    shell.close().await;
                }
                let _ = reply.send(());
                break;
            }
            None => break,
        }
    }
    if let Some(shell) = process.as_mut() {
        shell.close().await;
    }
}

struct ShellProcess {
    child: Child,
    pid: Option<u32>,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl Drop for ShellProcess {
    fn drop(&mut self) {
        // Tokio's kill_on_drop reaps the leader; also kill its entire group.
        kill_process_group(self.pid);
    }
}

impl ShellProcess {
    fn spawn(
        root: &Path,
        secret_env: &[String],
        allowed_secret_env: &[String],
        config: &ToolConfig,
    ) -> Result<Self, String> {
        let mut command = Command::new(&config.shell_executable);
        command
            .args(&config.shell_args)
            .arg("-s")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (name, value) in std::env::vars_os() {
            let name_text = name.to_string_lossy();
            // Bash 3 exports functions using values rather than BASH_FUNC names.
            if value.to_string_lossy().trim_start().starts_with("() {")
                || startup_env(&name_text)
                || (!allowed_secret_env
                    .iter()
                    .any(|allowed| name_text == allowed.as_str())
                    && (secret_env.iter().any(|secret| name_text == secret.as_str())
                        || sensitive_env(&name_text)))
            {
                command.env_remove(name);
            }
        }
        // Deterministic locale keeps shell diagnostics UTF-8-friendly.
        command.env("LC_ALL", "C");
        for (name, value) in &config.environment {
            // Defense in depth for callers constructing ToolConfig directly.
            if sensitive_env(name)
                || secret_env
                    .iter()
                    .any(|secret| secret.eq_ignore_ascii_case(name))
                || value.trim_start().starts_with("() {")
            {
                return Err(
                    "Custom shell environment contains a credential or startup hook".into(),
                );
            }
            command.env(name, value);
        }
        apply_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start shell: {error}"))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Shell stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Shell stdout unavailable")?;
        Ok(Self {
            child,
            pid,
            stdin,
            stdout,
        })
    }

    async fn close(&mut self) {
        kill_process_group(self.pid);
        let _ = self.child.wait().await;
        self.pid = None;
    }

    async fn run(
        &mut self,
        command: &str,
        timeout: Duration,
        output_limit: usize,
        cancel: &mut watch::Receiver<bool>,
        mut reply: Option<&mut oneshot::Sender<ToolResult>>,
    ) -> ToolResult {
        let token = format!("\u{1e}COGNIA_{}:", uuid::Uuid::new_v4().simple());
        let script = format!(
            "exec 2>&1\ncommand eval '{}' < /dev/null\ncommand printf '\\036COGNIA_{}:%d\\037' \"$?\"\n",
            command.replace('\'', "'\\''"),
            token.trim_start_matches('\u{1e}').trim_start_matches("COGNIA_").trim_end_matches(':')
        );
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let mut output = BoundedOutput::new(output_limit);
        let mut pending = Vec::new();
        let mut buffer = [0_u8; 8192];
        let mut result = ToolResult::error("");
        let write = self.stdin.write_all(script.as_bytes());
        tokio::pin!(write);
        let written = tokio::select! {
            value = &mut write => value.is_ok(),
            _ = &mut deadline => { result.timed_out = true; false },
            _ = cancelled(cancel) => { result.cancelled = true; false },
            _ = reply_closed(&mut reply) => { result.cancelled = true; false },
        };
        if !written {
            result.shell_reset = true;
            result.output = reset_notice(&result);
            return result;
        }
        loop {
            tokio::select! {
                _ = &mut deadline => {
                    result.timed_out = true;
                    result.shell_reset = true;
                    break;
                }
                _ = cancelled(cancel) => {
                    result.cancelled = true;
                    result.shell_reset = true;
                    break;
                }
                _ = reply_closed(&mut reply) => {
                    result.cancelled = true;
                    result.shell_reset = true;
                    break;
                }
                read = self.stdout.read(&mut buffer) => {
                    match read {
                        Ok(0) => {
                            tokio::select! {
                                status = self.child.wait() => {
                                    result.exit_code = status.ok().and_then(|status| status.code());
                                }
                                _ = &mut deadline => { result.timed_out = true; }
                                _ = cancelled(cancel) => { result.cancelled = true; }
                                _ = reply_closed(&mut reply) => { result.cancelled = true; }
                            }
                            result.shell_reset = true;
                            break;
                        }
                        Ok(count) => {
                            pending.extend_from_slice(&buffer[..count]);
                            if let Some((start, end, code)) = completion(&pending, token.as_bytes()) {
                                output.push(&pending[..start]);
                                // Bytes after the marker belong to background tasks, never the next request.
                                let _ = end;
                                pending.clear();
                                result.exit_code = Some(code);
                                break;
                            }
                            let keep = token.len() + 16;
                            if pending.len() > keep {
                                let flush = pending.len() - keep;
                                output.push(&pending[..flush]);
                                pending.drain(..flush);
                            }
                        }
                        Err(error) => {
                            output.push(format!("\nShell output error: {error}").as_bytes());
                            result.shell_reset = true;
                            break;
                        }
                    }
                }
            }
        }
        output.push(&pending);
        result.output = output.finish();
        if result.shell_reset {
            result.output.push_str(&reset_notice(&result));
        }
        result
    }
}

fn startup_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.starts_with("BASH_FUNC_")
        || [
            "BASH_ENV",
            "ENV",
            "SHELLOPTS",
            "BASHOPTS",
            "CDPATH",
            "GLOBIGNORE",
            "NODE_OPTIONS",
            "NODE_PATH",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONHOME",
            "PERL5OPT",
            "PERL5LIB",
            "RUBYOPT",
            "RUBYLIB",
            "LD_PRELOAD",
            "LD_AUDIT",
            "LD_LIBRARY_PATH",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "DYLD_FRAMEWORK_PATH",
        ]
        .contains(&upper.as_str())
}

fn sensitive_env(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    startup_env(name)
        || [
            "SSH_AUTH_SOCK",
            "SSH_AGENT_PID",
            "GIT_ASKPASS",
            "SSH_ASKPASS",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_SHARED_CREDENTIALS_FILE",
            "AWS_CONFIG_FILE",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AZURE_OPENAI_KEY",
            "AZURE_CLIENT_SECRET",
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "NPM_TOKEN",
            "HF_TOKEN",
            "HUGGING_FACE_HUB_TOKEN",
            "DATABASE_URL",
            "REDIS_URL",
        ]
        .contains(&upper.as_str())
        || upper.ends_with("_API_KEY")
        || upper.ends_with("_TOKEN")
        || upper.ends_with("_SECRET")
        || upper.ends_with("_PASSWORD")
        || upper == "API_KEY"
        || upper == "TOKEN"
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            // Dropping the cancellation authority terminates work safely.
            return;
        }
    }
}

async fn reply_closed(reply: &mut Option<&mut oneshot::Sender<ToolResult>>) {
    if let Some(reply) = reply.as_mut() {
        reply.closed().await;
    } else {
        std::future::pending::<()>().await;
    }
}

fn completion(bytes: &[u8], token: &[u8]) -> Option<(usize, usize, i32)> {
    let start = bytes.windows(token.len()).position(|part| part == token)?;
    let rest = &bytes[start + token.len()..];
    let end = rest.iter().position(|byte| *byte == 0x1f)?;
    if end > 3 || end == 0 || !rest[..end].iter().all(u8::is_ascii_digit) {
        return None;
    }
    let code = std::str::from_utf8(&rest[..end])
        .ok()?
        .parse::<i32>()
        .ok()?;
    (code <= 255).then_some((start, start + token.len() + end + 1, code))
}

fn reset_notice(result: &ToolResult) -> String {
    let reason = if result.timed_out {
        "Command timed out"
    } else if result.cancelled {
        "Command cancelled"
    } else {
        "Shell exited or disconnected"
    };
    format!("\n[{reason}; process group terminated. Shell state reset.]")
}

struct BoundedOutput {
    limit: usize,
    total: usize,
    head: Vec<u8>,
    tail: VecDeque<u8>,
}

impl BoundedOutput {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            total: 0,
            head: Vec::new(),
            tail: VecDeque::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len());
        let head_count = bytes
            .len()
            .min((self.limit / 2).saturating_sub(self.head.len()));
        self.head.extend_from_slice(&bytes[..head_count]);
        let tail_limit = self.limit - self.limit / 2;
        let remaining = &bytes[head_count..];
        if remaining.len() >= tail_limit {
            self.tail.clear();
            self.tail.extend(&remaining[remaining.len() - tail_limit..]);
        } else {
            let discard = (self.tail.len() + remaining.len()).saturating_sub(tail_limit);
            self.tail.drain(..discard);
            self.tail.extend(remaining);
        }
    }

    fn finish(self) -> String {
        let tail: Vec<_> = self.tail.into_iter().collect();
        let mut output = String::from_utf8_lossy(&self.head).replace('\0', "\\0");
        let mut tail = String::from_utf8_lossy(&tail).replace('\0', "\\0");
        let expanded = output.len() + tail.len() > self.limit;
        let head_limit = self.limit / 2;
        if output.len() > head_limit {
            let mut end = head_limit;
            while !output.is_char_boundary(end) {
                end -= 1;
            }
            output.truncate(end);
        }
        let tail_limit = self.limit - head_limit;
        if tail.len() > tail_limit {
            let mut start = tail.len() - tail_limit;
            while !tail.is_char_boundary(start) {
                start += 1;
            }
            tail.drain(..start);
        }
        if self.total > self.limit || expanded {
            output.push_str(&format!(
                "\n[output preview truncated; {} bytes received]\n",
                self.total
            ));
        }
        output.push_str(&tail);
        output
    }
}

fn preview(bytes: &[u8], limit: usize) -> String {
    let mut output = BoundedOutput::new(limit);
    output.push(bytes);
    output.finish()
}

/// Reuse fingerprints share the editor's descriptor-relative confinement.
#[cfg(unix)]
pub(crate) fn read_reuse_input(root: &Path, path: &str, limit: usize) -> Result<Vec<u8>, String> {
    editor::read_bytes(root, path, limit)
}
#[cfg(not(unix))]
pub(crate) fn read_reuse_input(
    _root: &Path,
    _path: &str,
    _limit: usize,
) -> Result<Vec<u8>, String> {
    Err("Reuse inputs require Unix file confinement".into())
}

#[cfg(unix)]
mod editor {
    use super::*;
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    struct Target {
        parent: File,
        name: CString,
        limit: usize,
    }

    impl Target {
        fn open(root: &Path, raw: &str, limit: usize) -> Result<Self, String> {
            let supplied = Path::new(raw);
            let relative = if supplied.is_absolute() {
                supplied
                    .strip_prefix(root)
                    .map_err(|_| "Path escapes workspace")?
            } else {
                supplied
            };
            let mut segments = Vec::new();
            for component in relative.components() {
                match component {
                    Component::Normal(segment) => segments.push(segment),
                    Component::CurDir => {}
                    _ => return Err("Parent traversal and escaped paths are forbidden".into()),
                }
            }
            let name = segments.pop().ok_or("A file path is required")?;
            let mut parent = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(root)
                .map_err(|error| format!("Cannot open workspace: {error}"))?;
            for segment in segments {
                let segment = CString::new(segment.as_bytes()).map_err(|_| "Path contains NUL")?;
                let descriptor = unsafe {
                    libc::openat(
                        parent.as_raw_fd(),
                        segment.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if descriptor < 0 {
                    return Err(format!(
                        "Cannot open parent directory (symlinks are forbidden): {}",
                        std::io::Error::last_os_error()
                    ));
                }
                parent = unsafe { File::from_raw_fd(descriptor) };
            }
            Ok(Self {
                parent,
                name: CString::new(name.as_bytes()).map_err(|_| "Path contains NUL")?,
                limit,
            })
        }

        fn read_bytes(&self) -> Result<(Vec<u8>, std::fs::Metadata), String> {
            let descriptor = unsafe {
                libc::openat(
                    self.parent.as_raw_fd(),
                    self.name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(format!(
                    "Cannot read file (symlinks are forbidden): {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut file = unsafe { File::from_raw_fd(descriptor) };
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            if !metadata.is_file() {
                return Err("Editor only accepts regular text files".into());
            }
            if metadata.len() > self.limit as u64 {
                return Err("Text file exceeds configured limit".into());
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take((self.limit + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            if bytes.len() > self.limit {
                return Err("File exceeds configured limit".into());
            }
            Ok((bytes, metadata))
        }

        fn read(&self) -> Result<(String, std::fs::Metadata), String> {
            let (bytes, metadata) = self.read_bytes()?;
            if bytes.contains(&0) {
                return Err("File is binary".into());
            }
            let content = String::from_utf8(bytes).map_err(|_| "File is not UTF-8 text")?;
            if content
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            {
                return Err("File contains binary control characters".into());
            }
            Ok((content, metadata))
        }

        fn write(
            &self,
            content: &str,
            observed: Option<(&str, &std::fs::Metadata)>,
        ) -> Result<(), String> {
            if content.len() > self.limit
                || content.chars().any(|character| {
                    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                })
            {
                return Err("Edited file is binary or exceeds configured limit".into());
            }
            let temp_name = CString::new(format!(
                ".cognia-bootstrap-{}.tmp",
                uuid::Uuid::new_v4().simple()
            ))
            .map_err(|error| error.to_string())?;
            let descriptor = unsafe {
                libc::openat(
                    self.parent.as_raw_fd(),
                    temp_name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if descriptor < 0 {
                return Err(format!(
                    "Cannot create atomic edit: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let cleanup = TempCleanup {
                parent: &self.parent,
                name: &temp_name,
            };
            let mut file = unsafe { File::from_raw_fd(descriptor) };
            file.write_all(content.as_bytes())
                .map_err(|error| error.to_string())?;
            if let Some((_, metadata)) = observed {
                file.set_permissions(std::fs::Permissions::from_mode(metadata.mode() & 0o777))
                    .map_err(|error| error.to_string())?;
            }
            file.sync_all().map_err(|error| error.to_string())?;
            let result = if let Some((expected, metadata)) = observed {
                let (actual, current) = self.read()?;
                if actual != expected
                    || current.dev() != metadata.dev()
                    || current.ino() != metadata.ino()
                    || current.mtime() != metadata.mtime()
                    || current.mtime_nsec() != metadata.mtime_nsec()
                    || current.ctime() != metadata.ctime()
                    || current.ctime_nsec() != metadata.ctime_nsec()
                {
                    return Err("File changed during edit; read it again before retrying".into());
                }
                unsafe {
                    libc::renameat(
                        self.parent.as_raw_fd(),
                        temp_name.as_ptr(),
                        self.parent.as_raw_fd(),
                        self.name.as_ptr(),
                    )
                }
            } else {
                // linkat is atomic and fails if *any* destination entry exists,
                // including symlinks: create never overwrites another writer.
                unsafe {
                    libc::linkat(
                        self.parent.as_raw_fd(),
                        temp_name.as_ptr(),
                        self.parent.as_raw_fd(),
                        self.name.as_ptr(),
                        0,
                    )
                }
            };
            if result != 0 {
                return Err(format!(
                    "Atomic edit failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            drop(cleanup);
            self.parent.sync_all().map_err(|error| error.to_string())?;
            Ok(())
        }
    }

    pub(super) fn read_bytes(root: &Path, path: &str, limit: usize) -> Result<Vec<u8>, String> {
        Target::open(root, path, limit)?
            .read_bytes()
            .map(|(bytes, _)| bytes)
    }

    struct TempCleanup<'a> {
        parent: &'a File,
        name: &'a CString,
    }

    impl Drop for TempCleanup<'_> {
        fn drop(&mut self) {
            unsafe {
                libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0);
            }
        }
    }

    pub(super) fn edit(
        root: &Path,
        args: &Value,
        limit: usize,
        output_limit: usize,
    ) -> Result<String, String> {
        let raw = args["path"].as_str().unwrap_or_default();
        let action = args["action"].as_str().unwrap_or_default();
        if action == "view" {
            // Opening the directory through parent descriptors never follows
            // symlinks, including during two-level enumeration.
            if let Ok(directory) = Target::open(root, &format!("{raw}/.cognia-list-entry"), limit) {
                if args.get("startLine").is_some()
                    || args.get("endLine").is_some()
                    || args["hasRange"] == true
                {
                    return Err("Line ranges only apply to files".into());
                }
                return list_directory(&directory.parent, raw, output_limit);
            }
        }
        let target = Target::open(root, raw, limit)?;
        if action == "create" {
            target.write(args["content"].as_str().unwrap_or_default(), None)?;
            return Ok("File created.".into());
        }
        let (content, metadata) = target.read()?;
        let dsh = args["dsh"] == true;
        if action == "view" {
            if dsh {
                let lines: Vec<_> = content.split('\n').collect();
                let start = args.get("startLine").and_then(Value::as_u64).unwrap_or(1) as usize;
                let end = args
                    .get("endLine")
                    .and_then(Value::as_u64)
                    .map(|n| n as usize)
                    .unwrap_or(lines.len());
                if start > end || end > lines.len() {
                    return Err("view_range is outside the file".into());
                }
                let mut output = String::new();
                for (index, line) in lines[start - 1..end].iter().enumerate() {
                    output.push_str(&format!("{:6}  {line}\n", start + index));
                    if output.len() > output_limit {
                        break;
                    }
                }
                return Ok(output);
            }
            let lines: Vec<_> = content.split_inclusive('\n').collect();
            let start = args.get("startLine").and_then(Value::as_u64).unwrap_or(1) as usize;
            let end = args
                .get("endLine")
                .and_then(Value::as_u64)
                .map(|line| line as usize)
                .unwrap_or(lines.len());
            if content.is_empty()
                && args.get("startLine").is_none()
                && args.get("endLine").is_none()
            {
                return Ok(String::new());
            }
            if start > lines.len() || end > lines.len() || start > end {
                return Err(format!("Line range exceeds file length ({})", lines.len()));
            }
            return Ok(lines[start - 1..end].concat());
        }
        let updated = if action == "replace" {
            let old = args["oldText"].as_str().unwrap_or_default();
            let matches = content
                .as_bytes()
                .windows(old.len())
                .filter(|window| *window == old.as_bytes())
                .count();
            if matches != 1 {
                return Err(format!(
                    "oldText must match exactly once; found {matches} matches"
                ));
            }
            content.replacen(old, args["newText"].as_str().unwrap_or_default(), 1)
        } else if dsh {
            let line = args["line"].as_u64().unwrap_or(u64::MAX) as usize;
            let mut lines: Vec<_> = content.split('\n').collect();
            if line > lines.len() {
                return Err("insert_line is outside the file".into());
            }
            lines.insert(line, args["newText"].as_str().unwrap_or_default());
            lines.join("\n")
        } else {
            let line = args["line"].as_u64().unwrap_or(0) as usize;
            let mut offsets = vec![0];
            offsets.extend(
                content
                    .match_indices('\n')
                    .map(|(position, _)| position + 1),
            );
            if offsets.last().copied() != Some(content.len()) {
                offsets.push(content.len());
            }
            let offset = offsets
                .get(line - 1)
                .copied()
                .ok_or_else(|| format!("Insertion line exceeds file length ({})", offsets.len()))?;
            let mut result = String::with_capacity(
                content.len() + args["newText"].as_str().unwrap_or_default().len(),
            );
            result.push_str(&content[..offset]);
            result.push_str(args["newText"].as_str().unwrap_or_default());
            result.push_str(&content[offset..]);
            result
        };
        target.write(&updated, Some((&content, &metadata)))?;
        Ok("File updated atomically.".into())
    }

    fn entries(
        directory: &File,
        max_bytes: usize,
    ) -> Result<(Vec<std::ffi::OsString>, bool), String> {
        use std::os::unix::ffi::OsStringExt;
        let descriptor = unsafe { libc::dup(directory.as_raw_fd()) };
        if descriptor < 0 {
            return Err("Cannot enumerate directory".into());
        }
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            unsafe {
                libc::close(descriptor);
            }
            return Err("Cannot enumerate directory".into());
        }
        struct DirStream(*mut libc::DIR);
        impl Drop for DirStream {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let stream = DirStream(stream);
        let mut names = Vec::new();
        let mut size = 0_usize;
        let mut clipped = false;
        loop {
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                break;
            }
            let bytes = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes.starts_with(b".") || bytes == b"node_modules" || bytes == b"__pycache__" {
                continue;
            }
            size = size.saturating_add(bytes.len() + 1);
            if size > max_bytes {
                clipped = true;
                break;
            }
            names.push(std::ffi::OsString::from_vec(bytes.to_vec()));
        }
        names.sort();
        Ok((names, clipped))
    }

    fn list_directory(directory: &File, raw: &str, output_limit: usize) -> Result<String, String> {
        let mut output = format!("{}/\n", raw.trim_end_matches('/'));
        let (children, mut clipped) = entries(directory, output_limit)?;
        for child in children {
            let path = Path::new(raw).join(&child);
            output.push_str(&format!("{}\n", path.to_string_lossy()));
            let name = CString::new(child.as_bytes()).map_err(|_| "Invalid directory entry")?;
            let descriptor = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor >= 0 {
                let directory = unsafe { File::from_raw_fd(descriptor) };
                let (grandchildren, truncated) =
                    entries(&directory, output_limit.saturating_sub(output.len()))?;
                clipped |= truncated;
                for entry in grandchildren {
                    output.push_str(&format!("{}\n", path.join(entry).to_string_lossy()));
                }
            }
            if output.len() > output_limit {
                clipped = true;
                break;
            }
        }
        if clipped {
            output.push_str("[Directory listing truncated]\n");
        }
        Ok(output)
    }

    use std::os::unix::fs::PermissionsExt;

    #[cfg(test)]
    pub(super) fn test_cas(root: &Path) {
        let target = Target::open(root, "cas.txt", MAX_TEXT_BYTES).expect("target");
        let (content, metadata) = target.read().expect("read");
        std::fs::write(root.join("cas.txt"), "external").expect("external update");
        assert!(target
            .write("replacement", Some((&content, &metadata)))
            .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("cas.txt")).expect("current"),
            "external"
        );
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;

    fn create_tools(root: &Path, timeout: Duration) -> Tools {
        Tools::new(root, timeout, 4096, &[]).expect("tools")
    }

    async fn shell(tools: &mut Tools, command: &str) -> ToolResult {
        let (_sender, mut cancel) = watch::channel(false);
        tools
            .execute("shell", &json!({"command": command}), &mut cancel)
            .await
    }

    #[test]
    fn validates_shapes_and_limits() {
        assert!(validate_call("shell", &json!({"command": "true", "unexpected": true})).is_err());
        assert!(validate_call("shell", &json!({"command": "true", "timeoutSecs": 0})).is_err());
        assert!(validate_call("shell", &json!({"command": "true", "timeoutSecs": 1.5})).is_err());
        assert!(validate_call(
            "editor",
            &json!({"action": "replace", "path": "a", "oldText": "", "newText": "b"})
        )
        .is_err());
        assert!(validate_call(
            "editor",
            &json!({"action": "view", "path": "a", "startLine": 3, "endLine": 2})
        )
        .is_err());
        assert!(validate_call(
            "editor",
            &json!({"action": "insert", "path": "a", "line": 0, "newText": "b"})
        )
        .is_err());
        assert!(validate_call(
            "editor",
            &json!({"action": "create", "path": "a", "content": "", "oldText": "a"})
        )
        .is_err());
    }

    #[test]
    fn editor_unique_replace_insert_and_ranges() {
        let directory = tempfile::tempdir().expect("tempdir");
        let tools = create_tools(directory.path(), Duration::from_secs(2));
        assert!(tools
            .edit(&json!({"action": "create", "path": "a", "content": "one\ntwo\nthree\n"}))
            .is_ok());
        assert_eq!(
            tools
                .edit(&json!({"action": "view", "path": "a", "startLine": 2, "endLine": 2}))
                .expect("range"),
            "two\n"
        );
        assert!(tools
            .edit(&json!({"action": "view", "path": "a", "endLine": 5}))
            .is_err());
        assert!(tools
            .edit(&json!({"action": "replace", "path": "a", "oldText": "two", "newText": "second"}))
            .is_ok());
        assert!(tools
            .edit(&json!({"action": "insert", "path": "a", "line": 2, "newText": "inserted\n"}))
            .is_ok());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("a")).expect("read"),
            "one\ninserted\nsecond\nthree\n"
        );
        std::fs::write(directory.path().join("overlap"), "aaa").expect("write");
        assert!(tools
            .edit(&json!({"action": "replace", "path": "overlap", "oldText": "aa", "newText": "b"}))
            .is_err());
        std::fs::write(directory.path().join("repeated"), "aa aa").expect("write");
        assert!(tools
            .edit(
                &json!({"action": "replace", "path": "repeated", "oldText": "aa", "newText": "b"})
            )
            .is_err());
    }

    #[test]
    fn editor_blocks_escapes_symlinks_binary_and_overwrites() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        let tools = create_tools(directory.path(), Duration::from_secs(2));
        std::fs::write(directory.path().join("a"), "original").expect("write");
        assert!(tools
            .edit(&json!({"action": "create", "path": "a", "content": "overwrite"}))
            .is_err());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("a")).expect("read"),
            "original"
        );
        assert!(tools
            .edit(&json!({"action": "create", "path": "../escape", "content": "x"}))
            .is_err());
        assert!(tools.edit(&json!({"action": "create", "path": outside.path().join("escape").to_str(), "content": "x"})).is_err());
        symlink(outside.path(), directory.path().join("link")).expect("symlink");
        assert!(tools
            .edit(&json!({"action": "create", "path": "link/new", "content": "x"}))
            .is_err());
        assert!(tools
            .edit(&json!({"action": "create", "path": "link/missing/new", "content": "x"}))
            .is_err());
        symlink(
            directory.path().join("a"),
            directory.path().join("file-link"),
        )
        .expect("symlink");
        assert!(tools
            .edit(&json!({"action": "view", "path": "file-link"}))
            .is_err());
        assert!(tools.edit(&json!({"action": "view", "path": "."})).is_ok());
        std::fs::write(directory.path().join("binary"), [0_u8, 255]).expect("binary");
        assert!(tools
            .edit(&json!({"action": "view", "path": "binary"}))
            .is_err());
        assert!(!outside.path().join("new").exists());
        assert!(!directory
            .path()
            .read_dir()
            .expect("entries")
            .any(|entry| entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
    }

    #[test]
    fn editor_cas_rejects_external_update() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("cas.txt"), "before").expect("write");
        editor::test_cas(directory.path());
    }

    #[tokio::test]
    async fn dsh_editor_exact_semantics_and_directory_views() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_secs(2));
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("example.txt");
        let path = file.to_str().unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let call = |command: &str, extra: Value| {
            let mut value = json!({"command":command,"path":path,"file_text":null,"old_str":null,"new_str":null,"insert_line":null,"view_range":null});
            for (key, item) in extra.as_object().unwrap() {
                value[key] = item.clone();
            }
            value
        };
        let result = tools
            .execute(
                "str_replace_editor",
                &call("create", json!({"file_text":"first\nlast\n"})),
                &mut cancel,
            )
            .await;
        assert_eq!(result.exit_code, Some(0), "{}", result.output);
        let result = tools
            .execute(
                "str_replace_editor",
                &call("view", json!({"view_range":[2,-1]})),
                &mut cancel,
            )
            .await;
        assert_eq!(result.output, "     2  last\n     3  \n");
        let result = tools
            .execute(
                "str_replace_editor",
                &call("insert", json!({"insert_line":0,"new_str":"before"})),
                &mut cancel,
            )
            .await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "before\nfirst\nlast\n"
        );
        let result = tools
            .execute(
                "str_replace_editor",
                &call("insert", json!({"insert_line":2,"new_str":"after first"})),
                &mut cancel,
            )
            .await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "before\nfirst\nafter first\nlast\n"
        );
        // Omission means deletion; a null new_str is invalid for replacement.
        assert!(validate_call(
            "str_replace_editor",
            &call("str_replace", json!({"old_str":"last"}))
        )
        .is_err());
        let result = tools
            .execute(
                "str_replace_editor",
                &json!({"command":"str_replace","path":path,"old_str":"last"}),
                &mut cancel,
            )
            .await;
        assert_eq!(result.exit_code, Some(0));
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        std::fs::write(directory.path().join("nested/child"), "a").unwrap();
        std::fs::create_dir(directory.path().join("node_modules")).unwrap();
        std::fs::write(directory.path().join(".hidden"), "hidden").unwrap();
        let result = tools
            .execute(
                "str_replace_editor",
                &json!({"command":"view","path":root.to_str()}),
                &mut cancel,
            )
            .await;
        assert_eq!(result.exit_code, Some(0), "{}", result.output);
        assert!(result.output.contains("nested/child"));
        assert!(!result.output.contains("node_modules"));
        assert!(!result.output.contains(".hidden"));
        assert!(validate_call(
            "str_replace_editor",
            &json!({"command":"view","path":"example.txt"})
        )
        .is_err());
        tools.close().await;
    }

    #[tokio::test]
    async fn custom_bash_environment_tool_toggles_and_file_limits() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut config = ToolConfig::default();
        config
            .environment
            .insert("BOOTSTRAP_CUSTOM".into(), "configured".into());
        config.max_file_bytes = 256;
        let mut tools =
            Tools::with_config(directory.path(), Duration::from_secs(2), 4096, &[], &config)
                .unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        let result = tools.execute("bash", &json!({"command":"items=(first second); printf '%s:%s' \"${items[1]}\" \"$BOOTSTRAP_CUSTOM\""}), &mut cancel).await;
        assert_eq!(result.output, "second:configured");
        let result = tools
            .execute(
                "editor",
                &json!({"action":"create","path":"too-big","content":"a".repeat(257)}),
                &mut cancel,
            )
            .await;
        assert!(result.exit_code.is_none());
        assert!(!directory.path().join("too-big").exists());
        tools.reset().await;
        tools.config.shell = false;
        let result = tools
            .execute("bash", &json!({"command":"touch forbidden"}), &mut cancel)
            .await;
        assert!(result.exit_code.is_none());
        assert!(!directory.path().join("forbidden").exists());
        tools.config.editor = false;
        let result = tools
            .execute(
                "editor",
                &json!({"action":"create","path":"forbidden","content":"a"}),
                &mut cancel,
            )
            .await;
        assert!(result.exit_code.is_none());
        // Readiness checks are host operations, independent of model tool grants.
        assert_eq!(
            tools.run_check("true", &mut cancel).await.exit_code,
            Some(0)
        );
        tools.close().await;
    }

    #[tokio::test]
    async fn shell_preserves_cwd_exports_and_functions_with_real_exit_codes() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(directory.path().join("nested")).expect("mkdir");
        let mut tools = create_tools(directory.path(), Duration::from_secs(3));
        assert_eq!(
            shell(
                &mut tools,
                "cd nested; export BOOTSTRAP_VALUE='persisted'; helper() { printf function; }"
            )
            .await
            .exit_code,
            Some(0)
        );
        let result = shell(
            &mut tools,
            "printf '%s:' \"$BOOTSTRAP_VALUE\"; helper; printf ':'; pwd; false",
        )
        .await;
        assert_eq!(result.exit_code, Some(1));
        assert!(
            result.output.starts_with("persisted:function:"),
            "{}",
            result.output
        );
        assert!(result.output.contains("nested"));
        assert!(!result.shell_reset);
        let result = shell(&mut tools, "printf no-newline").await;
        assert_eq!(result.output, "no-newline");
        assert_eq!(result.exit_code, Some(0));
        tools.close().await;
    }

    #[tokio::test]
    async fn shell_timeout_and_exit_reset_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_millis(150));
        let result = shell(&mut tools, "export STATE=present; sleep 30").await;
        assert!(result.timed_out && result.shell_reset);
        assert!(result.output.contains("Shell state reset"));
        assert_eq!(
            shell(&mut tools, "printf '%s' \"${STATE-unset}\"")
                .await
                .output,
            "unset"
        );
        let result = shell(&mut tools, "exit 7").await;
        assert_eq!(result.exit_code, Some(7));
        assert!(result.shell_reset);
        assert_eq!(
            shell(&mut tools, "printf restarted").await.output,
            "restarted"
        );
        tools.close().await;
        assert_eq!(
            shell(&mut tools, "printf reopened").await.output,
            "reopened"
        );
        tools.close().await;
    }

    #[tokio::test]
    async fn shell_closed_stdout_still_obeys_deadline() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_millis(150));
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            shell(&mut tools, "exec 1>&-; sleep 30"),
        )
        .await
        .expect("bounded");
        assert!(result.timed_out && result.shell_reset);
        tools.close().await;
    }

    #[tokio::test]
    async fn shell_large_and_invalid_utf8_output_drains_with_bounded_preview() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_secs(5));
        let result = shell(
            &mut tools,
            "printf HEAD; head -c 2000000 /dev/zero; printf '\\377TAIL'",
        )
        .await;
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output.starts_with("HEAD"));
        assert!(result.output.ends_with("TAIL"));
        assert!(result.output.contains("preview truncated"));
        assert!(result.output.len() < 4200);
        assert_eq!(shell(&mut tools, "printf next").await.output, "next");
        tools.close().await;
    }

    #[tokio::test]
    async fn readiness_uses_fresh_shell_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_secs(3));
        assert_eq!(
            shell(
                &mut tools,
                "export CHECK_FAKE=1; fake_ready() { return 0; }"
            )
            .await
            .exit_code,
            Some(0)
        );
        let (_sender, mut cancel) = watch::channel(false);
        let result = tools
            .run_check(
                "test -z \"$CHECK_FAKE\"; type fake_ready >/dev/null 2>&1",
                &mut cancel,
            )
            .await;
        assert_ne!(result.exit_code, Some(0));
        assert_eq!(
            tools
                .run_check("test -z \"$CHECK_FAKE\"", &mut cancel)
                .await
                .exit_code,
            Some(0)
        );
        tools.close().await;
    }

    #[tokio::test]
    async fn cancellation_and_dropped_futures_kill_grandchildren() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_secs(30));
        let (sender, mut cancel) = watch::channel(false);
        let pid_file = directory.path().join("grandchild");
        let command = "sleep 30 & child=$!; printf '%s' \"$child\" > grandchild; wait";
        let args = json!({"command": command});
        let execution = tools.execute("shell", &args, &mut cancel);
        tokio::pin!(execution);
        tokio::select! {
            _ = &mut execution => panic!("command should wait"),
            _ = wait_for_file(&pid_file) => {}
        }
        sender.send(true).expect("cancel");
        let result = execution.await;
        assert!(result.cancelled && result.shell_reset);
        assert_process_stopped(&pid_file).await;
        // The caller can drop execute during a total run-budget timeout.
        let directory2 = tempfile::tempdir().expect("tempdir");
        let mut tools2 = create_tools(directory2.path(), Duration::from_secs(30));
        let (_sender2, mut cancel2) = watch::channel(false);
        let mut execution = Box::pin(tools2.execute("shell", &args, &mut cancel2));
        let pid_file2 = directory2.path().join("grandchild");
        tokio::select! {
            _ = &mut execution => panic!("command should wait"),
            _ = wait_for_file(&pid_file2) => {}
        }
        drop(execution);
        tools2.close().await;
        assert_process_stopped(&pid_file2).await;
    }

    #[tokio::test]
    async fn dropping_fresh_check_kills_grandchildren() {
        let directory = tempfile::tempdir().expect("tempdir");
        let tools = create_tools(directory.path(), Duration::from_secs(30));
        let (_sender, mut cancel) = watch::channel(false);
        let command = "sleep 30 & child=$!; printf '%s' \"$child\" > grandchild; wait";
        let mut execution = Box::pin(tools.run_check(command, &mut cancel));
        let pid_file = directory.path().join("grandchild");
        tokio::select! {
            _ = &mut execution => panic!("command should wait"),
            _ = wait_for_file(&pid_file) => {}
        }
        drop(execution);
        assert_process_stopped(&pid_file).await;
    }

    #[tokio::test]
    async fn already_cancelled_does_not_start_tools() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut tools = create_tools(directory.path(), Duration::from_secs(3));
        let (_sender, mut cancel) = watch::channel(true);
        assert!(
            tools
                .execute(
                    "shell",
                    &json!({"command": "touch should-not-exist"}),
                    &mut cancel
                )
                .await
                .cancelled
        );
        assert!(
            tools
                .run_check("touch should-not-exist", &mut cancel)
                .await
                .cancelled
        );
        assert!(!directory.path().join("should-not-exist").exists());
    }

    #[tokio::test]
    async fn trusted_grants_only_accept_declared_non_model_credentials() {
        let directory = tempfile::tempdir().expect("tempdir");
        let tools = Tools::new(
            directory.path(),
            Duration::from_secs(2),
            4096,
            &[
                "MODEL_API_KEY".into(),
                "PRIVATE_NPM_TOKEN".into(),
                "BASH_ENV".into(),
            ],
        )
        .expect("tools");
        let (_sender, mut cancel) = watch::channel(false);
        for forbidden in [
            "MODEL_API_KEY",
            "model_api_key",
            "UNKNOWN_SECRET",
            "BASH_ENV",
        ] {
            let result = tools
                .run_trusted("touch forbidden", &mut cancel, &[forbidden.into()])
                .await;
            assert!(result.exit_code.is_none(), "{forbidden}");
        }
        assert!(!directory.path().join("forbidden").exists());
        let result = tools
            .run_trusted("printf trusted", &mut cancel, &["PRIVATE_NPM_TOKEN".into()])
            .await;
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.output, "trusted");
    }

    #[test]
    fn credentials_and_startup_injection_are_filtered() {
        for name in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "AWS_SECRET_ACCESS_KEY",
            "BASH_ENV",
            "ENV",
            "NODE_OPTIONS",
            "SSH_AUTH_SOCK",
            "BASH_FUNC_inject%%",
        ] {
            assert!(sensitive_env(name), "{name}");
        }
        assert!(!sensitive_env("PATH"));
        assert!(!sensitive_env("TERM"));
    }

    #[test]
    fn marker_and_output_handle_chunk_boundaries() {
        assert_eq!(
            completion(
                b"before\x1eCOGNIA_unique:13\x1fafter",
                b"\x1eCOGNIA_unique:"
            ),
            Some((6, 24, 13))
        );
        assert!(completion(b"before\x1eCOGNIA_unique:13", b"\x1eCOGNIA_unique:").is_none());
        assert_eq!(
            preview(b"123456789abcdef", 10),
            "12345\n[output preview truncated; 15 bytes received]\nbcdef"
        );
        assert_eq!(preview(b"short", 10), "short");
    }

    async fn wait_for_file(path: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(path).is_ok_and(|value| !value.is_empty()) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("grandchild pid published");
    }

    async fn assert_process_stopped(path: &Path) {
        let pid = std::fs::read_to_string(path)
            .expect("pid")
            .parse::<i32>()
            .expect("pid integer");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let alive = unsafe { libc::kill(pid, 0) } == 0;
                if !alive {
                    return;
                }
                // A killed child may briefly remain a zombie awaiting the init
                // process; it cannot execute or retain resources other than PID.
                #[cfg(target_os = "linux")]
                if std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|value| {
                    value
                        .rsplit_once(") ")
                        .is_some_and(|(_, rest)| rest.starts_with('Z'))
                }) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("grandchild stopped");
    }
}
