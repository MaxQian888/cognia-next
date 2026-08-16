//! Windows Task Scheduler implementation
//!
//! Uses schtasks.exe command-line tool for compatibility.
//! For production, consider using Windows COM API via windows-rs crate.

// cfg(target_os = "windows") is already applied at module level in mod.rs

use async_trait::async_trait;
use chrono::Timelike;
use log::{debug, error, info, warn};
use regex::Regex;
use std::process::Command;

use super::error::{Result, SchedulerError};
use super::service::{generate_task_name, is_cognia_task, now_iso, SystemScheduler, TASK_PREFIX};
use super::types::{
    derive_trigger_capabilities, validate_open_url, CreateSystemTaskInput, RunLevel,
    SchedulerCapabilities, SystemTask, SystemTaskAction, SystemTaskStatus, SystemTaskTrigger,
    SystemTriggerKind, TaskMetadataState, TaskRunResult, TranslationValidation, TriggerCapability,
};

/// Windows Task Scheduler implementation
pub struct WindowsScheduler {
    /// Whether the scheduler is available
    available: bool,
    /// Whether running elevated
    elevated: bool,
}

impl WindowsScheduler {
    /// Create a new Windows scheduler instance
    pub fn new() -> Self {
        let available = Self::check_schtasks_available();
        let elevated = Self::check_elevated();

        info!(
            "Windows scheduler initialized: available={}, elevated={}",
            available, elevated
        );

        Self {
            available,
            elevated,
        }
    }

