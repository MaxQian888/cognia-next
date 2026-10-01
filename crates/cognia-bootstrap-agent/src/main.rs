use clap::{Args, Parser, Subcommand};
use cognia_bootstrap_agent::{
    config::Config,
    conversation::Conversation,
    model,
    runner::{self, ResultRecord, Status},
};
use cognia_exec_sandbox::proc_group::{apply_process_group, kill_process_group};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;

#[derive(Parser)]
#[command(
    name = "cognia-bootstrap",
    version,
    about = "Bounded standalone task and environment initialization agent"
)]
struct Cli {
    #[command(subcommand)]
    command: Mode,
}
#[derive(Subcommand)]
enum Mode {
    Run(Common),
    Init(Initialize),
    Chat(Common),
    Configure(Configure),
}
#[derive(Args)]
struct Common {
    #[arg(
        long,
        required_unless_present = "config_env",
        conflicts_with = "config_env"
    )]
    config: Option<PathBuf>,
    #[arg(long, required_unless_present = "config", conflicts_with = "config")]
    config_env: Option<String>,
    #[arg(long)]
    cwd: Option<PathBuf>,
    #[arg(long)]
    task: Option<String>,
    #[arg(long)]
    session: Option<PathBuf>,
    #[arg(long, conflicts_with = "session")]
    no_session: bool,
    /// Suppress tool diagnostics in interactive mode.
    #[arg(long)]
    quiet: bool,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    base_url: Option<String>,
    #[arg(long)]
    api_key_env: Option<String>,
    #[arg(long)]
    max_tokens: Option<u64>,
    #[arg(long)]
    system_prompt: Option<String>,
    #[arg(long, action = clap::ArgAction::Set)]
    stream: Option<bool>,
    /// Override any config field using dotted.path=JSON or /json/pointer=JSON.
    #[arg(long = "set")]
    overrides: Vec<String>,
}
#[derive(Args)]
struct Configure {
    #[arg(long, default_value = "bootstrap.json")]
    output: PathBuf,
    #[arg(long)]
    force: bool,
    #[arg(long)]
    base_url: Option<String>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long, default_value = "COGNIA_BOOTSTRAP_API_KEY")]
    api_key_env: String,
    /// Generate defaults without prompting; never writes a credential.
    #[arg(long)]
    non_interactive: bool,
}
#[derive(Args)]
struct Initialize {
    #[command(flatten)]
    common: Common,
    #[arg(long)]
    force: bool,
    #[arg(long)]
    state: Option<PathBuf>,
    #[arg(long)]
    then: bool,
    #[arg(last = true)]
    next: Vec<OsString>,
}

fn emit(result: &ResultRecord) {
    if let Ok(value) = serde_json::to_string(result) {
        println!("{value}");
    }
}

async fn read_config(common: &Common) -> Result<Config, &'static str> {
    let text = if let Some(path) = &common.config {
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| "config-read-failed")?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "config-read-failed")?;
        if bytes.len() > 1024 * 1024 {
            return Err("config-too-large");
        }
        String::from_utf8(bytes).map_err(|_| "invalid-config")?
    } else {
        let name = common.config_env.as_ref().ok_or("invalid-cli")?;
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        {
            return Err("invalid-config-env");
        }
        std::env::var(name).map_err(|_| "config-read-failed")?
    };
    let mut value: Value = serde_json::from_str(&text).map_err(|_| "invalid-config")?;
    apply_overrides(&mut value, common)?;
    Config::parse(&value.to_string())
}

