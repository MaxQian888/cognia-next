use fern::Dispatch;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri_plugin_log::{Target, TargetKind};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod noop;
#[cfg(target_os = "windows")]
mod windows;

pub trait PlatformLogger: Send + Sync {
    fn log(
        &self,
        level: PlatformLogLevel,
        target: &str,
        message: &str,
        data: Option<&str>,
    ) -> Result<(), String>;
    fn is_available(&self) -> bool;
    fn name(&self) -> &'static str;
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlatformLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl PlatformLogLevel {
    fn priority(self) -> u8 {
        match self {
            Self::Trace => 0,
            Self::Debug => 1,
            Self::Info => 2,
            Self::Warn => 3,
            Self::Error => 4,
            Self::Fatal => 5,
        }
    }

    fn from_log_level(level: log::Level) -> Self {
        match level {
            log::Level::Trace => Self::Trace,
            log::Level::Debug => Self::Debug,
            log::Level::Info => Self::Info,
            log::Level::Warn => Self::Warn,
            log::Level::Error => Self::Error,
        }
    }

    fn allows(self, level: Self) -> bool {
        level.priority() >= self.priority()
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlatformLoggingHealth {
    Healthy,
    Degraded,
    Inactive,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLoggingConfig {
    pub enabled: bool,
    pub min_level: PlatformLogLevel,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLoggingConfigUpdate {
    pub enabled: Option<bool>,
    pub min_level: Option<PlatformLogLevel>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLogEntry {
    pub level: PlatformLogLevel,
    pub module: String,
    pub message: String,
    pub timestamp: Option<String>,
    pub trace_id: Option<String>,
    pub session_id: Option<String>,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformLoggingStatus {
    pub available: bool,
    pub backend: String,
    pub health: PlatformLoggingHealth,
    pub error: Option<String>,
    pub enabled: bool,
    pub min_level: PlatformLogLevel,
}

pub(crate) struct PlatformLoggerProbe {
    pub(crate) logger: Arc<dyn PlatformLogger>,
    error: Option<String>,
}

impl PlatformLoggerProbe {
    pub(crate) fn success(logger: Arc<dyn PlatformLogger>, error: Option<String>) -> Self {
        Self {
            logger,
            error: error.map(sanitize_error_message),
        }
    }

    pub(crate) fn failure(backend: &'static str, error: impl Into<String>) -> Self {
        Self {
            logger: Arc::new(noop::NoopPlatformLogger::new(backend)),
            error: Some(sanitize_error_message(error.into())),
        }
    }
}

struct PlatformLoggingState {
    logger: Arc<dyn PlatformLogger>,
    error: Option<String>,
    config: PlatformLoggingConfig,
}

impl Default for PlatformLoggingState {
    fn default() -> Self {
        Self {
            logger: Arc::new(noop::NoopPlatformLogger::new("none")),
            error: None,
            config: PlatformLoggingConfig {
                enabled: true,
                min_level: PlatformLogLevel::Warn,
            },
        }
    }
}

static PLATFORM_LOGGING_STATE: Lazy<Mutex<PlatformLoggingState>> =
    Lazy::new(|| Mutex::new(PlatformLoggingState::default()));

pub fn default_platform_logging_status() -> PlatformLoggingStatus {
    PlatformLoggingStatus {
        available: false,
        backend: "none".to_string(),
        health: PlatformLoggingHealth::Inactive,
        error: None,
        enabled: true,
        min_level: PlatformLogLevel::Warn,
    }
}

pub fn bootstrap_platform_logging() -> PlatformLoggingStatus {
    let probe = probe_platform_logger();
    if let Ok(mut state) = PLATFORM_LOGGING_STATE.lock() {
        let config = state.config.clone();
        *state = PlatformLoggingState {
            logger: probe.logger,
            error: probe.error,
            config,
        };
    }
    get_platform_logging_status()
}

pub fn get_platform_logging_status() -> PlatformLoggingStatus {
    match PLATFORM_LOGGING_STATE.lock() {
        Ok(state) => derive_status(&state),
        Err(_) => PlatformLoggingStatus {
            error: Some("platform_logging_lock_poisoned".to_string()),
            ..default_platform_logging_status()
        },
    }
}

pub fn set_platform_logging_config(update: PlatformLoggingConfigUpdate) -> PlatformLoggingStatus {
    if let Ok(mut state) = PLATFORM_LOGGING_STATE.lock() {
        state.config.enabled = update.enabled.unwrap_or(state.config.enabled);
        state.config.min_level = update.min_level.unwrap_or(state.config.min_level);
    }
    get_platform_logging_status()
}

pub fn forward_entries(entries: &[PlatformLogEntry]) -> Result<(), String> {
    for entry in entries {
        forward_entry(entry)?;
    }
    Ok(())
}

pub fn dispatch_target() -> Target {
    Target::new(TargetKind::Dispatch(Dispatch::new().chain(
        fern::Output::call(|record| {
            let _ = forward_record(record);
        }),
    )))
}

fn forward_record(record: &log::Record<'_>) -> Result<(), String> {
    let level = PlatformLogLevel::from_log_level(record.level());
    let message = format!("{}", record.args());
    dispatch(level, record.target(), &message, None)
}

fn forward_entry(entry: &PlatformLogEntry) -> Result<(), String> {
    let data = serialize_entry_context(entry);
    dispatch(entry.level, &entry.module, &entry.message, data.as_deref())
}

fn dispatch(
    level: PlatformLogLevel,
    target: &str,
    message: &str,
    data: Option<&str>,
) -> Result<(), String> {
    let state = PLATFORM_LOGGING_STATE
        .lock()
        .map_err(|_| "platform_logging_lock_poisoned".to_string())?;
    if !state.logger.is_available()
        || !state.config.enabled
        || !state.config.min_level.allows(level)
    {
        return Ok(());
    }
    state
        .logger
        .log(level, target, message, data)
        .map_err(sanitize_error_message)
}

fn derive_status(state: &PlatformLoggingState) -> PlatformLoggingStatus {
    let backend = state.logger.name().to_string();
    let available = state.logger.is_available();
    let health = if !state.config.enabled {
        PlatformLoggingHealth::Inactive
    } else if available && state.error.is_none() {
        PlatformLoggingHealth::Healthy
    } else if backend == "none" && !available {
        PlatformLoggingHealth::Inactive
    } else {
        PlatformLoggingHealth::Degraded
    };

    PlatformLoggingStatus {
        available,
        backend,
        health,
        error: state.error.clone(),
        enabled: state.config.enabled,
        min_level: state.config.min_level,
    }
}

fn serialize_entry_context(entry: &PlatformLogEntry) -> Option<String> {
    let mut map = serde_json::Map::new();
    if let Some(timestamp) = entry.timestamp.as_ref() {
        map.insert(
            "timestamp".to_string(),
            serde_json::Value::String(timestamp.clone()),
        );
    }
    if let Some(trace_id) = entry.trace_id.as_ref() {
        map.insert(
            "traceId".to_string(),
            serde_json::Value::String(trace_id.clone()),
        );
    }
    if let Some(session_id) = entry.session_id.as_ref() {
        map.insert(
            "sessionId".to_string(),
            serde_json::Value::String(session_id.clone()),
        );
    }
    if let Some(data) = entry.data.as_ref() {
        map.insert("data".to_string(), data.clone());
    }

    (!map.is_empty()).then(|| serde_json::Value::Object(map).to_string())
}

fn probe_platform_logger() -> PlatformLoggerProbe {
    #[cfg(target_os = "windows")]
    {
        return windows::probe_logger();
    }

    #[cfg(target_os = "macos")]
    {
        return macos::probe_logger();
    }

    #[cfg(target_os = "linux")]
    {
        return linux::probe_logger();
    }

    #[allow(unreachable_code)]
    PlatformLoggerProbe::failure("none", "platform_logging_unsupported")
}

pub(crate) fn sanitize_error_message(value: impl Into<String>) -> String {
    value
        .into()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(256)
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn sanitize_target(target: &str) -> String {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return "app".to_string();
    }
    trimmed
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' | '.' => ch,
            _ => '_',
        })
        .take(96)
        .collect()
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
pub(crate) fn append_structured_payload(message: &str, data: Option<&str>) -> String {
    match data {
        Some(data) if !data.is_empty() => format!("{message} | {data}"),
        _ => message.to_string(),
    }
}

#[cfg(test)]
pub(crate) fn replace_logger_for_test(
    logger: Arc<dyn PlatformLogger>,
    error: Option<String>,
    config: PlatformLoggingConfig,
) {
    if let Ok(mut state) = PLATFORM_LOGGING_STATE.lock() {
        *state = PlatformLoggingState {
            logger,
            error,
            config,
        };
    }
}

#[cfg(test)]
pub(crate) fn forward_record_for_test(
    level: log::Level,
    target: &str,
    message: &str,
) -> Result<(), String> {
    let rendered = message.to_string();
    let args = format_args!("{rendered}");
    let record = log::RecordBuilder::new()
        .level(level)
        .target(target)
        .args(args)
        .build();
    forward_record(&record)
}

#[cfg(test)]
mod tests {
    use super::{
        append_structured_payload, default_platform_logging_status, forward_entries,
        forward_record_for_test, get_platform_logging_status, replace_logger_for_test,
        sanitize_error_message, sanitize_target, set_platform_logging_config, PlatformLogEntry,
        PlatformLogLevel, PlatformLogger, PlatformLoggingConfig, PlatformLoggingConfigUpdate,
        PlatformLoggingHealth,
    };
    use once_cell::sync::Lazy;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// Serializes tests that mutate the global `PLATFORM_LOGGING_STATE`. The
    /// shared mutex prevents `cargo test` from interleaving setup steps from
    /// concurrent test threads, which would otherwise let one test observe
    /// another test's mock logger.
    static TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn lock_test_state() -> std::sync::MutexGuard<'static, ()> {
        match TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    type MockEntry = (PlatformLogLevel, String, String, Option<String>);

    struct MockPlatformLogger {
        backend: &'static str,
        available: bool,
        entries: Mutex<Vec<MockEntry>>,
    }

    impl MockPlatformLogger {
        fn new(backend: &'static str, available: bool) -> Self {
            Self {
                backend,
                available,
                entries: Mutex::new(Vec::new()),
            }
        }
    }

    impl PlatformLogger for MockPlatformLogger {
        fn log(
            &self,
            level: PlatformLogLevel,
            target: &str,
            message: &str,
            data: Option<&str>,
        ) -> Result<(), String> {
            self.entries.lock().expect("entries lock poisoned").push((
                level,
                target.to_string(),
                message.to_string(),
                data.map(str::to_string),
            ));
            Ok(())
        }

        fn is_available(&self) -> bool {
            self.available
        }

        fn name(&self) -> &'static str {
            self.backend
        }
    }

    #[test]
    fn default_platform_status_is_inactive() {
        let _guard = lock_test_state();
        assert_eq!(
            default_platform_logging_status().health,
            PlatformLoggingHealth::Inactive
        );
    }

    #[test]
    fn disabled_config_surfaces_inactive_health() {
        let _guard = lock_test_state();
        replace_logger_for_test(
            Arc::new(MockPlatformLogger::new("event_log", true)),
            None,
            PlatformLoggingConfig {
                enabled: false,
                min_level: PlatformLogLevel::Warn,
            },
        );

        let status = get_platform_logging_status();
        assert_eq!(status.backend, "event_log");
        assert_eq!(status.health, PlatformLoggingHealth::Inactive);
    }

    #[test]
    fn record_forwarding_respects_runtime_threshold() {
        let _guard = lock_test_state();
        let logger = Arc::new(MockPlatformLogger::new("event_log", true));
        replace_logger_for_test(
            logger.clone(),
            None,
            PlatformLoggingConfig {
                enabled: true,
                min_level: PlatformLogLevel::Error,
            },
        );

        forward_record_for_test(log::Level::Warn, "app_lib::test", "warn entry")
            .expect("warn forward should not error");
        forward_record_for_test(log::Level::Error, "app_lib::test", "error entry")
            .expect("error forward should not error");

        let entries = logger.entries.lock().expect("entries lock poisoned");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, PlatformLogLevel::Error);
        assert_eq!(entries[0].2, "error entry");
        assert_eq!(entries[0].3, None);
    }

    #[test]
    fn config_updates_change_threshold_and_enabled_state() {
        let _guard = lock_test_state();
        replace_logger_for_test(
            Arc::new(MockPlatformLogger::new("event_log", true)),
            None,
            PlatformLoggingConfig {
                enabled: true,
                min_level: PlatformLogLevel::Warn,
            },
        );

        let status = set_platform_logging_config(PlatformLoggingConfigUpdate {
            enabled: Some(false),
            min_level: Some(PlatformLogLevel::Debug),
        });

        assert!(!status.enabled);
        assert_eq!(status.min_level, PlatformLogLevel::Debug);
    }

    #[test]
    fn unavailable_backend_is_reported_as_degraded_when_enabled() {
        let _guard = lock_test_state();
        replace_logger_for_test(
            Arc::new(MockPlatformLogger::new("event_log", false)),
            None,
            PlatformLoggingConfig {
                enabled: true,
                min_level: PlatformLogLevel::Warn,
            },
        );

        let status = get_platform_logging_status();
        assert!(!status.available);
        assert_eq!(status.backend, "event_log");
        assert_eq!(status.health, PlatformLoggingHealth::Degraded);
    }

    #[test]
    fn forward_entries_serializes_context_payload() {
        let _guard = lock_test_state();
        let logger = Arc::new(MockPlatformLogger::new("event_log", true));
        replace_logger_for_test(
            logger.clone(),
            None,
            PlatformLoggingConfig {
                enabled: true,
                min_level: PlatformLogLevel::Info,
            },
        );

        forward_entries(&[PlatformLogEntry {
            level: PlatformLogLevel::Error,
            module: "app_lib::startup".to_string(),
            message: "startup failed".to_string(),
            timestamp: Some("2026-04-06T12:00:00Z".to_string()),
            trace_id: Some("trace-1".to_string()),
            session_id: Some("session-1".to_string()),
            data: Some(json!({
                "reason": "io_error",
                "retryable": false
            })),
        }])
        .expect("entry forwarding should succeed");

        let entries = logger.entries.lock().expect("entries lock poisoned");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, PlatformLogLevel::Error);
        assert_eq!(entries[0].1, "app_lib::startup");
        assert_eq!(entries[0].2, "startup failed");

        let payload = entries[0]
            .3
            .as_deref()
            .expect("forwarded payload should be present");
        let payload: serde_json::Value =
            serde_json::from_str(payload).expect("payload should be valid json");
        assert_eq!(payload["timestamp"], "2026-04-06T12:00:00Z");
        assert_eq!(payload["traceId"], "trace-1");
        assert_eq!(payload["sessionId"], "session-1");
        assert_eq!(payload["data"]["reason"], "io_error");
        assert_eq!(payload["data"]["retryable"], false);
    }

    #[test]
    fn sanitize_helpers_normalize_strings_for_platform_backends() {
        let noisy = format!("{}\n{}", "word ".repeat(40), "\ttail");
        let sanitized = sanitize_error_message(noisy);
        assert!(!sanitized.contains('\n'));
        assert!(!sanitized.contains('\t'));
        assert!(sanitized.len() <= 256);

        assert_eq!(sanitize_target(""), "app");
        assert_eq!(
            sanitize_target(" module path/with spaces "),
            "module_path_with_spaces"
        );
        assert_eq!(sanitize_target(&"a".repeat(128)).len(), 96);

        assert_eq!(
            append_structured_payload("hello", Some("{\"ok\":true}")),
            "hello | {\"ok\":true}"
        );
        assert_eq!(append_structured_payload("hello", Some("")), "hello");
    }
}