    /// Check if schtasks.exe is available
    fn check_schtasks_available() -> bool {
        Command::new("schtasks")
            .arg("/Query")
            .arg("/TN")
            .arg("\\")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Check if running with elevated privileges
    fn check_elevated() -> bool {
        // Try to query SYSTEM folder - only works if elevated
        Command::new("schtasks")
            .args(["/Query", "/TN", "\\Microsoft\\Windows\\"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Convert trigger to schtasks schedule parameters
    fn trigger_to_schtasks_args(trigger: &SystemTaskTrigger) -> Result<Vec<String>> {
        match trigger {
            SystemTaskTrigger::Cron { expression, .. } => {
                // Parse cron and convert to schtasks format
                // schtasks supports: MINUTE, HOURLY, DAILY, WEEKLY, MONTHLY, ONCE, ONSTART, ONLOGON
                Self::cron_to_schtasks(expression)
            }
            SystemTaskTrigger::Interval { seconds } => {
                let minutes = (*seconds / 60).max(1);
                Ok(vec![
                    "/SC".to_string(),
                    "MINUTE".to_string(),
                    "/MO".to_string(),
                    minutes.to_string(),
                ])
            }
            SystemTaskTrigger::Once { run_at } => {
                // Parse datetime and extract date/time
                let dt = chrono::DateTime::parse_from_rfc3339(run_at).map_err(|e| {
                    SchedulerError::InvalidConfig(format!("Invalid datetime: {}", e))
                })?;
                Ok(vec![
                    "/SC".to_string(),
                    "ONCE".to_string(),
                    "/SD".to_string(),
                    dt.format("%m/%d/%Y").to_string(),
                    "/ST".to_string(),
                    dt.format("%H:%M").to_string(),
                ])
            }
            SystemTaskTrigger::OnBoot { delay_seconds } => {
                let mut args = vec!["/SC".to_string(), "ONSTART".to_string()];
                if *delay_seconds > 0 {
                    args.push("/DELAY".to_string());
                    let mins = (*delay_seconds / 60).max(1);
                    args.push(format!("0000:{:02}:00", mins.min(59)));
                }
                Ok(args)
            }
            SystemTaskTrigger::OnLogon { user } => {
                let mut args = vec!["/SC".to_string(), "ONLOGON".to_string()];
                if let Some(u) = user {
                    args.push("/RU".to_string());
                    args.push(u.clone());
                }
                Ok(args)
            }
            SystemTaskTrigger::OnEvent { source, event_id } => {
                // ONEVENT requires XML task definition, use workaround
                warn!("OnEvent trigger requires XML, falling back to manual setup");
                Err(SchedulerError::InvalidConfig(format!(
                    "OnEvent trigger (source={}, id={}) requires manual XML configuration",
                    source, event_id
                )))
            }
        }
    }

    /// Convert simplified cron expression to schtasks format
    fn cron_to_schtasks(expression: &str) -> Result<Vec<String>> {
        let parts: Vec<&str> = expression.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(SchedulerError::InvalidCron(format!(
                "Expected 5 parts, got {}",
                parts.len()
            )));
        }

        let (minute, hour, dom, _month, dow) = (parts[0], parts[1], parts[2], parts[3], parts[4]);

        // Common patterns
        match (minute, hour, dom, dow) {
            // Every minute
            ("*", "*", "*", "*") => Ok(vec!["/SC".to_string(), "MINUTE".to_string()]),
            // Every N minutes
            (m, "*", "*", "*") if m.starts_with("*/") => {
                let interval = Self::parse_minute_interval(m)?;
                Ok(vec![
                    "/SC".to_string(),
                    "MINUTE".to_string(),
                    "/MO".to_string(),
                    interval.to_string(),
                ])
            }
            // Every hour at specific minute
            (m, "*", "*", "*") if Self::is_cron_number(m) => {
                let minute = Self::parse_minute(m)?;
                Ok(vec![
                    "/SC".to_string(),
                    "HOURLY".to_string(),
                    "/ST".to_string(),
                    format!("00:{minute:02}"),
                ])
            }
            // Daily at specific time
            (m, h, "*", "*") if Self::is_cron_number(m) && Self::is_cron_number(h) => {
                let minute = Self::parse_minute(m)?;
                let hour = Self::parse_hour(h)?;
                Ok(vec![
                    "/SC".to_string(),
                    "DAILY".to_string(),
                    "/ST".to_string(),
                    format!("{hour:02}:{minute:02}"),
                ])
            }
            // Weekly on specific days
            (m, h, "*", days) if Self::is_cron_number(m) && Self::is_cron_number(h) => {
                let minute = Self::parse_minute(m)?;
                let hour = Self::parse_hour(h)?;
                let day_str = Self::convert_dow(days)?;
                Ok(vec![
                    "/SC".to_string(),
                    "WEEKLY".to_string(),
                    "/D".to_string(),
                    day_str,
                    "/ST".to_string(),
                    format!("{hour:02}:{minute:02}"),
                ])
            }
            // Monthly on specific day
            (m, h, day, "*")
                if Self::is_cron_number(m)
                    && Self::is_cron_number(h)
                    && Self::is_cron_number(day) =>
            {
                let minute = Self::parse_minute(m)?;
                let hour = Self::parse_hour(h)?;
                let day = Self::parse_day_of_month(day)?;
                Ok(vec![
                    "/SC".to_string(),
                    "MONTHLY".to_string(),
                    "/D".to_string(),
                    day.to_string(),
                    "/ST".to_string(),
                    format!("{hour:02}:{minute:02}"),
                ])
            }
            _ => Err(SchedulerError::InvalidCron(format!(
                "Unsupported cron pattern: {}",
                expression
            ))),
        }
    }

    fn is_cron_number(value: &str) -> bool {
        !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
    }

    fn parse_cron_number(value: &str, label: &str, min: u32, max: u32) -> Result<u32> {
        let parsed = value
            .parse::<u32>()
            .map_err(|_| SchedulerError::InvalidCron(format!("Invalid {label} value: {value}")))?;

        if (min..=max).contains(&parsed) {
            Ok(parsed)
        } else {
            Err(SchedulerError::InvalidCron(format!(
                "{label} value {parsed} out of range {min}-{max}"
            )))
        }
    }

    fn parse_minute(value: &str) -> Result<u32> {
        Self::parse_cron_number(value, "minute", 0, 59)
    }

    fn parse_hour(value: &str) -> Result<u32> {
        Self::parse_cron_number(value, "hour", 0, 23)
    }

    fn parse_day_of_month(value: &str) -> Result<u32> {
        Self::parse_cron_number(value, "day-of-month", 1, 31)
    }

    fn parse_minute_interval(value: &str) -> Result<u32> {
        let interval = value
            .strip_prefix("*/")
            .ok_or_else(|| SchedulerError::InvalidCron("Invalid minute interval".to_string()))?;

        Self::parse_cron_number(interval, "minute interval", 1, 59)
    }

    /// Convert cron day-of-week to schtasks format
    fn convert_dow(dow: &str) -> Result<String> {
        if dow == "*" {
            return Ok("*".to_string());
        }

        let days: Vec<&str> = if dow.contains(',') {
            dow.split(',').collect()
        } else if dow.contains('-') {
            // Range like 1-5 (Mon-Fri)
            let parts: Vec<&str> = dow.split('-').collect();
            if parts.len() != 2 {
                return Err(SchedulerError::InvalidCron("Invalid day range".to_string()));
            }
            let start: u32 = parts[0]
                .parse()
                .map_err(|_| SchedulerError::InvalidCron("Invalid day number".to_string()))?;
            let end: u32 = parts[1]
                .parse()
                .map_err(|_| SchedulerError::InvalidCron("Invalid day number".to_string()))?;
            if start > end {
                return Err(SchedulerError::InvalidCron("Invalid day range".to_string()));
            }
            let mut converted = Vec::new();
            for day in start..=end {
                converted.push(Self::num_to_day(day)?);
            }
            return Ok(converted.join(","));
        } else {
            vec![dow]
        };

        let converted: Result<Vec<String>> =
            days.iter().map(|day| Self::dow_token_to_day(day)).collect();

        Ok(converted?.join(","))
    }

    fn dow_token_to_day(day: &str) -> Result<String> {
        if let Ok(num) = day.parse::<u32>() {
            return Self::num_to_day(num);
        }

        let normalized = day.to_uppercase();
        match normalized.as_str() {
            "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" => Ok(normalized),
            _ => Err(SchedulerError::InvalidCron(format!(
                "Invalid day of week: {day}"
            ))),
        }
    }

    /// Convert numeric day (0-6, Sunday=0) to schtasks format
    fn num_to_day(num: u32) -> Result<String> {
        match num {
            0 | 7 => Ok("SUN".to_string()),
            1 => Ok("MON".to_string()),
            2 => Ok("TUE".to_string()),
            3 => Ok("WED".to_string()),
            4 => Ok("THU".to_string()),
            5 => Ok("FRI".to_string()),
            6 => Ok("SAT".to_string()),
            _ => Err(SchedulerError::InvalidCron(format!(
                "Invalid day number: {num}"
            ))),
        }
    }

    /// Build the action command for schtasks
    fn build_action_command(action: &SystemTaskAction) -> Result<(String, Vec<String>)> {
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
                // For scripts, we invoke Cognia's sandbox executor
                // The script is passed via a temporary file or base64 encoded
                let code_b64 =
                    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, code);

                // Build command to invoke Cognia with script execution
                // Using PowerShell to handle complex arguments
                let mut ps_args = vec![
                    "-NoProfile".to_string(),
                    "-ExecutionPolicy".to_string(),
                    "Bypass".to_string(),
                    "-Command".to_string(),
                ];

                let sandbox_flag = if *use_sandbox {
                    "--sandbox"
                } else {
                    "--native"
                };
                let cognia_cmd = format!(
                    "& '{}' execute-script --language {} {} --timeout {} --memory {} --code-b64 '{}'",
                    Self::get_cognia_exe_path(),
                    language,
                    sandbox_flag,
                    timeout_secs,
                    memory_mb,
                    code_b64
                );

                // Add environment variables
                let mut env_setup = String::new();
                for (k, v) in env {
                    Self::validate_env_name(k)?;
                    env_setup.push_str(&format!("$env:{}='{}'; ", k, v.replace("'", "''")));
                }

                // Add working directory
                let cd_cmd = working_dir
                    .as_ref()
                    .map(|d| format!("Set-Location '{}'; ", d))
                    .unwrap_or_default();

                // Add additional args
                let extra_args: String = args
                    .iter()
                    .map(|a| format!(" '{}'", a.replace("'", "''")))
                    .collect();

                ps_args.push(format!(
                    "{}{}{}{}",
                    env_setup, cd_cmd, cognia_cmd, extra_args
                ));

                Ok(("powershell.exe".to_string(), ps_args))
            }
            SystemTaskAction::RunCommand {
                command,
                args,
                working_dir,
                env,
            } => {
                // For commands, use cmd.exe wrapper for env and directory handling
                let mut cmd_parts = vec![];

                // Set environment variables
                for (k, v) in env {
                    Self::validate_env_name(k)?;
                    cmd_parts.push(format!("set {}={}", k, v));
                }

                // Change directory
                if let Some(dir) = working_dir {
                    cmd_parts.push(format!("cd /d \"{}\"", dir));
                }

                // Add the actual command
                let full_cmd = if args.is_empty() {
                    command.clone()
                } else {
                    format!("{} {}", command, args.join(" "))
                };
                cmd_parts.push(full_cmd);

                let cmd_line = cmd_parts.join(" && ");

                Ok(("cmd.exe".to_string(), vec!["/C".to_string(), cmd_line]))
            }
            SystemTaskAction::LaunchApp { path, args } => Ok((path.clone(), args.clone())),
            SystemTaskAction::OpenUrl { url } => {
                validate_open_url(url).map_err(SchedulerError::InvalidConfig)?;
                // `start` is a cmd.exe builtin; the empty "" is the window
                // title argument so the URL is not mistaken for it. The URL is
                // quoted as well so `?`/`=` never reach cmd's parser unquoted
                // (`validate_open_url` bans `&|<>%^"` outright, so the quotes
                // cannot be broken out of).
                Ok((
                    "cmd.exe".to_string(),
                    vec![
                        "/C".to_string(),
                        "start".to_string(),
                        "\"\"".to_string(),
                        format!("\"{}\"", url),
                    ],
                ))
            }
        }
    }

