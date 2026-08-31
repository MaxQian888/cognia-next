//! macOS launchd implementation
//!
//! Uses launchctl and plist files for task scheduling.

#![cfg(target_os = "macos")]

use async_trait::async_trait;
use log::{debug, error, info, warn};
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::error::{Result, SchedulerError};
use super::service::{generate_task_name, is_cognia_task, now_iso, SystemScheduler, TASK_PREFIX};
use super::types::{
    derive_trigger_capabilities, validate_open_url, CreateSystemTaskInput, RunLevel,
    SchedulerCapabilities, SystemTask, SystemTaskAction, SystemTaskStatus, SystemTaskTrigger,
    SystemTriggerKind, TaskMetadataState, TaskRunResult, TranslationValidation, TriggerCapability,
};

/// macOS launchd scheduler implementation
pub struct MacOSScheduler {
    /// Whether launchctl is available
    available: bool,
    /// LaunchAgents directory path
    agents_dir: PathBuf,
}

impl MacOSScheduler {
    /// Create a new macOS scheduler instance
    pub fn new() -> Self {
        let available = Self::check_launchctl_available();
        let agents_dir = Self::get_agents_dir();

        info!(
            "macOS scheduler initialized: available={}, dir={:?}",
            available, agents_dir
        );

        Self {
            available,
            agents_dir,
        }
    }

