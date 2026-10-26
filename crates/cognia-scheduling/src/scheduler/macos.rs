//! macOS launchd implementation
//!
//! Uses launchctl and plist files for task scheduling.

#![cfg(target_os = "macos")]

use async_trait::async_trait;
use log::{debug, error, info, warn};
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::process::Command;

use super::error::{Result, SchedulerError};
use super::service::{generate_task_name, is_cognia_task, now_iso, SystemScheduler, TASK_PREFIX};
use super::types::{
    derive_trigger_capabilities, validate_open_url, CreateSystemTaskInput, RunLevel,
    SchedulerCapabilities, SystemTask, SystemTaskAction, SystemTaskStatus, SystemTaskTrigger,
    SystemTriggerKind, TaskMetadataState, TaskRunResult, TranslationValidation, TriggerCapability,
};

// Arguments are data, never shell source. The persistent atomic claim makes
// calendar replay (including a later year or reboot) one scheduled attempt.
const ONCE_GUARD: &str = r#"[ "$(/bin/date +%s)" -ge "$1" ] || exit 0
/bin/mkdir -m 700 "$2" 2>/dev/null || exit 0
shift 2
exec "$@""#;

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
        let label = &task.id;
        let (mut program, mut args) = Self::build_program_args(&task.action)?;
        if let SystemTaskTrigger::Once { run_at } = &task.trigger {
            let dt = Self::once_datetime(run_at)?;
            let marker = Self::once_marker_root().join(uuid::Uuid::new_v4().to_string());
            let mut guarded = vec![
                "-c".to_string(),
                ONCE_GUARD.to_string(),
                "cognia-once".to_string(),
                Self::once_epoch(&dt).to_string(),
                marker.to_string_lossy().into_owned(),
                program,
            ];
            guarded.append(&mut args);
            program = "/bin/sh".to_string();
            args = guarded;
        }

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
            Self::escape_xml(label),
            Self::escape_xml(&program)
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
                let dt = Self::once_calendar_time(run_at)?;
                plist.push_str("    <key>CogniaOnceRunAt</key>\n");
                plist.push_str(&format!(
                    "    <string>{}</string>\n",
                    Self::escape_xml(run_at)
                ));
                plist.push_str("    <key>StartCalendarInterval</key>\n    <dict>\n");
                for (key, value) in [
                    ("Month", dt.month()),
                    ("Day", dt.day()),
                    ("Hour", dt.hour()),
                    ("Minute", dt.minute()),
                ] {
                    plist.push_str(&format!(
                        "        <key>{key}</key>\n        <integer>{value}</integer>\n"
                    ));
                }
                plist.push_str("    </dict>\n");
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

    fn once_marker_root() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Cognia/scheduler-once")
    }

    fn once_datetime(run_at: &str) -> Result<chrono::DateTime<chrono::FixedOffset>> {
        chrono::DateTime::parse_from_rfc3339(run_at)
            .map_err(|e| SchedulerError::InvalidConfig(format!("Invalid datetime: {e}")))
    }

    fn once_epoch(dt: &chrono::DateTime<chrono::FixedOffset>) -> i64 {
        dt.timestamp() + i64::from(dt.timestamp_subsec_nanos() != 0)
    }

    fn once_calendar_time(run_at: &str) -> Result<chrono::DateTime<chrono::Local>> {
        let dt = Self::once_datetime(run_at)?;
        let epoch = Self::once_epoch(&dt);
        let minute = epoch.div_euclid(60) * 60 + if epoch.rem_euclid(60) != 0 { 60 } else { 0 };
        chrono::DateTime::from_timestamp(minute, 0)
            .map(|utc| utc.with_timezone(&chrono::Local))
            .ok_or_else(|| {
                SchedulerError::InvalidConfig("Datetime is outside launchd range".to_string())
            })
    }

    fn once_guard_marker(content: &str, args: &[String]) -> Option<PathBuf> {
        let run_at = Self::extract_key_block(content, "CogniaOnceRunAt", "string")?;
        let epoch = Self::once_epoch(&Self::once_datetime(&run_at).ok()?);
        if args.len() < 7
            || args[0] != "/bin/sh"
            || args[1] != "-c"
            || args[2] != ONCE_GUARD
            || args[3] != "cognia-once"
            || args[4] != epoch.to_string()
        {
            return None;
        }
        let marker = PathBuf::from(&args[5]);
        (marker.parent() == Some(Self::once_marker_root().as_path())
            && marker
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
                .is_some())
        .then_some(marker)
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
        s.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    }

    fn extract_key_block(content: &str, key: &str, value_tag: &str) -> Option<String> {
        let pattern = format!(
            r"(?s)<key>{}</key>\s*<{}>(.*?)</{}>",
            key, value_tag, value_tag
        );
        let regex = Regex::new(&pattern).ok()?;
        regex.captures(content).and_then(|cap| {
            cap.get(1).map(|v| {
                // Decode only scalar text, once. Decoding a container first
                // would change literal entity strings inside argv/env values.
                if value_tag == "string" {
                    Self::decode_xml_entities(v.as_str())
                } else {
                    v.as_str().trim().to_string()
                }
            })
        })
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
        let mut args = Self::extract_program_arguments(content);
        if Self::once_guard_marker(content, &args).is_some() {
            args = args.split_off(6);
        }
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

        if let Some(run_at) = Self::extract_key_block(content, "CogniaOnceRunAt", "string") {
            Self::once_datetime(&run_at).ok()?;
            return Some(SystemTaskTrigger::Once { run_at });
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
        if matches!(&task.trigger, SystemTaskTrigger::Once { .. }) {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(Self::once_marker_root())?;
        }
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
            if let Ok(content) = fs::read_to_string(&plist_path) {
                if let Some(marker) =
                    Self::once_guard_marker(&content, &Self::extract_program_arguments(&content))
                {
                    // Only an empty directory at the exact owned UUID path.
                    match fs::remove_dir(marker) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                }
            }
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

        // Explicit manual execution is independent of the scheduled once claim.
        // Run the original argv, with the same cwd/env, and report its result.
        let content = fs::read_to_string(self.agents_dir.join(format!("{}.plist", id)))?;
        let args = Self::extract_program_arguments(&content);
        if Self::once_guard_marker(&content, &args).is_some() {
            let mut command = tokio::process::Command::new(&args[6]);
            command
                .args(&args[7..])
                .envs(Self::parse_env_vars(&content));
            if let Some(dir) = Self::extract_key_block(&content, "WorkingDirectory", "string") {
                command.current_dir(dir);
            }
            let output = command.output().await?;
            return Ok(TaskRunResult {
                success: output.status.success(),
                exit_code: output.status.code(),
                stdout: Some(String::from_utf8_lossy(&output.stdout).into_owned()),
                stderr: Some(String::from_utf8_lossy(&output.stderr).into_owned()),
                error: (!output.status.success()).then(|| "Manual task action failed".to_string()),
                duration_ms: Some(start.elapsed().as_millis() as u64),
            });
        }

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
            SystemTriggerKind::Once => (true, false, vec![], vec!["Uses local calendar minutes with a persistent one-attempt guard; rounds up to the next local minute, plus OS delivery latency. Does not wake sleeping hardware.".to_string()]),
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
                match Self::once_calendar_time(run_at) {
                    Ok(dt) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec!["launchd has minute precision: rounds up to the next local minute, plus OS delivery latency. The persistent guard permits one scheduled attempt, not guaranteed successful delivery; sleeping hardware is not woken.".to_string()],
                        native_representation: Some(format!(
                            "launchd: local StartCalendarInterval Month={} Day={} Hour={} Minute={} with absolute-time and persistent once guard",
                            dt.month(), dt.day(), dt.hour(), dt.minute()
                        )),
                    },
                    Err(e) => TranslationValidation {
                        valid: false,
                        errors: vec![e.to_string()],
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

    fn once_task(run_at: &str) -> SystemTask {
        let mut task = cron_task("0 9 * * *");
        task.id = "com.cognia.task.Cognia_once_regression".to_string();
        task.trigger = SystemTaskTrigger::Once {
            run_at: run_at.to_string(),
        };
        task
    }

    #[test]
    fn once_calendar_is_offset_independent_and_preserves_the_original_instant() {
        let utc = once_task("2027-10-22T18:17:45Z");
        let offset = once_task("2027-10-23T02:17:45+08:00");
        let a = MacOSScheduler::generate_plist(&utc).unwrap();
        let b = MacOSScheduler::generate_plist(&offset).unwrap();
        assert_eq!(
            MacOSScheduler::extract_key_block(&a, "StartCalendarInterval", "dict"),
            MacOSScheduler::extract_key_block(&b, "StartCalendarInterval", "dict")
        );
        assert!(matches!(MacOSScheduler::parse_trigger_from_plist(&a),
            Some(SystemTaskTrigger::Once { run_at }) if run_at == "2027-10-22T18:17:45Z"));
    }

    #[test]
    fn once_plist_uses_the_registered_id_and_rejects_invalid_dates() {
        let mut task = once_task("2027-10-22T18:17:45Z");
        let plist = MacOSScheduler::generate_plist(&task).unwrap();
        assert_eq!(
            MacOSScheduler::extract_key_block(&plist, "Label", "string"),
            Some(task.id.clone())
        );
        task.trigger = SystemTaskTrigger::Once {
            run_at: "invalid".to_string(),
        };
        assert!(MacOSScheduler::generate_plist(&task).is_err());
    }

    #[test]
    fn once_guard_never_runs_early_and_claims_only_one_attempt() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(MacOSScheduler::once_marker_root())
            .unwrap();
        for (run_at, should_run) in [
            ("2999-01-01T00:00:00Z", false),
            ("2000-01-01T00:00:00Z", true),
        ] {
            let mut task = once_task(run_at);
            let literal = "$(touch /tmp/cognia-guard-must-not-execute) <&> \"quoted\"";
            task.action = SystemTaskAction::RunCommand {
                command: "/bin/echo".to_string(),
                args: vec![literal.to_string()],
                working_dir: None,
                env: HashMap::from([("PATH".to_string(), "/missing".to_string())]),
            };
            let plist = MacOSScheduler::generate_plist(&task).unwrap();
            let args = MacOSScheduler::extract_program_arguments(&plist);
            let marker = MacOSScheduler::once_guard_marker(&plist, &args).unwrap();
            let first = Command::new(&args[0])
                .args(&args[1..])
                .env("PATH", "/missing")
                .output()
                .unwrap();
            let second = Command::new(&args[0]).args(&args[1..]).output().unwrap();
            let claimed = marker.exists();
            if claimed {
                fs::remove_dir(&marker).unwrap();
            }
            assert!(first.status.success());
            assert!(second.status.success());
            assert_eq!(claimed, should_run);
            assert_eq!(
                String::from_utf8(first.stdout).unwrap(),
                if should_run {
                    format!("{literal}\n")
                } else {
                    String::new()
                }
            );
            assert!(second.stdout.is_empty());
            assert!(matches!(MacOSScheduler::parse_action_from_plist(&plist),
                Some(SystemTaskAction::RunCommand { command, args, .. }) if command == "/bin/echo" && args == vec![literal]));
        }
    }

    #[test]
    fn once_guard_records_failed_attempt_and_rounds_across_year_boundary() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(MacOSScheduler::once_marker_root())
            .unwrap();
        let mut task = once_task("2000-01-01T00:00:00Z");
        task.action = SystemTaskAction::RunCommand {
            command: "/missing/cognia-once-executable".to_string(),
            args: vec![],
            working_dir: None,
            env: HashMap::new(),
        };
        let plist = MacOSScheduler::generate_plist(&task).unwrap();
        let args = MacOSScheduler::extract_program_arguments(&plist);
        let marker = MacOSScheduler::once_guard_marker(&plist, &args).unwrap();
        let output = Command::new(&args[0]).args(&args[1..]).output().unwrap();
        let claimed = marker.exists();
        if claimed {
            fs::remove_dir(marker).unwrap();
        }
        assert!(!output.status.success());
        assert!(claimed, "a failed exec consumes the one scheduled attempt");
        let rounded = MacOSScheduler::once_calendar_time("2026-12-31T23:59:59.999Z").unwrap();
        assert_eq!(
            rounded.with_timezone(&chrono::Utc).to_rfc3339(),
            "2027-01-01T00:00:00+00:00"
        );
    }

    #[tokio::test]
    async fn once_manual_run_bypasses_guard_without_consuming_the_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let mut task = once_task("2999-01-01T00:00:00Z");
        task.action = SystemTaskAction::RunCommand {
            command: "/bin/pwd".to_string(),
            args: vec![],
            working_dir: Some(dir.path().to_string_lossy().into_owned()),
            env: HashMap::new(),
        };
        let plist = MacOSScheduler::generate_plist(&task).unwrap();
        let args = MacOSScheduler::extract_program_arguments(&plist);
        let marker = MacOSScheduler::once_guard_marker(&plist, &args).unwrap();
        fs::write(dir.path().join(format!("{}.plist", task.id)), plist).unwrap();
        let scheduler = MacOSScheduler {
            available: true,
            agents_dir: dir.path().to_path_buf(),
        };
        let result = scheduler.run_task_now(&task.id).await.unwrap();
        assert!(result.success);
        assert_eq!(
            result.stdout.unwrap().trim(),
            dir.path().canonicalize().unwrap().to_string_lossy()
        );
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn once_manual_run_preserves_whitespace_and_literal_xml_entities() {
        let dir = tempfile::tempdir().unwrap();
        let literal = "  &lt;literal&gt; &amp; \"quoted\"  ";
        let scheduler = MacOSScheduler {
            available: true,
            agents_dir: dir.path().to_path_buf(),
        };
        for from_env in [false, true] {
            let mut task = once_task("2999-01-01T00:00:00Z");
            task.action = if from_env {
                SystemTaskAction::RunCommand {
                    command: "/bin/sh".to_string(),
                    args: vec![
                        "-c".to_string(),
                        "printf '%s' \"$COGNIA_ACCEPTANCE\"".to_string(),
                    ],
                    working_dir: None,
                    env: HashMap::from([("COGNIA_ACCEPTANCE".to_string(), literal.to_string())]),
                }
            } else {
                SystemTaskAction::RunCommand {
                    command: "/usr/bin/printf".to_string(),
                    args: vec!["%s".to_string(), literal.to_string()],
                    working_dir: None,
                    env: HashMap::new(),
                }
            };
            fs::write(
                dir.path().join(format!("{}.plist", task.id)),
                MacOSScheduler::generate_plist(&task).unwrap(),
            )
            .unwrap();
            let result = scheduler.run_task_now(&task.id).await.unwrap();
            assert!(result.success);
            assert_eq!(result.stdout.unwrap(), literal, "from_env={from_env}");
        }
    }

    // Opt-in: installs only uniquely named user LaunchAgents and removes them
    // before asserting the outcome. No existing schedule or app is touched.
    #[tokio::test]
    #[ignore = "real launchd calendar acceptance; waits up to 90 seconds"]
    async fn once_launchd_calendar_and_recreation() {
        let scheduler = MacOSScheduler::new();
        assert!(scheduler.available, "launchctl user domain unavailable");
        let fixture = tempfile::tempdir().unwrap();
        let output_path = fixture.path().join("attempts");
        let name = format!("scheduler_acceptance_{}", uuid::Uuid::new_v4().simple());
        let target = chrono::Utc::now() + chrono::Duration::seconds(3);
        let expected = MacOSScheduler::once_calendar_time(&target.to_rfc3339()).unwrap();
        let input = CreateSystemTaskInput {
            name,
            description: Some("isolated scheduler acceptance".to_string()),
            trigger: SystemTaskTrigger::Once {
                run_at: target.to_rfc3339(),
            },
            action: SystemTaskAction::RunCommand {
                command: "/bin/sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "/bin/date +%s >> \"$1\"".to_string(),
                    "cognia-acceptance".to_string(),
                    output_path.to_string_lossy().into_owned(),
                ],
                working_dir: None,
                env: HashMap::new(),
            },
            run_level: RunLevel::User,
            tags: vec!["scheduler-acceptance".to_string()],
        };
        let task = scheduler.create_task(input.clone()).await.unwrap();
        let outcome: std::result::Result<serde_json::Value, String> = async {
            let loaded = scheduler.get_task(&task.id).await.map_err(|e| e.to_string())?.ok_or("created job not found")?;
            if !matches!(loaded.trigger, SystemTaskTrigger::Once { run_at } if run_at == target.to_rfc3339()) { return Err("absolute date failed round trip".to_string()); }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
            while fs::read_to_string(&output_path).unwrap_or_default().trim().is_empty() && std::time::Instant::now() < deadline { tokio::time::sleep(std::time::Duration::from_millis(100)).await; }
            let first = fs::read_to_string(&output_path).map_err(|e| format!("calendar job did not produce output: {e}"))?;
            let fired = first.trim().parse::<i64>().map_err(|e| e.to_string())?;
            if fired < expected.timestamp() { return Err("launchd job fired early".to_string()); }
            scheduler.run_task_now(&task.id).await.map_err(|e| e.to_string())?;
            let after_manual = fs::read_to_string(&output_path).map_err(|e| e.to_string())?;
            if after_manual.lines().count() != 2 { return Err("explicit manual attempt did not run".to_string()); }
            let started = Command::new("launchctl").args(["start", &task.id]).output().map_err(|e| e.to_string())?;
            if !started.status.success() { return Err(String::from_utf8_lossy(&started.stderr).into_owned()); }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if fs::read_to_string(&output_path).map_err(|e| e.to_string())? != after_manual { return Err("duplicate OS wake executed twice".to_string()); }
            Ok(serde_json::json!({"id": task.id, "target": target.to_rfc3339(), "calendar": expected.to_rfc3339(), "firedEpoch": fired, "lateMs": fired * 1000 - target.timestamp_millis(), "scheduledAttempts": 1, "manualAttempts": 1}))
        }.await;
        let deleted = scheduler.delete_task(&task.id).await;
        let absent = !scheduler
            .agents_dir
            .join(format!("{}.plist", task.id))
            .exists();
        // Recreate with the same name: a fresh marker belongs to this lifecycle.
        let mut replacement = input;
        replacement.trigger = SystemTaskTrigger::Once {
            run_at: "2000-01-01T00:00:00Z".to_string(),
        };
        let recreated = scheduler.create_task(replacement).await;
        let mut recreation_ok = false;
        if let Ok(next) = &recreated {
            if let Ok(plist) =
                fs::read_to_string(scheduler.agents_dir.join(format!("{}.plist", next.id)))
            {
                let args = MacOSScheduler::extract_program_arguments(&plist);
                let output = Command::new(&args[0]).args(&args[1..]).output().unwrap();
                recreation_ok = output.status.success()
                    && fs::read_to_string(&output_path)
                        .unwrap_or_default()
                        .lines()
                        .count()
                        == 3;
            }
            scheduler.delete_task(&next.id).await.unwrap();
        }
        println!(
            "COGNIA_LAUNCHD_ACCEPTANCE {}",
            serde_json::json!({"outcome": outcome, "deleted": deleted.is_ok(), "absent": absent, "recreated": recreation_ok})
        );
        assert!(deleted.is_ok() && absent);
        assert!(outcome.is_ok(), "{outcome:?}");
        assert!(recreated.is_ok() && recreation_ok);
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