fn set_value(value: &mut Value, path: &str, replacement: Value) -> Result<(), &'static str> {
    let parts: Vec<String> = if let Some(pointer) = path.strip_prefix('/') {
        pointer
            .split('/')
            .map(|part| part.replace("~1", "/").replace("~0", "~"))
            .collect()
    } else {
        path.split('.').map(str::to_owned).collect()
    };
    if parts.is_empty() || parts.len() > 64 || parts.iter().any(String::is_empty) {
        return Err("invalid-override");
    }
    let mut current = value;
    for part in &parts[..parts.len() - 1] {
        if current.is_null() {
            *current = json!({});
        }
        current = match current {
            Value::Object(object) => object.entry(part.clone()).or_insert_with(|| json!({})),
            Value::Array(array) => array
                .get_mut(part.parse::<usize>().map_err(|_| "invalid-override")?)
                .ok_or("invalid-override")?,
            _ => return Err("invalid-override"),
        };
    }
    if current.is_null() {
        *current = json!({});
    }
    let last = parts.last().ok_or("invalid-override")?;
    match current {
        Value::Object(object) => {
            object.insert(last.clone(), replacement);
        }
        Value::Array(array) if last == "-" => array.push(replacement),
        Value::Array(array) => {
            *array
                .get_mut(last.parse::<usize>().map_err(|_| "invalid-override")?)
                .ok_or("invalid-override")? = replacement
        }
        _ => return Err("invalid-override"),
    }
    Ok(())
}

fn apply_overrides(value: &mut Value, common: &Common) -> Result<(), &'static str> {
    apply_overrides_from(value, common, |name| std::env::var(name).ok())
}

fn apply_overrides_from(
    value: &mut Value,
    common: &Common,
    env: impl Fn(&str) -> Option<String>,
) -> Result<(), &'static str> {
    // Legacy DSH names remain usable; Cognia names take precedence.
    for (names, path, kind) in [
        (
            &["BASE_URL", "COGNIA_BOOTSTRAP_BASE_URL"][..],
            "model.baseUrl",
            0,
        ),
        (
            &["MODEL_NAME", "COGNIA_BOOTSTRAP_MODEL"][..],
            "model.model",
            0,
        ),
        (&["COGNIA_BOOTSTRAP_API_KEY_ENV"][..], "model.apiKeyEnv", 0),
        (
            &["DSH_MAX_TOKENS", "COGNIA_BOOTSTRAP_MAX_TOKENS"][..],
            "model.maxTokens",
            1,
        ),
        (
            &["DSH_MAX_STEPS", "COGNIA_BOOTSTRAP_MAX_STEPS"][..],
            "limits.maxSteps",
            1,
        ),
        (
            &["DSH_COMMAND_TIMEOUT", "COGNIA_BOOTSTRAP_COMMAND_TIMEOUT"][..],
            "limits.commandTimeoutSecs",
            1,
        ),
        (
            &["DSH_API_TIMEOUT", "COGNIA_BOOTSTRAP_API_TIMEOUT"][..],
            "model.requestTimeoutSecs",
            1,
        ),
        (
            &["DSH_SHOW_THINKING", "COGNIA_BOOTSTRAP_SHOW_THINKING"][..],
            "model.showThinking",
            2,
        ),
        (
            &["DSH_STREAM", "COGNIA_BOOTSTRAP_STREAM"][..],
            "model.stream",
            2,
        ),
        (
            &["DSH_SYSTEM_PROMPT", "COGNIA_BOOTSTRAP_SYSTEM_PROMPT"][..],
            "systemPrompt",
            0,
        ),
        (
            &["DSH_CONTEXT_WINDOW", "COGNIA_BOOTSTRAP_CONTEXT_WINDOW"][..],
            "context.contextWindowTokens",
            1,
        ),
        (
            &["DSH_AUTO_COMPACT", "COGNIA_BOOTSTRAP_AUTO_COMPACT"][..],
            "context.autoCompact",
            2,
        ),
        (
            &[
                "DSH_COMPACT_THRESHOLD",
                "COGNIA_BOOTSTRAP_COMPACT_THRESHOLD",
            ][..],
            "context.compactThresholdTokens",
            1,
        ),
        (
            &["DSH_COMPACT_RETAIN", "COGNIA_BOOTSTRAP_COMPACT_RETAIN"][..],
            "context.compactRetainTokens",
            1,
        ),
        (
            &[
                "DSH_COMPACT_MAX_TOKENS",
                "COGNIA_BOOTSTRAP_COMPACT_MAX_TOKENS",
            ][..],
            "context.compactMaxTokens",
            1,
        ),
        (
            &["DSH_COMPACT_RETRIES", "COGNIA_BOOTSTRAP_COMPACT_RETRIES"][..],
            "context.compactRetries",
            1,
        ),
        (
            &[
                "DSH_MAX_OVERFLOW_RETRIES",
                "COGNIA_BOOTSTRAP_MAX_OVERFLOW_RETRIES",
            ][..],
            "context.maxOverflowRetries",
            1,
        ),
    ] {
        for name in names {
            if let Some(text) = env(name) {
                if text.is_empty()
                    && matches!(
                        path,
                        "context.compactThresholdTokens" | "context.compactRetainTokens"
                    )
                {
                    set_value(value, path, Value::Null)?;
                    continue;
                }
                let replacement = match kind {
                    0 => json!(text),
                    1 => json!(text.parse::<u64>().map_err(|_| "invalid-override")?),
                    _ => json!(match text.as_str() {
                        "1" | "true" => true,
                        "0" | "false" => false,
                        _ => return Err("invalid-override"),
                    }),
                };
                set_value(value, path, replacement)?;
            }
        }
    }
    for name in ["DSH_REASONING_EFFORT", "COGNIA_BOOTSTRAP_REASONING_EFFORT"] {
        if let Some(effort) = env(name) {
            if effort == "none" {
                set_value(value, "model.thinking", json!({"type":"disabled"}))?;
                set_value(value, "model.reasoningEffort", Value::Null)?;
            } else {
                set_value(value, "model.thinking", json!({"type":"enabled"}))?;
                set_value(value, "model.reasoningEffort", json!(effort))?;
            }
        }
    }
    for (path, replacement) in [
        ("model.model", common.model.as_ref().map(|v| json!(v))),
        ("model.baseUrl", common.base_url.as_ref().map(|v| json!(v))),
        (
            "model.apiKeyEnv",
            common.api_key_env.as_ref().map(|v| json!(v)),
        ),
        ("model.maxTokens", common.max_tokens.map(|v| json!(v))),
        (
            "systemPrompt",
            common.system_prompt.as_ref().map(|v| json!(v)),
        ),
        ("model.stream", common.stream.map(|v| json!(v))),
    ] {
        if let Some(replacement) = replacement {
            set_value(value, path, replacement)?;
        }
    }
    for entry in &common.overrides {
        let (path, json) = entry.split_once('=').ok_or("invalid-override")?;
        let replacement = serde_json::from_str(json).map_err(|_| "invalid-override")?;
        set_value(value, path, replacement)?;
    }
    Ok(())
}