    /// Check if launchctl is available
    fn check_launchctl_available() -> bool {
        Command::new("launchctl")
            .arg("list")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Get the LaunchAgents directory for current user
    fn get_agents_dir() -> PathBuf {
        dirs::home_dir()
            .map(|h| h.join("Library").join("LaunchAgents"))
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    }

    /// Generate plist filename for a task
    fn plist_path(&self, task_name: &str) -> PathBuf {
        let label = Self::task_to_label(task_name);
        self.agents_dir.join(format!("{}.plist", label))
    }

    /// Convert task name to launchd label
    fn task_to_label(task_name: &str) -> String {
        format!("com.cognia.task.{}", task_name.replace(' ', "_"))
    }

    /// Convert a launchd label back to a Cognia task display name, or `None`
    /// when the label is not a Cognia-owned task. Applies the same
    /// `is_cognia_task` ownership gate the Windows backend uses when listing
    /// tasks, so foreign LaunchAgents that merely share our reverse-DNS prefix
    /// are skipped. The internal `TASK_PREFIX` (`Cognia_`) body marker is
    /// stripped so the surfaced name matches what the user originally entered —
    /// without this, a listed task fed back through `update_task`
    /// (delete + recreate) would acquire a second `Cognia_` prefix.
    fn label_to_task(label: &str) -> Option<String> {
        let body = label.strip_prefix("com.cognia.task.")?;
        if !is_cognia_task(body) {
            return None;
        }
        Some(
            body.strip_prefix(TASK_PREFIX)
                .unwrap_or(body)
                .replace('_', " "),
        )
    }

    /// Generate plist content for a task
    fn generate_plist(task: &SystemTask) -> Result<String> {
        let label = Self::task_to_label(&task.name);
        let (program, args) = Self::build_program_args(&task.action)?;

        let mut plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
"#,
            label, program
        );

        for arg in args {
            plist.push_str(&format!(
                "        <string>{}</string>\n",
                Self::escape_xml(&arg)
            ));
        }

        plist.push_str("    </array>\n");

        // Add trigger configuration
        match &task.trigger {
            SystemTaskTrigger::Cron { expression, .. } => {
                let calendar = Self::cron_to_calendar_interval(expression)?;
                plist.push_str("    <key>CogniaCronExpression</key>\n");
                plist.push_str(&format!(
                    "    <string>{}</string>\n",
                    Self::escape_xml(expression)
                ));
                plist.push_str("    <key>StartCalendarInterval</key>\n");
                plist.push_str(&calendar);
            }
            SystemTaskTrigger::Interval { seconds } => {
                plist.push_str(&format!(
                    "    <key>StartInterval</key>\n    <integer>{}</integer>\n",
                    seconds
                ));
            }
            SystemTaskTrigger::OnBoot { .. } => {
                return Err(SchedulerError::InvalidConfig(
                    "Boot-level triggers require system daemon scope (LaunchDaemons). Cognia operates as a user agent. Use 'on_logon' instead.".to_string(),
                ));
            }
            SystemTaskTrigger::OnLogon { .. } => {
                plist.push_str("    <key>RunAtLoad</key>\n    <true/>\n");
            }
            SystemTaskTrigger::Once { run_at } => {
                // launchd doesn't have native "once" - use StartCalendarInterval
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(run_at) {
                    plist.push_str("    <key>StartCalendarInterval</key>\n");
                    plist.push_str("    <dict>\n");
                    plist.push_str(&format!(
                        "        <key>Month</key>\n        <integer>{}</integer>\n",
                        dt.month()
                    ));
                    plist.push_str(&format!(
                        "        <key>Day</key>\n        <integer>{}</integer>\n",
                        dt.day()
                    ));
                    plist.push_str(&format!(
                        "        <key>Hour</key>\n        <integer>{}</integer>\n",
                        dt.hour()
                    ));
                    plist.push_str(&format!(
                        "        <key>Minute</key>\n        <integer>{}</integer>\n",
                        dt.minute()
                    ));
                    plist.push_str("    </dict>\n");
                }
            }
            SystemTaskTrigger::OnEvent { .. } => {
                warn!("OnEvent trigger not supported on macOS");
            }
        }

        // Working directory
        if let SystemTaskAction::ExecuteScript {
            working_dir: Some(dir),
            ..
        }
        | SystemTaskAction::RunCommand {
            working_dir: Some(dir),
            ..
        } = &task.action
        {
            plist.push_str(&format!(
                "    <key>WorkingDirectory</key>\n    <string>{}</string>\n",
                Self::escape_xml(dir)
            ));
        }

        // Environment variables
        let env = match &task.action {
            SystemTaskAction::ExecuteScript { env, .. } => Some(env),
            SystemTaskAction::RunCommand { env, .. } => Some(env),
            _ => None,
        };

        if let Some(env) = env {
            if !env.is_empty() {
                plist.push_str("    <key>EnvironmentVariables</key>\n    <dict>\n");
                for (k, v) in env {
                    plist.push_str(&format!(
                        "        <key>{}</key>\n        <string>{}</string>\n",
                        Self::escape_xml(k),
                        Self::escape_xml(v)
                    ));
                }
                plist.push_str("    </dict>\n");
            }
        }

        // Standard output/error logging
        let log_dir = dirs::home_dir()
            .map(|h| h.join("Library").join("Logs").join("Cognia"))
            .unwrap_or_else(|| PathBuf::from("/tmp"));

        plist.push_str(&format!(
            "    <key>StandardOutPath</key>\n    <string>{}/task-{}.stdout.log</string>\n",
            log_dir.display(),
            task.id
        ));
        plist.push_str(&format!(
            "    <key>StandardErrorPath</key>\n    <string>{}/task-{}.stderr.log</string>\n",
            log_dir.display(),
            task.id
        ));

        plist.push_str("</dict>\n</plist>\n");

        Ok(plist)
    }

