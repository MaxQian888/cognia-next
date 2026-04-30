//! Linux systemd implementation
//!
//! Uses systemd user services and timers for task scheduling.

#![cfg(target_os = "linux")]

use async_trait::async_trait;
use regex::Regex;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use log::{debug, error, info, warn};

use super::error::{Result, SchedulerError};
use super::service::{generate_task_name, now_iso, SystemScheduler, TASK_PREFIX};
use super::types::{
    CreateSystemTaskInput, RunLevel, SchedulerCapabilities, SystemTask, SystemTaskAction,
    SystemTaskId, SystemTaskStatus, SystemTaskTrigger, TaskMetadataState, TaskRunResult,
    TranslationValidation, TriggerCapability,
};

/// Linux systemd scheduler implementation
pub struct LinuxScheduler {
    /// Whether systemctl is available
    available: bool,
    /// User systemd directory
    user_dir: PathBuf,
}

impl LinuxScheduler {
    /// Create a new Linux scheduler instance
    pub fn new() -> Self {
        let available = Self::check_systemctl_available();
        let user_dir = Self::get_user_systemd_dir();

        info!(
            "Linux scheduler initialized: available={}, dir={:?}",
            available, user_dir
        );

        Self {
            available,
            user_dir,
        }
    }

    /// Check if systemctl is available
    fn check_systemctl_available() -> bool {
        Command::new("systemctl")
            .arg("--user")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Get user systemd directory
    fn get_user_systemd_dir() -> PathBuf {
        dirs::config_dir()
            .map(|c| c.join("systemd").join("user"))
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .map(|h| h.join(".config").join("systemd").join("user"))
                    .unwrap_or_else(|| PathBuf::from("/tmp"))
            })
    }

    /// Generate service unit name
    fn service_name(task_name: &str) -> String {
        format!("cognia-task-{}.service", Self::sanitize_name(task_name))
    }

    /// Generate timer unit name
    fn timer_name(task_name: &str) -> String {
        format!("cognia-task-{}.timer", Self::sanitize_name(task_name))
    }

    /// Sanitize name for systemd unit
    fn sanitize_name(name: &str) -> String {
        name.chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect()
    }

    /// Generate service unit content
    fn generate_service(task: &SystemTask) -> Result<String> {
        let (exec_start, working_dir, env) = Self::build_exec_start(&task.action)?;

        let mut unit = format!(
            r#"[Unit]
Description=Cognia Task: {}
After=network.target

[Service]
Type=oneshot
ExecStart={}
"#,
            task.name, exec_start
        );

        if let Some(dir) = working_dir {
            unit.push_str(&format!("WorkingDirectory={}\n", dir));
        }

        for (k, v) in env {
            unit.push_str(&format!("Environment=\"{}={}\"\n", k, v));
        }

        // Logging
        unit.push_str("StandardOutput=journal\n");
        unit.push_str("StandardError=journal\n");

        // Install section
        unit.push_str("\n[Install]\nWantedBy=default.target\n");

        Ok(unit)
    }

    /// Generate timer unit content
    fn generate_timer(task: &SystemTask) -> Result<String> {
        let service_name = Self::service_name(&task.name);
        let on_calendar = Self::trigger_to_on_calendar(&task.trigger)?;

        let mut timer = format!(
            r#"[Unit]
Description=Timer for Cognia Task: {}

[Timer]
"#,
            task.name
        );

        let is_calendar_timer = match &task.trigger {
            SystemTaskTrigger::OnBoot { delay_seconds } => {
                timer.push_str(&format!("OnBootSec={}s\n", delay_seconds));
                false
            }
            SystemTaskTrigger::Interval { seconds } => {
                timer.push_str(&format!("OnUnitActiveSec={}s\n", seconds));
                timer.push_str("OnBootSec=60s\n"); // Start 60s after boot
                false
            }
            _ => {
                if let Some(cal) = on_calendar {
                    timer.push_str(&format!("OnCalendar={}\n", cal));
                    true
                } else {
                    false
                }
            }
        };

        // Persistent=true only meaningful for OnCalendar timers; systemd ignores it for monotonic timers
        if is_calendar_timer {
            timer.push_str("Persistent=true\n");
        }
        timer.push_str(&format!("Unit={}\n", service_name));
        timer.push_str("\n[Install]\nWantedBy=timers.target\n");

        Ok(timer)
    }

    /// Convert trigger to systemd OnCalendar format
    fn trigger_to_on_calendar(trigger: &SystemTaskTrigger) -> Result<Option<String>> {
        match trigger {
            SystemTaskTrigger::Cron { expression, .. } => {
                Self::cron_to_calendar(expression).map(Some)
            }
            SystemTaskTrigger::Once { run_at } => {
                let dt = chrono::DateTime::parse_from_rfc3339(run_at).map_err(|e| {
                    SchedulerError::InvalidConfig(format!("Invalid datetime: {}", e))
                })?;
                Ok(Some(dt.format("%Y-%m-%d %H:%M:%S").to_string()))
            }
            SystemTaskTrigger::OnLogon { .. } => {
                // Use OnStartupSec instead
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// Convert cron expression to systemd calendar format
    fn cron_to_calendar(expression: &str) -> Result<String> {
        let parts: Vec<&str> = expression.trim().split_whitespace().collect();
        if parts.len() != 5 {
            return Err(SchedulerError::InvalidCron(format!(
                "Expected 5 parts, got {}",
                parts.len()
            )));
        }

        let (minute, hour, dom, month, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);

        // Build systemd calendar format: DOW YEAR-MONTH-DAY HOUR:MINUTE:SECOND
        let mut calendar = String::new();

        // Day of week
        if dow != "*" {
            calendar.push_str(&Self::convert_dow_systemd(dow));
            calendar.push(' ');
        }

        // Date part (YEAR-MONTH-DAY)
        calendar.push_str("*-"); // Year is always *

        // Month
        if month == "*" {
            calendar.push_str("*-");
        } else {
            calendar.push_str(&format!("{}-", Self::expand_cron_field(month)));
        }

        // Day of month
        if dom == "*" {
            calendar.push_str("* ");
        } else {
            calendar.push_str(&format!("{} ", Self::expand_cron_field(dom)));
        }

        // Time part (HOUR:MINUTE:SECOND)
        // Hour
        if hour == "*" {
            calendar.push_str("*:");
        } else {
            calendar.push_str(&format!("{}:", Self::expand_cron_field(hour)));
        }

        // Minute
        if minute == "*" {
            calendar.push_str("*:00");
        } else {
            calendar.push_str(&format!("{}:00", Self::expand_cron_field(minute)));
        }

        Ok(calendar)
    }

    /// Expand cron field (handle */n syntax)
    fn expand_cron_field(field: &str) -> String {
        if field.starts_with("*/") {
            // Convert */5 to 0/5 for systemd
            format!("0/{}", &field[2..])
        } else {
            field.to_string()
        }
    }

    /// Convert cron day-of-week to systemd format
    fn convert_dow_systemd(dow: &str) -> String {
        if dow.contains('-') {
            // Range like 1-5
            let parts: Vec<&str> = dow.split('-').collect();
            if parts.len() == 2 {
                let start = Self::num_to_day_systemd(parts[0]);
                let end = Self::num_to_day_systemd(parts[1]);
                return format!("{}..{}", start, end);
            }
        }

        if dow.contains(',') {
            return dow
                .split(',')
                .map(Self::num_to_day_systemd)
                .collect::<Vec<_>>()
                .join(",");
        }

        Self::num_to_day_systemd(dow)
    }

    /// Convert numeric day to systemd day name
    fn num_to_day_systemd(day: &str) -> String {
        match day.parse::<u32>() {
            Ok(0) | Ok(7) => "Sun".to_string(),
            Ok(1) => "Mon".to_string(),
            Ok(2) => "Tue".to_string(),
            Ok(3) => "Wed".to_string(),
            Ok(4) => "Thu".to_string(),
            Ok(5) => "Fri".to_string(),
            Ok(6) => "Sat".to_string(),
            _ => day.to_string(),
        }
    }

    /// Build ExecStart command
    fn build_exec_start(
        action: &SystemTaskAction,
    ) -> Result<(String, Option<String>, HashMap<String, String>)> {
        match action {
            SystemTaskAction::ExecuteScript {
                language,
                code,
                working_dir,
                args,
                env,
                timeout_secs,
                memory_mb,
                use_sandbox,
            } => {
                let code_b64 =
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, code);
                let cognia_path = Self::get_cognia_path();
                let sandbox_flag = if *use_sandbox {
                    "--sandbox"
                } else {
                    "--native"
                };

                let exec_start = format!(
                    "{} execute-script --language {} {} --timeout {} --memory {} --code-b64 '{}' {}",
                    cognia_path,
                    language,
                    sandbox_flag,
                    timeout_secs,
                    memory_mb,
                    code_b64,
                    args.join(" ")
                );

                Ok((exec_start, working_dir.clone(), env.clone()))
            }
            SystemTaskAction::RunCommand {
                command,
                args,
                working_dir,
                env,
            } => {
                let exec_start = if args.is_empty() {
                    command.clone()
                } else {
                    format!("{} {}", command, args.join(" "))
                };

                Ok((exec_start, working_dir.clone(), env.clone()))
            }
            SystemTaskAction::LaunchApp { path, args } => {
                let exec_start = if args.is_empty() {
                    path.clone()
                } else {
                    format!("{} {}", path, args.join(" "))
                };

                Ok((exec_start, None, HashMap::new()))
            }
        }
    }

    /// Get Cognia executable path
    fn get_cognia_path() -> String {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/usr/bin/cognia".to_string())
    }

    fn parse_unit_value(content: &str, key: &str) -> Option<String> {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some(rest) = line.strip_prefix(&format!("{key}=")) {
                return Some(rest.trim().trim_matches('"').to_string());
            }
        }
        None
    }

    fn parse_duration_seconds(raw: &str) -> Option<u64> {
        let value = raw.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        if let Ok(seconds) = value.parse::<u64>() {
            return Some(seconds);
        }

        let regex = Regex::new(r"^(\d+)([a-z]+)$").ok()?;
        let captures = regex.captures(&value)?;
        let num = captures.get(1)?.as_str().parse::<u64>().ok()?;
        let unit = captures.get(2)?.as_str();
        match unit {
            "s" | "sec" | "secs" | "second" | "seconds" => Some(num),
            "m" | "min" | "mins" | "minute" | "minutes" => Some(num * 60),
            "h" | "hr" | "hour" | "hours" => Some(num * 3600),
            "d" | "day" | "days" => Some(num * 24 * 3600),
            _ => None,
        }
    }

    fn parse_oncalendar_to_trigger(value: &str) -> Option<SystemTaskTrigger> {
        let trimmed = value.trim();
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
            return Some(SystemTaskTrigger::Once {
                run_at: format!("{}Z", dt.format("%Y-%m-%dT%H:%M:%S")),
            });
        }

        let regex = Regex::new(r"(\d{1,2}):(\d{1,2}):00").ok()?;
        let captures = regex.captures(trimmed)?;
        let hour = captures.get(1)?.as_str().parse::<u32>().ok()?;
        let minute = captures.get(2)?.as_str().parse::<u32>().ok()?;
        let dow = if trimmed.starts_with("Mon")
            || trimmed.starts_with("Tue")
            || trimmed.starts_with("Wed")
            || trimmed.starts_with("Thu")
            || trimmed.starts_with("Fri")
            || trimmed.starts_with("Sat")
            || trimmed.starts_with("Sun")
        {
            let day = trimmed
                .split_whitespace()
                .next()
                .unwrap_or("*")
                .replace("..", "-")
                .replace("Sun", "0")
                .replace("Mon", "1")
                .replace("Tue", "2")
                .replace("Wed", "3")
                .replace("Thu", "4")
                .replace("Fri", "5")
                .replace("Sat", "6");
            day
        } else {
            "*".to_string()
        };

        Some(SystemTaskTrigger::Cron {
            expression: format!("{minute} {hour} * * {dow}"),
            timezone: Some("UTC".to_string()),
        })
    }

    fn parse_trigger_from_units(timer_content: &str) -> Option<SystemTaskTrigger> {
        if let Some(value) = Self::parse_unit_value(timer_content, "OnUnitActiveSec")
            .and_then(|v| Self::parse_duration_seconds(&v))
        {
            return Some(SystemTaskTrigger::Interval { seconds: value });
        }

        if let Some(value) = Self::parse_unit_value(timer_content, "OnBootSec")
            .and_then(|v| Self::parse_duration_seconds(&v))
        {
            return Some(SystemTaskTrigger::OnBoot {
                delay_seconds: value,
            });
        }

        let on_calendar = Self::parse_unit_value(timer_content, "OnCalendar")?;
        Self::parse_oncalendar_to_trigger(&on_calendar)
    }

    fn arg_value(args: &[String], key: &str) -> Option<String> {
        args.iter()
            .position(|arg| arg == key)
            .and_then(|index| args.get(index + 1).cloned())
    }

    fn parse_service_env(service_content: &str) -> HashMap<String, String> {
        let mut env = HashMap::new();
        for line in service_content.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("Environment=") {
                let value = value.trim().trim_matches('"');
                if let Some((key, val)) = value.split_once('=') {
                    env.insert(key.to_string(), val.to_string());
                }
            }
        }
        env
    }

    fn parse_action_from_service(service_content: &str) -> Option<SystemTaskAction> {
        let exec = Self::parse_unit_value(service_content, "ExecStart")?;
        let mut parts = exec
            .split_whitespace()
            .map(|item| item.trim_matches('\'').trim_matches('"').to_string())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return None;
        }

        let command = parts.remove(0);
        let args = parts;
        let working_dir = Self::parse_unit_value(service_content, "WorkingDirectory");
        let env = Self::parse_service_env(service_content);

        if args.iter().any(|arg| arg == "execute-script") {
            let language =
                Self::arg_value(&args, "--language").unwrap_or_else(|| "unknown".to_string());
            let timeout_secs = Self::arg_value(&args, "--timeout")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(300);
            let memory_mb = Self::arg_value(&args, "--memory")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(512);
            let use_sandbox = args.iter().any(|arg| arg == "--sandbox");
            let code_b64 = Self::arg_value(&args, "--code-b64").unwrap_or_default();
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
            args,
            working_dir,
            env,
        })
    }

    /// Run systemctl command
    fn systemctl(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        Command::new("systemctl").arg("--user").args(args).output()
    }

    /// Check if a unit exists
    fn unit_exists(&self, unit_name: &str) -> bool {
        self.user_dir.join(unit_name).exists()
    }

    /// Reload systemd daemon
    fn daemon_reload(&self) -> Result<()> {
        let output = self.systemctl(&["daemon-reload"])?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(SchedulerError::Platform(format!(
                "daemon-reload failed: {}",
                stderr
            )));
        }
        Ok(())
    }
}