    fn validate_env_name(name: &str) -> Result<()> {
        let mut chars = name.chars();
        let Some(first) = chars.next() else {
            return Err(SchedulerError::SecurityViolation(
                "environment variable name is empty".to_string(),
            ));
        };
        if !(first == '_' || first.is_ascii_alphabetic()) {
            return Err(SchedulerError::SecurityViolation(format!(
                "unsafe environment variable name: {name}"
            )));
        }
        if chars.any(|c| !(c == '_' || c.is_ascii_alphanumeric())) {
            return Err(SchedulerError::SecurityViolation(format!(
                "unsafe environment variable name: {name}"
            )));
        }
        Ok(())
    }

    /// Get path to Cognia executable
    fn get_cognia_exe_path() -> String {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "cognia.exe".to_string())
    }

    fn decode_xml_entities(input: &str) -> String {
        input
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .trim()
            .to_string()
    }

    fn capture_tag(input: &str, tag: &str) -> Option<String> {
        let pattern = format!(r"(?s)<{0}>(.*?)</{0}>", tag);
        let regex = Regex::new(&pattern).ok()?;
        regex.captures(input).and_then(|cap| {
            cap.get(1)
                .map(|value| Self::decode_xml_entities(value.as_str()))
        })
    }

    fn parse_iso8601_interval_seconds(value: &str) -> Option<u64> {
        let interval = value.trim().trim_start_matches("PT");
        if interval.is_empty() {
            return None;
        }
        let mut total = 0_u64;
        let regex = Regex::new(r"(?i)(\d+)([HMS])").ok()?;
        for cap in regex.captures_iter(interval) {
            let n = cap.get(1)?.as_str().parse::<u64>().ok()?;
            match cap.get(2)?.as_str().to_ascii_uppercase().as_str() {
                "H" => total += n * 3600,
                "M" => total += n * 60,
                "S" => total += n,
                _ => {}
            }
        }
        if total > 0 {
            Some(total)
        } else {
            None
        }
    }

    fn parse_datetime_boundary(start_boundary: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        chrono::DateTime::parse_from_rfc3339(start_boundary)
            .ok()
            .map(|dt| dt.with_timezone(&chrono::Utc))
    }

    fn parse_days_of_week(calendar_block: &str) -> Option<String> {
        let mut days = Vec::new();
        let day_map = [
            ("Sunday", "0"),
            ("Monday", "1"),
            ("Tuesday", "2"),
            ("Wednesday", "3"),
            ("Thursday", "4"),
            ("Friday", "5"),
            ("Saturday", "6"),
        ];

        for (tag, value) in day_map {
            let marker = format!("<{}/>", tag);
            if calendar_block.contains(&marker) {
                days.push(value.to_string());
            }
        }

        if days.is_empty() {
            None
        } else {
            Some(days.join(","))
        }
    }

    fn parse_trigger_from_xml(xml: &str) -> Option<SystemTaskTrigger> {
        if let Some(boot_block) = Self::capture_tag(xml, "BootTrigger") {
            let delay = Self::capture_tag(&boot_block, "Delay")
                .and_then(|v| Self::parse_iso8601_interval_seconds(&v))
                .unwrap_or(0);
            return Some(SystemTaskTrigger::OnBoot {
                delay_seconds: delay,
            });
        }

        if let Some(logon_block) = Self::capture_tag(xml, "LogonTrigger") {
            let user = Self::capture_tag(&logon_block, "UserId");
            return Some(SystemTaskTrigger::OnLogon { user });
        }

        if let Some(time_block) = Self::capture_tag(xml, "TimeTrigger") {
            if let Some(run_at) = Self::capture_tag(&time_block, "StartBoundary") {
                return Some(SystemTaskTrigger::Once { run_at });
            }
        }

        if let Some(calendar_block) = Self::capture_tag(xml, "CalendarTrigger") {
            if let Some(repetition_block) = Self::capture_tag(&calendar_block, "Repetition") {
                if let Some(interval) = Self::capture_tag(&repetition_block, "Interval")
                    .and_then(|v| Self::parse_iso8601_interval_seconds(&v))
                {
                    return Some(SystemTaskTrigger::Interval { seconds: interval });
                }
            }

            let start_boundary = Self::capture_tag(&calendar_block, "StartBoundary")?;
            let start = Self::parse_datetime_boundary(&start_boundary)?;
            let minute = start.minute();
            let hour = start.hour();

            if let Some(week_block) = Self::capture_tag(&calendar_block, "ScheduleByWeek") {
                let dow = Self::parse_days_of_week(&week_block).unwrap_or_else(|| "*".to_string());
                return Some(SystemTaskTrigger::Cron {
                    expression: format!("{minute} {hour} * * {dow}"),
                    timezone: Some("UTC".to_string()),
                });
            }

            if let Some(day_block) = Self::capture_tag(&calendar_block, "ScheduleByDay") {
                if let Some(days_interval) = Self::capture_tag(&day_block, "DaysInterval")
                    .and_then(|v| v.parse::<u64>().ok())
                {
                    if days_interval > 1 {
                        return Some(SystemTaskTrigger::Interval {
                            seconds: days_interval * 24 * 3600,
                        });
                    }
                }
                return Some(SystemTaskTrigger::Cron {
                    expression: format!("{minute} {hour} * * *"),
                    timezone: Some("UTC".to_string()),
                });
            }

            return Some(SystemTaskTrigger::Cron {
                expression: format!("{minute} {hour} * * *"),
                timezone: Some("UTC".to_string()),
            });
        }

        None
    }

    fn parse_action_from_xml(xml: &str) -> Option<SystemTaskAction> {
        let exec_block = Self::capture_tag(xml, "Exec")?;
        let command = Self::capture_tag(&exec_block, "Command")?;
        let arguments = Self::capture_tag(&exec_block, "Arguments").unwrap_or_default();
        let working_dir = Self::capture_tag(&exec_block, "WorkingDirectory");

        if command.to_ascii_lowercase().contains("powershell")
            && arguments.contains("execute-script")
        {
            let language = Regex::new(r"--language\s+([^\s]+)")
                .ok()
                .and_then(|re| re.captures(&arguments))
                .and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
                .unwrap_or_else(|| "unknown".to_string());
            let code_b64 = Regex::new(r"--code-b64\s+'?([^'\s]+)'?")
                .ok()
                .and_then(|re| re.captures(&arguments))
                .and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
                .unwrap_or_default();
            let timeout_secs = Regex::new(r"--timeout\s+(\d+)")
                .ok()
                .and_then(|re| re.captures(&arguments))
                .and_then(|cap| cap.get(1).and_then(|m| m.as_str().parse::<u64>().ok()))
                .unwrap_or(300);
            let memory_mb = Regex::new(r"--memory\s+(\d+)")
                .ok()
                .and_then(|re| re.captures(&arguments))
                .and_then(|cap| cap.get(1).and_then(|m| m.as_str().parse::<u64>().ok()))
                .unwrap_or(512);
            let use_sandbox = arguments.contains("--sandbox");
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
                env: std::collections::HashMap::new(),
                timeout_secs,
                memory_mb,
                use_sandbox,
            });
        }

        let args = arguments
            .split_whitespace()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        Some(SystemTaskAction::RunCommand {
            command,
            args,
            working_dir,
            env: std::collections::HashMap::new(),
        })
    }

    fn enrich_from_xml(task: &SystemTask, xml: &str) -> Option<SystemTask> {
        let trigger = Self::parse_trigger_from_xml(xml)?;
        let action = Self::parse_action_from_xml(xml)?;
        let mut enriched = task.clone();
        enriched.trigger = trigger;
        enriched.action = action;
        enriched.metadata_state = TaskMetadataState::Full;
        enriched.requires_admin = enriched.check_requires_admin();
        Some(enriched)
    }

    /// Parse schtasks /Query output to extract task info
    fn parse_task_query(output: &str, task_name: &str) -> Option<SystemTask> {
        // Basic parsing of schtasks output
        let mut status = SystemTaskStatus::Unknown;
        let mut next_run = None;
        let mut last_run = None;

        for line in output.lines() {
            let line = line.trim();
            if line.starts_with("Status:") {
                let s = line.trim_start_matches("Status:").trim();
                status = match s {
                    "Ready" => SystemTaskStatus::Enabled,
                    "Running" => SystemTaskStatus::Running,
                    "Disabled" => SystemTaskStatus::Disabled,
                    _ => SystemTaskStatus::Unknown,
                };
            } else if line.starts_with("Next Run Time:") {
                let t = line.trim_start_matches("Next Run Time:").trim();
                if t != "N/A" {
                    next_run = Some(t.to_string());
                }
            } else if line.starts_with("Last Run Time:") {
                let t = line.trim_start_matches("Last Run Time:").trim();
                if t != "N/A" {
                    last_run = Some(t.to_string());
                }
            }
        }

        // Extract actual name from full path
        let name = task_name
            .trim_start_matches('\\')
            .trim_start_matches(TASK_PREFIX)
            .to_string();

        Some(SystemTask {
            id: task_name.to_string(),
            name,
            description: None,
            trigger: SystemTaskTrigger::Interval { seconds: 0 }, // Cannot determine from query
            action: SystemTaskAction::RunCommand {
                command: String::new(),
                args: vec![],
                working_dir: None,
                env: std::collections::HashMap::new(),
            },
            run_level: RunLevel::User,
            status,
            requires_admin: false,
            tags: vec![],
            created_at: None,
            updated_at: None,
            last_run_at: last_run,
            next_run_at: next_run,
            last_result: None,
            metadata_state: TaskMetadataState::Degraded,
        })
    }
}