async fn signals(tx: watch::Sender<bool>, terminated: Arc<AtomicBool>) {
    #[cfg(unix)]
    {
        let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            let _ = tx.send(true);
            return;
        };
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => { let _ = tx.send(true); },
                _ = terminate.recv() => { terminated.store(true,Ordering::SeqCst); let _ = tx.send(true); return; }
            }
        }
    }
    #[cfg(not(unix))]
    {
        while tokio::signal::ctrl_c().await.is_ok() {
            let _ = tx.send(true);
        }
        let _ = tx.send(true);
        terminated.store(true, Ordering::SeqCst);
    }
}

async fn handoff(
    argv: &[OsString],
    root: &std::path::Path,
    secret_env: &[String],
    config_env: Option<&str>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<i32, &'static str> {
    if *cancel.borrow() {
        return Err("cancelled");
    }
    let mut command = tokio::process::Command::new(argv.first().ok_or("invalid-handoff")?);
    command
        .args(&argv[1..])
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    for name in secret_env {
        command.env_remove(name);
    }
    if let Some(name) = config_env {
        command.env_remove(name);
    }
    apply_process_group(&mut command);
    let mut child = command.spawn().map_err(|_| "handoff-start-failed")?;
    let pid = child.id();
    let result = tokio::select! { biased;
        _ = model::cancellation(cancel) => { kill_process_group(pid); let _ = child.kill().await; let _ = child.wait().await; Err("cancelled") },
        status = child.wait() => status.map(|s| {
            #[cfg(unix)] { use std::os::unix::process::ExitStatusExt; s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(1)) }
            #[cfg(not(unix))] { s.code().unwrap_or(1) }
        }).map_err(|_| "handoff-wait-failed"),
    };
    kill_process_group(pid);
    result
}