    /// Build program and arguments from action
    fn build_program_args(action: &SystemTaskAction) -> Result<(String, Vec<String>)> {
        match action {
            SystemTaskAction::ExecuteScript {
                language,
                code,
                args,
                timeout_secs,
                memory_mb,
                use_sandbox,
                ..
            } => {
                let code_b64 =
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, code);
                let cognia_path = Self::get_cognia_path();
                let sandbox_flag = if *use_sandbox {
                    "--sandbox"
                } else {
                    "--native"
                };

                let mut prog_args = vec![
                    "execute-script".to_string(),
                    "--language".to_string(),
                    language.clone(),
                    sandbox_flag.to_string(),
                    "--timeout".to_string(),
                    timeout_secs.to_string(),
                    "--memory".to_string(),
                    memory_mb.to_string(),
                    "--code-b64".to_string(),
                    code_b64,
                ];
                prog_args.extend(args.clone());

                Ok((cognia_path, prog_args))
            }
            SystemTaskAction::RunCommand { command, args, .. } => {
                Ok((command.clone(), args.clone()))
            }
            SystemTaskAction::LaunchApp { path, args } => Ok((path.clone(), args.clone())),
            SystemTaskAction::OpenUrl { url } => {
                validate_open_url(url).map_err(SchedulerError::InvalidConfig)?;
                // `/usr/bin/open` routes to the registered handler: the Cognia
                // bundle for `cognia://`, the default browser for https.
                Ok(("/usr/bin/open".to_string(), vec![url.clone()]))
            }
        }
    }

    /// Get Cognia executable path
    fn get_cognia_path() -> String {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/Applications/Cognia.app/Contents/MacOS/Cognia".to_string())
    }

    /// Escape XML special characters
    fn escape_xml(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// Convert cron expression to launchd CalendarInterval
    fn cron_to_calendar_interval(expression: &str) -> Result<String> {
        let parts: Vec<&str> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(SchedulerError::InvalidCron(format!(
                "launchd requires exactly 5 fields, got {}",
                parts.len()
            )));
        }

        let (minute, hour, day, month, weekday) =
            (parts[0], parts[1], parts[2], parts[3], parts[4]);

        let mut dict = String::from("    <dict>\n");
        for (key, field, min, max) in [
            ("Minute", minute, 0, 59),
            ("Hour", hour, 0, 23),
            ("Day", day, 1, 31),
            ("Month", month, 1, 12),
            ("Weekday", weekday, 0, 7),
        ] {
            if let Some(value) = Self::parse_cron_field(field, key, min, max)? {
                dict.push_str(&format!(
                    "        <key>{key}</key>\n        <integer>{value}</integer>\n"
                ));
            }
        }

        dict.push_str("    </dict>\n");
        Ok(dict)
    }

    /// Parse a launchd-representable cron field without treating parse failure
    /// as a wildcard. launchd's omitted keys mean wildcard, so accepting an
    /// unsupported range/list/step here would silently increase frequency.
    fn parse_cron_field(field: &str, name: &str, min: u32, max: u32) -> Result<Option<u32>> {
        if field == "*" {
            return Ok(None);
        }
        let value = field.parse::<u32>().map_err(|_| {
            SchedulerError::InvalidCron(format!(
                "launchd cannot represent {name} field '{field}'; only '*' or one fixed value is supported"
            ))
        })?;
        if !(min..=max).contains(&value) {
            return Err(SchedulerError::InvalidCron(format!(
                "{name} field '{field}' is outside {min}..={max}"
            )));
        }
        Ok(Some(value))
    }

    fn decode_xml_entities(s: &str) -> String {
        s.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .trim()
            .to_string()
    }

    fn extract_key_block(content: &str, key: &str, value_tag: &str) -> Option<String> {
        let pattern = format!(
            r"(?s)<key>{}</key>\s*<{}>(.*?)</{}>",
            key, value_tag, value_tag
        );
        let regex = Regex::new(&pattern).ok()?;
        regex
            .captures(content)
            .and_then(|cap| cap.get(1).map(|v| Self::decode_xml_entities(v.as_str())))
    }

    fn extract_key_int(content: &str, key: &str) -> Option<u64> {
        Self::extract_key_block(content, key, "integer").and_then(|v| v.parse::<u64>().ok())
    }

    fn extract_program_arguments(content: &str) -> Vec<String> {
        let array = Self::extract_key_block(content, "ProgramArguments", "array");
        let Some(array) = array else {
            return Vec::new();
        };
        let mut values = Vec::new();
        if let Ok(regex) = Regex::new(r"(?s)<string>(.*?)</string>") {
            for cap in regex.captures_iter(&array) {
                if let Some(raw) = cap.get(1) {
                    values.push(Self::decode_xml_entities(raw.as_str()));
                }
            }
        }
        values
    }

    fn parse_env_vars(content: &str) -> HashMap<String, String> {
        let mut env = HashMap::new();
        let Some(dict) = Self::extract_key_block(content, "EnvironmentVariables", "dict") else {
            return env;
        };

        let Ok(regex) = Regex::new(r"(?s)<key>(.*?)</key>\s*<string>(.*?)</string>") else {
            return env;
        };

        for cap in regex.captures_iter(&dict) {
            let key = cap
                .get(1)
                .map(|m| Self::decode_xml_entities(m.as_str()))
                .unwrap_or_default();
            let value = cap
                .get(2)
                .map(|m| Self::decode_xml_entities(m.as_str()))
                .unwrap_or_default();
            if !key.is_empty() {
                env.insert(key, value);
            }
        }
        env
    }

    fn arg_value(args: &[String], key: &str) -> Option<String> {
        args.iter()
            .position(|arg| arg == key)
            .and_then(|index| args.get(index + 1).cloned())
    }

    fn parse_action_from_plist(content: &str) -> Option<SystemTaskAction> {
        let args = Self::extract_program_arguments(content);
        if args.is_empty() {
            return None;
        }

        let working_dir = Self::extract_key_block(content, "WorkingDirectory", "string");
        let env = Self::parse_env_vars(content);
        let command = args.first()?.clone();
        let command_args = args.get(1..).unwrap_or(&[]).to_vec();

        if command_args.iter().any(|arg| arg == "execute-script") {
            let language = Self::arg_value(&command_args, "--language")
                .unwrap_or_else(|| "unknown".to_string());
            let timeout_secs = Self::arg_value(&command_args, "--timeout")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300);
            let memory_mb = Self::arg_value(&command_args, "--memory")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(512);
            let use_sandbox = command_args.iter().any(|arg| arg == "--sandbox");
            let code_b64 = Self::arg_value(&command_args, "--code-b64").unwrap_or_default();
            let code = if code_b64.is_empty() {
                String::new()
            } else {
                base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    code_b64.as_bytes(),
                )
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .unwrap_or_default()
            };

            return Some(SystemTaskAction::ExecuteScript {
                language,
                code,
                working_dir,
                args: vec![],
                env,
                timeout_secs,
                memory_mb,
                use_sandbox,
            });
        }

        Some(SystemTaskAction::RunCommand {
            command,
            args: command_args,
            working_dir,
            env,
        })
    }

    fn parse_trigger_from_plist(content: &str) -> Option<SystemTaskTrigger> {
        if let Some(interval) = Self::extract_key_int(content, "StartInterval") {
            return Some(SystemTaskTrigger::Interval { seconds: interval });
        }

        if let Some(delay) = Self::extract_key_int(content, "ThrottleInterval") {
            return Some(SystemTaskTrigger::OnBoot {
                delay_seconds: delay,
            });
        }

        if content.contains("<key>RunAtLoad</key>") {
            return Some(SystemTaskTrigger::OnLogon { user: None });
        }

        if let Some(expression) = Self::extract_key_block(content, "CogniaCronExpression", "string")
        {
            return Some(SystemTaskTrigger::Cron {
                expression,
                // launchd evaluates calendar intervals in the host's local timezone.
                timezone: None,
            });
        }

        let calendar = Self::extract_key_block(content, "StartCalendarInterval", "dict")?;
        let minute = Self::extract_key_int(&calendar, "Minute");
        let hour = Self::extract_key_int(&calendar, "Hour");
        let day = Self::extract_key_int(&calendar, "Day");
        let month = Self::extract_key_int(&calendar, "Month");

        if let (Some(minute), Some(hour), Some(day), Some(month)) = (minute, hour, day, month) {
            let year = chrono::Utc::now().year();
            let run_at = format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:00Z");
            return Some(SystemTaskTrigger::Once { run_at });
        }

        if let (Some(minute), Some(hour)) = (minute, hour) {
            return Some(SystemTaskTrigger::Cron {
                expression: format!("{minute} {hour} * * *"),
                timezone: None,
            });
        }

        None
    }

    /// Load a task from its plist file
    fn load_task_from_plist(&self, path: &PathBuf) -> Option<SystemTask> {
        let content = fs::read_to_string(path).ok()?;
        let label = path.file_stem()?.to_str()?;

        // `label_to_task` enforces the `com.cognia.task.` prefix *and* the
        // `is_cognia_task` ownership gate, returning `None` for foreign agents.
        let name = Self::label_to_task(label)?;

        // Check status with launchctl
        let status = Command::new("launchctl")
            .args(["list", label])
            .output()
            .map(|o| {
                if o.status.success() {
                    SystemTaskStatus::Enabled
                } else {
                    SystemTaskStatus::Disabled
                }
            })
            .unwrap_or(SystemTaskStatus::Unknown);

        let parsed_trigger = Self::parse_trigger_from_plist(&content);
        let parsed_action = Self::parse_action_from_plist(&content);
        let metadata_state = if parsed_trigger.is_some() && parsed_action.is_some() {
            TaskMetadataState::Full
        } else {
            TaskMetadataState::Degraded
        };

        Some(SystemTask {
            id: label.to_string(),
            name,
            description: None,
            trigger: parsed_trigger.unwrap_or(SystemTaskTrigger::Interval { seconds: 0 }),
            action: parsed_action.unwrap_or(SystemTaskAction::RunCommand {
                command: String::new(),
                args: vec![],
                working_dir: None,
                env: HashMap::new(),
            }),
            run_level: RunLevel::User,
            status,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state,
        })
    }
}