impl Default for LinuxScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SystemScheduler for LinuxScheduler {
    fn capabilities(&self) -> SchedulerCapabilities {
        let trigger_caps = self.get_trigger_capabilities();
        let supported_triggers = trigger_caps
            .iter()
            .filter(|tc| tc.available)
            .map(|tc| tc.trigger_type.clone())
            .collect();
        SchedulerCapabilities {
            os: "linux".to_string(),
            backend: "systemd".to_string(),
            available: self.available,
            can_elevate: false, // User services only
            supported_triggers,
            trigger_capabilities: trigger_caps,
            max_tasks: 0,
        }
    }

    fn is_available(&self) -> bool {
        self.available
    }

    async fn create_task(&self, input: CreateSystemTaskInput) -> Result<SystemTask> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "systemd not available".to_string(),
            ));
        }

        // Ensure directory exists
        fs::create_dir_all(&self.user_dir)?;

        let task_name = generate_task_name(&input.name);
        let service_name = Self::service_name(&task_name);
        let timer_name = Self::timer_name(&task_name);

        // Check if already exists
        if self.unit_exists(&service_name) || self.unit_exists(&timer_name) {
            return Err(SchedulerError::TaskAlreadyExists(task_name));
        }

        // Build task object
        let mut task = SystemTask {
            id: task_name.clone(),
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

        // Generate and write service unit
        let service_content = Self::generate_service(&task)?;
        fs::write(self.user_dir.join(&service_name), &service_content)?;

        // Generate and write timer unit
        let timer_content = Self::generate_timer(&task)?;
        fs::write(self.user_dir.join(&timer_name), &timer_content)?;

        debug!("Created units: {} and {}", service_name, timer_name);

        // Reload daemon
        self.daemon_reload()?;

        // Enable and start timer
        let output = self.systemctl(&["enable", "--now", &timer_name])?;
        if !output.status.success() {
            // Cleanup on failure
            let _ = fs::remove_file(self.user_dir.join(&service_name));
            let _ = fs::remove_file(self.user_dir.join(&timer_name));
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to enable timer: {}", stderr);
            return Err(SchedulerError::Platform(stderr.to_string()));
        }

        info!("Created Linux task: {}", task_name);
        Ok(task)
    }

    async fn update_task(&self, id: &str, input: CreateSystemTaskInput) -> Result<SystemTask> {
        self.delete_task(id).await?;
        self.create_task(input).await
    }

    async fn delete_task(&self, id: &str) -> Result<bool> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "systemd not available".to_string(),
            ));
        }

        let service_name = Self::service_name(id);
        let timer_name = Self::timer_name(id);

        // Stop and disable timer
        let _ = self.systemctl(&["disable", "--now", &timer_name]);

        // Remove unit files
        let service_path = self.user_dir.join(&service_name);
        let timer_path = self.user_dir.join(&timer_name);

        let mut deleted = false;

        if service_path.exists() {
            fs::remove_file(&service_path)?;
            deleted = true;
        }

        if timer_path.exists() {
            fs::remove_file(&timer_path)?;
            deleted = true;
        }

        if deleted {
            self.daemon_reload()?;
            info!("Deleted Linux task: {}", id);
        }

        Ok(deleted)
    }

    async fn get_task(&self, id: &str) -> Result<Option<SystemTask>> {
        let timer_name = Self::timer_name(id);
        let service_name = Self::service_name(id);

        if !self.unit_exists(&timer_name) {
            return Ok(None);
        }

        // Get status
        let output = self.systemctl(&["is-active", &timer_name])?;
        let status = if output.status.success() {
            SystemTaskStatus::Enabled
        } else {
            SystemTaskStatus::Disabled
        };

        let timer_content = fs::read_to_string(self.user_dir.join(&timer_name)).unwrap_or_default();
        let service_content =
            fs::read_to_string(self.user_dir.join(&service_name)).unwrap_or_default();
        let parsed_trigger = Self::parse_trigger_from_units(&timer_content);
        let parsed_action = Self::parse_action_from_service(&service_content);
        let metadata_state = if parsed_trigger.is_some() && parsed_action.is_some() {
            TaskMetadataState::Full
        } else {
            TaskMetadataState::Degraded
        };

        Ok(Some(SystemTask {
            id: id.to_string(),
            name: id.trim_start_matches(TASK_PREFIX).to_string(),
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
        }))
    }

    async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
        if !self.available || !self.user_dir.exists() {
            return Ok(vec![]);
        }

        let mut tasks = Vec::new();

        for entry in fs::read_dir(&self.user_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();

            if name.starts_with("cognia-task-") && name.ends_with(".timer") {
                let id = name
                    .trim_start_matches("cognia-task-")
                    .trim_end_matches(".timer")
                    .to_string();

                if let Ok(Some(task)) = self.get_task(&id).await {
                    tasks.push(task);
                }
            }
        }

        Ok(tasks)
    }

    async fn enable_task(&self, id: &str) -> Result<bool> {
        let timer_name = Self::timer_name(id);
        let output = self.systemctl(&["enable", "--now", &timer_name])?;
        Ok(output.status.success())
    }

    async fn disable_task(&self, id: &str) -> Result<bool> {
        let timer_name = Self::timer_name(id);
        let output = self.systemctl(&["disable", "--now", &timer_name])?;
        Ok(output.status.success())
    }

    async fn run_task_now(&self, id: &str) -> Result<TaskRunResult> {
        let service_name = Self::service_name(id);
        let start = std::time::Instant::now();

        let output = self.systemctl(&["start", &service_name])?;
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
        // User services don't need elevation
        Ok(true)
    }

    fn is_elevated(&self) -> bool {
        unsafe { libc::geteuid() == 0 }
    }

    fn get_trigger_capabilities(&self) -> Vec<TriggerCapability> {
        vec![
            TriggerCapability {
                trigger_type: "cron".to_string(),
                available: true,
                requires_admin: false,
                constraint_notes: vec![],
                backend_notes: vec![
                    "Uses systemd OnCalendar directive. Persistent=true ensures missed runs are caught up.".to_string(),
                ],
            },
            TriggerCapability {
                trigger_type: "interval".to_string(),
                available: true,
                requires_admin: false,
                constraint_notes: vec![],
                backend_notes: vec![
                    "Uses systemd OnUnitActiveSec. First run triggered 60s after boot via OnBootSec.".to_string(),
                ],
            },
            TriggerCapability {
                trigger_type: "once".to_string(),
                available: true,
                requires_admin: false,
                constraint_notes: vec![],
                backend_notes: vec![
                    "Uses systemd OnCalendar with a fixed datetime. Persistent=true ensures the run happens even if missed.".to_string(),
                ],
            },
            TriggerCapability {
                trigger_type: "on_boot".to_string(),
                available: true,
                requires_admin: false,
                constraint_notes: vec![],
                backend_notes: vec![
                    "Uses systemd OnBootSec. Runs as a user service after the user's systemd instance starts.".to_string(),
                ],
            },
            TriggerCapability {
                trigger_type: "on_logon".to_string(),
                available: false,
                requires_admin: false,
                constraint_notes: vec![
                    "systemd user services start at user login automatically; use 'on_boot' with a short delay for equivalent behavior.".to_string(),
                ],
                backend_notes: vec![],
            },
            TriggerCapability {
                trigger_type: "on_event".to_string(),
                available: false,
                requires_admin: false,
                constraint_notes: vec![
                    "Event-based triggers are not supported via systemd user timers.".to_string(),
                ],
                backend_notes: vec![],
            },
        ]
    }

    fn validate_trigger_translation(&self, trigger: &SystemTaskTrigger) -> TranslationValidation {
        match trigger {
            SystemTaskTrigger::OnEvent { .. } => TranslationValidation {
                valid: false,
                errors: vec![
                    "Event-based triggers are not supported via systemd user timers.".to_string(),
                ],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::OnLogon { .. } => TranslationValidation {
                valid: false,
                errors: vec![
                    "systemd user services start at user login automatically; use 'on_boot' with a short delay for equivalent behavior.".to_string(),
                ],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::Cron { expression, .. } => {
                match Self::cron_to_calendar(expression) {
                    Ok(cal) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec![],
                        native_representation: Some(format!("systemd: OnCalendar={}", cal)),
                    },
                    Err(e) => TranslationValidation {
                        valid: false,
                        errors: vec![format!(
                            "Cron expression cannot be converted to systemd OnCalendar: {}",
                            e
                        )],
                        warnings: vec![],
                        native_representation: None,
                    },
                }
            }
            SystemTaskTrigger::Interval { seconds } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some(format!("systemd: OnUnitActiveSec={}s", seconds)),
            },
            SystemTaskTrigger::Once { run_at } => {
                match chrono::DateTime::parse_from_rfc3339(run_at) {
                    Ok(dt) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec![],
                        native_representation: Some(format!(
                            "systemd: OnCalendar={}",
                            dt.format("%Y-%m-%d %H:%M:%S")
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
            SystemTaskTrigger::OnBoot { delay_seconds } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some(format!("systemd: OnBootSec={}s", delay_seconds)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_systemd_units_for_trigger_and_action() {
        let timer = r#"
[Timer]
OnUnitActiveSec=120s
"#;
        let service = r#"
[Service]
ExecStart=/bin/echo hello world
WorkingDirectory=/tmp
"#;

        let trigger = LinuxScheduler::parse_trigger_from_units(timer).expect("trigger");
        let action = LinuxScheduler::parse_action_from_service(service).expect("action");

        assert!(matches!(
            trigger,
            SystemTaskTrigger::Interval { seconds: 120 }
        ));
        assert!(matches!(action, SystemTaskAction::RunCommand { .. }));
    }

    #[test]
    fn timer_generation_uses_persistent_only_for_calendar() {
        let cron_task = SystemTask {
            id: "test-cron".to_string(),
            name: "cron-task".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Cron {
                expression: "0 9 * * *".to_string(),
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
        };

        let timer = LinuxScheduler::generate_timer(&cron_task).expect("cron timer");
        assert!(
            timer.contains("Persistent=true"),
            "Calendar timer must have Persistent=true"
        );

        let interval_task = SystemTask {
            trigger: SystemTaskTrigger::Interval { seconds: 300 },
            ..cron_task.clone()
        };
        let timer = LinuxScheduler::generate_timer(&interval_task).expect("interval timer");
        assert!(
            !timer.contains("Persistent=true"),
            "Interval timer must NOT have Persistent=true"
        );

        let boot_task = SystemTask {
            trigger: SystemTaskTrigger::OnBoot { delay_seconds: 60 },
            ..cron_task
        };
        let timer = LinuxScheduler::generate_timer(&boot_task).expect("boot timer");
        assert!(
            !timer.contains("Persistent=true"),
            "OnBoot timer must NOT have Persistent=true"
        );
    }

    #[test]
    fn trigger_capabilities_report_on_logon_unavailable() {
        let scheduler = LinuxScheduler {
            available: true,
            user_dir: std::path::PathBuf::from("/tmp"),
        };
        let caps = scheduler.get_trigger_capabilities();
        let on_logon = caps.iter().find(|c| c.trigger_type == "on_logon").unwrap();
        assert!(!on_logon.available);
    }

    #[test]
    fn validate_translation_rejects_on_logon() {
        let scheduler = LinuxScheduler {
            available: true,
            user_dir: std::path::PathBuf::from("/tmp"),
        };
        let result =
            scheduler.validate_trigger_translation(&SystemTaskTrigger::OnLogon { user: None });
        assert!(!result.valid);
        assert!(!result.errors.is_empty());
    }
}