async fn bounded_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    limit: usize,
) -> Result<Option<String>, &'static str> {
    use tokio::io::AsyncBufReadExt;
    let mut bytes = Vec::new();
    let mut overflow = false;
    loop {
        let available = reader.fill_buf().await.map_err(|_| "stdin-read-failed")?;
        if available.is_empty() {
            if overflow {
                return Err("input-too-large");
            }
            return if bytes.is_empty() {
                Ok(None)
            } else {
                String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| "invalid-input")
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |position| position + 1);
        if !overflow {
            if count > limit.saturating_sub(bytes.len()) {
                overflow = true;
            } else {
                bytes.extend_from_slice(&available[..count]);
            }
        }
        reader.consume(count);
        if newline.is_some() {
            if overflow {
                return Err("input-too-large");
            }
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "invalid-input");
        }
    }
}

async fn task_text(task: &str, limit: usize) -> Result<String, &'static str> {
    if task != "-" {
        return if task.len() <= limit {
            Ok(task.to_owned())
        } else {
            Err("input-too-large")
        };
    }
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    tokio::io::stdin()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "stdin-read-failed")?;
    if bytes.len() > limit {
        return Err("input-too-large");
    }
    String::from_utf8(bytes).map_err(|_| "invalid-input")
}

fn session_path(common: &Common, root: &std::path::Path, chat: bool) -> Option<PathBuf> {
    if common.no_session {
        return None;
    }
    let path = common
        .session
        .clone()
        .or_else(|| {
            std::env::var_os("COGNIA_BOOTSTRAP_SESSION_FILE")
                .or_else(|| std::env::var_os("DSH_SESSION_FILE"))
                .map(PathBuf::from)
        })
        .or_else(|| chat.then(|| PathBuf::from("session.jsonl")))?;
    if path.as_os_str().is_empty() {
        None
    } else if path.is_absolute() {
        Some(path)
    } else {
        Some(root.join(path))
    }
}

#[cfg(unix)]
async fn prompt_secret(name: &str, cancel: &mut watch::Receiver<bool>) -> Result<(), &'static str> {
    use std::io::Read;
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open("/dev/tty")
        .map_err(|_| "missing-credential")?;
    let mut previous = std::mem::MaybeUninit::<libc::termios>::uninit();
    if unsafe { libc::tcgetattr(tty.as_raw_fd(), previous.as_mut_ptr()) } != 0 {
        return Err("terminal-read-failed");
    }
    let previous = unsafe { previous.assume_init() };
    struct Restore(i32, libc::termios);
    impl Drop for Restore {
        fn drop(&mut self) {
            unsafe {
                libc::tcsetattr(self.0, libc::TCSANOW, &self.1);
            }
        }
    }
    let _restore = Restore(tty.as_raw_fd(), previous);
    let mut hidden = previous;
    hidden.c_lflag &= !libc::ECHO;
    if unsafe { libc::tcsetattr(tty.as_raw_fd(), libc::TCSANOW, &hidden) } != 0 {
        return Err("terminal-read-failed");
    }
    write!(tty, "API key for {name} (hidden, this process only): ")
        .map_err(|_| "terminal-read-failed")?;
    tty.flush().map_err(|_| "terminal-read-failed")?;
    let mut bytes = Vec::new();
    loop {
        if *cancel.borrow() {
            return Err("cancelled");
        }
        let mut byte = [0];
        let count = match tty.read(&mut byte) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::select! { biased;
                    _ = model::cancellation(cancel) => return Err("cancelled"),
                    _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
                }
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("terminal-read-failed"),
        };
        if count == 0 || byte[0] == b'\n' {
            break;
        }
        if bytes.len() >= 8192 {
            return Err("invalid-credential");
        }
        bytes.push(byte[0]);
    }
    writeln!(tty).map_err(|_| "terminal-read-failed")?;
    let key = String::from_utf8(bytes).map_err(|_| "invalid-credential")?;
    if key.trim().is_empty() || key.chars().any(char::is_control) {
        return Err("missing-credential");
    }
    std::env::set_var(name, key);
    Ok(())
}