impl Default for MacOSScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SystemScheduler for MacOSScheduler {
    fn capabilities(&self) -> SchedulerCapabilities {
        let trigger_caps = self.get_trigger_capabilities();
        let supported_triggers = trigger_caps
            .iter()
            .filter(|tc| tc.available)
            .map(|tc| tc.trigger_type.clone())
            .collect();
        SchedulerCapabilities {
            os: "macos".to_string(),
            backend: "launchd".to_string(),
            available: self.available,
            can_elevate: false, // User-level agents only
            supported_triggers,
            trigger_capabilities: trigger_caps,
            supported_actions: super::types::all_action_kinds(),
            max_tasks: 0,
        }
    }

    fn is_available(&self) -> bool {
        self.available
    }

    async fn create_task(&self, input: CreateSystemTaskInput) -> Result<SystemTask> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "launchd not available".to_string(),
            ));
        }

        // Ensure agents directory exists
        fs::create_dir_all(&self.agents_dir)?;

        let task_name = generate_task_name(&input.name);
        let label = Self::task_to_label(&task_name);
        let plist_path = self.plist_path(&task_name);

        // Check if already exists
        if plist_path.exists() {
            return Err(SchedulerError::TaskAlreadyExists(task_name));
        }

        // Build task object
        let mut task = SystemTask {
            id: label.clone(),
            name: input.name,
            description: input.description,
            trigger: input.trigger,
            action: input.action,
            run_level: input.run_level,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: input.tags,
            created_at: Some(now_iso()),
            updated_at: Some(now_iso()),
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        };

        task.requires_admin = task.check_requires_admin();

        // Generate and write plist
        let plist_content = Self::generate_plist(&task)?;
        fs::write(&plist_path, &plist_content)?;

        debug!("Created plist at {:?}", plist_path);

        // Load the agent
        let output = Command::new("launchctl")
            .args(["load", "-w"])
            .arg(&plist_path)
            .output()?;

        if !output.status.success() {
            // Clean up plist on failure
            let _ = fs::remove_file(&plist_path);
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to load agent: {}", stderr);
            return Err(SchedulerError::Platform(stderr.to_string()));
        }

        info!("Created macOS task: {}", label);
        Ok(task)
    }

    async fn update_task(&self, id: &str, input: CreateSystemTaskInput) -> Result<SystemTask> {
        self.delete_task(id).await?;
        self.create_task(input).await
    }

    async fn delete_task(&self, id: &str) -> Result<bool> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "launchd not available".to_string(),
            ));
        }

        // Unload the agent
        let _ = Command::new("launchctl")
            .args(["unload", "-w"])
            .arg(self.agents_dir.join(format!("{}.plist", id)))
            .output();

        // Remove plist file
        let plist_path = self.agents_dir.join(format!("{}.plist", id));
        if plist_path.exists() {
            fs::remove_file(&plist_path)?;
            info!("Deleted macOS task: {}", id);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn get_task(&self, id: &str) -> Result<Option<SystemTask>> {
        let plist_path = self.agents_dir.join(format!("{}.plist", id));
        Ok(self.load_task_from_plist(&plist_path))
    }

    async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
        if !self.available || !self.agents_dir.exists() {
            return Ok(vec![]);
        }

        let mut tasks = Vec::new();

        for entry in fs::read_dir(&self.agents_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.extension().map(|e| e == "plist").unwrap_or(false) {
                if let Some(task) = self.load_task_from_plist(&path) {
                    tasks.push(task);
                }
            }
        }

        Ok(tasks)
    }

    async fn enable_task(&self, id: &str) -> Result<bool> {
        let plist_path = self.agents_dir.join(format!("{}.plist", id));

        let output = Command::new("launchctl")
            .args(["load", "-w"])
            .arg(&plist_path)
            .output()?;

        Ok(output.status.success())
    }

    async fn disable_task(&self, id: &str) -> Result<bool> {
        let plist_path = self.agents_dir.join(format!("{}.plist", id));

        let output = Command::new("launchctl")
            .args(["unload", "-w"])
            .arg(&plist_path)
            .output()?;

        Ok(output.status.success())
    }

    async fn run_task_now(&self, id: &str) -> Result<TaskRunResult> {
        let start = std::time::Instant::now();

        let output = Command::new("launchctl").args(["start", id]).output()?;

        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(TaskRunResult {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: Some(String::from_utf8_lossy(&output.stdout).to_string()),
            stderr: Some(String::from_utf8_lossy(&output.stderr).to_string()),
            error: if output.status.success() {
                None
            } else {
                Some(String::from_utf8_lossy(&output.stderr).to_string())
            },
            duration_ms: Some(duration_ms),
        })
    }

    fn requires_admin(&self, task: &SystemTask) -> bool {
        task.check_requires_admin()
    }

    async fn request_elevation(&self) -> Result<bool> {
        // macOS LaunchAgents are user-level, no elevation needed
        Ok(true)
    }

    fn is_elevated(&self) -> bool {
        // Check if running as root
        unsafe { libc::geteuid() == 0 }
    }

    fn get_trigger_capabilities(&self) -> Vec<TriggerCapability> {
        derive_trigger_capabilities(|kind| {
            match kind {
            SystemTriggerKind::Cron => (true, false, vec![], vec!["Uses launchd StartCalendarInterval. Step, range, and list expressions are not supported; only wildcards and fixed values.".to_string()]),
            SystemTriggerKind::Interval => (true, false, vec![], vec!["Uses launchd StartInterval (seconds). Minimum granularity is 1 second.".to_string()]),
            SystemTriggerKind::Once => (true, false, vec![], vec!["Implemented via StartCalendarInterval with fixed month/day/hour/minute.".to_string()]),
            SystemTriggerKind::OnBoot => (false, false, vec!["Boot-level triggers require system daemon scope (LaunchDaemons). Cognia operates as a user agent (LaunchAgents). Use 'on_logon' instead.".to_string()], vec![]),
            SystemTriggerKind::OnLogon => (true, false, vec![], vec!["Maps to RunAtLoad — runs when your user agent loads at login or agent restart.".to_string()]),
            SystemTriggerKind::OnEvent => (false, false, vec!["Event-based triggers are not supported on macOS via launchd.".to_string()], vec![]),
        }
        })
    }

    fn validate_trigger_translation(&self, trigger: &SystemTaskTrigger) -> TranslationValidation {
        match trigger {
            SystemTaskTrigger::OnBoot { .. } => TranslationValidation {
                valid: false,
                errors: vec![
                    "Boot-level triggers require system daemon scope (LaunchDaemons). Cognia operates as a user agent. Use 'on_logon' instead.".to_string(),
                ],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::OnEvent { .. } => TranslationValidation {
                valid: false,
                errors: vec![
                    "Event-based triggers are not supported on macOS via launchd.".to_string(),
                ],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::Cron { expression, .. } => {
                match Self::cron_to_calendar_interval(expression) {
                    Ok(_) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec![],
                        native_representation: Some(format!(
                            "launchd: StartCalendarInterval from '{}'",
                            expression
                        )),
                    },
                    Err(error) => TranslationValidation {
                        valid: false,
                        errors: vec![error.to_string()],
                        warnings: vec![],
                        native_representation: None,
                    },
                }
            }
            SystemTaskTrigger::Interval { seconds } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some(format!("launchd: StartInterval = {}", seconds)),
            },
            SystemTaskTrigger::Once { run_at } => {
                match chrono::DateTime::parse_from_rfc3339(run_at) {
                    Ok(dt) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec![],
                        native_representation: Some(format!(
                            "launchd: StartCalendarInterval Month={} Day={} Hour={} Minute={}",
                            dt.month(), dt.day(), dt.hour(), dt.minute()
                        )),
                    },
                    Err(e) => TranslationValidation {
                        valid: false,
                        errors: vec![format!("Invalid datetime: {}", e)],
                        warnings: vec![],
                        native_representation: None,
                    },
                }
            }
            SystemTaskTrigger::OnLogon { .. } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some("launchd: RunAtLoad = true".to_string()),
            },
        }
    }
}