impl Default for WindowsScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SystemScheduler for WindowsScheduler {
    fn capabilities(&self) -> SchedulerCapabilities {
        let trigger_caps = self.get_trigger_capabilities();
        let supported_triggers = trigger_caps
            .iter()
            .filter(|tc| tc.available)
            .map(|tc| tc.trigger_type.clone())
            .collect();
        SchedulerCapabilities {
            os: "windows".to_string(),
            backend: "Task Scheduler".to_string(),
            available: self.available,
            can_elevate: true,
            supported_triggers,
            trigger_capabilities: trigger_caps,
            supported_actions: super::types::all_action_kinds(),
            max_tasks: 0, // Unlimited
        }
    }

    fn is_available(&self) -> bool {
        self.available
    }

    async fn create_task(&self, input: CreateSystemTaskInput) -> Result<SystemTask> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "Task Scheduler not available".to_string(),
            ));
        }

        let task_name = generate_task_name(&input.name);
        let full_name = format!("\\{}", task_name);

        // Check if task already exists
        let check = Command::new("schtasks")
            .args(["/Query", "/TN", &full_name])
            .output()?;

        if check.status.success() {
            return Err(SchedulerError::TaskAlreadyExists(task_name));
        }

        // Build command arguments
        let mut args = vec!["/Create".to_string(), "/TN".to_string(), full_name.clone()];

        // Add trigger arguments
        let trigger_args = Self::trigger_to_schtasks_args(&input.trigger)?;
        args.extend(trigger_args);

        // Add action
        let (program, prog_args) = Self::build_action_command(&input.action)?;
        args.push("/TR".to_string());
        if prog_args.is_empty() {
            args.push(format!("\"{}\"", program));
        } else {
            args.push(format!("\"{}\" {}", program, prog_args.join(" ")));
        }

        // Run level
        if input.run_level == RunLevel::Administrator {
            args.push("/RL".to_string());
            args.push("HIGHEST".to_string());
        }

        // Force create (overwrite)
        args.push("/F".to_string());

        debug!("Creating task with args: {:?}", args);

        let output = Command::new("schtasks").args(&args).output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!("Failed to create task: {}", stderr);

            if stderr.contains("Access is denied") {
                return Err(SchedulerError::AdminRequired(
                    "Administrator privileges required to create this task".to_string(),
                ));
            }

            return Err(SchedulerError::Platform(stderr.to_string()));
        }

        info!("Created system task: {}", task_name);

        // Build and return task object
        let mut task = SystemTask {
            id: full_name,
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

        Ok(task)
    }

    async fn update_task(&self, id: &str, input: CreateSystemTaskInput) -> Result<SystemTask> {
        // Delete and recreate (schtasks doesn't have a proper update)
        self.delete_task(id).await?;
        self.create_task(input).await
    }

    async fn delete_task(&self, id: &str) -> Result<bool> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "Task Scheduler not available".to_string(),
            ));
        }

        let output = Command::new("schtasks")
            .args(["/Delete", "/TN", id, "/F"])
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("does not exist") {
                return Ok(false);
            }
            if stderr.contains("Access is denied") {
                return Err(SchedulerError::AdminRequired(
                    "Administrator privileges required to delete this task".to_string(),
                ));
            }
            return Err(SchedulerError::Platform(stderr.to_string()));
        }

        info!("Deleted system task: {}", id);
        Ok(true)
    }

    async fn get_task(&self, id: &str) -> Result<Option<SystemTask>> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "Task Scheduler not available".to_string(),
            ));
        }

        let output = Command::new("schtasks")
            .args(["/Query", "/TN", id, "/V", "/FO", "LIST"])
            .output()?;

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let base_task = match Self::parse_task_query(&stdout, id) {
            Some(task) => task,
            None => return Ok(None),
        };

        let xml_output = Command::new("schtasks")
            .args(["/Query", "/TN", id, "/XML"])
            .output()?;

        if xml_output.status.success() {
            let xml = String::from_utf8_lossy(&xml_output.stdout);
            if let Some(parsed) = Self::enrich_from_xml(&base_task, &xml) {
                return Ok(Some(parsed));
            }
        }

        Ok(Some(base_task))
    }

    async fn list_tasks(&self) -> Result<Vec<SystemTask>> {
        if !self.available {
            return Err(SchedulerError::NotAvailable(
                "Task Scheduler not available".to_string(),
            ));
        }

        let output = Command::new("schtasks")
            .args(["/Query", "/FO", "LIST"])
            .output()?;

        if !output.status.success() {
            return Ok(vec![]);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut tasks = Vec::new();

        // Parse output to find Cognia tasks
        let mut current_task_name = String::new();
        for line in stdout.lines() {
            if line.starts_with("TaskName:") {
                current_task_name = line.trim_start_matches("TaskName:").trim().to_string();
            } else if !current_task_name.is_empty() && is_cognia_task(&current_task_name) {
                // Get detailed info for this task
                if let Ok(Some(task)) = self.get_task(&current_task_name).await {
                    tasks.push(task);
                }
                current_task_name.clear();
            }
        }

        Ok(tasks)
    }

    async fn enable_task(&self, id: &str) -> Result<bool> {
        let output = Command::new("schtasks")
            .args(["/Change", "/TN", id, "/ENABLE"])
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(SchedulerError::Platform(stderr.to_string()));
        }

        Ok(true)
    }

    async fn disable_task(&self, id: &str) -> Result<bool> {
        let output = Command::new("schtasks")
            .args(["/Change", "/TN", id, "/DISABLE"])
            .output()?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(SchedulerError::Platform(stderr.to_string()));
        }

        Ok(true)
    }

    async fn run_task_now(&self, id: &str) -> Result<TaskRunResult> {
        let start = std::time::Instant::now();

        let output = Command::new("schtasks")
            .args(["/Run", "/TN", id])
            .output()?;

        let duration_ms = start.elapsed().as_millis() as u64;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Ok(TaskRunResult {
                success: false,
                exit_code: output.status.code(),
                stdout: None,
                stderr: Some(stderr.to_string()),
                error: Some(stderr.to_string()),
                duration_ms: Some(duration_ms),
            });
        }

        Ok(TaskRunResult {
            success: true,
            exit_code: Some(0),
            stdout: Some(String::from_utf8_lossy(&output.stdout).to_string()),
            stderr: None,
            error: None,
            duration_ms: Some(duration_ms),
        })
    }

    fn requires_admin(&self, task: &SystemTask) -> bool {
        task.check_requires_admin()
    }

    async fn request_elevation(&self) -> Result<bool> {
        // On Windows, we need to restart the process with elevation
        // This is typically done via ShellExecuteW with "runas" verb
        // For now, return false and let the UI handle elevation request
        warn!("Elevation request - application restart required");
        Err(SchedulerError::AdminRequired(
            "Please restart Cognia as Administrator to perform this operation".to_string(),
        ))
    }

    fn is_elevated(&self) -> bool {
        self.elevated
    }

    fn get_trigger_capabilities(&self) -> Vec<TriggerCapability> {
        derive_trigger_capabilities(|kind| {
            match kind {
            SystemTriggerKind::Cron => (true, false, vec![], vec!["Converted to schtasks schedule (MINUTE/HOURLY/DAILY/WEEKLY/MONTHLY). Complex cron patterns may not be fully expressible.".to_string()]),
            SystemTriggerKind::Interval => (true, false, vec![], vec!["Uses schtasks MINUTE schedule. Minimum granularity is 1 minute.".to_string()]),
            SystemTriggerKind::Once => (true, false, vec![], vec![]),
            SystemTriggerKind::OnBoot => (true, true, vec![], vec!["Uses schtasks ONSTART. Requires administrator privileges.".to_string()]),
            SystemTriggerKind::OnLogon => (true, false, vec![], vec!["Uses schtasks ONLOGON. Runs when the specified user logs in.".to_string()]),
            SystemTriggerKind::OnEvent => (false, false, vec!["Requires XML-based task creation; not yet supported via schtasks CLI. Will be enabled when XML round-trip parsing is implemented.".to_string()], vec![]),
        }
        })
    }

    fn validate_trigger_translation(&self, trigger: &SystemTaskTrigger) -> TranslationValidation {
        match trigger {
            SystemTaskTrigger::OnEvent { source, event_id } => TranslationValidation {
                valid: false,
                errors: vec![format!(
                    "Event triggers (source={}, id={}) are not supported on Windows via the schtasks CLI. XML-based task creation is required.",
                    source, event_id
                )],
                warnings: vec![],
                native_representation: None,
            },
            SystemTaskTrigger::Cron { expression, .. } => {
                match Self::cron_to_schtasks(expression) {
                    Ok(args) => {
                        let repr = args.join(" ");
                        TranslationValidation {
                            valid: true,
                            errors: vec![],
                            warnings: vec![],
                            native_representation: Some(format!("schtasks: /Create {}", repr)),
                        }
                    }
                    Err(e) => TranslationValidation {
                        valid: false,
                        errors: vec![format!(
                            "Cron pattern cannot be converted to schtasks schedule: {}",
                            e
                        )],
                        warnings: vec![],
                        native_representation: None,
                    },
                }
            }
            SystemTaskTrigger::Interval { seconds } => {
                let minutes = (*seconds / 60).max(1);
                let mut warnings = vec![];
                if *seconds < 60 {
                    warnings.push("Interval rounded up to 1 minute (schtasks minimum granularity).".to_string());
                }
                TranslationValidation {
                    valid: true,
                    errors: vec![],
                    warnings,
                    native_representation: Some(format!("schtasks: /SC MINUTE /MO {}", minutes)),
                }
            }
            SystemTaskTrigger::Once { run_at } => {
                match chrono::DateTime::parse_from_rfc3339(run_at) {
                    Ok(dt) => TranslationValidation {
                        valid: true,
                        errors: vec![],
                        warnings: vec![],
                        native_representation: Some(format!(
                            "schtasks: /SC ONCE /SD {} /ST {}",
                            dt.format("%m/%d/%Y"),
                            dt.format("%H:%M")
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
            SystemTaskTrigger::OnBoot { delay_seconds } => {
                let repr = if *delay_seconds > 0 {
                    let mins = (*delay_seconds / 60).clamp(1, 59);
                    format!("schtasks: /SC ONSTART /DELAY 0000:{:02}:00", mins)
                } else {
                    "schtasks: /SC ONSTART".to_string()
                };
                TranslationValidation {
                    valid: true,
                    errors: vec![],
                    warnings: vec![],
                    native_representation: Some(repr),
                }
            }
            SystemTaskTrigger::OnLogon { .. } => TranslationValidation {
                valid: true,
                errors: vec![],
                warnings: vec![],
                native_representation: Some("schtasks: /SC ONLOGON".to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_url_translates_to_cmd_start_and_rejects_bad_schemes() {
        let (program, args) = WindowsScheduler::build_action_command(&SystemTaskAction::OpenUrl {
            url: "cognia://scheduler/task/abc?run=tok".to_string(),
        })
        .unwrap();
        assert_eq!(program, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/C".to_string(),
                "start".to_string(),
                "\"\"".to_string(),
                "\"cognia://scheduler/task/abc?run=tok\"".to_string()
            ]
        );
        let err = WindowsScheduler::build_action_command(&SystemTaskAction::OpenUrl {
            url: "javascript://x".to_string(),
        })
        .unwrap_err();
        assert!(matches!(err, SchedulerError::InvalidConfig(_)));
        // cmd metacharacters (`%VAR%` expansion, `^` escape) never reach `start`.
        for bad in ["cognia://a%PATH%", "cognia://a^b", "cognia://a\"&calc"] {
            let err = WindowsScheduler::build_action_command(&SystemTaskAction::OpenUrl {
                url: bad.to_string(),
            })
            .unwrap_err();
            assert!(matches!(err, SchedulerError::InvalidConfig(_)));
        }
    }

    #[test]
    fn test_cron_to_schtasks_every_minute() {
        let result = WindowsScheduler::cron_to_schtasks("* * * * *");
        assert!(result.is_ok());
        let args = result.unwrap();
        assert!(args.contains(&"MINUTE".to_string()));
    }

    #[test]
    fn test_cron_to_schtasks_every_5_minutes() {
        let result = WindowsScheduler::cron_to_schtasks("*/5 * * * *");
        assert!(result.is_ok());
        let args = result.unwrap();
        assert!(args.contains(&"MINUTE".to_string()));
        assert!(args.contains(&"5".to_string()));
    }

    #[test]
    fn test_cron_to_schtasks_daily() {
        let result = WindowsScheduler::cron_to_schtasks("0 9 * * *");
        assert!(result.is_ok());
        let args = result.unwrap();
        assert!(args.contains(&"DAILY".to_string()));
        assert!(args.contains(&"09:00".to_string()));
    }

    #[test]
    fn cron_to_schtasks_rejects_invalid_numeric_fields() {
        for expression in ["60 * * * *", "0 24 * * *", "0 9 0 * *", "0 9 * * 8"] {
            assert!(
                matches!(
                    WindowsScheduler::cron_to_schtasks(expression),
                    Err(SchedulerError::InvalidCron(_))
                ),
                "expected invalid cron for {expression}"
            );
        }
    }

    #[test]
    fn build_action_command_rejects_unsafe_environment_names() {
        let mut env = std::collections::HashMap::new();
        env.insert("SAFE&whoami".to_string(), "value".to_string());

        let run_command = SystemTaskAction::RunCommand {
            command: "cmd.exe".to_string(),
            args: vec![],
            working_dir: None,
            env: env.clone(),
        };
        let script = SystemTaskAction::ExecuteScript {
            language: "bash".to_string(),
            code: "echo ok".to_string(),
            working_dir: None,
            args: vec![],
            env,
            timeout_secs: 30,
            memory_mb: 128,
            use_sandbox: true,
        };

        for action in [run_command, script] {
            assert!(
                matches!(
                    WindowsScheduler::build_action_command(&action),
                    Err(SchedulerError::SecurityViolation(_))
                ),
                "expected unsafe env name to be rejected"
            );
        }
    }

    #[test]
    fn test_generate_task_name() {
        assert_eq!(generate_task_name("My Task"), "Cognia_My_Task");
        assert_eq!(generate_task_name("test-task"), "Cognia_test-task");
    }

    #[test]
    fn test_is_cognia_task() {
        assert!(is_cognia_task("Cognia_MyTask"));
        assert!(!is_cognia_task("OtherTask"));
    }

    #[test]
    fn parses_xml_trigger_and_action_for_legacy_task_backfill() {
        let base = SystemTask {
            id: "\\Cognia_Test".to_string(),
            name: "Test".to_string(),
            description: None,
            trigger: SystemTaskTrigger::Interval { seconds: 0 },
            action: SystemTaskAction::RunCommand {
                command: String::new(),
                args: vec![],
                working_dir: None,
                env: std::collections::HashMap::new(),
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
            metadata_state: TaskMetadataState::Degraded,
        };

        let xml = r#"
<Task>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-02-18T09:30:00Z</StartBoundary>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/C echo hello</Arguments>
    </Exec>
  </Actions>
</Task>
"#;

        let parsed = WindowsScheduler::enrich_from_xml(&base, xml).expect("should parse XML");
        assert_eq!(parsed.metadata_state, TaskMetadataState::Full);
        assert!(matches!(parsed.trigger, SystemTaskTrigger::Cron { .. }));
        assert!(matches!(parsed.action, SystemTaskAction::RunCommand { .. }));
    }

    #[test]
    fn trigger_capabilities_report_on_event_unavailable() {
        let scheduler = WindowsScheduler {
            available: true,
            elevated: false,
        };
        let caps = scheduler.get_trigger_capabilities();
        let on_event = caps.iter().find(|c| c.trigger_type == "on_event").unwrap();
        assert!(!on_event.available);
        assert!(!on_event.constraint_notes.is_empty());
    }

    #[test]
    fn trigger_capabilities_report_on_boot_requires_admin() {
        let scheduler = WindowsScheduler {
            available: true,
            elevated: false,
        };
        let caps = scheduler.get_trigger_capabilities();
        let on_boot = caps.iter().find(|c| c.trigger_type == "on_boot").unwrap();
        assert!(on_boot.available);
        assert!(on_boot.requires_admin);
    }

    #[test]
    fn trigger_capabilities_report_cron_available() {
        let scheduler = WindowsScheduler {
            available: true,
            elevated: false,
        };
        let caps = scheduler.get_trigger_capabilities();
        let cron = caps.iter().find(|c| c.trigger_type == "cron").unwrap();
        assert!(cron.available);
        assert!(!cron.requires_admin);
        assert!(!cron.backend_notes.is_empty());
    }

    #[test]
    fn validate_translation_rejects_on_event() {
        let scheduler = WindowsScheduler {
            available: true,
            elevated: false,
        };
        let result = scheduler.validate_trigger_translation(&SystemTaskTrigger::OnEvent {
            source: "System".to_string(),
            event_id: 1,
        });
        assert!(!result.valid);
        assert!(!result.errors.is_empty());
        assert!(result.native_representation.is_none());
    }

    #[test]
    fn validate_translation_accepts_daily_cron() {
        let scheduler = WindowsScheduler {
            available: true,
            elevated: false,
        };
        let result = scheduler.validate_trigger_translation(&SystemTaskTrigger::Cron {
            expression: "0 9 * * *".to_string(),
            timezone: None,
        });
        assert!(result.valid);
        assert!(result.native_representation.is_some());
        assert!(result.native_representation.unwrap().contains("DAILY"));
    }

    #[test]
    fn validate_translation_warns_short_interval() {
        let scheduler = WindowsScheduler {
            available: true,
            elevated: false,
        };
        let result =
            scheduler.validate_trigger_translation(&SystemTaskTrigger::Interval { seconds: 30 });
        assert!(result.valid);
        assert!(!result.warnings.is_empty());
    }
}