async fn configure(args: Configure) -> Result<(), &'static str> {
    let mut reader = tokio::io::BufReader::new(tokio::io::stdin());
    let mut base_url = args
        .base_url
        .unwrap_or_else(|| "https://api.deepseek.com".into());
    let mut model = args.model.unwrap_or_else(|| "deepseek-v4-flash".into());
    let mut task =
        "Inspect this workspace and help with the requested engineering task.".to_owned();
    if !args.non_interactive {
        for (label, target) in [
            ("API base URL", &mut base_url),
            ("Model ID", &mut model),
            ("Default task", &mut task),
        ] {
            eprint!("{label} [{}]: ", target);
            std::io::stderr()
                .flush()
                .map_err(|_| "terminal-write-failed")?;
            let answer = bounded_line(&mut reader, 32000)
                .await?
                .ok_or("configure-input-ended")?;
            if !answer.trim().is_empty() {
                *target = answer.trim().to_owned();
            }
        }
    }
    let config = Config::parse(&json!({"version":1,"task":task,"model":{"baseUrl":base_url,"model":model,"apiKeyEnv":args.api_key_env,"stream":true,"requestTimeoutSecs":600,"maxTokens":32768},"tools":{"profile":"dsh"},"limits":{"maxSteps":100,"commandTimeoutSecs":300,"maxContextBytes":8*1024*1024}}).to_string())?;
    let parent = args
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    if let Ok(metadata) = args.output.symlink_metadata() {
        if !metadata.is_file() || !args.force {
            return Err("config-already-exists");
        }
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "config-write-failed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "config-write-failed")?;
    }
    serde_json::to_writer_pretty(&mut temporary, &config).map_err(|_| "config-write-failed")?;
    writeln!(temporary).map_err(|_| "config-write-failed")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "config-write-failed")?;
    if args.force {
        temporary
            .persist(&args.output)
            .map_err(|_| "config-write-failed")?;
    } else {
        temporary
            .persist_noclobber(&args.output)
            .map_err(|_| "config-already-exists")?;
    }
    eprintln!("Saved {}. Set {} in your environment, or enter it privately when chat starts. Credentials are never saved in this file.",args.output.display(),config.model.api_key_env);
    Ok(())
}