use chrono::{Datelike, Timelike};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_url_translates_to_the_open_binary_and_rejects_bad_schemes() {
        let (program, args) = MacOSScheduler::build_program_args(&SystemTaskAction::OpenUrl {
            url: "cognia://scheduler/task/abc?run=tok".to_string(),
        })
        .unwrap();
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(
            args,
            vec!["cognia://scheduler/task/abc?run=tok".to_string()]
        );
        let err = MacOSScheduler::build_program_args(&SystemTaskAction::OpenUrl {
            url: "file:///etc/passwd".to_string(),
        })
        .unwrap_err();
        assert!(matches!(err, SchedulerError::InvalidConfig(_)));
    }

    fn cron_task(expression: &str) -> SystemTask {
        SystemTask {
            id: "test-cron".to_string(),
            name: "cron-task".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Cron {
                expression: expression.to_string(),
                timezone: None,
            },
            action: SystemTaskAction::RunCommand {
                command: "/bin/echo".to_string(),
                args: vec![],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            status: SystemTaskStatus::Enabled,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: None,
            next_run_at: None,
            last_result: None,
            metadata_state: TaskMetadataState::Full,
        }
    }

    #[test]
    fn cron_translation_keeps_every_fixed_field_including_month() {
        let calendar = MacOSScheduler::cron_to_calendar_interval("0 9 1 1 3").unwrap();

        assert!(calendar.contains("<key>Minute</key>\n        <integer>0</integer>"));
        assert!(calendar.contains("<key>Hour</key>\n        <integer>9</integer>"));
        assert!(calendar.contains("<key>Day</key>\n        <integer>1</integer>"));
        assert!(calendar.contains("<key>Month</key>\n        <integer>1</integer>"));
        assert!(calendar.contains("<key>Weekday</key>\n        <integer>3</integer>"));
    }

    #[test]
    fn cron_translation_rejects_unrepresentable_or_wrong_arity_expressions() {
        for expression in [
            "*/15 * * * *",
            "0 9 * * 1-5",
            "0 9 * * 1,3,5",
            "0 0 9 * * *",
        ] {
            let error = MacOSScheduler::cron_to_calendar_interval(expression)
                .expect_err("expression must be rejected instead of losing fields");
            assert!(matches!(error, SchedulerError::InvalidCron(_)));
        }
    }

    #[test]
    fn cron_generation_round_trips_the_original_expression() {
        let plist = MacOSScheduler::generate_plist(&cron_task("0 9 1 1 *")).unwrap();
        let trigger = MacOSScheduler::parse_trigger_from_plist(&plist).expect("trigger");

        match trigger {
            SystemTaskTrigger::Cron {
                expression,
                timezone,
            } => {
                assert_eq!(expression, "0 9 1 1 *");
                assert_eq!(timezone, None);
            }
            other => panic!("expected cron trigger, got {other:?}"),
        }
    }

    #[test]
    fn cron_validation_rejects_every_expression_the_translator_rejects() {
        let scheduler = MacOSScheduler {
            available: true,
            agents_dir: PathBuf::from("/tmp"),
        };

        for expression in [
            "*/15 * * * *",
            "0 9 * * 1-5",
            "0 9 * * 1,3,5",
            "0 0 9 * * *",
        ] {
            let validation = scheduler.validate_trigger_translation(&SystemTaskTrigger::Cron {
                expression: expression.to_string(),
                timezone: None,
            });
            assert!(!validation.valid, "{expression} must not validate");
            assert!(!validation.errors.is_empty(), "{expression} needs a reason");
        }
    }

    #[test]
    fn parses_plist_trigger_and_action() {
        let plist = r#"
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/echo</string>
    <string>hello</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
</dict>
</plist>
"#;

        let trigger = MacOSScheduler::parse_trigger_from_plist(plist).expect("trigger");
        let action = MacOSScheduler::parse_action_from_plist(plist).expect("action");

        assert!(matches!(
            trigger,
            SystemTaskTrigger::Interval { seconds: 300 }
        ));
        assert!(matches!(action, SystemTaskAction::RunCommand { .. }));
    }

    #[test]
    fn label_to_task_strips_prefix_and_gates_ownership() {
        // A genuine Cognia label round-trips to the user-facing name without
        // carrying the internal `Cognia_` body prefix.
        assert_eq!(
            MacOSScheduler::label_to_task("com.cognia.task.Cognia_daily_sync"),
            Some("daily sync".to_string())
        );
        // The recovered name re-generates the *same* label — no double prefix.
        let name = MacOSScheduler::label_to_task("com.cognia.task.Cognia_daily_sync").unwrap();
        assert_eq!(
            MacOSScheduler::task_to_label(&generate_task_name(&name)),
            "com.cognia.task.Cognia_daily_sync"
        );
        // A foreign LaunchAgent that shares our reverse-DNS prefix but is not a
        // Cognia task is rejected by the `is_cognia_task` gate.
        assert_eq!(
            MacOSScheduler::label_to_task("com.cognia.task.Other_thing"),
            None
        );
        // An empty body after the `Cognia_` marker is rejected.
        assert_eq!(
            MacOSScheduler::label_to_task("com.cognia.task.Cognia_"),
            None
        );
        // A label outside our namespace entirely is rejected.
        assert_eq!(MacOSScheduler::label_to_task("com.apple.something"), None);
    }
}