async fn chat(
    config: &Config,
    common: &Common,
    root: &std::path::Path,
    tx: &watch::Sender<bool>,
    cancel: &mut watch::Receiver<bool>,
    terminated: &AtomicBool,
) -> Result<(), &'static str> {
    use std::io::IsTerminal;
    #[cfg(unix)]
    if config.model.auth != cognia_bootstrap_agent::config::Auth::None
        && std::env::var(&config.model.api_key_env).map_or(true, |key| key.is_empty())
        && std::io::stdin().is_terminal()
    {
        loop {
            match prompt_secret(&config.model.api_key_env, cancel).await {
                Err("cancelled") if !terminated.load(Ordering::SeqCst) => {
                    let _ = tx.send(false);
                    eprintln!("[Interrupted]");
                }
                result => {
                    result?;
                    break;
                }
            }
        }
    }
    let path = session_path(common, root, true);
    let mut conversation = Conversation::new(config, root, path.as_deref(), cancel).await?;
    conversation.set_verbose(!common.quiet);
    if conversation.completed_turns() > 0 {
        eprintln!(
            "Resumed {} completed turn(s). Shell state starts fresh.",
            conversation.completed_turns()
        );
    }
    eprintln!("/compact summarizes history; /clear resets history and shell; /help lists commands; /exit quits.");
    let mut reader = tokio::io::BufReader::new(tokio::io::stdin());
    let mut initial = common.task.clone();
    let result = loop {
        if terminated.load(Ordering::SeqCst) {
            break Err("cancelled");
        }
        let line = if let Some(task) = initial.take() {
            tokio::select! { biased;
                _ = model::cancellation(cancel) => { if terminated.load(Ordering::SeqCst) { break Err("cancelled"); } let _ = tx.send(false); eprintln!("[Interrupted]"); continue; },
                task = task_text(&task,config.limits.max_context_bytes) => task.map(Some),
            }
        } else {
            if std::io::stdin().is_terminal() {
                eprint!("> ");
                let _ = std::io::stderr().flush();
            }
            tokio::select! { biased;
                _ = model::cancellation(cancel) => { if terminated.load(Ordering::SeqCst) { break Err("cancelled"); } let _ = tx.send(false); eprintln!("[Interrupted]"); continue; },
                line = bounded_line(&mut reader,config.limits.max_context_bytes) => line,
            }
        };
        let line = match line {
            Ok(Some(line)) => line,
            Ok(None) => break Ok(()),
            Err(error) => {
                eprintln!("[{error}]");
                continue;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match line {
            "/exit" | "/quit" => break Ok(()),
            "/help" => {
                eprintln!("/compact  summarize earlier complete turns\n/clear    erase transcript and reset the persistent shell\n/exit     quit (also /quit or Ctrl+D)\nCtrl+C    cancel the current turn and return to the prompt");
                continue;
            }
            "/clear" => {
                if let Err(error) = conversation.clear().await {
                    eprintln!("[{error}]");
                } else {
                    eprintln!("[Conversation and shell cleared]");
                }
                continue;
            }
            "/compact" => {
                eprintln!("[Compacting context ...]");
                match conversation.compact(true, cancel).await {
                    Ok(true) => eprintln!("[Context compacted]"),
                    Ok(false) => eprintln!("[No older context to compact]"),
                    Err(error) => eprintln!("[{error}]"),
                }
                if *cancel.borrow() {
                    let _ = tx.send(false);
                }
                continue;
            }
            _ => {}
        }
        eprintln!("[Deep diving ...]");
        let mut wrote_text = false;
        let mut observer = |event| match event {
            model::ModelEvent::Text(text) => {
                print!("{text}");
                let _ = std::io::stdout().flush();
                wrote_text = true;
            }
            model::ModelEvent::Thinking(text) => {
                if config.model.show_thinking {
                    eprintln!("{text}");
                }
            }
        };
        match conversation.turn(line, cancel, &mut observer).await {
            Ok(text) => {
                if !wrote_text {
                    print!("{text}");
                }
                println!();
            }
            Err(error) => {
                eprintln!("[{error}]");
                if terminated.load(Ordering::SeqCst) {
                    break Err(error);
                }
            }
        }
        if *cancel.borrow() {
            let _ = tx.send(false);
        }
    };
    conversation.close().await;
    result
}

#[tokio::main]
async fn main() {
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(error)
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) =>
        {
            print!("{error}");
            return;
        }
        Err(_) => {
            emit(&ResultRecord::error("invalid-cli"));
            std::process::exit(2);
        }
    };
    let (common, init, force, state, next, interactive) = match cli.command {
        Mode::Configure(args) => {
            if let Err(error) = configure(args).await {
                emit(&ResultRecord::error(error));
                std::process::exit(2);
            }
            return;
        }
        Mode::Chat(c) => (c, false, false, None, Vec::new(), true),
        Mode::Run(c) => (c, false, false, None, Vec::new(), false),
        Mode::Init(i) => {
            if i.then == i.next.is_empty() {
                emit(&ResultRecord::error("invalid-handoff"));
                std::process::exit(2);
            }
            (i.common, true, i.force, i.state, i.next, false)
        }
    };
    let mut config = match read_config(&common).await {
        Ok(c) => c,
        Err(code) => {
            emit(&ResultRecord::error(code));
            std::process::exit(2);
        }
    };
    let root = match common
        .cwd
        .clone()
        .or_else(|| {
            std::env::var_os("COGNIA_BOOTSTRAP_CWD")
                .or_else(|| std::env::var_os("DSH_CWD"))
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("."))
        .canonicalize()
    {
        Ok(p) if p.is_dir() => p,
        _ => {
            emit(&ResultRecord::error("invalid-cwd"));
            std::process::exit(2);
        }
    };
    let (tx, mut cancel) = watch::channel(false);
    let terminated = Arc::new(AtomicBool::new(false));
    let signal_task = tokio::spawn(signals(tx.clone(), terminated.clone()));
    if interactive {
        let result = chat(&config, &common, &root, &tx, &mut cancel, &terminated).await;
        signal_task.abort();
        if let Err(error) = result {
            let result = ResultRecord::error(error);
            emit(&result);
            std::process::exit(result.exit_code());
        }
        std::process::exit(0);
    }
    if let Some(task) = &common.task {
        let task_result = tokio::select! { biased;
            _ = model::cancellation(&mut cancel) => Err("cancelled"),
            task = task_text(task,config.limits.max_context_bytes) => task,
        };
        config.task = match task_result {
            Ok(task) => task,
            Err(error) => {
                emit(&ResultRecord::error(error));
                std::process::exit(if error == "cancelled" { 130 } else { 2 });
            }
        };
        if let Err(error) = config.validate() {
            emit(&ResultRecord::error(error));
            std::process::exit(2);
        }
    }
    let session = session_path(&common, &root, false);
    let result = if !init && session.is_some() {
        match Conversation::new(&config, &root, session.as_deref(), &mut cancel).await {
            Ok(mut conversation) => {
                let result = match conversation
                    .turn(&config.task, &mut cancel, &mut |_| {})
                    .await
                {
                    Ok(message) => ResultRecord {
                        version: 1,
                        status: Status::Completed,
                        steps: conversation.last_steps(),
                        message,
                        checks: conversation.take_checks(),
                        reused: false,
                        error_code: None,
                    },
                    Err(error) => {
                        let mut result = ResultRecord::error(error);
                        result.steps = conversation.last_steps();
                        result.checks = conversation.take_checks();
                        result
                    }
                };
                conversation.close().await;
                result
            }
            Err(error) => ResultRecord::error(error),
        }
    } else {
        runner::run(
            &config,
            &root,
            runner::Options { init, force, state },
            &mut cancel,
        )
        .await
    };
    let mut exit = result.exit_code();
    let ready = matches!(result.status, Status::Ready);
    emit(&result);
    if ready && !next.is_empty() {
        let mut credentials = config.credential_env_names();
        credentials.push(config.model.api_key_env.clone());
        exit = match handoff(
            &next,
            &root,
            &credentials,
            common.config_env.as_deref(),
            &mut cancel,
        )
        .await
        {
            Ok(code) => code,
            Err(code) => {
                let r = ResultRecord::error(code);
                emit(&r);
                r.exit_code()
            }
        };
    }
    signal_task.abort();
    std::process::exit(exit);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_handoff_without_shell_interpolation() {
        let c = Cli::try_parse_from([
            "cognia-bootstrap",
            "init",
            "--config",
            "file.json",
            "--then",
            "--",
            "sh",
            "-c",
            "echo ready",
        ])
        .unwrap();
        let Mode::Init(i) = c.command else {
            panic!("init")
        };
        assert!(i.then);
        assert_eq!(i.next.len(), 3);
    }
    #[test]
    fn requires_exactly_one_config_source() {
        assert!(Cli::try_parse_from(["cognia-bootstrap", "run"]).is_err());
        assert!(Cli::try_parse_from([
            "cognia-bootstrap",
            "run",
            "--config",
            "a",
            "--config-env",
            "B"
        ])
        .is_err());
    }
    #[test]
    fn every_config_field_can_be_overridden_without_another_cli_flag() {
        let Cli {
            command: Mode::Chat(common),
        } = Cli::try_parse_from([
            "cognia-bootstrap",
            "chat",
            "--config",
            "a",
            "--model",
            "custom-model",
            "--stream",
            "false",
            "--set",
            "context.autoCompact=false",
            "--set",
            "/model/headers/X-Custom=\"value\"",
            "--set",
            "tools.shellArgs=[\"--norc\"]",
        ])
        .unwrap()
        else {
            panic!("chat")
        };
        let mut value = json!({"version":1,"task":"task","model":{"baseUrl":"https://example.org/v1","model":"old"}});
        apply_overrides(&mut value, &common).unwrap();
        let config = Config::parse(&value.to_string()).unwrap();
        assert_eq!(config.model.model, "custom-model");
        assert!(!config.model.stream);
        assert!(!config.context.auto_compact);
        assert_eq!(config.model.headers["X-Custom"], "value");
        assert_eq!(config.tools.shell_args, vec!["--norc"]);
        assert!(set_value(&mut value, "model.model.invalid", json!(1)).is_err());
        set_value(
            &mut value,
            "checks",
            json!([{"name":"ready","command":"false"}]),
        )
        .unwrap();
        set_value(&mut value, "/checks/0/command", json!("true")).unwrap();
        set_value(
            &mut value,
            "/checks/-",
            json!({"name":"another","command":"true"}),
        )
        .unwrap();
        set_value(&mut value, "model.thinking", Value::Null).unwrap();
        set_value(&mut value, "model.thinking.type", json!("enabled")).unwrap();
        let config = Config::parse(&value.to_string()).unwrap();
        assert_eq!(config.checks[0].command, "true");
        assert_eq!(config.checks.len(), 2);
        assert_eq!(config.model.thinking.unwrap()["type"], "enabled");
    }
    #[test]
    fn override_precedence_and_dsh_context_defaults_are_stable() {
        let Cli {
            command: Mode::Run(mut common),
        } = Cli::try_parse_from(["cognia-bootstrap", "run", "--config", "a"]).unwrap()
        else {
            panic!("run")
        };
        let environment = std::collections::HashMap::from([
            ("MODEL_NAME", "legacy"),
            ("COGNIA_BOOTSTRAP_MODEL", "cognia"),
            ("DSH_COMPACT_THRESHOLD", ""),
            ("DSH_COMPACT_RETAIN", ""),
            ("DSH_REASONING_EFFORT", "none"),
        ]);
        let lookup = |name: &str| environment.get(name).map(|v| (*v).to_owned());
        let initial = json!({"version":1,"task":"task","model":{"baseUrl":"https://example.org/v1","model":"file","reasoningEffort":"high"},"context":{"compactThresholdTokens":1000,"compactRetainTokens":100}});
        let mut value = initial.clone();
        apply_overrides_from(&mut value, &common, lookup).unwrap();
        let config = Config::parse(&value.to_string()).unwrap();
        assert_eq!(config.model.model, "cognia");
        assert_eq!(config.model.reasoning_effort, None);
        assert_eq!(config.model.thinking.unwrap(), json!({"type":"disabled"}));
        assert_eq!(config.context.compact_threshold_tokens, None);
        assert_eq!(config.context.compact_retain_tokens, None);
        common.model = Some("dedicated".into());
        value = initial.clone();
        apply_overrides_from(&mut value, &common, lookup).unwrap();
        assert_eq!(value["model"]["model"], "dedicated");
        common.overrides = vec!["model.model=\"generic\"".into()];
        value = initial;
        apply_overrides_from(&mut value, &common, lookup).unwrap();
        assert_eq!(value["model"]["model"], "generic");
    }

    #[tokio::test]
    async fn bounded_input_recovers_after_an_oversized_line() {
        let mut reader = tokio::io::BufReader::new(&b"oversized\nnext\n"[..]);
        assert_eq!(
            bounded_line(&mut reader, 5).await.err(),
            Some("input-too-large")
        );
        assert_eq!(
            bounded_line(&mut reader, 5).await.unwrap(),
            Some("next\n".into())
        );
        assert_eq!(bounded_line(&mut reader, 5).await.unwrap(), None);
    }
    #[tokio::test]
    async fn configuration_wizard_never_overwrites_or_persists_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("bootstrap.json");
        configure(Configure {
            output: output.clone(),
            force: false,
            base_url: Some("http://localhost:1234/v1".into()),
            model: Some("any-local-model".into()),
            api_key_env: "PRIVATE_MODEL_KEY".into(),
            non_interactive: true,
        })
        .await
        .unwrap();
        let text = std::fs::read_to_string(&output).unwrap();
        let config = Config::parse(&text).unwrap();
        assert_eq!(config.model.model, "any-local-model");
        assert_eq!(config.model.api_key_env, "PRIVATE_MODEL_KEY");
        assert!(text.contains("apiKeyEnv"));
        assert!(!text.contains("apiKey\""));
        let before = text;
        assert_eq!(
            configure(Configure {
                output: output.clone(),
                force: false,
                base_url: None,
                model: None,
                api_key_env: "OTHER_KEY".into(),
                non_interactive: true
            })
            .await,
            Err("config-already-exists")
        );
        assert_eq!(std::fs::read_to_string(output).unwrap(), before);
    }
    #[tokio::test]
    async fn handoff_propagates_exit() {
        let dir = tempfile::tempdir().unwrap();
        let (_sender, mut cancel) = watch::channel(false);
        assert_eq!(
            handoff(
                &["sh".into(), "-c".into(), "exit 7".into()],
                dir.path(),
                &["COGNIA_TEST_KEY".into()],
                None,
                &mut cancel
            )
            .await
            .unwrap(),
            7
        );
    }
}
